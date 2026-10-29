'use strict';

/* 在角色身上**右键按住**弹出的轮盘菜单（radial / pie menu）。
 *
 * 形态是 Wave Menu：外环 = 当前这一层，内环 = 外环高亮项的子项，中心死区 = 取消。
 * 选它的依据（不是图好看）：
 *   - ACHI 2024 综述：「Wave Menu presents new levels at the centre of the menu
 *     circle … typically perform better than overlapping pie menus in which only
 *     one hierarchy level is visible at each time」—— 子级显示在圆心，比"点进去
 *     换一页"表现更好。
 *   - muriel radial-menus 规范：sub-rings 与 nested Back 是标准件，键盘模型就是
 *     「上下键在外环 / 内环 / 中心之间移动」。
 *   - Don Hopkins 引 Kurtenbach & Buxton 实测：4 项 × 4 层错误率约 5%，
 *     8 项 × 2 层也在 10% 以内；但每层 8 项且深度 > 1 会迅速飙过 10%
 *     → 所以**每层压到 4~6 项**去做多级，比一层塞 8 项更稳。
 *
 * 🔴 命中判定放在**主进程轮询**而不是页面的鼠标事件里，理由踩过才知道：
 *    右键是在主窗上按下的，松手时鼠标很可能已经划到轮盘窗甚至别的窗口上方，
 *    mousemove / mouseup 归哪个窗口是不确定的。主进程用
 *    screen.getCursorScreenPoint() 自己算，与事件归属完全无关。
 *    提交则是**双保险**：主窗与本窗各有一个 mouseup 监听，谁先收到算谁，
 *    提交本身幂等（done 闩），重复触发无害。
 *
 * 🔴 规矩 9：几何与命中只在**这一处**定义，wheel.html 只接收结果来画。 */

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
/* 几何与命中判定在 wheel-geom.js（纯函数，不依赖 Electron，回归可直接 require）。 */
const { computeGeom, maxKidsOf, hitAt, clampCenter } = require('./wheel-geom');

const POLL_MS = 16;         // 轮询鼠标位置的间隔（≈60fps）
const TIMEOUT_MS = 8000;    // 兜底：万一 mouseup 谁都没收到，别把盘一直挂在那

let win = null;
let items = [];
let actions = null;
let geom = null;
let center = { x: 0, y: 0 };
let timer = null;
let gen = 0;                // 代际令牌（规矩 16：周期任务自调度 + 令牌取消）
let done = true;            // 一次打开只提交一次
let reported = null;        // 页面回报的尺寸（诊断用）
let hover = { outer: -1, inner: -1 };

function ensureWin() {
  if (win && !win.isDestroyed()) return Promise.resolve(win);
  win = new BrowserWindow({
    width: 240,
    height: 240,
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
      preload: path.join(__dirname, 'wheel-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { win = null; });
  return new Promise((res) => {
    win.webContents.once('did-finish-load', () => res(win));
    win.loadFile(path.join(__dirname, 'wheel.html'));
  });
}

/* 按屏幕坐标更新命中项（轮询每拍调一次）。
 * ⚠️ 单独成函数的理由：这是"鼠标位置 → 选中项"的**唯一**转换点，真机验证要能
 *    直接调它（没法在脚本里真的移动系统光标），而调它 == 走轮询那条路，不是
 *    另开后门。命中状态只在主进程持有，页面是镜像。 */
function applyPoint(px, py) {
  const h = hitAt(geom, items, px - center.x, py - center.y, hover.outer);
  if (h.outer !== hover.outer || h.inner !== hover.inner) {
    hover = h;
    try { if (win && !win.isDestroyed()) win.webContents.send('wheel:hover', h); } catch { /* ignore */ }
  }
  return h;
}

function stopPoll() {
  clearTimeout(timer);
  timer = null;
}

function hide() {
  stopPoll();
  try { if (win && !win.isDestroyed()) win.hide(); } catch { /* 正在销毁 */ }
}

function finish(id) {
  if (done) return;           // 幂等：主窗和本窗的 mouseup 谁先到都只算一次
  done = true;
  hide();
  const fn = id != null && actions ? actions.get(id) : null;
  if (fn) { try { fn(); } catch { /* 单个菜单项出错不该把盘卡住 */ } }
}

/* 打开轮盘。x/y 是**屏幕坐标**（鼠标按下的位置）。
 * opts.tint = 带底色（interaction.radialTint）—— 只把开关传下去，色值在
 * wheel.html 的 CSS 变量里一处定义（规矩 9），主进程不碰颜色。 */
async function show(list, actionMap, x, y, opts) {
  items = Array.isArray(list) ? list : [];
  actions = actionMap instanceof Map ? actionMap : new Map(Object.entries(actionMap || {}));
  geom = computeGeom(maxKidsOf(items));
  const d = screen.getDisplayNearestPoint({ x, y });
  center = clampCenter(x, y, geom.R, d.workArea);
  done = false;
  hover = { outer: -1, inner: -1 };

  const w = await ensureWin();
  if (done) return;                       // 打开期间就被取消了
  w.setBounds({
    x: center.x - geom.R,
    y: center.y - geom.R,
    width: geom.R * 2,
    height: geom.R * 2
  });
  w.showInactive();                       // 不抢焦点
  w.webContents.send('wheel:show', { items, geom, tint: !(opts && opts.tint === false) });

  const my = ++gen;
  const tick = () => {
    if (my !== gen) return;               // 已被新的一次打开 / 关闭取代
    if (done) return;
    const p = screen.getCursorScreenPoint();
    applyPoint(p.x, p.y);
    timer = setTimeout(tick, POLL_MS);
  };
  tick();
  clearTimeout(timeoutTimer);
  timeoutTimer = setTimeout(() => finish(null), TIMEOUT_MS);
}

let timeoutTimer = null;

function cancel() { finish(null); }
function isOpen() { return !done; }

/* 松手提交**当前命中项**（主窗 mouseup 走这一条；轮盘窗自己那条走 pick，
 * 两条都归 finish()，幂等所以谁先到都行）。
 * ⚠️ 停在有子项的**组**上不算选中 —— 等于没选（= 取消）。这条让"划过去看一眼
 *    又反悔"永远安全，不需要额外的确认步骤。 */
function release() {
  if (done) return;
  const h = hover;
  if (h.outer < 0) { finish(null); return; }
  const it = items[h.outer];
  const kids = Array.isArray(it.kids) ? it.kids : [];
  if (kids.length && h.inner < 0) { finish(null); return; }
  finish(kids.length ? kids[h.inner].id : it.id);
}

function dispose() {
  gen += 1;
  done = true;
  clearTimeout(timeoutTimer);
  stopPoll();
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  win = null;
}

ipcMain.on('wheel:size', (_e, s) => { reported = s; });
ipcMain.on('wheel:pick', (_e, id) => finish(id));
ipcMain.on('wheel:cancel', () => cancel());

module.exports = {
  show, cancel, dispose, isOpen, release,
  _state: () => ({
    open: !done,
    center,
    geom,
    hover,
    reported,
    n: items.length,
    ids: items.map((i) => i.id)
  }),
  _win: () => win,        // 诊断 / 截图用（debug/shot-wheel.js 要抓这一帧）
  _applyPoint: applyPoint,  // 鼠标位置 → 命中项（轮询走的就是它，真机验证也调它）
  _stopPoll: stopPoll,      // 真机验证要注入坐标，就得先停掉按真实光标跑的轮询
  /* 纯函数出口（几何 / 命中 / 贴边 —— 回归直接断言这三个，见 verify-wheel） */
  _computeGeom: computeGeom,
  _maxKidsOf: maxKidsOf,
  _hitAt: hitAt,
  _clampCenter: clampCenter
};
