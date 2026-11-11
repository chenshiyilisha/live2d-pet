'use strict';
/* W58 闲置边界触发 proactive —— motion.js 的逻辑单测（同步版）。
 *
 * 语义：主动冒泡从"距上次交互的墙钟计时"改为"系统级闲置（用户真没碰
 * 键鼠）跨过 idleMinutes 才触发"。墙钟口径的问题：用户聊完天后忙别的
 * （打字/点别的窗口），8 分钟后她照常冒泡 = 打扰；边界口径下只有用户
 * 真离开键鼠才冒泡。
 *
 * 出处：qq-dsh-bridge 的"闲置边界压缩"（MIT，§22.8 归档）。
 *
 * node debug/verify-w58.js
 */
const { makeMotionEnv } = require('./lib-motion-stub');

let passed = 0, failed = 0;
const ok = (m) => { passed++; console.log('  ✅ ' + m); };
const no = (m) => { failed++; console.log('  ❌ ' + m); };
const check = (c, m) => (c ? ok(m) : no(m));
const eq = (a, b, m) => check(a === b, `${m}（期望 ${b} 实际 ${a}）`);

function section(t) { console.log('\n== ' + t + ' =='); }

const BASE_CFG = {
  motion: { enabled: true, edgeSnap: true, wander: false, returnOnActivity: true }
};

const env = makeMotionEnv({
  cfg: { ...BASE_CFG, proactive: { idleBoundary: true, idleMinutes: 8 } }
});

const IDLE_BOUNDARY = 'pet:proactive-boundary';
const tick = () => env.motion.idleTickForTest();

section('A. 开关关：闲置多久都不发边界事件');
env.writeConfig({ ...BASE_CFG, proactive: { idleBoundary: false, idleMinutes: 8 } });
env.motion.setIdleForTest(9999);             // 闲置 9999 秒（远超 8 分钟）
tick();
tick();
eq(env.countOf(IDLE_BOUNDARY), 0, '开关关 → 闲置 9999s 不发边界事件');
eq(env.motion.proactiveArmedForTest(), true, '开关关时武装状态不变');

section('B. 开关开：闲置跨过阈值发一次');
env.writeConfig({ ...BASE_CFG, proactive: { idleBoundary: true, idleMinutes: 8 } });
env.motion.setIdleForTest(9999);             // 闲置 9999s ≥ 8min
tick();
eq(env.countOf(IDLE_BOUNDARY), 1, '闲置 9999s（≥8min）→ 发 1 次边界事件');
eq(env.motion.proactiveArmedForTest(), false, '触发后武装解除');

section('C. 持续闲置不刷屏（武装解除后不再发）');
env.clear();
tick();                                      // 还是 9999s，武装已解除
tick();
eq(env.countOf(IDLE_BOUNDARY), 0, '持续闲置再 tick → 不再发（武装已解除）');

section('D. 用户操作后重新武装，再次闲置再发');
env.motion.setIdleForTest(0.5);              // 用户操作（< 1s）
tick();
eq(env.motion.proactiveArmedForTest(), true, '用户操作 → 重新武装');
env.clear();
env.motion.setIdleForTest(9999);             // 再次闲置
tick();
eq(env.countOf(IDLE_BOUNDARY), 1, '操作→闲置 → 再发 1 次');
eq(env.motion.proactiveArmedForTest(), false, '再次触发后武装解除');

section('E. 闲置未到阈值不发');
env.motion.setIdleForTest(0.5);              // 先武装
tick();
env.clear();
env.motion.setIdleForTest(479);              // 479 秒 < 8 分钟（480s）
tick();
eq(env.countOf(IDLE_BOUNDARY), 0, '闲置 479s（<8min）→ 不发');
env.motion.setIdleForTest(480);              // 刚好跨过
tick();
eq(env.countOf(IDLE_BOUNDARY), 1, '闲置 480s（=8min）→ 发 1 次');

section('F. 负对照 1：负数 idleMinutes → 走默认 8 分钟（与渲染层 scaled 同式）');
env.motion.setIdleForTest(0.5);              // 武装
tick();
env.clear();
env.writeConfig({ ...BASE_CFG, proactive: { idleBoundary: true, idleMinutes: -5 } });
env.motion.setIdleForTest(0.5);
tick();                                       // 重新武装
env.clear();
env.motion.setIdleForTest(3);                // 3 秒 < 8 分钟
tick();
eq(env.countOf(IDLE_BOUNDARY), 0, 'idleMinutes=-5 → 3s 不发（走默认 8min）');
env.motion.setIdleForTest(0.5);
tick();
env.clear();
env.motion.setIdleForTest(480);              // 8 分钟
tick();
eq(env.countOf(IDLE_BOUNDARY), 1, 'idleMinutes=-5 → 480s 触发（默认 8min）');

section('G. 负对照 2：缺失 idleMinutes → 默认 8');
env.motion.setIdleForTest(0.5);
tick();
env.clear();
env.writeConfig({ ...BASE_CFG, proactive: { idleBoundary: true } });
env.motion.setIdleForTest(0.5);
tick();
env.clear();
env.motion.setIdleForTest(480);              // 8 分钟
tick();
eq(env.countOf(IDLE_BOUNDARY), 1, 'idleMinutes 缺失 → 默认 8min 触发');

section('H. 负对照 3：motion.enabled 关 → 整个 tick 不做');
env.motion.setIdleForTest(0.5);
tick();
env.clear();
env.writeConfig({ motion: { enabled: false }, proactive: { idleBoundary: true, idleMinutes: 8 } });
env.motion.setIdleForTest(9999);
tick();
eq(env.countOf(IDLE_BOUNDARY), 0, 'motion.enabled=false → 闲置也不发');

section('I. proactiveBoundaryMs 公式（与渲染层 scaled 同式）');
const ms1 = env.motion.proactiveBoundaryMs({
  proactive: { idleMinutes: 8 }, ocean: { idleMinutesMul: 1 }, presenceMul: 1
});
eq(ms1, 480000, '默认 8 分钟 → 480000ms');
const ms2 = env.motion.proactiveBoundaryMs({
  proactive: { idleMinutes: 8 }, ocean: { idleMinutesMul: 0.5 }, presenceMul: 2
});
eq(ms2, 480000, '乘子 0.5×2 → 480000ms（等效 8 分钟）');
const ms3 = env.motion.proactiveBoundaryMs({
  proactive: { idleMinutes: 999 }, ocean: { idleMinutesMul: 1 }, presenceMul: 1
});
eq(ms3, 999 * 60000, '999 分钟（不夹上界）');
const ms4 = env.motion.proactiveBoundaryMs({ proactive: {} });
eq(ms4, 480000, 'idleMinutes 缺失 → 默认 8');
const ms5 = env.motion.proactiveBoundaryMs({
  proactive: { idleMinutes: 8 }, ocean: { idleMinutesMul: 0 }, presenceMul: 1
});
eq(ms5, 480000, 'ocean 乘子 0 → 视为 1（!0 兜底）');

section('J. 渲染层 pokeIdleTimer 开关分支（源码级断言）');
const fs = require('fs');
const petSrc = fs.readFileSync(require('path').join(__dirname, '..', 'src/renderer/pet.js'), 'utf8');
check(
  /if\s*\(cfg\?\.proactive\?\.idleBoundary === true\)\s*return;/.test(petSrc),
  'pokeIdleTimer 里有 W58 开关分支（开时不排墙钟定时器）'
);
check(
  /window\.pet\?\.on\?\.\('pet:proactive-boundary'/.test(petSrc),
  'pet.js 监听 pet:proactive-boundary'
);
check(
  /proactiveSpeak\(\)/.test(petSrc.split("pet:proactive-boundary")[1] || ''),
  '收到边界事件 → 调 proactiveSpeak'
);

section('K. preload 白名单 + config 开关');
const preSrc = fs.readFileSync(require('path').join(__dirname, '..', 'src/main/preload.js'), 'utf8');
check(preSrc.includes("'pet:proactive-boundary'"), 'preload 白名单含 pet:proactive-boundary');
const cfgSrc = fs.readFileSync(require('path').join(__dirname, '..', 'src/main/config.js'), 'utf8');
check(/idleBoundary:\s*false/.test(cfgSrc), 'config 默认关（表外增强）');

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
