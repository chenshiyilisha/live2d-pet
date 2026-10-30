'use strict';
const rhythm = require('../src/main/rhythm');
const { distillPersonaParts } = require('../src/main/persona-distill');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('\n[X6] rhythm');
let s = rhythm.empty();
ok(rhythm.isActiveWindow(s) === true, '样本少 → 放行');
const noon = new Date('2026-10-30T12:00:00').getTime();
for (let i = 0; i < 30; i++) s = rhythm.record(s, noon);
ok(s.hours[12] >= 30, '12 点槽有计数');
ok(rhythm.isActiveWindow(s, noon) === true, '高峰窗活跃');
const night = new Date('2026-10-30T03:00:00').getTime();
ok(rhythm.isActiveWindow(s, night) === false, '低谷窗不活跃');

console.log('\n[P7] distill');
const d = distillPersonaParts({ name: '阿岩', who: '电脑搭子', tone: '干脆', help: '先结论' });
ok(d.ok && d.parts.identity.includes('阿岩'), 'identity');
ok(d.parts.style.includes('干脆') && d.parts.method.includes('结论'), 'style/method');
ok(!d.parts.emotion, '不碰协议槽');

console.log('\n[G16/G20/X8] 接线');
const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');
ok(/maybeEnterSleep/.test(pet) && /wakeFromSleep/.test(pet), 'drowsy→sleep');
ok(/mouthLevel = 0/.test(pet) && /stopSpeaking/.test(pet), '打断嘴型归零');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
ok(/dumpMemorySnapshot/.test(main) && /PET_SNAPSHOT/.test(main), 'X8 memory snapshot');
ok(/recordRhythmHit/.test(main) && /gateProactive/.test(main), 'rhythm 接线');
ok(/promptPersonaDistill/.test(main) && /视角蒸馏/.test(main), '蒸馏入口');
ok(/onAssistantEmotion\('happy'\)/.test(main), 'X7 success→mood');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
