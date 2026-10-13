'use strict';

/* 悬浮气泡的源码级防回流断言（纯文本检查，不起 Electron）。
 *
 * 这套断言锁的是「聊天分片的双发路由」—— 它是这个功能最容易被改坏的地方：
 * 有人图省事直接 webContents.send('chat:chunk') 绕过 emitChatChunk，
 * 气泡窗就开始漏字；或者有人把 setQuiet 里的 bubble.setQuiet 删了，
 * 全屏游戏时气泡盖在游戏画面上。
 * 跑法：node debug/verify-bubble.js */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};

/* 源码读入 + 归一 CRLF + 去注释（工作区是 CRLF，多个 debug 脚本踩过同一个坑） */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('[A] config.js —— 开关默认值');
{
  const c = stripComments(read('main/config.js'));
  ok(/chat:\s*\{[^}]*floatBubble:\s*true/.test(c), 'chat.floatBubble 默认开');
}

console.log('[B] main.js —— 分片路由收拢 + 生命周期接线');
{
  const m = stripComments(read('main/main.js'));
  ok(/require\('\.\/bubble'\)/.test(m), '引入了 bubble 模块');

  ok(/function emitChatChunk\(t\)\s*\{/.test(m), 'emitChatChunk 收拢函数存在');
  const direct = (m.match(/send\('chat:chunk'/g) || []).length;
  ok(direct === 1, `chat:chunk 直发只许出现 1 次（emitChatChunk 内），实际 ${direct}`);
  ok(/createStreamFilter\(emitChatChunk,\s*emitChatEmotion\)/.test(m), 'emitLocal 走收拢出口');
  ok(/send:\s*emitChatChunk/.test(m), 'chatStream 走收拢出口');

  const begin = (m.match(/bubble\.beginStream\(\)/g) || []).length;
  const end = (m.match(/bubble\.endStream\(\)/g) || []).length;
  const abort = (m.match(/bubble\.abortStream\(\)/g) || []).length;
  ok(begin >= 2, `beginStream 挂在 chat:send 与 chat:proactive 两处（${begin}）`);
  ok(end >= 2 && abort >= 2, `endStream(${end}) / abortStream(${abort}) 成对接线`);

  ok(/bubble\.setQuiet\(quiet\)/.test(m), '全屏静默会收掉气泡');
  ok(/bubble\.refreshConfig\(\)/.test(m), 'patchConfig 后刷新气泡开关');
  ok(/mainWindow\.on\('move',\s*\(\) => bubble\.syncPosition\(\)\)/.test(m), '主窗移动时气泡跟随');
  ok(/bubble\.configureBubble\(\{ getWindow: \(\) => mainWindow \}\)/.test(m), '主窗引用以 getter 注入');
  ok(/bubble\.registerBubbleIpc\(\)/.test(m), '气泡 IPC 已注册');
  ok(/bubble\.dispose\(\)/.test(m), '主窗 closed 时销毁气泡');
  ok(/'pet:float-say'/.test(m) && /'pet:float-hide'/.test(m), 'floatSay / floatHide 通道存在');
}

console.log('[C] preload.js —— 渲染层桥');
{
  const p = stripComments(read('main/preload.js'));
  ok(/floatSay:\s*\(text,\s*autoHideMs\)/.test(p), 'floatSay 带 autoHide 参数');
  ok(/floatHide:\s*\(\)/.test(p), 'floatHide 已暴露');
}

console.log('[D] pet.js —— 浮窗模式下主窗 #bubble 不再画');
{
  const r = stripComments(read('renderer/pet.js'));
  ok(/const floatBubble = \(\) => cfg\?\.chat\?\.floatBubble !== false;/.test(r), 'floatBubble 判定存在');
  const guards = (r.match(/!floatBubble\(\)/g) || []).length;
  ok(guards >= 6, `#bubble 写操作都有守卫（守卫出现 ${guards} 处）`);
  ok(/window\.pet\?\.floatSay\?\.\(line\)/.test(r), '离线主动搭话进浮窗');
  ok(/floatSay\?\.\(text,\s*autoHideMs\)/.test(r), 'say() 整段播报进浮窗');
  ok(/floatHide\?\.\(\)/.test(r), 'hideUI 会收浮窗');
}

console.log('[E] bubble.js —— 窗口本身的硬约束');
{
  const b = stripComments(read('main/bubble.js'));
  ok(/getContentBounds\(\)/.test(b) && !/main\.getBounds\(\)/.test(b), '定位锚 contentBounds（规矩 20）');
  ok(/focusable:\s*false/.test(b), '不抢聊天输入框焦点');
  ok(/hasShadow:\s*false/.test(b), '透明窗必须关系统阴影');
  ok(/screen-saver/.test(b), '置顶层盖过主窗');
  ok(/loadConfig\(\)\.chat\?\.floatBubble !== false/.test(b), '开关每次动作现读（改完立即生效）');
  ok(!/require\('\.\.\//.test(b), '不向上层目录 require（保持自包含）');
}

console.log('[F] 头顶锚点 —— 气泡锚人物头顶而非窗顶（2026-10-13 用户反馈"太远"）');
{
  const b = stripComments(read('main/bubble.js'));
  ok(/let headTop = null;/.test(b), 'headTop 状态存在（null = 还没量到）');
  ok(/const anchorY = b\.y \+ \(headTop \?\? 0\);/.test(b), 'place() 锚头顶（没量到退回窗顶）');
  ok(/const bottomY = anchorY - TIP_GAP - TAIL_TIP_INSET;/.test(b),
    '底边 = 头顶 − TIP_GAP − TAIL_TIP_INSET（决定"离人远近"的是尾巴尖不是窗底）');
  ok(/insideMode = bottomY - curH < wa\.y \+ 4;/.test(b), '贴顶兜底判据跟着 bottomY 走');
  ok(/async function measureHead\(\)/.test(b), 'measureHead 实量存在');
  ok(/getBitmap\(\)/.test(b), '用 nativeImage.getBitmap 逐行扫 alpha');
  ok(/function requestMeasure\(\)/.test(b) && /MEASURE_MIN_GAP_MS/.test(b), '实量有节流');
  ok(/module\.exports = \{[\s\S]*?requestMeasure,/.test(b), 'requestMeasure 在导出面上');

  const m = stripComments(read('main/main.js'));
  ok(/'pet:head-measure'/.test(m), 'main.js 注册 head-measure 通道');

  const p = stripComments(read('main/preload.js'));
  ok(/requestHeadMeasure:\s*\(\) => ipcRenderer\.send\('pet:head-measure'\)/.test(p), 'preload 暴露 requestHeadMeasure');

  const r = stripComments(read('renderer/pet.js'));
  const calls = (r.match(/requestHeadMeasure\?\.\(\)/g) || []).length;
  ok(calls >= 2, `layout 尾部 + 模型挂载后都触发实量（${calls} 处）`);
}

console.log('[G] 造型 —— 无描边 + 单层柔影挂在 #wrap（2026-10-13 用户："不要大黑边"→"只留很柔的投影"）');
{
  const h = read('main/bubble.html');
  /* ⚠️ 断言必须看**剥掉注释**的 CSS：bubble.html 的注释里正大光明写着
   *    "box-shadow 是各画各的…" 当反面教材，不剥就会假红（踩过一次）。 */
  const css = ((h.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]).replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => (css.match(new RegExp(`\\n  ${sel} \\{[\\s\\S]*?\\n  \\}`)) || [''])[0];
  const shell = block('#shell');
  const wrap = block('#wrap');
  const tail = block('#tail');

  ok(shell !== '' && wrap !== '' && tail !== '', '三个样式块都能切出来（选择器没被改名）');
  ok(!/border(?!-radius)/.test(shell), '#shell 无描边（只剩圆角）');
  ok(!/border(?!-radius)/.test(tail), '#tail 无描边（轮廓交给投影）');
  ok(!/box-shadow/.test(css), '不用 box-shadow（各画各的，尾巴接缝会留脏边）');
  ok(/filter:\s*drop-shadow\(/.test(wrap), 'drop-shadow 挂在 #wrap 上（按合成轮廓算 → 泡体和尾巴共用一条影）');
  ok(/position:\s*absolute/.test(tail), '尾巴 absolute 挂 #wrap（#wrap 有 filter → 是它的 containing block）');
  ok(/position:\s*relative/.test(wrap), '#wrap 是定位父级');
}

console.log('[H] 几何联动 —— 三个文件里的数字必须对得上（规矩 9 / 22）');
{
  const b = stripComments(read('main/bubble.js'));
  const h = read('main/bubble.html');
  const grab = (re, i = 1) => {
    const m = h.match(re);
    return m ? Number(m[i]) : NaN;
  };
  const num = (re, i = 1) => {
    const m = b.match(re);
    return m ? Number(m[i]) : NaN;
  };

  const topPad = grab(/reportHeight\((\d+) \+ shell\.offsetHeight/);
  const botPad = grab(/reportHeight\(\d+ \+ shell\.offsetHeight \+ (\d+)\)/);
  const wrapBlock = (h.match(/\n  #wrap \{[\s\S]*?\n  \}/) || [''])[0];
  const tailBlock = (h.match(/\n  #tail \{[\s\S]*?\n  \}/) || [''])[0];
  const grabIn = (src, re, i = 1) => {
    const m = src.match(re);
    return m ? Number(m[i]) : NaN;
  };
  const wrapTop = grabIn(wrapBlock, /margin:\s*(\d+)px/);
  const wrapPadBot = grabIn(wrapBlock, /padding-bottom:\s*(\d+)px/);
  const tailBottom = grabIn(tailBlock, /bottom:\s*(\d+)px/);
  const shellMax = grab(/max-height:\s*(\d+)px/);
  const padV = grab(/padding:\s*(\d+)px\s+\d+px\s+(\d+)px/);
  const padV2 = grab(/padding:\s*\d+px\s+\d+px\s+(\d+)px/);
  const maxH = num(/const MAX_H = (\d+);/);
  const tipInset = num(/const TAIL_TIP_INSET = (\d+);/);

  ok(topPad === wrapTop, `report() 顶部留白(${topPad}) = #wrap margin-top(${wrapTop})`);
  ok(botPad === wrapPadBot, `report() 底部(${botPad}) = #wrap padding-bottom(${wrapPadBot})（尾巴的容身处，两处必须同一个数）`);
  ok(wrapPadBot - tailBottom >= 3, `尾巴确实伸到外壳外（padding-bottom ${wrapPadBot} − tail bottom ${tailBottom} = ${wrapPadBot - tailBottom}px）`);
  ok(botPad - 9 === tipInset, `TAIL_TIP_INSET(${tipInset}) = 底部(${botPad}) − 尾巴最低点 9px`);
  const shellOuter = shellMax + padV + padV2;
  ok(maxH >= topPad + shellOuter + botPad,
    `MAX_H(${maxH}) ≥ 顶部${topPad} + 泡体上限${shellOuter} + 底部${botPad} = ${topPad + shellOuter + botPad}（否则长回复裁尾巴和末行）`);
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
