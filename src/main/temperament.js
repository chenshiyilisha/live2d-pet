'use strict';

/* ============================================================
 *  Temperament 慢层（P5）
 * ==========================================================
 *
 *  mood 日均 → 气质偏置。不改人设正文，只调漂移乘子 + 一句可选语气提示。
 *  日更 EMA：当天样本累加，换日再折进气质（τ≈7 天）。
 * ========================================================== */

function clamp01(v, fb = 0.5) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function lerp(a, b, t) {
  return a + (b - a) * clamp01(t);
}

function createTemperament(seed) {
  const T = {
    warmth: 0.5,   // ← 日均 valence
    cling: 0.5,    // ← 日均 social
    vitality: 0.5, // ← 日均 energy
    reserve: 0.5,  // ← 日均 pride
    dayKey: '',
    sumV: 0, sumS: 0, sumE: 0, sumP: 0,
    samples: 0
  };
  if (seed && typeof seed === 'object') {
    T.warmth = clamp01(seed.warmth);
    T.cling = clamp01(seed.cling);
    T.vitality = clamp01(seed.vitality);
    T.reserve = clamp01(seed.reserve);
  }

  const ALPHA = 1 / 7; // 约一周半衰期

  function foldDay() {
    if (T.samples <= 0) return;
    const avgV = T.sumV / T.samples;
    const avgS = T.sumS / T.samples;
    const avgE = T.sumE / T.samples;
    const avgP = T.sumP / T.samples;
    T.warmth = clamp01(T.warmth * (1 - ALPHA) + avgV * ALPHA);
    T.cling = clamp01(T.cling * (1 - ALPHA) + avgS * ALPHA);
    T.vitality = clamp01(T.vitality * (1 - ALPHA) + avgE * ALPHA);
    T.reserve = clamp01(T.reserve * (1 - ALPHA) + avgP * ALPHA);
    T.sumV = T.sumS = T.sumE = T.sumP = 0;
    T.samples = 0;
  }

  function observe(axes, now = Date.now()) {
    if (!axes || typeof axes !== 'object') return;
    const key = dayKey(now);
    if (T.dayKey && T.dayKey !== key) foldDay();
    T.dayKey = key;
    T.sumV += clamp01(axes.valence);
    T.sumS += clamp01(axes.social);
    T.sumE += clamp01(axes.energy);
    T.sumP += clamp01(axes.pride);
    T.samples++;
  }

  /* 乘子绕 1.0：气质偏高/偏低最多 ±15%，避免压死人设。 */
  function rateMul() {
    return {
      socialRiseMul: lerp(0.85, 1.15, T.cling),
      valencePullMul: lerp(1.1, 0.9, T.warmth), // 暖 → 心情回中更慢
      energyDriftMul: lerp(1.12, 0.88, T.vitality), // 活力高 → 耗得慢
      pridePullMul: lerp(0.9, 1.1, T.reserve)
    };
  }

  function promptHint() {
    const parts = [];
    if (T.warmth >= 0.65) parts.push('近来性情偏暖');
    else if (T.warmth <= 0.35) parts.push('近来性情偏沉');
    if (T.cling >= 0.65) parts.push('有点黏人');
    if (T.vitality <= 0.35) parts.push('这阵子提不起劲');
    if (T.reserve >= 0.7) parts.push('仍有点端着');
    return parts.join('，');
  }

  function snapshot() {
    return {
      warmth: T.warmth, cling: T.cling, vitality: T.vitality, reserve: T.reserve,
      dayKey: T.dayKey, samples: T.samples
    };
  }

  function hydrate(raw) {
    if (!raw || typeof raw !== 'object') return;
    T.warmth = clamp01(raw.warmth, T.warmth);
    T.cling = clamp01(raw.cling, T.cling);
    T.vitality = clamp01(raw.vitality, T.vitality);
    T.reserve = clamp01(raw.reserve, T.reserve);
    if (typeof raw.dayKey === 'string') T.dayKey = raw.dayKey;
  }

  return { observe, foldDay, rateMul, promptHint, snapshot, hydrate };
}

module.exports = { createTemperament, dayKey, clamp01 };
