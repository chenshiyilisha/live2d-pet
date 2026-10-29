'use strict';

/* 头顶泡泡菜单（右键她 → 头顶浮出一排泡泡）。
 *
 * 为什么是泡泡而不是轮盘：
 *   - Material 的 FAB menu 明文「show 2–6 related actions floating on screen」
 *     「no more than six options」→ 顶层压到 5 个（表情/动作/外观/朗读/隐藏）。
 *   - 气泡菜单（Pop Menus）规范原文「以小型气泡浮层的形式承载菜单功能，通常
 *     包含一个箭头指向浮层出现的位置，选中某个菜单项后自动关闭」。
 *   - 气泡是这个产品**自己的**视觉语言（对话气泡 / 悬浮气泡 / 尾巴 / 两层柔
 *     投影），轮盘是外来物。
 * ⚠️ 同一批资料里也有反向证据，记在这里免得以后被当成没考虑过：
 *   Callahan et al. CHI 1991 实测 **pie 比 linear 快 15~20%**。泡泡是离散圆点，
 *   丢掉了楔形"目标宽度随半径变大"那一半优势 —— 所以① 弧形排布（保住"距离
 *   近似相等"那半）② 直径守 40px 下限（Material mini FAB 同尺寸）。
 *
 * 🔴 命中判定放在**主进程轮询**，理由踩过才知道（轮盘那次）：右键是在主窗按下
 *    的，松手时鼠标很可能已经划到泡泡窗甚至别的窗口上方，mousemove / mouseup
 *    归哪个窗口不确定。主进程用 screen.getCursorScreenPoint() 自己算，与事件
 *    归属完全无关。
 *
 * 两种选中方式都给（用户拍板"两者都要"）：
 *   ① 手势态：右键按住 → 划向泡泡 → 松手选中（快，跟轮盘同一套肌肉记忆）
 *   ② 常驻态：按下没动就松手 → 泡泡留在那儿 → 再点选（新手兜底）
 *   判据就是位移：松手时位移 < GESTURE_MIN 算"没划"，进常驻态。
 *
 * 规矩 9：几何只在 bubble-menu-geom.js 定义，页面只接收结果。 */

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const G = require('./bubble-menu-geom');

const POLL_MS = 16;          // 轮询鼠标位置的间隔（≈60fps）
const GESTURE_MIN = 12;      // 位移小于它 = "没划" = 进常驻态
const TIMEOUT_MS = 8000;     // 手势态兜底（mouseup 谁都没收到时不一直挂着）
const STICKY_MS = 15000;     // 常驻态兜底（比手势态宽松，它本来就是"等你点"）

let win = null;
let actions = null;
let opts = {};
let cur = [];                // 当前这一排（可能是子项行，开头带"返回"）
let trail = [];              // 走过的父项，供"返回"用
let head = { x: 0, y: 0 };   // 她头顶（屏幕坐标，尾巴指着它）
let pts = [];                // 当前泡泡圆心（屏幕坐标）
let box = { x: 0, y: 0, width: 0, height: 0 };
let hover = -1;
let pressAt = null;          // 按下时的光标位置（判"划没划"）
let sticky = false;          // 常驻态
let decided = false;         // 松手判过一次了（第二次右键松手 = 关掉）
let timer = null;
let timeoutTimer = null;
let gen = 0;                 // 代际令牌（规矩 16：周期任务自调度 + 令牌取消）
let done = true;             // 一次打开只提交一次

function ensureWin() {
  if (win && !win.isDestroyed()) return Promise.resolve(win);
  win = new BrowserWindow({
    width: 320,
    height: 160,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,          // 透明窗必须关系统阴影，否则整块灰框
    resizable: false,
    movable: false,
    focusable: false,          // 不抢主窗焦点（免得影响全屏静默判定 / 输入框）
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-menu-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { win = null; });
  return new Promise((res) => {
    win.webContents.once('did-finish-load', () => res(win));
    win.loadFile(path.join(__dirname, 'bubble-menu.html'));
  });
}

/* 摆位 + 下发。⚠️ 换排（进子项 / 返回）也走这里 —— 项数变了半径就得重算，
 * 复用同一个函数才不会漏掉"重排后窗口也得跟着改大小"。 */
function placeAndSend() {
  if (!win || win.isDestroyed()) return;
  const d = screen.getDisplayNearestPoint(head);
  const out = G.layoutClamped(cur.length, head, d.workArea);
  pts = out.lay.pts;
  box = out.lay.box;
  win.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  win.showInactive();                     // 不抢焦点
  win.webContents.send('menu:show', {
    /* ⚠️ 只下发"画得出来"的字段：id 不下发，动作留在主进程（页面回一个下标，
     *    主进程自己换成 id）。这样加命令不用动页面。 */
    items: cur.map((it) => ({
      label: it.label,
      sub: it.sub,
      icon: it.icon,
      hasKids: Array.isArray(it.kids) && it.kids.length > 0
    })),
    pts: pts.map((p) => ({ x: p.x - box.x, y: p.y - box.y, r: p.r })),
    size: { width: box.width, height: box.height },
    /* 尾巴指的还是**她头顶真位置**（贴边收拢挪过之后两者会分开）。 */
    anchor: { x: head.x - box.x, y: head.y - box.y },
    level: trail.length + 1,
    tint: opts.tint !== false
  });
}

/* 鼠标位置 → 命中项。轮询每拍调一次。
 * ⚠️ 单独成函数的理由：真机验证要能直接调它（脚本里没法真的移动系统光标），
 *    而调它 == 走轮询那条路，不是另开后门。 */
function applyPoint(px, py) {
  const h = G.hitAt(pts, px, py);
  if (h !== hover) {
    hover = h;
    try { if (win && !win.isDestroyed()) win.webContents.send('menu:hover', h); } catch { /* ignore */ }
  }
  return h;
}

function stopPoll() {
  clearTimeout(timer);
  timer = null;
}

function armTimeout(ms) {
  clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => finish(null), ms);
}

function startPoll() {
  const my = ++gen;
  const tick = () => {
    if (my !== gen) return;               // 已被新的一次打开 / 关闭取代
    if (done) return;
    const p = screen.getCursorScreenPoint();
    applyPoint(p.x, p.y);
    timer = setTimeout(tick, POLL_MS);
  };
  tick();
}

function hide() {
  stopPoll();
  try { if (win && !win.isDestroyed()) win.hide(); } catch { /* 正在销毁 */ }
}

function finish(id) {
  if (done) return;                       // 幂等：两条 mouseup / 连点都只算一次
  done = true;
  clearTimeout(timeoutTimer);
  hide();
  const fn = id != null && id !== '__back' && actions ? actions.get(id) : null;
  if (fn) { try { fn(); } catch { /* 单个菜单项出错不该把菜单卡住 */ } }
}

/* 进子项：整排**原地换**成子项（用户拍板的方案）。
 * ⚠️ 不做"移进窄缝再展开"：MIT 6.831 讲过级联子菜单是 steering 任务，比
 *    pointing 难得多 —— 换排让每个子项都是一次普通指向。
 * 「返回」是显式的一项（不是靠 Esc 才知道能退）：可见的出口胜过隐性操作。 */
function drill(i) {
  const it = cur[i];
  const kids = Array.isArray(it && it.kids) ? it.kids : [];
  if (!kids.length) return false;
  trail.push({ items: cur });
  cur = [{ id: '__back', label: '返回' }].concat(kids);
  hover = -1;
  placeAndSend();
  return true;
}

function back() {
  if (!trail.length) { finish(null); return; }
  cur = trail.pop().items;
  hover = -1;
  placeAndSend();
}

/* 选中第 i 个：有子项 → 进子项（留在原地不关）；叶子 → 执行。 */
function activate(i) {
  if (i == null || i < 0) { finish(null); return; }
  if (drill(i)) { armTimeout(STICKY_MS); return; }
  finish(cur[i] ? cur[i].id : null);
}

/* 右键松手。
 * ⚠️ 判"划没划"用**位移**而不是时间：时间判据（按住多久算长按）会跟"她被摸
 *    头 / 拖拽"那些长按手势打架，位移判据跟它们正交。 */
function release() {
  if (done) return;
  if (decided) { finish(null); return; }   // 第二次右键松手 = 关掉
  decided = true;
  const p = screen.getCursorScreenPoint();
  const moved = pressAt ? Math.hypot(p.x - pressAt.x, p.y - pressAt.y) : 0;
  if (moved < GESTURE_MIN) {               // 没划 → 常驻态，等用户点
    sticky = true;
    armTimeout(STICKY_MS);
    return;
  }
  activate(hover);
}

async function show(list, actionMap, headPt, o) {
  actions = actionMap instanceof Map ? actionMap : new Map(Object.entries(actionMap || {}));
  opts = o || {};
  head = { x: headPt.x, y: headPt.y };
  cur = Array.isArray(list) ? list : [];
  trail = [];
  hover = -1;
  sticky = false;
  decided = false;
  done = false;
  const p = screen.getCursorScreenPoint();
  pressAt = { x: p.x, y: p.y };

  const w = await ensureWin();
  if (done) return;                        // 打开期间就被取消了
  placeAndSend();
  armTimeout(TIMEOUT_MS);
  startPoll();
}

function cancel() { finish(null); }
function isOpen() { return !done; }

function dispose() {
  gen += 1;
  done = true;
  clearTimeout(timeoutTimer);
  stopPoll();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  win = null;
}

ipcMain.on('menu:pick', (_e, i) => { if (!done) activate(Number(i)); });
ipcMain.on('menu:cancel', () => finish(null));
ipcMain.on('menu:back', () => { if (!done) back(); });
ipcMain.on('menu:release', () => release());
ipcMain.on('menu:hover-key', (_e, i) => { hover = Number(i); });

module.exports = {
  show, cancel, dispose, isOpen, release, back,
  _state: () => ({
    open: !done,
    sticky,
    decided,
    hover,
    n: cur.length,
    level: trail.length + 1,
    ids: cur.map((i) => i.id),
    box,
    pts,
    head
  }),
  _win: () => win,
  /* 选中第 i 个（**含**进子项的分支）。真机验证要测"划到带子项的泡泡"这条路径，
   * 而脚本里没法真的移动系统光标去触发 release()，所以开这个口子 —— 走的是
   * release() / click 同一条 activate()，不是另写一份。 */
  _activate: activate,
  _applyPoint: applyPoint,
  _stopPoll: stopPoll,
  _geom: G
};
