'use strict';

/* ============================================================
 *  工作态事件档位（W44）
 * ==========================================================
 *  events.workStatus[i]：**索引即档位**，新档只可追加到末尾。
 *  中间插档 = 已生效配置静默错位 —— 写进注释当红线。
 *
 *  decideEndedCue：播完分支纯函数（档内轮换 / 续播 / 事件结束 / 回归随机）。
 * ========================================================== */

/**
 * 🔴 只可追加到末尾。顺序锁死：thinking → working → result → waiting →
 *    success → error → attention（W44 接上 attention）。
 */
const WORK_STATUS = Object.freeze([
  'thinking',
  'working',
  'result',
  'waiting',
  'success',
  'error',
  'attention'
]);

function workStatusIndex(phase) {
  const i = WORK_STATUS.indexOf(String(phase || ''));
  return i < 0 ? -1 : i;
}

function workStatusAt(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= WORK_STATUS.length) return null;
  return WORK_STATUS[i];
}

/**
 * 播完当前工作态动作后下一步。
 * @param {{
 *   phase: string,
 *   candidates?: string[],
 *   current?: string|null,
 *   rotate?: boolean,
 *   sticky?: boolean
 * }} ctx
 * @returns {{ kind: string, next?: string|null, phase?: string }}
 *
 * kind:
 *   work-rotate     档内换下一个候选
 *   work-replay     同动作再播一次（sticky 工作中）
 *   event-done      收尾档播完 → 事件结束
 *   random          回到随机池
 */
function decideEndedCue(ctx = {}) {
  const phase = String(ctx.phase || '');
  const idx = workStatusIndex(phase);
  if (idx < 0) return { kind: 'random' };

  const terminal = phase === 'success' || phase === 'error' || phase === 'idle';
  if (terminal) return { kind: 'event-done', phase };

  const list = Array.isArray(ctx.candidates) ? ctx.candidates.filter(Boolean) : [];
  if (ctx.rotate && list.length > 1) {
    const cur = ctx.current;
    let i = list.indexOf(cur);
    if (i < 0) i = -1;
    const next = list[(i + 1) % list.length];
    return { kind: 'work-rotate', next, phase };
  }

  if (ctx.sticky && (phase === 'working' || phase === 'thinking' || phase === 'waiting')) {
    return { kind: 'work-replay', next: ctx.current || list[0] || null, phase };
  }

  if (phase === 'result' || phase === 'attention') {
    return { kind: 'event-done', phase };
  }

  return { kind: 'random', phase };
}

module.exports = {
  WORK_STATUS,
  workStatusIndex,
  workStatusAt,
  decideEndedCue
};
