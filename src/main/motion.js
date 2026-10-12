'use strict';

const { screen } = require('electron');
const { loadConfig } = require('./config');
const { clamp, cornerPos } = require('./util');
const { SIZE, MARGIN } = require('./win-size');

/* ============================================================
 *  窗口移动：平滑动画 / 边缘吸附 / 自主漫步
 * ==========================================================
 *
 *  ⚠️ 「用户操作优先于自动动作」是这个文件的最高原则。
 *     拖拽、点按进来时必须能立刻把跑着的动画掐掉（主进程侧由
 *     pet:drag-move 处理器调 cancelMoveAnim()）。两条循环同时写窗口
 *     位置的表现是「溜达途中一把抓住她，窗口一边跟着走一边自己抽搐」。
 * ========================================================== */

/* 窗口句柄由 main.js 注入（窗口会被销毁重建，不能在这里存快照）。 */
let getWin = () => null;
function configureMotion(fn) { getWin = fn; }
const win = () => {
  const w = getWin();
  return w && !w.isDestroyed() ? w : null;
};

let moveAnim = null;

function cancelMoveAnim() {
  if (moveAnim) { clearInterval(moveAnim); moveAnim = null; }
}

/* 给诊断通道用：判断「拖拽有没有把溜达的平滑移动掐掉」，
 * 光看坐标变化会被 edgeSnap 之类的后续动作干扰，直接看动画在不在跑最准。 */
function isMoveAnimRunning() { return !!moveAnim; }

/* 平滑移动窗口到 (tx, ty)。
 * ⚠️ 必须 setBounds 带死宽高 —— setPosition 会触发 DWM 边框重算把窗口撑大
 *   （见 main.js 里 pet:drag-move 的长注释），逐帧调用尤其明显。 */
function animateTo(tx, ty, ms = 800) {
  const w = win();
  if (!w) return;
  cancelMoveAnim();
  const b = w.getBounds();
  const sx = b.x;
  const sy = b.y;
  const t0 = Date.now();
  moveAnim = setInterval(() => {
    const cur = win();
    if (!cur) { cancelMoveAnim(); return; }
    const p = Math.min(1, (Date.now() - t0) / Math.max(1, ms));
    const e = 1 - Math.pow(1 - p, 3);          // easeOutCubic
    const x = Math.round(sx + (tx - sx) * e);
    const y = Math.round(sy + (ty - sy) * e);
    try { cur.setBounds({ x, y, width: SIZE.w, height: SIZE.h }); }
    catch { cancelMoveAnim(); return; }
    if (p >= 1) cancelMoveAnim();
  }, 24);
}

const SNAP_DIST = 56;      // 松手时窗口距边缘多少 px 内就吸附过去

/* 窗口**当前所在**的那块显示器。
 *
 * ⚠️ 贴边 / 溜达 / 回右下角都必须按她自己那块屏算，不能用 getPrimaryDisplay()：
 *    窗口在副屏（比如主屏左侧，副屏坐标为负）时，拿主屏的 workArea 去算
 *    dist.right = 主屏右边 - 窗口右边，会得到一个很大的负数 →
 *    「最近边」永远判成 right → 一松手就被拽回主屏。
 *    （本机目前是单屏，踩不到；插第二块屏立刻复现。）
 *
 * getDisplayMatching 语义就是「与这个矩形重叠最多的显示器 / 最近的那块」，
 * 窗口被拖到两屏之间、甚至大部分移出屏幕时也能给出合理答案。
 * 拿不到就退回主屏，不让它抛。 */
function currentDisplay() {
  const w = win();
  if (w) {
    try { return screen.getDisplayMatching(w.getBounds()); } catch { /* 退回主屏 */ }
  }
  return screen.getPrimaryDisplay();
}

let snapGuard = null;      // doWander 里那个延后触发的 set 拿它做取消

function edgeSnap() {
  const w = win();
  if (!w) return;
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false || cfg.motion?.edgeSnap === false) return;

  const { workArea } = currentDisplay();
  const b = w.getBounds();
  const dist = {
    left: b.x - workArea.x,
    right: (workArea.x + workArea.width) - (b.x + b.width),
    top: b.y - workArea.y,
    bottom: (workArea.y + workArea.height) - (b.y + b.height)
  };

  let edge = null;
  let best = Infinity;
  for (const k of ['left', 'right', 'top', 'bottom']) {
    if (dist[k] < best) { best = dist[k]; edge = k; }
  }
  if (best > SNAP_DIST) return;

  let x = b.x;
  let y = b.y;
  if (edge === 'left') x = workArea.x;
  if (edge === 'right') x = workArea.x + workArea.width - SIZE.w;
  if (edge === 'top') y = workArea.y;
  if (edge === 'bottom') y = workArea.y + workArea.height - SIZE.h;
  x = clamp(x, workArea.x, workArea.x + workArea.width - SIZE.w);
  y = clamp(y, workArea.y, workArea.y + workArea.height - SIZE.h);
  if (x === b.x && y === b.y) return;

  animateTo(x, y, 240);
  try { w.webContents.send('pet:snapped', { edge }); } catch { /* ignore */ }
}

let wanderTimer = null;

function resetWanderTimer() {
  clearTimeout(wanderTimer);
  const cfg = loadConfig();
  if (!win()) return;
  if (cfg.motion?.enabled === false || cfg.motion?.wander === false) return;
  const mins = clamp(Number(cfg.motion?.wanderIdleMin) || 3, 0.2, 120);
  wanderTimer = setTimeout(doWander, mins * 60000);
}

function doWander() {
  const w = win();
  if (!w || !w.isVisible()) {
    resetWanderTimer();
    return;
  }
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false || cfg.motion?.wander === false) return;

  const b = w.getBounds();

  // 光标就在她附近 → "注意到你了"，这一轮不溜达
  try {
    const pt = screen.getCursorScreenPoint();
    const near = pt.x > b.x - 220 && pt.x < b.x + b.width + 220 &&
                 pt.y > b.y - 220 && pt.y < b.y + b.height + 220;
    if (near) {
      try { w.webContents.send('pet:noticed'); } catch { /* ignore */ }
      resetWanderTimer();
      return;
    }
  } catch { /* 拿不到光标位置就照常溜达 */ }

  const { workArea } = currentDisplay();
  const minX = workArea.x + MARGIN;
  const minY = workArea.y + MARGIN;
  const far = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN);
  const tx = Math.round(minX + Math.random() * Math.max(0, far.x - minX));
  const ty = Math.round(minY + Math.random() * Math.max(0, far.y - minY));

  try { w.webContents.send('pet:wander-start'); } catch { /* ignore */ }
  animateTo(tx, ty, 1100);
  clearTimeout(snapGuard);
  snapGuard = setTimeout(() => {
    snapGuard = null;
    const cur = win();
    if (!cur) return;
    try { cur.webContents.send('pet:wander-end'); } catch { /* ignore */ }
    edgeSnap();               // 溜达到边缘附近就顺势贴过去
    resetWanderTimer();
  }, 1250);
}

function disposeMotion() {
  cancelMoveAnim();
  clearTimeout(wanderTimer);
  clearTimeout(snapGuard);
}

module.exports = {
  configureMotion,
  cancelMoveAnim,
  isMoveAnimRunning,
  animateTo,
  edgeSnap,
  resetWanderTimer,
  doWander,
  currentDisplay,
  disposeMotion
};
