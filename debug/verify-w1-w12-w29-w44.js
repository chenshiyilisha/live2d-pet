'use strict';

/* W1 限时看屏 · W12 PetEvent · W29 Agent JSONL · W44 work-cues
 * 跑法：node debug/verify-w1-w12-w29-w44.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

console.log('[A] W1 glance-grant');
{
  const G = require(path.join(SRC, 'main', 'glance-grant.js'));
  G._resetGrant();
  ok(!G.isGlanceAllowed(false), '无授权且永久关 → 拒');
  ok(G.isGlanceAllowed(true), '永久开 → 放行');
  const g = G.grantFor(60_000, 1_000_000);
  ok(g.remainingMs === 60_000 && G.isGranted(1_000_000), 'grant 60s');
  ok(G.isGlanceAllowed(false, 1_000_000), '限时授权可看屏');
  ok(!G.isGlanceAllowed(false, 1_000_000 + 60_001), '过期拒（逻辑时）');
  /* 用真时钟授权再收回 */
  G._resetGrant();
  G.grantFor(5000);
  ok(G.grantSnapshot().active, '真时钟 active');
  G.revoke('manual');
  ok(!G.grantSnapshot().active, 'revoke');
  ok(/限时授权|GRANT_PRESETS/.test(read('main/main.js')), '托盘限时入口');
  ok(/isGlanceAllowed/.test(read('main/main.js')), 'runGlance 走 isGlanceAllowed');
}

console.log('\n[B] W12 pet-events');
{
  const E = require(path.join(SRC, 'main', 'pet-events.js'));
  E._reset();
  let hit = 0;
  const off = E.on('work-state', (ev) => { hit += ev.payload.phase === 'thinking' ? 1 : 0; });
  E.emit('work-state', { phase: 'thinking' });
  E.emit('other', {});
  ok(hit === 1, '订阅精确类型');
  off();
  E.emit('work-state', { phase: 'thinking' });
  ok(hit === 1, 'off 后不再收');
  ok(/petEvents\.emit\('work-state'/.test(read('main/main.js')), 'emitWorkState 接线');
}

console.log('\n[C] W29 agent-link');
{
  const A = require(path.join(SRC, 'main', 'agent-link.js'));
  ok(A.parseAgentLine('{"state":"working"}')?.state === 'working', 'state 优先');
  ok(A.parseAgentLine('{"event":"PreToolUse"}')?.state === 'working', 'PreToolUse→working');
  ok(A.parseAgentLine('{"event":"Stop"}')?.state === 'attention', 'Stop→attention');
  ok(A.parseAgentLine('{"event":"Transcript"}') === null, '表外忽略');
  ok(A.stateToWorkPhase('sleeping') === 'idle', 'sleeping→idle');
  ok(A.stateToWorkPhase('attention') === 'attention', 'attention 保留');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agent-'));
  const file = path.join(dir, 'demo.jsonl');
  fs.writeFileSync(file, [
    '{"state":"thinking"}',
    '{"event":"PreToolUse","tool":"bash"}',
    '{"event":"UnknownThing"}',
    '{"state":"attention"}',
    ''
  ].join('\n'), 'utf8');
  let cur = { path: file, offset: 0, pending: '' };
  const r1 = A.readAgentTail(cur);
  ok(r1.events.length === 3, `读到 3 事件（${r1.events.length}）`);
  ok(r1.events[1].tool === 'bash', '保留 tool 名');
  const r2 = A.readAgentTail(r1.cursor);
  ok(r2.events.length === 0, '二次读无重复');
  /* 半行 */
  fs.appendFileSync(file, '{"state":"err');
  const r3 = A.readAgentTail(r2.cursor);
  ok(r3.events.length === 0 && r3.cursor.pending.startsWith('{'), '半行进 pending');
  fs.appendFileSync(file, 'or"}\n');
  const r4 = A.readAgentTail(r3.cursor);
  ok(r4.events[0]?.state === 'error', '半行补全');
  ok(/agentLink:\s*\{/.test(read('main/config.js')), 'config.agentLink');
  ok(/refreshAgentLinkWatch|tickAgentLink/.test(read('main/main.js')), 'main 轮询');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n[D] W44 work-cues');
{
  const W = require(path.join(SRC, 'main', 'work-cues.js'));
  ok(W.WORK_STATUS[0] === 'thinking' && W.WORK_STATUS.includes('attention'), '档位含 attention');
  ok(W.workStatusIndex('success') === 4, 'success 索引 4');
  ok(W.workStatusAt(6) === 'attention', 'index 6 = attention');
  ok(W.decideEndedCue({ phase: 'success' }).kind === 'event-done', 'success→event-done');
  ok(W.decideEndedCue({ phase: 'working', sticky: true, current: 'a' }).kind === 'work-replay', 'sticky replay');
  const rot = W.decideEndedCue({
    phase: 'working', rotate: true, candidates: ['a', 'b', 'c'], current: 'a'
  });
  ok(rot.kind === 'work-rotate' && rot.next === 'b', '档内轮换');
  ok(W.decideEndedCue({ phase: 'nope' }).kind === 'random', '未知→random');
  ok(/workStatusIndex/.test(read('main/main.js')), 'emitWorkState 用索引');
  ok(/attention/.test(read('renderer/pet.js')), '渲染层 attention');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
