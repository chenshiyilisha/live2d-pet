'use strict';

/* 光标处卡片菜单的 preload 桥（contextIsolation + sandbox，只递数据不递能力）。
 * ⚠️ 频道名统一加 `card:` 前缀：三个菜单模块都在 ipcMain 上注册监听，共用
 *    `menu:*` 会互相收到对方的消息（虽然 done 闩能挡住，但那是靠巧合）。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menuHost', {
  onShow: (cb) => ipcRenderer.on('card:show', (_e, data) => cb(data)),
  onHover: (cb) => ipcRenderer.on('card:hover', (_e, h) => cb(h)),
  pick: (h) => ipcRenderer.send('card:pick', h),
  cancel: () => ipcRenderer.send('card:cancel'),
  /* 右键**松手**。⚠️ 必须在本窗也监听一条：划进卡片时光标常常已经离开主窗，
   * 主窗收不到这个 mouseup，没有这条就会一直挂到超时。 */
  release: () => ipcRenderer.send('card:release'),
  /* 页面已按新相对坐标画完：子菜单翻到左侧时窗口原点会跳，主进程要
   * 等这一声再把透明度拉回，否则会闪一帧「主卡跟着窗口飞」。 */
  painted: () => ipcRenderer.send('card:painted')
});
