'use strict';

/* W49 回归：已取代证据维度（Mnemosyne §21.3）
 *
 * 核心行为：
 *   - 同槽位换值（喜欢猫→喜欢狗）→ 旧事实 superseded 留档（正文/时间保留），
 *     新事实落位，返回 superseded:1；
 *   - expand（包含关系）不触发取代，行为与旧版一致；
 *   - 用户改回旧值 → 按 id 复活留档，不存两份同 id；
 *   - superseded 不进 recall / settle / 容量淘汰；listFacts(includeSuperseded) 可查；
 *   - 开关关（getSupersede()=false）→ 回退旧合并行为（负对照）。
 *
 * 规矩 28：负对照必须真红。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const memory = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(name + ' :: ' + String(err && err.message || err));
    console.log('  ✗', name, '->', err && err.message);
  }
}

let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w49-'));
let storePath = path.join(tmpDir, 'memory-facts.json');
memory.configureMemory({
  getPath: () => storePath,
  getForgetEnabled: () => false,
  getQuietSpec: () => '',
  getQuietPenalty: () => true,
  getSupersede: () => true
});
memory._resetCache();

const T0 = Date.parse('2026-10-31T10:00:00+08:00');

console.log('== W49 已取代证据维度 ==');

/* ---------- [A] 纯函数：factRelation ---------- */
console.log('[A] factRelation 纯函数');
check('A1 相同文本 → expand', () => {
  assert.strictEqual(memory.factRelation('主人喜欢猫', '主人喜欢猫'), 'expand');
});
check('A2 包含关系 → expand', () => {
  assert.strictEqual(memory.factRelation('主人喜欢猫', '主人喜欢猫，尤其是布偶'), 'expand');
});
check('A3 同义改写 → expand（不误伤）', () => {
  assert.strictEqual(memory.factRelation('主人喜欢猫', '主人非常喜欢猫咪'), 'expand');
});
check('A4 偏好槽位换值 → replace', () => {
  assert.strictEqual(memory.factRelation('主人喜欢猫', '主人喜欢狗'), 'replace');
});
check('A5 不喜欢换值 → replace', () => {
  assert.strictEqual(memory.factRelation('主人不喜欢吃辣', '主人不喜欢吃甜'), 'replace');
});
check('A6 断言句尾端换值 → replace', () => {
  assert.strictEqual(memory.factRelation('主人在A公司上班', '主人在B公司上班'), 'replace');
});
check('A7 判不出 → expand（保守）', () => {
  assert.strictEqual(memory.factRelation('主人住在北京', '主人下个月搬家'), 'expand');
});

/* ---------- [B] upsert：replace 主路径 ---------- */
console.log('[B] upsertFacts replace');
{
  const r1 = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }],
    { now: T0, maxFacts: 60 }
  );
  check('B1 首次写入 added=1', () => assert.strictEqual(r1.added, 1));
  check('B2 首次写入 superseded=0', () => assert.strictEqual(r1.superseded, 0));

  const r2 = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }],
    { now: T0 + 86400000, maxFacts: 60 }
  );
  check('B3 换值后 added=1（新事实落位）', () => assert.strictEqual(r2.added, 1));
  check('B4 换值后 superseded=1（旧事实留档）', () => assert.strictEqual(r2.superseded, 1));

  const facts = r2.store.facts;
  check('B5 留档事实带 superseded 标记', () => {
    const old = facts.find((f) => f.superseded === true);
    assert.ok(old, '没有 superseded 条目');
    assert.strictEqual(old.text, '主人喜欢猫');
  });
  check('B6 留档保留正文与时间', () => {
    const old = facts.find((f) => f.superseded === true);
    assert.strictEqual(old.text, '主人喜欢猫');
    assert.strictEqual(old.at, T0);
  });
  check('B7 留档记录 supersededBy 指向新 id', () => {
    const old = facts.find((f) => f.superseded === true);
    const live = facts.find((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(old.supersededBy, live.id);
  });
  check('B8 新事实是活档且文案为新值', () => {
    const live = facts.find((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live.text, '主人喜欢狗');
  });
  check('B9 两者 id 不同（留档不顶替新档）', () => {
    const old = facts.find((f) => f.superseded === true);
    const live = facts.find((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.notStrictEqual(old.id, live.id);
  });
}

/* ---------- [C] 用户改回旧值 → 复活留档 ---------- */
console.log('[C] 改回旧值复活');
{
  memory._resetCache();
  const r = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }],
    { now: T0 + 2 * 86400000, maxFacts: 60 }
  );
  check('C1 改回旧值 added=0（复活留档）', () => assert.strictEqual(r.added, 0));
  check('C2 改回旧值 superseded=1（狗被换回旧值退场）', () => assert.strictEqual(r.superseded, 1));
  check('C3 复活后无重复 id 的两个活档', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live.length, 1);
  });
  check('C4 复活后活档为猫（当前值）', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live[0].text, '主人喜欢猫');
  });
  check('C5 复活清掉 superseded 标记', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live[0].superseded, undefined);
    assert.strictEqual(live[0].supersededBy, undefined);
  });
  check('C6 复活后留档仍在（狗可追溯到猫）', () => {
    const old = r.store.facts.find((f) => memory.isSuperseded(f));
    assert.ok(old, '留档消失');
    assert.strictEqual(old.text, '主人喜欢狗');
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(old.supersededBy, live[0].id);
  });
}

/* ---------- [D] expand 不触发取代（行为同旧版） ---------- */
console.log('[D] expand 不取代');
{
  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const r = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢猫，尤其是布偶', source: 'heuristic' }],
    { now: T0 + 86400000, maxFacts: 60 }
  );
  check('D1 expand updated=1 且无取代', () => {
    assert.strictEqual(r.updated, 1);
    assert.strictEqual(r.superseded, 0);
  });
  check('D2 expand 后活档只剩一条', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live.length, 1);
  });
  check('D3 expand 文案被更长的替换', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live[0].text, '主人喜欢猫，尤其是布偶');
  });
}

/* ---------- [E] 留档不参与召回 / settle / 淘汰 ---------- */
console.log('[E] 留档隔离');
{
  /* B–D 段共用同一 storePath，残留留档会污染本段状态 → 清空重开。 */
  try { fs.rmSync(storePath, { force: true }); } catch { /* ignore */ }
  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }], { now: T0 + 86400000, maxFacts: 60 });

  const recalled = memory.recall('主人喜欢什么动物', { forceExpand: true });
  check('E1 recall 不含留档', () => {
    assert.ok(!recalled.some((f) => f.superseded === true));
  });
  check('E2 recall 含活档狗', () => {
    assert.ok(recalled.some((f) => f.text === '主人喜欢狗'));
  });
  check('E3 recall 文案只出现新值', () => {
    assert.ok(!recalled.some((f) => f.text === '主人喜欢猫'));
  });

  const settled = memory.settle(memory.loadStore(), T0 + 40 * 86400000, { forgetEnabled: true });
  check('E4 settle 不动留档标记', () => {
    const old = settled.store.facts.find((f) => f.superseded === true);
    assert.ok(old, '留档丢失');
    assert.strictEqual(old.text, '主人喜欢猫');
  });
  check('E5 settle 留档不计数 forgotten/dropped', () => {
    const live = settled.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    const tombs = settled.store.facts.filter(memory.isTombstone);
    assert.strictEqual(settled.forgotten, 0);
    assert.ok(settled.store.facts.some((f) => f.superseded === true));
    assert.ok(live.length >= 1);
    assert.strictEqual(tombs.length, 0);
  });

  memory._resetCache();
  const shown = memory.listFacts();
  check('E6 listFacts 默认不含留档', () => {
    assert.ok(!shown.some((f) => f.superseded === true));
  });
  const shownAll = memory.listFacts({ includeSuperseded: true });
  check('E7 listFacts includeSuperseded 可查留档', () => {
    assert.ok(shownAll.some((f) => f.superseded === true));
  });

  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0 + 50 * 86400000, maxFacts: 2 });
  check('E8 留档占容量但活档照常淘汰', () => {
    const store = memory.loadStore();
    const live = store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.ok(live.length <= 2, '活档超过容量');
    assert.ok(store.facts.some((f) => f.superseded === true), '留档被清掉');
  });
}

/* ---------- [F] 负对照：开关关 → 回退旧合并行为 ---------- */
console.log('[F] 负对照（必须真红）');
{
  memory.configureMemory({
    getPath: () => storePath,
    getForgetEnabled: () => false,
    getQuietSpec: () => '',
    getQuietPenalty: () => true,
    getSupersede: () => false
  });
  /* 独立场景：清空前面段落的残留状态。 */
  try { fs.rmSync(storePath, { force: true }); } catch { /* ignore */ }
  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const r = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }],
    { now: T0 + 86400000, maxFacts: 60 }
  );
  check('F1 开关关 → 不取代（updated=1）', () => {
    assert.strictEqual(r.updated, 1, '开关关后仍发生取代');
    assert.strictEqual(r.superseded, 0);
  });
  check('F2 开关关 → 活档只剩一条（旧合并行为：同长不替换文案）', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].text, '主人喜欢猫');
  });
  check('F3 开关关 → 无留档', () => {
    assert.ok(!r.store.facts.some((f) => f.superseded === true));
  });
  /* 复位开关（后续清理用） */
  memory.configureMemory({
    getPath: () => storePath,
    getForgetEnabled: () => false,
    getQuietSpec: () => '',
    getQuietPenalty: () => true,
    getSupersede: () => true
  });
  memory._resetCache();
}

/* ---------- [G] 与 W2 夜间降权不冲突 ---------- */
console.log('[G] 与 W2 联动');
{
  /* 独立场景：清空前面段落的残留状态。 */
  try { fs.rmSync(storePath, { force: true }); } catch { /* ignore */ }
  memory._resetCache();
  memory.upsertFacts([{ kind: 'pref', text: '主人喜欢猫', source: 'heuristic' }], { now: T0, maxFacts: 60 });
  const r = memory.upsertFacts(
    [{ kind: 'pref', text: '主人喜欢狗', source: 'heuristic' }],
    { now: T0 + 86400000, maxFacts: 60 }
  );
  check('G1 取代后新档不残留旧档标记', () => {
    const live = r.store.facts.filter((f) => !memory.isTombstone(f) && !memory.isSuperseded(f));
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].superseded, undefined);
  });
}

/* ---------- 清理 ---------- */
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败'));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  console.log('失败清单：');
  for (const f of failures) console.log('  -', f);
}
process.exit(fail === 0 ? 0 : 1);
