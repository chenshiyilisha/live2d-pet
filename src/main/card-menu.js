'use strict';

/* 光标处卡片菜单（右键她 → 光标右下弹出竖排卡片）。
 *
 * 为什么最终是它（轮盘 / 头顶泡泡都试过，都不行）：
 *   - 轮盘：扇区 44px 厚塞「图标 + 标签 + 当前值」是几何死局（实测距外缘 2.8px），
 *     而且 MIT 6.831 的原话是「pie 快 15~20%，但**效率优势不足以抵消线性菜单的
 *     外部一致性与布局简单性**」——我上次只引了前半句。
 *   - 头顶泡泡：离散圆点**没有"菜单"的轮廓**，视线要跳 N 次逐个对准圆形目标，
 *     扫读成本比一列文字高；而且没有任何先例（桌宠 / 设计规范 / HCI 三处都没有）。
 *   - 卡片：VS Code / Discord / Figma / Slack 全部自绘但**都保留原生菜单的形态**，
 *     是"好看 + 可预测"唯一有大量先例的组合。
 * 两份旧实现都**留着**、可用配置切回（规矩 4：新形态是开关，不是替换）。
 *
 * 🔴 命中判定在**主进程轮询**，与事件归属无关：右键是在主窗按下的，松手/划过时
 *    鼠标很可能已经在卡片窗甚至别的窗口上方。
 * 🔴 窗口 bounds：首次打开就按「主卡 ∪ 每个 kids 子菜单可能占地」算死。
 *    进/出子菜单**不再 setBounds** —— Electron 透明窗改大小会闪一整帧
 *    （electron#39834）。空白区仍吃鼠标，但只在菜单开着时、且点空白 = 取消，
 *    比每次展开闪一下更可接受。
 *
 * 两种选中方式（与泡泡那版一致，用户拍板"两者都要"）：
 *   ① 手势态：右键按住 → 划到某行 → 松手执行
 *   ② 常驻态：按下没动就松手 → 卡片留着 → 再点选
 *   判据是**位移**（< GESTURE_MIN 算没划），不是时长 —— 时长会跟摸头 / 拖拽
 *   那些长按手势打架。
 *
 * 规矩 9：几何只在 card-menu-geom.js 定义，本文件只做状态与摆位。 */

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const G = require('./card-menu-geom');

const POLL_MS = 16;          // 轮询光标（≈60fps）
const GESTURE_MIN = 12;      // 位移小于它 = 没划 = 进常驻态
const TIMEOUT_MS = 8000;     // 手势态兜底
const STICKY_MS = 15000;     // 常驻态兜底（它本来就是"等你点"）
const DWELL_MS = 220;        // 悬停多久展开子菜单（原生菜单同量级）

let win = null;
let actions = null;
let opts = {};

let mainItems = [];          // 顶层项（可能含 {sep:true}）
let subItems = null;         // 子菜单项，没开就是 null
let parentIdx = -1;          // 子菜单属于哪个顶层项

let layMain = null;
let laySub = null;
let posMain = null;          // 卡片左上角（屏幕坐标）
let posSub = null;
let sizeMain = null;
let sizeSub = null;
let bounds = { x: 0, y: 0, width: 1, height: 1 };

let anchor = { x: 0, y: 0 }; // 按下时的光标（摆位锚点，**不追鼠标**）
let pressAt = null;
let hover = { card: 'main', i: -1 };
let sticky = false;
let decided = false;         // 松手判过一次了（第二次右键松手 = 关掉）
let timer = null;
let dwellTimer = null;
let timeoutTimer = null;
let gen = 0;                 // 代际令牌（规矩 16：周期任务自调度 + 令牌取消）
let paintGen = 0;            // 等页面画完再显形（子菜单左右翻转用）
let paintWaiters = [];
let done = true;             // 一次打开只提交一次

const hasKids = (it) => !!(it && Array.isArray(it.kids) && it.kids.length);

function ensureWin() {
  if (win && !win.isDestroyed()) return Promise.resolve(win);
  win = new BrowserWindow({
    width: 220,
    height: 200,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,          // 透明窗必须关系统阴影，否则整块灰框
    resizable: false,
    movable: false,
    focusable: false,          // 不抢主窗/用户编辑器焦点
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'card-menu-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { win = null; });
  return new Promise((res) => {
    win.webContents.once('did-finish-load', () => res(win));
    win.loadFile(path.join(__dirname, 'card-menu.html'));
  });
}

const workAreaAt = (p) => screen.getDisplayNearestPoint(p).workArea;
const rectOf = (pos, size) => ({ x: pos.x, y: pos.y, w: size.w, h: size.h });

/* 槽位数据：几何给的 y/h **不用下发** —— 页面用流式布局，高度由 CSS 变量
 * 从 metric 拿（一处定义）。这里只合并"项的内容"。 */
function slotsOf(items, lay) {
  return lay.slots.map((s) => {
    if (s.sep) return { sep: true };
    const it = items[s.i] || {};
    return {
      sep: false, i: s.i,
      label: it.label, sub: it.sub, icon: it.icon, hasKids: hasKids(it)
    };
  });
}

function flushPaintWaiters() {
  const q = paintWaiters.slice();
  paintWaiters.length = 0;
  for (const fn of q) { try { fn(); } catch { /* ignore */ } }
}

/* 等页面两帧画完；超时也放行，免得 IPC 丢了菜单永远透明。 */
function waitPainted() {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 80);
    paintWaiters.push(() => { clearTimeout(t); resolve(); });
  });
}

/* 每个带子菜单的顶层项，按它展开时的真实摆位塞进 rects。
 * 首次打开就把这些占地并进窗口 —— 之后进/出子菜单 bounds 不变，避免 setBounds 闪。 */
function pushKidsReserves(rects, pos, size, items, lay, wa) {
  if (!lay || !lay.rows) return;
  for (const row of lay.rows) {
    const it = items[row.i];
    if (!hasKids(it)) continue;
    const layK = G.card(it.kids);
    const posK = G.placeSub(pos, size, row.y, layK, wa);
    rects.push(rectOf(posK, layK));
  }
}

function boundsEqual(a, b) {
  return !!a && !!b
    && a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height;
}

/* 摆位 + 下发。进/出子菜单也走这里；窗口大小在首次打开时按 kids 预留钉死，
 * 之后只改页面里的子卡显隐，不再 setBounds。 */
function placeAndSend(entry) {
  if (!win || win.isDestroyed()) return;
  const wa = workAreaAt(anchor);
  layMain = G.card(mainItems);
  sizeMain = layMain;
  posMain = G.place(anchor, sizeMain, wa);

  let subRow = null;
  posSub = null;
  sizeSub = null;
  laySub = null;
  if (subItems) {
    laySub = G.card(subItems);
    sizeSub = laySub;
    subRow = layMain.rows.find((r) => r.i === parentIdx) || null;
    posSub = G.placeSub(posMain, sizeMain, subRow ? subRow.y : 0, sizeSub, wa);
  }

  /* ⚠️ bounds 必须**先**算出来：两张卡片的相对坐标都要减它。
   * 并上所有 kids 可能占地，保证开子菜单时 nextBounds === bounds。 */
  const rects = [rectOf(posMain, sizeMain)];
  if (posSub) rects.push(rectOf(posSub, sizeSub));
  pushKidsReserves(rects, posMain, sizeMain, mainItems, layMain, wa);
  const nextBounds = G.boundsOf(rects);

  /* 透明窗 setBounds 本身就会闪（即便只改宽、原点不动）。
   * 尺寸没变就绝对不要调；真要改（极少：首次显形）才走 setBounds。
   * 若可见时原点还跳了，先透明等 painted，避免主卡错位一帧。 */
  const wasVisible = win.isVisible();
  const moved = !boundsEqual(nextBounds, bounds);
  const originMoved = wasVisible && moved
    && (nextBounds.x !== bounds.x || nextBounds.y !== bounds.y);
  bounds = nextBounds;

  const specSub = posSub ? {
    x: posSub.x - bounds.x,
    y: posSub.y - bounds.y,
    w: sizeSub.w,
    h: sizeSub.h,
    slots: slotsOf(subItems, laySub),
    iconCol: laySub.iconCol,
    /* 子卡片的入场从**左边那条边**长出来（它是横向展开的）。 */
    origin: { x: 0, y: G.PAD_Y + (subRow ? subRow.h / 2 : 0) }
  } : null;

  if (originMoved) {
    try { win.setOpacity(0); } catch { /* ignore */ }
  }

  if (moved) {
    win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height });
  }
  if (!wasVisible) win.showInactive();      // 已可见时不要再 show（也会闪）

  const payload = {
    size: { width: bounds.width, height: bounds.height },
    metric: { itemH: G.ITEM_H, sepH: G.SEP_H, padY: G.PAD_Y, iconW: G.ICON_W },
    main: {
      x: posMain.x - bounds.x,
      y: posMain.y - bounds.y,
      w: sizeMain.w,
      h: sizeMain.h,
      slots: slotsOf(mainItems, layMain),
      iconCol: layMain.iconCol,
      /* 入场动画的缩放原点 = 光标在卡片里的位置（Material 菜单同款手感）。 */
      origin: {
        x: Math.max(0, Math.min(sizeMain.w, anchor.x - posMain.x)),
        y: Math.max(0, Math.min(sizeMain.h, anchor.y - posMain.y))
      }
    },
    sub: specSub,
    tint: opts.tint !== false,
    entry: !!entry
  };

  win.webContents.send('card:show', payload);

  if (originMoved) {
    const my = ++paintGen;
    waitPainted().then(() => {
      if (my !== paintGen || done) return;
      if (!win || win.isDestroyed()) return;
      try { win.setOpacity(1); } catch { /* ignore */ }
    });
  }
}

function sendHover() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('card:hover', hover);
  } catch { /* 正在销毁 */ }
}

function clearDwell() {
  clearTimeout(dwellTimer);
  dwellTimer = null;
}

function openSub(i) {
  const it = mainItems[i];
  if (!hasKids(it)) return false;
  clearDwell();
  subItems = it.kids;
  parentIdx = i;
  placeAndSend(false);
  return true;
}

function closeSub() {
  if (!subItems) return;
  subItems = null;
  parentIdx = -1;
  placeAndSend(false);
}

/* 只在 hover **变化**时重挂定时器 —— 每拍都重挂的话计时永远到不了。 */
function scheduleDwell() {
  clearDwell();
  if (subItems) return;
  const i = hover && hover.card === 'main' ? hover.i : -1;
  if (i < 0 || !hasKids(mainItems[i])) return;
  dwellTimer = setTimeout(() => {
    if (done) return;
    /* 这期间又动过就不开（dwell 是"停住"的意思，不是"路过"）。 */
    if (!(hover && hover.card === 'main' && hover.i === i)) return;
    openSub(i);
  }, DWELL_MS);
}

/* 光标 → 命中。轮询每拍调一次。
 * ⚠️ 单独成函数的理由：真机验证要能直接调它（脚本里没法真移动系统光标），
 *    而调它 == 走轮询那条路，不是另开后门。 */
function applyPoint(px, py) {
  const next = hitPoint(px, py);
  const changed = next.card !== hover.card || next.i !== hover.i;
  hover = next;
  if (changed) { sendHover(); scheduleDwell(); }
  return next;
}

function hitPoint(px, py) {
  if (subItems && posSub) {
    const subRect = rectOf(posSub, sizeSub);
    if (G.inRect(subRect, px, py)) {
      return { card: 'sub', i: G.hitAt(laySub, px - posSub.x, py - posSub.y) };
    }
    const mainRect = rectOf(posMain, sizeMain);
    if (G.inRect(mainRect, px, py)) {
      const i = G.hitAt(layMain, px - posMain.x, py - posMain.y);
      /* 移到别的顶层项上 → 子菜单立刻收（原生菜单就是这样，不用等）。
       * 回到父项不算"别的"，保持展开。 */
      if (i >= 0 && i !== parentIdx) closeSub();
      return { card: 'main', i };
    }
    /* 缝里（卡片右沿 → 子菜单左沿）保留父项高亮：手抖划过缝不该取消选择。 */
    if (G.inBridge(rectOf(posMain, sizeMain), sizeMain, subRect, px, py)) {
      return { card: 'main', i: parentIdx };
    }
    closeSub();
    return { card: 'main', i: -1 };
  }
  const mainRect = rectOf(posMain, sizeMain);
  const i = G.inRect(mainRect, px, py) ? G.hitAt(layMain, px - posMain.x, py - posMain.y) : -1;
  return { card: 'main', i };
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
  clearDwell();
  paintGen += 1;
  flushPaintWaiters();
  try {
    if (win && !win.isDestroyed()) {
      try { win.setOpacity(1); } catch { /* ignore */ }
      win.hide();
    }
  } catch { /* 正在销毁 */ }
}

function finish(id) {
  if (done) return;                       // 幂等：两条 mouseup / 连点都只算一次
  done = true;
  clearTimeout(timeoutTimer);
  hide();
  const fn = id != null && actions ? actions.get(id) : null;
  if (fn) { try { fn(); } catch { /* 单个菜单项出错不该把菜单卡住 */ } }
}

/* 选中：子项 → 执行；顶层叶子 → 执行；顶层带子项 → 展开并转常驻态。 */
function commit(h) {
  if (done) return;
  if (!h || h.i == null || h.i < 0) { finish(null); return; }
  if (h.card === 'sub') {
    const it = subItems && subItems[h.i];
    finish(it ? it.id : null);
    return;
  }
  const it = mainItems[h.i];
  if (!it) { finish(null); return; }
  if (hasKids(it)) {
    openSub(h.i);
    sticky = true;                        // 展开后留在那儿等用户点
    armTimeout(STICKY_MS);
    return;
  }
  finish(it.id);
}

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
  commit(hover);
}

/* 打开。pos 是**屏幕坐标**（右键按下处）。 */
async function show(list, actionMap, pos, o) {
  actions = actionMap instanceof Map ? actionMap : new Map(Object.entries(actionMap || {}));
  opts = o || {};
  mainItems = Array.isArray(list) ? list : [];
  subItems = null;
  parentIdx = -1;
  anchor = { x: Math.round(Number(pos.x) || 0), y: Math.round(Number(pos.y) || 0) };
  pressAt = { x: anchor.x, y: anchor.y };
  hover = { card: 'main', i: -1 };
  sticky = false;
  decided = false;
  done = false;

  const w = await ensureWin();
  if (done) return;                        // 打开期间就被取消了
  layMain = G.card(mainItems);
  placeAndSend(true);
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
  clearDwell();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  win = null;
}

ipcMain.on('card:pick', (_e, h) => { if (!done) commit(h && typeof h === 'object' ? h : { card: 'main', i: Number(h) }); });
ipcMain.on('card:cancel', () => finish(null));
ipcMain.on('card:release', () => release());
ipcMain.on('card:painted', () => flushPaintWaiters());

module.exports = {
  show, cancel, dispose, isOpen, release,
  _state: () => ({
    open: !done,
    sticky,
    decided,
    hover,
    n: mainItems.length,
    sub: subItems ? subItems.map((i) => i.id) : null,
    parentIdx,
    box: bounds,
    posMain,
    posSub,
    sizeMain,
    sizeSub: sizeSub ? { w: sizeSub.w, h: sizeSub.h } : null,
    anchor
  }),
  _win: () => win,
  /* 真机验证要测"划到带子项的项"这条路径，而脚本里没法真移动系统光标 ——
   * 走的是 release() / click 同一条 commit()，不是另写一份。 */
  _activate: commit,
  _openSub: openSub,
  _applyPoint: applyPoint,
  _stopPoll: stopPoll,
  _geom: G
};
