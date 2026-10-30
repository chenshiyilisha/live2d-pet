'use strict';
/* P3 OCEAN 轻量偏置 */

const fs = require('fs');
const path = require('path');
const {
  DIMS, LEVELS, normalize, nearestLevel, derive, decayMulFor
} = require('../src/main/ocean');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('[A] 中性 ≈ 1');
{
  const d = derive({ E: 0.5, N: 0.5, A: 0.5 });
  ok(Math.abs(d.idleMinutesMul - 1) < 0.02, `idle≈1（${d.idleMinutesMul}）`);
  ok(Math.abs(d.positiveDecayMul - 1) < 0.02, `posDecay≈1（${d.positiveDecayMul}）`);
  ok(Math.abs(d.negativeDecayMul - 1) < 0.02, `negDecay≈1（${d.negativeDecayMul}）`);
  ok(Math.abs(d.bubbleReadMul - 1) < 0.02, `bubble≈1（${d.bubbleReadMul}）`);
  ok(Math.abs(d.prideSoftMul - 1) < 0.05, `pride≈1（${d.prideSoftMul}）`);
}

console.log('\n[B] 方向');
{
  const hiE = derive({ E: 1, N: 0.5, A: 0.5 });
  const loE = derive({ E: 0, N: 0.5, A: 0.5 });
  ok(hiE.idleMinutesMul < loE.idleMinutesMul, '外向 → idle 更短');
  ok(hiE.positiveDecayMul > loE.positiveDecayMul, '外向 → 正面衰减更慢');
  const hiN = derive({ E: 0.5, N: 1, A: 0.5 });
  const loN = derive({ E: 0.5, N: 0, A: 0.5 });
  ok(hiN.negativeDecayMul > loN.negativeDecayMul, '敏感 → 负面更缠');
  ok(decayMulFor('happy', { E: 1 }) > decayMulFor('happy', { E: 0 }), 'decayMulFor happy 跟 E');
  ok(decayMulFor('serious', { N: 1 }) > decayMulFor('serious', { N: 0 }), 'decayMulFor serious 跟 N');
  ok(decayMulFor('think', { E: 1, N: 1 }) === 1, '中性情绪乘子 1');
}

console.log('\n[C] 钳位 / 档位');
{
  ok(normalize({ E: 9, N: -1, A: 'x' }).E === 1 && normalize({ E: 9 }).N === 0.5, '越界钳回');
  ok(nearestLevel(0.18).id === 'low' && nearestLevel(0.5).id === 'mid' && nearestLevel(0.9).id === 'high',
    'nearestLevel 三档');
  ok(DIMS.length === 4 && LEVELS.length === 3, '4 维 × 3 档');
  ok(normalize({}).T === 0.5, '缺省 T=0.5');
  const hiT = derive({ E: 0.5, N: 0.5, A: 0.5, T: 1 });
  const loT = derive({ E: 0.5, N: 0.5, A: 0.5, T: 0 });
  ok(hiT.idleMinutesMul < loT.idleMinutesMul, '话痨 → idle 更短');
  const midT = derive({ E: 0.5, N: 0.5, A: 0.5, T: 0.5 });
  ok(Math.abs(midT.idleMinutesMul - 1) < 0.02, '中性 T 不改 idle');
}

console.log('\n[D] 接线');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/require\('\.\/ocean'\)/.test(main), 'main 引入 ocean');
  ok(/性格微调/.test(main), '菜单有性格微调');
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');
  ok(/decayMulFor|oceanDecay|personality/.test(pet), '渲染层消费 personality/衰减乘子');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
  ok(/personality:\s*\{/.test(cfg), 'DEFAULT_CONFIG 有 personality');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
