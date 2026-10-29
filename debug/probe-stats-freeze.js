'use strict';

/* ============================================================
 *  「加载底座不再改人物大小」的真机探针（2026-10-29）
 * ==========================================================
 *
 *  用户定稿：「始终是加了底座时的大小，这样就不用担心加载底座后大小切换的
 *  问题」—— 落地就是把 --stats-h 在 boot 里冻结成"牌摆满"那一档，
 *  之后转圈 / 出数 / 开关悬浮显示都不再动它。
 *
 *  为什么不能用真 app 验：主进程的 stats 推送有 `mainWindow.isVisible()` 门
 *  （main.js 的 push），用 PET_HIDDEN=1 跑就永远收不到 monitor:stats，
 *  底座根本不会出现。所以这里自己起一个**不显示**的窗口 + 真 preload +
 *  真 index.html，由本脚本直接 webContents.send 送数据 —— 渲染路径完全一样，
 *  但不需要窗口可见。
 *
 *  验的是三件事：
 *    1) --stats-h 全程只有一个值（转圈 → 出数 → 关掉开关都不变）
 *    2) canvas 缓冲尺寸全程只有一个值（= 一次 resize 都没发生）
 *    3) [pet] canvasResize 日志在整个过程里 0 行
 *
 *  跑法：node_modules/electron/dist/electron.exe debug/probe-stats-freeze.js
 *  ⚠️ 不需要屏幕可见；跑完自己退出（退出码 0 = 全绿）。
 * ========================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { startLocalServer } = require('../src/main/server.js');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 假配置：只给渲染层真正会读的那几项。floating=true 才会走底座的完整路径。 */
let fakeCfg = {
  monitor: { floating: true, intervalMs: 3000 },
  appearance: { scale: 1, opacity: 1 },
  chat: { floatBubble: false },   // 不弹气泡窗（探针里没有 bubble 服务）
  tts: { enabled: false },
  llm: { apiKey: '' }
};
ipcMain.handle('config:get', () => fakeCfg);
ipcMain.handle('history:load', () => []);
ipcMain.handle('history:save', () => ({ ok: true }));

/* 底座四项，形状与 sysinfo 的返回值一致（见 pet.js 的 STAT_ITEMS） */
const SAMPLE = { cpu: 12, mem: { percent: 41 }, gpu: 3, tempC: 47 };

let fails = 0;
const ok = (cond, msg) => {
  console.log(cond ? '  PASS ' + msg : '  FAIL ' + msg);
  if (!cond) fails++;
};

app.whenReady().then(async () => {
  const srv = await startLocalServer(path.join(__dirname, '..'), {
    coreCacheFile: path.join(app.getPath('userData'), 'cache', 'live2dcubismcore.min.js')
  });
  const port = srv.address().port;

  const win = new BrowserWindow({
    width: 320, height: 360, show: false,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  });

  /* ⚠️ 首帧那次 resize 是**不可避免**的：画布从 0 建起来，第一次 layout() 必然
   *    要设一次尺寸。要验的是"**除了首帧之外**再没有第二次"。
   *    判据用日志顺序：canvasResize 必须排在 model ready **之前**。 */
  const events = [];
  win.webContents.on('console-message', (...args) => {
    const msg = typeof args[1] === 'string' ? args[1] : (args[2] || '');
    if (/canvasResize/.test(msg)) events.push({ k: 'resize', msg });
    if (/model ready/.test(msg)) events.push({ k: 'ready', msg });
    if (/statsReserve frozen|canvasResize|model ready/.test(msg)) {
      console.log('  [page]', String(msg).slice(0, 170));
    }
  });

  await win.loadURL(`http://127.0.0.1:${port}/src/renderer/index.html`);

  /* 等模型挂好（window.app 由 pet.js 自己挂；stage 上有 holder 才说明真挂上了） */
  for (let i = 0; i < 60; i++) {
    const ready = await win.webContents.executeJavaScript(
      `!!(window.app && window.app.stage && window.app.stage.children.length)`).catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(1200);          // 让首帧几何稳定

  const snap = (tag) => win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('canvas');
    const st = document.getElementById('stage');
    const pl = document.querySelector('#stats .plate');
    return {
      tag: ${JSON.stringify(tag)},
      reserve: getComputedStyle(document.body).getPropertyValue('--stats-h').trim(),
      stageH: st ? st.clientHeight : null,
      buf: c ? [c.width, c.height] : null,
      plateH: pl ? Math.round(pl.getBoundingClientRect().height) : null,
      loading: !!pl && pl.classList.contains('loading'),
      text: (pl ? pl.textContent : '').trim(),
      items: document.querySelectorAll('#stats .item').length
    };
  })()`);

  const s0 = await snap('boot');                    // 应当已是"牌摆满"的预留
  console.log('  ① boot', JSON.stringify(s0));

  /* 加载态：boot 里 scheduleStatsLoading 300ms 后摆转圈，这里手动再摆一次
   * （用真 builder，和真机一模一样），量完再等它落到出数态。 */
  await win.webContents.executeJavaScript('window.app && 1');
  await sleep(500);
  const s1 = await snap('loading');

  win.webContents.send('monitor:stats', SAMPLE);    // 出数
  await sleep(900);
  const s2 = await snap('data');
  console.log('  ② 出数后', JSON.stringify(s2));

  /* 关掉悬浮显示：只藏牌，不该还高度（以前这里会 setStatsReserve(0) → 人物放大） */
  fakeCfg = { ...fakeCfg, monitor: { floating: false, intervalMs: 3000 } };
  win.webContents.send('config:changed');
  await sleep(900);
  const s3 = await snap('off');
  console.log('  ③ 关掉悬浮显示', JSON.stringify(s3));

  const uniq = (arr) => [...new Set(arr.map((x) => JSON.stringify(x)))];

  console.log('[A] --stats-h 全程冻结');
  ok(s0.reserve !== '0px' && s0.reserve !== '', `boot 就有预留（实测 ${s0.reserve}）`);
  ok(uniq([s0, s1, s2, s3].map((s) => s.reserve)).length === 1,
    `转圈 / 出数 / 关开关 都还是同一个值（实测 ${uniq([s0, s1, s2, s3].map((s) => s.reserve)).join(' / ')}）`);

  console.log('[B] canvas 尺寸全程不变（= 0 次 resize）');
  ok(uniq([s0, s1, s2, s3].map((s) => s.buf)).length === 1,
    `canvas 缓冲只有一个尺寸（实测 ${uniq([s0, s1, s2, s3].map((s) => s.buf)).join(' / ')}）`);
  ok(uniq([s0, s1, s2, s3].map((s) => s.stageH)).length === 1,
    `舞台高也只有一个值（实测 ${uniq([s0, s1, s2, s3].map((s) => s.stageH)).join(' / ')}）`);
  const iReady = events.findIndex((e) => e.k === 'ready');
  const late = events.filter((e, i) => e.k === 'resize' && (iReady < 0 || i > iReady));
  ok(late.length === 0,
    `首帧之后没有第二次 resize（全程 ${events.filter((e) => e.k === 'resize').length} 次，` +
    `其中排在建模型之后 ${late.length} 次 → 应为 0）`);

  console.log('[C] 牌本身确实在动（否则上面三条会"因为什么都没发生"而假绿）');
  ok(s2.items > 0 && s2.text.length > 0, `出数后牌里有字：「${s2.text}」，${s2.items} 格`);
  ok(s2.loading === false, '出数后不再是转圈态');
  ok(s3.reserve === s0.reserve, '关掉之后预留高度没还回去（人物不会因此变大）');

  win.destroy();
  srv.close();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.exit(fails === 0 ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
