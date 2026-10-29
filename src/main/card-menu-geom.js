'use strict';

/* 光标处卡片菜单的**纯几何与命中判定**。
 *
 * 为什么单独成文件：card-menu.js 一被 require 就要碰 ipcMain（node 下是 undefined），
 * 而这里的排布/贴边/子菜单摆位是唯一值得断言的东西。抽出来之后
 * debug/verify-card-menu.js 能 require **真函数**来测，不是复刻一份公式
 * （复刻出来的断言永远绿）。—— 与 wheel-geom.js / bubble-menu-geom.js 同一动机。
 *
 * 规矩 9：几何只有这一处定义，页面只接收算好的结果来画。
 *
 * 形态依据（这一版是"原生菜单形状 + 自绘皮"，不是自由发挥）：
 *   - VS Code / Discord / Figma / Slack 的右键菜单全部自绘，但**都保留
 *     "光标处弹出的垂直列表"这个形态** —— 好看与可预测兼得的唯一已知组合。
 *   - Apple HIG（Contextual menus）：菜单左上角对齐光标右下、贴边翻转、
 *     ≤3 组用分隔线、最多一级子菜单、常用项离光标最近、破坏性项放最后。
 *   - @murphts/contexto 原话「Replaces Electron's native OS context menu with a
 *     frameless Chromium overlay」→ 方向被验证过（只借思路，不装包）。
 * ⚠️ 反过来也要记着：MIT 6.831 说 pie menu 快 15~20%，但"效率优势不足以抵消
 *    线性菜单的外部一致性与布局简单性"—— 这正是轮盘退场的原因。 */

/* ---- 尺寸常量（改任何一个都跑 verify-card-menu）---- */
const ITEM_H = 30;        // 行高
const SEP_H = 9;          // 分隔线的占位高（不是线宽）
const PAD_Y = 6;          // 卡片上下内边距
const PAD_X = 12;         // 左右内边距（= 行 margin 4 + 行 padding 8，见 html）
const ICON_W = 22;        // 图标列宽（含与文字的间距）
const CHEV_W = 18;        // 子菜单箭头占位（箭头 12 + 间距 6）
const VALUE_GAP = 10;     // 主标签与右侧当前值之间的最小间距
const MIN_W = 176;        // 卡片最小宽（太窄不像菜单，像标签）
const MAX_W = 272;        // 最大宽；超出的标签走省略号，不许把卡片撑到半屏
const CARD_GAP = 6;       // 卡片与子菜单卡片之间的缝
const SHADOW_PAD = 16;    // 窗外留白：两层柔投影要有地方扩散
const CURSOR_DX = 2;      // 卡片左上角相对光标的偏移（HIG：光标右下）
const CURSOR_DY = 4;      // 纵向多给 2px —— 光标本身有高度，压住它像"没弹出来"
const EDGE_PAD = 6;       // 贴屏幕边时留的呼吸（不是 SHADOW_PAD：阴影可以出屏）
const FONT_PX = 13;       // 主标签字号（与 html 里 .lb 一致）

/* 单字宽估算。
 * ⚠️ 主进程拿不到 DOM，只能估；标点/窄字母按经验系数，CJK 按全角算。
 *    debug/shot-card-menu.js 会用**真实 DOM** 反查一遍（逐行 scrollWidth ≤
 *    clientWidth），估错会在真机上红，不会静默把字挤掉。 */
function charW(ch, px) {
  const c = ch.codePointAt(0);
  if (c === 0x20) return px * 0.28;
  if (c >= 0x2e80) return px;                    // CJK / 全角标点 / 假名
  if (c >= 0x30 && c <= 0x39) return px * 0.56;  // 数字
  if (c >= 0x41 && c <= 0x5a) return px * 0.66;  // 大写
  if ('iljI.,:;!|\''.includes(ch)) return px * 0.30;
  return px * 0.53;
}

function textW(s, px) {
  const t = String(s == null ? '' : s);
  let w = 0;
  for (const ch of t) w += charW(ch, px || FONT_PX);
  return w;
}

const isSep = (it) => !!(it && it.sep);

/* 一张卡片：宽、高、每个槽位（行 / 分隔线）的 y 与高。
 * rows 只含真实项，i 是它在 items 里的下标（分隔线占下标但不进 rows）。 */
function card(items) {
  const list = Array.isArray(items) ? items : [];
  const anyIcon = list.some((it) => it && it.icon);
  const iconCol = anyIcon ? ICON_W : 0;

  let w = MIN_W;
  for (const it of list) {
    if (isSep(it)) continue;
    let need = PAD_X * 2 + iconCol + textW(it.label);
    if (it.sub) need += VALUE_GAP + textW(it.sub, 12);
    if (Array.isArray(it.kids) && it.kids.length) need += CHEV_W;
    w = Math.max(w, need);
  }
  w = Math.min(MAX_W, Math.round(w));

  const slots = [];
  const rows = [];
  let y = PAD_Y;
  list.forEach((it, i) => {
    if (isSep(it)) {
      slots.push({ sep: true, y, h: SEP_H });
      y += SEP_H;
      return;
    }
    slots.push({ sep: false, i, y, h: ITEM_H });
    rows.push({ i, y, h: ITEM_H });
    y += ITEM_H;
  });
  return { w, h: y + PAD_Y, slots, rows, iconCol };
}

/* 卡片摆位：左上角贴光标右下，贴边就翻到另一侧。
 * ⚠️ 翻转**先试左/上**，再 clamp —— 只 clamp 不翻转的话，贴着屏底的卡片会
 *    整个人往上跳一截，看起来像"没跟着鼠标"。
 * ⚠️ anchor 用**按下时的光标**，不是实时光标：否则卡片会追着鼠标跑。 */
function place(anchor, size, wa) {
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  let x = anchor.x + CURSOR_DX;
  let y = anchor.y + CURSOR_DY;
  if (x + size.w > right - EDGE_PAD) x = anchor.x - size.w - CURSOR_DX;
  if (y + size.h > bottom - EDGE_PAD) y = anchor.y - size.h - CURSOR_DY;
  const fit = (v, min, max) => (max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
  x = fit(x, wa.x + EDGE_PAD, right - size.w - EDGE_PAD);
  y = fit(y, wa.y + EDGE_PAD, bottom - size.h - EDGE_PAD);
  return { x: Math.round(x), y: Math.round(y) };
}

/* 子菜单摆位：贴父卡片右侧；右边放不开就翻到左侧。
 * 纵向**对齐父项那一行的上沿**（原生菜单的手感），再按可用区收一下。 */
function placeSub(parent, parentSize, rowY, subSize, wa) {
  const right = wa.x + wa.width;
  const bottom = wa.y + wa.height;
  let x = parent.x + parentSize.w + CARD_GAP;
  if (x + subSize.w > right - EDGE_PAD) x = parent.x - subSize.w - CARD_GAP;
  let y = parent.y + rowY - PAD_Y;
  const fit = (v, min, max) => (max < min ? (min + max) / 2 : Math.min(max, Math.max(min, v)));
  x = fit(x, wa.x + EDGE_PAD, right - subSize.w - EDGE_PAD);
  y = fit(y, wa.y + EDGE_PAD, bottom - subSize.h - EDGE_PAD);
  return { x: Math.round(x), y: Math.round(y) };
}

/* 窗口 bounds = 所有卡片的外接框 + 阴影留白。
 * ⚠️ 窗口必须**贴着内容**：透明窗的空白区会照吃鼠标（不做逐像素命中），
 *    留一大块空白会把用户点别的应用的点击吞掉。所以子菜单一开一关就改一次
 *    bounds，而不是一开始就按"卡片 + 子菜单"预留。 */
function boundsOf(rects) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  return {
    x: Math.round(x0 - SHADOW_PAD),
    y: Math.round(y0 - SHADOW_PAD),
    width: Math.round(x1 - x0 + SHADOW_PAD * 2),
    height: Math.round(y1 - y0 + SHADOW_PAD * 2)
  };
}

const inRect = (r, x, y) => !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/* 卡片内命中：返回项在 items 里的下标，落空返回 -1。
 * ⚠️ 分隔线的槽位不参与命中 —— 但**它占的位置仍算"在卡片里"**（不然鼠标划过
 *    分隔线会闪一下"没有高亮"）。所以先判 y 落在哪个槽，再判是不是分隔线。 */
function hitAt(lay, x, y) {
  if (!lay || x < 0 || y < 0 || x > lay.w || y > lay.h) return -1;
  for (const s of lay.slots) {
    if (y >= s.y && y < s.y + s.h) return s.sep ? -1 : s.i;
  }
  return -1;
}

/* 桥接区：卡片右沿 → 子菜单左沿之间那条缝。
 * 为什么要它：两点之间直线走会经过缝，缝上松开就等于"划出菜单 = 取消"，
 * 手一抖就把选择丢了。所以缝里保留**父项**的高亮，不取消、也不切换。 */
function inBridge(cardRect, cardSize, subRect, x, y) {
  if (!subRect) return false;
  const x0 = Math.min(cardRect.x + cardSize.w, subRect.x) - CARD_GAP;
  const x1 = Math.max(cardRect.x, subRect.x);
  const y0 = Math.min(cardRect.y, subRect.y) - CARD_GAP;
  const y1 = Math.max(cardRect.y + cardSize.h, subRect.y + subRect.h) + CARD_GAP;
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

module.exports = {
  ITEM_H, SEP_H, PAD_Y, PAD_X, ICON_W, CHEV_W, VALUE_GAP,
  MIN_W, MAX_W, CARD_GAP, SHADOW_PAD, CURSOR_DX, CURSOR_DY, EDGE_PAD, FONT_PX,
  textW, card, place, placeSub, boundsOf, inRect, hitAt, inBridge, isSep
};
