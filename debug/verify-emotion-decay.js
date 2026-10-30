'use strict';

/* 「情绪衰减回 calm」（Picard 指数曲线，第 8 轮定向调研落地）的回归。
 *
 * 覆盖两类风险：
 *   1) **数值层**（真的 import params.js 跑）：曲线算错 / 混合越界 /
 *      键集漏写 —— 全是静默失效，脸上看不出也报不出。
 *   2) **接线层**（源码断言）：pet.js 的三处顺序是这套东西的命 ——
 *      · setEmotion 的衰减清零必须在早退**之前**（同名再触发 = 重新饱满）；
 *      · 主循环必须 buildEmoTarget → mixEmoDecay → 插值循环（衰减要
 *        复用错峰插值，接错了就变成"整张脸齐刷刷回中性"）；
 *      · 开关读法必须 `!== false`（默认开，老配置没有这个键）。
 *
 * ⚠️ 主循环的推进逻辑（安定 5s 后启动、decayActive 闩住）在 pet.js 里
 *    碰 app/ticker 拿不出来，走源码断言；曲线本身是纯函数，喂假时钟
 *    逐点对 —— 和 verify-quiet-hours 同一条分界线。
 *
 * 跑法：node debug/verify-emotion-decay.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const PET = read('renderer/pet.js');

(async () => {
  /* ---- 复制 params.mjs + profiles/*.mjs 到临时目录再 import ----
   * params.js 从 profiles/hiyori.js import 档案数据 —— 得带上档案一起搬。 */
  const tmp = path.join(os.tmpdir(), `wb-params-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'profiles'), { recursive: true });
  /* params.js 从 profiles/<name>.js import 档案 —— 整个目录搬（同 verify-expressive）。 */
  for (const f of fs.readdirSync(path.join(SRC, 'renderer', 'profiles'))) {
    if (f.endsWith('.js')) fs.copyFileSync(
      path.join(SRC, 'renderer', 'profiles', f),
      path.join(tmp, 'profiles', f.replace(/\.js$/, '.mjs')));
  }
  fs.writeFileSync(
    path.join(tmp, 'params.mjs'),
    fs.readFileSync(path.join(SRC, 'renderer', 'params.js'), 'utf8')
      .replace(/'\.\/profiles\/([A-Za-z0-9_-]+)\.js'/g, "'./profiles/$1.mjs'"));
  let M;
  try {
    M = await import(pathToFileURL(path.join(tmp, 'params.mjs')).href);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const {
    EMOTION, EMO_RANGE, EMO_DECAY, EMO_DECAY_DEFAULT, EMO_DECAY_EPS,
    emoDecayAmt, mixEmoDecay, buildEmoTarget, EMO_SETTLE_HOLD_MS
  } = M;

  console.log('[A] EMO_DECAY —— 键集 = 情绪集，数值合法，效价排序（正快负慢）');
  {
    const emos = Object.keys(EMOTION).sort();
    const keys = Object.keys(EMO_DECAY).sort();
    ok(emos.length === 8, `情绪数 = 8`);
    ok(emoKeysEqual(emos, keys),
      `EMO_DECAY 键集与 EMOTION 一致${emoKeysEqual(emos, keys) ? '' : '（实际:' + keys + '）'}`);
    for (const [n, v] of Object.entries(EMO_DECAY)) {
      ok(typeof v === 'number' && v >= 0 && Number.isFinite(v),
        `${n} 的 τ 是非负有限数（实际 ${v}）`);
    }
    ok(EMO_DECAY.calm === 0, 'calm τ = 0（中性没有可衰减的对象）');
    ok(EMO_DECAY.surprised === Math.min(...Object.values(EMO_DECAY).filter((v) => v > 0)),
      'surprised 是最短的一档（惊讶转瞬即逝）');
    ok(EMO_DECAY.surprised < EMO_DECAY.happy && EMO_DECAY.happy < EMO_DECAY.smile,
      '正效价排序：surprised < happy < smile（浅笑挂得更久）');
    ok(EMO_DECAY.think < EMO_DECAY.serious,
      '负效价排序：think < serious（不快消得最慢）');
    ok(EMO_DECAY.happy < EMO_DECAY.think, '正快负慢：happy < think');
    ok(EMO_DECAY_DEFAULT > 0, '兜底 τ 是正数（漏键退 0 = 那个情绪永不衰减）');
    ok(EMO_DECAY_EPS > 0 && EMO_DECAY_EPS < 0.05,
      `EPS 在 (0, 0.05)（实际 ${EMO_DECAY_EPS}，太大会肉眼可见地"提前变脸"）`);
  }

  console.log('[B] emoDecayAmt —— 喂假时钟对 Picard 曲线 I(t) = e^(−t/τ)');
  {
    ok(emoDecayAmt('happy', 0) === 1, 't=0 满强度');
    ok(emoDecayAmt('happy', -500) === 1, '负数（还没启动）一律满强度');
    ok(emoDecayAmt('calm', 1) === 0, 'calm 启动即到底（τ=0）');
    ok(near(emoDecayAmt('happy', 30000), Math.exp(-1), 1e-12),
      'happy τ=30s：t=τ 时强度 = e^(-1) ≈ 0.368');
    ok(near(emoDecayAmt('surprised', 12000), Math.exp(-1), 1e-12),
      'surprised τ=12s：t=τ 时强度 = e^(-1)');
    ok(near(emoDecayAmt('nonexistent', 60000), Math.exp(-1), 1e-12),
      '表里没有的情绪走 EMO_DECAY_DEFAULT=60s 的曲线');
    /* 单调性 + EPS 截断 */
    let prev = 1, monotonic = true, hitZeroAt = -1;
    for (let ms = 0; ms <= 300000; ms += 100) {
      const a = emoDecayAmt('happy', ms);
      if (a > prev + 1e-12) { monotonic = false; break; }
      if (a === 0 && hitZeroAt < 0) hitZeroAt = ms;
      if (a > 0 && a <= EMO_DECAY_EPS) { ok(false, `EPS 归 0 失效：t=${ms} amt=${a}`); break; }
      prev = a;
    }
    ok(monotonic, '全程单调不回升');
    ok(hitZeroAt > 0 && hitZeroAt <= 125000,
      `EPS 截断生效（t=${hitZeroAt}ms 归 0；理论 ≈ 3.9τ = 117s）`);
    /* 快慢对照：同一时刻，surprised 比 serious 衰得快 */
    ok(emoDecayAmt('surprised', 30000) < emoDecayAmt('serious', 30000),
      't=30s 时惊讶已淡、严肃还浓（效价查表真的用上了）');
  }

  console.log('[C] mixEmoDecay —— 向 calm 混合：零侵入 / 到底 / 中点 / 不越界');
  {
    const clone = (o) => ({ ...o });
    const eff = clone(EMOTION.happy);
    mixEmoDecay(eff, 1);
    ok(deepEqual(eff, EMOTION.happy), 'amt=1 逐字段全等（满强度零侵入）');
    mixEmoDecay(eff, 1.5);
    ok(deepEqual(eff, EMOTION.happy), 'amt>1 同样不动（防御非规一输入）');

    const dead = clone(EMOTION.happy);
    mixEmoDecay(dead, 0);
    ok(deepEqual(dead, EMOTION.calm), 'amt=0 == calm（衰减到底）');

    const half = clone(EMOTION.happy);
    mixEmoDecay(half, 0.5);
    let midOk = true;
    for (const k in EMOTION.happy) {
      if (!near(half[k], (EMOTION.happy[k] + EMOTION.calm[k]) / 2, 1e-12)) { midOk = false; break; }
    }
    ok(midOk, 'amt=0.5 逐字段 = 中点（权重 w = 1 − amt 用对了方向）');

    /* 摸头调制过的目标再混合也不越界（凸组合不会顶出 EMO_RANGE） */
    const patted = {};
    buildEmoTarget(patted, EMOTION.shy, 1, 2.1);
    mixEmoDecay(patted, 0.37);
    let inRange = true;
    for (const k in patted) {
      const r = EMO_RANGE[k];
      if (r && (patted[k] < r[0] - 1e-9 || patted[k] > r[1] + 1e-9)) { inRange = false; break; }
    }
    ok(inRange, '调制 + 混合后所有字段仍在 EMO_RANGE 内');
    ok(deepEqual(Object.keys(patted).sort(), Object.keys(EMOTION.calm).sort()),
      '混合不增删键（键集仍 = 16 字段）');

    /* EPS 以下直接钳到 calm，而不是留一个 0.019 的残值 */
    const resid = clone(EMOTION.think);
    mixEmoDecay(resid, EMO_DECAY_EPS - 0.001);
    ok(deepEqual(resid, EMOTION.calm), 'amt ≤ EPS 直接归 calm（干净终点）');
  }

  console.log('[D] 喂假时钟 —— 复刻主循环推进：安定闩 + 衰减 + 同名再触发重置');
  {
    /* 复刻 pet.js 的推进逻辑（decayActive 闩），曲线对 emoDecayAmt 逐点核。 */
    let amt = 1, ms = 0, active = false, emotion = 'happy', steadyMs = 0;
    const step = (dtMs, deviating) => {
      steadyMs = deviating ? 0 : steadyMs + dtMs;
      if (!active && emotion !== 'calm' && steadyMs >= EMO_SETTLE_HOLD_MS) active = true;
      if (active && emotion !== 'calm') { ms += dtMs; amt = emoDecayAmt(emotion, ms); }
      return amt;
    };
    /* 前 5s：不安定（还在插值过渡）→ 不启动，强度恒 1 */
    for (let i = 0; i < 50; i++) step(100, true);
    ok(amt === 1 && !active, '过渡期（偏差超标）不启动衰减');
    /* 安定保持 5s：刚满那一刻启动 */
    for (let i = 0; i < 49; i++) step(100, false);
    ok(amt === 1 && !active, '保持到 4.9s 还没启动');
    step(100, false);
    ok(active, '安定满 5s 那一拍启动');
    /* 启动后即便偏差又超标（衰减自己在动）也继续推进。
     * 激活那一拍 ms 也 +100（与主循环同语义：先判启动、同一帧就推进），
     * 所以对的是「曲线在当前 ms 的取值」这个不变式，不是手算的整秒数。 */
    for (let i = 0; i < 100; i++) step(100, true);
    ok(active && near(amt, emoDecayAmt('happy', ms), 1e-12),
      `启动后偏差超标不再回看（闩住），强度恒等于曲线（ms=${ms}）`);
    /* 同名再触发 = 清零重置 */
    emotion = 'happy'; ms = 0; amt = 1; active = false;   // ← setEmotion 干的事
    for (let i = 0; i < 100; i++) step(100, false);
    ok(amt < 1, '重新安定后新一轮衰减又在走');
    /* 换 calm：不启动 */
    emotion = 'calm'; ms = 0; amt = 1; active = false;
    for (let i = 0; i < 200; i++) step(100, false);
    ok(amt === 1 && !active, 'calm 永不启动（没有可衰减的对象）');
  }

  console.log('[E] pet.js 接线 —— 三处顺序（清零在早退前 / 混合卡在插值前 / 开关默认开）');
  {
    const setFn = sliceFn(PET, 'setEmotion');
    ok(setFn.includes('decayAmt = 1') && setFn.includes('decayMs = 0') && setFn.includes('decayActive = false'),
      'setEmotion 里衰减三量全清零');
    ok(setFn.indexOf('decayAmt = 1') < setFn.indexOf("if (name === emotion) return;"),
      '清零在同名早退**之前**（再触发 = 重新饱满，不是接残量）');
    ok(setFn.indexOf('if (!EMOTION[name]) return;') < setFn.indexOf('decayAmt = 1'),
      '无效情绪名仍然整段早退（不认识的别去碰状态）');

    const ticker = between(PET, "app.ticker.add((ticker) => {", "}, null, PIXI.UPDATE_PRIORITY.LOW)");
    ok(!!ticker, '找到主循环体');
    if (ticker) {
      const iBuild = ticker.indexOf('buildEmoTarget(emoEff');
      const iMix = ticker.indexOf('mixEmoDecay(emoEff');
      const iLerp = ticker.indexOf('emoCur[key] += (emoEff[key] - emoCur[key])');
      ok(iBuild >= 0 && iMix >= 0 && iLerp >= 0, '主循环里三段都在');
      ok(iBuild < iMix, 'buildEmoTarget 在 mixEmoDecay 之前（混合的是调制后的目标）');
      ok(iMix < iLerp, 'mixEmoDecay 在插值循环之前（回落复用错峰插值）');
      ok(ticker.includes('cfg?.appearance?.emotionDecay !== false'),
        '开关读法 `!== false`（默认开，老配置无此键）');
      ok(ticker.includes('decayActive') && /emoDecayAmt\(emotion,\s*decayMs/.test(ticker),
        '启动条件 + 曲线推进都在主循环里');
      /* 关掉开关 = 回满强度（不硬跳） */
      const iElse = ticker.indexOf('} else if (decayAmt !== 1) {');
      ok(iElse > ticker.indexOf('mixEmoDecay(emoEff, decayAmt);'),
        '开关中途关掉有善后分支（decayAmt 回 1，插值自己滑回去）');
    }

    ok(PET.includes('decay: () => decayAmt,'), 'decay 强度露给了诊断探针（PET_SNAPSHOT=mood）');
  }

  console.log('[F] 配置与托盘 —— 默认值 + 菜单项 + 默认值取舍口径');
  {
    const CFG = read('main/config.js');
    ok(/emotionDecay:\s*true/.test(CFG), 'DEFAULT_CONFIG 的 appearance.emotionDecay = true');
    /* 默认开必须能对上 config.js 里那条"默认值取舍"的口径：不占资源也不打扰 */
    const MAIN = read('main/main.js');
    ok(MAIN.includes("flag('appearance', 'emotionDecay', '情绪自然回落')"),
      '托盘「外观与形象」里有勾选项');
  }

  console.log('[G] diag.js —— mood 探针带衰减追踪（肉眼之外的判据）');
  {
    const DIAG = read('renderer/diag.js');
    ok(DIAG.includes('decay: live.decay()'), 'mood 每档输出 decay 强度');
    ok(DIAG.includes("'[pet] decay-trace'"), '有 decay-trace 时间序列（曲线是否真在走）');
  }

  console.log(fails === 0 ? '\n情绪衰减：全部通过' : `\n情绪衰减：${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

/* ---- 与 verify-expressive 同款的小工具（这里再放一份：verify 之间不共享代码，
 *      免得改一处把另外十几个全带崩）---- */
function emoKeysEqual(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
function deepEqual(a, b) {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every((k) => a[k] === b[k]);
}
function sliceFn(src, name) {
  const head = src.indexOf(`function ${name}(`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = src.indexOf('\n}\n', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return src.slice(head, tail + 3);
}
function between(src, head, tail) {
  const i = src.indexOf(head);
  if (i < 0) return null;
  const j = src.indexOf(tail, i);
  if (j < 0) return null;
  return src.slice(i, j + tail.length);
}
