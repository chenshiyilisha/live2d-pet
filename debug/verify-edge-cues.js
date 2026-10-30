'use strict';
const fs = require('fs');
const path = require('path');
const { edgeCueFrom, CPU_BUSY, BATTERY_LOW } = require('../src/main/edge-cues');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[A] 阈值');
ok(edgeCueFrom({}).hint === '', '无线索 → 空');
ok(edgeCueFrom({ battery: { percent: BATTERY_LOW, charging: false } }).hint.includes('电量'),
  '低电量有 hint');
ok(edgeCueFrom({ battery: { percent: BATTERY_LOW, charging: true } }).hint === '',
  '充电中不报低电');
ok(edgeCueFrom({ cpu: CPU_BUSY }).preferSilent === true, '高 CPU → preferSilent');
ok(edgeCueFrom({ cpu: CPU_BUSY - 1 }).hint === '', 'CPU 阈值以下安静');
ok(edgeCueFrom({ fgSwitched: true }).hint.includes('切'), '切应用有 hint');
ok(edgeCueFrom({
  battery: { percent: 10, charging: false },
  cpu: 99,
  fgSwitched: true
}).hint.includes('电量'), '电量优先于 CPU/切应用');

console.log('\n[B] 接线');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/edgeCueHint/.test(main) && /edgeCues/.test(main), 'proactive 接边缘线索');
ok(/边缘线索/.test(main), '托盘有开关');
const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
ok(/edgeCues:\s*false/.test(cfg), 'edgeCues 默认关');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
