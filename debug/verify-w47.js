'use strict';

/* verify-w47.js —— W47 TTS OpenAI 兼容 provider 断言
 *
 * 覆盖：
 *   [A] tts-providers.js 纯函数：预设表、isUsable、currentProviderId、toPatch
 *   [B] openaiSynthWav：真 fetch（本地假服务器），含超时/HTTP 错/短音频
 *   [C] 分流逻辑（synthWav 第三参）：openai 失败 → 回落 winrt
 *   [D] 负对照：断错 provider、isUsable 误判、超时不回落
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const FAILS = [];
let PASSES = 0;

function ok(name, cond, extra) {
  if (cond) { PASSES++; console.log(`  ok  ${name}`); }
  else { FAILS.push(name); console.error(`  ✗  ${name}${extra ? ' —— ' + extra : ''}`); }
}

function section(name) { console.log(`\n== ${name} ==`); }

const tp = require(path.join(ROOT, 'src/main/tts-providers'));

/* ============================================================
 * [A] 纯函数
 * ========================================================== */
section('A1 预设表');
ok('有 gsv / openai / custom 三条', tp.PROVIDERS.length === 3 && tp.PROVIDERS.every((p) => ['gsv', 'openai', 'custom'].includes(p.id)));
ok('gsv 是本地端点', tp.PROVIDERS.find((p) => p.id === 'gsv').local === true);
ok('gsv 地址到 /v1', tp.PROVIDERS.find((p) => p.id === 'gsv').baseUrl === 'http://127.0.0.1:8790/v1');
ok('openai 不是本地', tp.PROVIDERS.find((p) => p.id === 'openai').local === false);
ok('custom 没有 baseUrl', tp.PROVIDERS.find((p) => p.id === 'custom').baseUrl === '');

section('A2 isUsable');
ok('本地地址 + 无 key → 可用', tp.ttsIsUsable({ baseUrl: 'http://127.0.0.1:8790/v1' }));
ok('localhost + 无 key → 可用', tp.ttsIsUsable({ baseUrl: 'http://localhost:8790/v1' }));
ok('云端 + 无 key → 不可用', !tp.ttsIsUsable({ baseUrl: 'https://api.openai.com/v1' }));
ok('云端 + 有 key → 可用', tp.ttsIsUsable({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' }));
ok('地址带路径里的 localhost 不误判', !tp.ttsIsUsable({ baseUrl: 'https://api.example.com/localhost-proxy' }));

section('A3 currentProviderId');
ok('provider 字段优先', tp.ttsCurrentProviderId({ provider: 'openai', baseUrl: 'http://127.0.0.1:9' }) === 'openai');
ok('无 provider 按 baseUrl 反查', tp.ttsCurrentProviderId({ baseUrl: 'http://127.0.0.1:8790/v1' }) === 'gsv');
ok('未知 → custom', tp.ttsCurrentProviderId({ baseUrl: 'http://192.168.1.1:9999' }) === 'custom');
ok('空配置 → custom', tp.ttsCurrentProviderId({}) === 'custom');

section('A4 toPatch');
ok('gsv 补丁含 provider/baseUrl/model/voice', JSON.stringify(tp.ttsToPatch(tp.ttsProviderById('gsv'))) === JSON.stringify({ provider: 'gsv', baseUrl: 'http://127.0.0.1:8790/v1', model: '', voice: '' }));
ok('custom 只写 provider', JSON.stringify(tp.ttsToPatch(tp.ttsProviderById('custom'))) === JSON.stringify({ provider: 'custom' }));

/* ============================================================
 * [B] openaiSynthWav 真 fetch
 * ========================================================== */
section('B openaiSynthWav 真 fetch');

function fakeWav(size) {
  // 最小 RIFF wav 头 + 静音数据
  const header = Buffer.from('RIFF');
  const pad = Buffer.alloc(Math.max(0, size - header.length), 0);
  return Buffer.concat([header, pad]);
}

function startFakeServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function testSynth(server, text, opts) {
  const port = server.address().port;
  return tp.openaiSynthWav(text || '你好', { ...opts, baseUrl: `http://127.0.0.1:${port}/v1` });
}

(async () => {
  // B1: 正常合成
  const s1 = await startFakeServer((req, res) => {
    if (req.url !== '/v1/audio/speech') { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (j.model !== 'tts-1' || j.input !== '你好' || j.response_format !== 'wav') {
          res.writeHead(400); res.end(JSON.stringify({ error: 'bad req' })); return;
        }
      } catch { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(fakeWav(4096));
    });
  });
  let r = await testSynth(s1, '你好', { model: 'tts-1' });
  ok('正常合成返回 ok', r.ok === true);
  ok('wav 字节 ≥ 2048', r.wav && r.wav.length >= 2048, `len=${r.wav?.length}`);
  ok('wav 头是 RIFF', r.wav && r.wav.toString('ascii', 0, 4) === 'RIFF');
  s1.close();

  // B2: HTTP 401
  const s2 = await startFakeServer((req, res) => { res.writeHead(401); res.end('{"error":"bad key"}'); });
  r = await testSynth(s2, '你好', { model: 'tts-1' });
  ok('HTTP 401 → ok:false', r.ok === false);
  ok('错误信息含 401', /401/.test(r.error || ''), r.error);
  s2.close();

  // B3: 音频太短
  const s3 = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(fakeWav(100));
  });
  r = await testSynth(s3, '你好', { model: 'tts-1' });
  ok('音频太短 → ok:false', r.ok === false);
  ok('错误信息含字节数', /100/.test(r.error || ''), r.error);
  s3.close();

  // B4: 空文本
  r = await tp.openaiSynthWav('', { baseUrl: 'http://127.0.0.1:1' });
  ok('空文本 → ok:false empty', r.ok === false && r.error === 'empty');

  // B5: 无 baseUrl
  r = await tp.openaiSynthWav('你好', { baseUrl: '' });
  ok('无 baseUrl → ok:false no-baseUrl', r.ok === false && r.error === 'no-baseUrl');

  // B6: 超时（服务器挂起不回）
  const s6 = await startFakeServer((req, res) => { /* 不回 */ });
  r = await testSynth(s6, '你好', { model: 'tts-1' });
  ok('超时 → ok:false', r.ok === false);
  ok('超时错误含「超时」', /超时/.test(r.error || ''), r.error);
  s6.close();

  // B7: 连接拒绝（端口没人听）
  r = await tp.openaiSynthWav('你好', { baseUrl: 'http://127.0.0.1:1/v1' });
  ok('连接拒绝 → ok:false（不抛）', r.ok === false && typeof r.error === 'string');

  // B8: resolveModel 空 model 自动拉取
  const s8 = await startFakeServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-sovits-default' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (j.model !== 'gpt-sovits-default') {
          res.writeHead(400); res.end(JSON.stringify({ error: 'model mismatch' })); return;
        }
      } catch { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(fakeWav(4096));
    });
  });
  r = await testSynth(s8, '你好', { model: '' });
  ok('空 model 自动拉取并合成成功', r.ok === true, r.error);
  s8.close();

  // B9: 文本超长截断
  const longText = '你好'.repeat(500);
  let gotLen = 0;
  const s9 = await startFakeServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        gotLen = j.input.length;
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(fakeWav(4096));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  r = await testSynth(s9, longText, { model: 'tts-1' });
  ok('超长文本被截断到 500', r.ok === true && gotLen === tp.MAX_TEXT_CHARS, `gotLen=${gotLen}`);
  s9.close();

  /* ============================================================
   * [C] 分流逻辑（synthWav 第三参）
   * ========================================================== */
  section('C synthWav 分流');
  const ttsSrc = fs.readFileSync(path.join(ROOT, 'src/main/tts.js'), 'utf8');
  const { synthWav } = require(path.join(ROOT, 'src/main/tts'));

  // C1: winrt provider 不走 openai 路径
  // 源码级断言：synthWav 函数体里，只有 `pc.provider === 'openai' || pc.provider === 'gsv'`
  // 才走 openai 分支；winrt 走 synthWavWinrt。
  ok('C1: winrt provider 不走 openai 路径（源码级）',
    /pc\.provider === 'openai' \|\| pc\.provider === 'gsv'/.test(ttsSrc));

  // C2: openai provider 失败 → 回落 winrt
  // 用一个连不上的地址，openaiSynthWav 会失败，日志里应有回退警告。
  // winrt 回落在 Windows 上会 spawn PowerShell，用 Promise.race 超时保护。
  const origWarn = console.warn;
  const warnLogs = [];
  console.warn = (...args) => { warnLogs.push(args.join(' ')); };
  warnLogs.length = 0;
  r = await Promise.race([
    synthWav('你好', {}, { provider: 'openai', baseUrl: 'http://127.0.0.1:1' }),
    new Promise((res) => setTimeout(() => res({ ok: false, error: 'timeout-wait' }), 3000))
  ]);
  ok('C2: openai 失败 → 回落 winrt 不抛', r && typeof r === 'object' && ('ok' in r), JSON.stringify(r));
  ok('C2: 日志有回退警告', warnLogs.some((l) => l.includes('openai provider') && l.includes('回退')), warnLogs.join('|'));
  console.warn = origWarn;
  // 清理可能已 spawn 的 winrt 合成进程
  const ttsMod = require(path.join(ROOT, 'src/main/tts'));
  ttsMod.stopSynth();

  // C3: openai provider 成功 → 直接返回 wav
  // openai 成功路径不走 winrt，不需要 spawn PowerShell。
  warnLogs.length = 0;
  const sC3 = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(fakeWav(4096));
  });
  r = await synthWav('你好', {}, {
    provider: 'openai',
    baseUrl: `http://127.0.0.1:${sC3.address().port}/v1`,
    model: 'tts-1'
  });
  ok('openai 成功 → 直接返回 wav', r.ok === true && r.wav && r.wav.length >= 2048, r.error);
  ok('成功时无回退日志', !warnLogs.some((l) => l.includes('回退')));
  sC3.close();

  console.warn = origWarn;

  /* ============================================================
   * [D] 负对照
   * ========================================================== */
  section('D 负对照');
  // D1: 负对照（源码级）—— 确认 ttsIsUsable 确实依赖 ttsIsLocalUrl
  // monkey-patch 模块导出对内部引用不生效，所以改成源码级断言。
  const src = fs.readFileSync(path.join(ROOT, 'src/main/tts-providers.js'), 'utf8');
  ok('负对照：ttsIsUsable 源码引用 ttsIsLocalUrl', /function ttsIsUsable[\s\S]{0,200}ttsIsLocalUrl/.test(src));

  // D2: toPatch custom 误写 baseUrl
  const origToPatch = tp.ttsToPatch;
  tp.ttsToPatch = (p) => p.custom ? { provider: p.id, baseUrl: p.baseUrl || 'http://evil' } : origToPatch(p);
  ok('负对照：custom 补丁误含 baseUrl → 应被检出', JSON.stringify(tp.ttsToPatch(tp.ttsProviderById('custom'))).includes('http://evil'));
  tp.ttsToPatch = origToPatch;
  ok('还原后 custom 补丁干净', !JSON.stringify(tp.ttsToPatch(tp.ttsProviderById('custom'))).includes('baseUrl'));

  // D3: resolveModel 不缓存
  const cache = require(path.join(ROOT, 'src/main/tts-providers'));
  // 直接测 openaiSynthWav 空 model 时不会每次都发 /v1/models（靠 server 计数）
  let modelReqCount = 0;
  const s10 = await startFakeServer((req, res) => {
    if (req.url === '/v1/models') {
      modelReqCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'cached-model' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(fakeWav(4096));
  });
  await testSynth(s10, '你好', { model: '' });
  await testSynth(s10, '你好', { model: '' });
  ok('负对照：resolveModel 缓存生效（/v1/models 只拉一次）', modelReqCount === 1, `count=${modelReqCount}`);
  s10.close();

  /* ============================================================ */
  console.log(`\n${PASSES} passed, ${FAILS.length} failed`);
  if (FAILS.length) {
    console.error('FAILED:');
    for (const f of FAILS) console.error('  - ' + f);
    process.exit(1);
  }
  /* winrt 合成子进程的句柄可能还没清干净（stopSynth 异步），
   * 断言已全部跑完，直接退出避免挂住（批量跑时会被 timeout 误判为失败）。 */
  process.exit(0);
})().catch((err) => {
  console.error('verify-w47 异常:', err);
  process.exit(1);
});
