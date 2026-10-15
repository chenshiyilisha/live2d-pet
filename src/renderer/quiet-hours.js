/* ============================================================
 *  免打扰时段 —— 纯函数、无状态、无依赖
 * ==========================================================
 *
 *  出处：竞品调研第 7 轮里 astrbot 主动聊天插件的 `quiet_hours`
 *  配置（见 docs/open-source-reference.md 的可借鉴 ③）。它的默认值是
 *  `"1-7"`，语义是"这个时间段内一条主动消息都不发"。
 *
 *  我们的问题是：主动搭话完全不看时间 —— 凌晨三点她照样来一句
 *  "你盯屏幕好久了，起来动动"。那不是陪伴，是闹鬼。
 *
 *  ── 配置格式 ──
 *    · `"23-8"`  晚上 11 点到早上 8 点（**跨零点**，区间绕回来）
 *    · `"13-14"` 同一天内的区间（不跨零点）
 *    · `""` / 写错 / 缺键 → **不设免打扰**（返回 null）
 *  只认整点，24 小时制，hours ∈ [0, 23]。
 *
 *  🔴 **解析失败一律当"不设"**，绝不当成"全天静默"：
 *     配置手写错一个字符就让她闭嘴一整天的代价，比"少拦一晚上"大得多。
 *     同理 `a === b`（`"0-0"`、`"8-8"`）直接判为不设 —— 那个写法在人的直觉里
 *     是"零长度区间"，而按区间语义算出来却是**整整 24 小时**。
 *
 *  ⚠️ 三个函数都吃 `Date` 参数（默认 now）—— 于是能像 params.js / jitter.js
 *     那样在 verify 里直接喂假时钟跑，不用等半夜。
 * ========================================================== */

/**
 * 解析配置字符串。
 * @param {string} spec 形如 `"23-8"`；其它一律不认
 * @returns {{start:number,end:number}|null} 分钟数区间；null = 不设免打扰
 */
export function parseQuietHours(spec) {
  if (typeof spec !== 'string') return null;
  const m = spec.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  if (a < 0 || a > 23 || b < 0 || b > 23) return null;
  if (a === b) return null;          // 零长度区间 → 不设（别退化成全天禁言）
  return { start: a * 60, end: b * 60 };
}

/** 当刻分钟数（0..1439）。 */
function minutesOf(date) {
  const d = date instanceof Date ? date : new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 此刻在不在免打扰时段里。
 * @param {{start:number,end:number}|null} range parseQuietHours 的结果
 * @param {Date} [date] 缺省用当前时间
 * @returns {boolean} range 为 null 时恒 false
 */
export function inQuietHours(range, date) {
  if (!range) return false;
  const mins = minutesOf(date);
  /* 半开区间 [start, end)：start 那一刻已经禁言，end 那一刻已经可以说话。 */
  return range.start < range.end
    ? (mins >= range.start && mins < range.end)      // 同一天内，例如 13-14
    : (mins >= range.start || mins < range.end);     // 跨零点，例如 23-8
}

/**
 * 距离这段免打扰结束还有多少毫秒。**不在时段内返回 0**。
 *
 * 用途：撞上免打扰时不 2 秒探一次（那是一整晚的空转），而是排到时段结束那一刻
 * 再看一眼 —— 见 pet.js 的 scheduleAfterQuietHours。
 *
 * @returns {number} 毫秒；0 = 当前不在时段内
 */
export function msUntilQuietEnd(range, date) {
  if (!inQuietHours(range, date)) return 0;
  const mins = minutesOf(date);
  const left = range.start < range.end
    ? range.end - mins                                // 同一天内：还差这么多分钟
    : (mins >= range.start
        ? (24 * 60 - mins) + range.end                // 跨零点且已过零点前段：先跨过去
        : range.end - mins);                          // 跨零点但还在零点后段
  return Math.max(0, left) * 60 * 1000;
}
