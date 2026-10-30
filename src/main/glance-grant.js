'use strict';

/* ============================================================
 *  限时看屏授权（W1）
 * ==========================================================
 *  会话内存态：grantUntil 时间戳。到期自动收回，不写配置（隐私：别把
 *  「曾经开过看屏」永久烙在磁盘上）。
 *  永久开关仍是 interaction.glance；限时授权是叠加通道。
 * ========================================================== */

const GRANT_PRESETS_MS = Object.freeze([
  { id: '3m', label: '3 分钟', ms: 3 * 60 * 1000 },
  { id: '10m', label: '10 分钟', ms: 10 * 60 * 1000 }
]);

/** @type {number} epoch ms；0 = 无授权 */
let grantUntil = 0;
/** @type {ReturnType<typeof setTimeout>|null} */
let revokeTimer = null;
/** @type {(info:{reason:string, remainingMs:number}) => void} */
let onChange = () => {};

function configureGlanceGrant(hooks = {}) {
  if (typeof hooks.onChange === 'function') onChange = hooks.onChange;
}

function clearRevokeTimer() {
  if (revokeTimer) { clearTimeout(revokeTimer); revokeTimer = null; }
}

function notify(reason) {
  try {
    onChange({ reason: String(reason || ''), remainingMs: remainingMs() });
  } catch { /* ignore */ }
}

function remainingMs(now = Date.now()) {
  const left = grantUntil - Number(now);
  return left > 0 ? left : 0;
}

function isGranted(now = Date.now()) {
  return remainingMs(now) > 0;
}

/**
 * 看屏是否放行：永久开关 OR 未过期限时授权。
 * @param {boolean} permanentOn interaction.glance
 */
function isGlanceAllowed(permanentOn, now = Date.now()) {
  return !!permanentOn || isGranted(now);
}

/** @param {number} ms 授权时长；≤0 等同收回 */
function grantFor(ms, now = Date.now()) {
  clearRevokeTimer();
  const dur = Math.max(0, Math.floor(Number(ms) || 0));
  if (dur <= 0) {
    grantUntil = 0;
    notify('revoke');
    return { until: 0, remainingMs: 0 };
  }
  grantUntil = Number(now) + dur;
  revokeTimer = setTimeout(() => {
    revokeTimer = null;
    grantUntil = 0;
    notify('expired');
  }, dur);
  /* 不让 timer 拖住进程退出 */
  if (typeof revokeTimer.unref === 'function') revokeTimer.unref();
  notify('grant');
  return { until: grantUntil, remainingMs: dur };
}

function revoke(reason = 'revoke') {
  clearRevokeTimer();
  const had = grantUntil > 0;
  grantUntil = 0;
  if (had) notify(reason);
  return had;
}

function grantSnapshot(now = Date.now()) {
  const left = remainingMs(now);
  return {
    until: left > 0 ? grantUntil : 0,
    remainingMs: left,
    active: left > 0
  };
}

/** 测试用 */
function _resetGrant() {
  clearRevokeTimer();
  grantUntil = 0;
}

module.exports = {
  GRANT_PRESETS_MS,
  configureGlanceGrant,
  isGranted,
  isGlanceAllowed,
  remainingMs,
  grantFor,
  revoke,
  grantSnapshot,
  _resetGrant
};
