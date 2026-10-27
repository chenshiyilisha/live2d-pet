'use strict';

const { screen, powerMonitor } = require('electron');
const { loadConfig } = require('./config');
const { clamp, cornerPos } = require('./util');
const { SIZE, MARGIN } = require('./win-size');
const {
  estimateVelocity, shouldThrow, step: throwStep
} = require('./throw-physics');

/* ============================================================
 *  窗口移动：平滑动画 / 边缘吸附 / 自主漫步 / 回位
 * ==========================================================
 *
 *  ⚠️ 「用户操作优先于自动动作」是这个文件的最高原则。
 *     拖拽、点按进来时必须能立刻把跑着的动画掐掉（主进程侧由
 *     pet:drag-move 处理器调 onUserDragMove()）。两条循环同时写窗口
 *     位置的表现是「溜达途中一把抓住她，窗口一边跟着走一边自己抽搐」。
 *
 *  两个**自动**移动（都会被她自己的动作打断）：
 *    1. 自主漫步 —— 长时间没人操作（系统级判定，鼠标动一下或敲键盘都算）
 *       就自己到处走走，走走停停，像在房间里踱步；
 *    2. 回位   —— 她溜达跑远之后，一旦检测到你回来了（同上判定），
 *       自己走回「家」的位置（家的定义见 setHome 的注释）。
 *     两者都成对给渲染层发 pet:wander-start / pet:wander-end，由那边
 *     播 / 停自制的 Walk 动作（首尾闭合的循环动作，见 tools/make-motions.js）。
 * ========================================================== */

/* 窗口句柄由 main.js 注入（窗口会被销毁重建，不能在这里存快照）。 */
let getWin = () => null;
function configureMotion(fn) { getWin = fn; }
const win = () => {
  const w = getWin();
  return w && !w.isDestroyed() ? w : null;
};

let moveAnim = null;
let throwAnim = null;          // 甩抛飞行定时器（与 moveAnim 互斥）
let throwSamples = [];         // 拖拽采样 [{t,x,y}]
let onThrowSquash = () => {};  // (intensity) => void —— 落地 Q 弹回调
let onThrowSettled = () => {}; // () => void —— 停稳后（落盘 / 贴边）

function configureThrowHooks({ onSquash, onSettled } = {}) {
  if (typeof onSquash === 'function') onThrowSquash = onSquash;
  if (typeof onSettled === 'function') onThrowSettled = onSettled;
}

/* 「暂停」= 全屏 / 游戏静默期间冻结一切自动移动（见 main.js 的 setQuiet）。
 *
 * ⚠️ 为什么不复用 motion.enabled 配置开关：那是**用户的选择**，这是**环境
 *    触发**的临时状态，两者会互相覆盖（静默结束时若把 enabled 写回 true，
 *    用户关掉的"自动溜达"就被偷偷打开了）。所以是一个独立的内存标志。 */
let paused = false;

function setMotionPaused(on) {
  const next = !!on;
  if (next === paused) return;
  paused = next;
  if (paused) {
    // 立刻收手：正在走的、以及溜达循环里排着的下一步
    cancelAutoMotion();
  } else {
    /* 醒了之后重新武装：别让她一醒就用"静默期间累积的闲置时长"直接开走。
     * （静默是环境状态，那段时间用户在打游戏，不该算作"没人理她"。） */
    armedAt = Date.now();
  }
}

function isMotionPaused() { return paused; }

/* 只停"当前这一趟平滑移动"。**不含**溜达循环的取消 —— 那个要 ++GEN。
 *
 * ⚠️ 这两种收手的粒度必须分开，踩过一次坑：老的 doWander 把「溜达结束顺势贴边」
 *    排在一个 1250ms 定时器上，而 animateTo 自己跑完（约 1104ms）也会走
 *    cancelMoveAnim()，顺手就把那个定时器清掉了 —— 于是"溜达结束"这件事
 *    从来没发生过。以前她溜达时人不动（只挪窗口），所以看不出来；换成
 *    播 Walk 动画之后就变成"溜达完一直原地走"。 */
function cancelMoveAnim() {
  if (moveAnim) { clearInterval(moveAnim); moveAnim = null; }
}

function cancelThrowFlight() {
  if (throwAnim) { clearInterval(throwAnim); throwAnim = null; }
}

function clearThrowSamples() { throwSamples = []; }

function cancelThrow() {
  cancelThrowFlight();
  clearThrowSamples();
}

function isThrowRunning() { return !!throwAnim; }

/* 用户上手 / 静默 / 销毁时用的**彻底**收手：当前这一趟 + 溜达循环 + 回位 + 甩抛，
 * 一起停掉。凡是从"外部"打断自动移动的都该用这个。 */
function cancelAutoMotion() {
  GEN++;
  mode = 'idle';
  cancelMoveAnim();
  cancelThrow();
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

/* ══════════════════════════════════════════════════════════
 *  自主漫步（走走停停）+ 有人操作就走回家
 * ══════════════════════════════════════════════════════════ */

/* 「家」= 她该待着的地方。
 *
 * 用户在 2026-10-13 明确指定了这个定义：「初始位置」就是**本次启动时**窗口
 * 所在的位置（也就是上次用户手动放好的地方 —— getInitialBounds 会从配置里
 * 读回 window.x/y）。所以这里**只在三个时刻**更新：
 *   1. 启动建窗（main.js 的 createWindow）；
 *   2. 用户点了托盘「回到右下角」—— 那是他明确指定"你就待这儿"；
 *   3. 换屏 / 改系统缩放导致窗口被重新落位（老位置已经不属于任何屏幕了）。
 * 用户在窗口上随手拖一把**不**更新家：那是临时挪一下，不代表搬家。
 *
 * ⚠️ 也正因为如此，「家的位置」绝不能跟着自动移动落盘 —— 见 main.js 的
 *    moved 处理器：溜达 / 回位期间不保存窗口位置，否则下次启动的"家"
 *    就是她上一轮溜达到的随机点，越跑越偏。 */
let homePos = null;
function setHome(x, y) {
  homePos = { x: Math.round(x), y: Math.round(y) };
}

/* 位置是不是**被她自己**挪过。
 * 只有溜达造成的位移才置位；用户手动拖放不算（那是对位置的明确指定，
 * 不该被"回位"撤销）。置位之后一旦检测到用户操作，就回位并清零。 */
let wanderMoved = false;

/* 溜达 / 回位循环的代际令牌。
 * ⚠️ 要 await 的周期任务一律**自调度 + 代际令牌**，绝不用 setInterval 排下一步
 *    （两次 push 重叠 → 两条 setBounds 打架）。任何"取消"都 ++GEN，
 *    循环里每个 await 前后各查一次，不匹配就自己退出。 */
let GEN = 0;
let mode = 'idle';                 // 'idle' | 'wander' | 'home'

const WALK_SPEED = 190;            // px/s。像在房间里踱步（老版固定 1100ms 走完，
                                   //   跨半屏时快得像瞬移，不像"走"）
const MIN_STEP = 130;              // 一步至少挪这么远，免得在小范围里原地抖
const REST_MIN = 700;              // 两步之间的停顿（她在站着歇脚）
const REST_MAX = 2200;
const ARRIVE_EPS = 3;              // 离家这么近就算到了

/* 最近一次"用户正在拖窗口"的时刻。拖拽期间 + 松手后的宽限期内，
 * 一切自动移动让位 —— 否则她一边被拖一边自己往回走。 */
let lastUserDragAt = 0;
const DRAG_GRACE_MS = 700;

/* 闲置计时器的"武装时刻"。
 * 光看系统闲置时长是不够的：用户刚在托盘里把「闲置时自己溜达」打开时，
 * 系统可能已经闲置了半小时 —— 不设这道门的话她会在下一秒突然开走。
 * 要求「本次武装之后又过了同样久」才允许起步。 */
let armedAt = Date.now();

/* 诊断口子：把系统闲置秒数钉死成一个固定值（null = 用真实读数）。
 *
 * 为什么需要：溜达的**触发**和**保持**都以"系统闲置"为准，而正在测它的人
 * 必然在动鼠标敲键盘 —— 不钉死的话 idleTick 每 1 秒都会把她刚起步的那趟收掉
 * （实测：强制开始溜达之后 mode 立刻被判定回 idle，一步都走不完）。
 * 只有 `PET_WANDER=1` 诊断口子会用，正常运行永远是 null。
 * 用法见 main.js 里 PET_WANDER 那段。 */
let idleOverrideSec = null;
function setIdleOverride(sec) {
  idleOverrideSec = (sec === null || sec === undefined) ? null : Number(sec);
}

/* 系统级「有人在用电脑吗」。
 *
 * powerMonitor.getSystemIdleTime() 直接返回"距上次用户输入过了多少秒"，
 * 用的是 Windows 的 GetLastInputInfo —— 鼠标动一下、键盘敲一下都会归零，
 * **不限于光标在她身上**，正是用户要的语义（"移动鼠标或触发键盘算操作"）。
 * 而且是 Electron 内置的同步调用：零子进程、零轮询开销
 * （对比一下：本机每起一次 powershell.exe 要 500ms，每秒一次纯属烧电）。
 * ⚠️ 必须在 app ready 之后调用，否则抛错 —— 所以外面套了 try。 */
function systemIdleSeconds() {
  if (idleOverrideSec !== null && Number.isFinite(idleOverrideSec)) return idleOverrideSec;
  try { return Number(powerMonitor.getSystemIdleTime()) || 0; }
  catch { return 0; }
}

function walkDuration(dist) {
  return clamp(Math.round((dist / WALK_SPEED) * 1000), 900, 3000);
}

/* 等当前这趟平滑移动跑完。moveAnim 被谁清掉都算"结束"。 */
function waitMoveEnd(gen) {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (gen !== GEN || !moveAnim) { clearInterval(t); resolve(); }
    }, 50);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 走一段路。**成对**发 wander-start / wander-end —— 渲染层收到 start 播
 * Walk（首尾闭合的循环动作），收到 end 收手回 idle。
 *
 * ⚠️ end 必须**无条件**发得出去，哪怕中途被取消。老实现把它挂在 animateTo
 *    之外的一个 1250ms 定时器上，而 animateTo 自己跑完（约 1104ms）会调
 *    cancelMoveAnim() 顺手清掉那个定时器 → end 从来没发出去过。她溜达时人
 *    不动（只挪窗口）所以看不出来，换成 Walk 之后就变成"溜达完一直原地走"。 */
async function walkTo(x, y, ms, gen) {
  const w = win();
  if (!w) return false;
  let sent = false;
  try { w.webContents.send('pet:wander-start'); sent = true; } catch { /* ignore */ }
  animateTo(x, y, ms);
  await waitMoveEnd(gen);
  if (sent) { try { w.webContents.send('pet:wander-end'); } catch { /* ignore */ } }
  return gen === GEN;
}

/* 随机挑一个"值得走一趟"的目标点。屏幕小到转不开身时返回 null（就站着别动）。 */
function pickTarget() {
  const w = win();
  if (!w) return null;
  const { workArea } = currentDisplay();
  const minX = workArea.x + MARGIN;
  const minY = workArea.y + MARGIN;
  const far = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN);
  const b = w.getBounds();

  let best = null;
  let bestD = -1;
  for (let i = 0; i < 8; i++) {
    const x = Math.round(minX + Math.random() * Math.max(0, far.x - minX));
    const y = Math.round(minY + Math.random() * Math.max(0, far.y - minY));
    const d = Math.hypot(x - b.x, y - b.y);
    if (d >= MIN_STEP) return { x, y, ms: walkDuration(d) };
    if (d > bestD) { bestD = d; best = { x, y, ms: walkDuration(d) }; }
  }
  return bestD >= 40 ? best : null;
}

/* 走的循环：一步 → 歇一会儿 → 再一步，直到被取消。
 * 「走走停停」是用户 2026-10-13 选的节奏（另一条路是"一口气游走一段"）。 */
async function wanderLoop(gen) {
  while (gen === GEN && mode === 'wander' && !paused) {
    const w = win();
    if (!w || !w.isVisible()) break;
    const t = pickTarget();
    if (!t) break;
    const ok = await walkTo(t.x, t.y, t.ms, gen);
    if (gen !== GEN) return;
    wanderMoved = true;
    if (!ok) return;
    await sleep(Math.round(REST_MIN + Math.random() * (REST_MAX - REST_MIN)));
    if (gen !== GEN) return;
  }
  if (gen === GEN) mode = 'idle';
}

function startWander() {
  if (paused || mode !== 'idle') return;
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false || cfg.motion?.wander === false) return;
  if (!win()) return;
  GEN++;
  mode = 'wander';
  wanderLoop(GEN);
}

/* 停下溜达（人回来了 / 静默 / 关开关）。正在走的那一趟立刻收手，
 * walkTo 那边会补上 pet:wander-end。 */
function stopWander() {
  if (mode !== 'wander') return;
  GEN++;
  mode = 'idle';
  cancelMoveAnim();
}

async function goHomeLoop(gen) {
  const w = win();
  if (!w || !homePos) { if (gen === GEN) mode = 'idle'; return; }
  const b = w.getBounds();
  const d = Math.hypot(homePos.x - b.x, homePos.y - b.y);
  await walkTo(homePos.x, homePos.y, clamp(Math.round((d / WALK_SPEED) * 1000), 700, 2400), gen);
  if (gen !== GEN) return;
  wanderMoved = false;
  mode = 'idle';
}

/* 走回家。注意顺序：先 stopWander() 把溜达那一趟收掉，再起新的一代 ——
 * 两条路都写窗口位置，必须先掐掉旧的（文件头那条最高原则）。 */
function goHome() {
  if (paused || !homePos) return;
  if (mode === 'home') return;
  stopWander();
  const w = win();
  if (!w) return;
  /* 「她注意到你回来了」—— 老代码在溜达前拿光标位置判过一次（近就不溜达），
   * 改成系统级闲置判定之后那次判断没意义了，但这个小反馈值得留下来：
   * 走的这一趟配上一句惊讶的反应，看起来才像"发现你了、赶紧回去"。 */
  try { w.webContents.send('pet:noticed'); } catch { /* ignore */ }
  GEN++;
  mode = 'home';
  goHomeLoop(GEN);
}

/* 她跑远了、而且你现在回来用电脑了 → 把她收回原位。
 * 已经在家里就只是清掉待回位标志，不会白动一趟。 */
function maybeGoHome() {
  if (!homePos || !wanderMoved) return;
  if (mode === 'home') return;
  if (Date.now() - lastUserDragAt < DRAG_GRACE_MS) return;   // 正抓着 / 刚松手
  const w = win();
  if (!w) return;
  const b = w.getBounds();
  if (Math.abs(b.x - homePos.x) <= ARRIVE_EPS && Math.abs(b.y - homePos.y) <= ARRIVE_EPS) {
    wanderMoved = false;
    return;
  }
  goHome();
}

/* 每秒一次的巡检。
 * ⚠️ 这里用 setInterval 是**安全**的：idleTick 全程同步（没有任何 await），
 *    不存在两次回调重叠的问题。规矩 16 禁的是"要 await 的周期任务"
 *    用 setInterval 排下一步 —— 那种情况在 wanderLoop 里，用的是自调度 + GEN。 */
const IDLE_TICK_MS = 1000;
let idleTimer = null;

function idleTick() {
  if (paused) return;
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false) return;

  const idleSec = systemIdleSeconds();

  /* 「有人操作」= 最近 1 秒内有输入。
   * 用户要的定义就是「移动鼠标或触发键盘」（系统级，不限于光标在她身上）。 */
  if (idleSec < 1) {
    if (mode === 'wander') stopWander();
    if (cfg.motion?.returnOnActivity !== false) maybeGoHome();
    return;
  }

  if (cfg.motion?.wander === false) return;
  if (mode !== 'idle') return;

  const needMs = clamp(Number(cfg.motion?.wanderIdleMin) || 3, 0.2, 120) * 60000;
  if (idleSec * 1000 >= needMs && Date.now() - armedAt >= needMs) startWander();
}

function startIdleWatcher() {
  if (idleTimer) return;
  armedAt = Date.now();
  idleTimer = setInterval(idleTick, IDLE_TICK_MS);
}

/* 配置变了：关掉开关要立刻收手；重新武装闲置计时（见 armedAt 的注释）。 */
function refreshWanderConfig() {
  armedAt = Date.now();
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false || cfg.motion?.wander === false) stopWander();
}

/* ── 用户上手（main.js 在对应的 IPC 里调）─────────────────
 *
 * onUserDragMove：他正拖着窗口。位置由他决定，自动移动立刻让位。
 * onUserDragEnd ：松手。贴边由 main.js 负责，这里只做状态收尾 ——
 *   用户手动拖放 = 对位置的明确指定 → 清掉"待回位"，别把他刚放好的人拽走。
 *   （她之后再溜达跑远了，下一次用户操作照样会把她收回来。） */
function onUserDragMove() {
  lastUserDragAt = Date.now();
  /* 拖拽中：停溜达/回位/飞行，但**保留采样**给松手估速。 */
  GEN++;
  mode = 'idle';
  cancelMoveAnim();
  cancelThrowFlight();
}

function onUserDragEnd() {
  lastUserDragAt = Date.now();
  wanderMoved = false;
  GEN++;
  mode = 'idle';
  cancelMoveAnim();
  cancelThrowFlight();
  /* throwSamples 留给紧跟着的 tryStartThrow */
}

/* ---- 甩抛：拖拽采样 + 松手起飞 ----
 *
 * 主进程在 pet:drag-move 里调 recordDragSample；松手时 tryStartThrow。
 * 飞出期间**不写 window 配置**（规矩 25）—— 停稳后由 onThrowSettled
 * 回调去落盘 + 可选贴边（那是用户甩出去的最终位置，算明确指定）。
 * 静默 / 再拖 / 销毁都会 cancelThrow。 */

function recordDragSample() {
  const w = win();
  if (!w) return;
  const b = w.getBounds();
  const now = Date.now();
  throwSamples.push({ t: now, x: b.x, y: b.y });
  /* 只留最近 ~120ms，估速够用又省内存 */
  while (throwSamples.length > 1 && now - throwSamples[0].t > 120) {
    throwSamples.shift();
  }
}

/**
 * @returns {boolean} 是否真的起飞了（没起飞时调用方应走原来的 edgeSnap）
 */
function tryStartThrow() {
  const w = win();
  if (!w || paused) { throwSamples = []; return false; }
  const cfg = loadConfig();
  if (cfg.motion?.enabled === false || cfg.interaction?.throw !== true) {
    throwSamples = [];
    return false;
  }

  const { vx, vy, speed } = estimateVelocity(throwSamples);
  throwSamples = [];
  if (!shouldThrow(speed, true)) return false;

  cancelMoveAnim();
  cancelThrow();

  const bounce = cfg.interaction?.bounce !== false;
  const wa = currentDisplay().workArea;
  let state = {
    x: w.getBounds().x,
    y: w.getBounds().y,
    vx, vy,
    w: SIZE.w,
    h: SIZE.h
  };
  let lastT = Date.now();
  let settledOnce = false;

  throwAnim = setInterval(() => {
    const cur = win();
    if (!cur || paused) {
      cancelThrow();
      return;
    }
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    const next = throwStep(state, wa, dt, { bounce });
    state = { ...state, x: next.x, y: next.y, vx: next.vx, vy: next.vy };
    try {
      cur.setBounds({ x: next.x, y: next.y, width: SIZE.w, height: SIZE.h });
    } catch {
      cancelThrow();
      return;
    }
    if (next.squash > 0.05) {
      try { onThrowSquash(next.squash); } catch { /* ignore */ }
    }
    if (next.stopped && !settledOnce) {
      settledOnce = true;
      cancelThrow();
      try { onThrowSettled(); } catch { /* ignore */ }
    }
  }, 16);

  return true;
}

/* 渲染层发来的"人还在"信号（点她 / 划过窗口 / 打字）。
 * 系统级闲置检测 1 秒才巡检一次，这条路能让她**立刻**反应，不用等下一拍。 */
function notifyUserActivity() {
  if (paused) return;
  if (mode === 'wander') stopWander();
  const cfg = loadConfig();
  if (cfg.motion?.returnOnActivity !== false) maybeGoHome();
}

function disposeMotion() {
  cancelAutoMotion();
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}

module.exports = {
  configureMotion,
  configureThrowHooks,
  cancelMoveAnim,
  cancelThrow,
  cancelAutoMotion,
  isMoveAnimRunning,
  isThrowRunning,
  setMotionPaused,
  isMotionPaused,
  animateTo,
  edgeSnap,
  setHome,
  startIdleWatcher,
  refreshWanderConfig,
  onUserDragMove,
  onUserDragEnd,
  recordDragSample,
  tryStartThrow,
  notifyUserActivity,
  startWander,
  stopWander,
  setIdleOverride,
  /* 诊断用：看当前在干嘛 / 家在哪儿 / 待不待回位 */
  wanderState: () => ({ mode, wanderMoved, homePos, gen: GEN, armed: armedAt, idleOverrideSec }),
  currentDisplay,
  disposeMotion
};
