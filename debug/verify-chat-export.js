'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeHistory, toJson, toMarkdown } = require('../src/main/chat-export');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

const sample = [
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '嗯，在呢。' },
  { role: 'system', content: '应忽略' },
  { role: 'user', content: '  ' }
];

console.log('\n[A] 归一化');
ok(normalizeHistory(sample).length === 2, '只留 user/assistant 非空');
ok(normalizeHistory(null).length === 0, 'null → []');

console.log('\n[B] JSON / MD');
const j = JSON.parse(toJson(sample, { name: '阿岩', exportedAt: '2026-10-30T00:00:00.000Z' }));
ok(j.count === 2 && j.messages[0].content === '你好', 'JSON 结构');
ok(j.name === '阿岩', 'JSON 带名字');
const md = toMarkdown(sample, { name: '阿岩', exportedAt: '2026-10-30T00:00:00.000Z' });
ok(md.includes('# 与「阿岩」的对话'), 'MD 标题');
ok(md.includes('## 主人') && md.includes('## 阿岩'), 'MD 角色小标题');
ok(md.includes('嗯，在呢。'), 'MD 正文');

console.log('\n[C] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/exportChatHistory/.test(main) && /导出对话/.test(main), '托盘导出入口');
ok(/historyToMarkdown|historyToJson/.test(main), 'main 调用导出');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
