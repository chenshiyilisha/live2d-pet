'use strict';

/* ============================================================
 *  Character Card V2/V3 → personaParts 草稿（P8）
 * ==========================================================
 *
 *  只解析常见字段，不碰 emotion/thought 协议槽。
 *  纯函数；坏 JSON / 缺字段 → 空草稿，不抛。
 * ========================================================== */

const SKIP_KEYS = new Set(['emotion', 'thought']);

function pickData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  /* V3: { spec, spec_version, data:{...} } ；V2 偶发顶层直出 */
  if (raw.data && typeof raw.data === 'object') return raw.data;
  if (raw.name || raw.description || raw.personality) return raw;
  return null;
}

function trimText(s, max = 800) {
  const t = String(s || '').replace(/\r\n/g, '\n').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * @returns {{ ok: boolean, name?: string, parts?: object, error?: string }}
 */
function cardToPersonaDraft(raw) {
  let doc = raw;
  if (typeof doc === 'string') {
    try { doc = JSON.parse(doc); }
    catch { return { ok: false, error: 'bad-json' }; }
  }
  const data = pickData(doc);
  if (!data) return { ok: false, error: 'no-data' };

  const name = trimText(data.name || data.char_name || '', 32);
  const parts = {};

  const identity = [
    name ? `你叫${name}。` : '',
    trimText(data.description || data.char_persona || '', 500)
  ].filter(Boolean).join('\n');
  if (identity) parts.identity = identity;

  const style = trimText(data.personality || data.scenario || '', 400);
  if (style) parts.style = style;

  const extra = [
    trimText(data.mes_example || data.example_dialogue || '', 400),
    trimText(data.system_prompt || data.post_history_instructions || '', 400)
  ].filter(Boolean).join('\n\n');
  if (extra) parts.extra = extra;

  for (const k of SKIP_KEYS) delete parts[k];

  if (!Object.keys(parts).length && !name) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, name: name || '', parts };
}

module.exports = { cardToPersonaDraft, pickData, SKIP_KEYS };
