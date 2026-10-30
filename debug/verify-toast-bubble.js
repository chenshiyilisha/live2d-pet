'use strict';

/* 操作反馈进气泡，不再默认冒主窗琥珀色 #status。
 * 跑法：node debug/verify-toast-bubble.js */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const main = read('main/main.js');
const toastFn = (main.match(/function toast\(text\) \{[\s\S]*?\n\}/) || [''])[0];
ok(toastFn.includes('bubble.showStatus'), 'toast() 优先进 bubble.showStatus');
ok(/floatBubble === false/.test(toastFn) && /pet:toast/.test(toastFn),
  '仅浮窗关时回退 pet:toast → #status');
ok(/pet:float-status/.test(main), '主进程接 pet:float-status');

const pre = read('main/preload.js');
ok(/floatStatus:/.test(pre), 'preload 暴露 floatStatus');

const pet = read('renderer/pet.js');
const show = (pet.match(/function showStatus\(msg\) \{[\s\S]*?\n\}/) || [''])[0];
ok(/floatStatus/.test(show), '渲染层 showStatus 浮窗开着走 floatStatus');
ok(/statusEl\.textContent/.test(show), '浮窗关着仍可写 #status');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
