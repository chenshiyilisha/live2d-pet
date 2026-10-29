'use strict';

/* 轮盘的**纯几何与命中判定**。
 *
 * 🔴 单独成文件的理由：这些是轮盘唯一值得断言的东西，而 wheel.js 一被 require
 *    就要碰 ipcMain（node 下是 undefined，断言根本跑不起来）。纯函数不该依赖
 *    Electron —— 抽出来之后 debug/verify-wheel.js 能直接 require 真函数来测，
 *    而不是把公式复刻一份（复刻出来的断言永远绿，那是骗自己）。
 *
 * 规矩 9：几何只有**这一处**定义，wheel.html 只接收结果来画。 */

const TAU = Math.PI * 2;
/* 起始 -90°：第一项的扇区从正上方开始。
 * 依据 Don Hopkins 引的研究结论 —— "on-axis items are easier to select than
 * off-axis items, so it's good to put commonly used items to the North, South,
 * East, and West"。6 项时中心落在 -60/0/60/120/180/240，正右与正左各占一个中心。 */
const START = -Math.PI / 2;
const GAP = 0.035;          // 扇区之间的**视觉**缝（弧度）；命中区比它大，见 hitAt

function computeGeom(maxKids) {
  /* 内环厚 32、外环厚 44、中心死区 = innerIn - 2。
   * ⚠️ 由**全局最大子项数**算一次定死，不随高亮项变 —— muriel 规范原话
   *    「Wedge boundaries do not move on hover」：目标一动，肌肉记忆就废了。
   *    子项多时内径要外扩，否则最窄处（内缘弧长 2πr/n）不够点。 */
  const innerIn = maxKids >= 6 ? 30 : 26;
  const innerOut = innerIn + 32;
  const outerIn = innerOut + 4;
  const outerOut = outerIn + 44;
  return { innerIn, innerOut, outerIn, outerOut, dead: innerIn - 2, R: outerOut + 12 };
}

function maxKidsOf(list) {
  let m = 0;
  for (const it of list) if (Array.isArray(it.kids)) m = Math.max(m, it.kids.length);
  return m;
}

/* ⚠️ 命中区用**完整均分**扇区，不含那条视觉缝：规范说「keep visual gaps
 *    smaller than hit gaps」—— 缝只是画出来的，缝上松手不该算"没选中"。 */
function hitAt(g, list, dx, dy, lastOuter) {
  const miss = { outer: -1, inner: -1 };
  if (!g || !list.length) return miss;
  const r = Math.hypot(dx, dy);
  if (r < g.dead) return miss;                 // 中心死区 = 取消
  let a = Math.atan2(dy, dx) - START;
  a = ((a % TAU) + TAU) % TAU;
  const nOut = list.length;
  const oi = Math.floor(a / (TAU / nOut)) % nOut;

  if (r >= g.outerIn && r <= g.outerOut) return { outer: oi, inner: -1 };
  if (r >= g.innerIn && r <= g.innerOut) {
    /* 🔴 父级锁定（lastOuter）。真机实测才撞出来的坑：内环子项是**整圈**均分的
     *    （表情 8 个子项各 45°），而外环 6 个组各 60° —— 子项 3 的中心角 22.5°
     *    早跑进"动作组"的角度范围了。不锁父级的话，鼠标一划到那个方向父级就
     *    变了、内环画的内容跟着变，**第 2 个以后的子项永远选不到**。
     *    锁住之后：划到某组 → 内环展开它的子项（整圈都可读）→ 往圆心方向划，
     *    按方向挑子项，父级不动。正是 marking menu 的"两级笔画"手势。 */
    const o = (lastOuter != null && lastOuter >= 0 && lastOuter < nOut) ? lastOuter : oi;
    const ks = (list[o] && Array.isArray(list[o].kids)) ? list[o].kids : [];
    if (!ks.length) return miss;               // 叶子项：中心那一圈是空白
    return { outer: o, inner: Math.floor(a / (TAU / ks.length)) % ks.length };
  }
  return miss;
}

/* 盘心往屏幕内收，保证整个盘可见（贴屏幕角时不会有一半在屏外）。
 * ⚠️ 屏幕比盘还小的时候退回到可用区中心，别算出个反转的区间。 */
function clampCenter(cx, cy, R, wa) {
  const lo = (v, min, max) => (max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
  return {
    x: Math.round(lo(cx, wa.x + R, wa.x + wa.width - R)),
    y: Math.round(lo(cy, wa.y + R, wa.y + wa.height - R))
  };
}

module.exports = { TAU, START, GAP, computeGeom, maxKidsOf, hitAt, clampCenter };
