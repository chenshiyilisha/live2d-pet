'use strict';

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { clamp } = require('./util');

/* ============================================================
 *  系统状态采集
 * ==========================================================
 *
 * CPU / 内存 / 磁盘走 Node 的 os / fs（同步、微秒级）；
 * 电量与网速 Windows 没有原生 API，只能问 PowerShell —— 那条路要
 * 400ms 上下，所以**只在真正需要时**才异步取（用户开口问、或开了悬浮显示）。
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
  const cpus = os.cpus();
  if (!cpus || !cpus.length) return null;
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    const t = c.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  const now = Date.now();
  const prev = lastCpuSample;
  if (!prev) { lastCpuSample = { idle, total, t: now }; return null; }
  const dt = now - prev.t;
  if (dt < CPU_WIN_MIN || dt > CPU_WIN_MAX) {
    lastCpuSample = { idle, total, t: now };
    return null;
  }
  const dIdle = idle - prev.idle;
  const dTotal = total - prev.total;
  lastCpuSample = { idle, total, t: now };
  if (dTotal <= 0) return null;
  return Math.round(clamp((1 - dIdle / dTotal) * 100, 0, 100));
}

/* 拿一个「当下」的 CPU 占用。冷启动后用户开口就问「CPU 多少」时，
 * 上一枪是不存在的（或早就过期了），cpuPercent() 会返回 null —— 那就等
 * 一小会儿补第二枪，保证答得出数来。 */
async function cpuPercentFresh() {
  const v = cpuPercent();
  if (v !== null) return v;
  await new Promise((r) => setTimeout(r, 260));
  return cpuPercent();
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

async function batteryInfo() {
  const r = await psJson(
    '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
    'if ($b) { [pscustomobject]@{ percent = [int]$b.EstimatedChargeRemaining; ' +
    'charging = [bool]($b.BatteryStatus -eq 2) } | ConvertTo-Json -Compress } else { "null" }'
  );
  return r && typeof r.percent === 'number' ? r : null;
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

/* 汇总一次系统状态。withSlow=true 时才去问 PowerShell（电量 / 网速）。 */
async function collectStats(withSlow = false) {
  const out = {
    cpu: await cpuPercentFresh(),
    mem: memInfo(),
    disk: diskInfo(),
    uptimeMin: Math.round(os.uptime() / 60),
    host: os.hostname()
  };
  if (withSlow) {
    const [bat, net] = await Promise.all([batteryInfo(), netInfo()]);
    out.battery = bat;
    out.net = net;
  }
  return out;
}

/* 把状态写成一句人话，直接塞进气泡。 */
function formatStats(s) {
  const parts = [];
  if (s.cpu !== null && s.cpu !== undefined) parts.push(`CPU ${s.cpu}%`);
  if (s.mem) parts.push(`内存 ${s.mem.percent}%（${s.mem.usedGB}/${s.mem.totalGB}G）`);
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

module.exports = { collectStats, formatStats };
