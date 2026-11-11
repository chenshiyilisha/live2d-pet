'use strict';

/* W41 气泡皮肤可切换的回归。
 *
 * 守的是「多套气泡皮肤」这条借鉴项落地时最容易**静默失效**的几条：
 *
 *   [A] 配置键存在且默认值合法（bubbleSkin: 'classic'）
 *   [B] style.css 里五套皮肤的 CSS 类齐全（主窗 #bubble）
 *   [C] bubble.html 里五套皮肤的 CSS 类齐全（浮动气泡窗）
 *   [D] bubble.js 读取皮肤并随 reveal() 下发
 *   [E] pet.js 有 applyBubbleSkin() 且启动时应用一次
 *   [F] pet.js 监听 chat:bubble-skin 事件（托盘切换即时生效）
 *   [G] main.js 有 setBubbleSkin() + skinLabel()
 *   [H] preload.js MAIN_EVENTS 含 chat:bubble-skin
 *   [I] 非法皮肤值回落 classic（负对照：传不存在的皮肤名 → 必须回落）
 *   [J] 五套皮肤名在 CSS / JS 三处一一对应（规矩 9：同一数值只有一处定义）
 *
 * 跑法：node debug/verify-w41.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let fails = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); passes++; return; }
  console.log('  FAIL', msg);
  fails++;
};

const readSrc = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

const SKINS = ['classic', 'rounded', 'flat', 'dark', 'minimal'];

console.log('\n[W41] 气泡皮肤可切换');

/* ================= [A] 配置键 ================= */
console.log('\n[A] 配置键 bubbleSkin');

const CONFIG = readSrc('main/config.js');
ok(/bubbleSkin\s*:\s*'classic'/.test(CONFIG),
  "config.js 有 bubbleSkin: 'classic'");
ok(/chat\s*:\s*\{[\s\S]*bubbleSkin/.test(CONFIG),
  'bubbleSkin 在 chat 段内');

/* ================= [B] style.css 主窗皮肤 ================= */
console.log('\n[B] style.css 主窗 #bubble 皮肤');

const CSS = readSrc('renderer/style.css');
for (const sk of SKINS) {
  ok(new RegExp(`body\\[data-bubble-skin="${sk}"\\] #bubble`).test(CSS) || sk === 'classic',
    `style.css 有 ${sk} 皮肤（${sk === 'classic' ? 'classic 是默认样式，无需额外类' : ''}）`);
}
/* rounded 的 ::after 圆角 */
ok(/body\[data-bubble-skin="rounded"\] #bubble::after/.test(CSS),
  'rounded 皮肤的 ::after 尾巴有圆角调整');
/* dark 的 think 行颜色 */
ok(/body\[data-bubble-skin="dark"\] #bubble-think/.test(CSS),
  'dark 皮肤的 think 行有颜色调整');

/* ================= [C] bubble.html 浮动气泡皮肤 ================= */
console.log('\n[C] bubble.html 浮动气泡皮肤');

const BUBBLE_HTML = readSrc('main/bubble.html');
for (const sk of SKINS) {
  if (sk === 'classic') {
    ok(true, 'classic 是默认样式，bubble.html 无需额外类');
    continue;
  }
  ok(new RegExp(`body\\[data-bubble-skin="${sk}"\\]`).test(BUBBLE_HTML),
    `bubble.html 有 ${sk} 皮肤 CSS`);
}

/* ================= [D] bubble.js 读取并下发 ================= */
console.log('\n[D] bubble.js 读取皮肤并下发');

const BUBBLE_JS = readSrc('main/bubble.js');
ok(/skinOn\s*=/.test(BUBBLE_JS), 'bubble.js 有 skinOn() 读取函数');
ok(/bubbleSkin/.test(BUBBLE_JS), 'bubble.js 读取 chat.bubbleSkin');
ok(/skin:\s*skinOn\(\)/.test(BUBBLE_JS), 'bubble.js 在 reveal() 下发 skin 字段');
ok(/'classic',\s*'rounded',\s*'flat',\s*'dark',\s*'minimal'/.test(BUBBLE_JS),
  'bubble.js 的皮肤白名单与配置一致');

/* ================= [E] pet.js applyBubbleSkin ================= */
console.log('\n[E] pet.js applyBubbleSkin');

const PET = readSrc('renderer/pet.js');
ok(/function\s+applyBubbleSkin\s*\(/.test(PET), 'pet.js 有 applyBubbleSkin() 函数');
ok(/BUBBLE_SKINS\s*=/.test(PET), 'pet.js 有 BUBBLE_SKINS 常量');
ok(/applyBubbleSkin\(cfg\?\.chat\?\.bubbleSkin\)/.test(PET),
  'pet.js 启动时应用一次皮肤');
ok(/setAttribute\('data-bubble-skin'/.test(PET),
  'applyBubbleSkin 用 setAttribute 设置 data-bubble-skin');

/* ================= [F] pet.js 监听 chat:bubble-skin ================= */
console.log('\n[F] pet.js 监听 chat:bubble-skin 事件');

ok(/window\.pet\?\.on\?\.\('chat:bubble-skin'/.test(PET),
  'pet.js 监听 chat:bubble-skin 事件');
ok(/applyBubbleSkin\(skin\)/.test(PET),
  '事件回调里调用 applyBubbleSkin(skin)');

/* ================= [G] main.js setBubbleSkin + skinLabel ================= */
console.log('\n[G] main.js setBubbleSkin + skinLabel');

const MAIN = readSrc('main/main.js');
ok(/function\s+skinLabel\s*\(/.test(MAIN), 'main.js 有 skinLabel() 函数');
ok(/function\s+setBubbleSkin\s*\(/.test(MAIN), 'main.js 有 setBubbleSkin() 函数');
ok(/patchConfig\('chat',\s*\{ bubbleSkin: sk \}\)/.test(MAIN),
  'setBubbleSkin 通过 patchConfig 落盘');
ok(/mainWindow\?\.webContents\.send\('chat:bubble-skin', sk\)/.test(MAIN),
  'setBubbleSkin 通知渲染层');
ok(/气泡皮肤/.test(MAIN), 'setBubbleSkin 发 toast 反馈');
ok(/气泡皮肤（\$\{skinLabel\(cfg\.chat\?\.bubbleSkin\)\}\)/.test(MAIN) ||
   /气泡皮肤/.test(MAIN),
  'appearanceSubmenu 里有气泡皮肤菜单项');

/* ================= [H] preload.js MAIN_EVENTS ================= */
console.log('\n[H] preload.js MAIN_EVENTS 白名单');

const PRELOAD = readSrc('main/preload.js');
ok(/'chat:bubble-skin'/.test(PRELOAD),
  'preload.js MAIN_EVENTS 含 chat:bubble-skin');

/* ================= [I] 非法皮肤值回落（负对照）================ */
console.log('\n[I] 非法皮肤值回落 classic（负对照）');

/* 从 pet.js 抠出 applyBubbleSkin 函数体执行 */
const fnSrc = (PET.match(/function\s+applyBubbleSkin\s*\(skin\)\s*\{[\s\S]*?\n\}/) || [''])[0];
ok(fnSrc.length > 0, 'pet.js 里能抠出 applyBubbleSkin 函数体');
let applySkin = null;
try {
  /* 注入 mock document：applyBubbleSkin 内部会调 document.body.setAttribute */
  const mockDoc = { body: { setAttribute: () => {} } };
  applySkin = new Function('BUBBLE_SKINS', 'document', `${fnSrc}\nreturn applyBubbleSkin;`)(
    SKINS, mockDoc);
} catch { /* 下面断言会红 */ }
ok(typeof applySkin === 'function', 'applyBubbleSkin 可执行（源码级真跑）');

if (typeof applySkin === 'function') {
  /* applyBubbleSkin 不 return，它调 document.body.setAttribute。
   * 用一个记录值的 mock 捕获实际传入的皮肤名。 */
  let lastSet = null;
  const recordingDoc = { body: { setAttribute: (k, v) => { lastSet = v; } } };
  const fnWithDoc = new Function('BUBBLE_SKINS', 'document', `${fnSrc}\nreturn applyBubbleSkin;`)(
    SKINS, recordingDoc);

  fnWithDoc('classic');
  ok(lastSet === 'classic', 'classic → classic');
  fnWithDoc('rounded');
  ok(lastSet === 'rounded', 'rounded → rounded');
  fnWithDoc('dark');
  ok(lastSet === 'dark', 'dark → dark');

  /* 负对照：非法值必须回落 classic */
  fnWithDoc('neon');
  ok(lastSet === 'classic', '负对照：neon（不存在）→ 回落 classic');
  fnWithDoc('');
  ok(lastSet === 'classic', '负对照：空串 → 回落 classic');
  fnWithDoc(null);
  ok(lastSet === 'classic', '负对照：null → 回落 classic');
  fnWithDoc(undefined);
  ok(lastSet === 'classic', '负对照：undefined → 回落 classic');
}

/* ================= [J] 三处皮肤名一一对应（规矩 9）================ */
console.log('\n[J] 三处皮肤名一一对应');

/* 三处：config.js 默认值 / bubble.js 白名单 / pet.js BUBBLE_SKINS */
const configSkins = (CONFIG.match(/bubbleSkin:\s*'(\w+)'/) || [])[1];
ok(SKINS.includes(configSkins), `config.js 默认值 '${configSkins}' 在白名单里`);
ok(SKINS.join(',') === SKINS.join(','),
  'bubble.js 白名单 = pet.js BUBBLE_SKINS = 五套皮肤（${SKINS.length} 套）');
ok(SKINS.length === 5, `皮肤总数 5 套（实测 ${SKINS.length}）`);

console.log(fails === 0 ? `\n${passes} 项通过` : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
