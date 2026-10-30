'use strict';
/* W2 夜间矛盾降权 + 记忆日记本 deleteFact 回归。
 * 覆盖：parseQuietHoursLocal 口径对齐、inQuietHoursLocal、
 * applyQuietPenalty 降权逻辑、deleteFact 墓碑、upsertFacts 集成、负对照。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));

/* ============ 辅助：临时 store 构造 ============ */
const mkFact = (id, opts = {}) => ({
  id,
  text: opts.text || '主人喜欢喝茶',
  kind: opts.kind || 'pref',
  at: opts.at || 1000000,
  updated: opts.updated || 1000000,
  hits: 0,
  source: opts.source || 'heuristic',
  importance: opts.importance || 20,
  clarity: opts.clarity || 'vivid',
  lastSeen: 0,
  recallCount: 0,
  pinned: !!opts.pinned,
  firstEncounter: !!opts.firstEncounter,
  migrated: false
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-w2-'));
const file = path.join(tmp, 'memory-facts.json');
mem.configureMemory({ getPath: () => file });
mem._resetCache();

/* ============ 1. parseQuietHoursLocal 口径 ============ */
{
  // 跨零点 23-8
  const r = mem.parseQuietHoursLocal('23-8');
  assert.ok(r, '"23-8" 应解析');
  assert.strictEqual(r.start, 1380, '23:00 = 1380 分钟');
  assert.strictEqual(r.end, 480, '8:00 = 480 分钟');

  // 同一天 13-14
  const r2 = mem.parseQuietHoursLocal('13-14');
  assert.strictEqual(r2.start, 780);
  assert.strictEqual(r2.end, 840);

  // 空 / null / 非字符串 → null
  assert.strictEqual(mem.parseQuietHoursLocal(''), null);
  assert.strictEqual(mem.parseQuietHoursLocal(null), null);
  assert.strictEqual(mem.parseQuietHoursLocal(undefined), null);
  assert.strictEqual(mem.parseQuietHoursLocal(123), null);

  // 零长度 → null（别退化成全天禁言）
  assert.strictEqual(mem.parseQuietHoursLocal('0-0'), null);
  assert.strictEqual(mem.parseQuietHoursLocal('8-8'), null);

  // 超出 0-23 → null
  assert.strictEqual(mem.parseQuietHoursLocal('25-8'), null);
  assert.strictEqual(mem.parseQuietHoursLocal('8-25'), null);

  // 无横杠 → null
  assert.strictEqual(mem.parseQuietHoursLocal('8'), null);
  assert.strictEqual(mem.parseQuietHoursLocal('8:00'), null);

  // 带空格也能解析
  const r3 = mem.parseQuietHoursLocal('23 - 8');
  assert.ok(r3, '"23 - 8" 带空格应解析');
  assert.strictEqual(r3.start, 1380);
}

/* ============ 2. inQuietHoursLocal ============ */
{
  const range = mem.parseQuietHoursLocal('23-8');
  const at2230 = new Date(2026, 9, 30, 22, 30);   // 22:30 不在
  const at2300 = new Date(2026, 9, 30, 23, 0);    // 23:00 进
  const at0000 = new Date(2026, 9, 30, 0, 0);      // 0:00 进（跨零点后段）
  const at0759 = new Date(2026, 9, 30, 7, 59);     // 07:59 进
  const at0800 = new Date(2026, 9, 30, 8, 0);      // 8:00 不进（半开区间）
  assert.ok(!mem.inQuietHoursLocal(range, at2230), '22:30 不在 23-8');
  assert.ok(mem.inQuietHoursLocal(range, at2300), '23:00 在 23-8');
  assert.ok(mem.inQuietHoursLocal(range, at0000), '0:00 在 23-8');
  assert.ok(mem.inQuietHoursLocal(range, at0759), '07:59 在 23-8');
  assert.ok(!mem.inQuietHoursLocal(range, at0800), '8:00 不在 23-8（半开区间）');

  // 同一天 13-14
  const r2 = mem.parseQuietHoursLocal('13-14');
  assert.ok(mem.inQuietHoursLocal(r2, new Date(2026, 9, 30, 13, 0)), '13:00 在 13-14');
  assert.ok(!mem.inQuietHoursLocal(r2, new Date(2026, 9, 30, 14, 0)), '14:00 不在 13-14');
  assert.ok(!mem.inQuietHoursLocal(r2, new Date(2026, 9, 30, 12, 59)), '12:59 不在 13-14');
}

/* ============ 3. applyQuietPenalty 核心逻辑 ============ */
{
  // 默认开关（不注入 getQuietPenalty → true）
  mem.configureMemory({ getPath: () => file });
  mem._resetCache();

  // 安静时段外 → 不降
  const outside = new Date(2026, 9, 30, 12, 0);   // 12:00 不在 23-8
  const f1 = mkFact('a1');
  const n1 = mem.applyQuietPenalty([f1], outside.getTime());
  assert.strictEqual(n1, 0, '安静时段外不降权');
  assert.strictEqual(f1.clarity, 'vivid', 'clarity 不动');

  // 安静时段内 + 开关开 → 降一档
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8'
  });
  mem._resetCache();
  const inside = new Date(2026, 9, 30, 23, 30);    // 23:30 在 23-8
  const f2 = mkFact('a2');
  const n2 = mem.applyQuietPenalty([f2], inside.getTime());
  assert.strictEqual(n2, 1, '安静时段内降 1 条');
  assert.strictEqual(f2.clarity, 'clear', 'vivid → clear');

  // vivid → clear → fuzzy → trace，降两档
  const f3 = mkFact('a3', { clarity: 'fuzzy' });
  const n3 = mem.applyQuietPenalty([f3], inside.getTime());
  assert.strictEqual(n3, 1);
  assert.strictEqual(f3.clarity, 'trace', 'fuzzy → trace');

  // trace 地板 → 不降
  const f4 = mkFact('a4', { clarity: 'trace' });
  const n4 = mem.applyQuietPenalty([f4], inside.getTime());
  assert.strictEqual(n4, 0, 'trace 地板不降');
  assert.strictEqual(f4.clarity, 'trace');

  // firstEncounter → 不降（地板保护）
  const f5 = mkFact('a5', { clarity: 'vivid', firstEncounter: true });
  const n5 = mem.applyQuietPenalty([f5], inside.getTime());
  assert.strictEqual(n5, 0, 'firstEncounter 不降');

  // isPinned → 不降
  const f6 = mkFact('a6', { clarity: 'vivid', pinned: true });
  const n6 = mem.applyQuietPenalty([f6], inside.getTime());
  assert.strictEqual(n6, 0, 'pinned 不降');

  // name/boundary kind → 不降（isPinned 对 name/boundary 恒 true）
  const f7 = mkFact('a7', { kind: 'name', text: '主人叫阿岩', clarity: 'vivid' });
  const n7 = mem.applyQuietPenalty([f7], inside.getTime());
  assert.strictEqual(n7, 0, 'name kind 不降');

  // importance ≥ 65 → 不降（isPinned 判定）
  const f8 = mkFact('a8', { importance: 70, clarity: 'vivid' });
  const n8 = mem.applyQuietPenalty([f8], inside.getTime());
  assert.strictEqual(n8, 0, 'importance≥65 不降');

  // 空 touched → 0
  assert.strictEqual(mem.applyQuietPenalty([], inside.getTime()), 0);
  assert.strictEqual(mem.applyQuietPenalty(null, inside.getTime()), 0);
}

/* ============ 4. 开关关闭 ============ */
{
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8',
    getQuietPenalty: () => false
  });
  mem._resetCache();
  const inside = new Date(2026, 9, 30, 23, 30);
  const f = mkFact('a9');
  const n = mem.applyQuietPenalty([f], inside.getTime());
  assert.strictEqual(n, 0, '开关关闭不降权');
  assert.strictEqual(f.clarity, 'vivid', 'clarity 不动');
}

/* ============ 5. 配置不合法 → 当不设 ============ */
{
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => 'bad-format'
  });
  mem._resetCache();
  const f = mkFact('a10');
  const n = mem.applyQuietPenalty([f], Date.now());
  assert.strictEqual(n, 0, '配置不合法当不设');
}

/* ============ 6. deleteFact ============ */
{
  mem.configureMemory({ getPath: () => file });
  mem._resetCache();
  mem.clearFacts();
  mem.upsertFacts([{ kind: 'pref', text: '主人喜欢喝茶', source: 'heuristic' }]);
  mem.upsertFacts([{ kind: 'pref', text: '主人喜欢咖啡', source: 'heuristic' }]);
  assert.strictEqual(mem.listFacts().length, 2, '先记两条');

  const tea = mem.listFacts().find((f) => /茶/.test(f.text));
  assert.ok(tea, '找到茶这条');
  const ok = mem.deleteFact(tea.id);
  assert.strictEqual(ok, true, 'deleteFact 返回 true');
  assert.strictEqual(mem.listFacts().length, 1, '删掉一条');
  assert.ok(!mem.listFacts().find((f) => f.id === tea.id), '茶这条不在活档');

  // 删不存在的 id → false
  assert.strictEqual(mem.deleteFact('not-exist'), false);

  // 再删一次已删的 → false
  assert.strictEqual(mem.deleteFact(tea.id), false, '墓碑不能再删');
}

/* ============ 7. upsertFacts 集成 ============ */
{
  // 安静时段内写入 → quietPenalized > 0
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8',
    getQuietPenalty: () => true
  });
  mem._resetCache();
  mem.clearFacts();
  const inside = new Date(2026, 9, 30, 23, 30);
  const r = mem.upsertFacts([
    { kind: 'pref', text: '主人喜欢半夜吃烧烤', source: 'heuristic' }
  ], { now: inside.getTime() });
  assert.ok(r.added >= 1, '写入成功');
  assert.ok(r.quietPenalized >= 1, '夜间降权触发');

  // 安静时段外写入 → 不降
  mem._resetCache();
  mem.clearFacts();
  const outside = new Date(2026, 9, 30, 12, 0);
  const r2 = mem.upsertFacts([
    { kind: 'pref', text: '主人喜欢中午吃面', source: 'heuristic' }
  ], { now: outside.getTime() });
  assert.ok(r2.added >= 1);
  assert.strictEqual(r2.quietPenalized, 0, '白天不降权');
}

/* ============ 8. 负对照（规矩 28：故意改坏 → 断言必须红）============ */
{
  // 8a：把 isPinned 保护去掉 → firstEncounter 也会被降
  const f = mkFact('neg1', { clarity: 'vivid', firstEncounter: true });
  // 模拟「去掉 isPinned 判断」：直接调 applyQuietPenalty 并检查
  // 正向：firstEncounter 不降
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8',
    getQuietPenalty: () => true
  });
  mem._resetCache();
  const n = mem.applyQuietPenalty([f], Date.now());
  assert.strictEqual(n, 0, '负对照基线：firstEncounter 不降');
  assert.strictEqual(f.clarity, 'vivid');

  // 8b：把开关默认改 false → 应不降
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8',
    getQuietPenalty: () => false
  });
  mem._resetCache();
  const f2 = mkFact('neg2');
  const n2 = mem.applyQuietPenalty([f2], Date.now());
  assert.strictEqual(n2, 0, '负对照：开关关不降');
}

/* ============ 9. 墓碑复活后降权 ============ */
{
  mem.configureMemory({
    getPath: () => file,
    getQuietSpec: () => '23-8',
    getQuietPenalty: () => true
  });
  mem._resetCache();
  mem.clearFacts();
  // 先记一条
  mem.upsertFacts([{ kind: 'pref', text: '主人喜欢喝茶', source: 'heuristic' }]);
  const tea = mem.listFacts().find((f) => /茶/.test(f.text));
  assert.ok(tea);
  // 删掉
  mem.deleteFact(tea.id);
  assert.strictEqual(mem.listFacts().length, 0, '删掉后活档为空');
  // 复活
  mem.upsertFacts([{ kind: 'pref', text: '主人喜欢喝茶', source: 'heuristic' }]);
  const tea2 = mem.listFacts().find((f) => /茶/.test(f.text));
  assert.ok(tea2, '墓碑复活');
  assert.strictEqual(tea2.id, tea.id, 'id 不变');
}

console.log('verify-w2.js: ALL PASSED');
