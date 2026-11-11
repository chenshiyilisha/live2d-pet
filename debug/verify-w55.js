'use strict';
/* W55：主动刷新独立主题流——topic-stream.js 验收。
 *
 * 规矩 28：正对照（构建/去重/截断/TTL/提示词拼装）+
 * 负对照（代际令牌 + fail-open + 开关关着不拼提示词）。
 *
 * 用法：node debug/verify-w55.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

/* ---- electron 桩：topic-stream 只要 app.getPath ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w55-'));
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return { app: { getPath: () => tmp, getVersion: () => '0.0.0-test' } };
  return origRequire.apply(this, arguments);
};

const topicStream = require(path.join(__dirname, '..', 'src', 'main', 'topic-stream'));

let pass = 0, fail = 0;
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 实际 ' + a); pass++; }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); pass++; }
function section(t) { console.log('\n[' + t + ']'); }

topicStream.configureTopicStream(tmp);

/* ---- 测试夹具 ---- */
function makeFacts(arr) {
  return arr.map((f, i) => ({ id: 'f' + i, kind: 'preference', text: f.text, clarity: f.clarity, importance: f.importance || 0.5 }));
}
function historyWith(lastUser) {
  if (!lastUser) return [];
  return [
    { role: 'assistant', content: '嗯嗯' },
    { role: 'user', content: lastUser }
  ];
}

section('A. 构建：记忆事实 + 最近对话');
const t1 = topicStream.buildTopics({
  listFacts: () => makeFacts([
    { text: '主人喜欢喝冰美式', clarity: 'vivid', importance: 0.9 },
    { text: '主人在写一个桌宠项目', clarity: 'clear', importance: 0.8 }
  ]),
  history: historyWith('今晚打算把渲染层重写一遍'),
  now: Date.now()
});
eq(t1.length, 3, '2 条记忆 + 1 条历史 = 3 个主题');
eq(t1[0].text, '主人喜欢喝冰美式', 'vivid 排最前');
eq(t1[1].text, '主人在写一个桌宠项目', 'clear 次之');
eq(t1[2].text, '今晚打算把渲染层重写一遍', '历史话题垫底');
eq(t1[0].source, 'memory:preference', '来源带 kind');
ok(t1[0].at > 0, '有时间戳');

section('B. 去重（记忆 vs 历史重叠）');
/* 记忆取清晰度前 2；历史只取最后一条用户消息。让历史那条与记忆重复 → 去重。 */
const t2 = topicStream.buildTopics({
  listFacts: () => makeFacts([
    { text: '话题甲', clarity: 'vivid' },
    { text: '话题乙', clarity: 'vivid' }
  ]),
  history: [
    { role: 'assistant', content: '嗯嗯' },
    { role: 'user', content: '话题甲' }        // 与记忆重复 → 去重
  ],
  now: Date.now()
});
eq(t2.length, 2, '重复话题只留一份');
eq(t2[0].text, '话题甲', '记忆优先');
eq(t2[0].source, 'memory:preference', '保留的是记忆版');
eq(t2[1].text, '话题乙', '记忆次之');
ok(t2.length <= topicStream.MAX_TOPICS, '不超过上限（当前来源上限正好等于 MAX_TOPICS）');
/* 记忆内部重复（同文本）也只留一份。 */
const t2b = topicStream.buildTopics({
  listFacts: () => makeFacts([
    { text: '重复记忆', clarity: 'vivid' },
    { text: '重复记忆', clarity: 'vivid' }
  ]),
  history: [],
  now: Date.now()
});
eq(t2b.length, 1, '记忆内部同文本也去重');

section('C. 空输入');
const t3 = topicStream.buildTopics({ listFacts: () => [], history: [], now: Date.now() });
eq(t3.length, 0, '没有来源 → 空主题');
const t4 = topicStream.buildTopics({ listFacts: null, history: null, now: Date.now() });
eq(t4.length, 0, '缺数据源不抛');

section('D. 刷新 + TTL');
const now = Date.now();
const r1 = topicStream.refreshOnce({
  listFacts: () => makeFacts([{ text: '新鲜话题', clarity: 'vivid' }]),
  history: [],
  now
});
eq(r1.length, 1, '刷新 1 个主题');
eq(topicStream.getTopics(now).length, 1, '即时可取到');
eq(topicStream.getTopics(now + topicStream.TTL_MS - 1).length, 1, 'TTL 内有效');
eq(topicStream.getTopics(now + topicStream.TTL_MS + 1).length, 0, '超过 TTL 淘汰');

section('E. 提示词拼装');
const cfgOn = { proactive: { topicStream: true } };
const t0 = Date.now();
topicStream.refreshOnce({ listFacts: () => makeFacts([{ text: '测试话题甲', clarity: 'vivid' }]), history: [], now: t0 });
const hintOn = topicStream.topicHintFor(cfgOn, t0);
ok(hintOn.includes('测试话题甲'), '开关开 → 提示词含主题');
ok(hintOn.includes('挑'), '提示词有挑选语义');
eq(topicStream.topicHintFor({ proactive: { topicStream: false } }, t0), '', '开关关 → 空串');
eq(topicStream.topicHintFor(null), '', '无配置不抛');
eq(topicStream.topicHintFor({}, t0), '', '没开 topicStream 不拼');
/* 过期：TTL 之后再查，话题已淘汰 → 不拼 */
eq(topicStream.topicHintFor(cfgOn, t0 + topicStream.TTL_MS + 1), '', '话题过期后不拼');
/* 边界：TTL-1 还在有效期内 */
ok(topicStream.topicHintFor(cfgOn, t0 + topicStream.TTL_MS - 1).includes('测试话题甲'), 'TTL 内仍有效');

section('F. 负对照 1：台账写失败不影响刷新');
/* 把台账路径指到不存在目录的深处 → appendFileSync 抛 ENOENT，被 fail-open 吃掉。
 * ⚠️ 不能直接覆盖 ledgerPath —— 模块内部走局部绑定，覆盖不生效（同 W54 G 段教训）。 */
topicStream.setLedgerPathForTest(path.join(tmp, 'no-such-dir', 'sub', 'ledger.jsonl'));
topicStream.refreshOnce({ listFacts: () => makeFacts([{ text: '坏台账也要用', clarity: 'vivid' }]), history: [], now: Date.now() });
ok(topicStream.getTopics().some((t) => t.text === '坏台账也要用'), '台账写失败主题照常用');
topicStream.setLedgerPathForTest(null);   // 恢复

section('G. 负对照 2：代际令牌（start/stop）');
/* stop 之后旧循环不许再 tick —— 用 onTick 打标记验证。 */
let ticks = 0;
const tok = topicStream.startTopicStream({ refreshMs: 60 * 1000, listFacts: () => [], history: () => [], onTick: () => { ticks++; } });
ok(tok > 0, 'start 返回令牌');
topicStream.stopTopicStream();
topicStream.stopTopicStream();   // 双停不炸
eq(ticks, 0, '低频轮次里 stop 及时拦住（1 分钟间隔，测试不等它 tick）');
/* 重启后旧令牌作废：start 两次，第一个的 onTick 不该被调。 */
let firstTicks = 0, secondTicks = 0;
topicStream.startTopicStream({ refreshMs: 60 * 1000, listFacts: () => [], history: () => [], onTick: () => { firstTicks++; } });
topicStream.startTopicStream({ refreshMs: 60 * 1000, listFacts: () => [], history: () => [], onTick: () => { secondTicks++; } });
eq(firstTicks, 0, '重启后旧流不再 tick');
topicStream.stopTopicStream();

section('H. 配置默认值');
const config = require(path.join(__dirname, '..', 'src', 'main', 'config'));
eq(config.DEFAULT_CONFIG.proactive.topicStream, false, '默认关（主动搭话是打扰向）');

console.log('\nW55: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
