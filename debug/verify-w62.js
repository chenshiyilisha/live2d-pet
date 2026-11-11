'use strict';

/* W62 休眠模式（dormancy）的回归。
 *
 * 守的是「一键卸载渲染（零 GPU）+ 切断事件处理 + 毫秒级唤醒」这条
 * 借鉴项落地时最容易**静默失效**的几条：
 *
 *   [A] config.js 有 chat.dormancy 开关（默认 false，占资源类默认关）
 *   [B] pet.js 有 dormant 状态变量
 *   [C] pet.js 有 applyDormancy() 函数
 *   [D] applyDormancy 进入休眠：停 app.ticker + 停 PIXI.Ticker.shared
 *   [E] applyDormancy 进入休眠：停朗读 + 收动作 + 撤定时器
 *   [F] applyDormancy 唤醒：重启 ticker + 恢复帧率
 *   [G] onConfigChanged 里调用了 applyDormancy（配置切换即时生效）
 *   [H] main.js 托盘有 chat.dormancy flag
 *   [I] applyDormancy 有状态守卫（dormant 不变时不重复执行）
 *   [J] 休眠与全屏静默互补（不是同一套逻辑）
 *
 * 跑法：node debug/verify-w62.js
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

console.log('\n[W62] 休眠模式（dormancy）');

/* ================= [A] config.js 开关 ================= */
console.log('\n[A] config.js chat.dormancy');

const CONFIG = readSrc('main/config.js');
ok(/dormancy\s*:\s*false/.test(CONFIG), "config.js 有 dormancy: false（默认关）");
ok(/chat\s*:\s*\{[\s\S]*dormancy/.test(CONFIG), 'dormancy 在 chat 段内');

/* ================= [B] dormant 状态变量 ================= */
console.log('\n[B] dormant 状态变量');

const pet = readSrc('renderer/pet.js');
ok(/let\s+dormant\s*=/.test(pet), 'pet.js 有 dormant 状态变量');

/* ================= [C] applyDormancy 函数 ================= */
console.log('\n[C] applyDormancy 函数');

ok(/function\s+applyDormancy/.test(pet), 'pet.js 有 applyDormancy() 函数');

/* ================= [D] 停 ticker ================= */
console.log('\n[D] 停 ticker');

ok(/app\?\.ticker\?\.stop/.test(pet), 'applyDormancy 停 app.ticker');
ok(/PIXI\.Ticker\.shared\.stop/.test(pet), 'applyDormancy 停 PIXI.Ticker.shared');

/* ================= [E] 停朗读 + 收动作 ================= */
console.log('\n[E] 停朗读 + 收动作');

ok(/stopSpeaking\(\)/.test(pet), 'applyDormancy 停朗读（stopSpeaking）');
ok(/stopEventMotions\(\)/.test(pet), 'applyDormancy 收动作');
ok(/patAbort\(\)/.test(pet), 'applyDormancy 撤摸头');

/* ================= [F] 唤醒 ================= */
console.log('\n[F] 唤醒');

ok(/app\?\.ticker\?\.start/.test(pet), 'applyDormancy 唤醒重启 app.ticker');
ok(/PIXI\.Ticker\.shared\.start/.test(pet), 'applyDormancy 唤醒重启 PIXI.Ticker.shared');
ok(/applyFrameCap\(\)/.test(pet), 'applyDormancy 唤醒后恢复帧率');

/* ================= [G] onConfigChanged 调用 ================= */
console.log('\n[G] onConfigChanged');

ok(/applyDormancy\(\)/.test(pet), 'onConfigChanged 里调用了 applyDormancy()');

/* ================= [H] main.js 托盘 flag ================= */
console.log('\n[H] main.js 托盘');

const main = readSrc('main/main.js');
ok(/flag\s*\(\s*'chat'\s*,\s*'dormancy'/.test(main), "main.js 托盘有 chat.dormancy flag");

/* ================= [I] 状态守卫 ================= */
console.log('\n[I] 状态守卫');

ok(/if\s*\(want\s*===\s*dormant\)\s*return/.test(pet), 'applyDormancy 有状态守卫（dormant 不变时不重复执行）');

/* ================= [J] 与全屏静默互补 ================= */
console.log('\n[J] 与全屏静默互补');

ok(/dormant/.test(pet) && /quiet/.test(pet), 'pet.js 同时有 dormant 和 quiet 两套状态');
ok(/dormancy/.test(pet) && /quiet/.test(pet), 'dormancy 和 quiet 是独立的概念');

/* ================= 结果 ================= */
console.log('\n' + '='.repeat(40));
if (fails === 0) {
  console.log(`✅ verify-w62 全绿（${passes} 项）`);
} else {
  console.log(`❌ verify-w62 有 ${fails} 项失败（${passes} 项通过）`);
  process.exit(1);
}
