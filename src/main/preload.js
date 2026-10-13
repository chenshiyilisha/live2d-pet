'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* 主进程 → 渲染层可以订阅的事件白名单。
 * 做成白名单 + 通用 on()，是为了以后新增事件不用每次改 preload。 */
const MAIN_EVENTS = [
  'pet:toast',          // 操作反馈（改了大小 / 透明度时的小提示）
  'pet:snapped',        // 吸附到屏幕边缘了
  'pet:noticed',        // 她"注意到"你在附近，这次不溜达了
  'pet:wander-start',   // 开始自己溜达
  'pet:wander-end',     // 溜达结束
  'pet:remind',         // 定时提醒 / 番茄钟到点
  'pet:set-emotion',    // 右键菜单里选了表情
  'pet:play-motion',    // 右键菜单里选了动作
  'pet:quiet',          // 进入 / 退出全屏静默（渲染层据此降帧、闭嘴）
  'pet:visible',        // 窗口显示 / 隐藏了（隐藏时降到 1fps，别白烧）
  'monitor:stats'       // 系统状态悬浮显示的数据
];

// 只暴露必要能力，渲染进程拿不到 Node，也拿不到 API Key
contextBridge.exposeInMainWorld('pet', {
  // 光标进入/离开角色本体时切换鼠标穿透
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),

  // 主进程按 30fps 轮询系统光标位置发过来，坐标是「相对窗口左上角」，
  // 和窗口内 mousemove 的 clientX/clientY 同一套 —— 这样鼠标移出窗口后
  // 视线依然能跟随（mousemove 只在窗口内触发，出了窗口就断了）。
  onCursor: (cb) => ipcRenderer.on('pet:cursor', (_e, p) => cb(p)),

  // 拖拽只发位移增量，窗口坐标由主进程计算
  dragMove: (dx, dy) => ipcRenderer.send('pet:drag-move', { dx, dy }),
  // 松手：主进程据此判断要不要吸附到屏幕边缘
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  // 「人还在」信号（点击 / 划过），用来推迟主进程的自主漫步
  activity: () => ipcRenderer.send('pet:activity'),

  // 在角色身上右键 → 主进程弹原生菜单（表情 / 动作 / 外观 / 退出）
  contextMenu: () => ipcRenderer.send('pet:context-menu'),

  quit: () => ipcRenderer.send('pet:quit'),
  hide: () => ipcRenderer.send('pet:hide'),

  chat: (messages) => ipcRenderer.invoke('chat:send', messages),
  onChunk: (cb) => ipcRenderer.on('chat:chunk', (_e, text) => cb(text)),

  /* 气泡 / 输入条显示时窗口要撑宽。宽度**由渲染层算好**（人物墨水宽 =
   * f(窗口高, 缩放, 模型)，几何在参数表里），主进程只负责落成 setBounds。 */
  setStageWidth: (w) => ipcRenderer.send('pet:stage-width', w),

  // 情绪标签由主进程从回复里解析后单独发过来（气泡文本里已经剥掉了）
  onEmotion: (cb) => ipcRenderer.on('chat:emotion', (_e, name) => cb(name)),

  // 聊天记录持久化：退出重开能接着上次聊
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (arr) => ipcRenderer.invoke('history:save', arr),

  // 主动搭话：闲置久了由主进程挑个话头
  proactive: () => ipcRenderer.invoke('chat:proactive'),

  // 托盘 / 右键菜单改了开关后主进程会通知过来
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', () => cb()),
  onHistoryCleared: (cb) => ipcRenderer.on('history:cleared', () => cb()),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  /* ---- 外观：主进程改了缩放 / 透明度 / 模型后推过来 ---- */
  onAppearance: (cb) => ipcRenderer.on('appearance:changed', (_e, a) => cb(a)),

  /* ---- 主进程事件（白名单） ---- */
  on: (channel, cb) => {
    if (!MAIN_EVENTS.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },

  /* ---- 系统状态 / 提醒 / 番茄钟 ---- */
  queryStats: () => ipcRenderer.invoke('monitor:query'),
  addReminder: (minutes, text, kind) => ipcRenderer.invoke('reminder:add', { minutes, text, kind }),
  listReminders: () => ipcRenderer.invoke('reminder:list'),
  clearReminders: () => ipcRenderer.invoke('reminder:clear'),
  startPomodoro: (workMin, breakMin) => ipcRenderer.invoke('pomodoro:start', { workMin, breakMin }),
  stopPomodoro: () => ipcRenderer.invoke('pomodoro:stop'),

  /* ---- 语音输入：把录好的 WAV（Uint8Array）交给主进程做离线识别 ---- */
  recognize: (wavBytes) => ipcRenderer.invoke('asr:recognize', wavBytes),

  // 自检通道：把渲染画面（dataURL）交给主进程落盘
  saveShot: (dataUrl) => ipcRenderer.invoke('pet:save-shot', dataUrl)
});
