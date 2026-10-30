'use strict';

/* ============================================================
 *  视角蒸馏模板（P7）→ personaParts 草稿
 * ==========================================================
 *
 *  用户填短答（她是谁 / 怎么说话 / 怎么帮忙），拼成 identity/style/method/extra。
 *  不碰 emotion/thought。纯函数。
 * ========================================================== */

function trim(s, max = 400) {
  return String(s || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

/**
 * @param {{ who?: string, tone?: string, help?: string, taboo?: string, name?: string }} answers
 */
function distillPersonaParts(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const name = trim(a.name, 32);
  const who = trim(a.who, 200);
  const tone = trim(a.tone, 200);
  const help = trim(a.help, 200);
  const taboo = trim(a.taboo, 200);
  const parts = {};

  const idBits = [];
  if (name) idBits.push(`你叫${name}。`);
  if (who) idBits.push(who);
  else if (name) idBits.push('是常驻在这台电脑里的搭子。');
  if (idBits.length) parts.identity = idBits.join('');

  if (tone) parts.style = tone;
  if (help) parts.method = help;
  if (taboo) parts.extra = `边界：${taboo}`;

  if (!Object.keys(parts).length) return { ok: false, error: 'empty', parts: {} };
  return { ok: true, name, parts };
}

const PROMPT_FIELDS = [
  { key: 'name', label: '她叫什么（可空）', placeholder: '日和' },
  { key: 'who', label: '她是谁 / 在哪儿', placeholder: '常驻电脑里的搭子，不是客服' },
  { key: 'tone', label: '怎么说话', placeholder: '干脆、直接，不客套' },
  { key: 'help', label: '怎么帮忙', placeholder: '先结论后理由，拿不准就说不确定' },
  { key: 'taboo', label: '别碰什么（可空）', placeholder: '别叫全名、别催睡' }
];

module.exports = { distillPersonaParts, PROMPT_FIELDS, trim };
