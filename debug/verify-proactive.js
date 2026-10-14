'use strict';
/* 主动搭话判据的验收。
 *
 * 这次改的东西分散在三个文件里（params.js / pet.js / main.js），
 * 三块内容各自独立：
 *   A. 情绪安定判据本身（纯函数 emotionDeviation + 阈值口径）
 *   B. 渲染层的接线（重试而不是重排整周期、闸门的三个条件、带情绪和历史）
 *   C. 主进程侧（按情绪挑话头、收历史、键集与 EMOTION 对齐）
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-proactive.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* params.js 是浏览器 ESM —— 剥掉 export 丢进 vm（与 verify-jitter.js 同款手法）。 */
const pSandbox = { console, Math };
vm.createContext(pSandbox);
vm.runInContext(
  read('src/renderer/params.js').replace(/^export\s+/gm, '') +
  '\n;globalThis.__api = { EMOTION, EMO_SETTLE_EPS, EMO_SETTLE_HOLD_MS, emotionDeviation };',
  pSandbox
);
const { EMOTION, EMO_SETTLE_EPS, EMO_SETTLE_HOLD_MS, emotionDeviation } = pSandbox.__api;

const EMO_KEYS = Object.keys(EMOTION);
const PET = read('src/renderer/pet.js');
const MAIN = read('src/main/main.js');

console.log('══════ A. 情绪安定判据（纯函数） ══════\n');

/* 1) 口径：取最大偏差，不是平均 */
{
  const cur = { a: 0.5, b: 0.5, c: 0.5 };
  const eff = { a: 0.5, b: 0.5, c: 0.55 };
  check(Math.abs(emotionDeviation(cur, eff) - 0.05) < 1e-12, '取的是**最大**偏差（0.05）');

  // 平均会被十几个已到位的字段稀释：这里 15 个字段零偏差 + 1 个大偏差，
  // 平均值只有 0.5/16 ≈ 0.031（在阈值内，会被误判成安定），最大值才是真相。
  const near = {}; const far = {};
  for (let i = 0; i < 15; i++) { near['k' + i] = 0; far['k' + i] = 0; }
  near.browLY = 0.5; far.browLY = 0;
  check(emotionDeviation(far, near) === 0.5,
    '单个字段没到位就**不算**安定（平均值会被稀释掉，这条拦住那种写法）');
  check(emotionDeviation(far, far) === 0, '完全一致 → 偏差 0');
}

/* 2) 边界：阈值两侧语义 */
{
  const eff = { x: 1 };
  check(emotionDeviation({ x: 1 - EMO_SETTLE_EPS / 2 }, eff) < EMO_SETTLE_EPS,
    '偏差 < 阈值 → 算收敛');
  check(!(emotionDeviation({ x: 1 - EMO_SETTLE_EPS * 2 }, eff) < EMO_SETTLE_EPS),
    '偏差 > 阈值 → 不算收敛');
  check(EMO_SETTLE_EPS > 0 && EMO_SETTLE_EPS < 0.2,
    '阈值落在"看不出还在动"的量级（0.06）');
  check(EMO_SETTLE_HOLD_MS === 5000, '保持 5 秒（与调研里 soullink 的 settledHoldSeconds 同值）');
}

/* 3) 真实情绪表：从 calm 切到别的情绪，初始偏差远大于阈值（否则判据形同虚设） */
{
  const calm = EMOTION.calm;
  // ⚠️ 排除 calm 对自己（偏差当然是 0）—— 这条量的是"切换"的落差
  const devs = EMO_KEYS.filter((k) => k !== 'calm')
    .map((k) => ({ k, d: emotionDeviation(calm, EMOTION[k]) }));
  const min = Math.min(...devs.map((d) => d.d));
  const max = Math.max(...devs.map((d) => d.d));
  const argmin = devs.find((d) => d.d === min).k;
  check(devs.every((d) => d.d > EMO_SETTLE_EPS * 2),
    `最"接近 calm"的 ${argmin} 初始偏差也有 ${min}（> 2×阈值，判据真的会拦）`);
  console.log(`     （初始偏差范围 ${min} ~ ${max}，阈值 ${EMO_SETTLE_EPS}）`);
}

/* 4) 指数逼近下"多久能安定"—— 口径自洽性检查（写进注释的数要能对上） */
{
  // 从偏差 0.5 收敛到 eps：0.5·e^(−s·t) = eps → t = ln(0.5/eps)/s
  const slowest = 2.2;   // EMO_SPEED 里最小的那个（bodyY/bodyZ）
  const t = Math.log(0.5 / EMO_SETTLE_EPS) / slowest;
  check(t > 0.5 && t < 3, `最慢的字段（速度 ${slowest}）从满幅情绪收敛到阈值约 ${t.toFixed(2)}s`);
}

console.log('\n══════ B. 渲染层接线 ══════\n');

/* 5) 安定计时由主循环推进（不是另起一个时钟 —— 规矩 16） */
{
  check(/emoSteadyMs\s*=\s*emotionDeviation\(emoCur,\s*emoEff\)\s*<\s*EMO_SETTLE_EPS/.test(PET),
    '安定计时量的是 emoCur 对 emoEff 的偏差（摸头调制也算在内）');
  check(/\?\s*emoSteadyMs\s*\+\s*dt\s*\*\s*1000\s*:\s*0/.test(PET),
    '偏差落回阈值内才累加，一超就归零');
  check((PET.match(/setInterval/g) || []).length === 0, '全程没有 setInterval（规矩 16）');
}

/* 6) 🔴 闸门与"短周期重试"—— 这次真正修掉的东西 */
{
  check(/reason|function proactiveBlockedBy/.test(PET) && /function proactiveBlockedBy\(\)/.test(PET),
    '有一个集中的"此刻能不能开口"判定');
  const gate = PET.slice(PET.indexOf('function proactiveBlockedBy()'), PET.indexOf('async function proactiveSpeak()'));
  check(/busy/.test(gate) && /state !== State\.IDLE/.test(gate) && /emoSteadyMs < EMO_SETTLE_HOLD_MS/.test(gate),
    '闸门三个条件：正忙 / 不在空闲态 / 情绪没安定');
  check(/retryIdleTimer\(\);/.test(PET) && /PROACTIVE_RETRY_MS\s*=\s*2000/.test(PET),
    '被闸门拦下 → 2 秒后再看一眼');
  // 关键：延后路径**不能**再调 pokeIdleTimer()（那会重排一整个闲置周期 = 这次不出声了）
  const defer = PET.slice(PET.indexOf('const why = proactiveBlockedBy();'), PET.indexOf('if (!hasApiKey)'));
  check(!/pokeIdleTimer\(\)/.test(defer),
    '🔴 延后路径里没有 pokeIdleTimer()（老代码在这里重排整个 8 分钟周期）');
}

/* 7) 带情绪和历史过去 */
{
  check(/window\.pet\.proactive\(\{\s*emotion,\s*history:\s*history\.slice\(-6\)\s*\}\)/.test(PET),
    '主动搭话把当前情绪 + 最近 6 条历史一起发给主进程');
  check(!/window\.pet\.proactive\(\)/.test(PET), '旧的"空手调用"已经不存在');
}

/* 8) 本地短句池按情绪分（8 个情绪都要有） */
{
  const m = PET.match(/const PROACTIVE_LINES = \{([\s\S]*?)\n\};/);
  check(!!m, 'PROACTIVE_LINES 是一张按情绪分的表');
  if (m) {
    const keys = [...m[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((x) => x[1]);
    const missing = EMO_KEYS.filter((k) => !keys.includes(k));
    check(missing.length === 0, `8 个情绪一个不缺（缺：${missing.join(',') || '无'}）`);
    check(!/PROACTIVE_LINES\[Math\.floor/.test(PET),
      '取话一律走 proactiveLine()（它有兜底，定时器回调里不许抛）');
    check(/function proactiveLine\(/.test(PET), 'proactiveLine() 存在');
  }

  /* 本地路径说完要把她放回中性，否则表情停在 smile → 下一轮只会从 smile 池挑，
   * "按情绪分池"就退化成了单池（实跑日志里连着几条都是 smile 池）。 */
  const local = PET.slice(PET.indexOf('const line = proactiveLine(emotion);'), PET.indexOf('busy = true;'));
  check(/setTimeout\(/.test(local) && /setEmotion\('calm'\)/.test(local), '本地话术说完把情绪放回中性');
  check(/emotion === 'smile'/.test(local) && /patState === 'idle'/.test(local) && /!busy/.test(local),
    '放回中性有守卫（这 2.6 秒里用户摸了她 / 聊了一轮就不许按回去）');
}

console.log('\n══════ C. 主进程侧 ══════\n');

/* 9) 话头按情绪给方向，且键集与 EMOTION 一致 */
{
  const m = MAIN.match(/const PROACTIVE_MOOD_HINT = \{([\s\S]*?)\n\};/);
  check(!!m, '主进程有一张按情绪的话头表');
  if (m) {
    const keys = [...m[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((x) => x[1]);
    const missing = EMO_KEYS.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !EMO_KEYS.includes(k));
    check(missing.length === 0 && extra.length === 0,
      `键集与 params.js 的 EMOTION 完全一致（缺：${missing.join(',') || '无'}；多：${extra.join(',') || '无'}）`);
    check(/\|\|\s*PROACTIVE_MOOD_HINT\.calm/.test(MAIN), '查不到情绪时退回 calm，不会给出 undefined');
  }
  check(/proactiveMoodHint\(c\.emotion\)/.test(MAIN), 'prompt 里真的拼上了情绪提示');
}

/* 10) 历史被收进来 + 校验 */
{
  check(/\.\.\.past,/.test(MAIN), '历史真的传给了对话后端');
  check(/m\.role === 'user' \|\| m\.role === 'assistant'/.test(MAIN),
    '历史条目按形状过滤（渲染层传来的东西不能直接信）');
  check(/const c = \(ctx && typeof ctx === 'object'\) \? ctx : \{\}/.test(MAIN),
    '主进程对 ctx 做了缺省兜底（老版本渲染层传 undefined 也不炸）');
}

console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（主动搭话判据）');
