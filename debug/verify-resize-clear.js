'use strict';

/* ============================================================
 *  「屏幕上一大一小两个她」的防回流断言（源码级，不起 Electron）
 * ==========================================================
 *
 *  背景（2026-10-28，未解 bug 终于定位）：
 *    用户报「底座出现时出现一大一小两个她，底座消失大模型也消失」。
 *    链路：底座出现 → --stats-h 0→N → #stage 变矮 → layout() → canvas resize
 *          → 人物整体缩放变化。
 *    因为 canvas 开着 preserveDrawingBuffer（命中测试要 readPixels），
 *    **尺寸变化时浏览器可能保留旧帧并按新尺寸拉伸** → 屏幕上出现两个不同
 *    大小的人物，且只有一个底座（与用户观察一致）。
 *    这种残留**截图抓不到**，所以只能靠"每次 resize 后立刻清屏 + 补画一帧"
 *    来杜绝，这条断言守的就是这个动作别被人改掉。
 *
 *  跑法：node debug/verify-resize-clear.js
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('[A] layout() 的 resize 分支');
{
  const s = stripComments(read('renderer/pet.js'));
  const layoutFn = (s.match(/function layout\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  ok(layoutFn !== '', '找得到 layout()');

  /* 尺寸真变了才重画 —— 每次 layout() 都重画会白白多一帧（layout 被高频调用）。 */
  ok(/let resized = false;/.test(layoutFn) &&
     /app\.renderer\.resize\(vw, vh\);[\s\S]{0,80}resized = true;/.test(layoutFn),
    '只有**真的 resize 了**才置位（不是每次 layout 都重画）');

  /* 🔴 核心：清屏 + 立刻补画一帧。 */
  ok(/if \(resized\) \{[\s\S]{0,200}app\.renderer\.clear\(\)/.test(layoutFn),
    'resize 后**先清屏**（否则旧帧残留 → 一大一小两个她）');
  ok(/app\.renderer\.render\(\{ container: app\.stage, clear: true \}\)/.test(layoutFn),
    '清完**立刻补画一帧**（只 clear 不够：全屏静默 1fps 时会挂一秒空白）');

  /* 顺序：必须在几何更新之后（清完不能画在旧位置上）。 */
  const iResize = layoutFn.indexOf('app.renderer.resize(vw, vh)');
  const iScale = layoutFn.indexOf('layoutBaseScale = s;');
  const iClear = layoutFn.indexOf('app.renderer.clear()');
  ok(iResize < iScale && iScale < iClear,
    '顺序：resize → 更新 scale/平移 → 才清屏补画（补画的是**新几何**）');

  /* 别把 preserveDrawingBuffer 关掉 —— 它是命中测试与实量头顶的前提。 */
  ok(/preserveDrawingBuffer: true/.test(s),
    'preserveDrawingBuffer 仍然开着（命中测试 readPixels 需要它，别为了躲残留关掉）');
}

console.log('[B] 取证日志（下次复现一眼定性）');
{
  const s = stripComments(read('renderer/pet.js'));
  const m = stripComments(read('main/main.js'));
  /* 底座高度变化 = 这条路径被触发的时刻，必须打印"到底有几份画布/几个孩子"。 */
  ok(/function setStatsReserve\(px\)/.test(s), 'setStatsReserve 存在');
  const fn = (s.match(/function setStatsReserve\(px\) \{[\s\S]*?\n\}\n/) || [''])[0];
  ok(/canvases: document\.querySelectorAll\('canvas'\)\.length/.test(fn) &&
     /stageChildren:/.test(fn),
    '底座高度变化时打印 canvases / stageChildren（1/1 = 残留，2 = 真画了两份）');
  ok(/\[boot\]/.test(m), '主进程 [boot] 仍在（pid / userData / software，用来数进程）');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
