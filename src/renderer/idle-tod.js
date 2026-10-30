/* W9：按时段挑闲置表情池（纯函数，无 DOM）。
 *
 * 桶：morning 5–11 / afternoon 11–17 / evening 17–22 / night 其余。
 * 池子是事件表情名（whale emotes）；hiyori 没有对应素材时调用方应跳过。
 */

export const BUCKETS = ['morning', 'afternoon', 'evening', 'night'];

/** @param {number} hour 0–23 */
export function hourBucket(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return 'afternoon';
  const x = ((Math.floor(h) % 24) + 24) % 24;
  if (x >= 5 && x < 11) return 'morning';
  if (x >= 11 && x < 17) return 'afternoon';
  if (x >= 17 && x < 22) return 'evening';
  return 'night';
}

/** 各时段闲置表情候选（与 whale emotes 键对齐；缺的调用方过滤）。 */
export const IDLE_EMOTE_POOL = {
  morning: ['呆眼', '花花', '星星眼'],
  afternoon: ['呆眼', '吐舌', '问号'],
  evening: ['呆眼', '晕晕', '脸红'],
  night: ['吐魂', '呆眼', '哭']
};

/**
 * @param {number} hour
 * @param {{ stage?: number, have?: Set<string>|string[] }} opts
 *   stage 0 → 第一档走神；1 → 第二档更「累」
 * @returns {string|null}
 */
export function pickIdleEmote(hour, opts = {}) {
  const bucket = hourBucket(hour);
  const pool = IDLE_EMOTE_POOL[bucket] || IDLE_EMOTE_POOL.afternoon;
  const stage = Number(opts.stage) || 0;
  const have = opts.have
    ? (opts.have instanceof Set ? opts.have : new Set(opts.have))
    : null;
  const filtered = have ? pool.filter((n) => have.has(n)) : pool.slice();
  if (!filtered.length) return null;
  /* 第二档偏向池尾（更「累 / 夜」那一侧）。 */
  if (stage >= 1 && filtered.length > 1) {
    return filtered[filtered.length - 1];
  }
  return filtered[0];
}
