'use strict';

/* ============================================================
 *  主动时机 · 信息增益（G7）
 * ==========================================================
 *
 *  硬闸门（quietHours / unanswered / lock）之外：没话找话就别开口。
 *  纯启发式，不调模型。返回 { speak, reason, preferSilent }。
 * ========================================================== */

function lastAssistant(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string') {
      return m.content.replace(/\s+/g, ' ').trim().slice(0, 80);
    }
  }
  return '';
}

function lastUser(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      return m.content.replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

/**
 * G22：由头四类（head）—— 闸门过了还要有由头；没由头可 preferSilent。
 *   cue   = 边缘/前台/心境线索
 *   reply = 用户刚说过话，她可以接
 *   idle  = 空场闲置够久，允许轻寒暄
 *   none  = 没由头（应沉默）
 *
 * @param {{
 *   history?: array,
 *   edgeHint?: string,
 *   moodLine?: string,
 *   fgHint?: string,
 *   idleMinutes?: number,
 *   minIdleForEmpty?: number
 * }} ctx
 * @returns {{ speak: boolean, reason: string, preferSilent: boolean, head: string }}
 */
function shouldProactiveSpeak(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const edge = String(c.edgeHint || '').trim();
  const mood = String(c.moodLine || '').trim();
  const fg = String(c.fgHint || '').trim();
  const idle = Number(c.idleMinutes);
  const minEmpty = Number.isFinite(c.minIdleForEmpty) ? c.minIdleForEmpty : 20;

  /* ① cue：有边缘 / 心境 / 前台 hint → 开口有点料 */
  if (edge || mood || fg) {
    return {
      speak: true,
      reason: edge ? 'cue-edge' : (mood ? 'cue-mood' : 'cue-fg'),
      preferSilent: !!edge && !mood,
      head: 'cue'
    };
  }

  const hist = Array.isArray(c.history) ? c.history : [];
  const last = hist[hist.length - 1];
  /* ② reply：最后一轮是用户 → 她可以接（不是「历史上有过用户」） */
  if (last?.role === 'user') {
    return { speak: true, reason: 'reply-user', preferSilent: false, head: 'reply' };
  }

  const asst = lastAssistant(c.history);
  const user = lastUser(c.history);

  /* 刚聊过且她最后一句还在，历史上从未有用户 → 没增益 */
  if (asst && !user) {
    return { speak: false, reason: 'stale-assistant', preferSilent: true, head: 'none' };
  }

  /* ③ idle：历史空 + 闲置够久才允许轻寒暄 */
  if (!asst && !user) {
    if (Number.isFinite(idle) && idle < minEmpty) {
      return { speak: false, reason: 'empty-too-soon', preferSilent: true, head: 'none' };
    }
    return { speak: true, reason: 'idle-hello', preferSilent: false, head: 'idle' };
  }

  /* ④ 兜底（外层 quietHours 等仍管着） */
  return { speak: true, reason: 'default', preferSilent: false, head: 'idle' };
}

module.exports = { shouldProactiveSpeak, lastAssistant, lastUser };
