'use strict';
/* W48：proactive 决策 AI —— decision-ai.js 验收。
 *
 * 借 group_chat_plus 的"决策 AI / 回复 AI 分离"（AGPL-3.0 → 只借思想）：
 * 判断"要不要插嘴"走独立的轻量 LLM 调用，不拼完整人设 + 全部记忆 +
 * 全部历史。fail-open：调用失败 / 超时 / 解析失败一律放行。
 *
 * 规矩 28：正对照（silent 拦 / send 放 / 不可用 fail-open）+
 *           负对照（空响应 / 不可解析 / 关键词兜底）。
 *
 * 用法：node debug/verify-w48.js
 */

const path = require('path');
const fs = require('fs');

const decisionAI = require(path.join(__dirname, '..', 'src', 'main', 'decision-ai'));

let pass = 0, fail = 0;
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 实际 ' + a); pass++; }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); pass++; }
function section(t) { console.log('\n[' + t + ']'); }

async function main() {

  /* ---- A. buildDecisionPrompt：轻量上下文 ---- */
  section('A. buildDecisionPrompt 轻量上下文');

  const prompt = decisionAI.buildDecisionPrompt({
    history: [
      { role: 'user', content: '今天加班好累' },
      { role: 'assistant', content: '辛苦了，先歇会儿' },
      { role: 'user', content: '嗯' }
    ],
    idleMinutes: 12,
    edgeHint: 'CPU 95%',
    moodLine: '疲惫',
    fgHint: '正在写代码',
    topics: ['加班', '猫'],
    now: new Date('2026-11-11T14:35:00').getTime()
  });

  eq(prompt.messages.length, 2, '两条消息（system + user）');
  eq(prompt.messages[0].role, 'system', '第一条是 system');
  ok(prompt.messages[0].content.includes('决策器'), 'system 是决策器角色');
  ok(prompt.messages[0].content.includes('silent'), 'system 提示词包含 silent 选项');
  ok(prompt.messages[0].content.includes('send'), 'system 提示词包含 send 选项');

  const userMsg = prompt.messages[1].content;
  ok(userMsg.includes('14:35'), '带当前时间');
  ok(userMsg.includes('12 分钟'), '带闲置时长');
  ok(userMsg.includes('主人'), '历史里 user 角色标为"主人"');
  ok(userMsg.includes('她'), '历史里 assistant 角色标为"她"');
  ok(userMsg.includes('CPU 95%'), '带边缘线索');
  ok(userMsg.includes('疲惫'), '带心境');
  ok(userMsg.includes('正在写代码'), '带前台');
  ok(userMsg.includes('加班'), '带候选话题');
  ok(userMsg.includes('猫'), '带候选话题 2');

  /* 轻量：只带最近 4 条，不拼完整历史 */
  const longHistory = [];
  for (let i = 0; i < 10; i++) longHistory.push({ role: 'user', content: 'msg' + i });
  const prompt2 = decisionAI.buildDecisionPrompt({ history: longHistory, idleMinutes: 5 });
  const histLines = prompt2.messages[1].content.match(/主人：|她：/g) || [];
  eq(histLines.length, 4, '只带最近 4 条对话');

  /* 空历史也能构建 */
  const prompt3 = decisionAI.buildDecisionPrompt({ history: [], idleMinutes: 0 });
  ok(prompt3.messages[1].content.includes('0 分钟'), '空历史也能构建');
  ok(!prompt3.messages[1].content.includes('主人'), '空历史无对话行');

  /* ---- B. parseDecision ---- */
  section('B. parseDecision 解析');

  let r = decisionAI.parseDecision('{"decision":"send"}');
  eq(r.speak, true, 'JSON send → speak');
  r = decisionAI.parseDecision('{"decision":"silent"}');
  eq(r.speak, false, 'JSON silent → 不 speak');
  r = decisionAI.parseDecision('{"decision":"SEND"}');
  eq(r.speak, true, 'JSON 大写 SEND → speak');
  r = decisionAI.parseDecision('{"decision":"SILENT"}');
  eq(r.speak, false, 'JSON 大写 SILENT → 不 speak');

  /* 关键词兜底（不是 JSON 时） */
  r = decisionAI.parseDecision('silent');
  eq(r.speak, false, '纯关键词 silent → 不 speak');
  r = decisionAI.parseDecision('send');
  eq(r.speak, true, '纯关键词 send → speak');
  r = decisionAI.parseDecision('不该开口');
  eq(r.speak, false, '中文"不该" → 不 speak');
  r = decisionAI.parseDecision('可以开口');
  eq(r.speak, true, '中文"可以" → speak');

  /* 负对照：空 / 不可解析 → fail-open */
  r = decisionAI.parseDecision('');
  eq(r.speak, true, '空响应 → fail-open speak');
  ok(r.reason.includes('empty'), '空响应 reason 标记');
  r = decisionAI.parseDecision('完全看不懂的回复');
  eq(r.speak, true, '不可解析 → fail-open speak');
  ok(r.reason.includes('unparsed'), '不可解析 reason 标记');

  /* ---- C. decideSpeak：测试钩子 ---- */
  section('C. decideSpeak 钩子注入');

  /* 钩子返回 silent */
  decisionAI.setDecisionResponderForTest(() => ({ speak: false, reason: 'decision-ai:silent' }));
  const d1 = await decisionAI.decideSpeak({ history: [], llm: { baseUrl: 'http://x', apiKey: 'k', model: 'm' } });
  eq(d1.speak, false, '钩子 silent → 不 speak');
  eq(d1.reason, 'decision-ai:silent', '钩子 silent reason 透传');

  /* 钩子返回 send */
  decisionAI.setDecisionResponderForTest(() => ({ speak: true, reason: 'decision-ai:send' }));
  const d2 = await decisionAI.decideSpeak({ history: [], llm: { baseUrl: 'http://x', apiKey: 'k', model: 'm' } });
  eq(d2.speak, true, '钩子 send → speak');
  eq(d2.reason, 'decision-ai:send', '钩子 send reason 透传');

  /* 钩子抛异常 → fail-open */
  decisionAI.setDecisionResponderForTest(() => { throw new Error('boom'); });
  const d3 = await decisionAI.decideSpeak({ history: [], llm: { baseUrl: 'http://x', apiKey: 'k', model: 'm' } });
  eq(d3.speak, true, '钩子抛异常 → fail-open');

  decisionAI.resetDecisionForTest();

  /* ---- D. decideSpeak：LLM 不可用 → fail-open ---- */
  section('D. decideSpeak LLM 不可用 fail-open');

  /* 空 baseUrl + 空 apiKey → isUsable false → 不发请求直接放行 */
  const d4 = await decisionAI.decideSpeak({
    history: [],
    llm: { baseUrl: '', apiKey: '', model: 'm' }
  });
  eq(d4.speak, true, 'LLM 不可用 → fail-open speak');
  ok(d4.reason.includes('unavailable'), 'LLM 不可用 reason 标记');

  /* ---- E. main.js 源码断言 ---- */
  section('E. main.js 接线断言');

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

  ok(mainSrc.includes("require('./decision-ai')"), 'main.js 导入 decision-ai');
  ok(/proactive\?\.decisionAi === true/.test(mainSrc), 'main.js 检查 decisionAi 开关');
  ok(/decisionAI\.decideSpeak/.test(mainSrc), 'main.js 调用 decideSpeak');
  ok(/decision\.speak/.test(mainSrc), 'main.js 检查 decision.speak');

  /* 决策 AI 在 info-gain 闸之后（shouldProactiveSpeak 在前） */
  const gainIdx = mainSrc.indexOf('shouldProactiveSpeak(gainCtx)');
  const decisionIdx = mainSrc.indexOf('decisionAI.decideSpeak');
  ok(gainIdx > -1 && decisionIdx > gainIdx, 'decideSpeak 在 shouldProactiveSpeak 之后');

  /* 决策 AI 在 bookFirst 之前 */
  const bookIdx = mainSrc.indexOf('bookDelivery({ reason: gain.reason');
  ok(decisionIdx > -1 && bookIdx > -1 && decisionIdx < bookIdx, 'decideSpeak 在 bookFirst 之前');

  /* ---- F. config 默认关 + 托盘 flag ---- */
  section('F. config 默认关 + 托盘 flag');

  const cfgSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
  ok(/decisionAi:\s*false/.test(cfgSrc), 'config 默认关（表外增强）');
  ok(/decisionModel:\s*''/.test(cfgSrc), 'config 默认空（用主模型）');

  ok(/flag\('proactive', 'decisionAi'/.test(mainSrc), '托盘有 decisionAi flag');
  ok(/决策 AI/.test(mainSrc), '托盘 label 含"决策 AI"');

  /* ---- G. 超时常量 ---- */
  section('G. 决策超时（比主对话短）');

  ok(decisionAI.DECISION_TIMEOUT.stallMs < 20000, 'stallMs < 主对话 20s');
  ok(decisionAI.DECISION_TIMEOUT.totalMs < 120000, 'totalMs < 主对话 120s');
  ok(decisionAI.DECISION_TIMEOUT.stallMs >= 1000, 'stallMs >= 1s（合理下限）');
  ok(decisionAI.DECISION_TIMEOUT.totalMs >= decisionAI.DECISION_TIMEOUT.stallMs, 'totalMs >= stallMs');

  /* ---- 汇总 ---- */
  section('汇总');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n❌ ' + (err && err.message || err));
  process.exit(1);
});
