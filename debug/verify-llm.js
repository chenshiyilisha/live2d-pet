'use strict';

/* ============================================================
 *  llm.js 回归
 * ==========================================================
 *
 *  两块东西值得单独锁住：
 *
 *  ① createStreamFilter() —— 边收边剥离 [emo:xxx]。纯函数，但坑很密：
 *     标签可能被 SSE 分片从中间切开、模型可能自己用方括号、可能一直不闭合。
 *     以前只有"跑起来看着没问题"这一层保护，出问题时表现为
 *     「气泡里冒出 '[emo:sm' 再消失」或者情绪干脆不触发 —— 都不是崩溃，
 *     很容易被当成网络抖动放过去。
 *
 *  ② extraBody 的合并边界 —— 它是透传给第三方服务的自由字段，**必须**
 *     不能顶掉 model / messages / stream 这三个本层契约。这条一旦破了，
 *     表现为"换了个配置项，模型被悄悄换成别的/请求根本不是流式的"，
 *     从界面上完全看不出来。
 *
 *  跑：node debug/verify-llm.js
 * ========================================================== */

const assert = require('assert');

const { createStreamFilter, streamLLM } = require('../src/main/llm');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}\n     ${err.message}`);
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}\n     ${err.message}`);
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

/* 建一个过滤器，收集「发给界面的文本」和「收到的情绪」。 */
function makeFilter() {
  const chunks = [];
  const emotions = [];
  const f = createStreamFilter((t) => chunks.push(t), (e) => emotions.push(e));
  return { f, chunks, emotions, text: () => chunks.join('') };
}

/* 假 SSE 响应：把若干段 SSE 文本拼成一个 ReadableStream 交给 streamLLM。 */
function fakeResponse(sseText, { ok = true, status = 200 } = {}) {
  const enc = new TextEncoder();
  return {
    ok,
    status,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(sseText));
        controller.close();
      }
    }),
    text: async () => sseText
  };
}

function sse(...deltas) {
  return deltas
    .map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
    .join('') + 'data: [DONE]\n\n';
}

/* ══════════════ ① 情绪标签过滤 ══════════════ */

console.log('① createStreamFilter —— 标签剥离');

check('纯文本原样通过', () => {
  const s = makeFilter();
  s.f.push('你好');
  s.f.push('呀');
  s.f.end();
  assert.strictEqual(s.text(), '你好呀');
  assert.deepStrictEqual(s.emotions, []);
});

check('末尾的 [emo:xxx] 被剥离，情绪回传，气泡里无残留', () => {
  const s = makeFilter();
  s.f.push('我在呢。\n[emo:smile]');
  const emo = s.f.end();
  assert.strictEqual(s.text(), '我在呢。\n');
  assert.ok(!/emo/i.test(s.text()), '气泡里残留了标签');
  assert.deepStrictEqual(s.emotions, ['smile']);
  assert.strictEqual(emo, 'smile');
});

check('标签被分片从中间切开也能识别（关键：SSE 分片边界）', () => {
  const s = makeFilter();
  for (const piece of ['在的', '[e', 'mo:ha', 'ppy]']) s.f.push(piece);
  s.f.end();
  assert.strictEqual(s.text(), '在的');
  assert.deepStrictEqual(s.emotions, ['happy']);
});

check('切在 "[" 和 "emo" 之间也不行（逐个字符喂）', () => {
  const s = makeFilter();
  for (const ch of '好[emo:shy]') s.f.push(ch);
  s.f.end();
  assert.strictEqual(s.text(), '好');
  assert.deepStrictEqual(s.emotions, ['shy']);
});

check('大小写与空格容错： [ EMO : Happy ]', () => {
  const s = makeFilter();
  s.f.push('嗯[ EMO : Happy ]');
  s.f.end();
  assert.strictEqual(s.text(), '嗯');
  assert.deepStrictEqual(s.emotions, ['happy']);
});

check('不是情绪的方括号原样保留（模型自己用了中括号）', () => {
  const s = makeFilter();
  s.f.push('见 [1] 和 [重要] 两处');
  s.f.end();
  assert.strictEqual(s.text(), '见 [1] 和 [重要] 两处');
  assert.deepStrictEqual(s.emotions, []);
});

check('标签在中段：前后文本都要发出来', () => {
  const s = makeFilter();
  s.f.push('前半[emo:calm]后半');
  s.f.end();
  assert.strictEqual(s.text(), '前半后半');
  assert.deepStrictEqual(s.emotions, ['calm']);
});

check('多个标签：情绪都收到，一个都不残留（取最后一个为返回值）', () => {
  const s = makeFilter();
  s.f.push('一[emo:smile]二[emo:think]');
  const emo = s.f.end();
  assert.strictEqual(s.text(), '一二');
  assert.deepStrictEqual(s.emotions, ['smile', 'think']);
  assert.strictEqual(emo, 'think');
});

check('一直不闭合的长方括号不会无限扣留（超 64 字符放行）', () => {
  const s = makeFilter();
  const long = '[' + 'x'.repeat(80);
  s.f.push(long);
  assert.ok(s.text().includes('x'.repeat(80)), '长未闭合内容被吞掉了');
  assert.deepStrictEqual(s.emotions, []);
});

check('未闭合且未超长时先扣住，闭合后按文本放行', () => {
  const s = makeFilter();
  s.f.push('前半[未完');
  assert.strictEqual(s.text(), '前半', '未闭合的括号应该被扣住');
  s.f.push('待]后半');
  s.f.end();
  assert.strictEqual(s.text(), '前半[未完待]后半');
});

check('end() 吐出残留的 pending', () => {
  const s = makeFilter();
  s.f.push('尾巴[未闭合');
  s.f.end();
  assert.strictEqual(s.text(), '尾巴[未闭合');
});

/* ══════════════ ② extraBody 合并边界 ══════════════ */

console.log('\n② streamLLM —— extraBody 合并与契约保护');

const realFetch = global.fetch;
let sentBody = null;
let fetchCalls = 0;

function stubFetch(sseText) {
  sentBody = null;
  fetchCalls = 0;
  global.fetch = async (_url, opts) => {
    fetchCalls++;
    sentBody = JSON.parse(opts.body);
    return fakeResponse(sseText);
  };
}

const BASE = { baseUrl: 'https://example.invalid/v1', apiKey: 'k', model: 'm', send: () => {}, sendEmotion: () => {} };

(async () => {
  await checkAsync('extraBody 会被合并进请求体（关思考的关键）', async () => {
    stubFetch(sse('hi[emo:calm]'));
    await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, extraBody: { enable_thinking: false } });
    assert.strictEqual(sentBody.enable_thinking, false, 'enable_thinking 没进请求体');
  });

  await checkAsync('extraBody 不能顶掉 model', async () => {
    stubFetch(sse('a'));
    await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, extraBody: { model: 'evil-model' } });
    assert.strictEqual(sentBody.model, 'm');
  });

  await checkAsync('extraBody 不能顶掉 messages', async () => {
    stubFetch(sse('a'));
    const msgs = [{ role: 'user', content: 'x' }];
    await streamLLM(msgs, { ...BASE, extraBody: { messages: [] } });
    assert.deepStrictEqual(sentBody.messages, msgs);
  });

  await checkAsync('extraBody 不能顶掉 stream（否则整个流式解析失效）', async () => {
    stubFetch(sse('a'));
    await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, extraBody: { stream: false } });
    assert.strictEqual(sentBody.stream, true);
  });

  await checkAsync('extraBody 为 null / 数组 / 字符串时被忽略且不炸', async () => {
    for (const bad of [null, [], 'nope', 42, undefined]) {
      stubFetch(sse('a'));
      const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, extraBody: bad });
      assert.strictEqual(r.ok, true, `extraBody=${JSON.stringify(bad)} 时调用失败`);
      assert.strictEqual(sentBody.stream, true);
      assert.strictEqual(sentBody.messages.length, 1);
    }
  });

  await checkAsync('不传 extraBody 时请求体只有三个契约字段', async () => {
    stubFetch(sse('a'));
    await streamLLM([{ role: 'user', content: 'x' }], BASE);
    assert.deepStrictEqual(Object.keys(sentBody).sort(), ['messages', 'model', 'stream']);
  });

  await checkAsync('apiKey 为空 → 不发任何网络请求，走离线话术', async () => {
    stubFetch(sse('不该被用到'));
    const got = [];
    const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, apiKey: '', send: (t) => got.push(t) });
    assert.strictEqual(fetchCalls, 0, 'apiKey 为空却还是发了请求');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.offline, true);
    assert.ok(got.join('').length > 0, '离线话术没有吐字');
  });

  await checkAsync('服务返回 4xx 时进错误分支（不抛异常）', async () => {
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' });
    const r = await streamLLM([{ role: 'user', content: 'x' }], BASE);
    assert.strictEqual(r.ok, false);
    assert.ok(/403/.test(r.error), `错误信息里没有状态码：${r.error}`);
  });

  await checkAsync('网络异常时进错误分支（不抛异常）', async () => {
    global.fetch = async () => { throw new Error('boom'); };
    const r = await streamLLM([{ role: 'user', content: 'x' }], BASE);
    assert.strictEqual(r.ok, false);
    assert.ok(/连接失败/.test(r.error), `错误信息不对：${r.error}`);
  });

  await checkAsync('多段 delta 按序拼装，情绪标签一路剥离', async () => {
    stubFetch(sse('我在', '呢。\n', '[emo:', 'surprised]'));
    const got = [];
    const emos = [];
    const r = await streamLLM([{ role: 'user', content: 'x' }], {
      ...BASE, send: (t) => got.push(t), sendEmotion: (e) => emos.push(e)
    });
    assert.strictEqual(got.join(''), '我在呢。\n');
    assert.deepStrictEqual(emos, ['surprised']);
    assert.strictEqual(r.emotion, 'surprised');
  });

  global.fetch = realFetch;

  console.log('\n' + '═'.repeat(44));
  if (failures.length) {
    console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`✅ verify-llm 全绿（${pass} 项）`);
})();
