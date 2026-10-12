'use strict';
/* 窗口宽度「固定为对话框那一档」的验收脚本。
 *
 * 演变史：宽度原先由比例定死（高 × 8/9）→ 人物站右边、左边空 135px；
 * 2026-10-12 上午改成「内容决定宽度」（常驻窄、对话宽）→ 点一下输入条窗口
 * 就伸缩一次、人物跟着挪；当晚用户定稿："可以根据对话框固定位置大小，
 * 不需要点击后再调整" → **恒 ≥ 对话框那一档（TALK_W）**，宽度只在换模型 /
 * 改缩放 / 开关底座时可能变，对话开关不动窗口分毫。
 *
 * 这条链路上有几件事**在界面上看不出来**，只能量：
 *
 *   1) 主进程到底怎么采纳渲染层报的宽度（含夹取、非法值、以及"报过之后粘住"）；
 *   2) 宽度必须装得下底座牌（148px）—— 装不下就是把牌裁掉；
 *   3) 宽度必须给够气泡 / 输入条要的宽度 —— 给不够就是把聊天框挤窄；
 *   4) ⚠️ 关键：宽度算式**不得依赖对话态** —— 算式里再出现 talking /
 *      bubble / composer 就是把"点击后调整"加了回来；
 *   5) 平时宽度必须**正好**等于 TALK_W（不多不少）：多了又回到"左边白占一片"。
 *
 * ⚠️ pet.js 里的常量与算式是**从源码里切出来的**，不是手抄的：手抄副本一脱节，
 *    这里量出来的宽度就是假的（同 tray-dump.js 切 LIMITS 的做法）。
 *
 * 用法：node debug/verify-win-size.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

/* ============================================================
 *  1. 在 vm 沙箱里加载主进程的 win-size.js
 *
 *  `screen` 只在 app ready 之后可用，纯 node 里 require('electron') 会直接炸。
 *  桩掉它、并且把 workArea 做成**可变**的，才能验"换显示器 / 改缩放"那条路。
 * ========================================================== */
function loadWinSize(work) {
  const src = read('src/main/win-size.js');
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    require: (name) => {
      if (name === 'electron') {
        return {
          screen: {
            getPrimaryDisplay: () => ({
              workArea: { x: 0, y: 0, width: work.width, height: work.height }
            })
          }
        };
      }
      throw new Error('win-size.js 不该 require「' + name + '」');
    },
    process: { env: {} },   // PET_WIN_H 之类的口子这里一律不生效
    console
  };
  vm.createContext(sandbox);
  new vm.Script(src, { filename: 'win-size.js' }).runInContext(sandbox);
  return mod.exports;
}

console.log('══════ 1. 主进程：宽度怎么采纳 ══════\n');

/* 本机实测：主屏 2560×1440 @150% → 逻辑可用区 1707×912 */
const work = { width: 1707, height: 912 };
const ws = loadWinSize(work);

/* ⚠️ 先 refresh 一次 —— SIZE 的初值是写死的 360，只有 refreshWinSize()
 *    才会按当前屏算。不调它，下面比的其实是「初值 vs 期望值」。
 *    （真实流程里 createWindow 第一件事就是调它。） */
ws.refreshWinSize();

const expectH = Math.round(work.height * 0.375);
check(ws.SIZE.h === expectH, `首帧高度 = 可用高 × 0.375 = ${expectH}（本机 912 → 342）`);
check(ws.SIZE.w === 320, `渲染层还没报数时用首帧占位宽（${ws.SIZE.w}）`);

/* 报一个真实值（对话框那一档的宽度） */
const idle = 308;
check(ws.applyStageWidth(idle) === idle && ws.SIZE.w === idle,
  `采纳渲染层报的宽度（${idle}）`);
check(ws.SIZE.h === expectH, '只改宽度，高度不动');

/* 夹取：算错了也不能真按离谱的值开窗 */
check(ws.applyStageWidth(999999) === 1200, '离谱的大值夹到上限 1200');
check(ws.applyStageWidth(1) === 120, '离谱的小值夹到下限 120');

/* 非法值一律不采纳 —— 这里最怕的是 0 / NaN 被当成"要收成 0 宽" */
const keep = ws.SIZE.w;
let bad = 0;
for (const v of [0, -5, NaN, Infinity, undefined, null, 'abc', {}]) {
  if (ws.applyStageWidth(v) !== 0) bad++;                 // 返回 0 = 没采纳
  if (ws.SIZE.w !== keep) bad++;
}
check(bad === 0, '非法值（0 / NaN / 负 / 非数）一律不采纳，宽度保持原样');

/* 换显示器：高度重算了，但**已经报过的宽度要粘住** ——
 * 掉回占位宽会让人物在换屏的一瞬间横移一大截（虽然马上会被重报纠正，
 * 但那一帧是看得见的）。 */
ws.applyStageWidth(idle);
work.height = 1440;                       // 换到 4K
const resized = ws.refreshWinSize();
check(resized === true, '换屏后高度重算了');
check(ws.SIZE.h === 540, `新的高度 = 1440 × 0.375 = ${ws.SIZE.h}`);
check(ws.SIZE.w === idle, '⚠️ 关键：换屏只改高度，渲染层报过的宽度粘住、不退回占位值');

/* ============================================================
 *  2. 渲染层：宽度算式（从 pet.js 源码里切，不手抄）
 * ========================================================== */
const PET_SRC = read('src/renderer/pet.js');

const numConst = (name) => {
  const m = new RegExp('^const ' + name + ' = (-?[0-9.]+);', 'm').exec(PET_SRC);
  if (!m) throw new Error('pet.js 里找不到「const ' + name + ' = <数字>;」（改名了？本脚本要跟着改）');
  return Number(m[1]);
};
const exprConst = (name, scope) => {
  const m = new RegExp('^const ' + name + ' = ([^;]+);', 'm').exec(PET_SRC);
  if (!m) throw new Error('pet.js 里找不到「const ' + name + ' = <表达式>;」（改名了？本脚本要跟着改）');
  const keys = Object.keys(scope);
  return new Function(...keys, 'return (' + m[1] + ');')(...keys.map((k) => scope[k]));
};

const PLATE_HALF = numConst('PLATE_HALF');
const CONTENT_PAD = numConst('CONTENT_PAD');
const TALK_W = exprConst('TALK_W', {
  BUBBLE_W: numConst('BUBBLE_W'),
  UI_PAD: numConst('UI_PAD')
});

/* syncStageWidth 里那两行算式也切出来 —— 这样改了 pet.js 的算法，
 * 这里量到的就是改后的算法，而不是一份会骗人的副本。 */
const pick = (re, what) => {
  const m = re.exec(PET_SRC);
  if (!m) throw new Error('pet.js 里找不到 ' + what + '（改过写法？本脚本要跟着改）');
  return m[1];
};
const CONTENT_W_EXPR = pick(/const contentW = ([^;]+);/, 'syncStageWidth 里的 contentW');
const WANT_EXPR = pick(/const want = Math\.round\(([^;]+)\);/, 'syncStageWidth 里的 want');

/* 给定"人物墨水宽"，算出渲染层会上报的窗口宽 */
function expectWidth(inkW) {
  const contentW = new Function('petRect', 'PLATE_HALF', 'CONTENT_PAD',
    'return (' + CONTENT_W_EXPR + ');')({ w: inkW }, PLATE_HALF, CONTENT_PAD);
  return Math.round(new Function('contentW', 'TALK_W',
    'return (' + WANT_EXPR + ');')(contentW, TALK_W));
}

console.log('\n══════ 2. 渲染层：宽度算式与几条硬性不变量 ══════\n');

const plateW = PLATE_HALF * 2;
/* 内容放得下气泡的临界墨水宽：再宽下去窗口才需要比对气泡那一档更宽。 */
const growFrom = TALK_W - CONTENT_PAD * 2;

console.log(`  切出来的常量：底座牌 ${plateW}px · 内容两侧留白 ${CONTENT_PAD}px · ` +
            `对话框那一档宽 ${TALK_W}px\n`);

/* 墨水宽取一串值扫过去：不变量该对**任何**墨水宽都成立，而不是只对本机那一档。
 * 本机实测（?snap=bar）是 150px。 */
const INK_SAMPLES = [80, 120, 148, 150, 180, 260, 400];

let fitFail = 0, dialogFail = 0, exactFail = 0, growFail = 0;
const rows = [];
for (const ink of INK_SAMPLES) {
  const w = expectWidth(ink);
  rows.push([ink, w, w - TALK_W]);
  if (w < plateW + CONTENT_PAD * 2) fitFail++;          // 底座牌会被裁
  if (w < TALK_W) dialogFail++;                         // 聊天框会被挤窄
  if (ink < growFrom && w !== TALK_W) exactFail++;      // 平时该正好是 TALK_W
  if (ink >= growFrom && w !== ink + CONTENT_PAD * 2) growFail++;  // 放不下才变宽
}

/* ⚠️ 关键（源码级断言）：宽度算式不得依赖对话态 ——
 * 「点开输入条窗口不伸缩」是这套固定宽度的全部意义，
 * 算式里再出现 talking / bubble / composer 就是把"点击后调整"加了回来。 */
const talkCoupled = /talking|bubble|composer/i.test(CONTENT_W_EXPR + ' ' + WANT_EXPR);

console.log('  人物墨水宽 →  窗口宽（相对对话框档位的差）');
for (const [ink, w, d] of rows) {
  console.log(`    ${String(ink).padStart(3)} →  ${String(w).padStart(4)}   （${d >= 0 ? '+' : ''}${d}px）`);
}
console.log('');

check(fitFail === 0, `宽度恒 ≥ 底座牌 ${plateW} + 两侧 ${CONTENT_PAD}（牌不会被窗口裁掉）`);
check(dialogFail === 0, `宽度恒 ≥ ${TALK_W}（气泡 / 输入条不会被挤窄）`);
check(exactFail === 0,
  `墨水宽 < ${growFrom} 时宽度恒**正好** = ${TALK_W}（不多不少，多了又是"左边白占一片"）`);
check(growFail === 0,
  `墨水宽 ≥ ${growFrom}（大模型 / 大缩放）时宽度 = 墨水宽 + 两侧留白（放不下才变宽）`);
check(!talkCoupled,
  '⚠️ 关键：宽度算式不依赖对话态 —— 点开 / 收起输入条窗口一个像素都不动');
/* 人物恒居中是 layout() 的事（要跑起来才量得到，见 ?snap=ui 实拍），
 * 这里能拦的是右靠机制的回流：CSS 变量与常量都不该再出现。 */
check(!/content-shift|contentShift|CONTENT_RIGHT_PAD/.test(PET_SRC) &&
      !/content-shift/.test(read('src/renderer/style.css')),
  '⚠️ 关键：已移除的「内容右靠」机制没有回流（--content-shift / CONTENT_RIGHT_PAD）');

console.log('\n════════════════════════════════════════');
if (failures) {
  console.log('❌ ' + failures + ' 项未通过');
  process.exit(1);
}
console.log('✅ 全部通过');
process.exit(0);
