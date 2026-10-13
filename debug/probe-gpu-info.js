'use strict';
/* 探测 Electron 实际在用哪块 GPU —— 用于核对 HUD 上「GPU 占用」的口径。
 *
 * 背景：本机是核显 + 独显（Intel UHD + RTX 4070）的双 GPU 笔记本，而
 * Win32_PerfRawData_GPUPerformanceCounters_GPUEngine 会**同时**暴露两块卡的
 * 实例（各自的 luid）。sysinfo.js 现在是「跨实例求和」，等于把核显和独显
 * 加在一起 —— 到底显示的是谁，得先问清楚。
 *
 * 用法：./node_modules/electron/dist/electron.exe debug/probe-gpu-info.js
 *
 * ⚠️ 本机（装了 aTrust 的这台）**独立入口必崩** —— 脚本入口不经过 main.js 的
 *    GPU 降级重启，GPU 进程会反复 0xC0000005 直到 FATAL 退出（见 ARCHIVE
 *    「环境坑」）。本机请改用主应用的诊断口子：`PET_GPUINFO=1`，
 *    它走的是 main.js 的完整启动路径，12 秒后打同样这几行。
 *    这个脚本留着给"没有该环境问题"的机器用。
 */
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration === undefined;   // 不用，只是提醒：别关硬件加速

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 200, height: 200 });
  await w.loadURL('data:text/html,<body style="margin:0;background:#123"></body>');
  await new Promise((r) => setTimeout(r, 4000));   // 等 GPU 进程把特性探测跑完

  const basic = await app.getGPUInfo('basic');
  const aux = basic.auxAttributes || {};
  console.log('[gpuinfo] auxAttributes.glRenderer = ' + aux.glRenderer);
  console.log('[gpuinfo] auxAttributes.glVendor   = ' + aux.glVendor);
  console.log('[gpuinfo] auxAttributes.glVersion  = ' + aux.glVersion);
  console.log('[gpuinfo] machineModelName        = ' + aux.machineModelName);
  console.log('[gpuinfo] gpuDevice = ' + JSON.stringify(basic.gpuDevice));

  const fs = app.getGPUFeatureStatus();
  console.log('[gpuinfo] featureStatus.gpu_compositing = ' + fs.gpu_compositing);
  console.log('[gpuinfo] featureStatus.video_decode    = ' + fs.video_decode);
  console.log('[gpuinfo] featureStatus.webgl            = ' + fs.webgl);

  setTimeout(() => app.quit(), 500);
});
