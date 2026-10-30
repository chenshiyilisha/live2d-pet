'use strict';

/* ============================================================
 *  状态台词池（P2）+ 人格招牌状态（P4）
 * ==========================================================
 *
 *  工作态短句 / 久别招呼 —— **不调 LLM**，从池子里抽一句。
 *  纯数据 + 纯函数，verify 可直接 node 跑。
 *
 *  P4 减法：每套人格只强化 idle / working / success / error 四档，
 *  不扩到 8 情绪分池。套用人设预设后 workLine(…, personaId) 走招牌句。
 * ========================================================== */

const WORK_LINES = Object.freeze({
  success: Object.freeze(['搞定啦 ✓', '好了。', '弄完了。', '成了。']),
  error: Object.freeze(['出了点问题…', '这轮没成。', '卡住了。', '嗯，不太对。']),
  thinking: Object.freeze(['想一下…', '嗯…', '让我想想。']),
  working: Object.freeze(['在弄…', '稍等。', '动手。']),
  idle: Object.freeze(['还在。', '嗯。', '待机中。'])
});

/* 久别（主动搭话旁路）：主人很久没来时，离线也能说。
 * ⚠️ 与渲染层 PROACTIVE_LINES（按情绪分池）互补 —— 这里是「久别」专用。 */
const FAREWELL_LINES = Object.freeze([
  '你回来了。',
  '好久没见。',
  '还在呢。',
  '嗯，你来了。'
]);

/* P4：人格 → 四档招牌句（idle/working/success/error）。
 * 缺档回落 WORK_LINES；default 故意不写 = 用通用池。 */
const SIGNATURE_LINES = Object.freeze({
  tsundere: Object.freeze({
    idle: Object.freeze(['……还在看啊。', '才没有等你。']),
    working: Object.freeze(['哼，帮你弄一下。', '别催。']),
    success: Object.freeze(['成了。才不是为了你。', '好了啦。']),
    error: Object.freeze(['啧，卡住了。', '……这轮算我失误。'])
  }),
  genki: Object.freeze({
    idle: Object.freeze(['随时待命！', '你忙你的～']),
    working: Object.freeze(['上了上了！', '交给我！']),
    success: Object.freeze(['搞定！', '漂亮！']),
    error: Object.freeze(['哎呀卡住了，再来。', '这轮没成，换招！'])
  }),
  airhead: Object.freeze({
    idle: Object.freeze(['欸……我在。', '嗯？啊，还在。']),
    working: Object.freeze(['想……想一下……', '我在弄……大概。']),
    success: Object.freeze(['欸，好了？', '好像成了。']),
    error: Object.freeze(['咦，坏掉了？', '不对劲……'])
  }),
  kuudere: Object.freeze({
    idle: Object.freeze(['在。', '嗯。']),
    working: Object.freeze(['处理中。', '等。']),
    success: Object.freeze(['好了。', '完成。']),
    error: Object.freeze(['失败。', '不行。'])
  }),
  gentle: Object.freeze({
    idle: Object.freeze(['我在这儿。', '不着急。']),
    working: Object.freeze(['我来慢慢弄。', '稍等一下下。']),
    success: Object.freeze(['好了哦。', '弄完啦。']),
    error: Object.freeze(['这轮不太顺利……', '没关系，我们再试。'])
  }),
  cool: Object.freeze({
    idle: Object.freeze(['待命。', '继续。']),
    working: Object.freeze(['执行中。', '处理。']),
    success: Object.freeze(['完成。', '通过。']),
    error: Object.freeze(['失败，看日志。', '未通过。'])
  })
});

/* P4：人格 → 工作态表情偏置（success/error）。缺则渲染层用默认 happy/serious。 */
const SIGNATURE_EMO = Object.freeze({
  tsundere: Object.freeze({ success: 'shy', error: 'serious' }),
  genki: Object.freeze({ success: 'happy', error: 'surprised' }),
  airhead: Object.freeze({ success: 'smile', error: 'think' }),
  kuudere: Object.freeze({ success: 'calm', error: 'serious' }),
  gentle: Object.freeze({ success: 'smile', error: 'shy' }),
  cool: Object.freeze({ success: 'calm', error: 'serious' })
});

function pick(pool, rand = Math.random, fallback = '') {
  const list = Array.isArray(pool) ? pool.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) return fallback;
  const i = Math.floor(rand() * list.length) % list.length;
  return list[i];
}

function workLine(kind, rand = Math.random, personaId) {
  const id = String(personaId || '').trim();
  const sig = id && SIGNATURE_LINES[id] ? SIGNATURE_LINES[id][kind] : null;
  if (sig && sig.length) {
    return pick(sig, rand, '');
  }
  const pool = WORK_LINES[kind];
  const fallback =
    kind === 'success' ? '搞定啦 ✓' :
    kind === 'error' ? '出了点问题…' :
    kind === 'thinking' ? '想一下…' :
    kind === 'working' ? '在弄…' :
    kind === 'idle' ? '还在。' : '';
  return pick(pool, rand, fallback);
}

function signatureEmo(personaId, kind) {
  const id = String(personaId || '').trim();
  const map = SIGNATURE_EMO[id];
  if (!map) return '';
  return map[kind] || '';
}

function farewellLine(rand = Math.random) {
  return pick(FAREWELL_LINES, rand, '你回来了。');
}

module.exports = {
  WORK_LINES,
  FAREWELL_LINES,
  SIGNATURE_LINES,
  SIGNATURE_EMO,
  pick,
  workLine,
  signatureEmo,
  farewellLine
};
