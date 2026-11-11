/* W56 分层摘要 L0/L1/L2 回归（借 OpenViking 思想，AGPL 只借思想）。
 * 跑法：node debug/verify-w56.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w56-'));
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return { app: { getPath: () => tmp, getVersion: () => 't' } };
  return origRequire.apply(this, arguments);
};

const memory = require('../src/main/memory.js');
memory.configureMemory(tmp);

let pass = 0, fail = 0;
const fails = [];
function eq(a, b, msg) { if (a === b) { pass++; } else { fail++; fails.push(msg + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); } }
function ok(v, msg) { if (v) { pass++; } else { fail++; fails.push(msg + ' (falsy)'); } }
function section(n) { console.log('\n=== ' + n + ' ==='); }

function mkFact(id, kind, text, importance) {
  return { id, kind, text, clarity: 'clear', importance: importance || 0.5, hits: 0, recallCount: 0, at: Date.now(), h: memory.factHash(text) };
}

section('A. buildSummary 纯函数');
const facts = [
  mkFact('n1', 'name', '主人叫阿诚', 0.9),
  mkFact('p1', 'pref', '主人喜欢猫', 0.8),
  mkFact('p2', 'pref', '主人不吃香菜', 0.7),
  mkFact('b1', 'boundary', '主人讨厌被催', 0.6),
  mkFact('r1', 'relation', '主人是上班族', 0.5),
  mkFact('o1', 'other', '主人养了一只猫', 0.4)
];
const s1 = memory.buildSummary(facts);
const s2 = memory.buildSummary(facts);
eq(s1.l0, s2.l0, '确定性：同输入同 L0');
eq(JSON.stringify(s1.l1), JSON.stringify(s2.l1), '确定性：同输入同 L1');
ok(s1.l0.length <= 60, 'L0 限 60 字（实际 ' + s1.l0.length + '）');
ok(s1.l0.includes('主人叫阿诚'), 'L0 含 name 代表');
ok(s1.l0.includes('主人喜欢猫'), 'L0 含 pref 代表');
ok(Array.isArray(s1.l1) && s1.l1.length >= 4, 'L1 按类分组');
ok(s1.l1.some((x) => x.startsWith('pref')), 'L1 有 pref 组');

section('B. formatMemoryLayered');
const storeFresh = { summary: { l0: s1.l0, l1: s1.l1, at: memory.localDayIndex() }, facts };
const line = memory.formatMemoryLayered(facts, storeFresh, 400);
ok(line.includes('整体印象'), '新鲜摘要 → 含 L0 先行');
ok(line.indexOf('整体印象') < line.indexOf('你记得的关于主人的事'), 'L0 在详情之前');
/* 不新鲜（昨天）→ 退化 */
const storeOld = { summary: { l0: s1.l0, l1: s1.l1, at: memory.localDayIndex() - 1 }, facts };
const lineOld = memory.formatMemoryLayered(facts, storeOld, 400);
ok(!lineOld.includes('整体印象'), '摘要不新鲜 → 退化（无 L0）');
ok(lineOld.includes('你记得的关于主人的事'), '退化后走原 formatMemoryLine');
/* 无 summary → 退化 */
const lineNo = memory.formatMemoryLayered(facts, { facts }, 400);
ok(!lineNo.includes('整体印象'), '无 summary → 退化');
/* budget 不足 → 只出 L0 */
const lineSmall = memory.formatMemoryLayered(facts, storeFresh, 10);
ok(lineSmall.includes('整体印象'), 'budget 不足 → 只出 L0');

section('C. ensureSummary');
const store1 = { facts, summary: undefined };
const r1 = memory.ensureSummary(store1);
ok(r1.summary && r1.summary.l0, '缺失 → 补算 summary');
eq(r1.summary.at, memory.localDayIndex(), 'summary.at = 当日');
/* 当日已有 → 不重算（用 marker 验证） */
const store2 = { facts, summary: { l0: 'X', l1: [], at: memory.localDayIndex() } };
const r2 = memory.ensureSummary(store2);
eq(r2.summary.l0, 'X', '当日已有 → 不重算（保留原 l0）');

section('D. settle 日结生成 summary');
const storeS = { version: 2, facts, decayDay: memory.localDayIndex() - 1, firstAt: Date.now() - 86400000, stats: {} };
const rs = memory.settle(storeS, Date.now(), { forgetEnabled: false });
ok(rs.store.summary && rs.store.summary.l0, 'settle → 生成 summary');
eq(rs.store.summary.at, memory.localDayIndex(), 'settle summary.at = 当日');

section('E. 负对照：空事实池');
const sEmpty = memory.buildSummary([]);
eq(sEmpty.l0, '', '空池 L0 为空');
eq(sEmpty.l1.length, 0, '空池 L1 为空');
const storeEmpty = { summary: { l0: '', l1: [], at: memory.localDayIndex() }, facts: [] };
const lineEmpty = memory.formatMemoryLayered([], storeEmpty, 400);
eq(lineEmpty, '', '空事实 + 空摘要 → 空行');

console.log('\n========================');
console.log('W56 结果: ' + pass + ' passed, ' + fail + ' failed');
if (fails.length) { console.log('--- 失败项 ---'); fails.forEach((f) => console.log('  ' + f)); }
process.exit(fail ? 1 : 0);
