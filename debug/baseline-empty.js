'use strict';
/* 内存基线对照：一个「和桌宠同参数、但什么都不加载」的空窗口。
 *
 * 为什么需要：直接看桌宠占 715MB 没有意义 —— 里面绝大部分是 Electron /
 * Chromium 的固定开销（主进程、GPU 进程、network utility）。只有拿这个基线
 * 一减，才知道「阿岩自己」到底占了多少钱。
 *
 * 参数刻意与 main.js 对齐（无边框 / 透明 / 同尺寸 / backgroundThrottling=false /
 * 关沙箱），否则量出来的差值里混着开关差异。
 *
 * 用法：./node_modules/electron/dist/electron.exe debug/baseline-empty.js
 *      （起完别关，另开一个终端去量内存）
 */
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

app.whenReady().then(() => {
  const w = new BrowserWindow({
    width: 308,
    height: 342,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    resizable: false,
    show: true,
    webPreferences: { backgroundThrottling: false }
  });
  w.loadURL('data:text/html,<body style="margin:0;background:transparent"></body>');
  console.log('[baseline] empty window up');

  /* 与 main.js 里那条 PET_MEM 同格式，方便两边逐进程对减（单位 KB → MB）。 */
  if (process.env.PET_MEM === '1') {
    let n = 0;
    const t = setInterval(() => {
      const parts = app.getAppMetrics().map((m) => {
        const mb = (kb) => Math.round(kb / 1024);
        const mm = m.memory || {};
        return `${m.type}:${m.pid} ws=${mb(mm.workingSetSize || 0)} ` +
               `peak=${mb(mm.peakWorkingSetSize || 0)} cpu=${(m.cpu?.percentCPUUsage ?? 0).toFixed(1)}%`;
      });
      console.log('[mem]', JSON.stringify({ n: ++n, parts }));
      if (n >= 6) clearInterval(t);
    }, 8000);
  }
});

app.on('window-all-closed', () => app.quit());
