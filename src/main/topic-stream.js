'use strict';

const fs = require('fs');
const path = require('path');

/* ============================================================
 *  W55：主动刷新独立主题流（2026-11-11）
 * ==========================================================
 *
 *  背景：proactive（主动搭话）现在只有"开口"一个动作 —— 渲染层到点 →
 *  主进程 info-gain 判该不该说 → 模型自由发挥一句。话头质量完全押在
 *  模型临场发挥上，没有"她最近在留意什么"这一层。
 *
 *  借鉴：surfcore-life / group_chat_plus 的"兴趣刷新"思想——
 *  **主题刷新和开口决定分层**：一条独立的刷新流周期性生成兴趣主题
 *  （interests），开口时只是**挑一个**提起来，而不是每次从零想。
 *
 *  设计约束：
 *   · **不用 LLM 刷新**：主题从记忆事实 + 最近对话里用启发式拼，
 *     刷新是纯本地计算（零成本、零延迟、可回归）。要模型参与的
 *     话术润色仍留在开口那一刻（chat:proactive 的提示词里带主题）。
 *   · **自调度 + 代际令牌**（规矩 16）：绝不用 setInterval；每轮
 *     睡醒后先看令牌是否还认自己，不认就退出（stop 之后不再冒头）。
 *   · **开关**（规矩 4）：`proactive.topicStream` 默认**关**——
 *     主动搭话本身默认关，主题流是它的增强，不该单独打扰。
 *     托盘有勾选（跟 proactive.enabled 同一组）。
 *   · **fail-open**：刷新/写盘任何一步失败都不影响 proactive 主流程，
 *     台账写不进去最多少一条审计记录。
 *   · **主题有 TTL**：刷出来的话题只供最近 N 分钟用，过期自然淘汰，
 *     不会一直挂着旧话题。
 *
 *  挂法：main.js 启动时 `startTopicStream()`；chat:proactive 里
 *  `topicHintFor(cfg)` 取当前主题拼进提示词；停止走 `stopTopicStream()`。 */

const LEDGER_NAME = 'proactive-topics.jsonl';
const MAX_TOPICS = 3;            // 一次最多带几个候选主题（多了等于全量注入）
const TTL_MS = 2 * 60 * 60 * 1000;  // 话题有效期：2 小时
const DEFAULT_REFRESH_MS = 10 * 60 * 1000;  // 默认 10 分钟刷一次

let dataDir = null;
let topics = [];                 // [{ text, source, at }]
let timer = null;
let token = 0;                   // 代际令牌（规矩 16）
let lastError = '';
/* 测试钩子：verify 脚本把台账路径指到不可写处制造失败（同 config-ledger 的教训）。 */
let testLedgerOverride = null;
/* 测试钩子：把回滚集合路径指到不可写处制造失败。 */
let testRejectedOverride = null;

function configureTopicStream(dir) {
  dataDir = dir || null;
  if (dataDir) loadRejected();
}

function ledgerPath() {
  if (testLedgerOverride) return testLedgerOverride;
  if (!dataDir) return null;
  return path.join(dataDir, LEDGER_NAME);
}

function appendRow(row) {
  const p = ledgerPath();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (err) {
    lastError = String(err && err.message || err).slice(0, 120);
    return false;
  }
}

/* ---- 主题来源 1：记忆事实（高清晰度的优先） ---- */
function topicsFromFacts(listFacts, clarityOrder) {
  if (typeof listFacts !== 'function') return [];
  let facts;
  try { facts = listFacts() || []; } catch { return []; }
  const rank = (f) => {
    const c = f && f.clarity;
    if (c === 'vivid') return 0;
    if (c === 'clear') return 1;
    if (c === 'faint') return 2;
    return 3;
  };
  return facts
    .filter((f) => f && typeof f.text === 'string' && f.text.trim())
    .sort((a, b) => rank(a) - rank(b) || (Number(b && b.importance) || 0) - (Number(a && a.importance) || 0))
    .slice(0, 2)
    .map((f) => ({ text: String(f.text).trim().slice(0, 40), source: 'memory:' + (f.kind || 'fact') }));
}

/* ---- 主题来源 2：最近一轮用户说的话（截一小段当话题苗子） ---- */
function topicsFromHistory(history) {
  const arr = Array.isArray(history) ? history : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m && m.role === 'user' && typeof m.content === 'string') {
      const t = m.content.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (t) return [{ text: t, source: 'history' }];
    }
  }
  return [];
}

/* 去重（同文本只留一份，记忆优先）+ 截断到上限。 */
function mergeTopics(parts) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    for (const t of p || []) {
      const key = t.text.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= MAX_TOPICS) break;
    }
    if (out.length >= MAX_TOPICS) break;
  }
  return out;
}

/* ---- W57：决策级回滚标记（借 deja-vu accepted/rejected 思想，MIT）---- */
const REJECTED_NAME = 'proactive-rejected.json';
const REJECTED_MAX = 20;
let rejected = [];

function rejectedPath() {
  if (testRejectedOverride) return testRejectedOverride;
  if (!dataDir) return null;
  return path.join(dataDir, REJECTED_NAME);
}

function loadRejected() {
  try {
    const arr = JSON.parse(fs.readFileSync(rejectedPath(), 'utf8'));
    rejected = Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch { rejected = []; }
  return rejected;
}

function saveRejected() {
  try {
    const p = rejectedPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(rejected), 'utf8');
    return true;
  } catch { return false; }
}

/** W57：标记决策被回滚（之后不再推荐）。去重 + 截断。 */
function markRejected(text) {
  const t = String(text || '').trim();
  if (!t || rejected.includes(t)) return false;
  rejected.push(t);
  if (rejected.length > REJECTED_MAX) rejected = rejected.slice(-REJECTED_MAX);
  saveRejected();
  return true;
}

function isRejected(text) {
  return rejected.includes(String(text || '').trim());
}

/** 测试钩子：清空内存里的回滚集合（不动磁盘文件）。 */
function resetRejectedForTest() {
  rejected = [];
}

/** 测试钩子：把回滚集合路径指到指定处（制造写失败用）。 */
function setRejectedPathForTest(p) {
  testRejectedOverride = p || null;
}

/**
 * 刷新主题（纯函数式入口，测试直接调它，不依赖定时器）。
 * @param {object} deps { listFacts, history, now }
 * @returns {Array} 新主题列表（旧的清零，由调用方决定何时替换）
 */
function buildTopics(deps) {
  const now = Number(deps && deps.now) || Date.now();
  const parts = [
    topicsFromFacts(deps && deps.listFacts),
    topicsFromHistory(deps && deps.history)
  ];
  const merged = mergeTopics(parts);
  /* W57：开关开（rollback===true）→ 过滤被回滚的主题。 */
  const filter = deps && deps.rollback === true;
  const kept = filter ? merged.filter((t) => !isRejected(t.text)) : merged;
  return kept.map((t) => ({ text: t.text, source: t.source, at: now }));
}

/** 取当前有效主题（过期的丢掉）。 */
function getTopics(now = Date.now()) {
  return topics.filter((t) => now - t.at < TTL_MS);
}

/** 把主题拼成提示词里的一行（没有主题返回 ''）。
 * @param {object} cfg 整份配置（读 proactive.topicStream 开关）
 * @param {number} [now] 时间戳（测试注入用；默认当前） */
function topicHintFor(cfg, now = Date.now()) {
  if (!cfg || cfg.proactive?.topicStream !== true) return '';
  const live = getTopics(now);
  if (!live.length) return '';
  const list = live.map((t) => t.text).join('、');
  return '（你最近在留意这些：' + list + '。主动开口时可以从里面挑一个顺口提起来，' +
    '挑不出来就照常随口说，别硬套。）';
}

/** 一轮刷新：算主题 → 替换 → 记台账。任何异常都吃掉（fail-open）。 */
function refreshOnce(deps) {
  try {
    const next = buildTopics(deps);
    topics = next;
    /* 台账每轮都记（哪怕主题没变，"什么时候刷过"本身也是审计信息）；
     * 写失败最多少一条记录，新主题照用。 */
    appendRow({ at: Date.now(), topics: next.map((t) => t.text) });
    return next;
  } catch (err) {
    lastError = String(err && err.message || err).slice(0, 120);
    return [];
  }
}

/**
 * 启动主题刷新流（自调度，规矩 16）。
 * @param {object} opts { listFacts, history, refreshMs, onTick, rollback }
 * listFacts / history 是**取数据的函数**（每次轮询时现取），
 * 不是静态值 —— 记忆是活的，得每轮重新读。
 * rollback：W57 开关，开则过滤已回滚主题。
 */
function startTopicStream(opts) {
  stopTopicStream();
  const o = opts || {};
  const ms = Math.max(60 * 1000, Number(o.refreshMs) || DEFAULT_REFRESH_MS);
  const myToken = ++token;
  const tick = () => {
    if (myToken !== token) return;   // 已被 stop / 重启取代
    const deps = {
      listFacts: typeof o.listFacts === 'function' ? o.listFacts : null,
      history: typeof o.history === 'function' ? o.history() : o.history,
      now: Date.now(),
      rollback: o.rollback === true
    };
    let next = [];
    try { next = refreshOnce(deps); } catch { next = []; }
    if (typeof o.onTick === 'function') {
      try { o.onTick(next); } catch { /* 观察者异常不拖垮循环 */ }
    }
    if (myToken === token) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return myToken;
}

function stopTopicStream() {
  token++;
  if (timer) { clearTimeout(timer); timer = null; }
}

module.exports = {
  configureTopicStream,
  buildTopics,
  getTopics,
  topicHintFor,
  refreshOnce,
  startTopicStream,
  stopTopicStream,
  /* 测试钩子：制造台账写入失败（指向不存在的目录深处）。 */
  setLedgerPathForTest: (p) => { testLedgerOverride = p; },
  TTL_MS,
  MAX_TOPICS,
  ledgerPath,
  /* W57：决策级回滚标记 */
  markRejected,
  isRejected,
  loadRejected,
  resetRejectedForTest,
  setRejectedPathForTest,
  _debug: () => ({ topics, lastError, rejected })
};
