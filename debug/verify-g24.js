'use strict';
/* G24：加强对话→事实沉淀（启发式扩充 + 「不乱记」闸门）的验收脚本。
 *
 * 背景：用户要把「短期记忆改成长期记忆」，按 §25 开源调研最优机制落地
 * （Mem0 抽取形态 + KokoroMemo「不乱记」闸门）。
 *
 * 改动：
 *   1. HEURISTICS 扩充 4 条模板（零 token，覆盖更多偏好/边界表达）；
 *   2. SKIP_MARKERS 扩充（否认/反悔/假设/口头禅/自我否定不进长期记忆）。
 *
 * 验证：
 *   A. 新启发式能抽到对应事实；
 *   B. 「不乱记」闸门能拒掉玩笑/假设/否认；
 *   C. 既有启发式不受影响（回归）；
 *   D. 负对照：SKIP_MARKERS 命中时 extractHeuristic 返回空。
 *
 * 用法：node debug/verify-g24.js
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

/* ══════ 先把 memory.js 跑起来（不需要 electron）══════ */
const mem = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-g24-'));
const file = path.join(tmp, 'memory-facts.json');
mem.configureMemory({ getPath: () => file });
mem._resetCache();

/* ══════ A. 新启发式能抽到对应事实 ══════ */
console.log('\n[A] 新启发式');
{
  const a = mem.extractHeuristic('我不吃香菜');
  check(a.some((f) => f.kind === 'pref' && /香菜/.test(f.text)), '不吃X → pref');

  const b = mem.extractHeuristic('我对花生过敏');
  check(b.some((f) => f.kind === 'pref' && /花生过敏/.test(f.text)), '对X过敏 → pref');

  const c = mem.extractHeuristic('我讨厌噪音');
  check(c.some((f) => f.kind === 'pref' && /噪音/.test(f.text)), '讨厌X → pref');

  const d = mem.extractHeuristic('别在我面前提蟑螂');
  check(d.some((f) => f.kind === 'boundary' && /蟑螂/.test(f.text)), '别在我面前提X → boundary');
}

/* ══════ B. 「不乱记」闸门能拒掉玩笑/假设/否认 ══════ */
console.log('\n[B] 不乱记闸门');
{
  eq(mem.extractHeuristic('开玩笑的，我喜欢榴莲').length, 0, '开玩笑 → 拒');
  eq(mem.extractHeuristic('说着玩的，我叫阿岩').length, 0, '说着玩 → 拒');
  eq(mem.extractHeuristic('可能吧，我喜欢喝茶').length, 0, '可能吧 → 拒');
  eq(mem.extractHeuristic('也许吧，我讨厌香菜').length, 0, '也许吧 → 拒');
  eq(mem.extractHeuristic('不是真的，我叫阿岩').length, 0, '不是真的 → 拒');
  eq(mem.extractHeuristic('当我没说').length, 0, '当我没说 → 拒');
  eq(mem.extractHeuristic('随便说说，我喜欢猫').length, 0, '随便说说 → 拒');
}

/* ══════ C. 既有启发式不受影响（回归）══════ */
console.log('\n[C] 既有启发式回归');
{
  const a = mem.extractHeuristic('我叫阿岩，请多关照');
  check(a.some((f) => f.kind === 'name' && /阿岩/.test(f.text)), '我叫X → name');

  const b = mem.extractHeuristic('我喜欢喝茶');
  check(b.some((f) => f.kind === 'pref' && /茶/.test(f.text)), '喜欢X → pref');

  const c = mem.extractHeuristic('别叫我老板');
  check(c.some((f) => f.kind === 'boundary'), '别叫我 → boundary');

  const d = mem.extractHeuristic('请记住明天要开会');
  check(d.some((f) => f.kind === 'other' && /明天要开会/.test(f.text)), '请记住X → other');
}

/* ══════ D. 负对照：SKIP_MARKERS 命中时返回空 ══════ */
console.log('\n[D] 负对照');
{
  /* 即便句子里有能抽的事实，SKIP_MARKERS 命中也要全拒 */
  eq(mem.extractHeuristic('开玩笑的，我不吃香菜').length, 0, '玩笑+事实 → 全拒');
  eq(mem.extractHeuristic('说着玩的，我对花生过敏').length, 0, '说着玩+事实 → 全拒');
  eq(mem.extractHeuristic('可能吧，我讨厌噪音').length, 0, '可能吧+事实 → 全拒');
  eq(mem.extractHeuristic('不是真的，别在我面前提蟑螂').length, 0, '否认+事实 → 全拒');
}

/* ══════ E. 落盘 + 召回（端到端）══════ */
console.log('\n[E] 落盘 + 召回');
{
  mem.clearFacts();
  const r = mem.upsertFacts([
    { kind: 'pref', text: '主人不喜欢香菜', source: 'heuristic' },
    { kind: 'pref', text: '主人对花生过敏', source: 'heuristic' }
  ]);
  eq(r.added, 2, '落盘 2 条');
  eq(mem.listFacts().length, 2, 'listFacts 返回 2 条');

  /* 召回：关键词重叠 */
  const recalled = mem.recall('香菜', {});
  check(recalled.some((f) => /香菜/.test(f.text)), '召回香菜');

  /* 去重：同义再写不新增 */
  const r2 = mem.upsertFacts([{ kind: 'pref', text: '主人不喜欢香菜', source: 'heuristic' }]);
  eq(r2.added, 0, '同义不新增');
  eq(mem.listFacts().length, 2, 'listFacts 仍 2 条');
}

/* ══════ 汇总 ══════ */
console.log(`\n──────────────────────────────────────────`);
console.log(`结果：${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
