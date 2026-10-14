'use strict';

const { spawn } = require('child_process');

/* ============================================================
 *  媒体感知（Windows）——「主人此刻在听什么」的输入
 * ==========================================================
 *
 *  要回答的问题只有一个：**现在有没有在放东西，放的是什么？**
 *
 *  为什么只能这么做：
 *    - Electron / Node 都没有任何 API 能读到系统正在播放的媒体。
 *    - 没有可靠的 Node 版 WinRT 绑定（竞品调研第 5 轮找过，没有在维护的）。
 *  → 走 WinRT 的 `GlobalSystemMediaTransportControlsSessionManager`（GSMTC，
 *    Win10 1809+ 的系统级媒体会话）。它是播放器主动上报的那块"正在播放"
 *    信息的**唯一**官方来源（网易云 / QQ音乐 / 浏览器 / PotPlayer 都上报）。
 *
 *  这是**第四个**起常驻 powershell 的地方（另三个：全屏静默、系统状态、
 *  语音合成）。按规矩 24，要常驻进程的功能一律默认不勾选 —— 见 config.js
 *  的 media.enabled，默认 false。没人开就不会有这个进程。
 *
 *  ⚠️ 与 fullscreen.js **刻意不合并**：那份采样脚本里全是对稳定性极敏感的
 *    Win32 interop（还带着"XAML 岛误判"这个未结的账）。往里塞一段 WinRT 的
 *    异步转换，等于把两个功能的成败绑在一起 —— WinRT 在个别机器上加载失败，
 *    连全屏静默一起坏。多一个进程换两个功能互不牵连，这笔账划算。
 *
 *  ⚠️ 用 `-EncodedCommand`（UTF-16LE base64）喂脚本，脚本正文**必须全 ASCII**：
 *    命令行参数要过控制台代码页，非 ASCII 会在 GBK/UTF-16 之间来回转换。
 *  ⚠️ 输出**不走 `Write-Output`**：中文歌名/歌手要按 UTF-8 出去，而
 *    `[Console]::OutputEncoding` 在重定向下不可靠。直接拿
 *    `[Console]::OpenStandardOutput()` 写 UTF-8 字节，绕开整个代码页问题。
 * ========================================================== */

/* 采样间隔。媒体信息变化很慢（切歌 / 按暂停），2 秒足够；
 * 每次采样就是两次 interop 调用（取会话 + 取属性），开销可忽略。 */
const SAMPLE_MS = 2000;

const MAX_RESTARTS = 6;
const RESTART_MS = 5000;

/* ============================================================
 *  纯函数（verify-media.js 直接测）
 * ========================================================== */

const s = (v) => (typeof v === 'string' ? v : '');

/**
 * 解析采样进程吐的一行。
 * @returns {{active:false}|{active:true,app,title,artist,album,status}|null}
 *   null = 不是一行有效样本（半行 / 杂音），调用方应当**原样丢掉**，
 *   不能当成"没在放东西"—— 那会在切歌的瞬间把她刚看到的信息清掉。
 */
function parseMediaLine(line) {
  const t = s(line).trim();
  if (!t || t[0] !== '{') return null;
  let o;
  try { o = JSON.parse(t); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  /* 采样进程自报的问题（WinRT 加载不了之类）。单独一档 —— 它既不是"没在放"
   * 也不该被当成杂音丢掉，否则"媒体感知不生效"就成了一个查不到原因的黑洞。 */
  if (typeof o.err === 'string') return { error: o.err };
  if (o.s === null) return { active: false };
  return {
    active: true,
    app: s(o.app),
    title: s(o.title),
    artist: s(o.artist),
    album: s(o.album),
    status: s(o.status)
  };
}

/* 去重用的键：同一首歌（哪怕暂停/继续）算同一个。
 * 换歌、换歌手都会换键 —— 那时才值得再提一次。 */
function mediaKey(m) {
  if (!m || !m.active) return '';
  return `${m.title}|${m.artist}`;
}

/**
 * 转成一句中文，给 LLM 当背景信息用。
 * @returns {string} 空串 = 「没有值得说的」（没在放 / 状态是停止 / 没有歌名）。
 *
 * ⚠️ 只在 Playing / Paused 时出话：Stopped / Closed 常常是"刚切歌的那一瞬间"
 *    或"播放器关掉了"，这时候塞一句"刚在听 XX"纯属噪音。
 */
function describeMedia(m) {
  if (!m || !m.active || !m.title) return '';
  const who = m.artist ? ` —— ${m.artist}` : '';
  if (m.status === 'Playing') return `正在听《${m.title}》${who}`;
  if (m.status === 'Paused') return `刚在听《${m.title}》${who}（暂停中）`;
  return '';
}

/* ============================================================
 *  采样脚本
 * ========================================================== */

function psScript(sampleMs, parentPid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    // 输出通道：直接写 stdout 的 UTF-8 字节（见文件头的说明）。
    // ⚠️ 定义放在最前面 —— 下面"WinRT 装不上"那条也要用它报信。
    '$out = [Console]::OpenStandardOutput()',
    'function Emit($json) {',
    '  $b = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")',
    '  $out.Write($b, 0, $b.Length)',
    '  $out.Flush()',
    '}',
    // WinRT 的异步操作返回 IAsyncOperation，PS 5.1 直接 .GetAwaiter() 不行。
    // 标准绕法：反射拿到 AsTask<T> 的泛型方法，自己 MakeGenericMethod 再 Wait。
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue',
    "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    // 装不上就**报信并退出**，别闷着循环：那种情况下这个进程一帧有用的东西
    // 都产不出来，留着只是白占内存，而且还让"为什么没反应"无从查起。
    'if ($null -eq $asTaskGeneric) { Emit \'{"err":"winrt-unavailable"}\'; exit }',
    'function Await($op, $t) {',
    '  $m = $asTaskGeneric.MakeGenericMethod($t)',
    '  $task = $m.Invoke($null, @($op))',
    '  $task.Wait(-1) | Out-Null',
    '  return $task.Result',
    '}',
    '$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]',
    '$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]',
    '$parent = ' + parentPid,
    '$tick = 0',
    '$mgr = $null',
    'while ($true) {',
    '  $tick = $tick + 1',
    // 每 10 拍自查父进程还在不在。Windows 上父进程退出**不**带走子进程，
    // 强杀应用时没有 will-quit 可跑 —— 这条自查是唯一确定的收尾（同 fullscreen.js）。
    '  if (($tick % 10) -eq 0) {',
    '    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }',
    '  }',
    // 管理器本身拿到一次就够（它是台机器级的单例视图）；只在取会话失败时重建。
    '  if ($null -eq $mgr) {',
    '    try { $mgr = Await ($mgrType::RequestAsync()) $mgrType } catch { $mgr = $null }',
    '  }',
    '  $line = $null',
    '  try {',
    '    $sess = $null',
    '    if ($null -ne $mgr) { $sess = $mgr.GetCurrentSession() }',
    '    if ($null -eq $sess) {',
    '      $line = \'{"s":null}\'',
    '    } else {',
    '      $pr = Await ($sess.TryGetMediaPropertiesAsync()) $propsType',
    '      $pb = $sess.GetPlaybackInfo()',
    '      $st = ""',
    '      if ($null -ne $pb) { $st = $pb.PlaybackStatus.ToString() }',
    '      $o = [pscustomobject]@{ app = $sess.SourceAppUserModelId; title = $pr.Title; artist = $pr.Artist; album = $pr.AlbumTitle; status = $st }',
    '      $line = $o | ConvertTo-Json -Compress',
    '    }',
    '  } catch {',
    '    $mgr = $null',
    '    $line = $null',
    '  }',
    '  if ($null -ne $line) { Emit $line }',
    '  Start-Sleep -Milliseconds ' + sampleMs,
    '}'
  ].join('\n');
}

const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/* ============================================================
 *  常驻监视进程
 * ========================================================== */

let child = null;
let stopped = true;
let restartTimer = null;
let restarts = 0;
/* 最近一次采样结果。null = 还没采到 / 明确没有会话。
 * 结构同 parseMediaLine 的返回值，另外带一个 at（时间戳，诊断用）。 */
let current = null;
/* 诊断钩子：每采到一行调一次（PET_MEDIA=1 时打印）。 */
let onSample = null;

function startMediaWatch(opts = {}) {
  if (process.platform !== 'win32') {
    console.log('[media] 非 Windows，跳过媒体监视');
    return false;
  }
  /* ⚠️ 钩子要在"已在跑"的提前返回**之前**更新：refreshMediaWatcher() 是每次
   * 改配置都会走的路径，重复调用时把新钩子丢掉的话，PET_MEDIA 这种
   * "先开着开关再起进程"的用法就永远接不上。
   * ⚠️ 但只有**显式带了 onSample 这个键**才覆盖 —— 否则一次不带参数的
   *    重复调用就会把正在用的钩子清成 null（实测踩到：探针再也收不到样本，
   *    看着像"采样进程死了"）。要清钩子走 stopMediaWatch()。 */
  if ('onSample' in opts) onSample = opts.onSample || null;
  if (child) return true;              // 已在跑

  stopped = false;
  restarts = 0;
  const { sampleMs = SAMPLE_MS } = opts;

  const handleLine = (line) => {
    const m = parseMediaLine(line);
    if (m === null) return;            // 半行 / 杂音：丢掉，**不要**清 current
    if (m.error) {
      // 采样进程自报装不上 WinRT。留一条明确的日志并**主动收手** ——
      // 让它继续每 2 秒吐同一行错误没有意义。
      console.warn('[media] 采样进程报错，媒体感知不生效:', m.error);
      stopMediaWatch();
      return;
    }
    current = { ...m, at: Date.now() };
    try { onSample?.(current); } catch { /* 诊断钩子不许影响主流程 */ }
  };

  const scheduleRestart = () => {
    if (stopped) return;
    if (restarts >= MAX_RESTARTS) {
      console.warn('[media] 采样进程反复退出，放弃监视（媒体感知将不生效）');
      return;
    }
    restarts++;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(spawnOnce, RESTART_MS);
  };

  function spawnOnce() {
    if (stopped) return;
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodeCommand(psScript(sampleMs, process.pid))
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[media] 起不了采样进程:', String(err?.message || err));
      scheduleRestart();
      return;
    }

    child = proc;
    restarts = 0;
    console.log('[media] 采样进程已启动（每 ' + sampleMs + 'ms 一次）');
    proc.stdout.setEncoding('utf8');   // 脚本那头写的就是 UTF-8 字节
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) handleLine(line);
    });
    // stderr 只丢不打印：Add-Type 在个别机器上会吐无害的告警，刷屏会淹掉真日志
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* ignore */ });
    proc.on('error', (err) => {
      console.warn('[media] 采样进程异常:', String(err?.message || err));
    });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      if (!stopped) console.warn('[media] 采样进程退出，code =', code);
      scheduleRestart();
    });
  }

  spawnOnce();
  return true;
}

function stopMediaWatch() {
  stopped = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  onSample = null;
  current = null;
  if (child) {
    const proc = child;
    child = null;
    try { proc.kill(); } catch { /* ignore */ }
  }
}

/* 当前在放什么。返回 null = 没在放 / 开关没开 / 还没采到。 */
function getMedia() {
  return current;
}

module.exports = {
  SAMPLE_MS,
  MAX_RESTARTS,
  psScript,
  parseMediaLine,
  mediaKey,
  describeMedia,
  startMediaWatch,
  stopMediaWatch,
  getMedia
};
