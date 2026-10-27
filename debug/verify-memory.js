'use strict';
/* 轻量长期记忆回归 —— 不启 Electron。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-mem-'));
const file = path.join(tmp, 'memory-facts.json');
mem.configureMemory({ getPath: () => file });
mem._resetCache();

/* ---- 启发式 ---- */
{
  const a = mem.extractHeuristic('我叫阿岩，请多关照');
  assert.ok(a.some((f) => f.kind === 'name' && /阿岩/.test(f.text)), JSON.stringify(a));

  const b = mem.extractHeuristic('我喜欢喝茶');
  assert.ok(b.some((f) => f.kind === 'pref' && /茶/.test(f.text)));

  const c = mem.extractHeuristic('别叫我老板');
  assert.ok(c.some((f) => f.kind === 'boundary'));

  const d = mem.extractHeuristic('开玩笑的，我喜欢榴莲');
  assert.strictEqual(d.length, 0, '玩笑标记应拒写');
}

/* ---- 写入 / 去重 ---- */
{
  mem.clearFacts();
  mem.upsertFacts([{ kind: 'name', text: '主人叫阿岩', source: 'heuristic' }]);
  mem.upsertFacts([{ kind: 'name', text: '主人叫阿岩', source: 'heuristic' }]);
  assert.strictEqual(mem.listFacts().length, 1, '同义应合并');
  mem.upsertFacts([{ kind: 'pref', text: '主人喜欢喝茶', source: 'heuristic' }]);
  assert.strictEqual(mem.listFacts().length, 2);
}

/* ---- 召回闸门 ---- */
{
  assert.ok(mem.needsExpandedRecall('你还记得我喜欢什么吗'));
  assert.ok(mem.needsExpandedRecall('上次我们聊到哪儿了'));
  assert.ok(!mem.needsExpandedRecall('今天天气怎么样'));

  const core = mem.recall('随便说一句', { injectMax: 6 });
  assert.ok(core.some((f) => f.kind === 'name'), '核心 name 应常驻');

  const expanded = mem.recall('你还记得我喜欢喝茶吗', { injectMax: 6 });
  assert.ok(expanded.some((f) => /茶/.test(f.text)), '扩召应命中偏好');
}

/* ---- 注入格式 ---- */
{
  const line = mem.formatMemoryLine([
    { text: '主人叫阿岩' },
    { text: '主人喜欢喝茶' }
  ], 400);
  assert.ok(line.includes('主人叫阿岩'));
  assert.ok(line.includes('喝茶'));
  assert.ok(line.startsWith('【'));

  const msgs = [
    { role: 'system', content: '人设' },
    { role: 'user', content: '你好' }
  ];
  const injected = mem.injectMemoryContext(msgs, line);
  assert.strictEqual(injected[0].content, '人设');
  assert.strictEqual(injected[1].content, line);
  assert.strictEqual(injected[2].role, 'user');
}

/* ---- LLM 解析 ---- */
{
  const parsed = mem.parseLlmFacts('name|主人叫小明\npref|主人喜欢猫\nNONE');
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].kind, 'name');
  assert.strictEqual(mem.parseLlmFacts('NONE').length, 0);
  assert.strictEqual(mem.parseLlmFacts('无').length, 0);
}

/* ---- 落盘 ---- */
{
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw.facts) && raw.facts.length >= 1);
}

/* ---- 清空 ---- */
{
  mem.clearFacts();
  assert.strictEqual(mem.listFacts().length, 0);
}

/* 清理临时目录 */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log('verify-memory: OK');
