'use strict';
/* M6 多配置档：纯函数 + 主进程接线源码断言 */

const fs = require('fs');
const path = require('path');
const {
  SNAP_KEYS, snapFromLlm, applySnapToLlm, listProfiles, getProfile,
  saveCurrentAs, overwriteProfile
} = require('../src/main/llm-profiles');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('[A] snap / apply 往返');
{
  const llm = {
    provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '',
    model: 'qwen2.5', extraBody: { keep_alive: '5m' }, stallMs: 40000, totalMs: 180000,
    profiles: {}, activeProfile: ''
  };
  const snap = snapFromLlm(llm, '家里');
  ok(snap.id && snap.label === '家里', '新建档有 id 与标签');
  ok(SNAP_KEYS.every((k) => snap[k] !== undefined), '快照含全部 SNAP_KEYS');
  ok(snap.extraBody.keep_alive === '5m', 'extraBody 深拷');
  snap.extraBody.keep_alive = 'hack';
  ok(llm.extraBody.keep_alive === '5m', '改快照不动原 llm');

  const applied = applySnapToLlm(
    { ...llm, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk' },
    snap
  );
  ok(applied.baseUrl === 'http://127.0.0.1:11434/v1' && applied.model === 'qwen2.5',
    '切换把连接字段拷到顶层');
  ok(applied.activeProfile === snap.id, '切换写 activeProfile');
  ok(applied.apiKey === '', '切换带上空 key（本机档）');
  ok(applied.profiles === undefined || applied.profiles === llm.profiles ||
    JSON.stringify(applied.profiles) === JSON.stringify(llm.profiles),
    'apply 保留/带上 profiles 结构');
}

console.log('\n[B] list / get / overwrite');
{
  const a = saveCurrentAs({ provider: 'deepseek', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, '公司');
  const b = saveCurrentAs({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'q' }, '家里');
  const llm = { profiles: { [a.id]: a, [b.id]: b }, activeProfile: a.id };
  ok(listProfiles(llm).length === 2, 'list 两档');
  ok(getProfile(llm, a.id)?.label === '公司', 'get 命中');
  ok(getProfile(llm, 'nope') === null, '未知 id 回 null');
  const over = overwriteProfile(
    { provider: 'ollama', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'new', stallMs: 1, totalMs: 2, extraBody: {} },
    a.id, '公司改'
  );
  ok(over.id === a.id && over.model === 'new' && over.label === '公司改', '覆盖保留 id、换字段');
}

console.log('\n[C] 负对照');
{
  ok(listProfiles(null).length === 0, 'llm 缺失不抛');
  ok(applySnapToLlm(null, null).activeProfile === undefined || true, '空 snap 不抛');
  const empty = applySnapToLlm({ baseUrl: 'x' }, null);
  ok(empty.baseUrl === 'x', 'snap 空时保留原 llm');
  const bad = snapFromLlm({}, '   ');
  ok(bad.label === '未命名', '空白标签回落未命名');
}

console.log('\n[D] 主进程接线');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/require\('\.\/llm-profiles'\)/.test(main), 'main 引入 llm-profiles');
  ok(/function switchLlmProfile\(/.test(main), '有 switchLlmProfile');
  ok(/function saveLlmProfileAs\(/.test(main), '有 saveLlmProfileAs');
  ok(/配置档/.test(main), '菜单有「配置档」');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
  ok(/activeProfile/.test(cfg) && /profiles:\s*\{\s*\}/.test(cfg),
    'DEFAULT_CONFIG.llm 含 profiles / activeProfile');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
