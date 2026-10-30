'use strict';
const { cardToPersonaDraft } = require('../src/main/character-card');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] V2/V3 解析');
const v3 = {
  spec: 'chara_card_v3',
  data: {
    name: '测试娘',
    description: '一只桌宠。',
    personality: '温柔寡言。',
    mes_example: '你好。'
  }
};
const d = cardToPersonaDraft(v3);
ok(d.ok && d.name === '测试娘', 'V3 取名');
ok(d.parts.identity.includes('测试娘'), 'identity 含名字');
ok(d.parts.style.includes('温柔'), 'style 来自 personality');
ok(!d.parts.emotion && !d.parts.thought, '不碰协议槽');
ok(cardToPersonaDraft('{').ok === false, '坏 JSON → 失败');
ok(cardToPersonaDraft({ data: {} }).ok === false, '空 data → 失败');

console.log('\n[B] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/importCharacterCard/.test(main) && /导入角色卡/.test(main), '托盘导入入口');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
