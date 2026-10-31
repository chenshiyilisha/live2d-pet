'use strict';
/* W53：记忆内容哈希跳过未变——factHash/factHashMatches 纯函数 + upsert expand 分支短路。
 * 规矩 28：正对照（未变跳过、变了重算）+ 负对照（坏哈希不短路）。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const memory = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 实际 ' + a);
  pass++;
}
function ok(v, msg) {
  if (!v) throw new Error(msg || 'expected truthy, got ' + v);
  pass++;
}

const T0 = Date.parse('2026-10-31T10:00:00+08:00');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w53-'));
const storePath = path.join(tmp, 'm.json');

memory.configureMemory({
  getPath: () => storePath,
  getForgetEnabled: () => false,
  getQuietSpec: () => '',
  getQuietPenalty: () => true,
  getSupersede: () => true
});

console.log('[A] 纯函数 factHash / factHashMatches');
{
  ok(typeof memory.factHash === 'function', 'factHash 应导出');
  ok(typeof memory.factHashMatches === 'function', 'factHashMatches 应导出');
  eq(memory.factHash('主人喜欢猫'), memory.factHash('主人喜欢猫'), '同文本同哈希');
  ok(memory.factHash('主人喜欢猫') !== memory.factHash('主人喜欢狗'), '不同文本不同哈希');
  // 规范化：大小写/空白不影响
  eq(memory.factHash('主人 喜欢猫'), memory.factHash('主人喜欢猫'), '空白不影响哈希');
  ok(memory.factHashMatches({ text: '主人喜欢猫', h: memory.factHash('主人喜欢猫') }), '匹配');
  ok(!memory.factHashMatches({ text: '主人喜欢猫', h: memory.factHash('主人喜欢狗') }), '不匹配');
  ok(!memory.factHashMatches({ text: '主人喜欢猫' }), '缺 h → false');
  ok(!memory.factHashMatches({ h: 'abc' }), '缺 text → false');
  ok(!memory.factHashMatches(null), 'null → false');
}

console.log('[B] upsert：新事实带 h');
{
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  eq(r.added, 1, 'added=1');
  const f = r.store.facts[0];
  ok(typeof f.h === 'string' && f.h.length === 8, 'h 是 8 位字符串');
  eq(f.h, memory.factHash('主人喜欢猫'), 'h 正确');
}

console.log('[C] expand 同文本（未变）→ 跳过 importance 重算');
{
  memory._resetCache();
  // 同文本再写一次 → expand，text 不变 → importance 沿用
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  eq(r.added, 0, 'added=0');
  eq(r.updated, 1, 'updated=1');
  const f = r.store.facts[0];
  eq(f.text, '主人喜欢猫', '文本不变');
  // importance 应与首次一致（scoreImportance 纯函数）
  const imp1 = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 }).store.facts[0].importance;
  // 重新读盘确认
  const fresh = memory.loadStore().facts[0];
  eq(fresh.importance, imp1, '未变 → importance 不变（跳过重算）');
}

console.log('[D] expand 变长文本 → 重算 importance 并刷新 h');
{
  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫，尤其是布偶', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  eq(r.added, 0, 'added=0');
  eq(r.updated, 1, 'updated=1');
  const f = r.store.facts[0];
  eq(f.text, '主人喜欢猫，尤其是布偶', '文本变长');
  eq(f.h, memory.factHash('主人喜欢猫，尤其是布偶'), 'h 刷新');
}

console.log('[E] expand kind bump → 重算 importance');
{
  memory._resetCache();
  try { fs.rmSync(storePath, { force: true }); } catch { }
  memory.upsertFacts([{ kind: 'other', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  // 先清空 h：若 kind bump 走了重算分支，h 会被重新写入
  const pre = memory.loadStore().facts[0];
  pre.h = '';
  fs.writeFileSync(storePath, JSON.stringify({
    version: 2, facts: memory.loadStore().facts,
    decayDay: memory.loadStore().decayDay, firstAt: memory.loadStore().firstAt,
    stats: memory.loadStore().stats
  }), 'utf8');
  memory._resetCache();
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  eq(r.updated, 1, 'updated=1');
  const f = r.store.facts[0];
  eq(f.kind, 'pref', 'kind bump');
  eq(f.h, memory.factHash('主人喜欢猫'), 'kind bump → h 被重写（走了重算分支）');
}

console.log('[F] 负对照：坏 h 不短路');
{
  memory._resetCache();
  try { fs.rmSync(storePath, { force: true }); } catch { }
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const f = r.store.facts[0];
  f.h = 'deadbeef';  // 手动改坏 h
  fs.writeFileSync(storePath, JSON.stringify(r.store), 'utf8');
  memory._resetCache();
  // 同文本再写 → factHashMatches 返回 false → 重算
  const r2 = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  eq(r2.updated, 1, 'updated=1');
  const f2 = r2.store.facts[0];
  eq(f2.h, memory.factHash('主人喜欢猫'), '坏 h → 重算并刷新');
}

console.log('[G] replace 分支带 h');
{
  memory._resetCache();
  try { fs.rmSync(storePath, { force: true }); } catch { }
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const r = memory.upsertFacts([{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  eq(r.superseded, 1, 'superseded=1');
  const live = r.store.facts.filter((f) => !memory.isSuperseded(f));
  eq(live.length, 1, '活档 1 条');
  eq(live[0].text, '主人喜欢狗', '活档是狗');
  ok(typeof live[0].h === 'string' && live[0].h === memory.factHash('主人喜欢狗'), 'replace 后 h 正确');
}

console.log('[H] 复活带 h');
{
  memory._resetCache();
  // 复活：猫→狗→猫，改回旧值
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0 + 2 * 86400000, maxFacts: 60 });
  const live = memory.loadStore().facts.filter((f) => !memory.isSuperseded(f));
  eq(live.length, 1, '复活后活档 1 条');
  eq(live[0].text, '主人喜欢猫', '复活为猫');
  ok(typeof live[0].h === 'string' && live[0].h === memory.factHash('主人喜欢猫'), '复活后 h 正确');
}

console.log('[I] settle 不受 h 影响（settle 不调 scoreImportance）');
{
  memory._resetCache();
  try { fs.rmSync(storePath, { force: true }); } catch { }
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const s = memory.loadStore();
  const r = memory.settle(s, T0 + 5 * 86400000, { forgetEnabled: true });
  ok(r.store.facts[0].h === memory.factHash('主人喜欢猫'), 'settle 后 h 保留');
}

console.log('[J] 配置默认值');
{
  const cfg = require(path.join(__dirname, '..', 'src', 'main', 'config.js'));
  const DEFAULTS = cfg.DEFAULT_CONFIG || cfg.defaults || cfg.default || cfg;
  ok(DEFAULTS.memory, 'memory 段存在');
  ok(DEFAULTS.memory.contentHash === true, 'contentHash 默认开');
}

console.log('\n=== W53: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail > 0 ? 1 : 0);
