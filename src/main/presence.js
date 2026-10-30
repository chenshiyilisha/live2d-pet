'use strict';

/* ============================================================
 *  专注 / 勿扰三档（X2）—— 盖过单一 quietHours
 * ==========================================================
 *
 *  companion  陪伴：忽略 quietHours，主动更勤一点
 *  normal     日常：走 quietHours（默认）
 *  focus      勿扰：全天不主动搭话（盖过 quietHours）
 *
 *  纯数据 + 纯函数；verify-presence.js 直接 node 跑。
 * ========================================================== */

const MODES = [
  { id: 'companion', label: '陪伴' },
  { id: 'normal', label: '日常' },
  { id: 'focus', label: '勿扰' }
];

function normalizeMode(raw) {
  const id = String(raw || '').trim();
  return MODES.some((m) => m.id === id) ? id : 'normal';
}

/**
 * 主动搭话是否被「状态档」拦下。
 * @returns {''|'focus'} 空串 = 本档不拦（仍可能被 quietHours 等拦）
 */
function presenceBlocksProactive(mode) {
  return normalizeMode(mode) === 'focus' ? 'focus' : '';
}

/** 陪伴档是否忽略 quietHours。 */
function ignoreQuietHours(mode) {
  return normalizeMode(mode) === 'companion';
}

/** 陪伴档 idle 间隔乘子（更勤）。日常/勿扰 = 1。 */
function presenceIdleMul(mode) {
  return normalizeMode(mode) === 'companion' ? 0.7 : 1;
}

module.exports = {
  MODES,
  normalizeMode,
  presenceBlocksProactive,
  ignoreQuietHours,
  presenceIdleMul
};
