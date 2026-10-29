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
 *  ⚠️ 2026-10-29 更新：真正的修法是**把 --stats-h 冻结**（用户：「始终是加了
 *    底座时的大小」）—— 底座出现不再触发 layout()，那条 resize 链根本不会发生。
 *    [A]/[A2] 那套清屏 + 整窗重绘因此降级成"真 resize（窗口/换模型/改缩放）"
 *    的保险，[B] 守的是冻结别被人改回去。
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

  /* 🔴 2026-10-29 补的两条：上一版只做"清画布"，用户实测**仍复现**。
   *    依据是 Electron 官方博客《Tech Talk: Improving Window Resize
   *    Behavior》：旧帧留在"新内容不再覆盖"的窗口区域里，清画布管不到那儿。
   *    官方修法（视口外涂透明）从 39.2.6 起就在，但只管**窗口 resize**；
   *    我们是"窗口不变、只缩画布层"，所以得自己要求整窗重绘。 */
  ok(/requestRepaint\(\)/.test(layoutFn),
    'resize 后请求**整窗重绘**（invalidate）—— 只清画布管不到窗口合成面上的旧帧');
  const iRepaint = layoutFn.indexOf('requestRepaint()');
  ok(iRepaint > iClear, '整窗重绘排在清画布之后（先有新内容，再让窗口重绘）');
  ok(/requestAnimationFrame\(\(\) => \{[\s\S]{0,300}app\.renderer\.render\(/.test(layoutFn),
    '下一帧再补画一次（重绘若仍拿到旧纹理，第二次能盖掉）');
  ok(/function requestRepaint\(\)[\s\S]{0,160}window\.pet\?\.repaint\?\.\(\)/.test(s),
    'requestRepaint 走 window.pet.repaint 且全可选链（最小页面 / 探针页没有 window.pet）');
}

console.log('[A2] 整窗重绘的桥（主进程 ← preload ← 渲染层）');
{
  const pre = read('main/preload.js');
  const m = stripComments(read('main/main.js'));
  ok(/repaint: \(\) => ipcRenderer\.send\('pet:repaint'\)/.test(pre),
    "preload 暴露 repaint() → 'pet:repaint'");
  ok(/ipcMain\.on\('pet:repaint',[\s\S]{0,220}webContents\.invalidate\(\)/.test(m),
    '主进程收到后调 webContents.invalidate()（Electron 官方口子：整窗重绘）');
  ok(/try \{ mainWindow\.webContents\.invalidate\(\); \} catch/.test(m),
    'invalidate 包了 try（窗口正在销毁时不该抛）');
}

/* 2026-10-29 用户拍板：「始终是加了底座时的大小，这样就不用担心加载底座后
 * 大小切换的问题了」。也就是说，**上面 [A]/[A2] 那套清屏 + 整窗重绘降级成保险**，
 * 真正的修法是把 `--stats-h` 冻结 —— 底座出现/消失根本不触发 layout()。
 * 这一段守的就是"别又让它变回去"。 */
console.log('[B] 预留高度冻结（源头掐掉 resize 链）');
{
  const s = stripComments(read('renderer/pet.js'));
  const m = stripComments(read('main/main.js'));

  ok(/function applyStatsReserve\(\)/.test(s),
    'applyStatsReserve() 存在（写 --stats-h 的唯一入口）');
  const fn = (s.match(/function applyStatsReserve\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  ok(fn !== '', '找得到 applyStatsReserve 的函数体');

  /* ✅ 只量一次：量完就冻在 statsReserve 里，之后永远走"值没变就返回"。 */
  ok(/if \(!statsReserve\) \{[\s\S]{0,220}statsReserve = measureStatsReserve\(\);/.test(fn),
    '只在 statsReserve 还是 0 时量一次（之后永不重量）');
  ok(/if \(statsReserve === statsApplied\) return statsReserve;/.test(fn),
    '值没变就直接返回（不写 CSS、不调 layout）');
  /* 函数体里除了那一次测量，不许再出现会"改值"的写法。
   * ⚠️ 别写成 `/statsReserve\s*=(?!measureStatsReserve)/` —— 那个正则会被回溯骗过
   *    （`\s*` 退成空、断言就看到了空格）。数**赋值次数**才是硬的：只能有 1 处。 */
  ok((fn.match(/statsReserve\s*=(?!=)/g) || []).length === 1,
    '函数体里没有第二处给 statsReserve 赋值（否则高度会在运行中跳）');

  /* 🔴 旧写法必须绝迹：任何 setStatsReserve(0) 都是"把高度还回去" = 人物放大一圈。 */
  ok(!/setStatsReserve\(/.test(s),
    '没有残留的 setStatsReserve(...)（还高度 = 又一次 canvas resize）');
  ok(!/--stats-h'?,\s*`?\$\{?\s*0/.test(s) && !/--stats-h', '0px'/.test(s),
    '没有任何地方把 --stats-h 写回 0px');

  /* 调用点必须覆盖：boot + 出数 + 转圈 + 收转圈 + 关开关（定义那一处也算进总数）。
   * ⚠️ 光数总数不够：把 renderStats 里那处换成按状态改值的旧写法，总数只少 1、
   *    仍然 ≥5 —— 所以出数 / 转圈这两个关键点要**点名验**。 */
  const calls = (s.match(/applyStatsReserve\(\)/g) || []).length;
  ok(calls >= 6, `调用点覆盖 boot／出数／转圈／收转圈／关开关（实测 ${calls} 处，含定义本身）`);
  for (const name of ['renderStats', 'renderStatsLoading', 'dismissStatsLoading']) {
    const body = (s.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`)) || [''])[0];
    ok(body !== '' && /applyStatsReserve\(\)/.test(body) && !/measureStatsReserve\(/.test(body),
      `${name} 里是确认式调用（不重量、不按状态改值）`);
  }
  ok(/if \(wasFloating && cfg\?\.monitor\?\.floating !== true\) \{[\s\S]{0,220}applyStatsReserve\(\);/.test(s),
    '关掉悬浮显示时也只是确认，不把高度还回去');

  /* 🔴 时机：必须在第一次 layout() 之前 —— 晚一步就是"先按大尺寸画一帧再缩小"。 */
  const bootFn = (s.match(/async function boot\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  const iApply = bootFn.indexOf('applyStatsReserve()');
  const iInit = bootFn.indexOf('app = new PIXI.Application()');
  ok(iApply >= 0 && iInit > 0 && iApply < iInit,
    'boot 里在 app.init（第一次 layout()）之前就冻结高度');
  ok(!/monitor[\s\S]{0,80}floating[\s\S]{0,120}applyStatsReserve/.test(bootFn) ||
     iApply >= 0,
    'boot 的冻结与悬浮显示开关无关（"始终"= 不看配置）');

  /* 取证：两个日志一起看才算证据 —— 冻结只打一行、resize 整场只该有一行。 */
  ok(/statsReserve frozen/.test(fn) &&
     /canvases: document\.querySelectorAll\('canvas'\)\.length/.test(fn) &&
     /stageChildren:/.test(fn),
    '冻结时打印 canvases / stageChildren（1/1 = 合成残留，2 = 真画了两份）');
  ok(/console\.log\('\[pet\] canvasResize'/.test(s),
    'canvas 真的 resize 时打一行 [pet] canvasResize（整场只该有首帧那一行）');
  ok(/\[boot\]/.test(m), '主进程 [boot] 仍在（pid / userData / software，用来数进程）');
}

/* ============================================================
 *  [C] 窗口宽度「只增不减」—— 「两个她」第三次复现的真凶（2026-10-29）
 *
 *  冻结 --stats-h 只断了"底座 → 舞台变矮"这条；真正让画布动的是**窗口自己**：
 *  启动期 layout() 跑了好几轮，petRect.w 一轮一个值，每轮都上报 →
 *  窗口宽 324→312→310 连缩两刀（高度还被 applyStageWidth 里的
 *  refreshWinSize 带偏 2px）→ canvas resize 两次。而**缩小**之后新视口比
 *  旧帧小，超出部分留在合成面上没人重绘（Electron 官方博客 2025-12-19）——
 *  屏幕上就是一大一小两个她。
 *
 *  实测：修前 3 次 canvasResize（939×858 → 904×852 → 898×852）；
 *        修后 1 次（只有首帧）。负对照（短路 want<=cur+2）能回到 3 次。
 * ========================================================== */
console.log('[C] 窗口宽度只增不减（缩窗口 = 残留的唯一来路）');
{
  const s = stripComments(read('renderer/pet.js'));
  ok(/const cur = Math\.round\(window\.innerWidth\)/.test(s),
    '用 innerWidth 判断当前窗口宽（DPR 误差靠容差吸收）');
  ok(/if \(want <= cur \+ 2\) \{[\s\S]{0,160}return;/.test(s),
    'want 不大于当前宽 → 不上报（不 setBounds、不动画布）');
  /* 主进程：改宽度不许顺带重算高度（启动早期 workArea 未稳，会抖 2px） */
  const w = stripComments(read('main/win-size.js'));
  const fn = (w.match(/function applyStageWidth\(want\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(fn.length > 0, 'applyStageWidth 存在');
  ok(!/refreshWinSize\(\)/.test(fn),
    'applyStageWidth 不调 refreshWinSize（高度只在屏幕真变时变）');
  ok(/SIZE\.w = reportedW/.test(fn), '只写 SIZE.w');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
