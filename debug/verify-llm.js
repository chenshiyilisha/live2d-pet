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

const {
  createStreamFilter, streamLLM, LLM_TIMEOUT, hitAssistantTone,
  THINK_MAX, THINK_HOLD
} = require('../src/main/llm');

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

/* 建一个过滤器，收集「发给界面的文本」和「收到的情绪 / 想法」。 */
function makeFilter() {
  const chunks = [];
  const emotions = [];
  const thinks = [];
  const f = createStreamFilter(
    (t) => chunks.push(t),
    (e) => emotions.push(e),
    (t) => thinks.push(t)
  );
  return { f, chunks, emotions, thinks, text: () => chunks.join('') };
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

/* 整段喂 / 逐字喂，两种都必须得到同一个结果 —— 清洗器是有状态的，
 * "分片边界"是它最容易出问题的地方（和情绪标签那条一样）。 */
function run(text, { byChar = true } = {}) {
  const s = makeFilter();
  if (byChar) for (const ch of text) s.f.push(ch);
  else s.f.push(text);
  s.f.end();
  return s.text();
}

/* ══════════════ ①b 反助手腔后处理（2026-10-13 加） ══════════════ */

console.log('\n①b createStreamFilter —— markdown / emoji / 开头填充词');

check('markdown 行内记号被丢掉（星号加粗、反引号）', () => {
  assert.strictEqual(run('**很**重要`代码`'), '很重要代码');
});

check('markdown 行首记号被丢掉，且分片切在记号中间也认得出', () => {
  assert.strictEqual(run('- 第一点\n- 第二点'), '第一点\n第二点');
  assert.strictEqual(run('1. 甲\n2. 乙'), '甲\n乙');
  assert.strictEqual(run('### 标题\n正文'), '标题\n正文');
});

check('分隔线整行消失，不留空行', () => {
  assert.strictEqual(run('上\n---\n下'), '上\n下');
});

check('行内的 - 和 # 是正常内容，不能动（C# / 3-2 / -5 度）', () => {
  assert.strictEqual(run('C# 和 3-2 还有 -5 度'), 'C# 和 3-2 还有 -5 度');
});

check('emoji 被丢掉，且不留下双空格', () => {
  assert.strictEqual(run('今天不错 ☀️ 出门吧'), '今天不错 出门吧');
  assert.strictEqual(run('👍好'), '好');
});

check('开头的纯应答被剥掉（删掉不丢信息）', () => {
  assert.strictEqual(run('好的，我在呢。'), '我在呢。');
  assert.strictEqual(run('好嘞～这就去'), '这就去');
});

check('助手式开场句删到句末标点', () => {
  assert.strictEqual(run('作为一个AI语言模型，我不能这样。'), '我不能这样。');
  assert.strictEqual(run('很高兴为您解答！这个我知道'), '这个我知道');
});

check('整条回复就是一个填充词时**原样保留**（绝不能删成空字符串）', () => {
  assert.strictEqual(run('好的'), '好的');
  assert.strictEqual(run('很高兴为您服务。'), '很高兴为您服务。');
});

check('「没问题」「当然」这类是回答本身，不能进剥离表', () => {
  assert.strictEqual(run('没问题，我来'), '没问题，我来');
  assert.strictEqual(run('当然可以！'), '当然可以！');
});

check('普通开头不被误伤（不吞字）', () => {
  for (const t of ['我在呢。', '前半后半', '你好呀', '嗯，听着呢。', '前一个是错的']) {
    assert.strictEqual(run(t), t, `被改动了：${t}`);
  }
  assert.strictEqual(run('前半[未闭合'), '前半[未闭合');
});

check('填充词剥离 + 情绪标签 + 整段/逐字两种喂法结果一致', () => {
  const src = '好的，我在呢。\n[emo:smile]';
  assert.strictEqual(run(src, { byChar: true }), '我在呢。\n');
  assert.strictEqual(run(src, { byChar: false }), '我在呢。\n');
});

check('tone() 统计助手腔但不改文本', () => {
  const s = makeFilter();
  s.f.push('总的来说，这个方案需要注意的是一定要留缓冲。');
  s.f.end();
  assert.strictEqual(s.text(), '总的来说，这个方案需要注意的是一定要留缓冲。', 'tone 不该改文本');
  const hits = s.f.tone();
  assert.ok(hits.includes('总的来说'), `没抓到最后统计：${JSON.stringify(hits)}`);
  assert.ok(hits.includes('需要注意的是'));
});

check('hitAssistantTone 对干净的口语不报命中', () => {
  assert.deepStrictEqual(hitAssistantTone('我在呢，今天累不累？'), []);
  assert.deepStrictEqual(hitAssistantTone(''), []);
});

/* ══════════════ ①c 内心想法双通道（2026-10-14 加） ══════════════
 *
 * [think:…] 和 [emo:xxx] 共用同一套方括号扣留机制，但有三处不同，
 * 每处都要单独锁住：
 *   · 内容是一整段话，未闭合时的上限宽得多（不然正文里会闪出半截标签）
 *   · 它会显示出来，所以要洗脏字符、压成一行、超长截断
 *   · 它走独立通道，**一个字符都不许留在正文里**（留在正文 = 当众念心声） */

console.log('\n①c createStreamFilter —— [think:…] 内心想法');

check('想法从正文里剥干净，走独立通道', () => {
  const s = makeFilter();
  s.f.push('[think:这人怎么又来了]\n我在呢。\n[emo:smile]');
  const emo = s.f.end();
  assert.strictEqual(s.text(), '\n我在呢。\n');
  assert.ok(!/think/i.test(s.text()), '正文里残留了想法标签');
  assert.deepStrictEqual(s.thinks, ['这人怎么又来了']);
  assert.deepStrictEqual(s.emotions, ['smile']);
  assert.strictEqual(emo, 'smile');
  assert.strictEqual(s.f.think(), '这人怎么又来了');
});

check('想法被分片切开也能拼回来（SSE 分片边界）', () => {
  const s = makeFilter();
  for (const p of ['[thi', 'nk:在想', '事情]', '嗯。']) s.f.push(p);
  s.f.end();
  assert.strictEqual(s.text(), '嗯。');
  assert.deepStrictEqual(s.thinks, ['在想事情']);
});

check('逐字符喂得到同一个结果', () => {
  const s = makeFilter();
  for (const ch of '[think:有点困]\n早点睡。') s.f.push(ch);
  s.f.end();
  assert.strictEqual(s.text(), '\n早点睡。');
  assert.deepStrictEqual(s.thinks, ['有点困']);
});

check('没写想法时通道是空的（think() 返回 null，不是空串）', () => {
  const s = makeFilter();
  s.f.push('就这样吧。\n[emo:calm]');
  s.f.end();
  assert.deepStrictEqual(s.thinks, []);
  assert.strictEqual(s.f.think(), null);
});

check('大小写与空格容错： [ Think : 在想事情 ]', () => {
  const s = makeFilter();
  s.f.push('[ Think : 在想事情 ]嗯。');
  s.f.end();
  assert.deepStrictEqual(s.thinks, ['在想事情']);
  assert.strictEqual(s.text(), '嗯。');
});

check('想法里的 markdown / emoji 也会被洗掉', () => {
  const s = makeFilter();
  s.f.push('[think:**真的**吗 😅]嗯。');
  s.f.end();
  assert.deepStrictEqual(s.thinks, ['真的吗']);
});

check('想法压成一行（它在气泡里只占一行，换行会撑高）', () => {
  const s = makeFilter();
  s.f.push('[think:第一句\n第二句]好。');
  s.f.end();
  assert.deepStrictEqual(s.thinks, ['第一句 第二句']);
});

check('超长想法被截断（它长在正文上方，不能把正文挤没）', () => {
  const s = makeFilter();
  const long = '啊'.repeat(THINK_MAX + 30);
  s.f.push(`[think:${long}]嗯。`);
  s.f.end();
  const got = s.f.think();
  assert.strictEqual(got.length, THINK_MAX + 1, '应该是 THINK_MAX 个字 + 一个省略号');
  assert.ok(got.endsWith('…'));
});

check('整条想法洗成空（全是 emoji）就当作没写', () => {
  const s = makeFilter();
  s.f.push('[think:🎉🎉]嗯。');
  s.f.end();
  assert.deepStrictEqual(s.thinks, []);
  assert.strictEqual(s.f.think(), null);
  assert.strictEqual(s.text(), '嗯。');
});

check('未闭合的 [think: 扣得比普通方括号久（emo 的 64 上限对它太短）', () => {
  const s = makeFilter();
  const near = '想'.repeat(60);          // '[think:' + 60 字 = 67 字符，已越过 64
  s.f.push(`[think:${near}`);
  assert.strictEqual(s.text(), '', '想法被提前放行了 —— 正文里会闪出半截标签');
  s.f.push('了]嗯。');
  s.f.end();
  assert.strictEqual(s.text(), '嗯。');
  assert.strictEqual(s.f.think(), near + '了');
});

/* ══════════════ ①d [silent] 沉默标签（2026-10-15 加，第 9 轮第一档） ══════════════ */

console.log('\n①d createStreamFilter —— [silent] 沉默标签');

check('整条 [silent]：一个字都不出去，silent() 为 true', () => {
  const s = makeFilter();
  s.f.push('[silent]');
  s.f.end();
  assert.strictEqual(s.text(), '', '沉默的标签进了正文');
  assert.strictEqual(s.f.silent(), true);
});

check('标签被分片切开也认得（SSE 分片边界）', () => {
  const s = makeFilter();
  for (const p of ['[sil', 'ent]']) s.f.push(p);
  s.f.end();
  assert.strictEqual(s.text(), '');
  assert.strictEqual(s.f.silent(), true);
});

check('混在正文里的 [silent] 不算沉默（那是她说的话，照常处理）', () => {
  const s = makeFilter();
  s.f.push('[silent] 算了，没什么。');
  s.f.end();
  assert.ok(s.text().includes('算了'), '正文被吞了 —— 判不准一律放行');
  assert.strictEqual(s.f.silent(), false, '有正文还判成沉默 = 吞话');
});

check('只有 [emo:xxx] 没有 [silent]：silent() 为 false', () => {
  const s = makeFilter();
  s.f.push('在呢。\n[emo:calm]');
  s.f.end();
  assert.strictEqual(s.f.silent(), false);
});

check('大小写与空格容错： [ Silent ]', () => {
  const s = makeFilter();
  s.f.push('[ Silent ]');
  s.f.end();
  assert.strictEqual(s.f.silent(), true);
});

check('end() 之后才能定沉默（剥器尾巴可能吐字，之前读会误判）', () => {
  const s = makeFilter();
  s.f.push('[silent]');
  // 没调 end() 就读 —— 不做断言值的要求，只要求不抛；定论必须 end() 之后
  s.f.end();
  assert.strictEqual(s.f.silent(), true);
});


check('未闭合且超过想法上限时仍然放行（绝不吞字）', () => {
  const s = makeFilter();
  const body = '想'.repeat(THINK_HOLD + 10);
  s.f.push(`[think:${body}`);
  assert.ok(s.text().includes(body), '超长的未闭合内容被吞掉了');
});

check('[thinking] 这种没有冒号的方括号不算想法标签，原样保留', () => {
  const s = makeFilter();
  s.f.push('我在[thinking]这个词。');
  s.f.end();
  assert.strictEqual(s.text(), '我在[thinking]这个词。');
  assert.deepStrictEqual(s.thinks, []);
});

/* 想法里混进方括号：和 [emo:xxx] 同款语义 —— 以**第一个** ] 收尾，
 * 剩下的原样进正文。会切得难看，但不吞字，这是两者共用的边界。 */
check('想法里混进方括号：第一个 ] 收尾，其余原样进正文（不吞字）', () => {
  const s = makeFilter();
  s.f.push('[think:他说[好]吧]嗯。');
  s.f.end();
  assert.strictEqual(s.f.think(), '他说[好');
  assert.strictEqual(s.text(), '吧]嗯。');
});

check('想法 + 填充词 + 情绪三件套同时出现（整段/逐字一致）', () => {
  const src = '[think:又来活了]\n好的，这就去。\n[emo:happy]';
  for (const byChar of [true, false]) {
    const s = makeFilter();
    if (byChar) for (const ch of src) s.f.push(ch);
    else s.f.push(src);
    s.f.end();
    assert.strictEqual(s.text(), '\n这就去。\n', `byChar=${byChar}`);
    assert.deepStrictEqual(s.thinks, ['又来活了']);
    assert.deepStrictEqual(s.emotions, ['happy']);
  }
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

  /* ---- [silent] 的端到端（第 9 轮第一档）：标签剥干净 + 返回值带 silent ---- */

  await checkAsync('整条 [silent]：ok 且 silent=true，正文一个字不 send', async () => {
    const got = [];
    stubFetch(sse('[si', 'lent]'));
    const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, send: (t) => got.push(t) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.silent, true, '分片切开的 [silent] 没被认出');
    assert.strictEqual(got.join(''), '', '沉默的标签进了正文（气泡会闪出字）');
  });

  await checkAsync('正常回复 silent=false（不误伤）', async () => {
    stubFetch(sse('在呢。\n[emo:calm]'));
    const r = await streamLLM([{ role: 'user', content: 'x' }], BASE);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.silent, false);
    assert.strictEqual(r.emotion, 'calm');
  });

  /* ══════════════ ③ 请求超时（2026-10-13 加） ══════════════
   *
   * 在这之前 fetch 完全没有超时 —— 服务端连上后不再吐数据，请求就永远不返回，
   * 气泡永远停在"打字中"，只能杀进程。这两条测的就是"不再挂住"。
   * 用真实的 AbortController 走到 abort，不是模拟。 */

  console.log('\n③ streamLLM —— 请求超时');

  /* 连上了、但一个字节都不吐的响应，并且**真的**响应 abort 信号。 */
  function stallingResponse(signal) {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => {
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }
      }),
      text: async () => ''
    };
  }

  await checkAsync('连上了但不吐数据 → stallMs 后中断，并给出可读原因', async () => {
    global.fetch = async (_u, opts) => stallingResponse(opts.signal);
    const t0 = Date.now();
    const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, stallMs: 600, totalMs: 4000 });
    const dt = Date.now() - t0;
    assert.strictEqual(r.ok, false, '应该失败');
    assert.ok(/没有收到新数据|超时/.test(r.error), `错误信息不可读：${r.error}`);
    assert.ok(dt >= 500 && dt < 3000, `中断时机不对：${dt}ms`);
  });

  await checkAsync('整轮超过 totalMs 也会中断', async () => {
    global.fetch = async (_u, opts) => stallingResponse(opts.signal);
    const t0 = Date.now();
    const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, stallMs: 30000, totalMs: 1200 });
    const dt = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.ok(/整轮超过/.test(r.error), `应该报"整轮超时"：${r.error}`);
    assert.ok(dt < 4000, `中断太慢：${dt}ms`);
  });

  /* ---- 外部中止（在途作废，第 9 轮第一档）----
   * 与超时共用同一条"掐流"路径，但 abortWhy 是 external ——
   * 错误信息必须能区分"超时"和"被新一轮对话取代"。 */
  await checkAsync('外部 signal 中止：报"在途作废"而不是超时', async () => {
    global.fetch = async (_u, opts) => stallingResponse(opts.signal);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const t0 = Date.now();
    const r = await streamLLM([{ role: 'user', content: 'x' }], {
      ...BASE, stallMs: 30000, totalMs: 30000, signal: ac.signal
    });
    const dt = Date.now() - t0;
    assert.strictEqual(r.ok, false);
    assert.ok(/作废/.test(r.error), `应该是"在途作废"：${r.error}`);
    assert.ok(!/超时/.test(r.error), '被误报成超时');
    assert.ok(dt < 3000, `中断太慢：${dt}ms`);
  });

  await checkAsync('正常回复完全不受影响，超时定时器不残留', async () => {
    stubFetch(sse('我在呢。\n[emo:calm]'));
    const got = [];
    const r = await streamLLM([{ role: 'user', content: 'x' }], {
      ...BASE, stallMs: 600, totalMs: 1200, send: (t) => got.push(t)
    });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(got.join(''), '我在呢。\n');
  });

  await checkAsync('手改配置写成 0 / 负数时被钳住，不会每轮立刻中断', async () => {
    for (const bad of [0, -1, 'x', null, NaN]) {
      stubFetch(sse('在的'));
      const r = await streamLLM([{ role: 'user', content: 'x' }], { ...BASE, stallMs: bad, totalMs: bad });
      assert.strictEqual(r.ok, true, `stallMs=${bad} 时把正常请求掐了：${r.error}`);
    }
  });

  /* ══════════════ ④ 默认值与区间只有一处真相 ══════════════ */

  console.log('\n④ 常量互验');

  await checkAsync('config.js 的 llm 超时默认值 = llm.js 的 LLM_TIMEOUT', async () => {
    /* config.js 只用到 app.getPath，stub 掉 electron 就能直接 require
     * （和 verify-config-defaults.js 同一套办法）。 */
    const Module = require('module');
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'electron') return { app: { getPath: () => require('os').tmpdir() } };
      return orig.apply(this, arguments);
    };
    let def;
    try {
      def = require('../src/main/config').DEFAULT_CONFIG.llm;
    } finally {
      Module.prototype.require = orig;
    }
    assert.strictEqual(def.stallMs, LLM_TIMEOUT.stallMs,
      'config.js 的 stallMs 默认值和 llm.js 的 LLM_TIMEOUT 不一致 —— 改一处必须改两处');
    assert.strictEqual(def.totalMs, LLM_TIMEOUT.totalMs, '同上，totalMs 不一致');
    assert.ok(LLM_TIMEOUT.stallMs >= LLM_TIMEOUT.stallMin && LLM_TIMEOUT.stallMs <= LLM_TIMEOUT.stallMax);
    assert.ok(LLM_TIMEOUT.totalMs >= LLM_TIMEOUT.totalMin && LLM_TIMEOUT.totalMs <= LLM_TIMEOUT.totalMax);
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
