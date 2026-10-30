'use strict';

/* ============================================================
 *  加权抽取纯函数（W43）
 * ==========================================================
 *  蓝本 dsh-pet shared/pickers.ts：排除当前避免连抽；排除后池空 → 退回原池。
 *  不碰 DOM / 配置 / 文件；verify 直接 require。
 * ========================================================== */

/**
 * 从池中抽一项。exclude 命中且池里还有别的 → 跳过它；排除后空 → 退回原池。
 * @param {any[]} pool
 * @param {{ exclude?: any, rand?: () => number, eq?: (a,b)=>boolean }} opts
 */
function pick(pool, opts = {}) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const eq = typeof opts.eq === 'function' ? opts.eq : ((a, b) => a === b);
  let cand = pool;
  if (opts.exclude !== undefined && opts.exclude !== null && pool.length > 1) {
    const filtered = pool.filter((x) => !eq(x, opts.exclude));
    if (filtered.length) cand = filtered;
    /* 排除后空 → 退回原池（W43 硬规则） */
  }
  const i = Math.min(cand.length - 1, Math.max(0, Math.floor(rand() * cand.length)));
  return cand[i];
}

/**
 * 按权重抽一项。{ id, weight }；weight≤0 跳过；全 0 → null。
 * @param {Array<{id:any, weight?:number}>} items
 */
function pickWeighted(items, rand = Math.random) {
  if (!Array.isArray(items) || !items.length) return null;
  const cand = items.filter((x) => x && Number(x.weight) > 0);
  if (!cand.length) return null;
  let total = 0;
  for (const x of cand) total += Number(x.weight);
  let r = rand() * total;
  for (const x of cand) {
    r -= Number(x.weight);
    if (r <= 0) return x;
  }
  return cand[cand.length - 1];
}

/**
 * 按 kind 权重抽分类，再从该类 actions 里 pick（可 exclude）。
 * weights 里 turn/move 为 0 时不归一化 —— 份额自然落到其他类。
 * @param {Array<{id:string, weight?:number, actions:any[]}>} categories
 * @param {Record<string, number>|null} weightOverride
 */
function pickWeightedCategory(categories, opts = {}) {
  if (!Array.isArray(categories) || !categories.length) return null;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;
  const ov = opts.weights && typeof opts.weights === 'object' ? opts.weights : null;
  const items = categories.map((c) => ({
    id: c.id,
    weight: ov && Object.prototype.hasOwnProperty.call(ov, c.id)
      ? Number(ov[c.id])
      : Number(c.weight),
    actions: c.actions
  }));
  const cat = pickWeighted(items, rand);
  if (!cat || !Array.isArray(cat.actions) || !cat.actions.length) return null;
  const action = pick(cat.actions, { exclude: opts.exclude, rand });
  return { category: cat.id, action };
}

/**
 * 只抽 kind（idle/turn/move…）。weight 为 0 的 kind 不参与；不把剩余归一化。
 * @param {Record<string, number>} weights
 */
function rollKind(weights, rand = Math.random) {
  if (!weights || typeof weights !== 'object') return null;
  const items = Object.keys(weights).map((id) => ({ id, weight: Number(weights[id]) }));
  const hit = pickWeighted(items, rand);
  return hit ? hit.id : null;
}

module.exports = {
  pick,
  pickWeighted,
  pickWeightedCategory,
  rollKind
};
