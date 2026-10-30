'use strict';

/* G10 并发合成 / G11 文字口型 / G12 MCP 骨架 / G17 stage 清扫 / G19 2b 遗忘
 * 源码级 + 纯函数行为。跑法：node debug/verify-g10-g12.js */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

/* config.js 顶层 require('electron') —— 单测里 stub 掉。 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-cfg-g-'));
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return { app: { getPath: () => tmp, getVersion: () => '0.0.0-test' } };
  }
  return origRequire.apply(this, arguments);
};

(async () => {
  console.log('\n[A] G10 TTS 有限并发');
  {
    const tts = require('../src/main/tts');
    ok(tts.MAX_PARALLEL >= 2 && tts.MAX_PARALLEL <= 8, `MAX_PARALLEL=${tts.MAX_PARALLEL}`);
    const src = read('main/tts.js');
    ok(/acquire\s*\(/.test(src) && /release\s*\(/.test(src), '有 acquire/release 槽');
    ok(!/let chain = Promise\.resolve/.test(src), '不再单链完全串行');
    const r = read('renderer/tts.js');
    ok(/prefetch\(t\)/.test(r) && /item\.pcm/.test(r), '渲染层仍入队预合成 + 按序播');
  }

  console.log('\n[B] G11 文字口型模拟');
  {
    const r = read('renderer/tts.js');
    ok(/startTextSim/.test(r) && /stepTextSim/.test(r), '有 textSim 起停步进');
    ok(/isSoft/.test(r) && /0\.08 \+ Math\.random/.test(r), '标点处降幅');
    ok(/if \(textSim\) return stepTextSim/.test(r), 'lipEnv 优先文字模拟');
    /* playSystem 开头新增了 no-speechSynthesis 早退（无引擎 → playSilent，不空跑口型），
     * 到 startTextSim 的距离因此拉长；判据仍是「system 引擎在 playSystem 里起文字模拟」。 */
    ok(/function playSystem\([\s\S]{0,700}?startTextSim\(text\)/.test(r), 'system 引擎走文字模拟');
  }

  console.log('\n[C] G17 mount 前清 stage');
  {
    const pet = read('renderer/pet.js');
    ok(/while \(app\.stage\.children\.length\)/.test(pet), '挂载前扫空 stage');
    ok(/G17/.test(pet), '标了 G17');
  }

  console.log('\n[D] G12 MCP 骨架');
  {
    const mcp = require('../src/main/mcp');
    let cfg = { enabled: false, servers: [], grants: {} };
    mcp.configureMcp({ getCfg: () => cfg });
    ok(mcp.isEnabled() === false, '默认关');
    ok(mcp.listServers().length === 0, '关着无 server');
    cfg = { enabled: true, servers: [{ id: 'demo', name: 'Demo', command: 'node' }], grants: {} };
    ok(mcp.isEnabled() === true && mcp.listServers().length === 1, '开后能列出 server');
    ok(mcp.listTools('demo').length === 0, '骨架 listTools 空');
    const r1 = await mcp.callTool('demo', 'x', {});
    ok(r1.ok === false && r1.error === 'not-authorized', '未授权拒调');
    cfg.grants = { 'demo:x': true };
    const r2 = await mcp.callTool('demo', 'x', {});
    ok(r2.ok === false && r2.error === 'not-connected', '已授权仍 not-connected（骨架）');
    const main = read('main/main.js');
    ok(/MCP 工具（默认关）/.test(main), '托盘有 MCP 项');
    const conf = require('../src/main/config');
    ok(conf.DEFAULT_CONFIG.mcp.enabled === false, 'config 默认关');
  }

  console.log('\n[E] G19 2b 遗忘默认关 + 墓碑');
  {
    const memory = require('../src/main/memory');
    const { localDayIndex } = require('../src/main/memory-score');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem2b-'));
    const file = path.join(dir, 'facts.json');
    fs.writeFileSync(file, JSON.stringify({ version: 2, facts: [], decayDay: localDayIndex() }));
    memory._resetCache();
    memory.configureMemory({ getPath: () => file, getForgetEnabled: () => false });

    const store = memory.loadStore();
    const old = Date.now() - 200 * 86400000;
    const weakText = '随便提过一次的小事';
    store.facts.push({
      id: 'weak1',
      text: weakText,
      kind: 'other',
      at: old,
      updated: old,
      hits: 0,
      source: 'heuristic',
      importance: 5,
      clarity: 'trace',
      lastSeen: 0,
      recallCount: 0,
      pinned: false,
      firstEncounter: false,
      migrated: false
    });
    store.decayDay = localDayIndex() - 2;
    const off = memory.settle(JSON.parse(JSON.stringify(store)), Date.now(), { forgetEnabled: false });
    ok(off.forgotten === 0 && off.store.facts.some((f) => f.id === 'weak1' && f.text),
      'forget 关：不删正文');

    const on = memory.settle(JSON.parse(JSON.stringify(store)), Date.now(), { forgetEnabled: true });
    ok(on.forgotten === 1, `forget 开：forgotten=${on.forgotten}`);
    const tomb = on.store.facts.find((f) => f.id === 'weak1');
    ok(memory.isTombstone(tomb) && !tomb.text && !!tomb.key, '留墓碑无正文但有 key');

    const mig = JSON.parse(JSON.stringify(store));
    mig.facts[0].migrated = true;
    mig.decayDay = localDayIndex() - 2;
    const skipMig = memory.settle(mig, Date.now(), { forgetEnabled: true });
    ok(skipMig.forgotten === 0 && skipMig.store.facts[0].text,
      'migrated 条目不因 2b 删除');

    memory._resetCache();
    fs.writeFileSync(file, JSON.stringify(on.store));
    memory._resetCache();
    memory.configureMemory({ getPath: () => file });
    const revived = memory.upsertFacts([{ kind: 'other', text: weakText, source: 'heuristic' }]);
    const live = revived.store.facts.find((f) => f.id === 'weak1' || f.text === weakText);
    ok(revived.updated >= 1 && live && !memory.isTombstone(live) && live.text === weakText,
      '同文案可复活墓碑');

    const conf = require('../src/main/config');
    ok(conf.DEFAULT_CONFIG.memory.forget.enabled === false, 'forget 默认关');
  }

  console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
