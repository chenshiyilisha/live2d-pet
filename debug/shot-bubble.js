'use strict';

/* ============================================================
 *  气泡窗观感截图：默认 / 描边 / 淡出中 / 尾巴回正
 * ==========================================================
 *
 *  为什么需要它（2026-10-28 补的第一批气泡改动）：
 *    C1 出场淡出、C2 入场 scale、A1 两层阴影、A2 描边、B2 尾巴回正 ——
 *    全是**只有看图才知道对不对**的东西。源码级断言（verify-bubble [G]/[I]）
 *    能证明"代码里有动画/有那层 filter"，证明不了"屏幕上真的动了、描边够不够看"。
 *    其中最该防的是那句老话：**代码有动画、屏幕没有**（同名 animation 不重排
 *    就不会重播）。所以这里专门抓一张**淡出进行中**的图 —— 抓到的是半透明，
 *    才说明动画真在跑。
 *
 *  背景为什么是浅灰：白气泡在**浅色壁纸**上最容易糊掉，那是 A2 描边要治的
 *  场景。这里给 body 铺一层浅底当"最坏情况壁纸"，四张图都按最坏情况看。
 *  ⚠️ 这是**截图脚本自己的**背景，不是产品行为 —— 产品里 body 恒为 transparent。
 *
 *  本机装了深信服 aTrust 时 GPU 进程会被注入打崩（exit_code=-1073741819）。
 *  解法照抄 main.js「GPU / GL 后端选择」段：关沙箱，而不是禁用硬件加速 ——
 *  disableHardwareAcceleration 会让合成的 alpha 静默失效，透明窗截成白块。
 *
 *  用法： env -u ELECTRON_RUN_AS_NODE npx electron debug/shot-bubble.js
 *  产物： debug/pet-bubble-{plain,outline,fade,tail}.png
 * ========================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const WIDTH = 272;      // 与 bubble.js 的 WIDTH 一致
const MIN_H = 56;
const MAX_H = 340;
const DIR = __dirname;

/* 一句"真实形状"的话：两行多一点，不会撑到滚动。 */
const BODY = '我在呢。那个方案我看过了，改起来不难，主要是把超时那段抽出来。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 浅色壁纸（最坏情况）。用 insertCSS 注入，**不碰 bubble.html 源文件** ——
 * 产品里 body 恒为 transparent，这个底色只属于截图脚本。
 * ⚠️ SHOT_TRANSPARENT=1 时不铺底：铺了底整个窗口矩形都是不透明的，
 *    alpha 就量不出来了（淡出验证会假绿）—— 那种跑法专给量数值用。 */
const LIGHT_BG = '#f2f2f0';
const TRANSPARENT = !!process.env.SHOT_TRANSPARENT;

async function shoot(win, file) {
  const img = await win.webContents.capturePage();
  const { width, height } = img.getSize();
  if (!width || !height) {
    console.error(`[shot-bubble] ${file} 拿到空图`);
    return false;
  }
  const out = path.join(DIR, file);
  fs.writeFileSync(out, img.toPNG());
  console.log(`[shot-bubble] ${out}  ${width}x${height}`);
  return true;
}

/* 灌一句完整的话：begin → 逐字 chunk → end。顺序照真实链路。 */
async function say(win) {
  win.webContents.send('bubble:begin');
  await sleep(60);
  for (const ch of BODY) {
    win.webContents.send('bubble:chunk', ch);
    await sleep(6);
  }
  win.webContents.send('bubble:end');
  await sleep(400);      // 等最后一帧排完 + 入场动画早播完了
}

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
    hasShadow: false,          // 透明窗必须关系统阴影，否则整块灰框
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

  /* 复刻 bubble.js 的高度联动：渲染层报多高窗口就多高（气泡往上长）。 */
  ipcMain.on('bubble:height', (_e, v) => {
    const n = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(v) || MIN_H)));
    if (Math.abs(n - h) < 4) return;
    h = n;
    win.setBounds({ x: 40, y: 40, width: WIDTH, height: h });
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'main', 'bubble.html'));
  if (!TRANSPARENT) {
    await win.webContents.insertCSS(`html, body { background: ${LIGHT_BG} !important; }`);
  }
  win.showInactive();
  await sleep(200);

  /* ---- 1. 默认（两层阴影、无描边）---- */
  win.webContents.send('bubble:show', { outline: false });
  await say(win);
  await shoot(win, 'pet-bubble-plain.png');

  /* ---- 2. 开描边（chat.floatBubbleOutline = true 的样子）---- */
  win.webContents.send('bubble:show', { outline: true });
  await sleep(300);
  await shoot(win, 'pet-bubble-outline.png');

  /* ---- 3. 淡出进行中：抓到半透明才说明动画真在跑 ----
   * 160ms 的动画，80ms 处抓 —— 抓到全透明说明动画没播/已经播完，
   * 抓到不透明说明 bubble:fade 根本没被页面接住。 */
  win.webContents.send('bubble:fade');
  await sleep(80);
  await shoot(win, 'pet-bubble-fade.png');
  await sleep(300);

  /* ---- 4. 尾巴回正：气泡被偏移/被屏幕边 clamp 后尾巴要跟着挪 ----
   * 用 -24 是**故意夸张**的（真实只有 ±8）：挪得明显才看得出尾巴有没有跟上、
   * 有没有和泡体脱开。 */
  win.webContents.send('bubble:show', { outline: true });
  await sleep(300);
  win.webContents.send('bubble:tail', -24);
  await sleep(200);
  await shoot(win, 'pet-bubble-tail.png');

  app.exit(0);
});
