'use strict';

/* ============================================================
 *  统一 PetEvent 薄总线（W12）
 * ==========================================================
 *  不取代现有 IPC 通道；给 main 内侧多方源（chat / agent-link / 本地）
 *  一个具名订阅点。payload 原样转发，失败静默。
 * ========================================================== */

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

function on(type, fn) {
  if (typeof fn !== 'function') return () => {};
  const key = String(type || '*');
  let set = listeners.get(key);
  if (!set) { set = new Set(); listeners.set(key, set); }
  set.add(fn);
  return () => { set.delete(fn); };
}

function off(type, fn) {
  const set = listeners.get(String(type || '*'));
  if (set) set.delete(fn);
}

/**
 * @param {string} type
 * @param {object} [payload]
 * @returns {{ type: string, ts: number, payload: object }}
 */
function emit(type, payload = {}) {
  const ev = {
    type: String(type || ''),
    ts: Date.now(),
    payload: payload && typeof payload === 'object' ? payload : {}
  };
  if (!ev.type) return ev;
  const run = (fn) => {
    try { fn(ev); } catch (err) {
      console.warn('[pet-events]', ev.type, err?.message || err);
    }
  };
  const exact = listeners.get(ev.type);
  if (exact) for (const fn of exact) run(fn);
  const all = listeners.get('*');
  if (all) for (const fn of all) run(fn);
  return ev;
}

function listenerCount(type) {
  const set = listeners.get(String(type || ''));
  return set ? set.size : 0;
}

function _reset() {
  listeners.clear();
}

module.exports = {
  on,
  off,
  emit,
  listenerCount,
  _reset
};
