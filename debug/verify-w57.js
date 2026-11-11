'use strict';
/* W57：决策级回滚标记——topic-stream.js 的 accepted/rejected 验收。
 *
 * 借 deja-vu（§22.3，MIT）思想：模型判定沉默 = 对候选主题投否决票，
 * 标记"已回滚"，下次刷新不再推荐。与 W49（事实级矛盾）互补——这是决策级。
 *
 * 规矩 28：正对照（标记/过滤/去重/截断/持久化）+
 * 负对照（开关关着不过滤 / 空文本不标记 / 写失败不影响主流程）。
 *
 * 用法：node debug/verify-w57.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

/* ---- electron 桩：topic-stream 只要 app.getPath ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w57-'));
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
function depsOf(facts, history, extra = {}) {
  return { listFacts: () => facts, history: history || [], now: Date.now(), ...extra };
}

section('A. 标记与查询');
topicStream.resetRejectedForTest();
eq(topicStream.markRejected('话题甲'), true, '首次标记成功');
eq(topicStream.markRejected('话题甲'), false, '重复标记去重');
eq(topicStream.isRejected('话题甲'), true, 'isRejected 命中');
eq(topicStream.markRejected('  话题甲  '), false, 'trim 后去重（带空白再标记视为同一条）');
eq(topicStream.markRejected(''), false, '空文本不标记');
eq(topicStream.markRejected(null), false, 'null 不标记');
eq(topicStream.markRejected(undefined), false, 'undefined 不标记');
eq(topicStream.markRejected('  '), false, '纯空白不标记');
eq(topicStream.isRejected('话题乙'), false, '未标记的不命中');

section('B. buildTopics 过滤：开关开才过滤');
topicStream.resetRejectedForTest();
topicStream.markRejected('话题甲');
const facts = makeFacts([
  { text: '话题甲', clarity: 'vivid' },
  { text: '话题乙', clarity: 'vivid' }
]);
/* 开关关（rollback 未传 / false）：照常返回 */
const tOff = topicStream.buildTopics(depsOf(facts, []));
eq(tOff.length, 2, '开关关 → 包含已回滚话题');
/* 开关开：过滤 */
const tOn = topicStream.buildTopics(depsOf(facts, [], { rollback: true }));
eq(tOn.length, 1, '开关开 → 过滤掉已回滚话题');
eq(tOn[0].text, '话题乙', '保留未回滚的');

section('C. 持久化：重启后回滚集合还在');
topicStream.resetRejectedForTest();
topicStream.markRejected('持久化话题A');
topicStream.markRejected('持久化话题B');
/* 模拟重启：清内存 → 重新加载 */
topicStream.resetRejectedForTest();
topicStream.loadRejected();
eq(topicStream.isRejected('持久化话题A'), true, '重启后 A 还在');
eq(topicStream.isRejected('持久化话题B'), true, '重启后 B 还在');
/* 文件确实落盘 */
const rejectedFile = path.join(tmp, 'proactive-rejected.json');
ok(fs.existsSync(rejectedFile), '回滚集合落盘');
const arr = JSON.parse(fs.readFileSync(rejectedFile, 'utf8'));
ok(arr.includes('持久化话题A') && arr.includes('持久化话题B'), '文件里有两条');

section('D. 截断：最多 REJECTED_MAX 条');
topicStream.resetRejectedForTest();
for (let i = 0; i < 30; i++) topicStream.markRejected('bulk-' + i);
const all = topicStream._debug().rejected;
eq(all.length, 20, '截断到 20 条');
eq(all[19], 'bulk-29', '保留的是最新的');
eq(topicStream.isRejected('bulk-0'), false, '最早的被挤掉');

section('E. refreshOnce 走过滤路径');
topicStream.resetRejectedForTest();
topicStream.markRejected('过滤话题');
const refreshed = topicStream.refreshOnce(depsOf(
  makeFacts([{ text: '过滤话题', clarity: 'vivid' }, { text: '正常话题', clarity: 'vivid' }]),
  [],
  { rollback: true }
));
eq(refreshed.length, 1, 'refreshOnce 也过滤');
eq(refreshed[0].text, '正常话题', 'refreshOnce 保留正常话题');

section('F. 负对照：写失败不影响标记返回值');
/* 把回滚文件路径指到"文件下面的路径"，mkdir 必然 ENOTDIR → saveRejected 失败。 */
topicStream.resetRejectedForTest();
fs.writeFileSync(path.join(tmp, 'blocked'), 'x');
topicStream.setRejectedPathForTest(path.join(tmp, 'blocked', 'sub', 'proactive-rejected.json'));
eq(topicStream.markRejected('写失败也要标'), true, '写失败仍返回 true');
eq(topicStream.isRejected('写失败也要标'), true, '内存里标记生效');
topicStream.setRejectedPathForTest(null);  // 恢复，别污染后续

section('G. 汇总');
console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail > 0 ? 1 : 0);
