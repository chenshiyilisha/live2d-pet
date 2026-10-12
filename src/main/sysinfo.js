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

/* 带原因版，理由同 gpuStatus —— 调用方要能区分"没有基线"（值得补枪）
 * 和"窗口不合适"（补枪无用）。 */
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

/* 为什么不用 Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine：
 * 本机实测那个 **formatted 类恒返回 0**（613 个实例全是 0），是坏的；
 * 同名的 raw 类有真实的累计值。所以走「两枪求差」—— 和 cpuPercent 完全同构。
 *
 * 为什么不用 Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage'：
 * 数值是对的（Task Manager 就是这套语义），但它**一次调用要 1.6 秒**
 * （PDH 要枚举上百个实例，还内部自己等采样窗口），而 raw 单枪只要 0.3 秒，
 * 求差在 Node 里是免费的。悬浮小字每 3 秒刷一次，这是常态开销，省下来值得。
 *
 * 口径：只取 engtype_3D（3D 引擎），跨实例求和。
 *   - 只取 3D：VideoDecode / Copy 那些引擎的占用跟"卡不卡"关系不大，
 *     混进来会让看视频时的读数虚高。
 *   - 求和而非取最大：GPU 引擎是「每进程每引擎」一个实例，任务管理器里
 *     一个程序的占用就是它所有实例之和。代价是多引擎（3D 与 Compute
 *     同时忙）时会略高于 100%，已 clamp 到 100。
 */
const GPU_WIN_MIN = 800;      // 采样窗口下限（ms）：太短了噪声大
const GPU_WIN_MAX = 20000;    // 上限：隔太久的两枪算出来是"这段时间的平均"
const GPU_FRESH_MS = 1200;    // 冷启动没有基线时，补第二枪的间隔

let lastGpuSample = null;

/* 把 PowerShell 那一枪的原始数据整理成可求差的形式。 */
function gpuMakeSample(raw) {
  if (!raw || !Array.isArray(raw.eng)) return null;
  const list = raw.eng.map((o) => [String(o.n), Number(o.u) || 0]);
  return { t100: Number(raw.t100) || 0, list, map: new Map(list) };
}

/* 传入这一枪，返回它相对上一枪算出的占用率（并把基线换成这一枪）。
 *
 * 🔴 返回 null 有**两种原因**，调用方必须区分（见 gpuStatus）：
 *      a) 根本没有基线（冷启动第一枪）→ 值得补一枪
 *      b) 有基线但两次之间的时间窗不合适 → 补枪没用，等下一次自然推送
 *    早先的写法把两者混为一谈（`util === null` 就补枪），后果是：任何
 *    两次采样间隔 < GPU_WIN_MIN 的调用都会白等 1.2 秒再打一枪，
 *    墙钟翻三倍。实测 verify-stats 连打两枪时报的 2.2s "热路径开销"
 *    就是这个假象 —— 真实 3 秒节奏下热路径只有 ~450ms。别再退回去。
 *
 * ⚠️ 绝不返回一个凭空的数：宁可这一帧不显示，也别让人看到错的占用率。
 *    （这条和 cpuPercent 里"落到区间外就丢掉旧基线"是同一个理由。）
 */
function gpuPercent(sample) {
  return gpuStatus(sample).util;
}

/* 带原因的状态版：{ util, reason }。
 *   reason: 'ok'        算出数了
 *           'no-baseline'  没有上一枪（冷启动，值得补枪）
 *           'bad-window'   有基线但时间窗不合适（补枪无用）
 *           'no-sample'    这一枪没取到数据（保留旧基线）
 */
function gpuStatus(sample) {
  if (!sample) return { util: null, reason: 'no-sample' };
  const prev = lastGpuSample;
  lastGpuSample = sample;
  if (!prev) return { util: null, reason: 'no-baseline' };
  const dt = sample.t100 - prev.t100;
  if (dt <= 0) return { util: null, reason: 'bad-window' };
  const ms = dt / 10000;                 // Timestamp_Sys100NS 是 100ns 单位
  if (ms < GPU_WIN_MIN || ms > GPU_WIN_MAX) return { util: null, reason: 'bad-window' };
  let busy = 0;
  for (const [n, u] of sample.list) {
    const before = prev.map.get(n);
    if (before === undefined) continue;  // 这一枪才出现的实例没有基线
    const d = u - before;
    if (d > 0) busy += d;                // 负值是实例被回收后复用，丢掉
  }
  return { util: Math.round(clamp((busy / dt) * 100, 0, 100)), reason: 'ok' };
}

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

/* 按需拼一个取数脚本。键名压到 6 字符以内 —— 这份 JSON 每 3 秒要过一遍
 * 命令行，而 engtype_3D 的实例数有上百个。 */
function sensorScript(want) {
  const L = ['$o = [ordered]@{}'];

  if (want.battery) {
    L.push('$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1');
    L.push('if ($b) { $o.batPct = [int]$b.EstimatedChargeRemaining; $o.batChg = [bool]($b.BatteryStatus -eq 2) }');
  }

  if (want.gpu) {
    L.push("$s = Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*engtype_3D*' }");
    L.push('if ($s) {');
    L.push('  $e = @(); $t = [long]0');
    L.push('  foreach ($x in $s) { $e += [pscustomobject]@{ n = $x.Name; u = [long]$x.UtilizationPercentage }; $t = [long]$x.Timestamp_Sys100NS }');
    L.push('  $o.t100 = $t; $o.eng = $e');
    L.push('}');
  }

  if (want.temp) {
    L.push("$smi = Join-Path $env:SystemRoot 'System32\\nvidia-smi.exe'");
    L.push('if (Test-Path $smi) {');
    L.push('  $line = & $smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1');
    L.push("  if ($line -match '^\\s*(\\d+)') { $o.tempC = [int]$Matches[1] }");
    L.push('}');
  }

  L.push('$o | ConvertTo-Json -Depth 4 -Compress');
  return L.join('\n');
}

/* ---------- 常驻传感器采样进程 ---------- */

/* 🔴 为什么要有这个东西（这是「GPU 占用慢一拍」的真正根因，别再走回头路）：
 *
 * GPU 占用是**累计计数器求差**，那么"这一枪相对上一枪"的差值除以时间就是占用率。
 * 之前上一枪来自**上一次推送**，而推送间隔是 3 秒、加上采集本身 1 秒 ——
 * 实测窗口 **4050 ms**。也就是说：屏幕上那个 GPU 数字，描述的是
 * **刚刚过去的整整一个周期**。你刚启动一个吃显卡的程序，要等下一整拍
 * （约 4 秒）才看得到它涨上去；关掉之后又要多显示一拍才落回来。
 * 这不是"少了数据"，是这个数**天生晚一拍**。
 *
 * （CPU 其实同一套求差、同一个毛病，只是 CPU 负载起落平缓，肉眼看不出来；
 *   GPU 负载往往是一瞬间拉满，所以它最先露馅。）
 *
 * 修法：让采样**连续**进行。一个常驻 powershell 每 1 秒读一枪原始计数器，
 * 主进程维护"最近两次"求差 → 窗口固定 1 秒，读到的永远是**眼前这一秒**。
 *
 * 顺带把这条热路径的开销也去掉了，实测数据支持这个取舍：
 *   - 常驻进程里单次查询只要 71~133 ms（首次 222 ms，模块加载只付一次）
 *   - 而每 3 秒起一个新进程，固定启动开销就有 ~500 ms，加上查询与 nvidia-smi
 *     实测一次 push 要 1035 ms —— 比常驻方案**更贵**，还更慢。
 * 所以这不是"为了准而变费"，是把延迟和开销一起降下来了。
 *
 * ⚠️ 只在该用的时候开：悬浮显示关着、或全屏静默中，立刻停掉（见 main.js 的
 *    refreshStatsTimer）。一条常驻进程哪怕很便宜，也不该在不需要时白跑。 */

const SAMPLE_MS = 1000;      // 采样间隔（= 求差窗口）。1000 是"够新鲜"与"够便宜"的折中
const TEMP_EVERY = 3;        // 温度每 3 拍取一次：nvidia-smi 本身要 100~640ms，且这个量变得慢
const LIVE_TTL = 5000;       // 读数超过这么久没更新就当过期（采样进程挂了时的兜底）

let sensorChild = null;
let sensorBuf = '';
let sensorStopped = true;
let sensorRestarts = 0;
let sensorRestartTimer = null;

/* 常驻采样器给出的最近读数。没在采样 / 已过期时是 null，
 * 那种情况下 slowPart 会退回"起一个进程打一枪"的老路。 */
const live = { gpu: null, gpuAt: 0, tempC: null, tempAt: 0, ticks: 0, gpuOk: false, tempOk: false };

/* 采样脚本。和 fullscreen.js 里那份同构，同样两条纪律：
 * 纯 ASCII + `-EncodedCommand`，以及每 10 拍自查父进程还在不在
 * （Windows 上父进程退出不会带走子进程，不留野进程）。 */
function sensorWatchScript(parentPid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$smi = Join-Path $env:SystemRoot \'System32\\nvidia-smi.exe\'',
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
    '  $s = Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object { $_.Name -like \'*engtype_3D*\' }',
    '  if ($s) {',
    '    $e = @(); $t = [long]0',
    '    foreach ($x in $s) { $e += [pscustomobject]@{ n = $x.Name; u = [long]$x.UtilizationPercentage }; $t = [long]$x.Timestamp_Sys100NS }',
    '    $o.t100 = $t; $o.eng = $e',
    '  }',
    '  if ($hasSmi -and (($i % ' + TEMP_EVERY + ') -eq 1)) {',
    '    $line = & $smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1',
    '    if ($line -match \'^\\s*(\\d+)\') { $o.tempC = [int]$Matches[1] }',
    '  }',
    '  $w.WriteLine(($o | ConvertTo-Json -Depth 4 -Compress))',
    '  $w.Flush()',
    '  Start-Sleep -Milliseconds ' + SAMPLE_MS,
    '}'
  ].join('\n');
}

function startSensorWatch() {
  if (process.platform !== 'win32') return false;
  if (sensorChild) return true;

  sensorStopped = false;
  sensorRestarts = 0;

  const spawnOnce = () => {
    if (sensorStopped) return;
    let proc;
    try {
      proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(sensorWatchScript(process.pid), 'utf16le').toString('base64')
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.warn('[sensor] 起不了采样进程:', String(err?.message || err));
      scheduleRestart();
      return;
    }

    sensorChild = proc;
    sensorRestarts = 0;
    console.log('[sensor] 采样进程已启动（每 ' + SAMPLE_MS + 'ms 一次）');

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

  /* ⚠️ 求差放在主进程做（复用 gpuStatus），不放进 PowerShell ——
   *    这样"窗口合不合适"的判定只有一处实现，能被 verify-stats 覆盖。 */
  if (r && Array.isArray(r.eng)) {
    const st = gpuStatus(gpuMakeSample(r));
    if (st.util !== null) {
      live.gpu = st.util;
      live.gpuAt = Date.now();
      live.gpuOk = true;
    }
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

/* ⚠️ 「采样器转了 8 拍以上却一次都没给出这一项」= 这台机器根本没有这个数据源
 *    （没有 N 卡 → 没有温度；性能计数器类被禁用 → 没有 GPU 占用）。
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
  if (want.gpu) {
    const g = liveGpu();
    if (g !== null) out.gpu = g;
    else if (!gpuUnavailable()) needGpu = true;
  }
  if (want.temp) {
    const t = liveTemp();
    if (t !== null) out.tempC = t;
    else if (!tempUnavailable()) needTemp = true;
  }
  // 电量没有常驻采样（悬浮小字不显示它），一律现取
  const needBattery = !!want.battery;
  if (!needGpu && !needTemp && !needBattery) return;

  const script = sensorScript({ gpu: needGpu, temp: needTemp, battery: needBattery });

  // 超时给宽一点：nvidia-smi 在显卡刚休眠时会慢一拍（实测偶发 640ms）
  let r = await psJson(script, 4000);
  if (!r) return;

  if (needGpu) {
    let st = gpuStatus(gpuMakeSample(r));
    /* 只有「真的没有基线」才补枪。
     * ⚠️ 不能用 `st.util === null` 判 —— 那会把"窗口太短"也算进来，
     *    于是每次调用都白等 1.2 秒再打一枪（见 gpuStatus 上面那段）。
     *    'bad-window' 时补枪是没用的：这一枪已经把基线更新掉了，
     *    再打一枪的窗口只会更短。让它这一帧不出数，下一次自然推送就好了。 */
    if (st.reason === 'no-baseline') {
      await new Promise((res) => setTimeout(res, GPU_FRESH_MS));
      const r2 = await psJson(script, 4000);
      if (r2) { r = r2; st = gpuStatus(gpuMakeSample(r2)); }
    }
    if (st.util !== null) out.gpu = st.util;
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
  HUD_FIELDS,
  FULL_FIELDS
};
