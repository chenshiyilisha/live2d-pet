'use strict';

/* 轮盘窗的 preload —— 只暴露"收菜单数据 / 收命中项 / 回传选择 / 报尺寸"。
 * 拿不到 Node，也碰不到主窗的任何通道：菜单项的执行一律回主进程按 id 查表。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wheelHost', {
  onShow: (cb) => ipcRenderer.on('wheel:show', (_e, d) => cb(d || {})),
  /* 主进程轮询算出的命中项（outer / inner 下标，-1 = 没命中）。 */
  onHover: (cb) => ipcRenderer.on('wheel:hover', (_e, h) => cb(h || { outer: -1, inner: -1 })),
  pick: (id) => ipcRenderer.send('wheel:pick', id),
  cancel: () => ipcRenderer.send('wheel:cancel'),
  reportSize: (w, h, r) => ipcRenderer.send('wheel:size', { w, h, r })
});
