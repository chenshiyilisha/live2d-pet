'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* 主进程 → 渲染层可以订阅的事件白名单。
 * 做成白名单 + 通用 on()，是为了以后新增事件不用每次改 preload。 */
const MAIN_EVENTS = [
  'pet:toast',          // 操作反馈兜底（仅 floatBubble 关时走主窗 #status）
  'pet:emote',          // G18 托盘表情槽预览
  'pet:stop-speak',     // G26 热键停朗读
  'pet:snapped',        // 吸附到屏幕边缘了
  'pet:noticed',        // 她"注意到"你在附近，这次不溜达了
  'pet:wander-start',   // 开始自己溜达
  'pet:wander-end',     // 溜达结束
  'pet:remind',         // 定时提醒 / 番茄钟到点
  'pet:set-emotion',    // 右键菜单里选了表情
  'pet:play-motion',    // 右键菜单里选了动作
  'pet:quiet',          // 进入 / 退出全屏静默（渲染层据此降帧、闭嘴）
  'pet:visible',        // 窗口显示 / 隐藏了（隐藏时降到 1fps，别白烧）
  'pet:screen-locked',  // 锁屏 / 解锁了（渲染层据此拦主动搭话）
  'pet:work-state',     // 对话工作状态（thinking/working/success/error）
  'pet:squash',         // 落地 / 甩抛 Q 弹挤压
  'pet:tilt',           // X4 单摆倾角（弧度）
  'pet:facing',         // X4 水平朝向 ±1
  'mood:snapshot',      // 心境层的四轴快照（表情偏置权重在里面，10s/事件后推）
  'monitor:stats'       // 系统状态悬浮显示的数据
];

// 只暴露必要能力，渲染进程拿不到 Node，也拿不到 API Key
contextBridge.exposeInMainWorld('pet', {
  // 光标进入/离开角色本体时切换鼠标穿透
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:set-ignore-mouse', ignore),
  /* W6：悬停渐隐穿透（淡 + 整窗 ignore；主进程压透明度） */
  setHoverFade: (on) => ipcRenderer.send('pet:hover-fade', !!on),

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

  // 心境层事件（点击 / 摸头起止 —— 只收渲染层才有的信号，拖拽聊天主进程自有）
  moodEvent: (type) => ipcRenderer.send('mood:event', { type }),

  // 在角色身上右键 → 主进程弹快捷菜单（默认自绘轮盘，配置关掉时退回原生）
  contextMenu: () => ipcRenderer.send('pet:context-menu'),
  /* 轮盘是「按住 → 划向扇区 → 松手」：按下时带上**屏幕坐标**（盘要开在鼠标处），
   * 松手时通知主进程提交当前命中项（兜底：mouseup 归主窗还是轮盘窗不确定）。 */
  wheelOpen: (x, y) => ipcRenderer.send('pet:wheel-open', { x, y }),
  wheelRelease: () => ipcRenderer.send('pet:wheel-release'),

  /* 要求主进程**整窗重绘**（webContents.invalidate）。画布层缩小后旧帧会留在
   * "新内容不再覆盖"的区域里 —— 详见 main.js 里 pet:repaint 那段（Electron
   * 官方博客《Tech Talk: Improving Window Resize Behavior》）。 */
  repaint: () => ipcRenderer.send('pet:repaint'),

  quit: () => ipcRenderer.send('pet:quit'),
  hide: () => ipcRenderer.send('pet:hide'),

  chat: (messages) => ipcRenderer.invoke('chat:send', messages),
  onChunk: (cb) => ipcRenderer.on('chat:chunk', (_e, text) => cb(text)),
  /* 「心里想的」那一段。和 onChunk 分开 —— 它不进 replyBuffer、不朗读、不进历史，
   * 只显示成气泡顶部的一行灰色小字（见 pet.js 的 onThink）。 */
  onThink: (cb) => ipcRenderer.on('chat:think', (_e, text) => cb(text)),

  /* 气泡 / 输入条显示时窗口要撑宽。宽度**由渲染层算好**（人物墨水宽 =
   * f(窗口高, 缩放, 模型)，几何在参数表里），主进程只负责落成 setBounds。 */
  setStageWidth: (w) => ipcRenderer.send('pet:stage-width', w),

  // 情绪标签由主进程从回复里解析后单独发过来（气泡文本里已经剥掉了）
  onEmotion: (cb) => ipcRenderer.on('chat:emotion', (_e, name) => cb(name)),

  // 聊天记录持久化：退出重开能接着上次聊
  loadHistory: () => ipcRenderer.invoke('history:load'),
  saveHistory: (arr) => ipcRenderer.invoke('history:save', arr),

  /* 主动搭话：闲置久了由主进程挑个话头。
   * 带上她此刻的情绪和最近几轮对话 —— 主进程按情绪挑话头，也让她接得上上文。 */
  proactive: (ctx) => ipcRenderer.invoke('chat:proactive', ctx),
  /* W27：零副作用 preview（只返回 reason/head，不调模型） */
  proactivePreview: (ctx) => ipcRenderer.invoke('chat:proactive-preview', ctx),

  /* ---- 媒体感知：主人此刻在听什么（歌名 / 歌手 / 播放状态） ----
   * 只在 media.enabled 开着时才有内容，否则恒为 null。 */
  media: () => ipcRenderer.invoke('media:get'),

  /* say() 类整段播报走悬浮气泡窗（chat.floatBubble 开启时）。
   * 主进程在浮窗关闭时会安全忽略这两条 —— 主窗内的 #bubble 照旧画。 */
  floatSay: (text, autoHideMs) => ipcRenderer.send('pet:float-say', { text, ms: autoHideMs }),
  /* 短提示（status 级）：录音/拖文件等；浮窗开着时替代主窗 #status。 */
  floatStatus: (text, autoHideMs) => ipcRenderer.send('pet:float-status', { text, ms: autoHideMs }),
  floatHide: () => ipcRenderer.send('pet:float-hide'),
  /* 请求主进程实量人物头顶 y（悬浮气泡的锚点用） */
  requestHeadMeasure: () => ipcRenderer.send('pet:head-measure'),

  // 托盘 / 右键菜单改了开关后主进程会通知过来
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', () => cb()),
  onHistoryCleared: (cb) => ipcRenderer.on('history:cleared', () => cb()),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  /* X3：把拖进来的文本文件「吃下」进长期记忆（主进程闸门 + 落盘）。 */
  eatFile: (payload) => ipcRenderer.invoke('memory:eat-file', payload),

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

  /* ---- 语音朗读：让主进程用 Windows 语音合成吐一段 wav 回来。
   * 渲染层拿它做真口型（声音走 WebAudio 才有波形可分析）。
   * 合成不出来时 resolve null —— 调用方会退回系统内置音色。 ---- */
  synthSpeech: (text, opts) => ipcRenderer.invoke('tts:synth', { text, opts }),

  // 自检通道：把渲染画面（dataURL）交给主进程落盘
  saveShot: (dataUrl) => ipcRenderer.invoke('pet:save-shot', dataUrl)
});
