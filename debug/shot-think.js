'use strict';

/* ============================================================
 *  气泡窗「内心想法」观感截图
 * ==========================================================
 *
 *  为什么单独做这个：llm.js 那层只能证明「标签被正确剥离、走了独立通道」，
 *  证明不了「那一行看起来对不对」—— 字号、灰度、虚线疏密、和正文的比例，
 *  这些只有看图才知道（规矩 15：每个里程碑留一张能看清的图）。
 *
 *  本机装了深信服 aTrust 时，GPU 进程会被注入打崩（exit_code=-1073741819）。
 *  项目自己的解法**不是**禁用 GPU，而是把沙箱整体关掉（见 main.js 的
 *  「GPU / GL 后端选择」段：崩的是沙箱进程，aTrustAgent 往进程里注入 DLL，
 *  权限最低的沙箱进程最先被打成访问冲突）。这里照抄同一组开关 ——
 *  千万别改成 disableHardwareAcceleration()：那会让合成的 alpha 静默失效，
 *  透明气泡截图变成一块白底。
 *
 *  用法： env -u ELECTRON_RUN_AS_NODE npx electron debug/shot-think.js
 *  产物： debug/pet-bubble-think.png（RGBA，透明底）
 * ========================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const WIDTH = 272;      // 与 bubble.js 的 WIDTH 一致
const MIN_H = 56;
const MAX_H = 340;
const OUT = path.join(__dirname, 'pet-bubble-think.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 一段"真实形状"的回复：想法在开头一句，正文两三句。
 * 正文故意写长一点，好看清想法那一行和正文的视觉比例。 */
const THINK = '又是这个方案，他今天第三次问了';
const BODY = '我在呢。那个方案我看过了，改起来不难，主要是把超时那一段抽出来。';

app.whenReady().then(async () => {
  let h = MIN_H;

  const win = new BrowserWindow({
    width: WIDTH,
    height: h,
    x: 40,
    y: 40,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'bubble-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  /* 复刻 bubble.js 的高度联动：渲染层报多高，窗口就多高 ——
   * 不比一次的话截图会缺一块（气泡往上长，窗口没跟上）。 */
  ipcMain.on('bubble:height', (_e, v) => {
    const n = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(v) || MIN_H)));
    if (Math.abs(n - h) < 4) return;
    h = n;
    win.setBounds({ x: 40, y: 40, width: WIDTH, height: h });
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'main', 'bubble.html'));
  win.showInactive();
  await sleep(300);

  /* 顺序就是真实链路里的顺序：begin → think（整段）→ chunk（逐字）→ end */
  win.webContents.send('bubble:begin');
  await sleep(150);
  win.webContents.send('bubble:think', THINK);
  await sleep(150);
  for (const ch of BODY) {
    win.webContents.send('bubble:chunk', ch);
    await sleep(14);
  }
  win.webContents.send('bubble:end');
  await sleep(600);

  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  if (!width || !height) {
    console.error('[shot-think] 拿到空图，截图失败');
    app.exit(1);
    return;
  }
  fs.writeFileSync(OUT, img.toPNG());
  console.log(`[shot-think] ${OUT}  ${width}x${height}  (窗口高 ${h})`);
  app.exit(0);
});
