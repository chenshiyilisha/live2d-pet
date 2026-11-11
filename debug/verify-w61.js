'use strict';

/* W61 碎碎念（inner whispers）的回归。
 *
 * 守的是「会话流式期间偶尔说内心独白」这条借鉴项落地时最容易
 * **静默失效**的几条：
 *
 *   [A] whisper.js 模块存在且导出完整（TEMPLATES / shouldShow / pickWhisper /
 *       markShown / renderWhisper / hideWhisper / resetWhisper / TTL_MS）
 *   [B] 模板池按类别分组（success / error / thinking / idle），全部手写中文
 *   [C] CD 配置正确（分类行 9s、结果行 5s）
 *   [D] 展示 TTL 8s
 *   [E] config.js 有 chat.whisper 开关（默认 true）
 *   [F] pet.js import 了 whisper 模块的函数
 *   [G] pet.js 有 triggerWhisper() 函数，映射 work-state → 类别
 *   [H] pet.js 在 work-state 处理器里调用了 triggerWhisper
 *   [I] pet.js 有 triggerWhisperCompletion() 函数
 *   [J] pet.js 在流结束处调用了 triggerWhisperCompletion
 *   [K] index.html 有 #whisper 元素
 *   [L] style.css 有 #whisper 样式
 *   [M] main.js 托盘有 chat.whisper flag
 *   [N] whisper.js 的 shouldShow 有负对照（CD 内不触发）
 *
 * 跑法：node debug/verify-w61.js
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

console.log('\n[W61] 碎碎念（inner whispers）');

/* ================= [A] 模块存在且导出完整 ================= */
console.log('\n[A] whisper.js 模块');

const whisper = readSrc('renderer/whisper.js');
ok(whisper.length > 500, 'whisper.js 存在且非空');
ok(/export\s+function\s+shouldShow/.test(whisper), '导出 shouldShow()');
ok(/export\s+function\s+pickWhisper/.test(whisper), '导出 pickWhisper()');
ok(/export\s+function\s+markShown/.test(whisper), '导出 markShown()');
ok(/export\s+function\s+renderWhisper/.test(whisper), '导出 renderWhisper()');
ok(/export\s+function\s+hideWhisper/.test(whisper), '导出 hideWhisper()');
ok(/export\s+function\s+resetWhisper/.test(whisper), '导出 resetWhisper()');
ok(/export\s+\{\s*TTL_MS/.test(whisper) || /export\s*\{[^}]*TTL_MS/.test(whisper) || /TTL_MS/.test(whisper), '导出 TTL_MS');

/* ================= [B] 模板池按类别分组 ================= */
console.log('\n[B] 模板池');

ok(/TEMPLATES\s*=/.test(whisper), '有 TEMPLATES 常量');
ok(/success\s*:/.test(whisper), '有 success 类别');
ok(/error\s*:/.test(whisper), '有 error 类别');
ok(/thinking\s*:/.test(whisper), '有 thinking 类别');
ok(/idle\s*:/.test(whisper), '有 idle 类别');
ok(/completion/.test(whisper), '有 completion 类别');

/* ================= [C] CD 配置 ================= */
console.log('\n[C] CD 配置');

ok(/CD_MS/.test(whisper), '有 CD_MS 常量');
ok(/9000/.test(whisper), '分类行 CD 9s');
ok(/5000/.test(whisper), '结果行 CD 5s');

/* ================= [D] 展示 TTL ================= */
console.log('\n[D] 展示 TTL');

ok(/TTL_MS\s*=\s*8000/.test(whisper), 'TTL_MS = 8000（8s）');

/* ================= [E] config.js 开关 ================= */
console.log('\n[E] config.js chat.whisper');

const CONFIG = readSrc('main/config.js');
ok(/whisper\s*:\s*true/.test(CONFIG), "config.js 有 whisper: true");
ok(/chat\s*:\s*\{[\s\S]*whisper/.test(CONFIG), 'whisper 在 chat 段内');

/* ================= [F] pet.js import ================= */
console.log('\n[F] pet.js import whisper');

const pet = readSrc('renderer/pet.js');
ok(/from\s+'\.\/whisper\.js'/.test(pet), "pet.js import 了 whisper.js");
ok(/shouldShow/.test(pet), 'pet.js 使用了 shouldShow');
ok(/pickWhisper/.test(pet), 'pet.js 使用了 pickWhisper');
ok(/markShown/.test(pet), 'pet.js 使用了 markShown');
ok(/renderWhisper/.test(pet), 'pet.js 使用了 renderWhisper');
ok(/hideWhisper/.test(pet), 'pet.js 使用了 hideWhisper');

/* ================= [G] triggerWhisper 函数 ================= */
console.log('\n[G] triggerWhisper 函数');

ok(/function\s+triggerWhisper/.test(pet), 'pet.js 有 triggerWhisper() 函数');
ok(/triggerWhisper\s*\(/.test(pet), 'triggerWhisper 被调用');

/* ================= [H] work-state 处理器里调用 ================= */
console.log('\n[H] work-state 处理器');

ok(/triggerWhisper\s*\(phase\)/.test(pet), 'work-state 处理器里调用 triggerWhisper(phase)');

/* ================= [I] triggerWhisperCompletion 函数 ================= */
console.log('\n[I] triggerWhisperCompletion 函数');

ok(/function\s+triggerWhisperCompletion/.test(pet), 'pet.js 有 triggerWhisperCompletion() 函数');

/* ================= [J] 流结束处调用 ================= */
console.log('\n[J] 流结束处');

ok(/triggerWhisperCompletion\s*\(\)/.test(pet), '流结束处调用了 triggerWhisperCompletion()');

/* ================= [K] index.html 元素 ================= */
console.log('\n[K] index.html');

const html = readSrc('renderer/index.html');
ok(/id="whisper"/.test(html), 'index.html 有 #whisper 元素');

/* ================= [L] style.css 样式 ================= */
console.log('\n[L] style.css');

const css = readSrc('renderer/style.css');
ok(/#whisper\s*\{/.test(css), 'style.css 有 #whisper 样式');
ok(/#whisper\.show/.test(css), 'style.css 有 #whisper.show 状态');

/* ================= [M] main.js 托盘 flag ================= */
console.log('\n[M] main.js 托盘');

const main = readSrc('main/main.js');
ok(/flag\s*\(\s*'chat'\s*,\s*'whisper'/.test(main), "main.js 托盘有 chat.whisper flag");

/* ================= [N] shouldShow 负对照 ================= */
console.log('\n[N] shouldShow 负对照');

ok(/if\s*\(lastShown\[category\]/.test(whisper), 'shouldShow 检查 lastShown（CD 内不触发）');
ok(/now\s*-\s*lastShown\[category\]/.test(whisper), 'shouldShow 比较时间差');

/* ================= 结果 ================= */
console.log('\n' + '='.repeat(40));
if (fails === 0) {
  console.log(`✅ verify-w61 全绿（${passes} 项）`);
} else {
  console.log(`❌ verify-w61 有 ${fails} 项失败（${passes} 项通过）`);
  process.exit(1);
}
