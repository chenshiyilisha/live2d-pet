'use strict';

/* ============================================================
 *  W48：proactive 决策 AI（2026-11-11）
 * ==========================================================
 *
 *  背景：proactive 现在是三道规则闸（quietHours / maxUnanswered /
 *  media）+ info-gain 启发式。规则闸是"硬拦"，但拦不住"规则通过了
 *  其实不该说"的情况——比如用户刚在忙、话题不合适、时机不对。
 *
 *  借鉴：group_chat_plus 的"决策 AI / 回复 AI 分离"（AGPL-3.0 →
 *  只借设计思想，自己实现，不复制代码）。判断"要不要插嘴"走一条
 *  **独立的轻量 LLM 调用**，不拼完整人格 + 全部记忆 + 全部历史——
 *  把最贵的资源花在会被丢弃的判断上是浪费。
 *
 *  设计约束：
 *   · **轻量调用**：短提示词（最近对话 + 闲置时长 + 时间 + 边缘线索），
 *     不注入完整人设 / 记忆 / 历史。短超时（stall 4s / total 8s）——
 *     判断比生成快，不该用生成的超时。
 *   · **fail-open**：决策 AI 调用失败 / 超时 / 解析失败 → 放行
 *     （按规则闸的结果继续走正常生成）。决策 AI 是增强不是闸门，
 *     它挂了不该把 proactive 整个弄哑。
 *   · **开关**（规矩 4）：`proactive.decisionAi` 默认**关**——多一次
 *     LLM 调用，主动搭话本身默认关，这个增强也该默认关。
 *   · **可选独立模型**：`proactive.decisionModel` 指定便宜模型
 *     （如 Haiku / Flash），空 = 用主模型。
 *   · **输出格式**：`{"decision":"send"}` / `{"decision":"silent"}`
 *     （借 group_chat_plus 的格式思想，自己解析、自己容错）。
 *
 *  挂法：main.js 的 chat:proactive 里，info-gain + rhythm 闸之后、
 *  bookFirst 之前调 decideSpeak()。返回 silent → 直接返回不生成。 */

const { isUsable } = require('./llm-providers');
const { streamLLM } = require('./llm');

/* 决策调用的超时 —— 刻意比主对话短（判断比生成快）。
 * 这两个数只在这里定义；不是用户配置项（参数不是开关）。 */
const DECISION_TIMEOUT = { stallMs: 4000, totalMs: 8000 };

/* 决策提示词里带多少条最近对话（轻量 = 短上下文）。 */
const DECISION_HISTORY_MAX = 4;
/* 每条对话截断长度。 */
const DECISION_MSG_CHARS = 100;

/* 测试钩子：verify 脚本注入假响应。 */
let testDecisionResponder = null;

function setDecisionResponderForTest(fn) { testDecisionResponder = typeof fn === 'function' ? fn : null; }
function resetDecisionForTest() { testDecisionResponder = null; }

/**
 * 构建决策 AI 的轻量提示词。
 * 刻意不带：完整人设 / 全部记忆 / 全部历史 —— 决策只看"现在该不该说"。
 * @param {object} ctx { history, idleMinutes, edgeHint, moodLine, fgHint, topics, now }
 * @returns {{ messages: array, meta: object }}
 */
function buildDecisionPrompt(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const now = Number(c.now) || Date.now();
  const d = new Date(now);
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const idleMin = Number.isFinite(Number(c.idleMinutes)) ? Math.round(Number(c.idleMinutes)) : 0;

  const hist = Array.isArray(c.history) ? c.history.slice(-DECISION_HISTORY_MAX) : [];
  const lines = hist.map((m) => {
    if (!m || typeof m.content !== 'string') return null;
    const role = m.role === 'user' ? '主人' : (m.role === 'assistant' ? '她' : m.role);
    const text = m.content.replace(/\s+/g, ' ').trim().slice(0, DECISION_MSG_CHARS);
    return role + '：' + text;
  }).filter(Boolean);

  const edge = String(c.edgeHint || '').trim();
  const mood = String(c.moodLine || '').trim();
  const fg = String(c.fgHint || '').trim();
  const topics = Array.isArray(c.topics) ? c.topics.map((t) => String(t).slice(0, 30)) : [];

  const parts = [];
  parts.push('【时间】' + hhmm);
  parts.push('【闲置】' + idleMin + ' 分钟');
  if (lines.length) parts.push('【最近对话】\n' + lines.join('\n'));
  if (edge) parts.push('【边缘线索】' + edge.slice(0, 80));
  if (mood) parts.push('【心境】' + mood.slice(0, 80));
  if (fg) parts.push('【前台】' + fg.slice(0, 80));
  if (topics.length) parts.push('【候选话题】' + topics.join('、'));

  const userContent = parts.join('\n\n') + '\n\n现在她该不该主动开口？';

  return {
    messages: [
      {
        role: 'system',
        content: '你是"要不要现在开口"的决策器。主人闲置了一段时间，你判断她现在主动搭话是否合适。\n' +
          '只看给出的上下文，不要脑补。只回答 JSON：{"decision":"send"} 或 {"decision":"silent"}。'
      },
      { role: 'user', content: userContent }
    ],
    meta: {
      idleMin, hhmm,
      historyCount: lines.length,
      hasEdge: !!edge, hasMood: !!mood, hasTopics: topics.length > 0
    }
  };
}

/**
 * 解析决策 AI 的输出。
 * 优先 JSON 格式；失败则找 send/silent 关键词；都找不到 → send（fail-open）。
 * @param {string} text
 * @returns {{ speak: boolean, reason: string }}
 */
function parseDecision(text) {
  const t = String(text || '').trim();
  if (!t) return { speak: true, reason: 'decision-ai:empty' };

  /* 优先 JSON */
  try {
    const obj = JSON.parse(t);
    if (obj && typeof obj === 'object') {
      const d = String(obj.decision || '').toLowerCase();
      if (d === 'silent' || d === 'no') return { speak: false, reason: 'decision-ai:silent' };
      if (d === 'send' || d === 'yes') return { speak: true, reason: 'decision-ai:send' };
    }
  } catch { /* 不是 JSON，走关键词 */ }

  /* 关键词兜底 */
  const low = t.toLowerCase();
  if (/"?silent"?/.test(low) || /\bno\b/.test(low) || /不该|不要|别/.test(t)) {
    return { speak: false, reason: 'decision-ai:silent' };
  }
  if (/"?send"?/.test(low) || /\byes\b/.test(low) || /该|可以|合适/.test(t)) {
    return { speak: true, reason: 'decision-ai:send' };
  }

  /* 都找不到 → fail-open */
  return { speak: true, reason: 'decision-ai:unparsed' };
}

/**
 * 决策 AI 主入口。
 * @param {object} deps { cfg, history, idleMinutes, edgeHint, moodLine, fgHint, topics, now, llm }
 *   llm = { baseUrl, apiKey, model } —— 调用方传入（main.js 从 cfg.llm 取）。
 * @returns {Promise<{ speak: boolean, reason: string }>}
 */
async function decideSpeak(deps) {
  /* 测试钩子 */
  if (testDecisionResponder) {
    try { return testDecisionResponder(deps); } catch { /* ignore */ }
  }

  const d = deps || {};
  const llm = d.llm || {};

  /* LLM 不可用 → fail-open（不调决策 AI，按规则闸继续） */
  if (!isUsable({ baseUrl: llm.baseUrl, apiKey: llm.apiKey })) {
    return { speak: true, reason: 'decision-ai:unavailable' };
  }

  const { messages } = buildDecisionPrompt(d);
  let text = '';
  try {
    const res = await streamLLM(messages, {
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      stallMs: DECISION_TIMEOUT.stallMs,
      totalMs: DECISION_TIMEOUT.totalMs,
      send: (t) => { text += t; },
      sendEmotion: () => {},
      sendThink: () => {}
    });
    if (!res || !res.ok) {
      return { speak: true, reason: 'decision-ai:error' };
    }
    return parseDecision(text);
  } catch {
    return { speak: true, reason: 'decision-ai:exception' };
  }
}

module.exports = {
  decideSpeak,
  buildDecisionPrompt,
  parseDecision,
  DECISION_TIMEOUT,
  DECISION_HISTORY_MAX,
  DECISION_MSG_CHARS,
  setDecisionResponderForTest,
  resetDecisionForTest
};
