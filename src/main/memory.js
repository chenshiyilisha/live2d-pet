'use strict';

/* ============================================================
 *  轻量长期记忆
 * ==========================================================
 *
 *  蓝本（docs 11.1-B / 11.21 KokoroMemo / ClawMemory）：
 *    · 只存**稳定事实**（称呼 / 偏好 / 边界 / 关系约定），不存整段聊天
 *    · 本地 JSON，无向量库、无 embedding
 *    · 召回 = 关键词重叠 + 时效 + 种类加权（BM25 的简化版）
 *    · 写入闸门：启发式先过；可选 LLM 补抽（玩笑/临时剧情不进）
 *    · 召回闸门：有时间代词 / 「记得」等才扩召；核心事实（name/boundary）常驻少量
 *
 *  纯函数为主：verify-memory.js 不启 Electron 也能测。
 *  落盘路径由 configureMemory({ getPath }) 注入。
 * ========================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = Object.freeze(['name', 'pref', 'boundary', 'relation', 'other']);
const KIND_BOOST = Object.freeze({
  name: 8,
  boundary: 7,
  pref: 4,
  relation: 3,
  other: 1
});

/* 时间代词 / 记忆触发 —— 命中才做「扩召」（docs 11.5） */
const RECALL_CUE = /上次|昨天|上周|那天|那次|记得|记不记得|你还记得|我叫什么|我喜欢什么|我的名字|别忘了|说过/;

/* 启发式：从用户话里抽稳定事实（零 token） */
const HEURISTICS = [
  {
    kind: 'name',
    re: /(?:我叫|我的名字是|名字是|请叫我|叫我)([\u4e00-\u9fffA-Za-z0-9·•]{1,12})/,
    fmt: (m) => `主人叫${m[1]}`
  },
  {
    kind: 'boundary',
    re: /(?:别叫我|不要叫我|别再叫我)([\u4e00-\u9fffA-Za-z0-9·•]{0,12})/,
    fmt: (m) => (m[1] ? `不要叫主人「${m[1]}」` : '主人不喜欢被乱叫名字')
  },
  {
    kind: 'pref',
    re: /我不(?:喜欢|爱|想要)(.{1,16}?)(?:[。！？!?,，]|$)/,
    fmt: (m) => `主人不喜欢${trimFact(m[1])}`
  },
  {
    kind: 'pref',
    re: /我(?:喜欢|爱|想要|超爱)(.{1,16}?)(?:[。！？!?,，]|$)/,
    fmt: (m) => `主人喜欢${trimFact(m[1])}`
  },
  {
    kind: 'other',
    re: /(?:请记住|记住|记一下)[：:\s]*(.{2,40}?)(?:[。！？!]|$)/,
    fmt: (m) => trimFact(m[1])
  }
];

const SKIP_MARKERS = /开玩笑|随便说说|骗你的|当我没说|临时|今天先|算了吧/;

let getPath = () => null;
let cache = null;   // { facts: Fact[] } | null

function configureMemory({ getPath: gp } = {}) {
  if (typeof gp === 'function') getPath = gp;
  cache = null;
}

function trimFact(s) {
  return String(s || '')
    .replace(/[「」『』""'']/g, '')
    .replace(/\s+/g, '')
    .replace(/[。.!！?？~～]+$/g, '')
    .slice(0, 40);
}

function normalizeKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，,。.!！?？、；;：:·•「」『』""'']/g, '');
}

function makeId(text) {
  return crypto.createHash('sha1').update(normalizeKey(text)).digest('hex').slice(0, 12);
}

function emptyStore() {
  return { version: 1, facts: [] };
}

function loadStore() {
  if (cache) return cache;
  const p = getPath();
  if (!p) {
    cache = emptyStore();
    return cache;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const facts = Array.isArray(raw?.facts) ? raw.facts.filter(isFact) : [];
    cache = { version: 1, facts };
  } catch {
    cache = emptyStore();
  }
  return cache;
}

function isFact(f) {
  return f && typeof f.text === 'string' && f.text.trim() &&
    KINDS.includes(f.kind) && typeof f.id === 'string';
}

function saveStore(store) {
  cache = store;
  const p = getPath();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(store, null, 1), 'utf8');
    return true;
  } catch (err) {
    console.warn('[memory] save failed:', String(err?.message || err));
    return false;
  }
}

/** 启发式抽取。返回 Fact 草案（无 id/at，由 upsert 补）。 */
function extractHeuristic(userText) {
  const t = String(userText || '').trim();
  if (!t || t.length < 2) return [];
  if (SKIP_MARKERS.test(t)) return [];
  const out = [];
  for (const h of HEURISTICS) {
    const m = t.match(h.re);
    if (!m) continue;
    const text = h.fmt(m);
    if (!text || text.length < 2) continue;
    out.push({ kind: h.kind, text, source: 'heuristic' });
  }
  return out;
}

/** 两段短事实是否该合并（同义改写）。 */
function similarFact(a, b) {
  const ka = normalizeKey(a);
  const kb = normalizeKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  /* 共享汉字比例 */
  const setA = new Set([...ka]);
  let hit = 0;
  for (const c of kb) if (setA.has(c)) hit++;
  const ratio = hit / Math.max(ka.length, kb.length);
  return ratio >= 0.72 && Math.abs(ka.length - kb.length) <= 6;
}

/**
 * 写入闸门 + 去重合并。
 * @returns {{ added: number, updated: number, store }}
 */
function upsertFacts(drafts, opts = {}) {
  const maxFacts = Math.max(10, Math.min(200, Number(opts.maxFacts) || 60));
  const store = loadStore();
  let added = 0;
  let updated = 0;
  const now = Date.now();

  for (const d of drafts || []) {
    if (!d || !d.text) continue;
    const kind = KINDS.includes(d.kind) ? d.kind : 'other';
    const text = trimFact(d.text);
    if (text.length < 2) continue;
    if (SKIP_MARKERS.test(text)) continue;

    let found = store.facts.find((f) => similarFact(f.text, text));
    if (found) {
      /* 新的更具体就替换文案；种类取更「硬」的（name > boundary > …） */
      if (text.length > found.text.length) found.text = text;
      if ((KIND_BOOST[kind] || 0) > (KIND_BOOST[found.kind] || 0)) found.kind = kind;
      found.updated = now;
      found.hits = (found.hits || 0) + 1;
      updated++;
    } else {
      store.facts.push({
        id: makeId(text + kind),
        text,
        kind,
        at: now,
        updated: now,
        hits: 0,
        source: d.source === 'llm' ? 'llm' : 'heuristic'
      });
      added++;
    }
  }

  /* 超限：按 salience 升序丢掉最弱的 */
  if (store.facts.length > maxFacts) {
    store.facts.sort((a, b) => scoreFact(a, '') - scoreFact(b, ''));
    store.facts = store.facts.slice(store.facts.length - maxFacts);
  }

  saveStore(store);
  return { added, updated, store };
}

function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const hans = t.match(/[\u4e00-\u9fff]{1,}/g) || [];
  const words = t.match(/[a-z0-9]{2,}/g) || [];
  /* 中文按双字切一点，单字太噪 */
  const grams = [];
  for (const h of hans) {
    if (h.length === 1) grams.push(h);
    else for (let i = 0; i < h.length - 1; i++) grams.push(h.slice(i, i + 2));
  }
  return [...grams, ...words];
}

function scoreFact(fact, query) {
  const ageDays = Math.max(0, (Date.now() - (fact.updated || fact.at || 0)) / 86400000);
  const recency = Math.max(0, 10 - ageDays * 0.15);   // 约两个月淡到 0
  const kind = KIND_BOOST[fact.kind] || 1;
  const hits = Math.min(12, Number(fact.hits) || 0);
  let overlap = 0;
  if (query) {
    const q = new Set(tokenize(query));
    const f = tokenize(fact.text);
    for (const tok of f) if (q.has(tok)) overlap += 1;
  }
  return kind + hits * 0.8 + recency + overlap * 3;
}

function needsExpandedRecall(userText) {
  return RECALL_CUE.test(String(userText || ''));
}

/**
 * 召回。
 * @returns {Fact[]}
 */
function recall(userText, opts = {}) {
  const store = loadStore();
  const injectMax = Math.max(1, Math.min(12, Number(opts.injectMax) || 6));
  const expand = opts.forceExpand || needsExpandedRecall(userText);
  const q = String(userText || '');

  const core = store.facts
    .filter((f) => f.kind === 'name' || f.kind === 'boundary')
    .sort((a, b) => scoreFact(b, q) - scoreFact(a, q))
    .slice(0, 2);

  let extra = [];
  if (expand || opts.alwaysExtra) {
    extra = store.facts
      .filter((f) => !core.includes(f))
      .map((f) => ({ f, s: scoreFact(f, q) }))
      .filter((x) => x.s > 4 || expand)
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(0, injectMax - core.length))
      .map((x) => x.f);
  }

  const picked = [...core];
  for (const f of extra) {
    if (picked.length >= injectMax) break;
    if (!picked.includes(f)) picked.push(f);
  }

  /* 命中计数（下次更优先） */
  if (picked.length) {
    const now = Date.now();
    for (const f of picked) {
      f.hits = (f.hits || 0) + 1;
      f.updated = f.updated || now;
    }
    saveStore(store);
  }

  return picked;
}

/** 拼进 system 的那一行。空 = 不要插。 */
function formatMemoryLine(facts, budget = 400) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '';
  const parts = [];
  let used = 0;
  for (const f of list) {
    const bit = f.text;
    if (used + bit.length + 1 > budget) break;
    parts.push(bit);
    used += bit.length + 1;
  }
  if (!parts.length) return '';
  return '【你记得的关于主人的事（别主动罗列，用得上再顺口提；别编造这里没有的）：' +
    parts.join('；') + '】';
}

/**
 * 解析 LLM 抽事实输出。每行 `kind|text`，或 NONE。
 */
function parseLlmFacts(raw) {
  const t = String(raw || '').trim();
  if (!t || /^none\b/i.test(t) || t === '无' || t === '没有') return [];
  const out = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim().replace(/^[-*•]\s*/, '');
    if (!s || /^none\b/i.test(s)) continue;
    const m = s.match(/^(name|pref|boundary|relation|other)\s*[|｜:：]\s*(.+)$/i);
    if (m) {
      out.push({ kind: m[1].toLowerCase(), text: trimFact(m[2]), source: 'llm' });
      continue;
    }
    /* 容错：纯中文一行也收，标 other */
    if (/[\u4e00-\u9fff]/.test(s) && s.length >= 4 && s.length <= 40) {
      out.push({ kind: 'other', text: trimFact(s), source: 'llm' });
    }
  }
  return out.slice(0, 3);
}

function buildExtractPrompt(userText, assistantText) {
  return (
    '从下面这段对话里抽出 0~3 条关于「主人」的稳定事实（称呼、偏好、边界、约定、关系）。\n' +
    '不要记玩笑、临时情绪、一次性剧情、模型自己编的内容。\n' +
    '每行一条，格式严格为：kind|事实\n' +
    'kind 只能是 name / pref / boundary / relation / other 之一。\n' +
    '没有可记的就只输出 NONE。\n\n' +
    '用户：' + String(userText || '').slice(0, 400) + '\n' +
    '助手：' + String(assistantText || '').slice(0, 400)
  );
}

/**
 * 非流式抽事实（可选）。失败返回 []，绝不抛到聊天主路径。
 */
async function extractViaLlm(userText, assistantText, llm = {}) {
  const { baseUrl, apiKey, model } = llm;
  if (!apiKey || !baseUrl) return [];
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'deepseek-chat',
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: '你只输出事实行或 NONE，不要解释。' },
          { role: 'user', content: buildExtractPrompt(userText, assistantText) }
        ]
      }),
      signal: ac.signal
    });
    if (!res.ok) return [];
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return parseLlmFacts(content);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function listFacts() {
  return loadStore().facts.slice();
}

function clearFacts() {
  cache = emptyStore();
  return saveStore(cache);
}

function injectMemoryContext(messages, line) {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  if (!line) return arr;
  arr.splice(Math.min(1, arr.length), 0, { role: 'system', content: line });
  return arr;
}

/** 一轮对话结束后的写入入口（启发式 ± LLM 草案）。 */
function rememberTurn(userText, drafts, opts = {}) {
  const fromUser = extractHeuristic(userText);
  const all = [...fromUser, ...(Array.isArray(drafts) ? drafts : [])];
  if (!all.length) return { added: 0, updated: 0 };
  return upsertFacts(all, opts);
}

module.exports = {
  KINDS,
  RECALL_CUE,
  configureMemory,
  extractHeuristic,
  parseLlmFacts,
  buildExtractPrompt,
  extractViaLlm,
  upsertFacts,
  similarFact,
  scoreFact,
  needsExpandedRecall,
  recall,
  formatMemoryLine,
  injectMemoryContext,
  rememberTurn,
  listFacts,
  clearFacts,
  loadStore,
  /* 测试用 */
  _resetCache: () => { cache = null; },
  normalizeKey,
  tokenize
};
