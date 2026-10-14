/* seeded 伪随机 —— 给「活人感」加的**第二层**抖动。
 *
 * 第一层是 params.js 的 EMO_SPEED（错峰插值：眉毛最快、身体最慢，让表情
 * "从脸上长出来"而不是整张脸同时到位）。但那张表是**固定**的 ——
 * 同一句情绪进两次，过渡曲线一模一样，看久了会露出"程序在摆"的马脚。
 *
 * 这一层给**每次情绪切换**抽一套速度因子（±JITTER_RATIO），于是同一情绪
 * 两次进入的节奏略有不同：错峰的比例变了，整张脸'长出来'的顺序感也就不
 * 重样。改动极小，但这是"活"和"准"之间最便宜的那一步。
 *
 * ⚠️ 抖的是**速度（时间维度）不是幅度**：
 *    幅度是 16 字段 × 8 情绪逐项标定过的（params.js 的 EMOTION，硬规矩 28），
 *    乘随机因子会让调好的表情变淡或过冲；速度只决定"这张脸用多久到位"，
 *    抖它不会让表情走形。
 * ⚠️ 用**固定种子**而不是 Math.random：同样的交互序列 → 同样的抖动序列，
 *    截图/日志才复现得了（真随机就再也对不上号了）。
 *    另：`Math.random` 现在全项目仍然只有 pet.js 挑主动语那一处。
 * ⚠️ 因子必须**一次抽一整套、过渡期间固定**（不可每帧抽）：
 *    每帧重抽就是帧间噪声，不是节奏差异。
 */

/* mulberry32 —— 32 位种子的小 PRNG，够用且无需依赖。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 种子与幅度。7 4119 只是随手挑的数（参考 soullink 用固定种子的做法），
 * 改它就换一套抖动序列，不改变统计性质。 */
export const JITTER_SEED = 74119;
/* ±15%：低于 10% 看不出来（叠加在错峰上完全被淹没），高于 25% 会让
 * 慢字段（身体 2.2 / 脸红 2.8）明显"慢半拍"，破坏错峰本身的比例感。 */
export const JITTER_RATIO = 0.15;

const rand = mulberry32(JITTER_SEED);

/* 为一批键抽一套乘性因子（1±ratio）。返回 { 键: 因子 }。 */
export function rollFactors(keys, ratio = JITTER_RATIO) {
  const out = {};
  for (const k of keys) out[k] = 1 + (rand() * 2 - 1) * ratio;
  return out;
}

/* 给测试/诊断用：确认 PRNG 是确定性的（同种子同序列）。 */
export function makeRng(seed) { return mulberry32(seed); }
