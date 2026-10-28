'use strict';

/* ============================================================
 *  情绪角标的**真机**验证（方案 A）
 * ==========================================================
 *
 *  为什么要真机：verify-bubble [L] 证明的是"表写全了、位置算得对"，
 *  证不了三件只有跑起来才看得见的事：
 *    ① 换情绪时角标**真的换**（不是停在上一个情绪上）
 *    ② 角标**不占布局** —— 有牌 / 无牌 时泡体高度必须一模一样，
 *       否则会打乱 A3 的宽度档位和高度上报
 *    ③ 认不出的情绪 / 新的一句话 → 收牌（不能挂着上一句的心情）
 *
 *  用法： env -u ELECTRON_RUN_AS_NODE npx electron debug/shot-bubble-badge.js
 *  产物： debug/pet-bubble-badge-happy.png / -sleepy.png
 * ========================================================== */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const bubble = require('../src/main/bubble.js');

const DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) fails++;
};

/* 角标状态 + 泡体几何（一次取全，免得多次 IPC 之间状态又变了） */
const badgeState = async () => {
  const w = bubble._win();
  return w.webContents.executeJavaScript(`(() => {
    const b = document.getElementById('badge');
    const shell = document.getElementById('shell');
    const br = b.getBoundingClientRect();
    const sr = shell.getBoundingClientRect();
    return {
      on: b.classList.contains('on'),
      emo: b.dataset.emo || null,
      svg: (b.innerHTML.match(/stroke="(#[0-9a-f]{6})"/) || [])[1] || null,
      shellH: shell.offsetHeight,
      /* 角标相对泡体的位置：应压在右上角、一半在泡体外 */
      dxRight: Math.round(br.right - sr.right),
      dyTop: Math.round(sr.top - br.top)
    };
  })()`, true);
};

async function shoot(file) {
  const w = bubble._win();
  const img = await w.webContents.capturePage();
  const { width, height } = img.getSize();
  if (!width || !height) { console.log('  (空图)'); return; }
  fs.writeFileSync(path.join(DIR, file), img.toPNG());
  console.log(`  shot ${file}  ${width}x${height}`);
}

app.whenReady().then(async () => {
  bubble.registerBubbleIpc();
  const main = new BrowserWindow({
    width: 308, height: 342, x: 700, y: 480,
    frame: false, transparent: true, show: true,
    webPreferences: { nodeIntegration: false }
  });
  await main.loadURL('data:text/html,<html><body style="background:transparent"></body></html>');
  bubble.configureBubble({ getWindow: () => main });

  /* ---- 场景 1：说一句话，量"无牌"时的基准高度 ---- */
  bubble.beginStream();
  await sleep(120);
  for (const ch of '这套方案我看过两遍了，改动集中在三个地方。') {
    bubble.appendChunk(ch); await sleep(4);
  }
  bubble.endStream();
  await sleep(250);
  const base = await badgeState();
  console.log('  [1] 无牌', JSON.stringify(base));
  ok(base.on === false, 'calm / 还没收到情绪 → 不挂牌（常态不挂牌）');

  /* ---- 场景 2：挂 happy ---- */
  bubble.setEmotion('happy');
  await sleep(300);
  const happy = await badgeState();
  console.log('  [2] happy', JSON.stringify(happy));
  ok(happy.on === true && happy.emo === 'happy', '收到 happy → 挂上爱心牌');
  ok(happy.svg === '#ff6b81', `用的是 happy 那套图形（描边色 ${happy.svg}）`);
  ok(happy.shellH === base.shellH,
    `角标**不占布局**：有牌 ${happy.shellH}px = 无牌 ${base.shellH}px（否则会打乱 A3 与高度上报）`);
  ok(happy.dxRight > 0 && happy.dyTop > 0,
    `角标压在**右上角**、一半在泡体外（右溢出 ${happy.dxRight}px / 上溢出 ${happy.dyTop}px）`);
  await shoot('pet-bubble-badge-happy.png');

  /* ---- 场景 3：换情绪 → 必须真的换 ---- */
  bubble.setEmotion('sleepy');
  await sleep(300);
  const sleepy = await badgeState();
  console.log('  [3] sleepy', JSON.stringify(sleepy));
  ok(sleepy.emo === 'sleepy' && sleepy.svg !== happy.svg,
    `换情绪时角标**真的换**（${happy.emo} → ${sleepy.emo}，颜色 ${happy.svg} → ${sleepy.svg}）`);
  await shoot('pet-bubble-badge-sleepy.png');

  /* ---- 场景 4：认不出的情绪 → 收牌（换模型也不能挂错牌）---- */
  bubble.setEmotion('不存在的情绪');
  await sleep(250);
  const unk = await badgeState();
  console.log('  [4] 未知', JSON.stringify(unk));
  ok(unk.on === false, '认不出的情绪 → 收牌（回退，不会挂着上一个牌）');

  /* ---- 场景 5：calm 不挂牌 ---- */
  bubble.setEmotion('happy');
  await sleep(200);
  bubble.setEmotion('calm');
  await sleep(250);
  const calm = await badgeState();
  ok(calm.on === false, 'calm 不挂牌（常态，表里故意没有它）');

  /* ---- 场景 6：下一句话 → 收牌（上一句的心情不能挂到这一句）---- */
  bubble.setEmotion('happy');
  await sleep(200);
  bubble.beginStream();
  await sleep(250);
  const next = await badgeState();
  console.log('  [6] 下一句', JSON.stringify(next));
  ok(next.on === false, '新一句话开头收牌（上一句的心情不带到这一句）');

  bubble.dispose();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.exit(fails === 0 ? 0 : 1);
});
