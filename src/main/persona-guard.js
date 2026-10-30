'use strict';

/* ============================================================
 *  输出侧人设护栏（G9）
 * ==========================================================
 *
 *  纯过滤器：返回 { pass, reason }，**不改文本**。
 *  silent 直通。档位：off / med（默认）/ strict（med + 伪造角色标记）。
 *  G25：med 起拦「伪造用户说过的话」（你刚才说… / 用户说…）。
 *  蓝本味道：Nexus personaGuardrail —— 只借机制。
 * ========================================================== */

const FORBIDDEN = [
  /作为一个\s*AI/i,
  /作为一名?(?:人工智能|AI)\s*助手/i,
  /我是(?:一个)?(?:人工智能|AI)(?:语言模型|助手)?/i,
  /很高兴为你(?:解答|服务)/,
  /希望这对你有帮助/,
  /总的来说[，,]/,
  /需要注意的是[，,]/,
  /让我们(?:一起|来)/,
  /首先[，,].{0,40}其次/
];

const ROLE_FORGE = /(?:^|\n)\s*(?:#{1,3}\s*)?(?:user|assistant|system|主人|用户)\s*[:：\n]/i;

/* G25：伪称用户说过某句（历史未必有）—— 常见幻觉话术。 */
const FAKE_USER_QUOTE = [
  /你(?:刚才|之前|刚刚)?(?:说过|讲过|提到过|告诉过我)\s*[：:「『""]/,
  /(?:用户|主人)(?:刚才|之前)?(?:说|讲|提)[过了]?\s*[：:「『""']/,
  /你不是(?:说|讲)[过了]?\s*[：:「『""']/
];

function normalizeLevel(raw) {
  const s = String(raw || 'med').toLowerCase();
  if (s === 'off' || s === '0' || s === 'false') return 'off';
  if (s === 'strict') return 'strict';
  return 'med';
}

/**
 * @param {string} text
 * @param {{ level?: string, silent?: boolean }} opts
 * @returns {{ pass: boolean, reason: string }}
 */
function checkPersonaOutput(text, opts = {}) {
  if (opts.silent) return { pass: true, reason: 'silent' };
  const level = normalizeLevel(opts.level);
  if (level === 'off') return { pass: true, reason: 'off' };

  const t = String(text || '').trim();
  if (!t) return { pass: true, reason: 'empty' };

  for (const re of FORBIDDEN) {
    if (re.test(t)) return { pass: false, reason: 'forbidden:' + re.source.slice(0, 24) };
  }

  for (const re of FAKE_USER_QUOTE) {
    if (re.test(t)) return { pass: false, reason: 'fake-user-quote' };
  }

  if (level === 'strict' && ROLE_FORGE.test(t)) {
    return { pass: false, reason: 'role-forge' };
  }

  return { pass: true, reason: 'ok' };
}

module.exports = {
  FORBIDDEN,
  ROLE_FORGE,
  FAKE_USER_QUOTE,
  normalizeLevel,
  checkPersonaOutput
};
