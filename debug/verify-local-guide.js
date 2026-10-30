'use strict';
const fs = require('fs');
const path = require('path');
const { ENDPOINTS, probeOne, summarizeProbes } = require('../src/main/local-guide');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('[A] 端点目录');
ok(ENDPOINTS.length >= 2, '至少 Ollama + LM Studio');
ok(ENDPOINTS.every((e) => e.url && e.baseUrl && e.hint), '每条有 url/baseUrl/hint');

console.log('\n[B] probeOne（假 fetch）');
(async () => {
  const okFetch = async () => ({ ok: true, status: 200 });
  const badFetch = async () => { throw new Error('ECONNREFUSED'); };
  const a = await probeOne(ENDPOINTS[0], okFetch, 500);
  ok(a.ok === true && a.id === 'ollama', '在听 → ok');
  const b = await probeOne(ENDPOINTS[0], badFetch, 500);
  ok(b.ok === false, '拒绝连接 → 不 ok');

  const sumNone = summarizeProbes([b, { ...b, id: 'lmstudio', ok: false }]);
  ok(/还没侦测到/.test(sumNone.toast), '全挂有引导文案');
  const sumOk = summarizeProbes([a]);
  ok(/Ollama ✓/.test(sumOk.toast) && sumOk.lines[0].includes('ollama'), '命中有下一步');

  console.log('\n[C] 接线');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/local-guide/.test(main) && /检测本机端点/.test(main), '托盘有检测本机端点');

  console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
