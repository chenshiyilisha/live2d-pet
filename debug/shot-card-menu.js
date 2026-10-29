'use strict';

/* 光标处卡片菜单的真机验证 + 截图。
 * ⚠️ 用的是**真的** card-menu.js / card-menu.html，不是把几何复刻一份来测。
 *
 * 用法：node_modules/electron/dist/electron.exe debug/shot-card-menu.js
 * 产出：debug/pet-card-menu.png（一级）、debug/pet-card-menu-sub.png（表情子菜单） */
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const menu = require('../src/main/card-menu.js');

const DIR = __dirname;
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 照着 main.js 的 buildPetMenu 摆一份同结构的数据（含两条分隔线）。 */
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
  { sep: true },
  {
    id: 'look', label: '外观', icon: 'zoomIn',
    kids: [{ id: 'l0', label: '放大' }, { id: 'l1', label: '缩小' },
      { id: 'l2', label: '重置 100%' }, { id: 'l3', label: '更透明' }]
  },
  { id: 'tts', label: '朗读', sub: '关', icon: 'volume2' },
  { sep: true },
  { id: 'hide', label: '隐藏', icon: 'eyeOff' }
];

async function main() {
  await app.whenReady();
  const wa = screen.getPrimaryDisplay().workArea;

  const picked = [];
  const actions = new Map();
  const walk = (list) => list.forEach((it) => {
    if (it.sep) return;
    actions.set(it.id, () => picked.push(it.id));
    if (it.kids) walk(it.kids);
  });
  walk(items);

  /* 光标放在屏幕中央偏左下 —— 卡片往右下展开，正好不贴边（贴边翻转由
   * verify-card-menu [B] 用纯函数覆盖）。 */
  const at = { x: Math.round(wa.x + wa.width * 0.42), y: Math.round(wa.y + wa.height * 0.42) };

  await menu.show(items, actions, at, { tint: true });
  await sleep(400);

  const st = menu._state();
  console.log('  state', JSON.stringify({ open: st.open, n: st.n, box: st.box, posMain: st.posMain }));
  ok(st.open, '菜单已打开');
  ok(st.n === 7, `顶层 7 个槽位（5 项 + 2 条分隔线，实际 ${st.n}）`);
  ok(!st.sub, '一开始没有子菜单');

  const w = menu._win();
  /* ⚠️ 比 **contentBounds** 不是 getBounds：本机 scaleFactor=1.5，
   *    getBounds() 会把尺寸报大 1px（DIP→物理像素取整），跟代码对错无关。 */
  const b = w.getContentBounds();
  const near = (p, q) => Math.abs(p - q) <= 1;
  ok(near(b.width, st.box.width) && near(b.height, st.box.height)
    && near(b.x, st.box.x) && near(b.y, st.box.y),
    `窗口内容区 = 摆位算出的 box（${b.width}×${b.height} vs ${st.box.width}×${st.box.height}）`);
  ok(b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width
    && b.y + b.height <= wa.y + wa.height, '整卡在可用区内');

  /* 卡片左上角相对光标：+2 / +4（HIG 的"光标右下"）。 */
  ok(near(st.posMain.x, at.x + 2) && near(st.posMain.y, at.y + 4),
    `卡片贴光标右下（${st.posMain.x},${st.posMain.y} vs 光标 ${at.x},${at.y}）`);

  const dom = await w.webContents.executeJavaScript(`(() => {
    const card = document.getElementById('main');
    const rows = [...card.querySelectorAll('.row')];
    const seps = [...card.querySelectorAll('.sep')];
    return {
      rows: rows.length,
      seps: seps.length,
      icons: card.querySelectorAll('.ico svg').length,
      chevs: card.querySelectorAll('.chev').length,
      cardW: card.offsetWidth,
      cardH: card.offsetHeight,
      rowH: rows[0].offsetHeight,
      sepH: seps[0] ? seps[0].offsetHeight : -1,
      sepLineH: seps[0] ? seps[0].getBoundingClientRect().height : -1,
      labels: rows.map((r) => r.querySelector('.lb').textContent),
      /* 🔴 主进程只能**估**字宽（拿不到 DOM）。这里用真实行盒反查：
       *    scrollWidth > clientWidth 说明估窄了、字被省略号吃掉。 */
      clipped: rows.filter((r) => {
        const lb = r.querySelector('.lb');
        return lb.scrollWidth > lb.clientWidth + 1;
      }).map((r) => r.querySelector('.lb').textContent),
      subShown: document.getElementById('sub').style.display
    };
  })()`);
  console.log('  dom', JSON.stringify(dom));
  ok(dom.rows === 5, `画了 5 行（实际 ${dom.rows}）`);
  ok(dom.seps === 2, `2 条分隔线（实际 ${dom.seps}）`);
  ok(dom.icons === 5, `5 个图标都画出来了（Lucide 路径没缺，实际 ${dom.icons}）`);
  ok(dom.chevs === 3, `3 个带子项的项有箭头（实际 ${dom.chevs}）`);
  ok(dom.cardH === 180 && dom.cardW === 176, `卡片 ${dom.cardW}×${dom.cardH}（几何算的 176×180）`);
  ok(dom.rowH === 30, `行高 ${dom.rowH} = 几何 ITEM_H（CSS 变量下发，页面没写死）`);
  ok(dom.sepH === 9, `分隔线占位 ${dom.sepH} = SEP_H`);
  ok(dom.clipped.length === 0, `没有标签被省略号吃掉（估宽够用；${JSON.stringify(dom.clipped)}）`);
  ok(dom.labels.join(',') === '表情,动作,外观,朗读,隐藏', `行序与数据一致：${dom.labels.join(' / ')}`);
  ok(dom.subShown === 'none', '子菜单卡片一开始不显示');

  /* ⚠️ capturePage 偶发 UnknownVizError（窗刚建、合成器没出帧）→ 重试 3 次。
   *    截图不是被测对象，但连着三次拿不到帧就是真问题，所以第三次仍失败直接抛。 */
  const shot = async (name) => {
    let last = null;
    for (let i = 0; i < 3; i++) {
      try {
        const img = await w.capturePage();
        fs.writeFileSync(path.join(DIR, name), img.toPNG());
        return path.join(DIR, name);
      } catch (e) { last = e; await sleep(300); }
    }
    throw last;
  };
  console.log('  → ' + await shot('pet-card-menu.png'));

  /* 命中：走 _applyPoint（轮询用的同一个函数）。
   * 🔴 必须先停轮询：它每 16ms 按**真实光标**重算，会把注入坐标覆盖掉。 */
  menu._stopPoll();
  const p0 = await w.webContents.executeJavaScript(`(() => {
    const r = document.querySelectorAll('#main .row')[0].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  menu._applyPoint(b.x + p0.x, b.y + p0.y);
  await sleep(120);
  const hot = await w.webContents.executeJavaScript(`(() => ({
    n: document.querySelectorAll('#main .row.hot').length,
    bg: getComputedStyle(document.querySelector('#main .row.hot')).backgroundColor,
    sub: document.getElementById('sub').style.display
  }))()`);
  console.log('  hot', JSON.stringify(hot));
  ok(hot.n === 1, `高亮正好 1 行（实际 ${hot.n}）`);
  ok(hot.bg === 'rgb(173, 201, 237)', `悬停 = #adc9ed（实际 ${hot.bg}）`);
  /* 「表情」有子项 → 停住 220ms 自己展开（dwell），不用点。 */
  await sleep(320);
  const st2 = menu._state();
  console.log('  sub', JSON.stringify({ sub: st2.sub, parentIdx: st2.parentIdx }));
  ok(Array.isArray(st2.sub) && st2.sub.length === 8, `悬停 220ms 自动展开表情子菜单（${st2.sub && st2.sub.length} 项）`);
  ok(st2.parentIdx === 0, '子菜单挂在「表情」上（parentIdx=0）');
  ok(st2.sizeSub && st2.sizeSub.w > 0, '子卡片有尺寸');

  const subDom = await w.webContents.executeJavaScript(`(() => {
    const s = document.getElementById('sub');
    const rows = [...s.querySelectorAll('.row')];
    return {
      shown: s.style.display !== 'none',
      rows: rows.length,
      labels: rows.map((r) => r.querySelector('.lb').textContent),
      top: s.offsetTop,
      left: s.offsetLeft,
      w: s.offsetWidth,
      clipped: rows.filter((r) => {
        const lb = r.querySelector('.lb');
        return lb.scrollWidth > lb.clientWidth + 1;
      }).length
    };
  })()`);
  console.log('  subDom', JSON.stringify(subDom));
  ok(subDom.shown && subDom.rows === 8, `子卡片画了 8 行（实际 ${subDom.rows}）`);
  ok(subDom.labels[0] === '平静', `子项顺序正确（首项 ${subDom.labels[0]}）`);
  ok(subDom.clipped === 0, '子项文字也没被截断');
  ok(subDom.left > dom.cardW, `子卡片在父卡片右侧（left ${subDom.left} > 卡宽 ${dom.cardW}）`);
  const grew = w.getContentBounds();
  ok(grew.width > b.width, `开子菜单时窗口跟着变宽（${b.width} → ${grew.width}）`);

  console.log('  → ' + await shot('pet-card-menu-sub.png'));

  /* 桥接区：卡片右沿到子卡片左沿那条缝里，选择不能丢。 */
  /* 缝在"父卡片右沿"和"子卡片左沿"之间 —— 卡片左沿 = 窗口内 16px（阴影留白），
   * 所以不能拿 b.x + 卡宽 直接算（那会落在卡片里，测了个假的桥接）。 */
  const padX = st.posMain.x - b.x;
  const bridge = { x: b.x + padX + dom.cardW + 3, y: b.y + subDom.top + 20 };
  menu._applyPoint(bridge.x, bridge.y);
  await sleep(100);
  const stB = menu._state();
  ok(stB.sub && stB.hover.i === 0, `缝里划过时子菜单不关、仍指向父项（sub=${!!stB.sub} i=${stB.hover.i}）`);

  /* 子项命中 + **真点击**：用 sendInputEvent 走浏览器真实事件链
   * （不是直接调 _activate —— 那只能证明函数能算，证明不了点击能到达页面）。 */
  const pSub = await w.webContents.executeJavaScript(`(() => {
    const r = document.querySelectorAll('#sub .row')[1].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  w.webContents.sendInputEvent({ type: 'mouseDown', x: pSub.x, y: pSub.y, button: 'left', clickCount: 1 });
  w.webContents.sendInputEvent({ type: 'mouseUp', x: pSub.x, y: pSub.y, button: 'left', clickCount: 1 });
  await sleep(200);
  console.log('  picked', JSON.stringify(picked));
  ok(picked.length === 1 && picked[0] === 'emo1', `点「开心」→ 真的执行了（${JSON.stringify(picked)}）`);
  ok(!menu.isOpen(), '点完就关（不是留在那儿）');
  menu._activate({ card: 'sub', i: 0 });
  ok(picked.length === 1, `关掉之后再点被 done 闩挡住（仍 ${picked.length} 次）`);

  /* 换顶层项 → 子菜单立刻收（原生菜单就是这样，不用等）。 */
  await menu.show(items, actions, at, { tint: true });
  await sleep(250);
  menu._stopPoll();
  const p0b = await w.webContents.executeJavaScript(`(() => {
    const r = document.querySelectorAll('#main .row')[0].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  menu._applyPoint(b.x + p0b.x, b.y + p0b.y);
  await sleep(320);
  ok(menu._state().sub, '（准备）表情子菜单已展开');
  const p1 = await w.webContents.executeJavaScript(`(() => {
    const r = document.querySelectorAll('#main .row')[1].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  menu._applyPoint(b.x + p1.x, b.y + p1.y);
  await sleep(120);
  const st3 = menu._state();
  ok(!st3.sub, '移到「动作」上 → 表情子菜单立刻收（不叠着两张卡）');
  ok(st3.hover.i === 1, '高亮跟到「动作」');

  /* 常驻态：没划就松手 → 卡片留着等点击（新手兜底）。
   * 🔴 真机上 anchor（renderer 报的 mousedown 坐标）就是光标位置，所以"没划"=
   *    位移为 0。脚本没法移动系统光标，只能反过来把锚点设在**真实光标**上 ——
   *    这样 release() 算出来的位移才是 0，测到的才是那条真路径（在别处开、
   *    然后期望位移为 0 是假测试：那本来就是"划了一大段"）。 */
  const cp = screen.getCursorScreenPoint();
  await menu.show(items, actions, cp, { tint: true });
  await sleep(250);
  menu._stopPoll();
  menu.release();
  await sleep(80);
  const st4 = menu._state();
  ok(st4.open && st4.sticky, `没划就松手 → 常驻态（open=${st4.open} sticky=${st4.sticky}）`);

  /* 常驻态下点叶子项「朗读」→ 执行。 */
  const p4 = await w.webContents.executeJavaScript(`(() => {
    const r = document.querySelectorAll('#main .row')[3].getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  w.webContents.sendInputEvent({ type: 'mouseDown', x: p4.x, y: p4.y, button: 'left', clickCount: 1 });
  w.webContents.sendInputEvent({ type: 'mouseUp', x: p4.x, y: p4.y, button: 'left', clickCount: 1 });
  await sleep(200);
  ok(picked.length === 2 && picked[1] === 'tts', `常驻态点「朗读」→ 执行（${JSON.stringify(picked)}）`);

  /* 第二次右键松手 = 关掉（不执行）。 */
  await menu.show(items, actions, cp, { tint: true });
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
