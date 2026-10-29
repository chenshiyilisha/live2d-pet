'use strict';

/* 头顶泡泡菜单的 preload 桥（contextIsolation + sandbox，只递数据不递能力）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuHost', {
  onShow: (cb) => ipcRenderer.on('menu:show', (_e, data) => cb(data)),
  onHover: (cb) => ipcRenderer.on('menu:hover', (_e, i) => cb(i)),
  pick: (i) => ipcRenderer.send('menu:pick', i),
  cancel: () => ipcRenderer.send('menu:cancel'),
  back: () => ipcRenderer.send('menu:back'),
  /* 右键**松手**。⚠️ 必须在本窗也监听一条：划向泡泡时光标常常已经离开主窗，
   * 主窗收不到这个 mouseup，没有这条就会一直挂到超时。 */
  release: () => ipcRenderer.send('menu:release'),
  hoverKey: (i) => ipcRenderer.send('menu:hover-key', i)
});
