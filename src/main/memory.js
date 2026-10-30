'use strict';

/* 「能不能真的发请求」只有一处定义（llm-providers.js 的 isUsable）。 */
const { isUsable } = require('./llm-providers');

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
const {
  scoreImportance, isPinned, retentionOf, clarityFromRetention,
  clarityIndex, localDayIndex, displayPrefix, CLARITY_ORDER, CLARITY, RETENTION,
  INITIAL, initialProbability, isFirstEncounter
} = require('./memory-score');

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
let getForgetEnabled = () => false;
let cache = null;   // { facts: Fact[] } | null

function configureMemory({ getPath: gp, getForgetEnabled: gfe } = {}) {
  if (typeof gp === 'function') getPath = gp;
  if (typeof gfe === 'function') getForgetEnabled = gfe;
  cache = null;
}

function isTombstone(f) {
  return !!(f && f.forgotten === true && typeof f.id === 'string');
}

function toTombstone(f, now = Date.now()) {
  return {
    id: f.id,
    kind: KINDS.includes(f.kind) ? f.kind : 'other',
    forgotten: true,
    text: '',
    /* 正文已删，留 normalizeKey 供 upsert 复活匹配（不能只靠 id：旧档 id 可能不是 makeId）。 */
    key: normalizeKey(f.text || f.key || ''),
    at: Number(f.at) || now,
    forgottenAt: now
  };
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

/** W25：稳定 0..1（sha1(id+'first') 前 4 字节 / 2^32）。同 id 永远同值。 */
function hashUnit(id) {
  const buf = crypto.createHash('sha1').update(String(id || '') + 'first').digest();
  return buf.readUInt32BE(0) / 4294967296;
}

/**
 * W25：在 firstAt 起 30 天窗口内，按稳定散列打 firstEncounter（最多 3 条）。
 * 已打标的不撤销；同一份档永远同一批。
 */
function refreshFirstEncounters(store) {
  if (!store || !Array.isArray(store.facts)) return store;
  const firstAt = Number(store.firstAt) || 0;
  if (!firstAt) return store;
  const live = store.facts.filter((f) => !isTombstone(f));
  const already = live.filter(isFirstEncounter);
  if (already.length >= INITIAL.MAX_MARK) return store;
  const cands = [];
  for (const f of live) {
    if (isFirstEncounter(f)) continue;
    const ageDays = (Number(f.at) - firstAt) / 86400000;
    if (ageDays < 0 || ageDays >= INITIAL.WINDOW_DAYS) continue;
    const u = hashUnit(f.id);
    if (u < initialProbability(ageDays)) cands.push({ f, u });
  }
  cands.sort((a, b) => a.u - b.u || String(a.f.id).localeCompare(String(b.f.id)));
  const need = INITIAL.MAX_MARK - already.length;
  for (const { f } of cands.slice(0, need)) f.firstEncounter = true;
  return store;
}

function emptyStore() {
  return {
    version: 2,
    facts: [],
    decayDay: localDayIndex(),
    firstAt: 0,
    stats: { forgotten: 0, dropped: 0 }
  };
}

/* G19 2a：v1 → v2 迁移（幂等；不追溯降档）。 */
function migrateStore(raw) {
  const rawFacts = Array.isArray(raw?.facts) ? raw.facts : [];
  const tombs = rawFacts.filter(isTombstone);
  const factsIn = rawFacts.filter(isFact);
  const today = localDayIndex();
  const facts = factsIn.map((f) => {
    if (f.migrated && typeof f.importance === 'number' && f.clarity) return f;
    const hits = Number(f.hits) || 0;
    const scored = scoreImportance(f.text, f.kind, f.source);
    const kindFloor = (f.kind === 'name' ? 45 : f.kind === 'boundary' ? 40 : 0) + hits * 4;
    const importance = Math.max(scored, kindFloor, 1);
    return {
      ...f,
      importance,
      clarity: f.clarity || 'clear',
      lastSeen: Number(f.lastSeen) || 0,
      recallCount: Number(f.recallCount) || 0,
      pinned: isPinned({ ...f, importance }),
      firstEncounter: !!f.firstEncounter,
      migrated: true
    };
  }).concat(tombs);
  const firstAt = facts.reduce((m, f) => {
    const t = Number(f.at) || 0;
    if (!t) return m;
    return m === 0 ? t : Math.min(m, t);
  }, Number(raw?.firstAt) || 0);
  const store = {
    version: 2,
    facts,
    decayDay: Number.isFinite(Number(raw?.decayDay)) ? Number(raw.decayDay) : today,
    firstAt,
    stats: {
      forgotten: Number(raw?.stats?.forgotten) || 0,
      dropped: Number(raw?.stats?.dropped) || 0
    }
  };
  refreshFirstEncounters(store);
  return store;
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
    cache = migrateStore(raw);
    if (Number(raw?.version) !== 2 || !raw?.decayDay) saveStore(cache);
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

    const id = makeId(text + kind);
    const key = normalizeKey(text);
    /* 2b：同 id / 同 key 墓碑 → 复活（恢复正文，不算「新记」）。 */
    const tombIdx = store.facts.findIndex((f) =>
      isTombstone(f) && (f.id === id || (f.key && f.key === key)));
    if (tombIdx >= 0) {
      const tomb = store.facts[tombIdx];
      const source = d.source === 'llm' ? 'llm' : 'heuristic';
      const importance = scoreImportance(text, kind, source);
      const fact = {
        id: tomb.id,
        text,
        kind,
        at: Number(tomb.at) || now,
        updated: now,
        hits: 0,
        source,
        importance,
        clarity: 'vivid',
        lastSeen: 0,
        recallCount: 0,
        pinned: false,
        firstEncounter: false,
        migrated: false,
        forgotten: false
      };
      fact.pinned = isPinned(fact);
      store.facts[tombIdx] = fact;
      updated++;
      continue;
    }

    let found = store.facts.find((f) => !isTombstone(f) && similarFact(f.text, text));
    if (found) {
      /* 新的更具体就替换文案；种类取更「硬」的（name > boundary > …） */
      if (text.length > found.text.length) found.text = text;
      if ((KIND_BOOST[kind] || 0) > (KIND_BOOST[found.kind] || 0)) found.kind = kind;
      found.updated = now;
      found.hits = (found.hits || 0) + 1;
      const imp = scoreImportance(found.text, found.kind, found.source);
      found.importance = Math.max(Number(found.importance) || 0, imp);
      found.pinned = isPinned(found);
      updated++;
    } else {
      const source = d.source === 'llm' ? 'llm' : 'heuristic';
      const importance = scoreImportance(text, kind, source);
      const fact = {
        id,
        text,
        kind,
        at: now,
        updated: now,
        hits: 0,
        source,
        importance,
        clarity: 'vivid',
        lastSeen: 0,
        recallCount: 0,
        pinned: false,
        firstEncounter: false,
        migrated: false
      };
      fact.pinned = isPinned(fact);
      store.facts.push(fact);
      if (!store.firstAt) store.firstAt = now;
      added++;
    }
  }

  /* W25：入库后刷新初次相遇打标（稳定散列，幂等）。 */
  refreshFirstEncounters(store);

  /* 超限：按 salience 升序丢掉最弱的（墓碑不占容量；初次相遇永不淘汰）。 */
  const live = store.facts.filter((f) => !isTombstone(f));
  const tombs = store.facts.filter(isTombstone);
  if (live.length > maxFacts) {
    const protected_ = live.filter((f) => isFirstEncounter(f));
    const rest = live.filter((f) => !isFirstEncounter(f));
    rest.sort((a, b) => scoreFact(a, '') - scoreFact(b, ''));
    const keep = Math.max(0, maxFacts - protected_.length);
    store.facts = protected_.concat(rest.slice(Math.max(0, rest.length - keep))).concat(tombs);
    store.stats = store.stats || { forgotten: 0, dropped: 0 };
    store.stats.dropped = (Number(store.stats.dropped) || 0) + Math.max(0, rest.length - keep);
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
  const live = store.facts.filter((f) => !isTombstone(f));

  /* W25：初次相遇单独成区，常驻少量（不挤掉 name/boundary）。 */
  const origin = live
    .filter(isFirstEncounter)
    .sort((a, b) => scoreFact(b, q) - scoreFact(a, q))
    .slice(0, 2);

  const core = live
    .filter((f) => f.kind === 'name' || f.kind === 'boundary')
    .sort((a, b) => scoreFact(b, q) - scoreFact(a, q))
    .slice(0, 2);

  let extra = [];
  if (expand || opts.alwaysExtra) {
    extra = live
      .filter((f) => !core.includes(f) && !origin.includes(f))
      .map((f) => ({ f, s: scoreFact(f, q) }))
      .filter((x) => x.s > 4 || expand)
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(0, injectMax - core.length - origin.length))
      .map((x) => x.f);
  }

  const picked = [];
  for (const f of [...origin, ...core, ...extra]) {
    if (picked.length >= injectMax) break;
    if (!picked.includes(f)) picked.push(f);
  }

  /* hits = 注入次数；复习（lastSeen）只在 query token 真重叠时涨 */
  if (picked.length) {
    const now = Date.now();
    const qTok = new Set(tokenize(q));
    for (const f of picked) {
      f.hits = (f.hits || 0) + 1;
      if (q) {
        const fTok = tokenize(f.text);
        if (fTok.some((tok) => qTok.has(tok))) {
          f.recallCount = (f.recallCount || 0) + 1;
          f.lastSeen = now;
        }
      }
    }
    saveStore(store);
  }

  return picked.filter((f) => {
    const c = f.clarity || 'clear';
    if (c === 'trace') return expand; // trace 只在扩召时
    return true;
  });
}

/** 拼进 system 的那一行。空 = 不要插。模糊档带前缀并计入 budget。
 *  W25：初次相遇单独成段「最初的日子」，不与普通重要混排。 */
function formatMemoryLine(facts, budget = 400) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '';
  const origin = list.filter(isFirstEncounter);
  const rest = list.filter((f) => !isFirstEncounter(f));
  const parts = [];
  let used = 0;
  let hasFuzzy = false;
  const pushBit = (bit) => {
    if (used + bit.length + 1 > budget) return false;
    parts.push(bit);
    used += bit.length + 1;
    return true;
  };
  if (origin.length) {
    const bits = [];
    for (const f of origin) {
      const clarity = f.clarity || 'clear';
      const prefix = displayPrefix(clarity);
      if (prefix) hasFuzzy = true;
      bits.push(prefix + f.text);
    }
    const block = '最初的日子：' + bits.join('；');
    if (!pushBit(block)) { /* budget 不够就跳过 origin */ }
  }
  for (const f of rest) {
    const clarity = f.clarity || 'clear';
    const prefix = displayPrefix(clarity);
    if (prefix) hasFuzzy = true;
    if (!pushBit(prefix + f.text)) break;
  }
  if (!parts.length) return '';
  const guard = hasFuzzy
    ? '标了「记不清/好像」的不要当事实硬说，也别否认。'
    : '';
  return '【你记得的关于主人的事（别主动罗列，用得上再顺口提；别编造这里没有的）' +
    (guard ? '；' + guard : '') + '：' +
    parts.join('；') + '】';
}

/**
 * 每天最多降一档；离线补跑 ≤30 天。
 * 2a：只降档不删。2b（opts.forgetEnabled）：retention<10 且非钉住、非迁移背填 → 墓碑。
 * @returns {{ store, dropped, risen, forgotten, awayDays }}
 */
function settle(storeIn, now = Date.now(), opts = {}) {
  const store = storeIn && typeof storeIn === 'object' ? storeIn : emptyStore();
  const forgetOn = opts.forgetEnabled === true;
  const today = localDayIndex(now);
  let decayDay = Number(store.decayDay);
  if (!Number.isFinite(decayDay) || decayDay > today) {
    store.decayDay = today;
    return { store, dropped: 0, risen: 0, forgotten: 0, awayDays: 0 };
  }
  if (decayDay === today) {
    return { store, dropped: 0, risen: 0, forgotten: 0, awayDays: 0 };
  }
  const step = Math.min(today - decayDay, RETENTION.CATCHUP_MAX_DAYS);
  let dropped = 0;
  let risen = 0;
  let forgotten = 0;
  const nextFacts = [];
  for (const f of store.facts) {
    if (isTombstone(f)) {
      nextFacts.push(f);
      continue;
    }
    const ret = retentionOf(f, now);
    /* G19 2b：只忘「本版新记」的弱条目；migrated 背填分不准，不许据此删。
     * W25：初次相遇永不遗忘。 */
    if (forgetOn && !isPinned(f) && !isFirstEncounter(f) && f.migrated !== true && ret < CLARITY.trace) {
      nextFacts.push(toTombstone(f, now));
      forgotten++;
      continue;
    }
    const target = clarityFromRetention(ret, isPinned(f) || isFirstEncounter(f));
    const iCur = clarityIndex(f.clarity || 'clear');
    const iTarget = clarityIndex(target);
    const iFloor = (isPinned(f) || isFirstEncounter(f))
      ? clarityIndex('clear')
      : clarityIndex('trace');
    /* 降：一天最多一档 × step；升：一次结算最多一档 */
    let iNext;
    if (iTarget > iCur) {
      iNext = Math.min(iCur + 1, iTarget);
      if (iNext > iCur) risen++;
    } else if (iTarget < iCur) {
      iNext = Math.max(iCur - step, iTarget, iFloor);
      if (iNext > iCur) { /* impossible */ }
      else if (iNext < iCur) dropped++;
    } else {
      iNext = iCur;
    }
    iNext = Math.max(iNext, iFloor);
    f.clarity = CLARITY_ORDER[iNext] || 'clear';
    f.pinned = isPinned(f);
    nextFacts.push(f);
  }
  store.facts = nextFacts;
  if (forgotten) {
    store.stats = store.stats || { forgotten: 0, dropped: 0 };
    store.stats.forgotten = (Number(store.stats.forgotten) || 0) + forgotten;
  }
  store.decayDay = today;
  store.version = 2;
  return { store, dropped, risen, forgotten, awayDays: step };
}

function settleAndSave(now = Date.now()) {
  const store = loadStore();
  const r = settle(store, now, { forgetEnabled: !!getForgetEnabled() });
  if (r.awayDays > 0 || r.dropped || r.risen || r.forgotten) {
    if (saveStore(r.store)) {
      console.log('[memory] settle', JSON.stringify({
        away: r.awayDays, dropped: r.dropped, risen: r.risen, forgotten: r.forgotten
      }));
    }
  }
  return r;
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
  /* 和 streamLLM 同一条判定（llm-providers.isUsable）：本机端点不需要 key。
   * 旧写法只看 apiKey，于是选了 Ollama 之后聊天能通、记忆抽取永远静默跳过。 */
  if (!isUsable({ baseUrl, apiKey }) || !baseUrl) return [];
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
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
  return loadStore().facts.filter((f) => !isTombstone(f));
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
  settle,
  settleAndSave,
  migrateStore,
  isTombstone,
  toTombstone,
  refreshFirstEncounters,
  hashUnit,
  /* 测试用 */
  _resetCache: () => { cache = null; },
  normalizeKey,
  tokenize
};
