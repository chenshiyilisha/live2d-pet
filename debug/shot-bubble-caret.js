'use strict';

/* ============================================================
 *  气泡的**真机**验证：C3 打字光标 + D1 停留时长随字数
 * ==========================================================
 *
 *  为什么不能只靠 verify-bubble.js [K] 段：那是源码级断言，证明的是
 *  "规则写对了"。而这两项的风险都在**真跑起来才看得见**的地方：
 *
 *   C3 —— 光标是 2px 的 inline-block，挂在正文末尾。若正赶上行尾，这 2px
 *        会多逼出一次换行 → 高度跳一截 → 主进程跟着 setBounds → 气泡抖一下。
 *        CSS 里那句负外边距就是为这个写的，**必须实测有没有真的防住**：
 *        做法是把最后一行喂到"再一个字就换行"的临界点，然后开关光标量两次高度。
 *   D1 —— 字数必须真的按流式累上来（不是整段一次性），且说完那一刻的时长
 *        要落在合理区间里。
 *
 *  同样**直接用真的 bubble.js**（真 place / 真渲染层），不复刻。
 *
 *  用法： env -u ELECTRON_RUN_AS_NODE npx electron debug/shot-bubble-caret.js
 *  产物： debug/pet-bubble-caret.png（打字中的气泡，光标可见）
 * ========================================================== */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const bubble = require('../src/main/bubble.js');

/* 一段真·长回复（>160 字，用来触发停留时长的上限）。 */
const LONG = '这套方案我看过两遍了，改动其实集中在三个地方：超时那一处要抽成独立函数，' +
  '状态机里补一个"已取消"的分支，日志要带上代际号。做完这三处，剩下的都是文案调整，' +
  '不难。另外记得把回归脚本里的断言同步改掉，不然下次跑会一直红着没人管——' +
  '那种"红着没人管"的断言比没有还糟，因为它会骗人。' +
  '要是这三处里有一处没改干净，表现就是"看起来改完了、过两天又冒出来"，' +
  '那种最难查，因为你会默认它已经修好了。所以改完请当场跑一遍回归。';

const DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  PASS ' : '  FAIL ') + msg);
  if (!cond) fails++;
};

/* 渲染层量一次泡体高度（= shell 的 offsetHeight，主进程那个 curH 是含留白的整页高）。 */
const shellH = async () => {
  const w = bubble._win();
  return w.webContents.executeJavaScript(
    "document.getElementById('shell').offsetHeight", true);
};
/* 渲染层的状态：三个 class 是否按预期挂着。 */
const domState = async () => {
  const w = bubble._win();
  return w.webContents.executeJavaScript(`(() => {
    const shell = document.getElementById('shell');
    const cs = getComputedStyle(document.getElementById('text'), '::after');
    return {
      bodyCaret: document.body.classList.contains('caret'),
      typing: shell.classList.contains('typing'),
      waiting: shell.classList.contains('waiting'),
      caretW: cs.width,
      caretMarginR: cs.marginRight,
      caretAnim: cs.animationName,
      h: shell.offsetHeight
    };
  })()`, true);
};

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
  const main = new BrowserWindow({
    width: 308, height: 342, x: 700, y: 480,
    frame: false, transparent: true, show: true,
    webPreferences: { nodeIntegration: false }
  });
  await main.loadURL('data:text/html,<html><body style="background:transparent"></body></html>');
  bubble.configureBubble({ getWindow: () => main });

  /* ---- 场景 1：waiting 态（还没出字）---- */
  bubble.beginStream();
  await sleep(200);
  const d0 = await domState();
  console.log('  [1] dom', JSON.stringify(d0));
  ok(d0.bodyCaret === true, 'caret 开关下发到了渲染层（body.caret 挂着）');
  ok(d0.waiting === true && d0.typing === false, '还没出字 → 只有「…」，不该有光标');

  /* ---- 场景 2：把最后一行喂到"再一个字就换行"的临界点 ----
   * 逐字加，每次量高度：高度一变就说明刚发生了换行，此时**回退到换行前**
   * 是不可能的（字符已经打进去了），所以改判"再补到下一次换行前一刻"——
   * 也就是说：换行之后继续加，直到高度**又要变**的那一刻，最后一行就是最满的。
   * 实现上：加字 → 若高度变了，把这一轮的长度记下来，继续加；直到加满两行。 */
  let prevH = await shellH();
  let sinceWrap = 0;
  let lineCap = 0;               // 一行装得下多少个字（第一次换行时才知道）
  for (let i = 0; i < 200; i++) {
    bubble.appendChunk('字');
    await sleep(12);
    const h = await shellH();
    if (h !== prevH) {           // 刚换了一行
      prevH = h;
      lineCap = sinceWrap;       // 上一行装了多少字
      sinceWrap = 0;
      if (h >= 200) break;       // 已经够高，再往上就该滚了
    } else {
      sinceWrap++;
      /* 逼近下一次换行的前一刻 —— 这时最后一行最满，光标最容易把它挤下去。 */
      if (lineCap > 0 && sinceWrap >= lineCap - 2) break;
    }
  }
  console.log(`  [2] 一行约 ${lineCap} 字，停在距行尾 ${lineCap - sinceWrap} 字处`);
  const dTyping = await domState();
  console.log('  [2] dom', JSON.stringify(dTyping));
  ok(dTyping.typing === true && dTyping.waiting === false, '出字中 → typing（「…」换成光标）');
  ok(dTyping.caretW === '2px', `光标渲染出来了（::after 宽 ${dTyping.caretW}）`);
  ok(dTyping.caretMarginR === '-4px', `负外边距生效（${dTyping.caretMarginR} → 净宽为负）`);
  ok(dTyping.caretAnim === 'caret', '光标在闪（animation-name = caret）');

  /* 🔴 C3 的核心：开关光标量两次高度 —— 必须一样。
   * 不一样就说明这 2px 把最后一行挤换行了，气泡会跳一截。 */
  const hWith = dTyping.h;
  await bubble._win().webContents.executeJavaScript(
    "document.body.classList.remove('caret')", true);
  await sleep(60);
  const hWithout = await shellH();
  await bubble._win().webContents.executeJavaScript(
    "document.body.classList.add('caret')", true);
  await sleep(60);
  ok(hWith === hWithout,
    `光标**不引起换行**：有光标 ${hWith}px = 无光标 ${hWithout}px（差 ${hWith - hWithout}）`);
  await shoot('pet-bubble-caret.png');

  /* ---- 场景 3：说完 → 光标撤掉 ---- */
  bubble.endStream();
  await sleep(200);
  const dEnd = await domState();
  console.log('  [3] dom', JSON.stringify(dEnd));
  ok(dEnd.typing === false, '说完 → 撤掉 typing（留着会一直闪，像没说完）');

  /* ---- 场景 4：D1 长回复 → 停得比固定值久 ----
   * ⚠️ 上面那句只有 29 字（6.5s，**比固定 9s 还短**）—— 所以单测它证明不了
   *    "长话停更久"。这里单独打一段真·长回复，拿固定值 9000 当参照。 */
  bubble.beginStream();
  await sleep(120);
  for (const ch of LONG) { bubble.appendChunk(ch); await sleep(4); }
  bubble.endStream();
  await sleep(200);
  const st4 = bubble._state();
  console.log('  [4] state', JSON.stringify({ chars: st4.chars, hideMs: st4.hideMs }));
  ok(st4.chars >= 160, `长回复的字数按流式真的累上来了（${st4.chars} 字）`);
  /* 不写死"必须顶到 14000"—— 那是"文本够不够长"的问题，不是这条规则的问题。
   * 这里要证明的只有一件事：长话比固定值 9000 停得久。 */
  ok(st4.hideMs > 9000 && st4.hideMs <= 14000,
    `长话停 ${st4.hideMs}ms —— 比固定值 9000 **久**（原来长话根本读不完）`);

  /* ---- 场景 5：下一句短话 → 停得比固定值短，且**不继承**上一句的字数 ---- */
  bubble.beginStream();
  await sleep(120);
  for (const ch of '嗯，我在呢。') { bubble.appendChunk(ch); await sleep(8); }
  bubble.endStream();
  await sleep(200);
  const st5 = bubble._state();
  console.log('  [5] state', JSON.stringify({ chars: st5.chars, hideMs: st5.hideMs }));
  ok(st5.chars === 6, `短话字数重算（${st5.chars}，不是接着上一句的 ${st4.chars}）`);
  ok(st5.hideMs === 6000 && st5.hideMs < 9000,
    `短话停 ${st5.hideMs}ms —— 比固定值 9000 **短**（不用陪着长话一起停）`);

  bubble.dispose();
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  app.exit(fails === 0 ? 0 : 1);
});
