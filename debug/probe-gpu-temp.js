'use strict';
/* 探测：本机能否取到 GPU 占用 / 温度。
 * 结论决定 sysinfo 怎么写 —— 猜口径会写出一堆恒为 null 的字段。
 * 用法：node debug/probe-gpu-temp.js
 */

const { execFile } = require('child_process');

function ps(script, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout, maxBuffer: 1 << 22 },
      (err, stdout, stderr) => resolve({
        err: err ? String(err.message) : null,
        out: String(stdout || '').trim(),
        er: String(stderr || '').trim()
      })
    );
  });
}

const PROBES = [
  ['① 显卡列表', `
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  ForEach-Object { "{0} | drv {1}" -f $_.Name, $_.DriverVersion }
`],

  ['② GPU 引擎计数器（Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine）', `
$s = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue
if (-not $s) { "NONE —— 该类不可用" } else {
  "实例数 = " + ($s | Measure-Object).Count
  "全部求和 = " + [math]::Round((($s | Measure-Object UtilizationPercentage -Sum).Sum), 2)
  $d3 = $s | Where-Object { $_.Name -like '*engtype_3D*' }
  "3D 引擎实例数 = " + ($d3 | Measure-Object).Count
  "3D 求和 = " + [math]::Round((($d3 | Measure-Object UtilizationPercentage -Sum).Sum), 2)
  "--- 前 8 个最忙 ---"
  $s | Sort-Object UtilizationPercentage -Descending | Select-Object -First 8 |
    ForEach-Object { "  {0} = {1}" -f $_.Name, $_.UtilizationPercentage }
}
`],

  ['③ Get-Counter GPU Engine 3D（实时计数器）', `
try {
  $c = Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop
  $sum = ($c.CounterSamples | Measure-Object CookedValue -Sum).Sum
  "样本数 = " + ($c.CounterSamples | Measure-Object).Count
  "3D 求和 = " + [math]::Round($sum, 2)
} catch { "ERR " + $_.Exception.Message }
`],

  ['④ 温度：root/wmi MSAcpi_ThermalZoneTemperature', `
try {
  $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
  if (-not $t) { "NONE —— 返回空" }
  else { $t | ForEach-Object { "{0} -> {1} (raw, 十分之一开尔文)" -f $_.InstanceName, $_.CurrentTemperature } }
} catch { "ERR " + $_.Exception.Message }
`],

  ['⑤ 温度：Get-Counter Thermal Zone Information', `
try {
  $c = Get-Counter '\\Thermal Zone Information(*)\\Temperature' -ErrorAction Stop
  $c.CounterSamples | ForEach-Object { "{0} -> {1} K" -f $_.InstanceName, [math]::Round($_.CookedValue, 1) }
} catch { "ERR " + $_.Exception.Message }
`],

  ['⑥ nvidia-smi 是否存在', `
$p = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $p) { "未找到 nvidia-smi" }
else {
  "路径 = " + $p.Source
  & nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu --format=csv,noheader 2>&1
}
`],

  ['⑦ 根命名空间下的第三方硬件监控（LibreHardwareMonitor / OpenHardwareMonitor）', `
Get-CimInstance -Namespace root -ClassName __NAMESPACE -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match 'Libre|Open|HP' } | ForEach-Object { $_.Name }
`],

  ['⑧ 电池（现存字段，留个基线）', `
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($b) { "percent=" + $b.EstimatedChargeRemaining + " status=" + $b.BatteryStatus } else { "无电池（台式/虚拟机）" }
`]
];

(async () => {
  for (const [title, script] of PROBES) {
    const r = await ps(script);
    console.log('\n════════════════════════════════════════');
    console.log(title);
    console.log('────────────────────────────────────────');
    if (r.err) console.log('  [执行错误] ' + r.err);
    console.log(r.out || '  (无输出)');
    if (r.er) console.log('  [stderr] ' + r.er.split('\n').slice(0, 4).join('\n  '));
  }
  console.log('\n════════════════════════════════════════');
  console.log('探测结束');
})();
