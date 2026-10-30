'use strict';
/* G6 药盒。用法：node debug/verify-oneshot.js */

const fs = require('fs');
const path = require('path');
const oneshot = require('../src/main/oneshot');

let fails = 0;
const ok = (c, m) => {
  if (c) console.log('  PASS', m);
  else { console.log('  FAIL', m); fails++; }
};

console.log('\n[A] 药盒纯函数');
oneshot.clearPending();
ok(oneshot.getPending() === '', '初始空');
ok(oneshot.listPills().length >= 4, `至少 4 颗药（${oneshot.listPills().length}）`);
const p = oneshot.pillById('short');
ok(p && p.text.includes('短'), 'short 药存在');
oneshot.setPending(p.text);
ok(oneshot.getPending() === p.text, 'set 后可读');
const got = oneshot.consume();
ok(got === p.text, 'consume 取出');
ok(oneshot.getPending() === '', 'consume 后清空');
ok(oneshot.consume() === '', '再 consume 空串');
oneshot.setPending('  x'.repeat(100));
ok(oneshot.getPending().length <= 200, '超长截断到 200');
oneshot.clearPending();

console.log('\n[B] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/require\('\.\/oneshot'\)/.test(main), 'main 引入 oneshot');
ok(/oneshotSubmenu\(/.test(main), '托盘有药盒子菜单');
ok(/oneshot\.consume\(/.test(main), 'chat:send 消费药盒');
ok(/【仅本轮】/.test(main), '注入标记【仅本轮】');
ok(/promptOneshot/.test(main), '手写药盒对话框');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
