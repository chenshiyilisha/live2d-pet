'use strict';

/* ============================================================
 *  作息学习（X6）—— 24 小时槽交互直方图
 * ==========================================================
 *
 *  每次用户交互记一笔 → 每周 ×0.85 衰减 → 主动搭话可问「现在是不是活跃窗」。
 *  纯数据；落盘由 main 负责。
 * ========================================================== */

const SLOTS = 24;
const WEEK_MS = 7 * 86400000;
const DECAY = 0.85;

function empty() {
  return {
    hours: Array.from({ length: SLOTS }, () => 0),
    lastDecayAt: Date.now(),
    total: 0
  };
}

function hydrate(raw) {
  const base = empty();
  if (!raw || typeof raw !== 'object') return base;
  const hours = Array.isArray(raw.hours) ? raw.hours.slice(0, SLOTS) : [];
  while (hours.length < SLOTS) hours.push(0);
  base.hours = hours.map((n) => {
    const x = Number(n);
    return Number.isFinite(x) && x > 0 ? x : 0;
  });
  base.lastDecayAt = Number(raw.lastDecayAt) || Date.now();
  base.total = Number(raw.total) || base.hours.reduce((a, b) => a + b, 0);
  return base;
}

function maybeDecay(state, now = Date.now()) {
  const s = state || empty();
  let last = Number(s.lastDecayAt) || now;
  if (last > now) last = now;
  let weeks = Math.floor((now - last) / WEEK_MS);
  if (weeks > 8) weeks = 8;
  if (weeks <= 0) return s;
  let total = 0;
  for (let i = 0; i < SLOTS; i++) {
    s.hours[i] *= Math.pow(DECAY, weeks);
    if (s.hours[i] < 0.05) s.hours[i] = 0;
    total += s.hours[i];
  }
  s.total = total;
  s.lastDecayAt = last + weeks * WEEK_MS;
  return s;
}

function record(state, now = Date.now()) {
  const s = maybeDecay(hydrate(state), now);
  const h = new Date(now).getHours();
  s.hours[h] = (s.hours[h] || 0) + 1;
  s.total = (s.total || 0) + 1;
  return s;
}

/** 当前小时是否偏活跃（相对日均）。样本太少一律 true（不误伤新用户）。 */
function isActiveWindow(state, now = Date.now()) {
  const s = maybeDecay(hydrate(state), now);
  if ((s.total || 0) < 20) return true;
  const h = new Date(now).getHours();
  const avg = s.total / SLOTS;
  return (s.hours[h] || 0) >= avg * 0.85;
}

function snapshot(state) {
  const s = hydrate(state);
  return { hours: s.hours.slice(), total: s.total, lastDecayAt: s.lastDecayAt };
}

module.exports = {
  SLOTS, WEEK_MS, DECAY,
  empty, hydrate, maybeDecay, record, isActiveWindow, snapshot
};
