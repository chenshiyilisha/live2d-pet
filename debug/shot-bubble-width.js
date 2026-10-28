'use strict';

/* ============================================================
 *  气泡摆位的**真机**验证：宽高比多档（A3）+ 上方三候选（B1/B4/B5）
 * ==========================================================
 *
 *  为什么不能只靠 verify-bubble.js：那套是纯函数断言（[J] 段），证明的是
 *  "规则写对了"；证不了"真跑起来落在该落的档位上、而且**停下来**"。
 *  A3 最大的风险恰恰是跑起来才发作的那个回路 —— 加宽 → 行数变少 → 高度回落 →
 *  收窄 → 高度又涨 → 再加宽…… 纯函数断言里我们只模拟了一步，这里让它真跑。
 *
 *  所以本脚本**直接用真的 bubble.js**（不是复刻一份高度联动）：
 *  真 place() · 真 setBounds · 真渲染层报高度。主窗用一个空白透明窗代替
 *  （headTop 量不到 → 退回贴窗顶，不影响本脚本要验的宽档与候选位）。
 *
 *  四个场景：
 *    1. 长回复（屏幕中间）  → 宽度应从最窄档上浮，且**落定后不再变**
 *    2. 主窗贴屏幕左边缘    → top 被夹 → 改用侧候选 + 尾巴回正
 *    3. 主窗贴屏幕顶        → inside + 优先偏一侧（少挡脸）
 *    4. 下一句短话          → 宽度重置回最窄档
 *
 *  用法： env -u ELECTRON_RUN_AS_NODE npx electron debug/shot-bubble-width.js
 *  产物： debug/pet-bubble-wide.png / pet-bubble-aside.png
 * ========================================================== */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

/* 本机装了深信服 aTrust 时 GPU 进程会被注入打崩（exit_code=-1073741819）。
 * 照抄 main.js「GPU / GL 后端选择」段：关沙箱，而不是禁用硬件加速 ——
 * disableHardwareAcceleration 会让合成的 alpha 静默失效，透明窗截成白块。 */
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const bubble = require('../src/main/bubble.js');

/* 一句"真实长度"的长回复：按 272 宽、14px 字号算大约 9 行，
 * 正好顶到 shell 的 max-height 236 —— 也就是 A3 要治的那种"窄高盒"。 */
const LONG = '这套方案我看过两遍了，改动其实集中在三个地方：超时那一处要抽成独立函数，' +
  '状态机里补一个"已取消"的分支，日志要带上代际号。做完这三处，剩下的都是文案调整，' +
  '不难。另外记得把回归脚本里的断言同步改掉，不然下次跑会一直红着没人管——' +
  '那种"红着没人管"的断言比没有还糟，因为它会骗人。';
const SHORT = '嗯，我在呢。';

const DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) fails++;
};

async function typeOut(text) {
  for (const ch of text) {
    bubble.appendChunk(ch);
    await sleep(5);
  }
}

async function shoot(file) {
  const w = bubble._win();
  if (!w) { console.log('  (气泡窗不在，跳过截图)'); return; }
  const img = await w.webContents.capturePage();
  const { width, height } = img.getSize();
  if (!width || !height) { console.log('  (空图)'); return; }
  fs.writeFileSync(path.join(DIR, file), img.toPNG());
  console.log(`  shot ${file}  ${width}x${height}`);
}

app.whenReady().then(async () => {
  bubble.registerBubbleIpc();

  /* 假主窗：尺寸照真实主窗（308×342，见 win-size.js），透明 + 无框。 */
  const main = new BrowserWindow({
    width: 308, height: 342, x: 700, y: 480,
    frame: false, transparent: true, show: true,
    webPreferences: { nodeIntegration: false }
  });
  await main.loadURL('data:text/html,<html><body style="background:transparent"></body></html>');
  bubble.configureBubble({ getWindow: () => main });

  /* ---- 场景 1：长回复 → 宽度上浮，且落定后不再变化 ---- */
  bubble.beginStream();
  await sleep(120);
  await typeOut(LONG);
  bubble.endStream();
  await sleep(500);
  const s1 = bubble._state();
  console.log('  [1] state', JSON.stringify(s1));
  ok(s1.w > 272, `长回复把气泡从最窄档加宽到 ${s1.w}（272 → ${s1.w}）`);
  ok(s1.w / s1.h >= 1.2 - 1e-9, `宽高比 ${(s1.w / s1.h).toFixed(2)} ≥ 1.2（治窄高盒）`);

  /* 🔴 回路检查：再等一大截，宽和高都不许动 —— 动了就是"加宽→变矮→收窄"在抖。 */
  const before = bubble._state();
  await sleep(700);
  const after = bubble._state();
  ok(before.w === after.w && before.h === after.h,
    `落定后 700ms 内宽高都不再变（${before.w}×${before.h} → ${after.w}×${after.h}）`);
  await shoot('pet-bubble-wide.png');

  /* ---- 场景 2：主窗贴屏幕左边缘 → top 被夹，改用侧候选 + 尾巴回正 ---- */
  main.setBounds({ x: 0, y: 480, width: 308, height: 342 });
  bubble.syncPosition();
  await sleep(250);
  const s2 = bubble._state();
  console.log('  [2] state', JSON.stringify(s2));
  ok(s2.cand !== 'top', `正上方被屏幕边夹住时改用侧候选（实际 ${s2.cand}）`);
  ok(Math.abs(s2.tailOffset) >= 20,
    `尾巴回正量跟着变大（${s2.tailOffset}px）—— 位置一变尾巴必须跟着变，否则指不到她`);
  await shoot('pet-bubble-aside.png');

  /* ---- 场景 3：主窗贴屏幕顶 → 头顶上方放不下，inside + 偏一侧少挡脸 ---- */
  main.setBounds({ x: 700, y: 0, width: 308, height: 342 });
  bubble.syncPosition();
  await sleep(250);
  const s3 = bubble._state();
  console.log('  [3] state', JSON.stringify(s3));
  ok(s3.inside === true, '头顶上方放不下 → inside 兜底（气泡退回主窗内，不会凭空消失）');
  ok(s3.cand !== 'top', `inside 时优先偏一侧少挡脸（实际 ${s3.cand}）`);

  /* ---- 场景 4：下一句短话 → 宽度重置回最窄档 ---- */
  main.setBounds({ x: 700, y: 480, width: 308, height: 342 });
  bubble.syncPosition();
  bubble.beginStream();
  await sleep(120);
  await typeOut(SHORT);
  bubble.endStream();
  await sleep(400);
  const s4 = bubble._state();
  console.log('  [4] state', JSON.stringify(s4));
  ok(s4.w === 272, `下一句短话把宽度重置回最窄档（实际 ${s4.w}，不能继承上一句的宽气泡）`);

  bubble.dispose();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.exit(fails === 0 ? 0 : 1);
});
