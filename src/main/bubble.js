'use strict';

/* ============================================================
 *  悬浮气泡窗（白底圆角 + 一层柔和投影，尾巴尖指着她）
 * ==========================================================
 *
 * 为什么独立开一个窗口：半身取景下人物的**头顶离主窗顶还有一大截**
 * （实测窗口 342 DIP 高时头顶在 y≈137 —— 取景给头顶留了呼吸空间，
 * 别按「头顶贴窗顶」想当然）。主窗里没有头顶以上的空间，气泡放窗口里
 * 就必然压在人身上（老布局压胸口到腰那一段）。所以对话气泡搬进一个透明
 * 小窗，底边锚在**人物头顶**上方的屏幕上 —— 人物一根毛都不挡。
 *
 * 头顶 y 哪来：主进程实量（measureHead：capturePage 逐行扫 alpha，第一行
 * 有足够不透明像素的 y）。渲染层在模型挂载 / 布局变化时发 pet:head-measure
 * 来触发。量不出（软件合成下 canvas 糊成白块、alpha 全 1 → 量出 0；或还没
 * 量过）时退回贴窗顶的旧行为 —— 位置远一点，但绝不会飘到别处去。
 *
 * 垂直定位的真相（别被"窗口底边"这个词骗了）：
 *   气泡窗底边**不是**视觉上的气泡底 —— 尾巴尖（旋转方块的顶点）在窗口
 *   底边之上 TAIL_TIP_INSET px，再往下是给柔影留的空白。所以决定"离人远近"
 *   的是 TIP_GAP（尾巴尖 ↔ 头顶），窗口底边得再往下让 TAIL_TIP_INSET。
 *   这两个数与 bubble.html 的 CSS 是死联动（规矩 9 / 22），改一处必须对另一处。
 *
 * 生命周期（由 main.js 驱动，本模块不解析聊天内容）：
 *   beginStream()  清空 + 定位 + 显示"…"等待态
 *   appendChunk()  流式逐字追加（高度自适应，底边锚定、往上长）
 *   appendThink()  一整段"心里想的"，显示在正文上方的小字行
 *   endStream()    摘掉等待态，AUTO_HIDE_MS 后自动淡出
 *   abortStream()  这轮失败，立刻藏
 *   showFull()     整段显示（say() 类临时播报：提醒 / 番茄钟播报）
 *
 * 跟随：主窗 move 时 syncPosition()（内部 33ms 节流，拖着她走气泡跟着飘）。
 * 贴顶兜底：头顶上方放不下（她被拖到屏幕顶部）时，气泡退回主窗内
 * 顶部 —— 会盖到一点脸，但比"凭空消失"强，这是极端位置下的取舍。
 *
 * 注入约定同 tts.js / recorder.js：configureBubble({ getWindow })，
 * 主窗引用用 getter 传，本模块不 require main.js。
 * ========================================================== */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { createArbiter } = require('./bubble-priority');

/* 气泡优先级：stream / alert / status，低级不抢高级（见 bubble-priority.js）。 */
const arbiter = createArbiter();
let streamToken = null;

const WIDTH = 272;        // 气泡窗宽（主窗 308，左右各收一点）
const TIP_GAP = 10;       // **尾巴尖**与人物头顶的间隙（决定"离人远近"的就是它）
/* 尾巴尖在气泡窗底边上方的距离 —— 由 bubble.html 的 CSS 几何决定：
 *   wrap 的 padding-bottom(21) − 尾巴旋转后最低点(15px 方块 bottom:15px 转 45°，
 *   中心在外壳底上方 1.5px，包围盒半高 10.6 → 最低点在外壳底下方 9.1px) ≈ 12。
 * ⚠️ 改 #tail 的尺寸/位置、或改 #wrap 的 padding-bottom / report() 里的数字，
 *    都要重算这里（verify-bubble [H] 在校验联动）。 */
const TAIL_TIP_INSET = 12;
const MEASURE_MIN_GAP_MS = 400;  // 头顶实量的节流
const MIN_H = 56;         // 窗口最小高（兜底下限；实际一句短话算出来约 79，用不到）
/* 窗口最大高。⚠️ 必须 ≥ 顶部留白 8 + 泡体上限(shell max-height 236 + padding
 * 上下 26) + 底部 21 = 291，否则长回复时窗口被夹矮、**尾巴和末行被裁**，
 * 而 shell 的内部滚动（overflow-y:auto）根本轮不到生效。
 * debug/verify-bubble.js 的 [H] 段从两个文件里切常量做这个校验。 */
const MAX_H = 292;
const AUTO_HIDE_MS = 9000; // 说完保留多久，与渲染层 say() 的 9000 对齐
const FOLLOW_MS = 33;     // 主窗移动时的跟随节流

let getWindow = () => null;   // () => mainWindow | null（注入）
let win = null;
let hideTimer = null;
let followTimer = null;
let lastFollow = 0;
let curH = MIN_H;        // 当前窗口高度（底边锚定，随内容长高）
let insideMode = false;  // true = 贴顶兜底，气泡退回主窗内部
let headTop = null;      // 人物头顶在主窗内容区里的 y（DIP，实量）。null = 还没量到
let measureTimer = null;
let shotSeq = 0;

function enabled() {
  try {
    const { loadConfig } = require('./config');
    return loadConfig().chat?.floatBubble !== false;
  } catch {
    return false;
  }
}

/* 内容高度 → 窗口高度（渲染层报的是它量出的整页高度）。 */
function onContentHeight(h) {
  if (!win) return;
  const n = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(h) || MIN_H)));
  if (Math.abs(n - curH) < 4) return;   // 抖动过滤：差一点就别折腾 setBounds
  curH = n;
  place();
}

/* 摆位置：水平对齐人物中线（人物恒居中于主窗，规矩 20），
 * **尾巴尖**锚在人物头顶上方 TIP_GAP 处（headTop 实量；没量到就退回窗顶 ——
 * 远，但方向不会错）。高度变化只往上长、人视角下气泡扎根在头顶。 */
function place() {
  if (!win || win.isDestroyed()) return;
  const main = getWindow();
  if (!main || main.isDestroyed()) return;

  const b = main.getContentBounds();   // ⚠️ 规矩 20：锚 contentBounds，别用 getBounds
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;

  let x = Math.round(b.x + b.width / 2 - WIDTH / 2);
  x = Math.max(wa.x + 4, Math.min(wa.x + wa.width - WIDTH - 4, x));

  const anchorY = b.y + (headTop ?? 0);              // 头顶的屏幕 y（没量到 = 窗顶）
  const bottomY = anchorY - TIP_GAP - TAIL_TIP_INSET; // 气泡窗底边的屏幕 y
  insideMode = bottomY - curH < wa.y + 4;             // 头顶上方放不下 → 退回窗内
  let y;
  if (insideMode) {
    y = b.y + 6;
  } else {
    y = bottomY - curH;
  }
  win.setBounds({ x, y, width: WIDTH, height: curH });
  diagPlace(y);
}

/* 诊断口子：PET_SNAPSHOT 含 "bubble" 时打一行摆位日志（跟 snapshotSelf 同门）。 */
function diagPlace(y) {
  const tag = String(process.env.PET_SNAPSHOT || '');
  if (!tag.includes('bubble')) return;
  const main = getWindow();
  console.log('[bubble] place', JSON.stringify({
    headTop, y, h: curH, tipGap: TIP_GAP, tipInset: TAIL_TIP_INSET,
    mainTop: main?.getContentBounds().y ?? null
  }));
}

/* ---------- 人物头顶实量 ----------
 * capturePage 拿主窗一帧，从上往下找第一行"有足够不透明像素"的 y。
 * 只量顶部所以底座牌不干扰（它在底部，规矩 23 只坑"整窗包围盒"）。
 * 软件合成下 canvas 糊成不透明白块 → 量出 0 → 退回贴窗顶，无害。
 * 渲染层在模型挂载 / 布局变化时触发，这里节流。 */
async function measureHead() {
  const main = getWindow();
  if (!main || main.isDestroyed()) return;
  try {
    const img = await main.webContents.capturePage();
    if (img.isEmpty()) return;
    const { width, height } = img.getSize();
    if (!width || !height) return;
    const dipW = main.getContentBounds().width;
    if (dipW <= 0) return;
    const dpr = width / dipW;
    const bmp = img.getBitmap();          // BGRA，alpha 在每像素第 4 字节
    let top = -1;
    for (let y = 0; y < height && top < 0; y++) {
      let cnt = 0;
      for (let x = 6; x < width - 6; x += 2) {
        if (bmp[(y * width + x) * 4 + 3] > 40) {
          if (++cnt >= 4) { top = y; break; }
        }
      }
    }
    if (top < 0) return;                  // 全透明帧（模型还没画出来），丢弃
    const dip = Math.round(top / dpr);
    if (dip !== headTop) {
      headTop = dip;
      if (win && !win.isDestroyed() && win.isVisible()) place();
    }
  } catch { /* 窗口正在销毁 / capturePage 失败：下次布局再量 */ }
}

function requestMeasure() {
  if (measureTimer) return;               // 已有排队中的量，节流
  measureTimer = setTimeout(() => {
    measureTimer = null;
    measureHead();
  }, MEASURE_MIN_GAP_MS);
}

function ensureWin() {
  if (win && !win.isDestroyed()) return win;
  curH = MIN_H;
  win = new BrowserWindow({
    width: WIDTH,
    height: MIN_H,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,          // 透明窗必须关系统阴影，否则整块灰框
    resizable: false,
    movable: false,
    focusable: false,          // 不抢聊天输入框的焦点
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 盖过主窗的置顶层（主窗是普通 alwaysOnTop；气泡悬浮其上，位置不重叠但保险）
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'bubble.html'));
  win.on('closed', () => { win = null; });
  return win;
}

function clearHideTimer() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function scheduleAutoHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => { hideNow(); }, AUTO_HIDE_MS);
}

/* 诊断口子：PET_SNAPSHOT 含 "bubble" 时，气泡落定后给自己拍个照。 */
function snapshotSelf() {
  const tag = String(process.env.PET_SNAPSHOT || '');
  if (!tag.includes('bubble') || !win || win.isDestroyed()) return;
  const seq = ++shotSeq;
  setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const img = await win.webContents.capturePage();
      const dir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `pet-bubble-${seq}.png`), img.toPNG());
      console.log(`[bubble] shot #${seq} saved`);
    } catch (err) {
      console.log('[bubble] shot failed:', String(err?.message || err));
    }
  }, 1200);
}

/* ---------- 对外 API ---------- */

function beginStream() {
  clearHideTimer();
  const gate = arbiter.acquire('stream');
  if (!gate.ok) return;           // 被更高优先级占着（极少见）
  streamToken = gate.token;
  if (!enabled()) return;
  try {
    const w = ensureWin();
    w.webContents.send('bubble:begin');
    curH = MIN_H;
    place();
    w.showInactive();      // 不抢焦点
  } catch (err) {
    console.warn('[bubble] begin failed:', String(err?.message || err));
  }
}

function appendChunk(text) {
  if (!enabled()) return;
  if (streamToken != null && !arbiter.allowsAppend(streamToken)) return;
  try {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { curH = MIN_H; place(); win.showInactive(); }
    win.webContents.send('bubble:chunk', String(text));
  } catch { /* 气泡窗刚关：主窗照常收 chunk，气泡这一轮缺席 */ }
}

/* 「心里想的」那一行（[think:…] 的内容）。
 * 整段到达、不进正文 —— 但**不能进 appendChunk**：那段文本会进 TTS 和聊天历史，
 * 想法是没打算说出口的，混进去就等于当众念出心声了。
 * 与前缀无关的另一个通道，故单独一个函数。 */
function appendThink(text) {
  if (!enabled()) return;
  if (streamToken != null && !arbiter.allowsAppend(streamToken)) return;
  try {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { curH = MIN_H; place(); win.showInactive(); }
    win.webContents.send('bubble:think', String(text));
  } catch { /* ignore */ }
}

function endStream() {
  arbiter.release(streamToken);
  streamToken = null;
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:end');
  } catch { /* ignore */ }
  snapshotSelf();
  scheduleAutoHide();
}

function abortStream() {
  arbiter.release(streamToken);
  streamToken = null;
  clearHideTimer();
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:abort');
  } catch { /* ignore */ }
}

/* say() 类整段播报（提醒 / 番茄钟 / 主动搭话的离线分支）—— alert 级，可盖住 status。 */
function showFull(text, autoHideMs = AUTO_HIDE_MS) {
  clearHideTimer();
  const gate = arbiter.acquire('alert');
  if (!gate.ok) return;
  /* alert 占位后 stream 被挤掉 —— 清掉旧 token，避免迟到的 endStream 误清 alert */
  streamToken = null;
  if (!enabled()) {
    arbiter.release(gate.token);
    return;
  }
  try {
    const w = ensureWin();
    w.webContents.send('bubble:full', String(text));
    curH = MIN_H;
    place();
    w.showInactive();
    snapshotSelf();
    hideTimer = setTimeout(() => {
      arbiter.release(gate.token);
      hideNow();
    }, Math.max(2000, autoHideMs));
  } catch (err) {
    arbiter.release(gate.token);
    console.warn('[bubble] showFull failed:', String(err?.message || err));
  }
}

/* 工作状态短句（status 级）—— 对话流进行中时不抢气泡。 */
function showStatus(text, autoHideMs = 2800) {
  clearHideTimer();
  const gate = arbiter.acquire('status');
  if (!gate.ok) return false;
  if (!enabled()) {
    arbiter.release(gate.token);
    return false;
  }
  try {
    const w = ensureWin();
    w.webContents.send('bubble:full', String(text));
    curH = MIN_H;
    place();
    w.showInactive();
    hideTimer = setTimeout(() => {
      arbiter.release(gate.token);
      hideNow();
    }, Math.max(1200, autoHideMs));
    return true;
  } catch (err) {
    arbiter.release(gate.token);
    console.warn('[bubble] showStatus failed:', String(err?.message || err));
    return false;
  }
}

function hideNow() {
  clearHideTimer();
  arbiter.reset();
  streamToken = null;
  try {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  } catch { /* ignore */ }
}

/* 主窗 move/resize 时跟随（拖着她走，气泡跟着飘）。 */
function syncPosition() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const now = Date.now();
  if (now - lastFollow < FOLLOW_MS) {
    if (!followTimer) {
      followTimer = setTimeout(() => {
        followTimer = null;
        lastFollow = Date.now();
        place();
      }, FOLLOW_MS);
    }
    return;
  }
  lastFollow = now;
  place();
}

/* 托盘开关切到关：立刻藏 + 销毁窗（下次开再懒创建）。 */
function refreshConfig() {
  if (!enabled()) hideNow();
}

/* 全屏静默：气泡浮在 alwaysOnTop 顶层会盖住全屏应用，进静默必须收掉。
 * 退出静默不恢复 —— 对话早就结束了，没有"恢复"可言。 */
function setQuiet(on) {
  if (on) hideNow();
}

function dispose() {
  clearHideTimer();
  arbiter.reset();
  streamToken = null;
  if (followTimer) { clearTimeout(followTimer); followTimer = null; }
  if (measureTimer) { clearTimeout(measureTimer); measureTimer = null; }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  win = null;
}

function configureBubble({ getWindow: get }) {
  if (typeof get === 'function') getWindow = get;
}

function registerBubbleIpc() {
  ipcMain.on('bubble:height', (_e, h) => onContentHeight(h));
}

module.exports = {
  configureBubble,
  registerBubbleIpc,
  requestMeasure,
  beginStream,
  appendChunk,
  appendThink,
  endStream,
  abortStream,
  showFull,
  showStatus,
  hideNow,
  syncPosition,
  refreshConfig,
  setQuiet,
  dispose,
  /* 测试与诊断用 */
  _state: () => ({
    alive: !!(win && !win.isDestroyed()),
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    h: curH,
    inside: insideMode,
    headTop,
    priority: arbiter.peek()
  }),
  _arbiter: arbiter
};
