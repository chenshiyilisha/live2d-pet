'use strict';
/* 表情节奏抖动的验收。
 *
 * jitter.js 是浏览器 ESM，node 直接 require 不进来 —— 但它是纯函数、
 * 零依赖，所以剥掉 `export ` 前缀丢进 vm 跑（与 verify-vad.js 同款手法）。
 *
 * 两块内容：
 *   A. PRNG 与 rollFactors 本身 —— 确定性、值域、键集、两次不相同。
 *   B. 源码级接线 —— 开关语义、重抽位置、关掉时的"不抽"分支（这条最关键：
 *      写错就会白白推进随机数序列，开关来回切一次换一套抖动、不可复现）。
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-jitter.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

const sandbox = { console };
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(ROOT, 'src/renderer/jitter.js'), 'utf8')
  .replace(/^export\s+/gm, '');
vm.runInContext(
  src + '\n;globalThis.__api = { JITTER_SEED, JITTER_RATIO, rollFactors, makeRng };',
  sandbox
);
const { JITTER_SEED, JITTER_RATIO, rollFactors, makeRng } = sandbox.__api;

const KEYS = ['browLY', 'browRY', 'eyeOpen', 'mouthForm', 'cheek', 'headY', 'shoulder', 'bodyY'];

console.log('══════ A. PRNG 与因素 ══════\n');

/* 1) 确定性：同种子 → 逐位相同的序列 */
{
  const a = makeRng(JITTER_SEED);
  const b = makeRng(JITTER_SEED);
  const sa = Array.from({ length: 50 }, () => a());
  const sb = Array.from({ length: 50 }, () => b());
  check(sa.every((v, i) => v === sb[i]), '同种子 → 50 个采样逐位相同（可复现）');
  check(sa.some((v) => v !== sa[0]), '序列不是常数（真的在走）');
  check(sa.every((v) => v >= 0 && v < 1), '采样全部落在 [0,1)');
}

/* 2) 不同种子 → 序列不同 */
{
  const a = makeRng(1);
  const b = makeRng(2);
  check(Array.from({ length: 20 }, () => a()).join() !== Array.from({ length: 20 }, () => b()).join(),
    '不同种子 → 不同序列（种子真的在起作用）');
}

/* 3) rollFactors：键集与值域 */
{
  const f = rollFactors(KEYS);
  check(Object.keys(f).sort().join() === [...KEYS].sort().join(), '键集与传入完全一致');
  check(Object.values(f).every((v) => v >= 1 - JITTER_RATIO - 1e-9 && v <= 1 + JITTER_RATIO + 1e-9),
    `全部落在 1±${JITTER_RATIO}（实测 ${Math.min(...Object.values(f)).toFixed(3)} ~ ${Math.max(...Object.values(f)).toFixed(3)}）`);
  check(new Set(Object.values(f)).size === KEYS.length, '各字段因子互不相同（不是整张脸同乘一个数）');
}

/* 4) ratio=0 → 全 1（这是"关掉开关"的数学等价，虽然实际走的是 null 分支） */
{
  const f = rollFactors(KEYS, 0);
  check(Object.values(f).every((v) => v === 1), 'ratio=0 → 因子恒为 1（乘上去逐位不变）');
}

/* 5) 两次调用结果不同 —— 这就是"同一情绪两次进入节奏不同"的根据 */
{
  const a = rollFactors(KEYS).browLY;
  const b = rollFactors(KEYS).browLY;
  check(a !== b, `连续两次抽取不同（${a.toFixed(4)} vs ${b.toFixed(4)}）`);
}

/* 6) 均值回归：大样本下均值应接近 1（±0.01） */
{
  let sum = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) sum += rollFactors(['k']).k;
  const mean = sum / N;
  check(Math.abs(mean - 1) < 0.01, `2000 次抽样均值 ≈ 1（实测 ${mean.toFixed(4)}）`);
}

/* 7) 抖动不改变"错峰"的方向：最慢的字段（bodyY=2.2）仍应明显慢于最快的（browLY=9） */
{
  const EMO_SPEED = { browLY: 9, bodyY: 2.2 };
  const f = rollFactors(['browLY', 'bodyY']);
  const spBrow = EMO_SPEED.browLY * f.browLY;
  const spBody = EMO_SPEED.bodyY * f.bodyY;
  check(spBrow > spBody * 2, `抖动后错峰方向不变（眉 ${spBrow.toFixed(2)} vs 身 ${spBody.toFixed(2)}，仍 >2×）`);
}

console.log('\n══════ B. 接线（源码级） ══════\n');

const pet = fs.readFileSync(path.join(ROOT, 'src/renderer/pet.js'), 'utf8');

check(/import\s*\{\s*rollFactors\s*\}\s*from\s*'\.\/jitter\.js'/.test(pet),
  "pet.js 从 './jitter.js' 引进 rollFactors");
check(/emoJitter\s*=\s*rollFactors\(Object\.keys\(EMOTION\.calm\)\)/.test(pet),
  '初始 emoJitter 就绪（不是 null —— 首次切换前也已确定）');
check(/function setEmotion[\s\S]{0,400}?rollFactors\(Object\.keys\(emoTarget\)\)/.test(pet),
  'setEmotion 里重抽一整套（切换点唯一，不会漏抽）');
check(/emoJitter\s*=\s*cfg\?\.appearance\?\.jitter\s*===\s*false\s*\n?\s*\?\s*null/.test(pet),
  '开关语义：`=== false ? null` —— 默认开，关掉时**不抽**（不推进随机序列）');
check(/emoJitter\s*\?\s*emoJitter\[key\]\s*\?\?\s*1\s*:\s*1/.test(pet),
  '主循环乘因子，emoJitter 为 null 时乘 1（与旧版逐位一致）');

/* 旧公式不许还在（留着说明改了一半、两处都生效） */
check(!/const sp = EMO_SPEED\[key\] \?\? EMO_SPEED_DEFAULT;/.test(pet),
  '旧的一行（不加因子）已经不存在 —— 没有"改一半"');

const cfg = fs.readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8');
check(/appearance:\s*\{[\s\S]*?jitter:\s*true/.test(cfg), 'config.js 的 appearance 段默认 jitter: true');

const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
check(/flag\('appearance',\s*'jitter'/.test(main), "main.js 托盘有「表情节奏抖动」勾选项（硬规矩 4）");

console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（表情节奏抖动）');
