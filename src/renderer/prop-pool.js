'use strict';
/* 道具池的两个纯函数：抽哪一个、挂多久。
 *
 * 单独成文件是为了能被 node 直接 require 断言 —— 权重抽样的边界
 * （rand()=0 / rand()=1 / 权重全 0 / 只有一项）出错时表现是"某个道具
 * 永远不出现"或"偶尔抽到空"，靠肉眼看几十次是发现不了的（规矩 28）。
 *
 * ⚠️ 这两个函数**不碰任何状态**：不读配置、不看当前情绪、不记"上次是谁"。
 *    什么时候抽、要不要抽、抽完排不排下次，全在 pet.js 的调度器里。
 */

/** 从道具池按权重抽一个。pool 为空 / 全部 w<=0 → null（调用方跳过这一轮）。
 * @param {Array<{file:string,w:number,ms?:number[]}>} pool
 * @param {() => number} rand  0..1（含 0，不含 1）
 * @param {string|null} exclude 不要抽到这一项（避免连着两次同一件）
 */
export function pickProp(pool, rand = Math.random, exclude = null) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const cand = pool.filter((p) => p && p.file && Number(p.w) > 0 && p.file !== exclude);
  if (!cand.length) return null;
  let total = 0;
  for (const p of cand) total += Number(p.w);
  /* ⚠️ rand() 理论上 <1，但自定义 rand（测试里常给 1）会走满一圈 —— 
   *    兜底返回最后一个，不能返回 undefined。 */
  let r = rand() * total;
  for (const p of cand) {
    r -= Number(p.w);
    if (r <= 0) return p;
  }
  return cand[cand.length - 1];
}

/** 这一件该挂多久（毫秒）。ms 缺失 / 写反（[高,低]）→ 用 fallback。
 * @param {{ms?:number[]}|null} spec
 * @param {() => number} rand
 * @param {number[]} fallback [最短, 最长]
 */
export function propDuration(spec, rand = Math.random, fallback = [20000, 45000]) {
  const raw = Array.isArray(spec?.ms) && spec.ms.length === 2 ? spec.ms : fallback;
  const a = Number(raw[0]);
  const b = Number(raw[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback[0];
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.round(lo + (hi - lo) * rand());
}

/** 两次道具之间隔多久（毫秒）。纯函数：只把区间按随机数摊开。
 * @param {number[]} range [最短, 最长]
 */
export function propGap(range = [90000, 240000], rand = Math.random) {
  const lo = Math.max(0, Number(range[0]) || 0);
  const hi = Math.max(lo, Number(range[1]) || lo);
  return Math.round(lo + (hi - lo) * rand());
}
