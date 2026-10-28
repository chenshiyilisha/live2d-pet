'use strict';

/* 悬浮气泡窗的 preload —— 只暴露订阅与报高度两个能力，
 * 气泡窗拿不到 Node，也碰不到主窗的任何通道。 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bubbleHost', {
  onBegin: (cb) => ipcRenderer.on('bubble:begin', () => cb()),
  onChunk: (cb) => ipcRenderer.on('bubble:chunk', (_e, t) => cb(t)),
  /* 「心里想的」那一段 —— 和正文分开走，样式也不同（灰色小字，见 bubble.html） */
  onThink: (cb) => ipcRenderer.on('bubble:think', (_e, t) => cb(t)),
  onEnd: (cb) => ipcRenderer.on('bubble:end', () => cb()),
  onAbort: (cb) => ipcRenderer.on('bubble:abort', () => cb()),
  onFull: (cb) => ipcRenderer.on('bubble:full', (_e, t) => cb(t)),
  /* 入场动画：主进程 showInactive() **之后**才发（先发的话动画会在窗口还藏着
   * 时就被消耗掉）。带一个 style 包，告诉页面这一句要不要描边。 */
  onShow: (cb) => ipcRenderer.on('bubble:show', (_e, s) => cb(s || {})),
  /* 出场动画：主进程等 FADE_MS 播完才真 hide。 */
  onFade: (cb) => ipcRenderer.on('bubble:fade', () => cb()),
  /* 尾巴回正量（px）：泡体被随机偏移/被屏幕边 clamp 后，尾巴要往回挪多少才
   * 仍然指着她。只在变化时下发。 */
  onTail: (cb) => ipcRenderer.on('bubble:tail', (_e, v) => cb(Number(v) || 0)),
  /* 内容尺寸变化时把"想要的窗口高度"报给主进程（主进程锚定底边往上长） */
  reportHeight: (h) => ipcRenderer.send('bubble:height', h)
});
