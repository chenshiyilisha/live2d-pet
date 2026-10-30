'use strict';

/* G18 真脸情绪 / G22 由头 / G25 伪造用户句 / G26·G27 开关默认关 / G30 接线
 * 跑法：node debug/verify-g18-g30.js */

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
  console.log('\n[A] G18 whale 真脸情绪 ≠ hiyori 抄表');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-g18-'));
    fs.mkdirSync(path.join(tmp, 'profiles'));
    for (const f of ['whale.js', 'hiyori.js']) {
      fs.copyFileSync(path.join(SRC, 'renderer', 'profiles', f),
        path.join(tmp, 'profiles', f.replace('.js', '.mjs')));
    }
    const W = (await import(pathToFileURL(path.join(tmp, 'profiles', 'whale.mjs')).href)).WHALE;
    const H = (await import(pathToFileURL(path.join(tmp, 'profiles', 'hiyori.mjs')).href)).HIYORI;
    ok(W.emotion.happy.mouthForm !== H.emotion.happy.mouthForm ||
       W.emotion.happy.cheek !== H.emotion.happy.cheek ||
       W.emotion.happy.eyeOpen !== H.emotion.happy.eyeOpen,
      'happy 嘴/脸红/睁眼已按真脸偏离 hiyori');
    ok(W.emotion.sleepy.eyeOpen < H.emotion.sleepy.eyeOpen,
      'sleepy 睁眼更低（真脸困）');
    ok(/G18/.test(read('renderer/profiles/whale.js')), 'whale.js 标了 G18');
    const main = read('main/main.js');
    ok(/表情槽预览/.test(main) && /pet:emote/.test(main), '托盘表情槽预览');
  }

  console.log('\n[B] G22 由头四类');
  {
    const { shouldProactiveSpeak } = require('../src/main/info-gain');
    ok(shouldProactiveSpeak({ edgeHint: 'x' }).head === 'cue', 'cue');
    ok(shouldProactiveSpeak({
      history: [{ role: 'user', content: '嗨' }]
    }).head === 'reply', 'reply');
    ok(shouldProactiveSpeak({ history: [], idleMinutes: 30 }).head === 'idle', 'idle');
    ok(shouldProactiveSpeak({
      history: [{ role: 'assistant', content: '嗯' }],
      idleMinutes: 30
    }).head === 'none' && shouldProactiveSpeak({
      history: [{ role: 'assistant', content: '嗯' }]
    }).speak === false, 'none/stale');
  }

  console.log('\n[C] G25 伪造用户句');
  {
    const { checkPersonaOutput } = require('../src/main/persona-guard');
    ok(!checkPersonaOutput('你刚才说过：「明天放假」', { level: 'med' }).pass,
      'med 拦「你刚才说过」');
    ok(!checkPersonaOutput('用户说：去洗碗', { level: 'med' }).pass, 'med 拦用户说');
    ok(checkPersonaOutput('在呢。', { level: 'med' }).pass, '正常句通过');
  }

  console.log('\n[D] G26/G27 默认关');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-cfg-g18-'));
    const Module = require('module');
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'electron') {
        return { app: { getPath: () => tmp, getVersion: () => '0' } };
      }
      return orig.apply(this, arguments);
    };
    delete require.cache[require.resolve('../src/main/config')];
    const conf = require('../src/main/config');
    ok(conf.DEFAULT_CONFIG.hotkeys.enabled === false, 'hotkeys 默认关');
    ok(conf.DEFAULT_CONFIG.motion.multiScreenHop === false, 'multiScreenHop 默认关');
    const main = read('main/main.js');
    ok(/refreshHotkeys/.test(main) && /globalShortcut/.test(main), '热键接线');
    ok(/multiScreenHop/.test(main) && /display-added/.test(main), '多屏 hop 接线');
    Module.prototype.require = orig;
  }

  console.log('\n[E] G30 verify-arch 存在');
  ok(fs.existsSync(path.join(ROOT, 'debug', 'verify-arch.js')), 'verify-arch.js');

  console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
