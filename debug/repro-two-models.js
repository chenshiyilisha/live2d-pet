'use strict';

/* ============================================================
 *  「底座出现时一大一小两个她」的受控复现
 * ==========================================================
 *
 * 背景：上次（2026-10-28）的修复只在**源码层**被验证过（verify-resize-clear.js），
 * 真机从来没验过 —— 用户 2026-10-29 报告**还在复现**。这次必须抓到实况。
 *
 * 为什么这样搭：残留只在**窗口的合成面**（DWM composited surface）上，
 * capturePage / Page.captureScreenshot 拿的都是页面重绘后的新内容，看不见它。
 * 唯一能看见它的是 desktopCapturer 抓**窗口**。
 *
 * 流程：
 *   1. 用真的 server.js 起静态服务（真 index.html + 真 Cubism）
 *   2. 真窗口（transparent + preserveDrawingBuffer 同 app）
 *   3. 等模型挂载 → 抓「before」
 *   4. 模拟底座出现：--stats-h 0→150 + resize 事件
 *      （与 setStatsReserve 走**同一条下游路径**：改 CSS 变量 → layout()）
 *   5. 抓「pedestal」→ 再切回 0 → 抓「gone」
 *
 * ⚠️ 会弹一个可见窗口十几秒（截图探针必须可见，PET_HIDDEN 截不到）。
 * 跑法：node_modules/electron/dist/electron.exe debug/repro-two-models.js
 * ========================================================== */
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { startLocalServer } = require('../src/main/server.js');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');   // 照抄 main.js：aTrust 注入会崩 GPU 进程

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(win, name) {
  /* ⚠️ 用 **screen** 源 + 裁剪，不用 window 源：本机 window 源在画布 resize
   *    之后会返回黑帧（抓窗路径失效），而我们要看的恰恰是 resize 之后。 */
  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const sf = d.scaleFactor;
  const ds = d.size;
  const full = { width: Math.round(ds.width * sf), height: Math.round(ds.height * sf) };
  const list = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: full });
  const src = list.find((x) => String(x.display_id) === String(d.id)) || list[0];
  if (!src) { console.log('FAIL 没有 screen 源'); return null; }
  const img = src.thumbnail;
  const crop = {
    x: Math.round((b.x - d.bounds.x) * sf),
    y: Math.round((b.y - d.bounds.y) * sf),
    width: Math.round(b.width * sf),
    height: Math.round(b.height * sf)
  };
  const out = img.crop(crop);
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, out.toPNG());
  console.log('  → ' + name + '  ' + JSON.stringify(out.getSize()));
  return p;
}

app.whenReady().then(async () => {
  const srv = await startLocalServer(path.join(__dirname, '..'), {
    coreCacheFile: path.join(app.getPath('userData'), 'cache', 'live2dcubismcore.min.js')
  });
  const port = srv.address().port;

  const win = new BrowserWindow({
    width: 320,
    height: 620,
    x: 60,
    y: 60,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    title: 'PETCAP',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (_e, _lv, msg) => {
    if (/model (ready|mounted)|statsReserve|Error|error/.test(msg)) console.log('  [page]', msg.slice(0, 160));
  });
  await win.loadURL(`http://127.0.0.1:${port}/src/renderer/index.html`);
  await sleep(9000);                       // 等模型挂载 + 首帧

  console.log('[1] 底座出现前');
  await capture(win, 'two-0-before.png');

  console.log('[2] 模拟底座出现（--stats-h 0→150）→ 连拍抓瞬态');
  await win.webContents.executeJavaScript(
    `document.body.style.setProperty('--stats-h','150px'); window.dispatchEvent(new Event('resize')); 'ok'`);
  for (let i = 0; i < 14; i++) {
    await capture(win, `burst-${String(i).padStart(2, '0')}.png`);
    await sleep(90);
  }

  console.log('[3] 底座消失（--stats-h → 0）');
  await win.webContents.executeJavaScript(
    `document.body.style.setProperty('--stats-h','0px'); window.dispatchEvent(new Event('resize')); 'ok'`);
  await sleep(800);
  await capture(win, 'two-2-gone.png');

  const st = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('canvas');
    return { canvases: document.querySelectorAll('canvas').length,
             css: [c.style.width, c.style.height],
             buf: [c.width, c.height] };
  })()`);
  console.log('  page state', JSON.stringify(st));

  win.destroy();
  app.quit(0);
}).catch((e) => { console.error(e); app.quit(1); });
