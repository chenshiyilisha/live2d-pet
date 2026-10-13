'use strict';

/* ============================================================
 *  对话后端探针
 * ==========================================================
 *
 *  为什么要有它：接第三方推理服务时，「配错了」和「服务本身不行」从应用界面
 *  上看是同一件事 —— 气泡里冒一句报错，或者干脆什么都不出来。而 llm.js 里
 *  的流式解析（SSE 分片、[emo:xxx] 剥离、reasoning_content 处理）恰恰是
 *  **最容易在一个特定服务上踩雷**的地方。所以这里直接把 llm.js 的
 *  streamLLM() 拉出来单独驱动一遍 —— 验的是真实代码路径，不是 curl 近似。
 *
 *  用法：
 *    node debug/llm-probe.js                    # 用源码版配置（%APPDATA%/live2d-pet）
 *    node debug/llm-probe.js --userdata Ayan    # 用安装版的配置
 *    node debug/llm-probe.js --config <路径>    # 指定配置
 *    node debug/llm-probe.js --model A,B,C      # 临时换模型试（不改配置）
 *    node debug/llm-probe.js --raw              # 只做原始诊断，不走 streamLLM
 *    node debug/llm-probe.js --list             # 列出服务端当前提供的模型
 *    node debug/llm-probe.js --dry              # 只打印将要发出的请求，不联网
 *
 *  两段式设计（同一进程，各发一次请求）：
 *    ① 原始诊断 —— 直接读 SSE，记录首字节 / 首个 reasoning_content /
 *       首个 content 的时间。用来回答「这个模型是不是先想半天再说」。
 *    ② 真实路径 —— 调 streamLLM()，看最终文本和情绪标签是否符合预期。
 *  分开的理由：llm.js **只认 delta.content**，推理型的 delta.reasoning_content
 *  会被静默丢掉 —— 现象就是「气泡半天不吐字」，光看 streamLLM 的返回
 *  完全看不出是被推理阶段吃掉了。
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const { streamLLM } = require('../src/main/llm');

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 90000);

/* 探针用的提问。刻意用一句最日常的话 —— 复现用户真实用法，
 * 而不是拿「介绍一下量子力学」这种长回答去放大模型差异。 */
const PROBE_MESSAGES = [
  {
    role: 'system',
    content:
      '你叫小绿，是常驻在这台电脑里的搭子。说话短，一两句就够，别啰嗦。\n' +
      '每次回复末尾必须带一个情绪标签，可选：calm / happy / smile / think / shy / serious / surprised / sleepy。\n' +
      '格式：[emo:smile]'
  },
  { role: 'user', content: '在吗' }
];

/* ---------- 参数 ---------- */

function parseArgs(argv) {
  const out = { userdata: 'live2d-pet', config: '', models: [], raw: false, dry: false, list: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--userdata') out.userdata = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--model' || a === '-m') out.models = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--raw') out.raw = true;
    else if (a === '--dry') out.dry = true;
    else if (a === '--list') out.list = true;
    else if (a === '-h' || a === '--help') { out.help = true; }
    else console.log(`（忽略未知参数 ${a}）`);
  }
  return out;
}

/* 配置路径。默认跟着**源码版**（live2d-pet），因为从源码跑就是从那儿读；
 * 安装版的 userData 目录名是 productName（Ayan）。 */
function resolveConfigPath(args) {
  if (args.config) return args.config;
  const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(roaming, args.userdata, 'config.json');
}

function mask(key) {
  const s = String(key || '');
  if (!s) return '(未设置)';
  if (s.length <= 10) return s[0] + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}（${s.length} 字符）`;
}

/* ---------- 原始诊断：自己读 SSE ---------- */

/* 返回 { ttfb, firstReasoning, firstContent, chunks, reasoningChunks, text,
 *        reasoning, status, error, total } —— 时间全是相对请求发出的 ms。
 * ⚠️ 这里必须和 llm.js **同样**带上 extraBody（如 {"enable_thinking":false}），
 *    否则诊断会说"有推理阶段"而真实路径其实没有，两边对不上、白排查。 */
async function rawProbe({ baseUrl, apiKey, model, extraBody }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};
  const t0 = Date.now();
  const r = { ttfb: null, firstReasoning: null, firstContent: null, chunks: 0, reasoningChunks: 0, text: '', reasoning: '', status: null, error: null, total: null, finish: null };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ ...extra, model, messages: PROBE_MESSAGES, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (err) {
    r.error = `${err.name}: ${err.message}`;
    r.total = Date.now() - t0;
    return r;
  }

  r.status = res.status;
  if (!res.ok) {
    try { r.error = (await res.text()).slice(0, 400); } catch { /* ignore */ }
    r.total = Date.now() - t0;
    return r;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (r.ttfb === null) r.ttfb = Date.now() - t0;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const d = obj.choices?.[0]?.delta || {};
      if (obj.choices?.[0]?.finish_reason) r.finish = obj.choices[0].finish_reason;
      if (d.reasoning_content) {
        r.reasoningChunks++;
        if (r.firstReasoning === null) r.firstReasoning = Date.now() - t0;
        r.reasoning += d.reasoning_content;
      }
      if (d.content) {
        r.chunks++;
        if (r.firstContent === null) r.firstContent = Date.now() - t0;
        r.text += d.content;
      }
    }
  }

  r.total = Date.now() - t0;
  return r;
}

/* ---------- 真实路径：走 llm.js ---------- */

async function realProbe({ baseUrl, apiKey, model }) {
  const t0 = Date.now();
  let ttft = null;
  let chars = 0;
  const pieces = [];
  const emotions = [];

  const res = await streamLLM(PROBE_MESSAGES, {
    baseUrl,
    apiKey,
    model,
    send: (t) => {
      if (ttft === null && t) ttft = Date.now() - t0;
      chars += t.length;
      pieces.push(t);
    },
    sendEmotion: (e) => emotions.push(e)
  });

  return {
    ok: res.ok,
    offline: !!res.offline,
    error: res.error || null,
    ttft,
    chars,
    text: pieces.join('').replace(/\s+/g, ' ').trim(),
    emotions,
    emotion: res.emotion || null,
    total: Date.now() - t0
  };
}

/* ---------- 列模型 ---------- */

async function listModels({ baseUrl, apiKey }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
    const body = await res.text();
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      // 服务返回的不是 JSON —— 多半是鉴权提示的纯文本，或根本不是 OpenAI 兼容服务
      console.log(`列模型失败：HTTP ${res.status}，响应不是 JSON：${body.slice(0, 200)}`);
      return [];
    }
    const ids = (j.data || []).map((m) => m.id).filter(Boolean).sort();
    if (!ids.length) {
      console.log(`列模型：HTTP ${res.status}，但没有 data[].id（响应：${body.slice(0, 200)}）`);
      return [];
    }
    console.log(`服务端提供 ${ids.length} 个模型：`);
    for (const id of ids) console.log('  ' + id);
    return ids;
  } catch (err) {
    console.log(`列模型失败：${err.name}: ${err.message}`);
    return [];
  }
}

/* ---------- 主流程 ---------- */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('============')[1].replace(/^\s*\n/, ''));
    return;
  }

  const cfgPath = resolveConfigPath(args);
  if (!fs.existsSync(cfgPath)) {
    console.error(`${C.red}配置不存在：${cfgPath}${C.reset}\n先跑一次应用（或指定 --userdata / --config）。`);
    process.exit(2);
  }

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const llm = cfg.llm || {};
  const models = args.models.length ? args.models : [llm.model];

  console.log(`${C.dim}配置文件：${cfgPath}${C.reset}`);
  console.log(`${C.dim}baseUrl  ：${llm.baseUrl}${C.reset}`);
  console.log(`${C.dim}apiKey   ：${mask(llm.apiKey)}${C.reset}`);
  console.log(`${C.dim}model    ：${models.join(', ')}${C.reset}\n`);

  if (args.dry) {
    const extra = llm.extraBody && typeof llm.extraBody === 'object' && !Array.isArray(llm.extraBody) ? llm.extraBody : {};
    console.log('--- 将要发出的请求体（dry run，不联网）---');
    console.log(JSON.stringify({ ...extra, model: models[0], messages: PROBE_MESSAGES, stream: true }, null, 2));
    return;
  }

  if (!llm.apiKey) {
    console.log(`${C.yellow}⚠️  apiKey 为空 —— 应用此时会走「离线话术」，不会请求任何服务。${C.reset}\n`);
  }

  if (args.list) {
    await listModels(llm);
    return;
  }

  if (args.raw) {
    const r = await rawProbe({ ...llm, model: models[0] });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  let failed = 0;

  for (const model of models) {
    console.log(`${C.cyan}══ ${model} ══${C.reset}`);

    const raw = await rawProbe({ ...llm, model });
    if (raw.error) {
      console.log(`  ${C.red}原始请求失败${C.reset}  HTTP ${raw.status || '-'}  ${raw.total}ms`);
      console.log(`  ${raw.error}`);
      failed++;
      console.log('');
      continue;
    }

    const notes = [];
    if (raw.reasoningChunks) {
      const stall = raw.firstContent !== null && raw.firstReasoning !== null ? raw.firstContent - raw.firstReasoning : null;
      notes.push(`${C.yellow}有推理阶段${C.reset}（${raw.reasoningChunks} 分片）` +
        (stall !== null ? `，正式开始说话前静默 ${stall}ms` : '，且始终没有 content'));
    }
    console.log(`  原始：HTTP ${raw.status}  首字节 ${raw.ttfb}ms  ` +
      `首字 ${raw.firstContent === null ? `${C.red}无 content${C.reset}` : raw.firstContent + 'ms'}  ` +
      `共 ${raw.chunks} 分片  ${raw.total}ms  finish=${raw.finish}`);
    if (notes.length) console.log('  ' + notes.join('；'));

    const real = await realProbe({ ...llm, model });
    if (!real.ok) {
      console.log(`  ${C.red}streamLLM 失败${C.reset}（${real.total}ms）：${real.error}`);
      failed++;
      console.log('');
      continue;
    }

    const tagOk = /\[emo:[a-z]+\]/i.test(raw.text);
    console.log(`  真实：首字 ${real.ttft === null ? `${C.red}无输出${C.reset}` : real.ttft + 'ms'}  ` +
      `${real.chars} 字符  ${real.total}ms  情绪=${real.emotion || '(无)'}`);
    console.log(`  文本：${real.text.slice(0, 120)}`);
    console.log(`  情绪标签：${tagOk ? `${C.green}模型自带 ✓${C.reset}` : `${C.yellow}未自带（llm.js 已剥离，无残留即可）${C.reset}`}`);
    if (/\[emo:/i.test(real.text)) {
      console.log(`  ${C.red}✗ 气泡里残留了未剥离的标签！${C.reset}`);
      failed++;
    }
    console.log('');
  }

  if (failed) {
    console.log(`${C.red}✗ 有 ${failed} 项失败${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}✓ 探针全过${C.reset}`);
})();
