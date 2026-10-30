'use strict';

/* ============================================================
 *  记忆重要度 / 清晰度（G19 Phase 2a）
 * ==========================================================
 *  纯函数；同输入同输出。不调模型。细则见 docs/memory-phase2-plan.md。
 * ========================================================== */

const KIND_BASE = Object.freeze({
  name: 45, boundary: 40, relation: 18, pref: 15, other: 5
});

const STRONG_EMO = /哭|怒|恨|爱死|崩溃|绝望|开心死|气死|害怕/;
const NORM_EMO = /喜欢|讨厌|开心|难过|生气|害怕|想你|思念|开心|伤心/;
const FIRST_CUE = /第一次|最早|以前从来没|初次|刚认识/;
const PROMISE_CUE = /答应|以后|每天|一直|永远|不许|必须/;
const APOLOGY_CUE = /对不起|抱歉|其实我|之前是我/;

const CLARITY_ORDER = Object.freeze(['vivid', 'clear', 'fuzzy', 'trace']);
const CLARITY = Object.freeze({
  vivid: 70, clear: 50, fuzzy: 30, trace: 10
});
const RETENTION = Object.freeze({
  FUZZY_AFTER_DAYS: 14,
  RATE_NORMAL: 0.35,
  RATE_PINNED: 0.12,
  CATCHUP_MAX_DAYS: 30
});

/* W25：初次相遇轴（独立于 important/pinned）。
 * 窗口 = firstAt 起 30 天；概率按日龄分段；稳定散列定命中，同一份档永远同一批。 */
const INITIAL = Object.freeze({
  WINDOW_DAYS: 30,
  MAX_MARK: 3
});

/** @param {number} dayOffset 相对 firstAt 的天数 */
function initialProbability(dayOffset) {
  const d = Math.max(0, Number(dayOffset) || 0);
  if (d < 10) return 0.90;
  if (d < 20) return 0.55;
  if (d < 30) return 0.30;
  return 0.03;
}

function isFirstEncounter(fact) {
  return !!(fact && fact.firstEncounter === true);
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function scoreImportance(text, kind, source) {
  const t = String(text || '');
  let s = 10 + (KIND_BASE[kind] || KIND_BASE.other);
  const strong = (t.match(new RegExp(STRONG_EMO.source, 'g')) || []).length;
  const norm = (t.match(new RegExp(NORM_EMO.source, 'g')) || []).length;
  s += Math.min(24, strong * 8 + norm * 3);
  if (/[!！]{2,}|\.{3,}|…{2,}/.test(t)) s += 2;
  const effective = t.replace(/\s+/g, '').length;
  if (effective < 6) s -= 10;
  if (FIRST_CUE.test(t)) s += 25;
  if (PROMISE_CUE.test(t)) s += 15;
  if (APOLOGY_CUE.test(t)) s += 12;
  if (source === 'llm') s -= 5;
  return clamp(Math.round(s), 1, 100);
}

function isPinned(fact) {
  if (!fact) return false;
  if (fact.pinned === true) return true;
  if (fact.kind === 'name' || fact.kind === 'boundary') return true;
  return Number(fact.importance) >= 65;
}

function ageDays(fact, now = Date.now()) {
  const ts = Number(fact?.lastSeen || fact?.updated || fact?.at || now);
  return Math.max(0, (now - ts) / 86400000);
}

function retentionOf(fact, now = Date.now()) {
  const imp = Number(fact?.importance) || 50;
  const recalls = Math.min(12, Number(fact?.recallCount) || 0);
  const age = ageDays(fact, now);
  let fresh = 0;
  if (age <= 2) fresh = 8;
  else if (age <= 7) fresh = 4;
  const seenRecently = fact?.lastSeen && (now - fact.lastSeen) <= 2 * 86400000 ? 8 : 0;
  const rate = isPinned(fact) ? RETENTION.RATE_PINNED : RETENTION.RATE_NORMAL;
  const penalty = age > RETENTION.FUZZY_AFTER_DAYS
    ? (age - RETENTION.FUZZY_AFTER_DAYS) * rate
    : 0;
  return imp + Math.min(12, recalls * 2) + fresh + seenRecently - penalty;
}

function clarityFromRetention(ret, pinned) {
  let c = 'trace';
  if (ret >= CLARITY.vivid) c = 'vivid';
  else if (ret >= CLARITY.clear) c = 'clear';
  else if (ret >= CLARITY.fuzzy) c = 'fuzzy';
  else if (ret >= CLARITY.trace) c = 'trace';
  if (pinned && (c === 'fuzzy' || c === 'trace')) c = 'clear';
  return c;
}

function clarityIndex(c) {
  const i = CLARITY_ORDER.indexOf(c);
  return i < 0 ? 2 : i;
}

function localDayIndex(now = Date.now()) {
  const off = new Date(now).getTimezoneOffset() * 60000;
  return Math.floor((now - off) / 86400000);
}

function displayPrefix(clarity) {
  if (clarity === 'fuzzy') return '记得不太清：';
  if (clarity === 'trace') return '好像有过这么回事：';
  return '';
}

module.exports = {
  KIND_BASE, CLARITY, CLARITY_ORDER, RETENTION, INITIAL,
  scoreImportance, isPinned, ageDays, retentionOf,
  clarityFromRetention, clarityIndex, localDayIndex, displayPrefix, clamp,
  initialProbability, isFirstEncounter
};
