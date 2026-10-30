'use strict';

/* ============================================================
 *  触摸响应档（W19）
 * ==========================================================
 *  quiet  ：少反应 —— 连戳门槛更高、摸头更快害羞/挣脱
 *  normal ：现有常数（= Custom 基线；单项 headPat/pokeReact 仍可关）
 *  eager  ：多反应 —— 连戳更敏感、摸头更耐蹭
 *
 *  纯函数；verify 可直接 import。
 * ========================================================== */

const MODES = Object.freeze([
  { id: 'quiet', label: '安静' },
  { id: 'normal', label: '平常' },
  { id: 'eager', label: '热情' }
]);

/** @returns {'quiet'|'normal'|'eager'} */
function normalizeTouchMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'quiet' || s === 'eager') return s;
  /* custom → normal：Custom = 平常 + 单项开关 */
  return 'normal';
}

/**
 * 连戳递进门槛（W13 基线 4/6/8）。
 * @returns {{ annoy: number, hurt: number, mad: number }}
 */
function pokeThresholds(mode) {
  const m = normalizeTouchMode(mode);
  if (m === 'quiet') return { annoy: 6, hurt: 9, mad: 12 };
  if (m === 'eager') return { annoy: 3, hurt: 4, mad: 6 };
  return { annoy: 4, hurt: 6, mad: 8 };
}

/**
 * 摸头时间门槛（乘在 PAT 基线上）。
 * @param {string} mode
 * @param {{ shyMs:number, nagMs:number, angryMs:number, escapeMs:number }} base
 */
function patThresholds(mode, base) {
  const m = normalizeTouchMode(mode);
  const scale = m === 'quiet' ? 0.7 : m === 'eager' ? 1.35 : 1;
  const shyMs = Math.round(base.shyMs * scale);
  const nagMs = Math.round(base.nagMs * scale);
  const angryMs = Math.round(base.angryMs * scale);
  let escapeMs = Math.round(base.escapeMs * scale);
  /* 保序：shy < nag < angry < escape */
  const floorNag = shyMs + 200;
  const floorAngry = Math.max(nagMs, floorNag) + 200;
  const floorEsc = Math.max(angryMs, floorAngry) + 500;
  return {
    shyMs,
    nagMs: Math.max(nagMs, floorNag),
    angryMs: Math.max(angryMs, floorAngry),
    escapeMs: Math.max(escapeMs, floorEsc)
  };
}

export { MODES, normalizeTouchMode, pokeThresholds, patThresholds };
