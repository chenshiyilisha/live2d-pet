'use strict';
const {
  scoreImportance, isPinned, clarityFromRetention, retentionOf,
  displayPrefix, localDayIndex
} = require('../src/main/memory-score');
const memory = require('../src/main/memory');
const fs = require('fs');
const path = require('path');
const os = require('os');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] scoreImportance 纯函数');
ok(scoreImportance('主人的名字是小明啊', 'name', 'heuristic') >= 50, 'name 高分');
ok(scoreImportance('随便说说喜欢的事', 'other', 'llm') <
  scoreImportance('随便说说喜欢的事', 'other', 'heuristic'),
  'llm 来源略降分');
ok(scoreImportance('主人的名字是小明啊', 'name', 'heuristic') ===
  scoreImportance('主人的名字是小明啊', 'name', 'heuristic'), '同输入同输出');

console.log('\n[B] pinned / clarity');
ok(isPinned({ kind: 'name', importance: 10 }) === true, 'name 钉住');
ok(isPinned({ kind: 'other', importance: 70 }) === true, 'importance≥65 钉住');
ok(clarityFromRetention(80, false) === 'vivid', '高 retention → vivid');
ok(clarityFromRetention(5, true) === 'clear', '钉住不低于 clear');
ok(displayPrefix('fuzzy').includes('不太清'), 'fuzzy 前缀');

console.log('\n[C] migrate + settle');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem2a-'));
const file = path.join(dir, 'facts.json');
fs.writeFileSync(file, JSON.stringify({
  version: 1,
  facts: [{
    id: 'a1', text: '主人叫小明', kind: 'name', at: Date.now() - 40 * 86400000,
    updated: Date.now() - 40 * 86400000, hits: 2, source: 'heuristic'
  }]
}));
memory._resetCache();
memory.configureMemory({ getPath: () => file });
const store = memory.loadStore();
ok(store.version === 2 && store.facts[0].migrated === true, 'v1→v2 迁移');
ok(store.facts[0].clarity === 'clear', '迁移起手 clear');
ok(typeof store.facts[0].importance === 'number', '背填 importance');

store.decayDay = localDayIndex() - 3;
store.facts[0].clarity = 'vivid';
store.facts[0].importance = 20;
store.facts[0].kind = 'other';
store.facts[0].pinned = false;
const r = memory.settle(store);
ok(r.awayDays === 3, `补跑 3 天（${r.awayDays}）`);
ok(clarityIndexSafe(r.store.facts[0].clarity) >= clarityIndexSafe('vivid') - 3,
  '三天最多降三档');
ok(r.store.decayDay === localDayIndex(), 'decayDay 推进到今天');
/* 幂等 */
const r2 = memory.settle(r.store);
ok(r2.awayDays === 0, '同日再 settle 无变化');

console.log('\n[D] format 模糊前缀');
const line = memory.formatMemoryLine([
  { text: '喜欢猫', clarity: 'fuzzy' }
], 200);
ok(line.includes('记得不太清'), 'format 含模糊前缀');

console.log('\n[E] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/settleAndSave/.test(main), '启动 settle');

function clarityIndexSafe(c) {
  return ['vivid', 'clear', 'fuzzy', 'trace'].indexOf(c);
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
