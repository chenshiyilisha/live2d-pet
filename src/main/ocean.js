'use strict';

/* ============================================================
 *  OCEAN 轻量人格偏置（P3 + W10）
 * ==========================================================
 *
 *  四维：
 *    E 外向 Extraversion
 *    N 神经质 Neuroticism
 *    A 宜人 Agreeableness
 *    T 话痨 Talkativeness（W10；忙时少插嘴 ≈ 低档）
 *  各维 0~1，默认 0.5 = 中性（乘子 ≈1，行为与没这功能时一致）。
 *
 *  落到现成旋钮上（不另写一套性格系统）：
 *    · E↑ → 正面情绪衰减更慢；并与 T 一起缩短 idle 间隔
 *    · T↑ → 主动搭话更勤（idle 再乘一档；中性 ×1）
 *    · N↑ → 负面情绪衰减更慢（「更缠」）
 *    · A↑ → 气泡停留更久（读得下更长一句）；被搭理时 pride 放软更快
 *
 *  纯函数；verify-ocean.js 直接 node 跑。
 * ========================================================== */

const DIMS = [
  { key: 'E', label: '外向', low: '内敛', high: '外向' },
  { key: 'N', label: '敏感', low: '淡定', high: '敏感' },
  { key: 'A', label: '温柔', low: '清冷', high: '温柔' },
  { key: 'T', label: '话痨', low: '寡言', high: '话痨' }
];

const LEVELS = [
  { id: 'low', label: '低', value: 0.2 },
  { id: 'mid', label: '中', value: 0.5 },
  { id: 'high', label: '高', value: 0.8 }
];

const POSITIVE = new Set(['happy', 'smile', 'shy', 'surprised']);
const NEGATIVE = new Set(['serious']);

function clamp01(v, fallback = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t, 0.5);
}

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    E: clamp01(src.E, 0.5),
    N: clamp01(src.N, 0.5),
    A: clamp01(src.A, 0.5),
    T: clamp01(src.T, 0.5)
  };
}

/** 把连续值归到最近一档（托盘 radio 用）。 */
function nearestLevel(v) {
  const x = clamp01(v, 0.5);
  let best = LEVELS[1];
  let bestD = Infinity;
  for (const lv of LEVELS) {
    const d = Math.abs(lv.value - x);
    if (d < bestD) { bestD = d; best = lv; }
  }
  return best;
}

/**
 * 由人格算出消费端乘子。中性 0.5 → 全 ≈1。
 * @returns {{
 *   idleMinutesMul: number,
 *   positiveDecayMul: number,
 *   negativeDecayMul: number,
 *   bubbleReadMul: number,
 *   prideSoftMul: number
 * }}
 */
function derive(raw) {
  const o = normalize(raw);
  /* ⚠️ 端点必须关于 0.5 对称到 1：lerp(a,b,0.5)=(a+b)/2 ≡ 1，
   * 否则默认性格也会悄悄改行为（验收线：中性 ≈ 没这功能）。 */
  const eIdle = lerp(1.45, 0.55, o.E);
  /* W10：话痨再乘一档；端点关于 0.5 对称 → 中性 ×1 */
  const tIdle = lerp(1.35, 0.65, o.T);
  return {
    /* E×T：更勤开口（间隔缩短） */
    idleMinutesMul: eIdle * tIdle,
    /* E↑：正面情绪 τ 放大 → 衰减更慢 */
    positiveDecayMul: lerp(0.7, 1.3, o.E),
    /* N↑：负面情绪更缠 */
    negativeDecayMul: lerp(0.7, 1.3, o.N),
    /* A↑：气泡多停一会儿（字多也读得完） */
    bubbleReadMul: lerp(0.7, 1.3, o.A),
    /* A↑：被搭理时端着放软更快（softening 是负增量，乘子 >1 更软） */
    prideSoftMul: lerp(0.7, 1.3, o.A)
  };
}

/** 某情绪本次衰减用的 τ 乘子（喂给 emoDecayAmt 的时钟缩放）。 */
function decayMulFor(emotion, raw) {
  const d = derive(raw);
  if (POSITIVE.has(emotion)) return d.positiveDecayMul;
  if (NEGATIVE.has(emotion)) return d.negativeDecayMul;
  return 1;
}

module.exports = {
  DIMS,
  LEVELS,
  POSITIVE,
  NEGATIVE,
  clamp01,
  normalize,
  nearestLevel,
  derive,
  decayMulFor
};
