'use strict';
/* 模型接入（M1 本地免 key / M2 预设 / WorkBuddy models.json 导入）的验收脚本。
 *
 * 为什么这几条要单独锁死：它们全是**静默失败**型规则 —— 判错了不会报错，
 * 只会表现为"她一直在念台词"或"记忆永远抽不出来"，界面上一片正常。
 *
 *   A. isLocalUrl  —— 语义边界（只认 hostname；路径里带 localhost 不算）
 *   B. isUsable    —— 唯一判定点（有 key 或本机）
 *   C. PROVIDERS   —— 目录自身的一致性（id 唯一、baseUrl 不能带 /chat/completions）
 *   D. fromWorkBuddyModels —— 官方 schema 的 url 是完整路径，必须反剥
 *   E. 负对照      —— 故意给错期望，断言必须变红（只见过绿色的断言不算证据）
 *
 * 用法：node debug/verify-llm-providers.js
 */

const {
  PROVIDERS, providerById, currentProviderId, isLocalUrl, isUsable, toPatch, fromWorkBuddyModels,
  featuredProviders, moreProviders, isTestGreen, suggestTimeouts, TIMEOUT_CLOUD, TIMEOUT_LOCAL
} = require('../src/main/llm-providers');
const { LLM_TIMEOUT } = require('../src/main/llm');

let failures = 0;
let total = 0;
const check = (cond, m) => {
  total++;
  if (cond) console.log('  ✅ ' + m);
  else { failures++; console.log('  ❌ ' + m); }
};

/* ── A. isLocalUrl ─────────────────────────────────────────── */
console.log('\nA. isLocalUrl（本机端点判定）');
check(isLocalUrl('http://127.0.0.1:11434/v1') === true, '127.0.0.1 是本机');
check(isLocalUrl('http://localhost:1234/v1') === true, 'localhost 是本机');
check(isLocalUrl('http://[::1]:11434/v1') === true, '[::1] 是本机');
check(isLocalUrl('http://0.0.0.0:8000/v1') === true, '0.0.0.0 是本机');
check(isLocalUrl('https://api.deepseek.com/v1') === false, '云端地址不是本机');
/* 🔴 关键负例：路径里出现 localhost 的**不是**本机。
 * 判错了的后果是「没填 key 也去发请求」，用户以为连上了。 */
check(isLocalUrl('https://api.example.com/localhost-proxy/v1') === false,
  '路径里带 localhost 不算本机（按 hostname 判）');
check(isLocalUrl('ftp://127.0.0.1/v1') === false, '非 http(s) 协议不算本机');
check(isLocalUrl('') === false, '空串不是本机');
check(isLocalUrl(undefined) === false, 'undefined 不是本机（不抛）');
check(isLocalUrl('not a url') === false, '坏地址不是本机（不抛）');

/* ── B. isUsable ──────────────────────────────────────────── */
console.log('\nB. isUsable（能不能真的发请求 —— 全项目唯一判定点）');
check(isUsable({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x' }) === true, '云端 + key = 可用');
check(isUsable({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '' }) === false, '云端 + 无 key = 不可用（走离线话术）');
check(isUsable({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '' }) === true, '本机 + 无 key = 可用（M1）');
check(isUsable({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '   ' }) === true, '本机 + 空白 key = 可用');
check(isUsable({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '   ' }) === false, '云端 + 空白 key = 不可用');
check(isUsable(undefined) === false, '整个 llm 缺失时不抛、判不可用');
check(isUsable({}) === false, '空对象判不可用');

/* ── C. PROVIDERS 目录自身一致性 ───────────────────────────── */
console.log('\nC. PROVIDERS（预设目录）');
const ids = PROVIDERS.map((p) => p.id);
check(new Set(ids).size === ids.length, 'id 不重复');
check(ids[0] === 'deepseek', '第一条是默认的 DeepSeek');
check(PROVIDERS.every((p) => p.label && p.id), '每条都有 id 与 label');
/* baseUrl 契约：llm.js 拼的是 `${baseUrl}/chat/completions`，
 * 预设里若已经带了这段就会拼成 …/chat/completions/chat/completions。 */
check(PROVIDERS.filter((p) => !p.custom).every((p) =>
  p.baseUrl && !/\/chat\/completions$/.test(p.baseUrl) && !/\/$/.test(p.baseUrl)),
  '预设 baseUrl 非空、无尾斜杠、不带 /chat/completions');
check(PROVIDERS.every((p) => p.custom || p.model), '预设都带默认模型名');
check(PROVIDERS.filter((p) => p.local).every((p) => isLocalUrl(p.baseUrl)),
  '标了 local 的条目地址确实在本机');
check(providerById('ollama')?.baseUrl === 'http://127.0.0.1:11434/v1', 'providerById 能取到 Ollama');
check(providerById('nope') === null, '未知 id 返回 null（不抛）');

/* ── D. toPatch ──────────────────────────────────────────── */
console.log('\nD. toPatch（选中预设要写进配置的键）');
const deepseek = providerById('deepseek');
const patch = toPatch(deepseek);
check(patch.provider === 'deepseek' && patch.baseUrl === deepseek.baseUrl && patch.model === deepseek.model,
  '普通预设：provider + baseUrl + model 一起给');
check(patch.stallMs === TIMEOUT_CLOUD.stallMs && patch.totalMs === TIMEOUT_CLOUD.totalMs,
  '云端预设带云端超时（M9）');
check(!('apiKey' in patch), '预设**不动** apiKey（用户已填的 key 不能被覆盖）');
check(JSON.stringify(toPatch(providerById('custom'))) === JSON.stringify({ provider: 'custom' }),
  '自定义项只改 provider，不覆盖已填的地址');
check(toPatch(null) === null, '空入参返回 null');
const ollamaPatch = toPatch(providerById('ollama'));
check(ollamaPatch.stallMs === TIMEOUT_LOCAL.stallMs && ollamaPatch.totalMs === TIMEOUT_LOCAL.totalMs,
  '本地预设带本地超时（M9）');

/* ── E. fromWorkBuddyModels ──────────────────────────────── */
console.log('\nE. fromWorkBuddyModels（WorkBuddy models.json）');
const doc = {
  models: [
    {
      id: 'deepseek-v4-pro', name: 'DeepSeek V4', vendor: 'Anyfast', apiKey: 'sk-abc',
      url: 'https://sjht.anyfast.ai/v1/chat/completions'
    },
    /* 没有 /chat/completions 结尾的（有些网关就这么写）→ 原样保留 */
    { id: 'gpt-4o', name: 'GPT-4o', vendor: 'OpenAI', apiKey: '${OPENAI_API_KEY}', url: 'https://api.openai.com/v1' },
    /* 重复条目（同地址同模型）→ 只留一条 */
    { id: 'gpt-4o', name: 'GPT-4o dup', url: 'https://api.openai.com/v1' },
    /* 缺 id / 缺 url → 跳过 */
    { name: 'no id', url: 'https://x/v1' },
    { id: 'no-url' },
    null,
    'junk'
  ]
};
const got = fromWorkBuddyModels(doc);
check(got.length === 2, `只保留 2 条合法且去重（实际 ${got.length}）`);
check(got[0].baseUrl === 'https://sjht.anyfast.ai/v1', '剥掉 /chat/completions 得到 baseUrl');
check(got[0].model === 'deepseek-v4-pro' && got[0].id === 'deepseek-v4-pro', 'model 取 id');
check(got[0].label === 'DeepSeek V4（Anyfast）', 'label = name（vendor）');
check(got[0].apiKey === 'sk-abc' && got[0].keyIsRef === false, '真 key 原样搬，keyIsRef=false');
check(got[1].baseUrl === 'https://api.openai.com/v1', '不带 /chat/completions 的地址原样保留');
check(got[1].keyIsRef === true, '${ENV} 形式识别成引用（不解析、原样搬）');
/* 手滑写成数组（有的版本直接是数组）也要认 */
check(fromWorkBuddyModels([{ id: 'a', url: 'https://h/v1/chat/completions' }])[0]?.baseUrl === 'https://h/v1',
  '顶层是数组也认');
/* 字符串 JSON：调用方从文件读到的就是字符串 */
check(fromWorkBuddyModels(JSON.stringify(doc)).length === 2, '字符串入参自动 JSON.parse');
check(fromWorkBuddyModels('{坏 json').length === 0, '坏 JSON 返回空列表（不抛）');
check(fromWorkBuddyModels({ models: [] }).length === 0, '空 models 返回空列表');
check(fromWorkBuddyModels(undefined).length === 0, 'undefined 返回空列表（不抛）');
/* 地址末尾多余斜杠要吃掉，否则会拼出 //chat/completions */
check(fromWorkBuddyModels([{ id: 'x', url: 'https://h/v1/chat/completions/' }])[0]?.baseUrl === 'https://h/v1/chat/completions/'.replace(/\/chat\/completions\/?$/i, ''),
  '尾部斜杠被吃掉');

/* ── E2. currentProviderId（旧配置没有 provider 字段） ────── */
console.log('\nE2. currentProviderId（哪个预设该打勾）');
check(currentProviderId({ provider: 'ollama', baseUrl: 'x' }) === 'ollama', '有 provider 字段就信它');
check(currentProviderId({ baseUrl: 'https://api.deepseek.com/v1' }) === 'deepseek',
  '旧配置（没有 provider）按 baseUrl 认出 DeepSeek');
check(currentProviderId({ baseUrl: 'https://api.deepseek.com/v1/' }) === 'deepseek', '尾巴带斜杠也认得');
check(currentProviderId({ baseUrl: 'https://my.proxy.example/v1' }) === 'custom', '对不上的地址 = 自定义');
check(currentProviderId({ provider: 'workbuddy', model: 'm' }) === 'workbuddy', 'WorkBuddy 导入的条目');
check(currentProviderId({}) === 'custom', '空配置 = 自定义（不抛）');
check(currentProviderId(undefined) === 'custom', 'undefined 不抛');

/* ── F. M5 设置页 / M3 拉列表（源码级） ──────────────────── */
console.log('\nF. M5 设置页 + M3 拉列表（main.js 接线）');
{
  const fs = require('fs');
  const path = require('path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  check(/模型设置/.test(main) && /extraBody/.test(main) && /stallSec/.test(main),
    '设置页含模型设置 / extraBody / 超时（秒）');
  check(/function listLlmModels\(/.test(main) && /\/models`/.test(main),
    'listLlmModels 打 GET …/models');
  check(/拉取列表/.test(main) && /__fillModels/.test(main),
    '页内「拉取列表」把 id 填进 datalist');
  check(/label: '模型设置…'/.test(main), '托盘入口改叫「模型设置…」');
  check(/async function testLlm\(override\)/.test(main),
    'testLlm 接受 override（页内先测再存）');
}

/* ── G. M8 目录精简 + 绿标 / M9 超时 ─────────────────────── */
console.log('\nG. M8 云端目录精简 + 绿标 · M9 场景超时');
const featured = featuredProviders();
const more = moreProviders();
check(featured.length >= 4, `featured 至少 4 条（实测 ${featured.length}）`);
check(featured.some((p) => p.id === 'deepseek') && featured.some((p) => p.id === 'qwen'),
  'featured 含 DeepSeek + 通义');
check(featured.some((p) => p.local) && featured.some((p) => p.custom),
  'featured 含本地 + 自定义');
check(more.every((p) => !p.featured), '更多列表全非 featured');
check(featured.length + more.length === PROVIDERS.length, 'featured ∪ 更多 = 全表');
check(isTestGreen({
  baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
  tested: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
}) === true, '指纹一致 → 绿');
check(isTestGreen({
  baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
  tested: { baseUrl: 'https://api.deepseek.com/v1', model: 'other' }
}) === false, '模型名变 → 掉绿');
check(isTestGreen({ baseUrl: 'https://api.deepseek.com/v1', model: 'x' }) === false, '无 tested → 不绿');
check(suggestTimeouts(true).stallMs === TIMEOUT_LOCAL.stallMs, 'suggestTimeouts(true) → 本地');
check(suggestTimeouts('http://127.0.0.1:11434/v1').stallMs === TIMEOUT_LOCAL.stallMs,
  'suggestTimeouts(本机 url) → 本地');
check(suggestTimeouts('https://api.deepseek.com/v1').stallMs === TIMEOUT_CLOUD.stallMs,
  'suggestTimeouts(云端) → 云端');
check(TIMEOUT_LOCAL.stallMs === LLM_TIMEOUT.localStallMs &&
  TIMEOUT_LOCAL.totalMs === LLM_TIMEOUT.localTotalMs,
  'TIMEOUT_LOCAL 与 llm.js LLM_TIMEOUT.local* 一致');
check(TIMEOUT_CLOUD.stallMs === LLM_TIMEOUT.stallMs &&
  TIMEOUT_CLOUD.totalMs === LLM_TIMEOUT.totalMs,
  'TIMEOUT_CLOUD 与 llm.js 默认超时一致');
const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
check(/featuredProviders\(\)/.test(mainSrc) && /moreProviders\(\)/.test(mainSrc),
  '托盘菜单用 featured / 更多');
check(/isTestGreen/.test(mainSrc) && /tested:/.test(mainSrc), 'testLlm 成功写 tested 绿标');

/* ── H. 负对照：断言必须能红 ─────────────────────────────── */
console.log('\nH. 负对照（故意给错期望，上面这套断言必须翻红）');
let red = 0;
const mustFail = (fn, label) => {
  total++;
  let val;
  try {
    val = fn();
  } catch {
    /* 抛错也算"红了" —— 断言里出现异常同样说明它不是恒绿 */
    red++; console.log('  ✅ 负对照正常红: ' + label); return;
  }
  if (val === false) { red++; console.log('  ✅ 负对照正常红: ' + label); }
  else { failures++; console.log('  ❌ 负对照没红: ' + label); }
};
mustFail(() => isLocalUrl('https://api.deepseek.com/v1') === true, 'isLocalUrl 云端');
mustFail(() => isUsable({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '' }) === true, 'isUsable 无 key 云端');
mustFail(() => fromWorkBuddyModels([{ id: 'a', url: 'https://h/v1/chat/completions' }])[0]?.baseUrl === 'https://h/v1/chat/completions',
  'baseUrl 未剥 /chat/completions');
/* 这里用 "expected === actual" 的形式，让上一次的错误期望真的会判定为不符合 */
const expectValue = (actual, wrongExpected, label) => {
  total++;
  if (actual === wrongExpected) { failures++; console.log('  ❌ 负对照没红: ' + label); }
  else console.log('  ✅ 负对照正常红: ' + label);
};
expectValue(got.length, 3, '条目数写成 3 会红');
expectValue(got[0].baseUrl, 'https://sjht.anyfast.ai/v1/chat/completions', 'baseUrl 写成未剥的值会红');
check(red === 3, `三条 mustFail 全部抛错（实际 ${red}）`);

console.log(`\n${failures ? '❌' : '✅'} ${total - failures}/${total} 通过，${failures} 失败`);
process.exit(failures ? 1 : 0);
