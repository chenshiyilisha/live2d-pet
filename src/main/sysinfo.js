'use strict';

const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { clamp } = require('./util');

/* ============================================================
 *  系统状态采集
 * ==========================================================
 *
 * CPU / 内存 / 磁盘走 Node 的 os / fs（同步、微秒级）；
 * 电量 / 网速 / GPU 占用 / 温度 Windows 没有原生 API，得靠 PowerShell
 * 或厂商命令 —— 那条路每起一个进程就是 ~500ms 固定开销，所以两条纪律：
 *   1) 只在真正需要时才取（用户开口问、或开了悬浮显示）；
 *   2) 能合并的合并进**同一个** powershell 进程（见 slowPart）。
 *
 * ⚠️ collectStats 的入参是「要哪些慢字段」而不是一个布尔开关。
 *    以前是 `collectStats(true)` 一把梭，可悬浮小字只显示 CPU / 内存 / GPU /
 *    温度，却连带把电量和网速也取了 —— 网卡统计在本机要 2.5 秒，
 *    等于每 3 秒白烧掉大半的时间片。见 HUD_FIELDS / FULL_FIELDS。
 *
 * 定时往渲染层推状态的那部分（refreshStatsTimer）留在 main.js ——
 * 它要碰窗口，不属于「采集」。
 * ========================================================== */

let lastCpuSample = null;

/* 采样窗口的合理区间（毫秒）。
 * 太短（相邻帧）噪声大；太长（比如拿开机时那一枪当基线）算出来的是
 * 「这段时间的平均占用」，跟用户问的「CPU 现在多少」不是一回事。
 * 落到区间外就丢掉旧基线、重新起算 —— 宁可多等 260ms，也别报个假数。 */
const CPU_WIN_MIN = 200;
const CPU_WIN_MAX = 10000;

function cpuPercent() {
  const st = cpuStatus();
  return st.util;
}

/* 带原因版：调用方要能区分"没有基线"（值得补枪）和"窗口不合适"（补枪无用）。
 * （GPU 那边曾经也是这套，2026-10-13 改成 nvidia-smi 直读之后不再需要。） */
function cpuStatus() {
  const cpus = os.cpus();
  if (!cpus || !cpus.length) return { util: null, reason: 'no-sample' };
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  const now = Date.now();
  const prev = lastCpuSample;
  if (!prev) { lastCpuSample = { idle, total, t: now }; return { util: null, reason: 'no-baseline' }; }
  const dt = now - prev.t;
  if (dt < CPU_WIN_MIN || dt > CPU_WIN_MAX) {
    lastCpuSample = { idle, total, t: now };
    return { util: null, reason: 'bad-window' };
  }
  const dIdle = idle - prev.idle;
  const dTotal = total - prev.total;
  lastCpuSample = { idle, total, t: now };
  if (dTotal <= 0) return { util: null, reason: 'bad-window' };
  return { util: Math.round(clamp((1 - dIdle / dTotal) * 100, 0, 100)), reason: 'ok' };
}

/* 拿一个「当下」的 CPU 占用。冷启动后用户开口就问「CPU 多少」时，
 * 上一枪是不存在的（或早就过期了），cpuPercent() 会返回 null —— 那就等
 * 一小会儿补第二枪，保证答得出数来。
 * ⚠️ 只有 no-baseline 才值得补枪；bad-window（例如连着调两次）补枪也一样
 *    落在窗口外，白等 260ms。 */
async function cpuPercentFresh() {
  const st = cpuStatus();
  if (st.util !== null || st.reason !== 'no-baseline') return st.util;
  await new Promise((r) => setTimeout(r, 260));
  return cpuPercent();
}

/* ---------- GPU 占用 ---------- */

/* 🔴 口径（2026-10-13 修正）：**有 NVIDIA 独显就用独显的利用率**。
 *
 * 之前是「WMI 的 GPUEngine(engtype_3D) 跨实例求和」，在**双 GPU 机器上是错的**：
 * 那些实例是**按 luid 分**的，核显与独显各有一串，求和出来的是「两块卡加在一起」，
 * 既不等于核显也不等于独显。实测本机（Intel UHD + RTX 4070）：
 *   · 桌宠渲染在**核显**上 —— `?snap=` 打的 webgl backend 是
 *     "ANGLE (Intel, Intel(R) UHD Graphics (0x0000A78B), Direct3D11)"，
 *     且 GPUEngine 里 Electron 那个 GPU 进程的实例**全落在核显的 luid 上**；
 *   · 于是求和的结果几乎全是核显的占用 —— 用户看到的是「核显的 GPU 占用」
 *     （2026-10-12 用户报："取的好像不是独立显卡的，好像是核心显卡的"，属实）。
 * 现在改成问 nvidia-smi 要独显的 `utilization.gpu`，**和温度同一个调用**
 * （一次拿两个值，实测 ~180ms，与 WMI 的 161ms 同量级，不额外加开销）。
 *
 * 🔴 **没有 N 卡就整项不取**（用户 2026-10-13 明确："没有就不取"）——
 *    与温度完全同一个规矩：不硬凑、更不用核显的数字冒充独显。
 *    所以底座上「GPU 占用」和「温度」是**同生共死**的一对：有 N 卡就都有，
 *    没有就都不画。（AMD 独显目前也归到"没有"——只用 WMI 取不到可靠的
 *    独显口径，宁可空着。）
 *
 * 为什么不用 Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine：
 * 本机实测那个 **formatted 类恒返回 0**（613 个实例全是 0），是坏的；
 * 同名的 raw 类才有真实的累计值（要用就得两枪求差）。这条坑记在这里是给
 * 将来想拿 WMI 补 CPU 温度之类的人看的 —— 本文件的 GPU 已经不用它了。
 *
 * 原先那一支的口径是「engtype_3D 跨实例求和」，连同两枪求差的一整套
 * （GPU_WIN_MIN / lastGpuSample / gpuStatus / 补枪）**2026-10-13 整体移除**：
 * 求和那条路在双 GPU 机器上口径就是错的（见上），而"没有独显就不取"之后
 * 它再没有存在的场景。留下的只有 nvidia-smi 直接给的一个百分比，
 * 代码反而短了一大截（少了一次求差、一次补枪、一套窗口合法性判定）。
 */
function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    percent: Math.round((used / total) * 100),
    usedGB: Math.round((used / 1073741824) * 10) / 10,
    totalGB: Math.round((total / 1073741824) * 10) / 10
  };
}

function diskInfo() {
  try {
    const st = fs.statfsSync('C:\\');
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return {
      percent: Math.round(((total - free) / total) * 100),
      freeGB: Math.round((free / 1073741824) * 10) / 10,
      totalGB: Math.round((total / 1073741824) * 10) / 10
    };
  } catch {
    return null;
  }
}

/* 调 PowerShell 并解析 JSON。失败 / 超时一律返回 null ——
 * 系统状态是锦上添花，绝不能因为它出错影响桌宠本身。 */
function psJson(script, timeout = 2600) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), timeout);
    try {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout, maxBuffer: 1 << 20 },
        (err, stdout) => {
          clearTimeout(timer);
          if (err || !stdout) return finish(null);
          const txt = String(stdout).trim();
          if (!txt || txt === 'null') return finish(null);
          try { finish(JSON.parse(txt)); } catch { finish(null); }
        });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

let lastNetSample = null;

/* ---------- 慢传感器：合并成一个 PowerShell 进程 ---------- */

/* 温度为什么只有一个来源。
 *
 * Windows 没有跨厂商的温度接口。查过开源实现（kobe718/gpu-smi —— 纯
 * PowerShell + 性能计数器、号称支持 A/N/I 三家的那个），它在文档里明确写着
 * "Temperature and power consumption not yet implemented (requires
 * vendor-specific APIs)"。这跟本机实测完全一致，四条路全断：
 *   - MSAcpi_ThermalZoneTemperature        → 拒绝访问（要管理员）
 *   - Get-Counter Thermal Zone Information → 能出数，但本机 _tz.tz00 恒
 *     301K、_tz.tz02 恒 283K（= 9.9℃），连采 3 次一字不变 —— 是死值，
 *     比没有更坏，因为它看起来像个数
 *   - Win32_TemperatureProbe               → 空
 *   - root\HP 命名空间                      → 只有 CIM 基础类，无温度类
 * 所以温度只用显卡厂商自己的工具：NVIDIA 就是 nvidia-smi。
 * 没有 NVIDIA 显卡就**干脆不显示这一行**，不硬凑一个来路不明的数。
 */

/* 按需拼一个取数脚本。键名压到 6 字符以内 —— 这份 JSON 每 3 秒要过一遍命令行，
 * 键名越短，"每拍白带的固定开销"越小。 */
function sensorScript(want) {
  const L = ['$o = [ordered]@{}'];

  if (want.battery) {
    L.push('$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1');
    L.push('if ($b) { $o.batPct = [int]$b.EstimatedChargeRemaining; $o.batChg = [bool]($b.BatteryStatus -eq 2) }');
  }

  /* GPU 占用与温度**同源**：都只认 nvidia-smi（**独显**口径，见文件头那段）。
   * 一次调用拿两个值（拆成两次就是白付一次进程启动）。
   * 没有 N 卡（或这一拍读不到）就两个都不填 —— 与温度同一个规矩：
   * 不硬凑、更不用核显的数字冒充独显。 */
  if (want.gpu || want.temp) {
    L.push("$smi = Join-Path $env:SystemRoot 'System32\\nvidia-smi.exe'");
    L.push('if (Test-Path $smi) {');
    L.push("  $line = & $smi --query-gpu=utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1");
    L.push("  if ($line -match '^\\s*(\\d+)\\s*,\\s*(\\d+)\\s*$') { $o.nvGpu = [int]$Matches[1]; $o.tempC = [int]$Matches[2] }");
    L.push('}');
  }

  L.push('$o | ConvertTo-Json -Depth 4 -Compress');
  return L.join('\n');
}

/* ---------- 常驻传感器采样进程 ---------- */

/* 🔴 为什么要有这个东西（别再走回头路）：
 *
 * 一句话：**每 3 秒起一个新的 powershell 太贵，而且数太旧**。
 *   - 一个 powershell.exe 的固定启动开销就有 ~500ms（模块自动加载），
 *     加上 nvidia-smi 的 ~180ms，实测一次 push 要 1035ms；
 *   - 而且那时拿到的读数只能描述"上一次推送到现在"这一整段（约 4 秒），
 *     用户刚打开一个吃显卡的程序，要等下一整拍才看得到它涨上去。
 * 常驻之后：一个 powershell 每 1 秒读一枪，单次查询只要 ~180ms
 * （首次 222ms，模块加载只付一次），读到的是**眼前这一秒**。
 * 所以这不是"为了准而变费"，是把延迟和开销一起降下来了。
 *
 * （历史备注：这个东西最初是为了修「GPU 占用慢一拍」—— 那时 GPU 走 WMI 的
 *   累计计数器，要两枪求差，而"上一枪"来自上一次推送，窗口 4050ms。
 *   2026-10-13 GPU 改成 nvidia-smi 直读以后，求差那一步没有了，
 *   但"常驻比每拍起进程便宜得多"这一点没变，所以采样器留着。
 *   CPU 那边仍是求差（os.cpus() 的累计值，主进程自己算，不经过这里）。）
 *
 * ⚠️ 只在该用的时候开：悬浮显示关着、或全屏静默中，立刻停掉（见 main.js 的
 *    refreshStatsTimer）。一条常驻进程哪怕很便宜，也不该在不需要时白跑。 */

/* 采样间隔的兜底值 —— 真正的节奏由 main.js 按**显示间隔**传进来
 * （见 startSensorWatch）。显示每 3 秒才推一次，采样就没必要每秒一枪：
 * 多出来的那两枪没有任何人看得到，只是白起两次 nvidia-smi（单次 ~180ms，
 * 是这条路径的全部成本）。
 * ⚠️ 两头都有理由：**不低于 1000**（底座那格要"眼前这一秒"的手感），
 *    **不高于 LIVE_TTL**（再慢读数就算过期，查询会退回"现起一个进程打一枪"，
 *    反而比常驻更贵）。 */
const SAMPLE_MS = 1000;
const LIVE_TTL = 5000;       // 读数超过这么久没更新就当过期（采样进程挂了时的兜底）

let sensorChild = null;
let sensorBuf = '';
let sensorStopped = true;
let sensorRestarts = 0;
let sensorRestartTimer = null;
let sensorStartedAt = 0;   // 本次 spawn 的时刻（给"还没吐出第一行"的宽限期用）
let sensorSampleMs = 0;    // 当前跑着的采样间隔（改间隔必须重启进程，见 startSensorWatch）
let lastTickAt = 0;        // 最后一次收到读数的时刻（判"新不新鲜"）

/* 常驻采样器给出的最近读数。没在采样 / 已过期时是 null，
 * 那种情况下 slowPart 会退回"起一个进程打一枪"的老路。 */
const live = { gpu: null, gpuAt: 0, tempC: null, tempAt: 0, ticks: 0, gpuOk: false, tempOk: false };

/* 采样脚本。和 fullscreen.js 里那份同构，同样两条纪律：
 * 纯 ASCII + `-EncodedCommand`，以及每 10 拍自查父进程还在不在
 * （Windows 上父进程退出不会带走子进程，不留野进程）。
 *
 * 每拍只起**一个** nvidia-smi（一次拿利用率 + 温度，实测 ~180ms，
 * 与原先那条 WMI 查询的 161ms 同量级）。原先温度是每 3 拍取一次的分频，
 * 现在去掉：利用率每拍都要，而两个值同一次调用就能拿到，
 * 分频反而要把这一次调用拆成"每拍一次取利用率 + 每 3 拍一次取温度"= 更贵。 */
function sensorWatchScript(parentPid, sampleMs) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$smi = Join-Path $env:SystemRoot 'System32\\nvidia-smi.exe'",
    '$hasSmi = Test-Path $smi',
    '$parent = ' + parentPid,
    '$i = 0',
    '$w = [Console]::Out',
    'while ($true) {',
    '  $i = $i + 1',
    '  if (($i % 10) -eq 0) {',
    '    if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }',
    '  }',
    '  $o = [ordered]@{}',
    '  if ($hasSmi) {',
    "    $line = & $smi --query-gpu=utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1",
    "    if ($line -match '^\\s*(\\d+)\\s*,\\s*(\\d+)\\s*$') { $o.nvGpu = [int]$Matches[1]; $o.tempC = [int]$Matches[2] }",
    '  }',
    '  $w.WriteLine(($o | ConvertTo-Json -Depth 4 -Compress))',
    '  $w.Flush()',
    '  Start-Sleep -Milliseconds ' + sampleMs,
    '}'
  ].join('\n');
}

/* 起常驻采样器。sampleMs 由上层按显示节奏给（默认 SAMPLE_MS）。
 * ⚠️ 间隔是**编码进脚本里的常量**，已经跑着的那份改不了 —— 所以间隔变了
 *    必须重启进程才会生效（否则改了配置还是按老节奏采）。 */
function startSensorWatch(sampleMs = SAMPLE_MS) {
  if (process.platform !== 'win32') return false;
  if (sensorChild) {
    if (sampleMs === sensorSampleMs) return true;
    stopSensorWatch();
  }
  sensorSampleMs = sampleMs;

  sensorStopped = false;
  sensorRestarts = 0;

  const spawnOnce = () => {
    if (sensorStopped) return;
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(sensorWatchScript(process.pid, sampleMs), 'utf16le').toString('base64')
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[sensor] 起不了采样进程:', String(err?.message || err));
      scheduleRestart();
      return;
    }

    sensorChild = proc;
    sensorRestarts = 0;
    sensorStartedAt = Date.now();
    console.log('[sensor] 采样进程已启动（每 ' + sampleMs + 'ms 一次）');

    proc.stdout.setEncoding('utf8');
    sensorBuf = '';
    proc.stdout.on('data', (chunk) => {
      sensorBuf += chunk;
      const lines = sensorBuf.split('\n');
      sensorBuf = lines.pop() || '';
      for (const line of lines) handleSensorLine(line);
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* ignore */ });
    proc.on('error', (err) => console.warn('[sensor] 采样进程异常:', String(err?.message || err)));
    proc.on('exit', (code) => {
      if (sensorChild === proc) sensorChild = null;
      if (!sensorStopped) console.warn('[sensor] 采样进程退出，code =', code);
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (sensorStopped) return;
    // 同 fullscreen：反复退出（比如 PowerShell 被策略拦了）就放弃，
    // 而不是变成每秒重启一次的循环
    if (sensorRestarts >= 6) {
      console.warn('[sensor] 采样进程反复退出，放弃（退回每次现打一枪的老路）');
      return;
    }
    sensorRestarts++;
    clearTimeout(sensorRestartTimer);
    sensorRestartTimer = setTimeout(spawnOnce, 5000);
  };

  spawnOnce();
  return true;
}

function handleSensorLine(line) {
  const s = line.trim();
  if (!s || s[0] !== '{') return;
  let r;
  try { r = JSON.parse(s); } catch { return; }

  live.ticks++;
  lastTickAt = Date.now();

  /* GPU 只有一条口径：nvidia-smi 给的**独显**百分比（见文件头那段），
   * 拿过来就能用 —— 没有两枪求差那一步了。
   * ⚠️ 没有 N 卡时脚本根本不带这个字段，这里自然什么都不做；上层于是永远
   *    拿不到 GPU 读数，底座那一格就不画（和温度一个待遇）。 */
  if (r && typeof r.nvGpu === 'number') {
    live.gpu = Math.round(clamp(r.nvGpu, 0, 100));
    live.gpuAt = Date.now();
    live.gpuOk = true;
    flushGpuWaiters();
  }
  if (r && typeof r.tempC === 'number') {
    live.tempC = r.tempC;
    live.tempAt = Date.now();
    live.tempOk = true;
  }
}

function stopSensorWatch() {
  sensorStopped = true;
  clearTimeout(sensorRestartTimer);
  sensorRestartTimer = null;
  /* 采样器一停，等 GPU 的调用方就没指望了 —— 立刻放行，别让它干等到超时
   * （静默开始时会走这里，那时上层本来就该把推送停下）。 */
  flushGpuWaiters();
  if (sensorChild) {
    const proc = sensorChild;
    sensorChild = null;
    try { proc.kill(); } catch { /* ignore */ }
  }
}

/* 常驻读数，过期（或从没采到）返回 null —— 调用方据此决定要不要现打一枪。 */
function liveGpu() {
  return (live.gpu !== null && Date.now() - live.gpuAt <= LIVE_TTL) ? live.gpu : null;
}
function liveTemp() {
  return (live.tempC !== null && Date.now() - live.tempAt <= LIVE_TTL) ? live.tempC : null;
}

/* 常驻采样器是不是"活着、且确实还会继续给数"。
 *
 * 这个判据只有一个用途：**决定要不要另起一个进程现打一枪**。
 * 采样器活着时就不该再起进程 —— 它 ≤1s 就给新数，等它比自己去打划算
 * （少付一次 powershell 启动开销，也不会两条路互相干扰）。
 *
 * 两段判据：
 *   ① 刚收到读数（< 2.5 拍）—— 正常状态；
 *   ② 刚 spawn 出来还没吐第一行 —— PowerShell 启动 + 头一拍要 1~2s，这段宽限
 *      不能当成"它死了"。给 8s，之后还不给数才认账。
 * ⚠️ 进程一 exit 就把 sensorChild 置空，所以"脚本被策略拦掉"会立刻掉到
 *    兜底路径，不会干等这 8s。 */
const SENSOR_ALIVE_MS = 2500;
const SENSOR_GRACE_MS = 8000;

function sensorAlive() {
  if (sensorStopped || !sensorChild) return false;
  if (lastTickAt && Date.now() - lastTickAt < SENSOR_ALIVE_MS) return true;
  return Date.now() - sensorStartedAt < SENSOR_GRACE_MS;
}

/* ── 「等第一个 GPU 读数」 ──
 *
 * 采样器要先把 powershell 拉起来、再跑一次 nvidia-smi 才吐第一行（实测 ≈1.5s）。
 * 主进程的第一次推送如果不等它，那一帧就是"半张牌"：CPU / 内存先出，
 * 牌上留一个空位，GPU 下一拍才补进来 —— 正是用户说的「GPU 比别的项慢一拍」。
 * 等它一次换来"首次出现就是完整的一张牌"，比先给半张再补更干净。
 *
 * ⚠️ 采样器没在跑就立刻返回 false，**不许干等** —— 没有独显 / 采样器起不来的
 *    机器上，等是等不来的，只会白耽误时间（那时 slowPart 的兜底路径会负责出数）。 */
let gpuWaiters = [];

function flushGpuWaiters() {
  if (!gpuWaiters.length) return;
  const list = gpuWaiters;
  gpuWaiters = [];
  for (const w of list) w(true);
}

function waitForFirstGpu(ms = 4500) {
  if (live.gpu !== null) return Promise.resolve(true);   // 已经有新鲜读数
  if (!sensorAlive()) return Promise.resolve(false);     // 采样器没跑，别等
  if (gpuUnavailable()) return Promise.resolve(false);   // 已经断定这台机器没有 GPU 计数器，等也没用
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      gpuWaiters = gpuWaiters.filter((w) => w !== done);
      resolve(false);
    }, ms);
    const done = (v) => { clearTimeout(timer); resolve(v); };
    gpuWaiters.push(done);
  });
}

/* ⚠️ 「采样器转了 8 拍以上却一次都没给出这一项」= 这台机器根本没有这个数据源
 *    （没有 N 卡 → GPU 占用与温度都没有；独显驱动异常 → nvidia-smi 取不到）。
 *    这时候必须把它标成"永远取不到"，否则 slowPart 每次推送都会为它
 *    白起一个 powershell 进程 —— 白白回到每 3 秒 1 秒开销的老路上，
 *    而结果永远是空的。这就是这台机器上"没有独显就整项不画"的正确代价：
 *    画不出来，但也不再为它花钱。 */
function gpuUnavailable() { return live.ticks >= 8 && !live.gpuOk; }
function tempUnavailable() { return live.ticks >= 8 && !live.tempOk; }

/* 取一次慢字段，直接写进 out。
 *
 * ⚠️ 必须合并成一个进程：每个 powershell.exe 有 ~500ms 的固定启动开销
 *    （模块自动加载），拆成三次调用就是白付三次。
 * ⚠️ 常驻采样器正在跑时，这条路径**一次进程都不该起** —— 先查 live 读数，
 *    全部命中就直接返回。这是"每 3 秒 1035ms"降到"0"的那一步。 */
async function slowPart(out, want) {
  let needGpu = false;
  let needTemp = false;

  /* 采样器活着时**绝不现打一枪**（理由见 sensorAlive 上面那段）：
   * 它 ≤1s 就给新数，这一帧宁可不画（交给上层等 / 下一拍），
   * 也不去重复起一个 powershell。 */
  const busy = sensorAlive();

  if (want.gpu) {
    const g = liveGpu();
    if (g !== null) out.gpu = g;
    else if (!busy && !gpuUnavailable()) needGpu = true;
  }
  if (want.temp) {
    const t = liveTemp();
    if (t !== null) out.tempC = t;
    else if (!busy && !tempUnavailable()) needTemp = true;
  }
  // 电量没有常驻采样（悬浮小字不显示它），一律现取
  const needBattery = !!want.battery;
  if (!needGpu && !needTemp && !needBattery) return;

  const script = sensorScript({ gpu: needGpu, temp: needTemp, battery: needBattery });

  // 超时给宽一点：nvidia-smi 在显卡刚休眠时会慢一拍（实测偶发 640ms）
  let r = await psJson(script, 4000);
  if (!r) return;

  if (needGpu && typeof r.nvGpu === 'number') {
    /* 独显口径：nvidia-smi 直接给百分比，没有"两枪求差"这一步，
     * 也就不存在"没基线要补枪"的问题 —— 一枪就是结果。 */
    out.gpu = Math.round(clamp(r.nvGpu, 0, 100));
  }

  if (needTemp && typeof r.tempC === 'number') out.tempC = r.tempC;
  if (want.battery && typeof r.batPct === 'number') {
    out.battery = { percent: r.batPct, charging: !!r.batChg };
  }
}

async function netInfo() {
  const a = await netSample();
  if (!a) return null;

  /* 有「够新」的旧样本就直接求差 —— 悬浮显示 3 秒一推，这样每次只花一次
   * PowerShell（约 400ms），不用每次量两枪。 */
  const prev = lastNetSample;
  lastNetSample = a;
  if (prev && a.t - prev.t >= 250 && a.t - prev.t <= 30000) {
    const dt = (a.t - prev.t) / 1000;
    return {
      down: Math.max(0, (a.rx - prev.rx) / dt),
      up: Math.max(0, (a.tx - prev.tx) / dt)
    };
  }

  /* 没有可用基线（冷启动 / 距上次太久）→ 补第二枪，量一个真实的瞬时速率。
   * 不能拿「开机到现在」的累计流量去除时间，那是平均速率，用户问的是当下。 */
  await new Promise((r) => setTimeout(r, 400));
  const b = await netSample();
  if (!b) return null;
  lastNetSample = b;
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0) return null;
  return {
    down: Math.max(0, (b.rx - a.rx) / dt),
    up: Math.max(0, (b.tx - a.tx) / dt)
  };
}

/* 单次取样：累计收发字节 + 时刻。 */
async function netSample() {
  const r = await psJson(
    '$a = Get-NetAdapterStatistics -ErrorAction SilentlyContinue; ' +
    'if (-not $a) { "null" } else { ' +
    '$rx = ($a | Measure-Object ReceivedBytes -Sum).Sum; ' +
    '$tx = ($a | Measure-Object SentBytes -Sum).Sum; ' +
    '[pscustomobject]@{ rx = [long]$rx; tx = [long]$tx } | ConvertTo-Json -Compress }'
  );
  if (!r || typeof r.rx !== 'number') return null;
  return { rx: r.rx, tx: r.tx, t: Date.now() };
}

/* 慢字段清单 —— 调用方按需声明。
 * 悬浮小字只画 CPU / 内存 / GPU / 温度，就不该顺手把电量与网速也取了。 */
const HUD_FIELDS = ['gpu', 'temp'];
const FULL_FIELDS = ['battery', 'net', 'gpu', 'temp'];

/* 汇总一次系统状态。fields 里的慢字段才去问 PowerShell / 厂商命令。 */
async function collectStats(fields = []) {
  const want = {
    gpu: fields.includes('gpu'),
    temp: fields.includes('temp'),
    battery: fields.includes('battery')
  };

  const out = {
    cpu: await cpuPercentFresh(),
    mem: memInfo(),
    disk: diskInfo(),
    uptimeMin: Math.round(os.uptime() / 60),
    host: os.hostname()
  };

  /* 慢的两条并行：
   *   - 传感器（电量 / GPU / 温度）合并成一个 powershell 进程
   *   - 网速自己一条 —— 它要隔着时间采两枪，塞不进合并脚本
   * 并行是为了压墙钟时间；两条都在子进程里，不挡主线程。 */
  const jobs = [slowPart(out, want)];
  if (fields.includes('net')) jobs.push(netInfo().then((v) => { out.net = v; }));
  await Promise.all(jobs);

  return out;
}

/* 把状态写成一句人话，直接塞进气泡。 */
function formatStats(s) {
  const parts = [];
  if (s.cpu !== null && s.cpu !== undefined) parts.push(`CPU ${s.cpu}%`);
  if (s.mem) parts.push(`内存 ${s.mem.percent}%（${s.mem.usedGB}/${s.mem.totalGB}G）`);
  if (typeof s.gpu === 'number') parts.push(`GPU ${s.gpu}%`);
  /* 这里必须写明是"GPU 温度"。只说"温度 47℃"会让人以为是 CPU ——
   * 而 CPU 温度在非管理员下根本取不到（见 sensorScript 上面的注释）。 */
  if (typeof s.tempC === 'number') parts.push(`GPU 温度 ${s.tempC}℃`);
  if (s.disk) parts.push(`C 盘剩 ${s.disk.freeGB}G`);
  if (s.battery) {
    parts.push(`电量 ${s.battery.percent}%${s.battery.charging ? '（充电中）' : ''}`);
  }
  if (s.net && (s.net.down > 0 || s.net.up > 0)) {
    parts.push(`网速 ↓${fmtRate(s.net.down)} ↑${fmtRate(s.net.up)}`);
  }
  return parts.join('，') || '取不到系统状态。';
}

function fmtRate(bps) {
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(1)}MB/s`;
  if (bps >= 1024) return `${Math.round(bps / 1024)}KB/s`;
  return `${Math.round(bps)}B/s`;
}

module.exports = {
  collectStats,
  formatStats,
  startSensorWatch,
  stopSensorWatch,
  waitForFirstGpu,
  HUD_FIELDS,
  FULL_FIELDS
};
