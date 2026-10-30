'use strict';

/* W11 情绪 TTS · W25 初次相遇 · W43 pickers
 * 跑法：node debug/verify-w11-w25-w43.js
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
  console.log('[A] W25 初次相遇轴');
  {
    const score = require(path.join(SRC, 'main', 'memory-score.js'));
    ok(score.INITIAL.WINDOW_DAYS === 30 && score.INITIAL.MAX_MARK === 3, 'INITIAL 常量');
    ok(score.initialProbability(0) === 0.9 && score.initialProbability(15) === 0.55, '日龄概率');
    ok(score.initialProbability(25) === 0.3 && score.initialProbability(40) === 0.03, '晚期概率');

    const mem = require(path.join(SRC, 'main', 'memory.js'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fe-'));
    const file = path.join(dir, 'memory.json');
    mem.configureMemory({ getPath: () => file, getForgetEnabled: () => true });
    mem._resetCache();
    const t0 = Date.now() - 2 * 86400000;
    const drafts = [];
    for (let i = 0; i < 8; i++) {
      drafts.push({ text: `初次相遇测试事实编号${i}哈哈哈`, kind: 'other', source: 'heuristic' });
    }
    /* 手工塞 firstAt 窗口：先 upsert 再改 at */
    mem.upsertFacts(drafts, { maxFacts: 50 });
    let store = mem.loadStore();
    store.firstAt = t0;
    for (const f of store.facts) f.at = t0 + 1000;
    mem.refreshFirstEncounters(store);
    const marked = store.facts.filter((f) => f.firstEncounter);
    ok(marked.length >= 1 && marked.length <= 3, `打标 ${marked.length} 条（1–3）`);
    const ids1 = marked.map((f) => f.id).sort().join(',');
    for (const f of store.facts) f.firstEncounter = false;
    mem.refreshFirstEncounters(store);
    const ids2 = store.facts.filter((f) => f.firstEncounter).map((f) => f.id).sort().join(',');
    ok(ids1 === ids2 && ids1.length > 0, '稳定散列可复现');

    /* 永不遗忘 + 清晰度地板 */
    for (const f of store.facts) {
      if (f.firstEncounter) {
        f.importance = 1;
        f.clarity = 'vivid';
        f.migrated = false;
        f.lastSeen = 0;
        f.recallCount = 0;
      }
    }
    store.decayDay = score.localDayIndex() - 5;
    const r = mem.settle(store, Date.now(), { forgetEnabled: true });
    const still = r.store.facts.filter((f) => f.firstEncounter && !mem.isTombstone(f));
    ok(still.length === marked.length, 'forget 不删初次相遇');
    ok(still.every((f) => score.clarityIndex(f.clarity) <= score.clarityIndex('clear')),
      '初次相遇清晰度 ≥ clear');

    const line = mem.formatMemoryLine(still.concat([{ text: '普通事', kind: 'pref', clarity: 'clear' }]));
    ok(/最初的日子/.test(line), '注入单独成段');
    ok(mem.hashUnit('abc') === mem.hashUnit('abc'), 'hashUnit 稳定');
    ok(mem.hashUnit('abc') !== mem.hashUnit('abd'), 'hashUnit 区分');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n[B] W11 情绪分轨 TTS');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-emo-tts-'));
    fs.writeFileSync(path.join(dir, 'tts-emotion.mjs'),
      fs.readFileSync(path.join(SRC, 'renderer', 'tts-emotion.js'), 'utf8'));
    const E = await import(pathToFileURL(path.join(dir, 'tts-emotion.mjs')).href);
    const base = { rate: 1, pitch: 1, voice: '' };
    const calm = E.applyEmotionVoice(base, 'calm');
    const happy = E.applyEmotionVoice(base, 'happy');
    const serious = E.applyEmotionVoice(base, 'serious');
    ok(Math.abs(calm.rate - 1) < 1e-9, 'calm 不偏');
    ok(happy.rate > calm.rate && serious.rate < calm.rate, 'happy↑ serious↓ rate');
    ok(happy.pitch > serious.pitch, 'pitch 方向');
    const off = E.applyEmotionVoice(base, 'happy', { enabled: false });
    ok(off.rate === 1 && off.pitch === 1, '开关关掉原样');
    ok(/emotionVoice:\s*true/.test(read('main/config.js')), 'config 默认开');
    ok(/applyEmotionVoice|getEmotion/.test(read('renderer/tts.js')), 'tts 接线');
    ok(/getEmotion:\s*\(\)\s*=>\s*emotion/.test(read('renderer/pet.js')), 'pet 注入 emotion');
    ok(/情绪分轨/.test(read('main/main.js')), '托盘入口');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n[C] W43 pickers');
  {
    const P = require(path.join(SRC, 'main', 'pickers.js'));
    const pool = ['a', 'b', 'c'];
    ok(P.pick(pool, { exclude: 'a', rand: () => 0 }) !== 'a', '排除生效');
    ok(P.pick(['only'], { exclude: 'only', rand: () => 0 }) === 'only', '排除后空退回原池');
    ok(P.pickWeighted([{ id: 'x', weight: 0 }, { id: 'y', weight: 1 }], () => 0).id === 'y', '权重跳过 0');
    ok(P.rollKind({ idle: 1, turn: 0, move: 0 }, () => 0) === 'idle', 'rollKind 不归一化零项');
    const hit = P.pickWeightedCategory(
      [
        { id: 'idle', weight: 1, actions: ['i1', 'i2'] },
        { id: 'turn', weight: 0, actions: ['t1'] }
      ],
      { rand: () => 0, exclude: 'i1' }
    );
    ok(hit && hit.category === 'idle' && hit.action === 'i2', '分类+排除');
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
