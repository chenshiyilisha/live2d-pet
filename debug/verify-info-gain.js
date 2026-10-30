'use strict';
const { shouldProactiveSpeak } = require('../src/main/info-gain');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] 增益判据');
ok(shouldProactiveSpeak({ edgeHint: '低电' }).speak === true, '有 edge → 说');
ok(shouldProactiveSpeak({ edgeHint: '低电' }).head === 'cue', 'edge → head=cue');
ok(shouldProactiveSpeak({ moodLine: '你有点想他' }).speak === true, '有 mood → 说');
ok(shouldProactiveSpeak({
  history: [{ role: 'assistant', content: '嗯。' }],
  idleMinutes: 30
}).speak === false, '只有旧 assistant → 不说');
ok(shouldProactiveSpeak({ history: [], idleMinutes: 5 }).speak === false, '空历史闲置短 → 不说');
ok(shouldProactiveSpeak({ history: [], idleMinutes: 25 }).speak === true, '空历史闲置久 → 说');
ok(shouldProactiveSpeak({ history: [], idleMinutes: 25 }).head === 'idle', '闲置久 → head=idle');

console.log('\n[B] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/shouldProactiveSpeak/.test(main), 'proactive 接 info-gain');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
