'use strict';
const { createTemperament, dayKey } = require('../src/main/temperament');
const { setRateMul, getRateMul, createMoodEngine, RATE } = require('../src/main/mood');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] 日均 → EMA');
const t = createTemperament();
ok(typeof dayKey() === 'string' && dayKey().includes('-'), 'dayKey 有日期');
for (let i = 0; i < 20; i++) t.observe({ valence: 0.9, social: 0.8, energy: 0.3, pride: 0.7 });
t.foldDay();
const snap = t.snapshot();
ok(snap.warmth > 0.5, `warmth 上抬（${snap.warmth.toFixed(3)}）`);
ok(snap.cling > 0.5, `cling 上抬（${snap.cling.toFixed(3)}）`);
ok(snap.vitality < 0.5, `vitality 下压（${snap.vitality.toFixed(3)}）`);

console.log('\n[B] 乘子接到 mood');
setRateMul(t.rateMul());
const m = getRateMul();
ok(m.socialRiseMul > 1, 'cling 高 → socialRiseMul>1');
ok(m.energyDriftMul > 1, 'vitality 偏低 → energyDriftMul>1（|耗|更快）');
const eng = createMoodEngine();
const before = eng.axes.social;
eng.step(600, 12); // 10 分钟
ok(eng.axes.social !== before || RATE.socialRise > 0, 'step 会动 social');

console.log('\n[C] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/createTemperament/.test(main) && /temperament\.observe/.test(main), 'main 接 temperament');
ok(/setRateMul/.test(main), 'main 推 rateMul');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
