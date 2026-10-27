'use strict';

/* ============================================================
 *  气泡优先级仲裁（纯函数 + 轻量状态机）
 * ==========================================================
 *
 *  蓝本：Tisitan/dsh-live2d-companion —— 低级不抢高级，完成/报错必达。
 *
 *  等级（数字越大越优先）：
 *    0 status  —— 工作状态短句（思考中 / 搞定了）
 *    1 stream  —— 对话流 / think 行
 *    2 alert   —— 提醒、番茄钟、报错、互动庆祝
 *
 *  规则：
 *    · 同级或更高级可以占位 / 覆盖
 *    · 更低级在占用中被拒绝（返回 false）
 *    · release 必须带同 token，防止旧流结束后误清新流
 * ========================================================== */

const RANK = Object.freeze({
  status: 0,
  stream: 1,
  alert: 2
});

function rankOf(kind) {
  const n = RANK[kind];
  return Number.isFinite(n) ? n : 0;
}

function createArbiter() {
  let holder = null;   // { kind, rank, token }
  let seq = 0;

  function peek() {
    return holder ? { kind: holder.kind, rank: holder.rank, token: holder.token } : null;
  }

  /** 尝试占用。成功返回 { ok:true, token }；被拒 { ok:false }。 */
  function acquire(kind) {
    const rank = rankOf(kind);
    if (holder && rank < holder.rank) {
      return { ok: false, reason: 'preempted', held: holder.kind };
    }
    seq += 1;
    holder = { kind, rank, token: seq };
    return { ok: true, token: seq };
  }

  /** 释放；token 对不上则忽略（旧流迟到结束）。 */
  function release(token) {
    if (!holder) return false;
    if (token != null && holder.token !== token) return false;
    holder = null;
    return true;
  }

  /** 强制清空（静默 / 销毁）。 */
  function reset() {
    holder = null;
  }

  /** 当前占用下，append 类增量是否允许（仅同 token 的 stream）。 */
  function allowsAppend(token) {
    return !!(holder && holder.kind === 'stream' && holder.token === token);
  }

  return { acquire, release, reset, peek, allowsAppend, RANK };
}

module.exports = { RANK, rankOf, createArbiter };
