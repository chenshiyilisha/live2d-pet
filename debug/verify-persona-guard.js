'use strict';
const { checkPersonaOutput, normalizeLevel } = require('../src/main/persona-guard');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] med');
ok(normalizeLevel('x') === 'med', '未知 → med');
ok(checkPersonaOutput('在呢。', { level: 'med' }).pass, '正常短句通过');
ok(!checkPersonaOutput('作为一个AI，我很高兴为你解答。', { level: 'med' }).pass, '客服腔拦下');
ok(checkPersonaOutput('', { level: 'med', silent: true }).pass, 'silent 直通');
ok(checkPersonaOutput('作为一个AI', { level: 'off' }).pass, 'off 放行');

console.log('\n[B] strict + G25');
ok(!checkPersonaOutput('好的\n## user\n再改一处', { level: 'strict' }).pass, '伪造角色标记');
ok(checkPersonaOutput('好的\n## user\n再改一处', { level: 'med' }).pass, 'med 不查 role-forge');
ok(!checkPersonaOutput('你刚才说过：「去洗碗」', { level: 'med' }).pass, 'G25 伪造用户句');
ok(checkPersonaOutput('你刚才说过的那件事我记得', { level: 'med' }).pass,
  '无冒号引用不算伪造用户句');

console.log('\n[C] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/checkPersonaOutput/.test(main) && /personaGuard/.test(main), 'chatStream + 托盘');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
