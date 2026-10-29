'use strict';

/* 光标处卡片菜单的静态回归。
 *
 * 真机（开真窗、真轮询、真 DOM 量字宽）另见 debug/shot-card-menu.js ——
 * 那一支用的是真的 card-menu.js，不是把几何复刻一份来测
 * （复刻出来的断言永远绿，那是骗自己）。
 *
 * 跑：node debug/verify-card-menu.js   exit=0 才算过。 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const src = read('src/main/card-menu.js');
const geomSrc = read('src/main/card-menu-geom.js');
const html = read('src/main/card-menu.html');
const pre = read('src/main/card-menu-preload.js');
const mainjs = read('src/main/main.js');
const cfgjs = read('src/main/config.js');

let fails = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`);
  if (!cond) fails++;
};
const head = (t) => console.log(`\n[${t}]`);

const G = require(path.join(ROOT, 'src/main/card-menu-geom.js'));

/* 与 main.js 里 buildPetMenu 同构的一份（含 {sep:true}），
 * 这样"分隔线占下标但不参与命中"这条才能真的被测到。 */
const ITEMS = [
  { id: 'emo', label: '表情', icon: 'smile', kids: [1, 2, 3] },
  { id: 'motion', label: '动作', icon: 'hand', kids: [1, 2] },
  { sep: true },
  { id: 'look', label: '外观', icon: 'zoomIn', kids: [1, 2, 3, 4] },
  { id: 'tts', label: '朗读', sub: '关', icon: 'volume2' },
  { sep: true },
  { id: 'hide', label: '隐藏', icon: 'eyeOff' }
];
const WA = { x: 0, y: 0, width: 1920, height: 1040 };

const centreOf = (lay, i) => {
  const r = lay.rows.find((x) => x.i === i);
  return { x: lay.w / 2, y: r.y + r.h / 2 };
};

head('A 卡片几何');
{
  const lay = G.card(ITEMS);
  const rows = ITEMS.filter((it) => !G.isSep(it)).length;
  ok(lay.h === G.PAD_Y * 2 + rows * G.ITEM_H + 2 * G.SEP_H,
    `高 ${lay.h} = 上下留白 + ${rows} 行 + 2 条分隔线（分隔线只占 9px 占位）`);
  ok(lay.rows.length === rows, `${lay.rows.length} 个可命中行（分隔线不在 rows 里）`);
  for (let k = 1; k < lay.rows.length; k++) {
    const a = lay.rows[k - 1];
    const b = lay.rows[k];
    ok(b.y >= a.y + a.h, `第 ${k} 行不压上一行（y ${b.y} ≥ ${a.y + a.h}）`);
  }
  ok(lay.w >= G.MIN_W && lay.w <= G.MAX_W, `宽 ${lay.w} 落在 ${G.MIN_W}~${G.MAX_W}`);
  /* 🔴 这两个值是**钉死**的：宽度档一变，"估字宽够不够"就要重新量
   *    （真机那支 shot-card-menu 会用真实行盒反查）。想改值，先跑真机那支。 */
  ok(G.MIN_W === 176 && G.MAX_W === 272, `宽度档被钉住 MIN=176 / MAX=272（现在 ${G.MIN_W}/${G.MAX_W}）`);
  ok(lay.iconCol === G.ICON_W, `有图标 → 图标列 ${lay.iconCol}px（没图标的行也留列，不左右跳）`);

  const sub = G.card([{ id: 'a', label: '打个招呼' }]);
  ok(sub.iconCol === 0, '子菜单没有图标 → 不留图标列（不白缩进 22px）');
  ok(sub.w === G.MIN_W, `短标签走最小宽 ${sub.w}（不被内容撑成一条）`);

  const long = G.card([{ id: 'x', label: '一二三四五六七八九十一二三四五六七八九十' }]);
  ok(long.w === G.MAX_W, `超长标签封顶 ${long.w} = MAX_W（其余交给省略号）`);

  ok(G.textW('表情') === 2 * G.FONT_PX, `中文按全角算：'表情' = ${G.textW('表情')} = 2×13`);
  ok(G.textW('100%') < 40, `'100%' 估宽 ${G.textW('100%').toFixed(1)}（数字窄，不会算成 4×13）`);
  ok(G.ITEM_H >= 28 && G.ITEM_H <= 34, `行高 ${G.ITEM_H} 在 28~34（指针目标下限 / 不虚胖）`);
}

head('B 卡片摆位（贴边翻转）');
{
  const size = G.card(ITEMS);
  const mid = G.place({ x: 900, y: 500 }, size, WA);
  ok(mid.x === 900 + G.CURSOR_DX && mid.y === 500 + G.CURSOR_DY,
    `屏幕中间：左上角贴光标右下 (${mid.x},${mid.y})，偏移 ${G.CURSOR_DX}/${G.CURSOR_DY}`);

  const r = G.place({ x: 1910, y: 500 }, size, WA);
  /* 🔴 必须是"翻转"而不是"只 clamp"：clamp 会把卡片怼到屏幕边上（右沿 1914），
   *    翻转才是"整卡在光标左侧"。负对照实测：把翻转删掉、只留 clamp，
   *    "右沿 ≤ 屏宽"这种断言照样绿 —— 所以这里钉的是翻转语义本身。 */
  ok(r.x + size.w <= 1910 - G.CURSOR_DX,
    `贴右边缘：翻到光标左侧（右沿 ${r.x + size.w} ≤ 光标-${G.CURSOR_DX}）`);

  const b = G.place({ x: 900, y: 1035 }, size, WA);
  ok(b.y + size.h <= 1035 - G.CURSOR_DY,
    `贴底边：翻到光标上方（下沿 ${b.y + size.h} ≤ 光标-${G.CURSOR_DY}）`);
  ok(b.y <= 1035, `贴底边：卡片顶在光标上方（不盖住光标）`);

  for (const p of [{ x: 0, y: 0 }, { x: 1919, y: 1039 }, { x: 5, y: 1035 }]) {
    const q = G.place(p, size, WA);
    ok(q.x >= WA.x && q.x + size.w <= 1920 + 1 && q.y >= WA.y && q.y + size.h <= 1041,
      `角落 (${p.x},${p.y})：整卡仍在可用区内 (${q.x},${q.y})`);
  }

  const tiny = { x: 0, y: 0, width: 100, height: 60 };
  const t = G.place({ x: 10, y: 10 }, size, tiny);
  ok(Number.isFinite(t.x) && Number.isFinite(t.y), '可用区比卡片还小：退回中心，不出 NaN');
}

head('C 子菜单摆位');
{
  const sizeM = G.card(ITEMS);
  const sizeS = G.card(ITEMS[0].kids.map((n, i) => ({ id: 'k' + i, label: '平静' + n })));
  const cardPos = G.place({ x: 600, y: 400 }, sizeM, WA);
  const row = sizeM.rows[0].y;
  const sub = G.placeSub(cardPos, sizeM, row, sizeS, WA);
  ok(sub.x === cardPos.x + sizeM.w + G.CARD_GAP,
    `默认贴父卡片右侧（缝 ${G.CARD_GAP}px）：${sub.x}`);
  ok(Math.abs(sub.y - (cardPos.y + row - G.PAD_Y)) <= 1,
    '纵向对齐父项那一行的上沿（原生菜单手感）');

  const cardRight = G.place({ x: 1700, y: 400 }, sizeM, WA);
  const subL = G.placeSub(cardRight, sizeM, row, sizeS, WA);
  ok(subL.x + sizeS.w <= cardRight.x, `右边放不开 → 翻到左侧（右沿 ${subL.x + sizeS.w} ≤ ${cardRight.x}）`);

  const cardBottom = G.place({ x: 600, y: 990 }, sizeM, WA);
  const subB = G.placeSub(cardBottom, sizeM, row, sizeS, WA);
  ok(subB.y >= 0 && subB.y + sizeS.h <= 1040, `父卡片贴底时子菜单仍在屏内（y ${subB.y}）`);
}

head('D 命中判定');
{
  const lay = G.card(ITEMS);
  ok(G.hitAt(lay, centreOf(lay, 0).x, centreOf(lay, 0).y) === 0, '第一行 → 0');
  /* 🔴 分隔线占一个槽位，但**不占下标**：外观在 items 里是 3，不是 2。
   *    回归这条是因为"下标"和"槽位"混用是最容易写错的一处。 */
  ok(G.hitAt(lay, centreOf(lay, 3).x, centreOf(lay, 3).y) === 3,
    '分隔线之后的「外观」命中的是 items[3]（分隔线不占下标）');
  const sepSlot = lay.slots.find((s) => s.sep);
  ok(G.hitAt(lay, lay.w / 2, sepSlot.y + 2) === -1,
    '分隔线上没有命中项（但也不算"出卡片"，见下一条）');
  ok(G.inRect({ x: 0, y: 0, w: lay.w, h: lay.h }, lay.w / 2, sepSlot.y + 2),
    '分隔线位置仍算"在卡片里"（划过它不会闪一下没高亮）');
  ok(G.hitAt(lay, -3, 10) === -1, '卡片左侧外面 → -1');
  ok(G.hitAt(lay, lay.w / 2, lay.h + 5) === -1, '卡片下方外面 → -1');
  ok(G.hitAt(lay, 4, G.PAD_Y + 1) === 0, '卡片内边距也算第一行（不给"点了没反应"的缝）');
}

head('E 窗口 bounds 与桥接');
{
  const sizeM = G.card(ITEMS);
  const sizeS = G.card([{ id: 'a', label: '平静' }]);
  const one = G.boundsOf([{ x: 100, y: 100, w: sizeM.w, h: sizeM.h }]);
  ok(one.width === sizeM.w + 2 * G.SHADOW_PAD && one.height === sizeM.h + 2 * G.SHADOW_PAD,
    `单卡 bounds ${one.width}×${one.height} = 卡片 + 两侧阴影留白 ${G.SHADOW_PAD}`);
  ok(one.x === 100 - G.SHADOW_PAD, 'bounds 左上角向外扩阴影留白（不然投影被窗口切掉）');

  const two = G.boundsOf([
    { x: 100, y: 100, w: sizeM.w, h: sizeM.h },
    { x: 100 + sizeM.w + G.CARD_GAP, y: 160, w: sizeS.w, h: sizeS.h }
  ]);
  ok(two.x + two.width >= 100 + sizeM.w + G.CARD_GAP + sizeS.w,
    `子菜单开着时 bounds 覆盖到子卡片右沿（${two.x + two.width}）`);
  ok(two.width < sizeM.w + sizeS.w + 2 * G.SHADOW_PAD + 40,
    'bounds 只比内容大一圈 —— 透明窗空白会照吃鼠标，不能预留');

  const cardR = { x: 100, y: 100, w: sizeM.w, h: sizeM.h };
  const subR = { x: 100 + sizeM.w + G.CARD_GAP, y: 160, w: sizeS.w, h: sizeS.h };
  ok(G.inBridge(cardR, sizeM, subR, 100 + sizeM.w + 2, 180), '两张卡片之间的缝算桥接区（手抖不丢选择）');
  ok(!G.inBridge(cardR, sizeM, subR, 900, 900), '远离两张卡片的点不算桥接区');
}

head('F 接线与状态机');
{
  ok(/petMenu: 'card'/.test(cfgjs), "config 默认 petMenu: 'card'");
  ok(/'bubble'/.test(cfgjs) && /'wheel'/.test(cfgjs), '两份旧实现仍作为技术储备列在注释里');
  ok(/require\('\.\/card-menu'\)/.test(mainjs), 'main.js 引入了 card-menu');
  ok(/cardMenu\.show\(/.test(mainjs) && /cardMenu\.release\(/.test(mainjs), '分流里接了 show / release');
  ok(/cardMenu\.dispose\(\)/.test(mainjs), 'will-quit 里 dispose（轮询 + 悬停定时器必须停）');
  ok(/form === 'wheel'/.test(mainjs) && /form === 'bubble'/.test(mainjs),
    "三形态分流齐全（'wheel' / 'bubble' / 默认 card）");
  ok((mainjs.match(/function buildPetMenu\(/g) || []).length === 1,
    'buildPetMenu 只有一处定义（泡泡与卡片共用一份数据，规矩 9）');
  ok(/items\.filter\(\(it\) => !it\.sep\)/.test(mainjs),
    '泡泡那支过滤掉 {sep:true}（离散圆点没有"分隔线"这个概念）');

  ok(/POLL_MS = 16/.test(src) && /const DWELL_MS = 220/.test(src),
    '轮询 16ms ≈60fps / 悬停展开 220ms（原生菜单同量级）');
  ok(!/setInterval/.test(src), '没有 setInterval（规矩 16：自调度 + 代际令牌）');
  ok(/const my = \+\+gen/.test(src) && /if \(my !== gen\) return/.test(src),
    '代际令牌真的被比对（不只是分配）');
  ok(/if \(done\) return;/.test(src) && (src.match(/if \(done\) return/g) || []).length >= 3,
    'done 闩在多条提交路径上（幂等）');
  /* 🔴 源码级断言：dispose 函数体里三只定时器都得停。行为测不出来
   *    （dispose 之后进程多半跟着退了），只能对着函数体断言。 */
  const disposeBody = src.slice(src.indexOf('function dispose()'), src.indexOf("ipcMain.on('card:pick'"));
  ok(disposeBody.includes('stopPoll()') && disposeBody.includes('clearDwell()')
    && disposeBody.includes('clearTimeout(timeoutTimer)'),
    'dispose 函数体里停了轮询 / 悬停 / 超时三只定时器');

  /* 🔴 源码级断言（规矩 28）：悬停定时器只能在 hover **变化**时重挂。
   *    每拍都重挂的话计时永远到不了 220ms —— 而这条行为测不出来
   *    （返回值都一样），只能对着源码断言。 */
  ok(/if \(changed\) \{ sendHover\(\); scheduleDwell\(\); \}/.test(src),
    'scheduleDwell 只在 hover 变化时调用（每拍重挂 = 永远不展开）');
  ok(/if \(!\(hover && hover\.card === 'main' && hover\.i === i\)\) return;/.test(src),
    '定时器到点时再确认一次"还停在这一项"（路过不算）');

  ok(/card:show/.test(pre) && !/'menu:/.test(pre),
    'preload 用 card: 前缀（三个菜单模块共用 menu: 会互相收到对方消息）');
  ok(!/setIgnoreMouseEvents/.test(src) && !/setIgnoreMouseEvents/.test(html),
    '不做鼠标穿透（同轮盘：卡片窗自己收 click）');
  /* 子菜单翻到左侧时窗口原点会跳：先 setOpacity(0) → 等 card:painted → 再显回，
   * 否则 setBounds 与 DOM 相对坐标不同步会闪一帧。 */
  ok(/setOpacity\(0\)/.test(src) && /originMoved/.test(src),
    '窗口原点变化时先透明（防子菜单左右翻转闪主卡）');
  ok(/card:painted/.test(src) && /painted/.test(pre),
    'preload/主进程接 card:painted（页面画完再恢复不透明）');
  ok(/requestAnimationFrame[\s\S]*requestAnimationFrame[\s\S]*painted/.test(html),
    '页面两帧后再 painted（布局 + 绘制）');
  /* 进/出子菜单会重发 card:show。主卡槽位没变时不能 textContent='' 重建，
   * 也不能清 hotKey —— 否则划过有 kids 的行悬停展开时高亮会闪一帧。 */
  ok(/function slotsSame\(/.test(html) && /keepMain/.test(html) && /keepDom/.test(html),
    '槽位未变时 keepDom，不拆主卡行节点');
  ok(/if \(d\.entry\) hotKey = ''/.test(html),
    '只有首次入场才清 hotKey（进/出子菜单保留高亮）');
  /* Electron 透明窗 setBounds 会闪（#39834）。首次打开预留所有 kids 占地，
   * 进/出子菜单 bounds 不变 → 跳过 setBounds；已可见时也不再 showInactive。 */
  ok(/function pushKidsReserves\(/.test(src) && /pushKidsReserves\(rects/.test(src),
    '首次摆位并上每个 kids 子菜单占地（进/出不再改窗）');
  ok(/if \(moved\) \{\s*win\.setBounds/.test(src),
    'bounds 没变就不 setBounds');
  ok(/if \(!wasVisible\) win\.showInactive\(\)/.test(src),
    '已可见时不重复 showInactive');
}

head('G 页面');
{
  ok(/--item-h/.test(html) && /height: var\(--item-h\)/.test(html),
    '行高来自 CSS 变量，不是写死 30px');
  ok(!/height: 30px/.test(html), '页面里没有硬编码的 30px 行高（规矩 9：常量只在 geom）');
  ok(/root\.setProperty\('--item-h', m\.itemH \+ 'px'\)/.test(html),
    '几何的 ITEM_H 经 metric 下发到页面（同一处定义）');
  ok(/text-overflow: ellipsis/.test(html), '标签放不下时走省略号（不溢出卡片）');
  ok(/overflow: hidden/.test(html), '卡片裁掉圆角外的内容');
  ok(/box-shadow/.test(html) && /0 1px 2px/.test(html) && /0 4px 12px/.test(html),
    '两层柔投影（与对话气泡同一套视觉语言）');
  /* ⚠️ 先剥掉 CSS 注释再断言：注释里就写着 "不用 filter: drop-shadow"，
   *    直接对全文正则会把解释当成违规（这条我踩过）。 */
  const htmlLive = html.replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/filter:\s*drop-shadow/.test(htmlLive),
    '卡片用 box-shadow 不用 filter: drop-shadow（圆角矩形不必按合成轮廓算）');
  ok(/entry/.test(html) && /animation: grow/.test(html), '只做入场动画（关闭要立刻）');
  ok(!/textContent\s*\+?=\s*[^;]*\$\{/.test(html), '文字不拼 innerHTML（标签以后可能来自角色名/配置）');
  /* 高亮刷新必须用 classList.contains('row')：className !== 'row' 在加了 hot
   * 后会变成 "row hot" 而跳过该行，旧蓝底永远清不掉（多条同时高亮）。
   * ⚠️ 对去注释后的正文断言 —— 注释里会写旧写法当反面教材。 */
  ok(/classList\.contains\(\s*['"]row['"]\s*\)/.test(htmlLive),
    'paint 用 classList.contains("row") 识别行（避免 hot 后 className 对不上）');
  ok(!/className\s*!==\s*['"]row['"]/.test(htmlLive) && !/className\s*===\s*['"]row['"]/.test(htmlLive),
    'paint 不用 className ===/!== "row"（会漏掉已高亮行）');
}

head('H 取色与对比度');
{
  const grab = (name) => {
    const m = html.match(new RegExp('--' + name + ':\\s*(#[0-9a-fA-F]{6})'));
    return m ? m[1] : null;
  };
  const surface = grab('surface');
  const hot = grab('hot');
  const ink = grab('ink');
  const ink2 = grab('ink-2');
  const icon = grab('icon');
  ok(surface && hot && ink && ink2 && icon, `色值全部能解析（${[surface, hot, ink, ink2, icon].join(' ')})`);

  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const lum = (h) => {
    const [r, g, b] = rgb(h);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const cr = (a, b) => {
    const la = lum(a);
    const lb = lum(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };

  const need = (label, a, b, min) => {
    const v = cr(a, b);
    ok(v >= min, `${label} ${v.toFixed(2)} ≥ ${min}`);
  };
  need('正文 / 卡片面', ink, surface, 4.5);        // WCAG 1.4.3
  need('正文 / 悬停面', ink, hot, 4.5);            // 悬停时字还是那个字
  need('次级文字 / 卡片面', ink2, surface, 4.5);   // 当前值、箭头
  need('图标 / 卡片面', icon, surface, 3.0);       // WCAG 1.4.11 非文本
  /* 悬停档差：Material 的 hover state layer 是 8%（≈1.24），我们给到 1.35+，
   * 因为整行换底色比叠一层薄纱更容易看漏。 */
  need('悬停 vs 常态（要看得出来）', hot, surface, 1.35);
}

console.log(fails ? `\n${fails} 项失败\n` : '\n全部通过\n');
process.exit(fails ? 1 : 0);
