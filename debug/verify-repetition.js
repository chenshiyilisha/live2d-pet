'use strict';
/* 防复读护栏（src/main/repetition-guard.js）的验收。
 *
 * 这个模块全是纯字符串分析，所以**真跑**（直接 require，不用正则看长相）。
 * 坏的后果是两头的：
 *   · 该报不报 → 她又开始复读，用户只能去删 chat-history.json（就是我们要治的）；
 *   · 不该报乱报 → **每一轮都往 prompt 里塞一段指令**，她的语气被"别复读"带跑。
 * 所以下面的用例两半都要有：命中的、以及**不许命中**的。
 *
 * 分四块：
 *   A. 四个维度的判据本身（各自单独命中 / 各自的边界 / 不许误报）
 *   B. hint 的形态（拼装、空 findings 不产生提示）
 *   C. 主进程接线（取哪几条、注入位置、与媒体背景的先后、只此一处）
 *   D. 配置（默认开、不进托盘）
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-repetition.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  ✅ ' + msg); return; }
  failures++;
  console.log('  ❌ ' + msg);
};

const G = require(path.join(ROOT, 'src/main/repetition-guard.js'));
const { analyzeRepetition, buildHint, stripTailPunct } = G;

/** 有没有命中某一类。 */
const hasKind = (r, kind) => r.findings.some((f) => f.kind === kind);
const kinds = (r) => r.findings.map((f) => f.kind).join(',');

/* 造一条长度恰好 n 的假回复，且**开头 2 字与结尾 4 字都由 tag 决定**。
 * 专测"长度"那一项时用：不会顺手把开头/结尾那两项也撞响。 */
const CH = '甲乙丙丁戊己庚辛壬癸';
function mk(n, tag) {
  const head = (tag + CH).slice(0, 2);
  const tail = (CH + tag).slice(-4);
  const mid = '的'.repeat(Math.max(0, n - head.length - tail.length));
  return head + mid + tail;
}

/* ============================================================
 *  A. 四个维度
 * ========================================================== */
console.log('\n══════ A. 四个维度的判据 ══════\n');

{
  /* ① 同样开头 */
  const hit = analyzeRepetition(['嗯嗯，我知道啦', '嗯嗯，那好吧', '今天天气不错，出去走走会比较舒服一点']);
  ok(hasKind(hit, 'opening'), '两条同一个开头 → 命中 opening');
  ok(hit.findings.find((f) => f.kind === 'opening').items.includes('嗯嗯'), '报告里点名是「嗯嗯」');

  const miss = analyzeRepetition(['嗯，我知道啦', '好，那好吧', '今天天气不错，出去走走会比较舒服一点']);
  ok(!hasKind(miss, 'opening'), '三条开头各不相同 → 不命中（不许乱报）');

  /* 只有一条短到取不出两个字：不参与这一项，但**不影响**其它条 */
  const oneShort = analyzeRepetition(['嗯嗯，好', '嗯嗯，行', '哦']);
  ok(hasKind(oneShort, 'opening'), '过短的那条只是不参与，剩下两条照样能判出来');
}

{
  /* ② 同样结尾 */
  const hit = analyzeRepetition(['今天有点忙，我先记着呢', '外面下雨了，我先记着呢', '你先忙吧']);
  ok(hasKind(hit, 'ending'), '两条同一个结尾 → 命中 ending');
  ok(hit.findings.find((f) => f.kind === 'ending').items.includes('先记着呢'),
    '结尾按**最后四个字**比（「我先记着呢」→ 取「先记着呢」）');

  /* 尾标点不算差异：「我记着呢！」和「我记着呢。」是同一个结尾 */
  const tail = analyzeRepetition(['今天有点忙，我先记着呢！', '外面下雨了，我先记着呢。', '你先忙吧']);
  ok(hasKind(tail, 'ending'), '只差一个尾标点也算同一个结尾（标点先剥掉）');

  const miss = analyzeRepetition(['今天有点忙，我先记着呢', '外面下雨了，回头再说吧', '你先忙吧']);
  ok(!hasKind(miss, 'ending'), '结尾不同 → 不命中');
}

{
  /* ③ 长度单调 */
  const hit = analyzeRepetition([mk(6, 'A'), mk(6, 'B'), mk(6, 'C')]);
  ok(hasKind(hit, 'length'), '三条一样长 → 命中 length');
  ok(!hasKind(hit, 'opening') && !hasKind(hit, 'ending'), '长度那条**不会**顺手把开头/结尾撞响');

  /* 边界：正好 20% —— 判据是 `<= 0.2`，8/12 相对均值 10 恰好 20% → 命中 */
  const edge = analyzeRepetition([mk(8, 'A'), mk(12, 'B'), mk(10, 'C')]);
  ok(hasKind(edge, 'length'), '边界：都落在 ±20%（含）→ 命中');

  /* 刚过 20%：8 相对均值 10.5 差 23.8% → 不命中 */
  const over = analyzeRepetition([mk(8, 'A'), mk(13, 'B'), mk(10, 'C')]);
  ok(!hasKind(over, 'length'), '超出 ±20% → 不命中');

  const varied = analyzeRepetition([mk(6, 'A'), mk(20, 'B'), mk(40, 'C')]);
  ok(!hasKind(varied, 'length'), '长短不一（真实对话的样子）→ 不命中');
}

{
  /* ④ 标点密度 */
  const hit = analyzeRepetition(['太好了！！', '真棒！！', '嗯，知道了']);
  ok(hasKind(hit, 'punct'), '半数以上每条都带 ≥2 个「！」→ 命中 punct');

  const weak = analyzeRepetition(['太好了！', '真棒！！', '嗯，知道了']);
  ok(!hasKind(weak, 'punct'), '只有一条够 2 个 → 不命中（单个「！」是正常语气）');

  const few = analyzeRepetition(['太好了！！', '真棒！！', '嗯，知道了', '先这样吧']);
  ok(hasKind(few, 'punct'), '4 条里 2 条 = 占比 0.5 恰好达标 → 命中（含）');

  const rare = analyzeRepetition(['太好了！！', '真棒', '嗯，知道了', '先这样吧']);
  ok(!hasKind(rare, 'punct'), '4 条里 1 条 = 0.25 → 不命中');
}

{
  /* 四项全命中时的顺序（opening → ending → length → punct）。顺序本身不重要，
   * 但**必须稳定** —— 日志和 hint 都按它排。 */
  const all = analyzeRepetition([
    '好吧，我全知道了！！', '好吧，我全知道了！！', '好吧，我全知道了！！'
  ]);
  ok(kinds(all) === 'opening,ending,length,punct', `四项能同时命中，顺序稳定（实得 ${kinds(all)}）`);
  ok(all.findings.length === 4, '不会重复报同一类');
}

{
  /* 样本不足：这是**最重要的一条不报**——两条里撞同一个开头太正常了 */
  ok(analyzeRepetition([]).findings.length === 0, '空数组 → 不报');
  ok(analyzeRepetition(['嗯嗯', '嗯嗯']).findings.length === 0, '两条（< 3）→ 一律不报，不管多像');
  ok(analyzeRepetition(['嗯嗯，好', '嗯嗯，行', '嗯嗯', '嗯嗯']).hint !== '', '到 3 条就开始判');

  /* 脏输入不许炸（messages 是渲染层传上来的，形状不可信） */
  const dirty = analyzeRepetition([null, 42, {}, '  ', '嗯嗯，好', '嗯嗯，行', '嗯嗯']);
  ok(hasKind(dirty, 'opening'), '非字符串 / 空白条目被过滤掉，剩下的照判');
  ok(analyzeRepetition(null).hint === '' && analyzeRepetition(undefined).hint === '',
    'null / undefined 不抛，直接当没有');

  /* minSamples 可调（只为测试留口子，默认值不变） */
  ok(analyzeRepetition(['嗯嗯', '嗯嗯'], { minSamples: 2 }).findings.length > 0,
    'minSamples 参数生效（默认仍是 3）');
  ok(G.MIN_SAMPLES === 3 && G.REPEAT_MIN === 2, '默认口径：≥3 条样本、≥2 次重复');
}

{
  /* stripTailPunct 本身 */
  ok(stripTailPunct('我记着呢！') === '我记着呢', '剥尾标点');
  ok(stripTailPunct('我记着呢...') === '我记着呢', '剥省略号（英文三点）');
  ok(stripTailPunct('我记着呢」') === '我记着呢', '剥收尾引号');
  ok(stripTailPunct('  我记着呢  ') === '我记着呢', '剥空白');
  ok(stripTailPunct('') === '' && stripTailPunct(null) === '', '空值不抛');
  ok(stripTailPunct('我记着呢') === '我记着呢', '本来就没有尾标点时原样返回');
}

/* ============================================================
 *  B. hint 的形态
 * ========================================================== */
console.log('\n══════ B. hint ══════\n');

{
  ok(buildHint([]) === '', '空 findings → 空串（调用方据此**不插** system）');
  ok(buildHint(null) === '', 'null 也返回空串');

  const r = analyzeRepetition(['嗯嗯，我知道啦', '嗯嗯，那好吧', '今天天气不错，出去走走会比较舒服一点']);
  ok(r.hint.includes('换个说法'), 'hint 是"提示她换"，不是"批评"');
  ok(r.hint.includes('别再用「嗯嗯」开头'), 'hint 里点名具体是哪一项（模型才知道要改什么）');
  ok(r.hint.includes('别解释这句话'), '🔴 结尾禁止元对话（否则她会回一句"好的我换个说法"）');
  ok(r.hint.length < 160, `hint 不长（实测 ${r.hint.length} 字）—— 它每轮都进 prompt`);
  ok(r.hint.startsWith('【') && r.hint.endsWith('】'),
    '包在【】里 —— 和 media 那条背景信息同一套视觉约定');
}

/* ============================================================
 *  C. 主进程接线
 * ========================================================== */
console.log('\n══════ C. 主进程接线 ══════\n');

const MAIN = read('src/main/main.js');

{
  ok(/require\('\.\/repetition-guard'\)/.test(MAIN), 'main.js 引入了 repetition-guard');
}

/* 把两个注入函数 + varietyHint 切出来真跑（都是纯函数，不碰窗口）。
 * console 换成收集器，顺便验'命中时会记一条日志'。
 *
 * ⚠️ 源码是 CRLF：先归一化，否则 `'\n}\n'` 这种标记永远找不到 ——
 *    找不到时**返回空串**（不是"切到文件末尾"），切片失败会当场由断言喊出来。 */
{
  const MAINN = MAIN.replace(/\r\n/g, '\n');
  const between = (src, from, to) => {
    const i = src.indexOf(from);
    if (i < 0) return '';
    const j = src.indexOf(to, i + from.length);
    return j < 0 ? '' : src.slice(i, j + to.length);
  };
  const logs = [];
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(' ')), warn: () => {} },
    analyzeRepetition,
    REPEAT_WINDOW: G.REPEAT_WINDOW
  };
  vm.createContext(sandbox);
  const src =
    between(MAINN, 'function varietyHint(', '\n}\n') + '\n' +
    between(MAINN, 'function injectVarietyHint(', '\n}\n') + '\n' +
    between(MAINN, 'function injectMediaContext(', '\n}\n') +
    '\n;globalThis.__api = { varietyHint, injectVarietyHint, injectMediaContext };';
  vm.runInContext(src, sandbox);
  const { varietyHint, injectVarietyHint, injectMediaContext } = sandbox.__api;

  ok(typeof varietyHint === 'function' && typeof injectVarietyHint === 'function' &&
    typeof injectMediaContext === 'function', '三个函数都切出来了');

  /* 取哪几条：只看 assistant，且只取最近 REPEAT_WINDOW 条 */
  const rep = (t) => ({ role: 'assistant', content: t });
  const usr = (t) => ({ role: 'user', content: t });
  const persona = { role: 'system', content: '你是 Ayan' };

  /* 窗口内 6 条：互不重复 + 长短不一 → 干净的对照组 */
  const CLEAN = [mk(6, 'A'), mk(9, 'B'), mk(14, 'C'), mk(20, 'D'), mk(27, 'E'), mk(35, 'F')];
  const cleanMsgs = [persona, usr('在吗'), ...CLEAN.map(rep), usr('怎么说')];
  ok(varietyHint(cleanMsgs, true) === '', '窗口内 6 条各不相同、长短不一 → 不报（对照组）');

  /* 同一批，但把其中一条换成和第 1 条一样 → 必须报 */
  const dup = CLEAN.slice();
  dup[4] = mk(6, 'A');
  const dupMsgs = [persona, usr('在吗'), ...dup.map(rep), usr('怎么说')];
  ok(varietyHint(dupMsgs, true).length > 0, '窗口内出现重复 → 报');

  logs.length = 0;
  varietyHint(dupMsgs, true);
  ok(logs.some((l) => l.includes('[chat] 复读护栏')), '命中时记一条日志（带是哪一类）');

  /* 反向：重复只出现在**窗口之外**，窗口内是干净的 → 不许报 */
  const outsideMsgs = [
    persona, usr('在吗'),
    rep('嗯嗯，甲'), rep('嗯嗯，甲'),           // 这两条会被窗口切掉
    ...CLEAN.map(rep),
    usr('怎么说')
  ];
  ok(varietyHint(outsideMsgs, true) === '',
    '🔴 只看**最近 6 条**：窗口外的重复不算（拿老句式判今天的说法会一直误报）');
  ok(G.REPEAT_WINDOW === 6, '窗口就是 6 条（和主动搭话带的历史同一个口径）');

  /* user 的话不参与（她复读复的是自己，不是用户） */
  const noisyUser = [
    persona,
    usr('嗯嗯，那我先走了'),
    usr('嗯嗯，你忙你的'),
    rep(mk(6, 'A')), rep(mk(9, 'B')), rep(mk(14, 'C'))
  ];
  ok(varietyHint(noisyUser, true) === '', '用户自己的重复不算');

  /* 开关 */
  ok(varietyHint(dupMsgs, false) === '', 'chat.varietyGuard = false → 直接不判（不看内容）');
  ok(varietyHint(dupMsgs, undefined).length > 0, '缺这个键（老配置）→ 当开');

  /* 注入：纯函数、位置、空 hint 不插 */
  const base = [persona, { role: 'user', content: '在吗' }];
  const injected = injectVarietyHint(base, 'HINT');
  ok(base.length === 2, '🔴 不原地改传入的数组（纯函数，好测）');
  ok(injected.length === 3, '多出一条 system');
  ok(injected[0] === persona && injected[1].role === 'system' && injected[1].content === 'HINT',
    '插在**第二位**（紧跟人设）');
  ok(injected[2] === base[1], '原来的历史整体后移，没有被顶掉');
  ok(injectVarietyHint(base, '').length === 2, '空 hint → 不插空 system');
  ok(injectVarietyHint([], 'HINT').length === 1, '空 messages 也不抛');

  /* 🔴 与媒体背景的先后：chatStream 里媒体在外层，于是媒体在第二位、复读在第三位 */
  const composed = injectMediaContext(injectVarietyHint(base, 'HINT'), 'MEDIA');
  ok(composed.length === 4, '两条上下文都插上了');
  ok(composed[1].content === 'MEDIA' && composed[2].content === 'HINT',
    '🔴 结果是 [人设, 媒体背景, 复读提示, ...历史] —— 媒体保持"紧跟人设"的语义');
  ok(composed[3].role === 'user', '用户那句话仍在最后（后面不许再追加 system）');
}

{
  /* chatStream 的组合方式（源码级，防止有人把顺序写反）。
   * 2026-10-22 心境层加进来后最外层多套一层 injectMoodContext ——
   * 这条断言测的仍是**媒体与复读**的内层组合（媒体必须套着复读 =
   * 媒体在两者中更靠外），mood 层的顺序归 verify-mood 管。 */
  const cs = MAIN.slice(MAIN.indexOf('function chatStream('), MAIN.indexOf('function registerIpc('));
  ok(/injectMediaContext\(\s*injectVarietyHint\(messages, varietyHint\(messages, cfg\.chat\?\.varietyGuard !== false\)\),\s*mediaContextLine\(\)\s*\)/.test(cs),
    'chatStream 里媒体在外层、复读在内层（顺序写反 → 媒体就不是"紧跟人设"了）');
  ok(/injectMoodContext\(\s*injectMediaContext\(/.test(cs),
    '心境人话套在最外层（verify-mood 的职责范围，这里顺带钉住别拆散）');
  ok(/streamLLM\(withContext,/.test(cs), 'streamLLM 收到的是拼好的上下文');
  ok((MAIN.match(/injectVarietyHint\(/g) || []).length === 2,
    '注入点**只有一处**（一次定义 + 一次调用）—— 对话和主动搭话两条路共用 chatStream');
  ok(!/chat:send[\s\S]{0,400}injectVarietyHint/.test(MAIN), 'chat:send 里没有第二处自己注入');
}

/* ============================================================
 *  D. 配置
 * ========================================================== */
console.log('\n══════ D. 配置 ══════\n');

{
  const CFG = read('src/main/config.js');
  const seg = CFG.slice(CFG.indexOf('chat: {'), CFG.indexOf('tts: {'));
  ok(seg.length > 0, '切到了 chat 段');
  ok(/varietyGuard:\s*true/.test(seg), '默认**开**（纯字符串分析，零成本；治的是用户真能感觉到的复读）');

  /* 参数型开关：进配置文件、不进托盘（规矩 5：菜单要短） */
  ok(!/'varietyGuard'/.test(MAIN), "托盘 / 开关表里没有它（键名带引号的地方都不该出现）");
  ok((MAIN.match(/cfg\.chat\?\.varietyGuard/g) || []).length === 1,
    'main.js 只有一处读它（chatStream 那次）');

  /* 开关关掉时不能"点了没反应"：这里是配置文件字段，不存在菜单入口 → 无需额外断言 */
  ok(/chat\?\.varietyGuard !== false/.test(MAIN),
    '缺键当开（老配置不会因为我们加了这个键而突然变样）');
}

/* ============================================================ */
console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（防复读护栏）');
