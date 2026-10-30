'use strict';

/* W10 话痨 · W19 触摸档 · W20(=G15) 气泡穿透 · W23/W24(=G19) 记忆打分
 * 跑法：node debug/verify-w10-w19-w20.js
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
  console.log('[A] W10 话痨维 T');
  {
    const { DIMS, normalize, derive } = require(path.join(SRC, 'main', 'ocean.js'));
    ok(DIMS.some((d) => d.key === 'T'), 'ocean DIMS 含 T');
    ok(normalize({}).T === 0.5, '缺省 T=0.5');
    const mid = derive({ E: 0.5, T: 0.5 });
    const hi = derive({ E: 0.5, T: 1 });
    const lo = derive({ E: 0.5, T: 0 });
    ok(Math.abs(mid.idleMinutesMul - 1) < 0.02, `中性 idle≈1（${mid.idleMinutesMul}）`);
    ok(hi.idleMinutesMul < mid.idleMinutesMul && lo.idleMinutesMul > mid.idleMinutesMul,
      'T 高低拉开 idle');
    ok(/T:\s*0\.5/.test(read('main/config.js')), 'config.personality.T');
    ok(/话痨/.test(read('main/ocean.js')), '标签 话痨');
  }

  console.log('\n[B] W19 触摸档');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-touch-'));
    fs.writeFileSync(path.join(dir, 'touch-mode.mjs'),
      fs.readFileSync(path.join(SRC, 'renderer', 'touch-mode.js'), 'utf8'));
    const T = await import(pathToFileURL(path.join(dir, 'touch-mode.mjs')).href);
    ok(T.normalizeTouchMode('custom') === 'normal', 'custom→normal');
    ok(T.normalizeTouchMode('QUIET') === 'quiet', 'quiet 归一');
    const n = T.pokeThresholds('normal');
    const q = T.pokeThresholds('quiet');
    const e = T.pokeThresholds('eager');
    ok(n.annoy === 4 && n.hurt === 6 && n.mad === 8, 'normal 4/6/8');
    ok(q.annoy > n.annoy && e.annoy < n.annoy, 'quiet 高门槛 / eager 低门槛');
    const base = { shyMs: 1400, nagMs: 3000, angryMs: 5000, escapeMs: 8000 };
    const pq = T.patThresholds('quiet', base);
    const pe = T.patThresholds('eager', base);
    ok(pq.escapeMs < base.escapeMs && pe.escapeMs > base.escapeMs, 'pat 时间缩放');
    ok(pq.shyMs < pq.nagMs && pq.nagMs < pq.angryMs && pq.angryMs < pq.escapeMs, 'quiet 保序');
    ok(pe.shyMs < pe.nagMs && pe.nagMs < pe.angryMs && pe.angryMs < pe.escapeMs, 'eager 保序');
    ok(/touchMode:\s*'normal'/.test(read('main/config.js')), 'config 默认 normal');
    ok(/pokeThresholds|patThresholds/.test(read('renderer/pet.js')), 'pet 消费门槛');
    ok(/触摸响应/.test(read('main/main.js')), '托盘入口');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n[C] W20 = G15 气泡穿透');
  {
    const b = read('main/bubble.js');
    ok(/setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/.test(b), '气泡 IgnoreMouseEvents');
    ok(/G15\s*\/\s*W20|W20/.test(b), '注释挂 W20');
  }

  console.log('\n[D] W23/W24 = G19 记忆打分/清晰度');
  {
    const s = require(path.join(SRC, 'main', 'memory-score.js'));
    ok(typeof s.scoreImportance === 'function', 'scoreImportance');
    ok(s.CLARITY_ORDER.length === 4, '四档清晰度');
    ok(s.RETENTION.CATCHUP_MAX_DAYS === 30, '离线补跑 ≤30 天');
    const hi = s.scoreImportance('第一次见面就答应永远喜欢你！！', 'relation', 'user');
    const lo = s.scoreImportance('嗯', 'other', 'llm');
    ok(hi > lo && hi >= 65, `重要度拉开（hi=${hi} lo=${lo}）`);
    ok(/CATCHUP_MAX_DAYS|clarityFromRetention/.test(read('main/memory.js')), 'memory 日结接线');
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
