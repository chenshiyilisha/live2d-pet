'use strict';

/* 轮盘的真机验证 + 截图。
 * ⚠️ 用的是**真的** wheel.js / wheel.html，不是把几何复刻一份来测 —— 复刻出来
 *    的断言永远绿，那是骗自己。
 *
 * 用法：node_modules/electron/dist/electron.exe debug/shot-wheel.js
 * 产出：debug/pet-wheel.png（常态）、debug/pet-wheel-hot.png（高亮某一项 + 内环展开） */
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const wheel = require('../src/main/wheel.js');

const DIR = __dirname;
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 照着 main.js 的 buildPetWheel 摆一份同结构的数据（6 个外环项，两个叶子）。 */
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
    /* ⚠️ label + sub 的**两行**写法照抄 main.js：一行塞"透明 100%"会横着溢出
     *    扇区（左右两侧最窄），截图要能反映真实形态。 */
    id: 'scale', label: '大小', sub: '100%', icon: 'zoomIn',
    kids: [{ id: 's0', label: '放大' }, { id: 's1', label: '缩小' }, { id: 's2', label: '重置 100%' }]
  },
  {
    id: 'opacity', label: '透明', sub: '100%', icon: 'sun',
    kids: [1, 0.9, 0.8, 0.7].map((v, i) => ({ id: 'o' + i, label: `${Math.round(v * 100)}%` }))
  },
  { id: 'tts', label: '朗读', sub: '关', icon: 'volume2' },
  { id: 'hide', label: '隐藏', icon: 'eyeOff' }
];

async function main() {
  await app.whenReady();
  const wa = screen.getPrimaryDisplay().workArea;
  const x = Math.round(wa.x + wa.width / 2);
  const y = Math.round(wa.y + wa.height / 2);

  const picked = [];
  const actions = new Map();
  const walk = (list) => list.forEach((it) => {
    actions.set(it.id, () => picked.push(it.id));
    if (it.kids) walk(it.kids);
  });
  walk(items);

  await wheel.show(items, actions, x, y, { tint: true });
  await sleep(400);

  const st = wheel._state();
  console.log('  state', JSON.stringify({
    open: st.open, center: st.center, R: st.geom.R, n: st.n
  }));
  ok(st.open, '盘已打开');
  ok(st.n === 6, `外环 6 项（实际 ${st.n}）`);

  const w = wheel._win();
  const b = w.getBounds();
  const R = st.geom.R;
  ok(b.width === R * 2 && b.height === R * 2, `窗尺寸 = 2R（${b.width}×${b.height}，R=${R}）`);
  ok(Math.abs(b.x + R - st.center.x) <= 1 && Math.abs(b.y + R - st.center.y) <= 1,
    '窗左上角 = 盘心 − R（盘心真的落在窗正中）');
  ok(b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width,
    '整个盘在可用区内（贴边收过了）');

  /* 页面真的画出来了吗：数扇区。 */
  const counts = await w.webContents.executeJavaScript(`(() => {
    const q = (s) => document.querySelectorAll(s).length;
    return { outer: q('#outer > g'), inner: q('#inner > g'), hub: !!document.getElementById('hub') };
  })()`);
  console.log('  dom', JSON.stringify(counts));
  ok(counts.outer === 6, `#outer 里 6 个扇区（实际 ${counts.outer}）`);
  ok(counts.inner === 0, '还没高亮任何组 → 内环是空的');
  ok(counts.hub, '中心 hub 画出来了');

  /* ---- 底色：读**真实 DOM 的计算色**，不是源码里的字符串 ----
   * CSS 变量有没有真的生效、body.tint 有没有挂上、特异度顺序有没有生效，
   * 只有算出 rgb 才算数（源码断言只能证明"写了"，证明不了"生效了"）。 */
  const tint = await w.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('#outer > g');
    return {
      hasTint: document.body.classList.contains('tint'),
      outer: getComputedStyle(g.querySelector('path')).fill,
      hub: getComputedStyle(document.getElementById('hub')).fill
    };
  })()`);
  console.log('  tint', JSON.stringify(tint));
  ok(tint.hasTint, 'body.tint 已挂上（底色开关生效）');
  ok(tint.outer === 'rgb(228, 235, 247)', `外环静息 = #e4ebf7（实际 ${tint.outer}）`);
  ok(tint.hub === 'rgb(250, 251, 254)', `中心 = #fafbfe（实际 ${tint.hub}）`);

  const shot = async (name) => {
    const img = await w.capturePage();
    fs.writeFileSync(path.join(DIR, name), img.toPNG());
    return path.join(DIR, name);
  };
  console.log('  → ' + await shot('pet-wheel.png'));

  /* 高亮「表情」组 → 内环应展开 8 项；再高亮其中一个子项。
   * ⚠️ 走的是 _applyPoint（轮询用的同一个函数），不是直接给页面发 hover ——
   *    发消息只会改页面的镜像，主进程持有的命中状态没变，提交时就会空。 */
  /* 🔴 必须先停掉轮询：它每 16ms 按**真实光标**重算一次，会把我们注入的坐标
   *    覆盖掉（第一版就是这么"看起来没命中"的 —— 其实轮询在正常工作）。
   *    正常使用时光标就在盘上，不存在这个冲突。顺手把它变成一条断言：
   *    轮询真的在跑、而且真的按光标位置算。 */
  wheel._stopPoll();
  const G = require('../src/main/wheel-geom.js');
  const at = (deg, r) => {
    const a = (deg * Math.PI) / 180;
    return { x: st.center.x + Math.cos(a) * r, y: st.center.y + Math.sin(a) * r };
  };
  const p1 = at(-60, (st.geom.outerIn + st.geom.outerOut) / 2);
  const h1 = wheel._applyPoint(p1.x, p1.y);
  console.log('  applyPoint', JSON.stringify({ p1, h1, hoverNow: wheel._state().hover, geom: st.geom }));
  await sleep(120);
  const api = await w.webContents.executeJavaScript(
    `JSON.stringify({ has: !!window.wheelHost, keys: Object.keys(window.wheelHost || {}) })`
  );
  ok(/onHover/.test(api), `页面拿到了 onHover 通道（${api}）`);
  const c2 = await w.webContents.executeJavaScript(`(() => ({
    inner: document.querySelectorAll('#inner > g').length,
    hotOuter: document.querySelectorAll('#outer > g.hot').length
  }))()`);
  console.log('  hover 表情组', JSON.stringify(c2));
  ok(c2.inner === 8, `高亮表情组 → 内环展开 8 项（实际 ${c2.inner}）`);
  ok(c2.hotOuter === 1, '外环正好一个高亮');

  /* 高亮的**实际填充色**：验证 .slot.hot 真的盖住了 .slot.kid / .slot 的静息色
   * （两条规则同特异度，靠源码顺序决胜 —— 顺序写反这里立刻变回静息色）。 */
  const hotFill = await w.webContents.executeJavaScript(`(() => ({
    hotOuter: getComputedStyle(document.querySelector('#outer > g.hot path')).fill,
    innerRest: getComputedStyle(document.querySelector('#inner > g:not(.hot) path')).fill
  }))()`);
  console.log('  fills', JSON.stringify(hotFill));
  ok(hotFill.hotOuter === 'rgb(173, 201, 237)', `外环高亮 = #adc9ed（实际 ${hotFill.hotOuter}）`);
  ok(hotFill.innerRest === 'rgb(250, 251, 254)', `内环静息 = #fafbfe（实际 ${hotFill.innerRest}）`);

  /* 内环第 3 个子项：8 项均分，中心角 = -90 + (2 + 0.5) × 45 = 22.5°。 */
  const p2 = at(22.5, (st.geom.innerIn + st.geom.innerOut) / 2);
  wheel._applyPoint(p2.x, p2.y);
  await sleep(120);
  const c3 = await w.webContents.executeJavaScript(
    `document.querySelectorAll('#inner > g.hot').length`
  );
  ok(c3 === 1, `内环高亮 1 项（实际 ${c3}）`);
  console.log('  → ' + await shot('pet-wheel-hot.png'));

  /* 提交语义：停在内环子项上松手 → 真的执行那个子项。 */
  wheel.release();
  await sleep(80);
  ok(picked.length === 1 && picked[0] === 'emo2', `松手执行的是命中的子项（${JSON.stringify(picked)}）`);
  ok(!wheel.isOpen(), '提交后盘已关');

  /* 幂等：再来一次 release 不该重复执行。 */
  wheel.release();
  ok(picked.length === 1, `重复的松手不会重复执行（仍 ${picked.length} 次）`);

  /* 取消语义：停在死区 → 什么都不执行。 */
  await wheel.show(items, actions, x, y, { tint: true });
  await sleep(200);
  wheel.release();
  await sleep(80);
  ok(picked.length === 1, '死区里松手 = 取消（没有多出一次执行）');

  /* 关掉底色 → 退回纯白（与气泡完全一致那套）。开关真的能关，不是摆设。 */
  await wheel.show(items, actions, x, y, { tint: false });
  await sleep(250);
  const off = await w.webContents.executeJavaScript(`(() => ({
    hasTint: document.body.classList.contains('tint'),
    outer: getComputedStyle(document.querySelector('#outer > g path')).fill
  }))()`);
  console.log('  tint-off', JSON.stringify(off));
  ok(!off.hasTint, '关掉后 body.tint 摘掉了');
  ok(off.outer === 'rgb(255, 255, 255)', `关掉底色 → 外环回纯白（实际 ${off.outer}）`);
  wheel.release();

  wheel.dispose();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.quit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); app.quit(1); });
