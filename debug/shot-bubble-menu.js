'use strict';

/* 头顶泡泡菜单的真机验证 + 截图。
 * ⚠️ 用的是**真的** bubble-menu.js / bubble-menu.html，不是把几何复刻一份来测。
 *
 * 用法：node_modules/electron/dist/electron.exe debug/shot-bubble-menu.js
 * 产出：debug/pet-bubble-menu.png（一级）、debug/pet-bubble-menu-lv2.png（表情子排） */
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const menu = require('../src/main/bubble-menu.js');

const DIR = __dirname;
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 照着 main.js 的 buildPetBubble 摆一份同结构的数据（5 项，3 项带子项）。 */
const items = [
  {
    id: 'emo', label: '表情', icon: 'smile',
    kids: ['平静', '开心', '微笑', '思考', '害羞', '认真', '惊讶', '困倦']
      .map((label, i) => ({ id: 'emo' + i, label }))
  },
  {
    id: 'motion', label: '动作', icon: 'hand',
    kids: [{ id: 'm0', label: '打个招呼' }, { id: 'm1', label: '随便动动' }]
  },
  {
    id: 'look', label: '外观', icon: 'zoomIn',
    kids: [{ id: 'l0', label: '放大' }, { id: 'l1', label: '缩小' },
      { id: 'l2', label: '重置 100%' }, { id: 'l3', label: '更透明' }]
  },
  { id: 'tts', label: '朗读', sub: '关', icon: 'volume2' },
  { id: 'hide', label: '隐藏', icon: 'eyeOff' }
];

async function main() {
  await app.whenReady();
  const wa = screen.getPrimaryDisplay().workArea;
  /* 锚点 = "她头顶"（真机上由 bubble.headAnchor 给，这里取屏幕中央偏下，
   * 让整排泡泡有地方展开）。 */
  const head = { x: Math.round(wa.x + wa.width / 2), y: Math.round(wa.y + wa.height * 0.62) };

  const picked = [];
  const actions = new Map();
  const walk = (list) => list.forEach((it) => {
    actions.set(it.id, () => picked.push(it.id));
    if (it.kids) walk(it.kids);
  });
  walk(items);

  await menu.show(items, actions, head, { tint: true });
  await sleep(400);

  const st = menu._state();
  console.log('  state', JSON.stringify({ open: st.open, n: st.n, level: st.level, box: st.box }));
  ok(st.open, '菜单已打开');
  ok(st.n === 5, `顶层 5 项（实际 ${st.n}）`);
  ok(st.level === 1, '一开始在第一级');

  const w = menu._win();
  /* ⚠️ 比的是 **contentBounds** 不是 getBounds：本机 scaleFactor=1.5，
   *    getBounds() 会把 278 报成 279（DIP→物理像素的取整差），跟代码对错无关。
   *    规矩 20 本来也规定锚 contentBounds。 */
  const b = w.getContentBounds();
  const boxEq = (p, q) => Math.abs(p.width - q.width) <= 1 && Math.abs(p.height - q.height) <= 1
    && Math.abs(p.x - q.x) <= 1 && Math.abs(p.y - q.y) <= 1;
  ok(boxEq(b, st.box), `窗口内容区 = 摆位算出的 box（${b.width}×${b.height} vs ${st.box.width}×${st.box.height}）`);
  ok(b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width
    && b.y + b.height <= wa.y + wa.height, '整排在可用区内（贴边收过了）');

  const dom = await w.webContents.executeJavaScript(`(() => ({
    bubbles: document.querySelectorAll('#row > g.bb').length,
    discs: document.querySelectorAll('.disc').length,
    tails: document.querySelectorAll('.tail').length,
    icons: document.querySelectorAll('.ic').length,
    lv: document.getElementById('row').getAttribute('class')
  }))()`);
  console.log('  dom', JSON.stringify(dom));
  ok(dom.bubbles === 5, `画了 5 个泡泡（实际 ${dom.bubbles}）`);
  ok(dom.discs === 5, '每个泡泡都有盘面');
  ok(dom.icons === 5, '5 个图标都画出来了（Lucide 路径没缺）');
  ok(dom.tails === 1, `尾巴只挂 1 个泡泡（实际 ${dom.tails}）`);
  ok(dom.lv === 'lv1', '一级用的是一级配色');

  /* ⚠️ capturePage 偶发 UnknownVizError（窗刚建好、合成器还没出帧）—— 重试两次。
   *    这不是"掩盖失败"：截图本身不是被测对象，被测的是摆位 / 命中 / 两级语义；
   *    但连着三次都拿不到帧那就是真出问题了，所以第三次仍失败就直接抛。 */
  const shot = async (name) => {
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        const img = await w.capturePage();
        fs.writeFileSync(path.join(DIR, name), img.toPNG());
        return path.join(DIR, name);
      } catch (e) {
        last = e;
        await sleep(300);
      }
    }
    throw last;
  };
  console.log('  → ' + await shot('pet-bubble-menu.png'));

  /* 命中：走 _applyPoint（轮询用的同一个函数）。
   * 🔴 必须先停轮询：它每 16ms 按**真实光标**重算一次，会把注入的坐标覆盖掉
   *    （轮盘那次踩过）。正常使用时光标就在盘上，不存在这个冲突。 */
  menu._stopPoll();
  menu._applyPoint(st.pts[2].x, st.pts[2].y);
  await sleep(120);
  const h2 = await w.webContents.executeJavaScript(
    `document.querySelectorAll('#row > g.bb.hot').length`
  );
  ok(h2 === 1, `高亮正好 1 个（实际 ${h2}）`);
  const fill = await w.webContents.executeJavaScript(`(() => ({
    hot: getComputedStyle(document.querySelector('#row > g.bb.hot .disc')).fill,
    rest: getComputedStyle(document.querySelector('#row > g.bb:not(.hot) .disc')).fill
  }))()`);
  console.log('  fill', JSON.stringify(fill));
  ok(fill.hot === 'rgb(173, 201, 237)', `悬停 = #adc9ed（实际 ${fill.hot}）`);
  ok(fill.rest === 'rgb(228, 235, 247)', `静息 = #e4ebf7（实际 ${fill.rest}）`);

  /* 进子项：整排**原地换**（表情 8 + 返回 = 9）。 */
  menu._applyPoint(st.pts[0].x, st.pts[0].y);
  menu._activate(0);
  await sleep(300);
  const st2 = menu._state();
  console.log('  lv2', JSON.stringify({ n: st2.n, level: st2.level }));
  ok(st2.n === 9, `表情子排 9 项（8 个表情 + 返回，实际 ${st2.n}）`);
  ok(st2.level === 2, '进到第二级');
  ok(st2.open, '进子项时菜单不关（还要再选一次）');
  const dom2 = await w.webContents.executeJavaScript(`(() => ({
    bubbles: document.querySelectorAll('#row > g.bb').length,
    lv: document.getElementById('row').getAttribute('class'),
    first: document.querySelector('#row > g.bb text').textContent
  }))()`);
  console.log('  dom2', JSON.stringify(dom2));
  ok(dom2.first === '返回', `子排第一项是「返回」（实际 ${dom2.first}）`);
  ok(dom2.lv === 'lv2', '二级用的是二级配色（层级感）');
  const lv2Fill = await w.webContents.executeJavaScript(
    `getComputedStyle(document.querySelector('#row > g.bb:not(.hot) .disc')).fill`
  );
  ok(lv2Fill === 'rgb(250, 251, 254)', `二级底 = #fafbfe（实际 ${lv2Fill}）`);
  console.log('  → ' + await shot('pet-bubble-menu-lv2.png'));

  /* 返回：回第一级。 */
  menu.back();
  await sleep(250);
  const st3 = menu._state();
  ok(st3.n === 5 && st3.level === 1, `返回后回到 5 项第一级（${st3.n} / lv${st3.level}）`);

  /* 叶子项执行：隐藏（第 5 个）。 */
  menu._activate(4);
  await sleep(120);
  ok(picked.length === 1 && picked[0] === 'hide', `选中叶子 → 真的执行了（${JSON.stringify(picked)}）`);
  ok(!menu.isOpen(), '执行后菜单已关');
  menu._activate(4);
  ok(picked.length === 1, `重复执行被 done 闩挡住（仍 ${picked.length} 次）`);

  /* 常驻态：没划就松手 → 菜单留在那儿等点击（新手兜底）。
   * ⚠️ 脚本里没法真的移动系统光标，所以这里 release() 算出来的位移必然 <
   *    GESTURE_MIN —— 正好把常驻态这条路径测到了。 */
  await menu.show(items, actions, head, { tint: true });
  await sleep(250);
  menu.release();
  await sleep(80);
  const st4 = menu._state();
  ok(st4.open && st4.sticky, `没划就松手 → 进常驻态（open=${st4.open} sticky=${st4.sticky}）`);
  menu._activate(4);
  await sleep(80);
  ok(picked.length === 2, `常驻态下点一项也能执行（共 ${picked.length} 次）`);
  /* 第二次右键松手 = 关掉。 */
  await menu.show(items, actions, head, { tint: true });
  await sleep(250);
  menu.release();
  menu.release();
  await sleep(80);
  ok(!menu.isOpen(), '第二次右键松手 = 关掉');
  ok(picked.length === 2, '关掉不算执行（没有多出一次）');

  menu.dispose();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.quit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); app.quit(1); });
