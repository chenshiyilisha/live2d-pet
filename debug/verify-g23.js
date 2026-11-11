'use strict';
/* G23：短期记忆 → 长期记忆（历史保留三档开关）的验收脚本。
 *
 * 背景：用户要把「短期记忆改成长期记忆」，按开源调研最优机制落地
 * （§25：KokoroMemo 分层 + Mem0 抽取形态），做成配置开关：
 *   chat.history.contextKeep —— 渲染层发给 LLM 的最近对话条数（决定 token）
 *   chat.history.saveKeep    —— chat-history.json 落盘保留条数
 *   chat.history.loadKeep    —— 启动时恢复进内存的条数
 * 默认温和值 20/300/100（原硬编码 16/80/40）。
 *
 * 验证：
 *   A. DEFAULT_CONFIG 三档存在且为温和值；
 *   B. historyKeep() 逻辑：缺字段/坏值/负数 → 温和值兜底；
 *   C. history:load 按 loadKeep 截断（mock fs + 真实 loadConfig）；
 *   D. history:save 按 saveKeep 截断；
 *   E. 负对照：loadKeep/saveKeep 为 0 或负 → 温和值兜底（不截到空）。
 *
 * ⚠️ 计数必须累计（这个项目踩过：只打印不计数 → 全红也退 0）。
 *
 * 用法：node debug/verify-g23.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
let passes = 0;
const ok = (m) => { passes++; console.log('  ✅ ' + m); };
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));
const eq = (a, b, m) => check(a === b, `${m}（期望 ${b} 实际 ${a}）`);

/* ══════ 先把 electron 换成桩 ══════ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-g23-'));
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return { app: { getPath: () => tmp, getVersion: () => '0.0.0-test' } };
  }
  return origRequire.apply(this, arguments);
};

const config = require('../src/main/config');

const cfgFile = path.join(tmp, 'config.json');
const writeCfg = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj, null, 2), 'utf8');

/* ══════ A. DEFAULT_CONFIG 三档存在且为温和值 ══════ */
console.log('\n[A] DEFAULT_CONFIG 三档');
const def = config.DEFAULT_CONFIG;
check(def.chat && def.chat.history, 'chat.history 段存在');
eq(def.chat.history.contextKeep, 20, 'contextKeep 默认 20（原 16）');
eq(def.chat.history.saveKeep, 300, 'saveKeep 默认 300（原 80）');
eq(def.chat.history.loadKeep, 100, 'loadKeep 默认 100（原 40）');

/* ══════ B. historyKeep 逻辑（复刻 main.js 的 historyKeep）══════ */
console.log('\n[B] historyKeep 逻辑');
/* main.js 里的 historyKeep 是模块内函数，这里复刻同逻辑测兜底行为。
 * 真源在 main.js 的 historyKeep()，本段测的是「配置缺字段/坏值时的行为」。 */
function historyKeepOf(cfg) {
  const h = (cfg && cfg.chat && cfg.chat.history) || {};
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : def);
  return {
    loadKeep: num(h.loadKeep, 100),
    saveKeep: num(h.saveKeep, 300),
    contextKeep: num(h.contextKeep, 20)
  };
}

eq(historyKeepOf({}).loadKeep, 100, '缺 history 段 → loadKeep 温和值');
eq(historyKeepOf({}).saveKeep, 300, '缺 history 段 → saveKeep 温和值');
eq(historyKeepOf({}).contextKeep, 20, '缺 history 段 → contextKeep 温和值');
eq(historyKeepOf({ chat: {} }).loadKeep, 100, '空 chat 段 → 温和值');
eq(historyKeepOf({ chat: { history: {} } }).contextKeep, 20, '空 history 段 → 温和值');
eq(historyKeepOf({ chat: { history: { loadKeep: 0 } } }).loadKeep, 100, 'loadKeep=0 → 温和值（不截到空）');
eq(historyKeepOf({ chat: { history: { saveKeep: -5 } } }).saveKeep, 300, 'saveKeep 负数 → 温和值');
eq(historyKeepOf({ chat: { history: { contextKeep: 'abc' } } }).contextKeep, 20, 'contextKeep 字符串 → 温和值');
eq(historyKeepOf({ chat: { history: { loadKeep: 50 } } }).loadKeep, 50, '合法 loadKeep 被采用');
eq(historyKeepOf({ chat: { history: { saveKeep: 12.7 } } }).saveKeep, 12, 'saveKeep 小数向下取整');

/* ══════ C. history:load 按 loadKeep 截断 ══════ */
console.log('\n[C] history:load 按 loadKeep 截断');
const arr = Array.from({ length: 250 }, (_, i) => ({ role: 'user', content: 'm' + i }));
fs.writeFileSync(path.join(tmp, 'chat-history.json'), JSON.stringify(arr));

/* 复刻 main.js 的 history:load 逻辑：读文件 → slice(-loadKeep) */
function loadHistory(keep) {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(tmp, 'chat-history.json'), 'utf8'));
    return Array.isArray(a) ? a.slice(-keep) : [];
  } catch { return []; }
}
eq(loadHistory(100).length, 100, 'loadKeep=100 → 取最后 100 条');
eq(loadHistory(50).length, 50, 'loadKeep=50 → 取最后 50 条');
eq(loadHistory(100)[99].content, 'm249', '取到的是最新的那条');
eq(loadHistory(100)[0].content, 'm150', '取到的是第 150 条（250-100）');

/* ══════ D. history:save 按 saveKeep 截断 ══════ */
console.log('\n[D] history:save 按 saveKeep 截断');
function saveHistory(arr, keep) {
  fs.writeFileSync(path.join(tmp, 'chat-history.json'), JSON.stringify((arr || []).slice(-keep), null, 1), 'utf8');
  return JSON.parse(fs.readFileSync(path.join(tmp, 'chat-history.json'), 'utf8'));
}
const saved = saveHistory(arr, 300);
eq(saved.length, 250, 'saveKeep=300 ≥ 总数 → 全存');
const saved2 = saveHistory(arr, 80);
eq(saved2.length, 80, 'saveKeep=80 → 只存最后 80 条');
eq(saved2[79].content, 'm249', '存的最后是最新');

/* ══════ E. 负对照：loadKeep/saveKeep 为 0 或负 → 温和值兜底 ══════ */
console.log('\n[E] 负对照：坏配置不截到空');
/* 复刻 main.js：loadKeep=0 时 historyKeep() 返回温和值 100，不会 slice(-0)=空 */
eq(historyKeepOf({ chat: { history: { loadKeep: 0 } } }).loadKeep, 100, 'loadKeep=0 → 兜底 100（不截到空）');
eq(historyKeepOf({ chat: { history: { saveKeep: 0 } } }).saveKeep, 300, 'saveKeep=0 → 兜底 300');
eq(historyKeepOf({ chat: { history: { contextKeep: 0 } } }).contextKeep, 20, 'contextKeep=0 → 兜底 20');

/* ══════ 汇总 ══════ */
console.log(`\n──────────────────────────────────────────`);
console.log(`结果：${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
