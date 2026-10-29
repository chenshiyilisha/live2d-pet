'use strict';

/* 头顶泡泡菜单的**纯几何与命中判定**。
 *
 * 🔴 单独成文件的理由同 wheel-geom.js：这是泡泡菜单唯一值得断言的东西，而
 *    bubble-menu.js 一被 require 就要碰 ipcMain（node 下是 undefined）。抽出来
 *    之后 debug/verify-bubble-menu.js 能直接 require **真函数**来测，不是把公式
 *    复刻一份（复刻出来的断言永远绿，那是骗自己）。
 *
 * 规矩 9：几何只有这一处定义，页面只接收结果来画。 */

const DEG = Math.PI / 180;

/* 泡泡半径分档。
 * ⚠️ 下限不是审美：Material 的 mini FAB 是 40×40dp，FAB menu 也要求"large
 *    item size"。泡泡是**离散圆点**，不像扇区那样"宽度随半径变大"（Callahan
 *    那 15~20% 的优势里有一半来自这个），所以尺寸只能靠自己给足。
 *    8 个（表情）才降到 23 —— 再小就守不住 40px 直径了。 */
function radiusFor(n) {
  if (n <= 5) return 30;
  if (n === 6) return 27;
  return 22;
}

const GAP = 8;            // 相邻泡泡之间的**视觉**缝；命中区比它大，见 HIT_PAD
const STEP = 36 * DEG;    // 每个泡泡之间 36°，再按上下限收一次
const SPAN_MIN = 120 * DEG;
const SPAN_MAX = 170 * DEG;
const SQUASH = 0.75;      // 竖向压扁（见 layout 注释）
const R_MIN = 110;        // 弧半径下限：再近就要压到她脸上了
const HIT_PAD = 4;        // 命中区比视觉半径大 4px（离散小圆，不像扇区连成片）
const PAD = 14;           // 窗外留白：两层柔投影要有地方扩散

/* 弧形排布。
 *
 * 为什么不排成**一行**：Fitts 定律说指向时间随距离增长 —— 一行的话第 5 个泡泡
 * 的距离是第 1 个的好几倍（MIT 6.831 讲线性菜单的劣势正是这个）。弧形让每个
 * 泡泡到锚点的距离**近似相等**，这是 pie menu 那份优势里我们能保住的一半。
 *
 * ⚠️ 为什么竖向要压扁 0.75：不压的话 5 个泡泡那个弧会绕到她脸两侧甚至下巴
 *    高度，看着像"围一圈"而不是"浮在头顶"。压扁之后距离落在 0.75R~R 之间
 *    —— 不再严格相等，但仍然远好于一行排开（末端 2 倍以上）。这条是取舍，
 *    不是公式，写在这里免得以后被当成"算错了"改回去。 */
function layout(n, anchor) {
  const r = radiusFor(n);
  const count = Math.max(1, n | 0);
  const span = count > 1 ? Math.min(SPAN_MAX, Math.max(SPAN_MIN, (count - 1) * STEP)) : 0;
  const step = count > 1 ? span / (count - 1) : 0;
  const a0 = -90 * DEG - span / 2;      // 从正上方往两边摊开
  const ang = [];
  for (let i = 0; i < count; i++) ang.push(count > 1 ? a0 + i * step : -90 * DEG);

  /* 🔴 反解 R 必须在**压扁之后**的空间里量，不能拿未压扁的弦长 2R·sin(step/2)
   *    直接除（第一版就是这么写的，5 项时相邻泡泡实测只差 60.1px，而直径就是
   *    60 —— 正好贴边重叠）。
   *    好在位置对 R 是**线性**的（y 已经乘了 SQUASH 这个常数），所以：
   *    先在 R=1 的单位弧上量出最小间距 dmin，再 R = need / dmin。
   * ⚠️ 这就是"项数一变半径就重算"的原因：照抄一个常数会在 9 项时叠在一起。 */
  const unit = ang.map((a) => ({ x: Math.cos(a), y: Math.sin(a) * SQUASH }));
  let dmin = Infinity;
  for (let i = 0; i < unit.length; i++) {
    for (let j = i + 1; j < unit.length; j++) {
      dmin = Math.min(dmin, Math.hypot(unit[i].x - unit[j].x, unit[i].y - unit[j].y));
    }
  }
  const need = 2 * r + GAP;
  const R = Math.max(R_MIN, dmin > 0 && isFinite(dmin) ? need / dmin : R_MIN);

  const pts = ang.map((a) => ({
    x: Math.round(anchor.x + Math.cos(a) * R),
    y: Math.round(anchor.y + Math.sin(a) * R * SQUASH),
    r
  }));
  return { r, R, span, step, pts, box: boxOf(pts, r) };
}

function boxOf(pts, r) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x - r);
    y0 = Math.min(y0, p.y - r);
    x1 = Math.max(x1, p.x + r);
    y1 = Math.max(y1, p.y + r);
  }
  if (!pts.length) { x0 = y0 = x1 = y1 = 0; }
  return {
    x: Math.round(x0 - PAD),
    y: Math.round(y0 - PAD),
    width: Math.round(x1 - x0 + PAD * 2),
    height: Math.round(y1 - y0 + PAD * 2)
  };
}

/* 贴边收拢：她站在屏幕边上时，整排泡泡往屏内挪（不许有一半在屏外）。
 * ⚠️ 挪的是**锚点**再重排 —— 平移单个泡泡会破坏弧形，肌肉记忆就废了。
 * ⚠️ 可用区比整排还小的时候（极端小屏）退回到可用区中心，别算出反转区间。 */
function layoutClamped(n, anchor, wa) {
  let a = { x: anchor.x, y: anchor.y };
  let lay = layout(n, a);
  const fit = (v, min, max) => (max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
  const b = lay.box;
  const dx = b.x < wa.x ? wa.x - b.x
    : (b.x + b.width > wa.x + wa.width ? (wa.x + wa.width) - (b.x + b.width) : 0);
  const dy = b.y < wa.y ? wa.y - b.y
    : (b.y + b.height > wa.y + wa.height ? (wa.y + wa.height) - (b.y + b.height) : 0);
  if (dx || dy) {
    a = { x: fit(a.x + dx, wa.x, wa.x + wa.width), y: fit(a.y + dy, wa.y, wa.y + wa.height) };
    lay = layout(n, a);
  }
  return { anchor: a, lay };
}

/* 命中判定：离散圆，取**最近的**那一个（不重叠时等价于"在圆内"）。
 * ⚠️ 命中区 = r + HIT_PAD：泡泡之间有 8px 的视觉缝，缝上松手不该算没选中
 *    （muriel 规范那条「keep visual gaps smaller than hit gaps」的同款理由）。 */
function hitAt(pts, x, y) {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(x - pts[i].x, y - pts[i].y);
    if (d < bd) { bd = d; best = i; }
  }
  return (best >= 0 && bd <= pts[best].r + HIT_PAD) ? best : -1;
}

module.exports = {
  DEG, GAP, STEP, SPAN_MIN, SPAN_MAX, SQUASH, R_MIN, HIT_PAD, PAD,
  radiusFor, layout, layoutClamped, hitAt
};
