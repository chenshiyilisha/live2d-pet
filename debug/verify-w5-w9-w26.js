'use strict';

/* W5 位置钉 · W9 时段 idle · W26/W27 主动账本+preview
 * 跑法：node debug/verify-w5-w9-w26.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  console.log('[A] W5 motion 位置钉');
  {
    const m = read('main/motion.js');
    const c = read('main/config.js');
    ok(/positionPin/.test(c) && /positionPin:\s*false/.test(c), 'config.motion.positionPin 默认关');
    ok(/rollPositionPin|isPositionPinned|pinUntil/.test(m), 'motion 钉状态机');
    ok(/PIN_MINUTES|14,\s*34,\s*44/.test(m), '钉时长 14/34/44');
    ok(/pinMode/.test(m) && /稀有换位/.test(m), '钉模式只 hop 一步');
    ok(/位置钉（稀有换位）/.test(read('main/main.js')), '托盘入口');
  }

  console.log('[B] W9 时段 idle 池');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tod-'));
    fs.writeFileSync(path.join(dir, 'idle-tod.mjs'),
      fs.readFileSync(path.join(SRC, 'renderer', 'idle-tod.js'), 'utf8'));
    const T = await import(pathToFileURL(path.join(dir, 'idle-tod.mjs')).href);
    ok(T.hourBucket(7) === 'morning', '7 → morning');
    ok(T.hourBucket(13) === 'afternoon', '13 → afternoon');
    ok(T.hourBucket(19) === 'evening', '19 → evening');
    ok(T.hourBucket(2) === 'night', '2 → night');
    ok(T.pickIdleEmote(2, { stage: 1 }) === '哭' || T.pickIdleEmote(2, { stage: 1 }) === '吐魂'
      || !!T.pickIdleEmote(2, { stage: 1 }), '夜第二档有候选');
    const have = new Set(['呆眼', '吐魂']);
    ok(T.pickIdleEmote(2, { stage: 0, have }) === '吐魂'
      || T.pickIdleEmote(2, { stage: 0, have }) === '呆眼', '按 have 过滤');
    ok(/pickIdleEmote/.test(read('renderer/pet.js')), 'pet.js 接 pickIdleEmote');
    ok(/timeOfDayIdle:\s*true/.test(read('main/config.js')), 'timeOfDayIdle 默认开');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('[C] W26/W27 账本 + preview');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-led-'));
    const L = require(path.join(SRC, 'main', 'proactive-ledger.js'));
    L.configureLedger(tmp);
    const book = L.bookDelivery({ reason: 'idle-hello', head: 'idle' });
    ok(!!book.id && book.status === 'pending', '先记账 pending');
    L.settleDelivery(book.id, 'delivered', { reason: 'idle-hello' });
    const log = fs.readFileSync(path.join(tmp, 'proactive-log.jsonl'), 'utf8').trim().split('\n');
    ok(log.length >= 2, `JSONL ≥2 行（${log.length}）`);
    const preview = L.previewProactive({ history: [], idleMinutes: 25 });
    ok(preview.speak === true && preview.reason === 'idle-hello' && preview.head === 'idle',
      `preview reason=${preview.reason} head=${preview.head}`);
    const skip = L.previewProactive({ history: [], idleMinutes: 2 });
    ok(skip.speak === false && skip.reason === 'empty-too-soon', 'preview 短闲置不说');
    const main = read('main/main.js');
    ok(/bookDelivery|settleDelivery/.test(main), 'chat:proactive 先记账');
    ok(/chat:proactive-preview/.test(main), 'preview IPC');
    ok(/proactivePreview/.test(read('main/preload.js')), 'preload 暴露 preview');
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
