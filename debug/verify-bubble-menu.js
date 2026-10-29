'use strict';

/* 头顶泡泡菜单的静态回归。
 * 真机（开真窗、真轮询）另见 debug/shot-bubble-menu.js —— 那一支用真的
 * bubble-menu.js，不是把几何复刻一份来测（复刻出来的断言永远绿，那是骗自己）。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('src/main/bubble-menu.js');
const geomSrc = read('src/main/bubble-menu-geom.js');
const html = read('src/main/bubble-menu.html');
const pre = read('src/main/bubble-menu-preload.js');
const mainjs = read('src/main/main.js');
const bubblesrc = read('src/main/bubble.js');
const cfgjs = read('src/main/config.js');

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const head = (t) => console.log(`\n[${t}]`);

const G = require(path.join(ROOT, 'src/main/bubble-menu-geom.js'));

const pairs = (pts) => {
  let mn = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      mn = Math.min(mn, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
  }
  return mn;
};

head('A 几何');
{
  ok(G.radiusFor(5) >= 20, `5 项半径 ${G.radiusFor(5)}（直径 ≥ 40 = Material mini FAB 下限）`);
  ok(G.radiusFor(9) >= 20, `9 项（表情 8 + 返回）半径 ${G.radiusFor(9)} 仍守 40px 直径`);

  for (const n of [5, 9]) {
    const lay = G.layout(n, { x: 500, y: 500 });
    const d = pairs(lay.pts);
    /* ⚠️ 这条是修真 bug 的回归：第一版按**未压扁**的弦长反解 R，5 项实测相邻
     *    只差 60.1px 而直径就是 60 —— 正好贴边重叠。压扁后必须按实测间距反解。 */
    ok(d >= lay.r * 2 + 2, `${n} 项：最近两泡泡间距 ${d.toFixed(1)} ≥ 直径+2（不重叠、还留得住缝）`);
    const ds = lay.pts.map((p) => Math.hypot(p.x - 500, p.y - 500));
    const ratio = Math.min(...ds) / Math.max(...ds);
    /* 弧形排布的意义就在这里：末端那个的距离不能比第一个远太多（一行排开的话
     * 是好几倍）。压扁 0.75 之后不再严格相等，但比值必须守得住。 */
    ok(ratio >= 0.7, `${n} 项：到锚点距离 min/max = ${ratio.toFixed(2)} ≥ 0.7（近似等距，不是一行排开）`);
    ok(lay.pts.every((p) => p.y <= 500), `${n} 项：所有泡泡都在头顶或以上（不绕到她下巴）`);
    const b = lay.box;
    ok(lay.pts.every((p) => p.x - p.r >= b.x && p.x + p.r <= b.x + b.width
      && p.y - p.r >= b.y && p.y + p.r <= b.y + b.height), `${n} 项：box 完整包住所有泡泡`);
  }
  const a = G.layout(5, { x: 500, y: 500 });
  const b = G.layout(9, { x: 500, y: 500 });
  ok(Math.abs(a.R - b.R) > 1, `项数不同弧半径就重算（5→R=${a.R.toFixed(1)}, 9→R=${b.R.toFixed(1)}）`);
  ok(G.layout(1, { x: 0, y: 0 }).pts.length === 1, '单项也排得出（不除零、不 NaN）');
}

head('B 命中判定');
{
  const lay = G.layout(5, { x: 500, y: 500 });
  const p = lay.pts;
  ok(G.hitAt(p, p[2].x, p[2].y) === 2, '泡泡圆心命中自己');
  ok(G.hitAt(p, p[0].x, p[0].y) === 0, '最边上那个也命中（不是只有中间能用）');
  /* 缝上也要算命中：muriel 规范「keep visual gaps smaller than hit gaps」，
   * 视觉有 8px 缝，但缝上松手不该变成"没选中"。 */
  const edge = { x: p[1].x + p[1].r + 2, y: p[1].y };
  ok(G.hitAt(p, edge.x, edge.y) === 1, '圆外 2px（缝里）仍算命中（命中区比视觉大）');
  ok(G.hitAt(p, p[1].x, p[1].y - lay.r - 12) === -1, '离泡泡 12px = 没命中');
  ok(G.hitAt(p, 0, 0) === -1, '盘外（很远）= 没命中');
  ok(G.hitAt([], 10, 10) === -1, '空列表不炸');
}

head('C 贴边');
{
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  for (const [name, ax, ay] of [['左上', 5, 5], ['右下', 1915, 1075]]) {
    const out = G.layoutClamped(9, { x: ax, y: ay }, wa);
    const b = out.lay.box;
    ok(b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width
      && b.y + b.height <= wa.y + wa.height,
      `贴${name}角时整排仍在屏内（box ${b.x},${b.y} ${b.width}×${b.height}）`);
  }
  const mid = G.layoutClamped(5, { x: 900, y: 600 }, wa);
  ok(mid.anchor.x === 900 && mid.anchor.y === 600, '离边够远时锚点 = 她头顶（不无谓偏移）');
  const tiny = G.layoutClamped(9, { x: 10, y: 10 }, { x: 0, y: 0, width: 120, height: 120 });
  ok(Number.isFinite(tiny.anchor.x) && Number.isFinite(tiny.anchor.y),
    '屏幕比整排还小时退化成有限值，不会算出反转区间');
}

head('D 源码接线');
ok(/menuHost/.test(pre) && /onShow/.test(pre) && /onHover/.test(pre), 'preload 暴露 onShow / onHover');
ok(/pick:/.test(pre) && /cancel:/.test(pre) && /back:/.test(pre), 'preload 暴露 pick / cancel / back');
ok(/release:/.test(pre), 'preload 暴露 release（本窗也要收右键松手，见页面那条注释）');
ok(/e\.button === 2[\s\S]{0,120}menuHost\.release/.test(html),
  '页面监听**右键**松手（划向泡泡时光标已离开主窗，主窗收不到）');
ok(/ipcMain\.on\('menu:pick'/.test(src) && /ipcMain\.on\('menu:back'/.test(src)
  && /ipcMain\.on\('menu:cancel'/.test(src) && /ipcMain\.on\('menu:release'/.test(src),
  '主进程接 pick / back / cancel / release');
ok(/if \(done\) return;/.test(src) && /done = true;/.test(src), '提交有 done 闩（幂等）');
ok(/screen\.getCursorScreenPoint\(\)/.test(src), '命中由主进程轮询光标算（不依赖哪个窗收到事件）');
ok(/setTimeout\(tick, POLL_MS\)/.test(src) && /my !== gen/.test(src),
  '轮询是自调度 + 代际令牌，不是 setInterval（规矩 16）');
ok(!/setIgnoreMouseEvents/.test(src), '泡泡窗**不做**鼠标穿透（它自己要收点击）');
ok(/focusable: false/.test(src), '不抢焦点（免得影响全屏静默判定）');
ok(/TIMEOUT_MS/.test(src) && /STICKY_MS/.test(src), '手势态与常驻态各有超时兜底');
ok(/GESTURE_MIN/.test(src) && /moved < GESTURE_MIN/.test(src),
  '手势 / 常驻靠**位移**判（不是靠时长 —— 时长会跟摸头、拖拽那些长按打架）');

head('E 菜单数据');
/* 2026-10-29 定版：默认形态换成「光标处卡片」（card-menu），泡泡降为技术储备。
 * ⚠️ 菜单数据也从 buildPetBubble 改成了 buildPetMenu —— 泡泡和卡片**共用一份**，
 *    泡泡那支在 main.js 里把 {sep:true} 过滤掉（离散圆点没有"分隔线"）。 */
ok(/petMenu: 'card'/.test(cfgjs) && /'bubble'/.test(cfgjs) && /'wheel'/.test(cfgjs),
  "配置默认 'card'，'bubble' / 'wheel' 都保留可切回（规矩 4）");
ok(/petMenuTint: true/.test(cfgjs), '底色有开关且默认开');
ok(/radialMenu: true/.test(cfgjs) && /'wheel'/.test(cfgjs),
  '轮盘保留为技术储备，配置可切回（不是删掉）');
const seg = (() => {
  const a = mainjs.indexOf('function buildPetMenu');
  const b = mainjs.indexOf('return { items, actions };', a);
  return a >= 0 && b > a ? mainjs.slice(a, b) : '';
})();
ok(seg.length > 0, '能取到 buildPetMenu 的数据段（泡泡与卡片共用）');
const outerCount = (seg.match(/^\s{6}\{/gm) || []).length;
ok(outerCount === 7, `顶层 7 个槽位 = 5 项 + 2 条分隔线（数出来 ${outerCount}）——实际项数仍是 5，守住"菜单要短"`);
ok(/items\.filter\(\(it\) => !it\.sep\)/.test(mainjs),
  '泡泡那支过滤掉 {sep:true}（泡泡没有"分隔线"这个概念）');
ok(!/put\('quit'/.test(seg) && !/put\('rename'/.test(seg) && !/put\('persona'/.test(seg),
  '退出 / 重命名 / 角色设定都不进菜单（破坏性与设置类只在托盘）');
ok((seg.match(/kids:/g) || []).length === 3, '只有 3 项带子项（表情 / 动作 / 外观）');
ok(!/\n\s{10,}kids:/.test(seg), '深度最多 2 层（子项里没有再嵌 kids）');
ok(/更透明/.test(seg), '外观里有「更透明」（循环档，省得列 4 个档位）');
ok((mainjs.match(/OPACITY_STEPS = \[/g) || []).length === 1, '不透明度档位数组只有一处定义（规矩 9）');
ok(/Math\.abs\(OPACITY_STEPS\[i\] - cur\)/.test(mainjs),
  '循环档用"找最近的一档"而不是 === 比浮点（0.9 落盘再读回来可能是 0.9000000001）');

head('F 两级与返回');
ok(/trail\.push\(\{ items: cur \}\)/.test(src), '进子项前把当前排压栈（返回用）');
ok(/\{ id: '__back', label: '返回' \}\]\.concat\(kids\)/.test(src),
  '子排**显式**带一个「返回」项（可见的出口，不靠 Esc 才知道能退）');
ok(/function back\(\)[\s\S]{0,200}!trail\.length[\s\S]{0,80}finish\(null\)/.test(src),
  '已经在第一级时再返回 = 关闭（不会卡住）');
ok(/function activate\(i\)[\s\S]{0,200}drill\(i\)[\s\S]{0,120}finish\(cur\[i\]/.test(src),
  '命中带子项的泡泡 = 进子项（不关）；叶子 = 执行');
ok(/menu:hover-key/.test(src) && /hoverKey/.test(html),
  '键盘移动高亮会回报主进程（命中状态在主进程手里，页面只是镜像）');

head('G 锚点（头顶）');
ok(/headAnchor/.test(bubblesrc) && /headAnchor,/.test(bubblesrc), 'bubble.js 导出头顶锚点');
ok(/getContentBounds\(\)/.test(bubblesrc) && !/getBounds\(\)/.test(bubblesrc.slice(bubblesrc.indexOf('function headAnchor'), bubblesrc.indexOf('function headAnchor') + 600)),
  '锚点换算用 contentBounds，不是 getBounds 反推（规矩 20）');
ok(/bubble\.headAnchor\(\)/.test(mainjs), '主进程用现成的头顶锚点（不另拼一次 b.y + headTop）');

head('H 视觉与对比度');
ok(/drop-shadow\(0 1px 2px/.test(html) && /drop-shadow\(0 3px 8px/.test(html),
  '两层柔投影，与气泡 / 轮盘同一套');
ok(/prefers-reduced-motion/.test(html) && /@keyframes rise/.test(html),
  '只做入场动画（逐个往上冒）+ 尊重 prefers-reduced-motion');
ok((html.match(/class: 'tail'/g) || []).length === 1,
  '尾巴只挂**一个**泡泡（气泡菜单规范：「**一个**箭头指向浮层出现的位置」）');
/* 色值**从 HTML 现读**，不复刻 —— 判据同 verify-wheel [H]。 */
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
const v = varsOf(block(':root'));
const need = (name, a, b, min) => {
  const isHex = (x) => typeof x === 'string' && /^#[0-9a-fA-F]{6}$/.test(x);
  if (!isHex(a) || !isHex(b)) { ok(false, `${name}：色值缺失或不合法（${a} / ${b}）`); return; }
  const r = cr(a, b);
  ok(r >= min, `${name} ${r.toFixed(2)} ≥ ${min}`);
};
ok(!!v['s-1'] && !!v['s-2'] && !!v['s-hot'], '泡泡表面色（一级 / 二级 / 悬停）都有定义');
need('正文 / 一级底', v['ink'], v['s-1'], 4.5);
need('正文 / 二级底', v['ink'], v['s-2'], 4.5);
need('正文 / 悬停', v['ink'], v['s-hot'], 4.5);
need('图标 / 一级底（非文本 3:1）', v['icon'], v['s-1'], 3);
need('悬停 vs 一级（可辨）', v['s-hot'], v['s-1'], 1.35);
need('悬停 vs 二级（可辨）', v['s-hot'], v['s-2'], 1.35);
need('一级 vs 二级（层级感）', v['s-1'], v['s-2'], 1.10);

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
