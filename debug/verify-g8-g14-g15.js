'use strict';
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
const bubble = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'bubble.js'), 'utf8');

console.log('\n[G8] think 弱展示开关');
ok(/showThink:\s*true/.test(cfg), 'showThink 默认开');
ok(/isOn\('chat',\s*'showThink'/.test(main), 'emitChatThink 守 showThink');
ok(/内心 OS/.test(main), '托盘有内心 OS 开关');

console.log('\n[G14] 截屏隐藏');
ok(/hideFromCapture:\s*false/.test(cfg), 'hideFromCapture 默认关');
ok(/setContentProtection/.test(main) && /藏 3 秒/.test(main), '菜单 + 短暂隐藏');
ok(/setContentProtection/.test(bubble), '气泡窗同步保护');

console.log('\n[G15] 气泡穿透');
ok(/setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(bubble),
  '气泡 ensureWin 穿透');

console.log('\n[P6] 双模态');
ok(/mode:\s*'companion'/.test(cfg), 'chat.mode 默认 companion');
ok(/本轮模态·专业/.test(main) && /对话模态/.test(main), '专业模态接线');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
