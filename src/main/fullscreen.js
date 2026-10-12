'use strict';

const { spawn } = require('child_process');

/* ============================================================
 *  前台全屏检测（Windows）——「游戏 / 看片时自动静默」的输入
 * ==========================================================
 *
 *  要回答的问题只有一个：**此刻前台那个窗口是不是占满了整块显示器？**
 *
 *  为什么不用现成的办法：
 *    - Electron 没有任何 API 能拿到"系统前台窗口"（它只管自己的窗口）。
 *    - `powerMonitor` 只有锁屏/休眠/电源事件，没有窗口状态。
 *    - 没有 npm 依赖能做这件事，而本机在代理环境下装包很不可靠。
 *  → 只能走 Win32：GetForegroundWindow + GetWindowRect + GetMonitorInfo。
 *
 *  ⚠️ **判定用显示器的物理边界（rcMonitor），不是工作区（rcWork）。**
 *    这是整件事的关键分水岭：
 *      · 真全屏（独占全屏 / 无边框全屏）会盖住任务栏 → 窗口 rect == rcMonitor
 *      · 只是"最大化"的普通窗口会停在任务栏上方 → rect.bottom == rcWork.bottom
 *    如果拿 rcWork 去比，**任何最大化的记事本都会被判成全屏**，
 *    她就会在你写文档时莫名其妙地静默。
 *
 *  ⚠️ 起一个**常驻**的 powershell.exe，而不是每次采样起一个。
 *    每个 powershell.exe 有 ~500ms 的固定启动开销（模块自动加载），
 *    1 秒采一次就等于每秒烧掉半个 CPU 核。常驻进程里 Add-Type 只编译一次，
 *    之后的循环就是几次 interop 调用 + Start-Sleep，开销可以忽略。
 *
 *  分工：**PowerShell 只负责采样（哑的），判定全在 JS 里。**
 *    这样判定逻辑能在 node 里直接单测（debug/verify-quiet.js），
 *    而 PowerShell 那边一旦有编码/引号问题也不会污染业务逻辑。
 * ========================================================== */

/* 桌面外壳窗口的类名 —— 它们"看起来"也占满整屏（桌面的尺寸就是屏幕尺寸），
 * 但显然不算全屏应用。不排除掉的话，一按 Win+D 回到桌面就进静默。
 *
 * ⚠️ 这里**刻意不包含** `Windows.UI.Core.CoreWindow`（开始菜单、任务视图、
 *    以及部分 UWP 应用都用它）。它的代价是"全屏的 UWP 应用检测不到"，
 *    但收益明确：开始菜单一点就开、再点就关，若把它算成全屏，
 *    关掉开始菜单后还要等 4 秒迟滞才恢复 —— 那种"卡住 4 秒"比漏检更烦人。 */
const SHELL_CLASSES = new Set([
  'Progman',                 // 桌面（旧版）
  'WorkerW',                 // 桌面壁纸层（Win10 起）
  'Shell_TrayWnd',           // 主任务栏
  'Shell_SecondaryTrayWnd'   // 副屏任务栏
]);

/* 采样间隔。900ms 是"感知不到延迟"与"几乎不占资源"之间的折中：
 * Alt+Tab 出来之后最多 0.9 秒恢复，而常驻进程本身的开销远低于这个量级。 */
const SAMPLE_MS = 900;

/* 进入立刻生效、退出延迟 4 秒（迟滞）。
 *
 * ⚠️ 退出延迟不是可有可无的装饰：**Alt+Tab 出去看一眼攻略再切回来**是
 *    打游戏时最常见的动作，中间那段桌面只停留一两秒。没有迟滞的话，
 *    她会在这几秒里"醒过来"（恢复溜达、重启状态轮询、重新置顶），
 *    切回游戏又立刻睡回去 —— 每次切换都白折腾一轮，还可能在游戏画面上闪一下。
 * 进入不需要延迟：越早停止遛达和轮询越好。 */
const ENTER_MS = 0;
const EXIT_MS = 4000;

/* ============================================================
 *  判定（纯函数，可单测）
 * ========================================================== */

/* sample 形状（PowerShell 每行吐一个 JSON）：
 *   { r: [l,t,r,b] | null,   // 前台窗口矩形；null = 没有前台窗口
 *     m: [l,t,r,b],          // 该窗口所在显示器的物理边界
 *     c: 'Chrome_WidgetWin_1',
 *     p: 1234 }
 *
 * ⚠️ 必须排除**自己**（selfPid）：桌宠窗口虽然小，但如果哪天它自己被判定
 *    成全屏（比如将来改成可拉伸），就会"自我静默"并且再也醒不过来 ——
 *    因为静默本身不会改变前台窗口。这类死锁要在这里一次性堵死。 */
function evaluateSample(sample, selfPid) {
  if (!sample || !Array.isArray(sample.r) || !Array.isArray(sample.m)) {
    return { full: false, why: 'no-foreground' };
  }
  if (selfPid && sample.p === selfPid) return { full: false, why: 'self' };

  const cls = String(sample.c || '');
  if (SHELL_CLASSES.has(cls)) return { full: false, why: `shell:${cls}` };

  const [l, t, r, b] = sample.r;
  const [ml, mt, mr, mb] = sample.m;
  // 覆盖到显示器的物理边界才算全屏（最大化窗口会差一条任务栏，见文件头说明）
  const covers = l <= ml && t <= mt && r >= mr && b >= mb;
  if (!covers) return { full: false, why: 'windowed' };

  return { full: true, why: `fullscreen:${cls}` };
}

/* ============================================================
 *  迟滞（进/出不对称），同样是纯逻辑 —— 定时器可注入，方便单测
 * ========================================================== */

class Hysteresis {
  /**
   * @param {object}   o
   * @param {Function} o.onChange 只在"对外可见的状态真的变了"时调用
   * @param {number}   o.enterMs  进入延迟，默认 0（立刻）
   * @param {number}   o.exitMs   退出延迟，默认 4000（防 Alt+Tab 抖动）
   * @param {Function} o.setT / o.clearT  注入定时器（测试用假时钟）
   */
  constructor({ onChange, enterMs = ENTER_MS, exitMs = EXIT_MS, setT = setTimeout, clearT = clearTimeout } = {}) {
    this.onChange = onChange;
    this.enterMs = enterMs;
    this.exitMs = exitMs;
    this.setT = setT;
    this.clearT = clearT;

    this.state = false;      // 已经对外发出的状态
    this.pending = null;     // 正排着队要发的状态（null = 没有在排）
    this.timer = null;
    this.why = '';
  }

  push(full, why) {
    const next = !!full;
    this.why = why || this.why;

    // 与已发出的状态一致 → 撤销排着的反向变更（"又变回来了"）
    if (next === this.state) {
      if (this.pending !== null) {
        this.cancel();
        this.pending = null;
      }
      return;
    }
    // 已经在排同一个方向 → 什么都不用做（避免每次采样都重置定时器）
    if (this.pending === next) return;

    this.cancel();
    this.pending = next;
    const delay = next ? this.enterMs : this.exitMs;
    if (delay <= 0) { this.fire(); return; }
    this.timer = this.setT(() => this.fire(), delay);
  }

  fire() {
    this.timer = null;
    const next = this.pending;
    this.pending = null;
    if (next === null || next === this.state) return;
    this.state = next;
    try { this.onChange(this.state, this.why); }
    catch (err) { console.error('[fullscreen] onChange 抛错:', String(err?.message || err)); }
  }

  cancel() {
    if (this.timer) {
      try { this.clearT(this.timer); } catch { /* ignore */ }
      this.timer = null;
    }
  }

  stop() {
    this.cancel();
    this.pending = null;
  }
}

/* ============================================================
 *  采样脚本（纯 ASCII —— 用 -EncodedCommand 送进去，绕开一切编码/引号问题）
 * ========================================================== */

/* ⚠️ 脚本里**不能出现任何非 ASCII 字符**。
 *    这条路走的是 powershell.exe 的命令行参数，中文会经过控制台代码页，
 *    在 GBK/UTF-16 之间来回转换，出问题时报错信息往往指向别处。
 *    纯 ASCII 则随便怎么转都不会坏。
 *  ⚠️ 用 `-EncodedCommand`（base64 的 UTF-16LE）而不是 `-Command`：
 *    后者要把整段脚本塞进命令行，引号转义、长度上限、代码页三件事都会咬人。
 *  ⚠️ `[Console]::Out.WriteLine` + `Flush()` 而不是 `Write-Output`：
 *    PowerShell 的输出流在 stdout 被重定向时会**攒着不发**，
 *    JS 侧就会一秒一秒地收不到东西（看着像"监视进程死了"）。
 *    Flush 显式推出去。
 *
 *  ⚠️ **每 10 拍自查一次父进程还在不在，不在就退出。**
 *    Windows 上父进程退出**不会**带走子进程，所以应用被强杀（崩溃、任务管理器
 *    结束进程、taskkill /F）时这里没有 will-quit 可跑 —— 没有这道自查就会
 *    留下一个永远在跑的 powershell.exe。管道断开多数情况下也能让它退出，
 *    但那是"碰巧"；这条是确定的。代价是每 9 秒一次 Get-Process，可以忽略。 */
function psScript(sampleMs, parentPid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class AyanFg {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);',
    '  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);',
    '}',
    '\'@',
    '$parent = ' + parentPid,
    '$tick = 0',
    '$sb = New-Object System.Text.StringBuilder 256',
    '$w = [Console]::Out',
    'while ($true) {',
    '  $tick = $tick + 1',
    '  if (($tick % 10) -eq 0) {',
    '    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }',
    '  }',
    '  $h = [AyanFg]::GetForegroundWindow()',
    '  if ($h -eq [IntPtr]::Zero) {',
    '    $w.WriteLine(\'{"r":null}\')',
    '  } else {',
    '    $rc = New-Object AyanFg+RECT',
    '    [void][AyanFg]::GetWindowRect($h, [ref]$rc)',
    '    $op = [uint32]0',
    '    [void][AyanFg]::GetWindowThreadProcessId($h, [ref]$op)',
    '    [void]$sb.Clear()',
    '    [void][AyanFg]::GetClassName($h, $sb, 256)',
    '    $mi = New-Object AyanFg+MONITORINFO',
    // cbSize 必须填对，否则 GetMonitorInfo 直接返回 false（然后 m 全 0，
    // 判定就会偏移）。MONITORINFO 的固定大小 = 4 + 16 + 16 + 4 = 40 字节。
    '    $mi.cbSize = 40',
    '    [void][AyanFg]::GetMonitorInfo([AyanFg]::MonitorFromWindow($h, 2), [ref]$mi)',
    // ⚠️ 这一行必须**整条写在同一行**里。拆成多个数组元素会被 '\n' 接起来，
    //    变成在表达式中间换行 —— PS 5.1 对"行尾是二元运算符"的续行支持
    //    不如 PS 7 可靠，赌它会解析失败不如写长一行。
    '    $w.WriteLine(\'{"r":[\' + $rc.L + \',\' + $rc.T + \',\' + $rc.R + \',\' + $rc.B + \'],"m":[\' + $mi.rcMonitor.L + \',\' + $mi.rcMonitor.T + \',\' + $mi.rcMonitor.R + \',\' + $mi.rcMonitor.B + \'],"c":"\' + $sb.ToString() + \'","p":\' + $op + \'}\')',
    '  }',
    '  $w.Flush()',
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
let hyst = null;
let restartTimer = null;
let restarts = 0;

/* 连续重启上限。
 * ⚠️ 不能无脑重启：如果这台机器上 PowerShell 被组策略禁了（或被安全软件拦了），
 *    spawn 会立刻失败、exit 立刻回来，就变成一个每秒重启一次的循环，
 *    比不工作还糟。超过上限就停下并留一条明确的日志，让"静默功能不生效"
 *    这件事在日志里是可解释的，而不是一个查不到原因的黑洞。 */
const MAX_RESTARTS = 6;
const RESTART_MS = 5000;

function startFullscreenWatch(onChange, opts = {}) {
  if (process.platform !== 'win32') {
    console.log('[fullscreen] 非 Windows，跳过全屏监视');
    return false;
  }
  if (child) return true;         // 已在跑

  stopped = false;
  restarts = 0;
  const { onSample, sampleMs = SAMPLE_MS, enterMs = ENTER_MS, exitMs = EXIT_MS } = opts;

  hyst = new Hysteresis({ onChange, enterMs, exitMs });

  const handleLine = (line) => {
    const s = line.trim();
    if (!s || s[0] !== '{') return;
    let sample;
    try { sample = JSON.parse(s); } catch { return; }   // 半行/杂音，丢
    const r = evaluateSample(sample, process.pid);
    try { onSample?.(sample, r); } catch { /* 诊断钩子不许影响主流程 */ }
    hyst?.push(r.full, r.why);
  };

  const scheduleRestart = () => {
    if (stopped) return;
    if (restarts >= MAX_RESTARTS) {
      console.warn('[fullscreen] 采样进程反复退出，放弃监视（全屏静默将不生效）');
      return;
    }
    restarts++;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(spawnOnce, RESTART_MS);
  };

  const spawnOnce = () => {
    if (stopped) return;
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodeCommand(psScript(sampleMs, process.pid))
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[fullscreen] 起不了采样进程:', String(err?.message || err));
      scheduleRestart();
      return;
    }

    child = proc;
    restarts = 0;
    console.log('[fullscreen] 采样进程已启动（每 ' + sampleMs + 'ms 一次）');
    proc.stdout.setEncoding('utf8');
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() || '';        // 末段可能是半行，留到下一块再拼
      for (const line of lines) handleLine(line);
    });
    // stderr 只丢掉不打印：Add-Type 偶尔会吐无害的告警，刷屏会淹掉真正的日志
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* ignore */ });
    proc.on('error', (err) => {
      console.warn('[fullscreen] 采样进程异常:', String(err?.message || err));
    });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      if (!stopped) console.warn('[fullscreen] 采样进程退出，code =', code);
      scheduleRestart();
    });
  };

  spawnOnce();
  return true;
}

function stopFullscreenWatch() {
  stopped = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  hyst?.stop();
  hyst = null;
  if (child) {
    const proc = child;
    child = null;
    try { proc.kill(); } catch { /* ignore */ }
  }
}

module.exports = {
  SHELL_CLASSES,
  ENTER_MS,
  EXIT_MS,
  evaluateSample,
  Hysteresis,
  startFullscreenWatch,
  stopFullscreenWatch
};
