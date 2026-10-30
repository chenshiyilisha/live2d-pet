'use strict';

/* ============================================================
 *  情绪分轨 TTS（W11）
 * ==========================================================
 *  在基线 rate/pitch 上叠一档情绪偏置。中性 calm/默认 = 乘子 1。
 *  纯函数；verify 可直接 import。
 * ========================================================== */

/** @type {Record<string, { rate: number, pitch: number }>} */
export const EMO_VOICE = Object.freeze({
  calm: { rate: 1, pitch: 1 },
  smile: { rate: 1.04, pitch: 1.04 },
  happy: { rate: 1.08, pitch: 1.06 },
  shy: { rate: 0.98, pitch: 1.08 },
  surprised: { rate: 1.12, pitch: 1.1 },
  serious: { rate: 0.92, pitch: 0.9 },
  sleepy: { rate: 0.88, pitch: 0.94 },
  think: { rate: 0.96, pitch: 1 }
});

/**
 * @param {{ rate?: number, pitch?: number, voice?: string }} base
 * @param {string} emotion
 * @param {{ enabled?: boolean }} opts
 */
export function applyEmotionVoice(base, emotion, opts = {}) {
  const rate0 = Number(base?.rate);
  const pitch0 = Number(base?.pitch);
  const out = {
    rate: Number.isFinite(rate0) ? rate0 : 1.05,
    pitch: Number.isFinite(pitch0) ? pitch0 : 1,
    voice: String(base?.voice || '')
  };
  if (opts.enabled === false) return out;
  const key = String(emotion || 'calm');
  const mul = EMO_VOICE[key] || EMO_VOICE.calm;
  out.rate = Math.min(3, Math.max(0.5, out.rate * mul.rate));
  out.pitch = Math.min(2, Math.max(0, out.pitch * mul.pitch));
  return out;
}
