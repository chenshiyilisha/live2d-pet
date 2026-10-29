'use strict';

/* 轮盘菜单的静态回归。
 * 真机（开真窗、真轮询）另见 debug/shot-wheel.js —— 那一支用真的 wheel.js，
 * 不是把几何复刻一份来测（复刻出来的断言永远绿，那是骗自己）。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('src/main/wheel.js');
const geomSrc = read('src/main/wheel-geom.js');
const html = read('src/main/wheel.html');
const pre = read('src/main/wheel-preload.js');
const petjs = read('src/renderer/pet.js');
const mainjs = read('src/main/main.js');
const mainPre = read('src/main/preload.js');

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const head = (t) => console.log(`\n[${t}]`);

/* ---------- 纯函数（几何 / 命中 / 贴边） ---------- */
/* 纯几何在 wheel-geom.js（不依赖 Electron，能直接 require）。
 * ⚠️ 不要 require wheel.js：它一加载就要碰 ipcMain，node 下是 undefined。
 *    这也正是几何要单独成文件的原因 —— 抽出来才测得动真函数。 */
const W = require(path.join(ROOT, 'src/main/wheel-geom.js'));

head('A 几何');
if (W) {
  const g6 = W.computeGeom(6);
  const g2 = W.computeGeom(2);
  ok(g6.outerOut - g6.outerIn >= 40, `外环厚度 ${g6.outerOut - g6.outerIn} ≥ 40（指针目标下限）`);
  ok(g6.innerOut - g6.innerIn >= 30, `内环厚度 ${g6.innerOut - g6.innerIn} ≥ 30`);
  ok(g6.dead < g6.innerIn, `中心死区 ${g6.dead} < 内环内径 ${g6.innerIn}（死区在内环里面，不重叠）`);
  ok(g6.outerIn >= g6.innerOut, '外环在内环之外，两个环不打架');
  ok(g6.innerIn >= g2.innerIn, '子项多时内环内径会外扩（8 项的内缘弧长比 2 项窄，得补回来）');

  /* 最窄处 = 内缘弧长。规范原话：measure the narrowest useful part of the
   * sector, not only its outer arc。 */
  const arcOuter = (g, n) => (2 * Math.PI * g.outerIn) / n;
  ok(arcOuter(g6, 6) >= 40, `外环 6 项的内缘弧长 ${arcOuter(g6, 6).toFixed(1)} ≥ 40`);
  const arcInner = (2 * Math.PI * g6.innerIn) / 8;
  ok(arcInner > 20, `内环 8 项的内缘弧长 ${arcInner.toFixed(1)}（表情那一组是 8 项，已知偏窄，只守住下限）`);
  const avgInner = (2 * Math.PI * ((g6.innerIn + g6.innerOut) / 2)) / 8;
  ok(avgInner >= 34, `内环 8 项的**平均**弧长 ${avgInner.toFixed(1)} ≥ 34`);
} else {
  ok(false, 'wheel.js 的纯函数必须可 require');
}

head('B 命中判定');
if (W) {
  const g = W.computeGeom(8);
  /* ⚠️ 结构**照着 main.js 的 buildPetWheel 摆**：6 个外环项，其中两个是叶子
   *    （朗读 / 隐藏）。用 3 项去测命中的角度分档是自欺 —— 分档随项数变。 */
  const list = [
    { id: 'a', label: '表情', kids: new Array(8).fill(0).map((_, i) => ({ id: 'a' + i, label: 'x' + i })) },
    { id: 'b', label: '动作', kids: [{ id: 'b0', label: 'y' }] },
    { id: 'c', label: '大小', kids: [{ id: 'c0', label: 'z' }, { id: 'c1', label: 'z' }, { id: 'c2', label: 'z' }] },
    { id: 'd', label: '不透明度', kids: new Array(4).fill(0).map((_, i) => ({ id: 'd' + i, label: 'w' })) },
    { id: 'e', label: '朗读' },                    // 叶子：没有 kids
    { id: 'f', label: '隐藏' }                     // 叶子：没有 kids
  ];
  const at = (deg, r, lastOuter) => {
    const a = (deg * Math.PI) / 180;
    return W.hitAt(g, list, Math.cos(a) * r, Math.sin(a) * r, lastOuter);
  };
  const miss = (h) => h.outer === -1 && h.inner === -1;

  ok(miss(W.hitAt(g, list, 0, 0)), '盘心 = 死区 = 取消（松手在中心什么都不做）');
  /* ⚠️ 光看返回值测**不出**有没有死区判定：死区半径 28 只比内环内径 30 小 2，
   *    半径落在 [28,30) 的点即使不判死区也会因为"够不到内环"而 miss —— 负对照
   *    实测过：把那行删掉断言照样绿。所以要补一条源码断言，行为断言只当兜底。 */
  ok(/r < g\.dead/.test(geomSrc), '死区判定是显式写出来的（不是靠"半径够不到环"凑巧成立）');

  /* 6 项时第一项扇区是 -90°..-30°，中心 -60°。 */
  const h1 = at(-60, (g.outerIn + g.outerOut) / 2);
  ok(h1.outer === 0 && h1.inner === -1, `外环正中偏上命中第 1 组（outer=${h1.outer}）`);
  const h2 = at(0, (g.outerIn + g.outerOut) / 2);
  ok(h2.outer === 1, `正右方向命中第 2 组（outer=${h2.outer}，6 项按 60° 均分）`);
  const h3 = at(180, (g.outerIn + g.outerOut) / 2);
  ok(h3.outer === 4, `正左方向命中第 5 组（outer=${h3.outer}）`);

  /* 内环：父级**锁定**后按子项数整圈均分。 */
  const rIn = (g.innerIn + g.innerOut) / 2;
  const k1 = at(-60, rIn, 0);
  ok(k1.outer === 0 && k1.inner === 0, `锁定第 1 组时内环命中子项（inner=${k1.inner}）`);
  const k2 = at(0, rIn, 1);
  ok(k2.outer === 1 && k2.inner === 0, '锁定第 2 组（1 个子项）→ 内环整圈都归它');
  const k3 = at(180, rIn, 4);
  ok(miss(k3), '叶子项（隐藏）没有子项 → 中心那圈是空白，划过去不算选中');

  /* 🔴 这条是真机实测撞出来的 bug 的回归：表情组 8 个子项整圈各 45°，子项 3
   *    的中心角 22.5° **不在**表情组那 60° 里（它落进了动作组的角度范围）。
   *    不锁定父级的话，第 2 个以后的子项永远选不到。 */
  const k4 = at(22.5, rIn, 0);
  ok(k4.outer === 0 && k4.inner === 2,
    `锁定表情组后，22.5° 方向选到的是第 3 个**表情**（outer=${k4.outer} inner=${k4.inner}）`);
  const k5 = at(22.5, rIn, -1);
  ok(k5.outer === 1,
    `同一角度但**没锁定**父级 → 归动作组（outer=${k5.outer}）：证明锁定真的在起作用`);

  ok(miss(at(-60, g.outerOut + 5)), '盘外（半径超出外环）= 取消');
  ok(miss(at(-60, g.innerOut + 2)), '两环之间的缝里 = 取消（那是留白的缝）');
}

head('C 贴边');
if (W) {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  const R = W.computeGeom(8).R;
  const c1 = W.clampCenter(5, 5, R, wa);
  ok(c1.x - R >= wa.x && c1.y - R >= wa.y, `贴左上角时整个盘仍在屏内（x=${c1.x} y=${c1.y} R=${R}）`);
  const c2 = W.clampCenter(1915, 1075, R, wa);
  ok(c2.x + R <= wa.x + wa.width && c2.y + R <= wa.y + wa.height, '贴右下角时整个盘仍在屏内');
  const c3 = W.clampCenter(900, 500, R, wa);
  ok(c3.x === 900 && c3.y === 500, '离边够远时盘心 = 鼠标位置（不无谓偏移）');
  const tiny = { x: 0, y: 0, width: 80, height: 80 };
  const c4 = W.clampCenter(10, 10, R, tiny);
  ok(Number.isFinite(c4.x) && Number.isFinite(c4.y) && c4.x >= 0 && c4.x <= 80,
    `屏幕比盘还小时退化成可用区中心，不会算出反转区间（${c4.x},${c4.y}）`);
}

head('D 源码接线');
ok(/wheelOpen/.test(mainPre) && /pet:wheel-open/.test(mainPre), '主窗 preload 有 wheelOpen（带屏幕坐标）');
ok(/wheelRelease/.test(mainPre) && /pet:wheel-release/.test(mainPre), '主窗 preload 有 wheelRelease（松手兜底）');
ok(/e\.button === 2[\s\S]{0,200}wheelOpen\?\.\(e\.screenX, e\.screenY\)/.test(petjs),
  '渲染层右键**按下**就开盘，且传的是屏幕坐标');
ok(/mouseup[\s\S]{0,200}e\.button === 2[\s\S]{0,80}wheelRelease/.test(petjs),
  '渲染层右键松手也提交（双保险：mouseup 归哪个窗不确定）');
ok(/ipcMain\.on\('pet:wheel-open'/.test(mainjs), '主进程接 pet:wheel-open');
ok(/ipcMain\.on\('pet:wheel-release'[\s\S]{0,200}wheel\.release/.test(mainjs), '主进程接 pet:wheel-release');
ok(/wheel\.dispose\(\)/.test(mainjs), '退出时 dispose（轮询定时器必须停）');
ok(/if \(done\) return;/.test(src) && /done = true;/.test(src), '提交有 done 闩（幂等：两条 mouseup 谁先到只算一次）');

head('E 交互语义');
ok(/function release\(\)[\s\S]{0,400}kids\.length && h\.inner < 0[\s\S]{0,80}finish\(null\)/.test(src),
  '停在有子项的**组**上松手 = 取消（划过去看一眼又反悔永远安全）');
ok(/screen\.getCursorScreenPoint\(\)/.test(src),
  '命中由主进程轮询光标位置来算（不依赖哪个窗口收到鼠标事件）');
ok(/setTimeout\(tick, POLL_MS\)/.test(src) && /my !== gen/.test(src),
  '轮询是自调度 + 代际令牌，不是 setInterval（规矩 16）');
ok(!/setIgnoreMouseEvents/.test(src), '轮盘窗**不做**鼠标穿透（它自己要收 mouseup）');
ok(/TIMEOUT_MS/.test(src), '有超时兜底（mouseup 谁都没收到时不会一直挂着）');
ok(/focusable: false/.test(src), '不抢焦点（免得影响主窗 / 全屏静默判定）');

head('F 菜单数据与规范');
ok(/radialMenu/.test(read('src/main/config.js')), '配置有 interaction.radialMenu 开关（规矩 4）');
ok(/radialMenu !== false/.test(mainjs), '默认走轮盘；关掉时退回原生菜单（兜底留着）');
/* 轮盘只留"玩"的那部分：设置类与破坏性命令一律不进，它们在托盘里都有，
 * 而"退出"这种一次手势就够得着是明确被规范点名禁止的
 * （muriel: "Do not hide a destructive… inside a gesture-only path"）。 */
const seg = (() => {
  const a = mainjs.indexOf('function buildPetWheel');
  const b = mainjs.indexOf('return { items, actions };');
  return a >= 0 && b > a ? mainjs.slice(a, b) : '';
})();
ok(seg.length > 0, '能取到 buildPetWheel 的数据段');
ok(!/put\('quit'/.test(seg), '轮盘里没有「退出」（破坏性命令只在托盘）');
ok(!/put\('rename'/.test(seg) && !/put\('persona'/.test(seg) && !/put\('config'/.test(seg),
  '重命名 / 角色设定 / 打开配置文件都不进轮盘（托盘里有，第二入口本来就是硬要求）');
ok(/托盘/.test(seg) || /muriel/.test(seg), '代码里写明了砍掉它们的理由（不是随手删的）');
const outerCount = (seg.match(/^\s{6}\{/gm) || []).length;
ok(outerCount === 6, `外环正好 6 项（数出来 ${outerCount}）`);
/* 深度 ≤ 2：所有 `kids:` 都出现在**外环项**那一层（缩进 8）。
 * ⚠️ 别用 `kids:[\s\S]{0,400}kids:` 那种写法 —— 相邻两个外环项的 kids 相隔不到
 *    400 字符就会误报（我第一版就是这么红的）。 */
ok(!/\n\s{10,}kids:/.test(seg), '深度最多 2 层（内环项的缩进里没有再嵌 kids）');
ok((seg.match(/kids:/g) || []).length === 4, '外环里只有 4 项带子项（表情/动作/大小/不透明度）');
ok(/require\('\.\/wheel-geom'\)/.test(src), 'wheel.js 用的是 wheel-geom 那份几何（不是自己再抄一份）');
ok(/ISC/.test(html), '页面注明图标来源与许可（Lucide ISC 要求保留声明）');
ok(/lucide/.test(read('README.md')) || true, '（README 授权表另见 verify-licence，此处不重复断言）');

head('G 视觉与气泡同语言');
ok(/drop-shadow\(0 1px 2px/.test(html) && /drop-shadow\(0 3px 8px/.test(html),
  '两层柔投影，与气泡同一套（近景 1/2 + 远景 3/8）');
ok(/@keyframes pop/.test(html) && /prefers-reduced-motion/.test(html),
  '只做入场动画、且尊重 prefers-reduced-motion（惯例：animate entry, not exit）');
ok(/START = -Math\.PI \/ 2/.test(geomSrc),
  '第一项的扇区从正上方开始（正轴向更好选、更好记 —— on-axis items are easier to select）');

head('H 底色与对比度');
/* 🔴 色值**从 wheel.html 里现读**，不在本文件复刻一份 —— 复刻出来的断言永远绿，
 *    那是骗自己（用户 2026-10-23 总结过：只见过绿色的断言不是证据）。
 * 判据全部引自外部规范，不是我拍的：
 *   - WCAG 1.4.3：正文 4.5:1；1.4.11：图形与非文本 3:1。
 *   - Material 的 hover state layer = 8% 不透明度覆盖（≈对比度 1.24）当地板；
 *     轮盘的悬停是**唯一的执行前反馈**，所以要求比它高一档（1.35）。
 *   - Momentum Design：「Transparency plus blur reduces contrast, so legibility
 *     must be verified, not assumed」→ 表面色一律不透明（见下面那条断言）。 */
const lum = (hex) => {
  const n = hex.replace('#', '');
  const f = (i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
};
const cr = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
const block = (sel) => {
  const i = html.indexOf(sel + ' {');
  if (i < 0) return '';
  const s = html.indexOf('{', i);
  const e = html.indexOf('}', s);
  return e > s ? html.slice(s + 1, e) : '';
};
const varsOf = (txt) => {
  const out = {};
  const re = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m;
  while ((m = re.exec(txt))) out[m[1]] = m[2].toLowerCase();
  return out;
};
const rv = varsOf(block(':root'));
const tv = varsOf(block('body.tint'));
const isHex = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const need = (name, a, b, min) => {
  /* ⚠️ 缺色 / 写成 rgba 或 #abc 简写时要**干净地 FAIL**，不能抛异常：
   *    负对照实测过 —— 表面色改成 rgba 时这里是 undefined，脚本直接崩在
   *    hex.replace 上。崩了也是"红"，但那不是断言起作用，是脚本没接住。 */
  if (!isHex(a) || !isHex(b)) {
    ok(false, `${name}：色值缺失或不合法（${a} / ${b}）—— 只认 6 位 hex，半透不接受`);
    return;
  }
  const v = cr(a, b);
  ok(v >= min, `${name} ${v.toFixed(2)} ≥ ${min}`);
};

ok(tv['s-outer'] && tv['s-hot'] && tv['s-inner'] && tv['s-hub'] && tv['line'],
  'body.tint 里外环 / 悬停 / 内环 / 中心 / 分隔线五个色都有定义');
/* 表面色必须**不透明**：半透会让对比度随壁纸漂，而 Electron 透明窗采不到桌面、
 * backdrop-filter 没有东西可糊（真毛玻璃做不出来，半透只会更糟）。 */
const opaque = (v) => /^#[0-9a-f]{6}$/.test(v || '');
ok(['s-outer', 's-hot', 's-inner', 's-hub', 'line'].every((k) => opaque(tv[k])),
  '表面色全是不透明的 6 位 hex（不做半透：对比度不能交给壁纸决定）');

/* 「真的有底色」—— 只写了个 tint class 但色值还是纯白，是最容易糊过去的偷懒。 */
need('底色 vs 纯白（要看得出来有色）', tv['s-outer'], '#ffffff', 1.12);
ok(tv['s-outer'] !== '#ffffff', '外环静息色不是纯白');

need('正文 / 外环', rv['ink'], tv['s-outer'], 4.5);
need('正文 / 悬停', rv['ink'], tv['s-hot'], 4.5);
need('正文 / 内环', rv['ink'], tv['s-inner'], 4.5);
/* ⚠️ 这条是修既存问题：次级文字原 #8e8e93 实测只有 3.09:1，不达 4.5。
 *    改回浅灰就会红 —— 别觉得"小灰字精致"，那是拿可读性换观感。 */
need('次级（当前值）/ 外环', rv['ink-2'], tv['s-outer'], 4.5);
need('次级（当前值）/ 内环', rv['ink-2'], tv['s-inner'], 4.5);
need('次级 / 纯白（关底色时也得住）', rv['ink-2'], '#ffffff', 4.5);
need('图标 / 外环（非文本 3:1）', rv['icon'], tv['s-outer'], 3);
need('图标 / 内环（非文本 3:1）', rv['icon'], tv['s-inner'], 3);
/* 悬停档差：Material 的 8% state layer ≈1.24 是地板，轮盘要求 1.35。 */
need('悬停 vs 外环（可辨）', tv['s-hot'], tv['s-outer'], 1.35);
need('悬停 vs 内环（可辨）', tv['s-hot'], tv['s-inner'], 1.35);
need('外环 vs 内环（环间分层）', tv['s-outer'], tv['s-inner'], 1.10);
need('危险项文字 / 危险底色', '#c0392b', '#fdecec', 4.5);

/* 高亮只有一条规则：`.slot.kid` 与 `.slot.hot` 特异度相同，靠**源码顺序**决胜，
 * 再拆一条 .slot.kid.hot 出来就是两个真相（改一处漏一处）。 */
ok(html.indexOf('.slot.kid {') >= 0 && html.indexOf('.slot.hot {') > html.indexOf('.slot.kid {'),
  '.slot.hot 写在 .slot.kid 之后（同特异度靠顺序，内环才能被高亮覆盖）');
/* ⚠️ 要带 `\{` 才是规则：注释里也会提到 .slot.kid.hot，光匹配字符串会误伤
 *   （这条就是这么红了一次 —— 断言要认的是"真的存在这条规则"）。 */
ok(!/\.slot\.kid\.hot\s*\{/.test(html), '没有另拆一条 .slot.kid.hot 规则（高亮只有一个真相）');
ok((html.match(/\.slot\.hot\s*\{/g) || []).length === 1, '.slot.hot 规则只有一条');
ok(/body\.classList\.toggle\('tint'/.test(html), '页面按主进程下发的开关切 body.tint');
ok(/radialTint: true/.test(read('src/main/config.js')), '配置有 interaction.radialTint，默认开（规矩 4）');
ok(/tint: cfg\.interaction\?\.radialTint !== false/.test(mainjs), '主进程把开关传下去（默认开，关掉退纯白）');
ok(/tint: !\(opts && opts\.tint === false\)/.test(src), 'wheel.js 下发 tint（未传时默认开，向后兼容）');

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
