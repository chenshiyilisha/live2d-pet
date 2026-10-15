'use strict';

/* ============================================================
 *  防复读护栏（variety guard）
 *
 * 出处：竞品调研第 6 轮的 ①（Nexus 的 `v2/repetitionGuard.ts`），
 * 见 docs/open-source-reference.md。它的定位一句话说清了：
 *
 *   > Layered on top of personaGuardrail (which checks fidelity to the character).
 *   > This module checks fidelity to *variety*.
 *
 * 护栏分两层：**人设护栏管「像不像她」**（我们写在 system prompt 里的禁令，
 * 以及 main.js 里对 tone() 的统计），**复读护栏管「像不像人」**。两者不重叠 ——
 * llm.js 的 `createOpenerStripper` 是**删掉**开头的填充词（清理），
 * 这里是**提示她换个说法**（引导）。
 *
 * 为什么需要它：记忆里那条「说话变短 / 复读 = 删 chat-history.json」描述的就是
 * 这个症状 —— 历史一长，模型开始抄自己上一句的句式，几句下来全是同一个味。
 * 删历史确实能好，代价是她刚知道的事也一起忘了。这个护栏是更便宜的那半边：
 * **不改历史、不调模型**，只把「你最近几句太像了，具体像在哪」作为一条 system
 * 提示插进这一轮请求（注入点在 main.js 的 chatStream）。
 *
 * 纯字符串分析、零依赖、零状态 —— 所以 verify 里直接喂数组真跑。
 *
 * ⚠️ 判据刻意保守：样本不足宁可不报。误报的代价是**每一轮都往 prompt 里塞
 *    一段没必要的指令**，那比不报更糟（会让她的语气被"别复读"这件事带跑）。
 * ========================================================== */

/* 只看最近几条。取 6，和主动搭话带的历史条数同一个口径 ——
 * 再往前的回复跟"这一轮该怎么说"已经没关系了。 */
const REPEAT_WINDOW = 6;

/* 少于 3 条不判：两条里撞上同一个开头太正常了（"嗯"、"好"），
 * 样本不足时看到的"重复"基本都是噪声。 */
const MIN_SAMPLES = 3;

/* 同一个开头 / 结尾出现 2 次就算"她开始复读了"。 */
const REPEAT_MIN = 2;

const OPENING_LEN = 2;
const ENDING_LEN = 4;

/* 所有回复长度都落在均值 ±20% 内 = "说的话总一样长"，很假（Nexus 的口径）。 */
const LENGTH_BAND = 0.2;

/* 标点：带 ≥2 个该标点的回复占比 ≥ 50% 才算 ——
 * 一句里有个"！"不算什么，整段都靠"！"撑情绪才是问题。 */
const PUNCT_MIN_COUNT = 2;
const PUNCT_RATIO = 0.5;
const PUNCT_MARKS = ['!', '！', '?', '？', '…', '~', '～'];

/* 每条提示里最多列几个"别用 X"。列太多提示本身就成了噪声。 */
const MAX_ITEMS = 3;

/** 一条文本里某个字符出现几次（按码点遍历 —— 别用 length 数，emoji 会算重）。 */
function countChar(s, ch) {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * 去掉末尾的标点与空白。
 * "话是怎么收的"指的是**字**，不是标点 ——「我记着呢！」和「我记着呢」是同一个结尾。
 */
function stripTailPunct(s) {
  return String(s == null ? '' : s)
    .trim()
    .replace(/[\s。．.!！?？…~～、，,；;：:）)】」』"'’”]+$/u, '');
}

/** 按 pick 取键计数。pick 返回空串 = 这条不参与这一项统计。 */
function tally(list, pick) {
  const m = new Map();
  for (const item of list) {
    const k = pick(item);
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** 出现次数 ≥ REPEAT_MIN 的键（Map 保持插入顺序，所以同次数时是最早出现的在前）。 */
function repeatedKeys(counter) {
  return [...counter.entries()].filter(([, n]) => n >= REPEAT_MIN).map(([k]) => k);
}

/**
 * 扫最近几条回复，找出"结构性重复"。
 *
 * @param {string[]} replies 最近的 assistant 回复，**旧的在前、新的在后**
 * @returns {{findings: Array<{kind:string,text:string}>, hint: string}}
 *   findings 给日志（哪一类命中），hint 是要插进 prompt 的那条 system 提示
 *   （空串 = 没什么好说的，调用方就**不要**插）。
 */
function analyzeRepetition(replies, opts = {}) {
  const minSamples = Number.isFinite(opts.minSamples) ? opts.minSamples : MIN_SAMPLES;
  const list = (Array.isArray(replies) ? replies : [])
    .filter((r) => typeof r === 'string')
    .map((r) => r.trim())
    .filter(Boolean);

  const findings = [];
  if (list.length < minSamples) return { findings, hint: '' };

  /* ① 同样的开头（两个字）。人开口的惯性最难改，也最容易被看出来。 */
  const opens = repeatedKeys(tally(list, (r) => (r.length >= OPENING_LEN ? r.slice(0, OPENING_LEN) : '')));
  if (opens.length) {
    const top = opens.slice(0, MAX_ITEMS);
    findings.push({ kind: 'opening', items: top, text: `别再用「${top.join('」「')}」开头` });
  }

  /* ② 同样的结尾（去尾标点后的最后四个字）。 */
  const ends = repeatedKeys(tally(list, (r) => {
    const core = stripTailPunct(r);
    return core.length >= ENDING_LEN ? core.slice(-ENDING_LEN) : '';
  }));
  if (ends.length) {
    const top = ends.slice(0, MAX_ITEMS);
    findings.push({ kind: 'ending', items: top, text: `别老拿「${top.join('」「')}」收尾` });
  }

  /* ③ 长度单调：每一条都差不多长。 */
  const lens = list.map((r) => r.length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (mean > 0 && lens.every((n) => Math.abs(n - mean) / mean <= LENGTH_BAND)) {
    findings.push({
      kind: 'length',
      mean: Math.round(mean),
      text: `最近每条都是 ${Math.round(mean)} 字上下，这次长短随便点`
    });
  }

  /* ④ 标点密度：某个标点的使用密度跟前面几条一样。 */
  const marks = PUNCT_MARKS.filter((p) =>
    list.filter((r) => countChar(r, p) >= PUNCT_MIN_COUNT).length / list.length >= PUNCT_RATIO);
  if (marks.length) {
    findings.push({ kind: 'punct', items: marks, text: `「${marks.join('」「')}」用得跟前面一样密，收着点` });
  }

  return { findings, hint: buildHint(findings) };
}

/** 把 findings 拼成一条 system 提示。空 findings → 空串（调用方据此跳过注入）。 */
function buildHint(findings) {
  if (!Array.isArray(findings) || !findings.length) return '';
  /* 结尾那句"别解释这句话"是必须的：不说的话模型会用"好的，我换个说法"来回应
   * 这条提示 —— 用户看到的是一句莫名其妙的元对话。 */
  return `【换个说法：你最近几句太像了（${findings.map((f) => f.text).join('；')}）。` +
    '只是变个花样，人设不变，别解释这句话。】';
}

module.exports = {
  analyzeRepetition,
  buildHint,
  stripTailPunct,
  REPEAT_WINDOW,
  MIN_SAMPLES,
  REPEAT_MIN,
  OPENING_LEN,
  ENDING_LEN,
  LENGTH_BAND,
  PUNCT_MIN_COUNT,
  PUNCT_RATIO,
  PUNCT_MARKS,
  MAX_ITEMS
};
