'use strict';
/**
 * usage.js —— token 用量台账与成本估算（W64）
 *
 * 出处：PolinniZhong/dsh-personal-center（MIT）的 Token 用量 + 成本估算面板。
 * 我们只借「用量记账 + 成本估算」的形态，不搬其面板。
 *
 * 数据流：
 *   llm.js 的 streamLLM 在收流时解析每个 SSE chunk 的 `usage`
 *   （OpenAI 兼容协议在最后一个 chunk 带 usage，需 `stream_options.include_usage`），
 *   返回 { ok, usage: { promptTokens, completionTokens, totalTokens } }。
 *   main.js 的 chatStream 在流结束后调用 record() 记账。
 *
 * 存储：userData/usage.json（按天聚合 + 明细尾部）。
 *   - byDay: { 'YYYY-MM-DD': { prompt, completion, total, turns, models: {...} } }
 *   - recent: 最近 N 条明细（倒序，便于排查）
 *
 * 成本：monitor.usagePrices 是 { modelName: { prompt: 每百万 token 单价, completion: ... } }，
 *   单位 ¥/百万 token。没配价格的模型只记账不计价（成本显示 "—"）。
 */

const fs = require('fs');
const path = require('path');

const RECENT_MAX = 200;
const DAY_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 明细只留 90 天

let storePath = null;      // 由 main.js 注入（userData 目录）
let store = { byDay: {}, recent: [] };
let saveTimer = null;

function setStorePath(p) {
  storePath = p;
  store = { byDay: {}, recent: [] };
  load();
}

function load() {
  if (!storePath) return;
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.byDay && Array.isArray(parsed.recent)) {
      store = parsed;
    }
  } catch { /* 首次运行 / 文件损坏 → 用空台账 */ }
}

function scheduleSave() {
  if (!storePath) return;
  if (saveTimer) return;                 // 已排 → 合并到下一轮
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
    } catch { /* 记不住就记不住，不影响聊天 */ }
  }, 1500);
}

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 记一条用量。usage 来自 streamLLM 的返回值。 */
function record(entry) {
  if (!entry || typeof entry !== 'object') return;
  const model = String(entry.model || 'unknown');
  const prompt = Math.max(0, Math.round(entry.promptTokens || 0));
  const completion = Math.max(0, Math.round(entry.completionTokens || 0));
  const total = Math.max(prompt + completion, Math.round(entry.totalTokens || 0));
  const ts = Date.now();

  const key = todayKey(new Date(ts));
  const day = store.byDay[key] || (store.byDay[key] = {
    prompt: 0, completion: 0, total: 0, turns: 0, models: {}
  });
  day.prompt += prompt;
  day.completion += completion;
  day.total += total;
  day.turns += 1;
  const mm = day.models[model] || (day.models[model] = { prompt: 0, completion: 0, total: 0, turns: 0 });
  mm.prompt += prompt;
  mm.completion += completion;
  mm.total += total;
  mm.turns += 1;

  store.recent.unshift({ ts, model, prompt, completion, total });
  if (store.recent.length > RECENT_MAX) store.recent.length = RECENT_MAX;

  /* 修剪过期天数：只保留最近 90 天的按天聚合 */
  const cutoff = Date.now() - DAY_TTL_MS;
  for (const k of Object.keys(store.byDay)) {
    if (new Date(k + 'T00:00:00').getTime() < cutoff - 86400000) delete store.byDay[k];
  }

  scheduleSave();
}

/** 按模型单价估算单条明细成本。prices = { model: { prompt, completion } }，单位 ¥/百万。 */
function costOf(entry, prices) {
  const p = prices && prices[entry.model];
  if (!p) return null;
  const promptCost = (entry.prompt / 1e6) * (Number(p.prompt) || 0);
  const completionCost = (entry.completion / 1e6) * (Number(p.completion) || 0);
  return promptCost + completionCost;
}

/** 汇总：今日 / 累计 / 估算成本。返回给渲染层显示。 */
function summary(prices) {
  const keys = Object.keys(store.byDay).sort();
  const today = store.byDay[todayKey()] || { prompt: 0, completion: 0, total: 0, turns: 0, models: {} };
  let allPrompt = 0, allCompletion = 0, allTotal = 0, allTurns = 0;
  for (const k of keys) {
    allPrompt += store.byDay[k].prompt;
    allCompletion += store.byDay[k].completion;
    allTotal += store.byDay[k].total;
    allTurns += store.byDay[k].turns;
  }
  const costToday = sumCost(today, prices);
  const costAll = sumCost({ models: aggregateModels(keys) }, prices);
  return {
    today: { prompt: today.prompt, completion: today.completion, total: today.total, turns: today.turns },
    all: { prompt: allPrompt, completion: allCompletion, total: allTotal, turns: allTurns },
    costToday,
    costAll,
    dayCount: keys.length,
  };
}

function aggregateModels(keys) {
  const out = {};
  for (const k of keys) {
    for (const m of Object.keys(store.byDay[k].models || {})) {
      const src = store.byDay[k].models[m];
      const dst = out[m] || (out[m] = { prompt: 0, completion: 0, total: 0, turns: 0 });
      dst.prompt += src.prompt;
      dst.completion += src.completion;
      dst.total += src.total;
      dst.turns += src.turns;
    }
  }
  return out;
}

function sumCost(day, prices) {
  let c = 0, priced = false;
  for (const m of Object.keys(day.models || {})) {
    const f = costOf({ model: m, prompt: day.models[m].prompt, completion: day.models[m].completion }, prices);
    if (f !== null) { c += f; priced = true; }
  }
  return priced ? c : null;
}

/** 立即落盘（取消延迟写）。测试与退出时用。 */
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!storePath) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8');
  } catch { /* 记不住就记不住，不影响聊天 */ }
}

/** 重置（测试用）。 */
function resetForTest() {
  store = { byDay: {}, recent: [] };
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

module.exports = {
  setStorePath, record, summary, flush, resetForTest, todayKey, costOf,
  _store: () => store,
};
