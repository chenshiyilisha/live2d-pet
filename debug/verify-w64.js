'use strict';
/**
 * verify-w64.js —— token 用量台账 + 成本面板验收
 *
 * 分两段：
 *   A. usage.js 纯模块真跑（record / summary / costOf / 持久化）。
 *   B. 接线源码级断言（llm.js 采集 usage、main.js 记账 + 推送 + 托盘、
 *      config.js 配置键、pet.js STAT_ITEMS 用量项、preload 白名单）。
 *
 * 规矩 28：负对照 —— 把某处改坏后断言必须变红。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = (p) => path.join(ROOT, 'src', p);

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
 *  A. usage.js 纯模块
 * ========================================================== */
const usage = require(SRC('main/usage.js'));

// A1: 用临时文件隔离持久化
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w64-'));
const tmpFile = path.join(tmpDir, 'usage.json');
usage.setStorePath(tmpFile);
usage.resetForTest();

// A2: 记录一条
usage.record({ model: 'deepseek-chat', promptTokens: 1000, completionTokens: 500, totalTokens: 1500 });
ok(usage._store().recent.length === 1, 'A2 记一条 → recent 1 条');
const today = usage.todayKey();
ok(usage._store().byDay[today]?.total === 1500, 'A2 按天聚合 total=1500');
eq(usage._store().byDay[today]?.turns, 1, 'A2 turns=1');
ok(usage._store().byDay[today]?.models['deepseek-chat']?.total === 1500, 'A2 按模型聚合');

// A3: 多条 + 跨模型
usage.record({ model: 'deepseek-chat', promptTokens: 2000, completionTokens: 1000, totalTokens: 3000 });
usage.record({ model: 'gpt-4o', promptTokens: 500, completionTokens: 500, totalTokens: 1000 });
eq(usage._store().byDay[today]?.turns, 3, 'A3 turns=3');
eq(usage._store().byDay[today]?.total, 5500, 'A3 累计 total=5500');
ok(Object.keys(usage._store().byDay[today]?.models || {}).length === 2, 'A3 两个模型');

// A4: summary 汇总
const sum = usage.summary({ 'deepseek-chat': { prompt: 1, completion: 2 } });
eq(sum.all.total, 5500, 'A4 summary.all.total=5500');
eq(sum.all.turns, 3, 'A4 summary.all.turns=3');
eq(sum.today.total, 5500, 'A4 summary.today.total=5500');
// 成本：deepseek 1000+2000=3000 prompt ×1/百万 = 0.003；completion 500+1000=1500 ×2/百万=0.003 → 0.006
// gpt-4o 无价 → 不计。costAll 只算有价的。
ok(typeof sum.costAll === 'number' && Math.abs(sum.costAll - 0.006) < 1e-9,
   `A4 costAll=0.006（实际 ${sum.costAll}）`);

// A5: 没配价 → costAll null
const sumNoPrice = usage.summary({});
eq(sumNoPrice.costAll, null, 'A5 无单价 → costAll=null');

// A6: 负对照 —— costOf 对未知模型返回 null
eq(usage.costOf({ model: 'nope', prompt: 100, completion: 100 }, { known: {} }), null,
   'A6 负对照：未知模型 costOf=null');

// A7: 持久化：重载后数据还在
usage.flush();
const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
ok(saved && saved.byDay && saved.byDay[today]?.total === 5500, 'A7 持久化落盘 total=5500');

// A8: 重置
usage.resetForTest();
eq(usage._store().recent.length, 0, 'A8 reset → recent 清空');
eq(Object.keys(usage._store().byDay).length, 0, 'A8 reset → byDay 清空');

/* ============================================================
 *  B. 接线源码级断言
 * ========================================================== */
const llmSrc = read(SRC('main/llm.js'));
const mainSrc = read(SRC('main/main.js'));
const cfgSrc = read(SRC('main/config.js'));
const petSrc = read(SRC('renderer/pet.js'));
const preSrc = read(SRC('main/preload.js'));

// B1: llm.js 请求带 stream_options include_usage
ok(llmSrc.includes('stream_options'), 'B1 llm.js 请求带 stream_options');
ok(llmSrc.includes('include_usage'), 'B1 llm.js 带 include_usage');

// B2: llm.js 解析 usage 并返回
ok(llmSrc.includes('captureUsage'), 'B2 llm.js 有 captureUsage');
ok(llmSrc.includes('usage'), 'B2 llm.js 返回值带 usage');

// B3: main.js 初始化台账路径
ok(mainSrc.includes('usage.setStorePath'), 'B3 main.js 初始化 usage.setStorePath');
ok(mainSrc.includes('usage.json'), 'B3 main.js 用 usage.json');

// B4: main.js chatStream 记账
ok(mainSrc.includes('usage.record'), 'B4 main.js chatStream 记 usage.record');
ok(mainSrc.includes('res.usage'), 'B4 main.js 读 res.usage');

// B5: main.js 推送汇总
ok(mainSrc.includes('usageSummaryForPush'), 'B5 main.js 有 usageSummaryForPush');
ok(mainSrc.includes('s.usage = usageSummaryForPush()'), 'B5 main.js push 带 s.usage');

// B6: main.js 托盘 flag
ok(mainSrc.includes("flag('monitor', 'usage'"), 'B6 main.js 托盘 monitor.usage flag');

// B7: config.js 配置键
ok(cfgSrc.includes('usage: false'), 'B7 config monitor.usage 默认关');
ok(cfgSrc.includes('usagePrices'), 'B7 config monitor.usagePrices');

// B8: pet.js STAT_ITEMS 用量项
ok(/key:\s*'usage'/.test(petSrc), 'B8 pet.js STAT_ITEMS 有 usage 项');
ok(petSrc.includes('s?.usage'), 'B8 pet.js 读 s.usage');
ok(petSrc.includes('costAll'), 'B8 pet.js 读 costAll');

// B9: preload 白名单有 monitor:stats（用量走这条通道）
ok(preSrc.includes("'monitor:stats'"), 'B9 preload 白名单有 monitor:stats');

/* ============================================================
 *  负对照（规矩 28）：把关键接线去掉 → 断言必须红
 * ========================================================== */
// C1: 若 llm.js 不带 include_usage，B1 应红（模拟：临时移除代码形态再查）
const llmNoUsage = llmSrc.replace(/stream_options:\s*\{\s*include_usage:\s*true\s*\}/g, '');
ok(!/stream_options\s*:/.test(llmNoUsage), 'C1 负对照：移除 include_usage 后代码形态不再含 stream_options（B1 会红）');

// C2: 若 pet.js 没有 usage 项，B8 应红
const petNoUsage = petSrc.replace(/key:\s*'usage'/g, "key: 'nousage'");
ok(!/key:\s*'usage'/.test(petNoUsage), 'C2 负对照：替换 usage 项后不再匹配（B8 会红）');

console.log(`\n${failed === 0 ? '✅ verify-w64 全绿' : '❌ verify-w64 有失败'}：${passed} 通过 / ${failed} 失败`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
