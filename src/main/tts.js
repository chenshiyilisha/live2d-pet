'use strict';

/* ============================================================
 *  Windows 语音合成（WinRT SpeechSynthesizer）
 * ==========================================================
 *
 *  为什么不用 Chromium 自带的 speechSynthesis 了：
 *  它的声音**不进 WebAudio 的图** —— 拿不到波形，也就做不出真口型
 *  （说话时嘴巴只能跑一条与音量无关的正弦波）。WinRT 的
 *  `SynthesizeTextToStreamAsync()` 直接给一段 audio/wav 字节流，
 *  交给渲染层的 AudioContext 播放，就能挂 AnalyserNode 取包络。
 *
 *  ⚠️ 常驻一个 powershell.exe，不是每句起一个。
 *     起一次要 ~500ms（模块自动加载）+ 载入 WinRT 绑定又几百毫秒；
 *     每句现起 = 每句话前面白等一秒，朗读明显"慢半拍"。
 *     实测常驻之后：首次合成 55ms，之后每句 7ms。
 *
 *  ⚠️ 为什么用「扫目录」而不是「读 stdin」取活：
 *     `[Console]::In.ReadLine()` 会**阻塞**，而父进程被强杀（崩溃 /
 *     任务管理器）时 Windows 不会关掉子进程的 stdin，它就永远卡在
 *     那一行上 —— 父子自查也永远执行不到，留下一个野进程。
 *     改成每 150ms 扫一次请求目录，自查就能真的跑起来。
 *
 *  ⚠️ 中文**不走管道**：文本写成 UTF-8 的 JSON 请求文件，PS 读文件。
 *     管道那一路会经过控制台代码页，中文必然出问题（同 speech.js）。
 *     stdin/stdout 上跑的只有纯 ASCII 的路径和状态字。
 * ========================================================== */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 请求目录扫描间隔 —— 它直接变成"每句话前的排队延迟"（合成本身只要几十毫秒，
 * 实测稳态 180ms/句里有一大半是等这一拍）。80ms 是感知与开销的折中：
 * `.NET Directory.GetFiles` 扫一个小目录不到 1ms，一拍的开销可以忽略。
 * 渲染层那边还做了流水线预合成（播上一句时把下一句合成好），所以真正
 * 用户能感知到的只有整轮的第一句。 */
const SCAN_MS = 80;

/* 单句合成上限。合成很快（毫秒级），超过这个数就是卡住了 ——
 * 卡住不能再等：整条队列都在它后面排着。超时就杀掉进程重来。 */
const SYNTH_TIMEOUT = 8000;

/* 连续重启上限（同 fullscreen.js 的理由）：PowerShell 被组策略禁掉、
 * 或安全软件拦了 WinRT 时，spawn 会立刻失败、exit 立刻回来 ——
 * 不设上限就变成一个每秒重启一次的循环，比不工作还糟。 */
const MAX_RESTARTS = 4;
const RESTART_MS = 4000;

const VOICE_MAX = 60;      // 音色名最长（防御：PS 那边吐出来的东西不能无限长）

let child = null;
let stopped = true;
let ready = false;
let restarts = 0;
let restartTimer = null;
let seq = 0;
let voices = [];

/* id -> { resolve, timer, req, out }。请求发出后在这里等 PS 的回话。 */
const waiting = new Map();
/* 等"进程就绪"的排队者（首次合成要等 READY）。 */
let readyWaiters = [];

let dir = null;

/* ---- 串行化 ----
 * 渲染层的朗读队列本来就是串行的，但「合成」这一层不能指望调用方守规矩
 * （将来接别的出口时很容易忘）。用一条 Promise 链把请求排好。 */
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

function ensureDir() {
  if (dir) return dir;
  dir = path.join(os.tmpdir(), `pet-tts-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 清掉上一次留下的垃圾（同一个 pid 目录理论上是空的，防御性清理）
    for (const f of fs.readdirSync(dir)) {
      try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[tts] 建不了临时目录:', String(err?.message || err));
  }
  sweepOldDirs();
  return dir;
}

/* 这个进程还活着吗。
 * ⚠️ `kill(pid, 0)` 在不存在的进程上抛 ESRCH，但对**存在但没权限**的进程
 *    抛 EPERM —— 那种情况它显然活着，不能当死的删掉。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return !!err && err.code === 'EPERM'; }
}

/* 清掉以前留下的 `pet-tts-<pid>` 目录。
 *
 * 为什么需要它：应用被**强杀**（崩溃、任务管理器结束进程、timeout）时
 * `will-quit` 不会跑，stopSynth 也就没机会删自己的目录。目录名带 pid 是
 * 为了多实例互不干扰，代价就是会一点点攒起来 —— 每次启动顺手扫一遍。
 * ⚠️ 只删"那个 pid 已经不在了"的：同时开着两个实例时，
 *    不能把对方正在用的目录端掉。 */
function sweepOldDirs() {
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const n of names) {
    const m = /^pet-tts-(\d+)$/.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pidAlive(pid)) continue;
    try { fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ============================================================
 *  采样脚本（纯 ASCII —— 走 -EncodedCommand）
 * ========================================================== */

function psScript(scanMs, parentPid, tmpDir) {
  return [
    "$ErrorActionPreference = 'Stop'",
    /* 进度流会往 stderr 吐一堆 CLIXML 噪音（实测），淹掉真正的错误。 */
    '$ProgressPreference = "SilentlyContinue"',
    /* ⚠️ 不设这个，[Console]::Out 按控制台代码页（中文机上是 GBK）编码，
     *    而 JS 侧是按 UTF-8 解的 —— 合成失败时那条中文错误就变成一串乱码。 */
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
    /* IAsyncOperation → Task 的泛型桥（PS 5.1 没有 GetAwaiter）。 */
    '$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {',
    "  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and",
    "  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
    'function Await($op, $type) {',
    '  $m = $asTaskGeneric.MakeGenericMethod($type)',
    '  $task = $m.Invoke($null, @($op))',
    '  [void]$task.Wait(6000)',
    '  if ($task.IsFaulted) { throw $task.Exception.InnerException.Message }',
    '  return $task.Result',
    '}',
    '$syT = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]',
    '$stT = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream, Windows.Media.SpeechSynthesis, ContentType=WindowsRuntime]',
    '$synth = [Activator]::CreateInstance($syT)',
    '$all = $syT::AllVoices',
    '$w = [Console]::Out',
    /* 路径是纯 ASCII 且不含 $（PS 的双引号里 $ 才是转义点，反斜杠不是），
     * 所以原样拼进去就行。 */
    '$dir = "' + tmpDir + '"',
    '$parent = ' + parentPid,
    '$tick = 0',
    /* 音色表随 READY 一起报出去 —— 省一次进程启动。 */
    'foreach ($v in $all) { $w.WriteLine("VOICE " + $v.DisplayName + "|" + $v.Language) }',
    '$w.WriteLine("READY")',
    '$w.Flush()',
    'while ($true) {',
    '  $tick = $tick + 1',
    /* 每 40 拍（≈6 秒）自查一次父进程：Windows 上父进程退出**不会**带走
     * 子进程，应用被强杀时这里没有 will-quit 可跑。 */
    '  if (($tick % 40) -eq 0) {',
    '    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }',
    '  }',
    '  $files = [System.IO.Directory]::GetFiles($dir, "req-*.json")',
    '  foreach ($reqPath in $files) {',
    /* ⚠️ 顺序不能反：**先把内容读出来，再删文件**。请求文件同时是
     * "待处理"的凭据和内容的载体 —— 先删后读就永远读不到了
     * （实测踩过：每句都报"找不到文件"）。 */
    '    $raw = $null',
    '    try { $raw = [System.IO.File]::ReadAllText($reqPath, [System.Text.Encoding]::UTF8) } catch { continue }',
    '    try { [System.IO.File]::Delete($reqPath) } catch { }',
    '    $id = [System.IO.Path]::GetFileNameWithoutExtension($reqPath)',
    '    $id = $id.Substring(4)',
    '    $outPath = [System.IO.Path]::Combine($dir, "out-" + $id + ".wav")',
    '    try {',
    '      $cfg = $raw | ConvertFrom-Json',
    '      $v = $null',
    '      if ($cfg.voice) { $v = $all | Where-Object { $_.DisplayName -eq $cfg.voice } | Select-Object -First 1 }',
    '      if ($v -eq $null) { $v = $all | Where-Object { $_.Language -like "zh*" } | Select-Object -First 1 }',
    '      if ($v -eq $null) { $v = $all[0] }',
    '      $synth.Voice = $v',
    '      $r = [double]$cfg.rate',
    '      if ($r -lt 0.5) { $r = 0.5 }',
    '      if ($r -gt 3) { $r = 3 }',
    '      $p = [double]$cfg.pitch',
    '      if ($p -lt 0) { $p = 0 }',
    '      if ($p -gt 2) { $p = 2 }',
    '      $synth.Options.SpeakingRate = $r',
    '      $synth.Options.AudioPitch = $p',
    '      $stream = Await ($synth.SynthesizeTextToStreamAsync([string]$cfg.text)) $stT',
    '      $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)',
    '      $fs = [System.IO.File]::Create($outPath)',
    '      $net.CopyTo($fs)',
    '      $fs.Close()',
    '      $net.Close()',
    '      $stream.Dispose()',
    '      $w.WriteLine("DONE " + $id)',
    '    } catch {',
    '      $msg = $_.Exception.Message -replace "[\\r\\n|]", " "',
    '      $w.WriteLine("ERR " + $id + " " + $msg)',
    '    }',
    '    $w.Flush()',
    '  }',
    '  Start-Sleep -Milliseconds ' + scanMs,
    '}'
  ].join('\n');
}

const encodeCommand = (script) => Buffer.from(script, 'utf16le').toString('base64');

/* ============================================================
 *  常驻进程
 * ========================================================== */

function handleLine(line) {
  const s = String(line || '').trim();
  if (!s) return;

  if (s === 'READY') {
    ready = true;
    const ws = readyWaiters;
    readyWaiters = [];
    for (const r of ws) r(true);
    console.log('[tts] 合成进程就绪，音色:', voices.join(' / ') || '(未知)');
    return;
  }

  if (s.startsWith('VOICE ')) {
    const [name] = s.slice(6).split('|');
    const n = String(name || '').slice(0, VOICE_MAX);
    if (n && !voices.includes(n)) voices.push(n);
    return;
  }

  const m = /^(DONE|ERR) (\d+)(?: (.*))?$/.exec(s);
  if (!m) return;

  const w = waiting.get(m[2]);
  if (!w) return;                    // 已被超时作废，忽略
  waiting.delete(m[2]);
  clearTimeout(w.timer);

  if (m[1] === 'ERR') {
    cleanup(w);
    w.resolve({ ok: false, error: String(m[3] || 'synth-error').slice(0, 200) });
    return;
  }

  let buf = null;
  try { buf = fs.readFileSync(w.out); } catch { /* 下面统一判 */ }
  cleanup(w);
  /* 只认像样的 wav：太小的、头不对的一律当失败 —— 宁可让上层回退到
   * speechSynthesis，也不能把一段坏数据丢给 decodeAudioData
   * （它会 reject，而那时气泡已经开始"朗读"了）。 */
  if (!buf || buf.length < 2048 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    w.resolve({ ok: false, error: 'bad-wav' });
    return;
  }
  w.resolve({ ok: true, wav: buf });
}

function cleanup(w) {
  for (const p of [w.req, w.out]) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

function killChild() {
  ready = false;
  if (!child) return;
  const proc = child;
  child = null;
  try { proc.kill(); } catch { /* ignore */ }
}

/* 所有在等的请求一起失败 —— 进程没了，它们等不到回话了。 */
function failAllWaiting(why) {
  const all = [...waiting.values()];
  waiting.clear();
  for (const w of all) {
    clearTimeout(w.timer);
    cleanup(w);
    w.resolve({ ok: false, error: why });
  }
}

function scheduleRestart() {
  if (stopped) return;
  if (restarts >= MAX_RESTARTS) {
    console.warn('[tts] 合成进程反复退出，本会话不再尝试（朗读回退到系统音色）');
    return;
  }
  restarts++;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(spawnOnce, RESTART_MS);
}

function spawnOnce() {
  if (stopped || child) return;
  const d = ensureDir();
  if (!d) return;

  let proc;
  try {
    proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodeCommand(psScript(SCAN_MS, process.pid, d))
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.warn('[tts] 起不了合成进程:', String(err?.message || err));
    scheduleRestart();
    return;
  }

  child = proc;
  restarts = 0;

  proc.stdout.setEncoding('utf8');
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      try { handleLine(line); } catch (err) {
        console.warn('[tts] 处理回话出错:', String(err?.message || err));
      }
    }
  });
  /* stderr 只丢不打印：WinRT 那条路会吐无害的 CLIXML 进度记录，刷屏会淹掉真日志。 */
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', () => { /* ignore */ });
  proc.on('error', (err) => {
    console.warn('[tts] 合成进程异常:', String(err?.message || err));
  });
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    ready = false;
    failAllWaiting('synth-exit');
    if (!stopped) console.warn('[tts] 合成进程退出，code =', code);
    scheduleRestart();
  });
}

/* ============================================================
 *  对外接口
 * ========================================================== */

/** 起常驻合成进程（幂等）。非 Windows 直接 false。 */
function startSynth() {
  if (process.platform !== 'win32') return false;
  if (child) return true;
  stopped = false;
  restarts = 0;          // 每次显式启动都重置重启额度（用户重新开了朗读）
  spawnOnce();
  return !!child;
}

function stopSynth() {
  stopped = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  failAllWaiting('stopped');
  readyWaiters = [];
  ready = false;
  killChild();
  if (dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    dir = null;
  }
}

/** 等进程就绪（首次合成要等它把 WinRT 绑好）。超时返回 false。 */
function waitReady(ms = 6000) {
  if (ready) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    readyWaiters.push(fin);
    setTimeout(() => fin(ready), ms);
  });
}

/**
 * 合成一句话 → wav 字节。
 * @param {string} text
 * @param {{rate?:number, pitch?:number, voice?:string}} opts
 * @returns {Promise<{ok:true, wav:Buffer} | {ok:false, error:string}>}
 *          永远 resolve，不 reject —— 调用方（渲染层的朗读队列）要在
 *          "合成不出来"时无缝回退到系统音色，抛异常会把队列卡住。
 */
function synthWav(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return Promise.resolve({ ok: false, error: 'empty' });
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, error: 'non-win32' });

  return enqueue(async () => {
    if (!startSynth()) return { ok: false, error: 'spawn-failed' };
    if (!(await waitReady())) return { ok: false, error: 'not-ready' };

    const id = String(++seq);
    const req = path.join(ensureDir(), `req-${id}.json`);
    const out = path.join(ensureDir(), `out-${id}.wav`);

    const payload = JSON.stringify({
      text: t,
      rate: Number.isFinite(opts.rate) ? opts.rate : 1,
      pitch: Number.isFinite(opts.pitch) ? opts.pitch : 1,
      voice: String(opts.voice || '').slice(0, VOICE_MAX)
    });

    try {
      fs.writeFileSync(req, payload, 'utf8');
    } catch (err) {
      return { ok: false, error: `write-req: ${String(err?.message || err).slice(0, 120)}` };
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        cleanup({ req, out });
        /* 卡住的不只是一句 —— 整条队列都排在它后面。杀掉重来比干等划算。 */
        console.warn('[tts] 合成超时，重启合成进程');
        killChild();
        resolve({ ok: false, error: 'timeout' });
      }, SYNTH_TIMEOUT);

      waiting.set(id, { resolve, timer, req, out });
      if (!child) {                       // 竞态：刚被判死
        clearTimeout(timer);
        waiting.delete(id);
        cleanup({ req, out });
        resolve({ ok: false, error: 'no-child' });
      }
    });
  });
}

/** PS 在 READY 时报上来的音色名（第一次合成之后才有）。 */
function synthVoices() { return voices.slice(); }
function synthReady() { return ready; }

module.exports = {
  SCAN_MS, SYNTH_TIMEOUT, MAX_RESTARTS,
  startSynth, stopSynth, synthWav, synthVoices, synthReady
};
