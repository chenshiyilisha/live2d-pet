import { State } from './params.js';

/* ============================================================
 *  语音朗读
 * ==========================================================
 *
 * 用 Chromium 内置的 speechSynthesis —— Windows 上就是系统 SAPI，
 * 零依赖、纯离线，不用装任何东西。音色取决于系统装了哪些语音包，
 * 中文 Windows 一般有 Microsoft Huihui / Yaoyao。
 * 想要更好听的音色（晓晓这类神经语音）再换 edge-tts，接口是同一个。
 *
 * 🔴 两种念法，别混（混了的后果是"念一半被掐掉"或"整段念两遍"）：
 *   · `speak(text)`     —— **打断式**：清空队列、掐掉正在念的，立刻念这一条。
 *                          给"说一句就走"的场景：提醒、摸头抗议、离线短句池。
 *   · `enqueueSpeech()` —— **排队式**：追加到队尾，一条念完接着下一条。
 *                          给流式回复：边生成边念（见下面「边收边念」）。
 * ========================================================== */

/* 外部依赖注入：配置、当前状态、是否忙碌、以及状态机的入口。
 * 这几个都在 pet.js 手里，用 getter 注入 —— 注意不能传值快照，
 * state / busy 每帧都在变。 */
let deps = {
  getCfg: () => null,
  getState: () => '',
  isBusy: () => false,
  setState: () => {},
  /* 全屏静默中（主进程判定你在打游戏 / 全屏看片）。
   * ⚠️ 拦在 speak() / enqueueSpeech() 这两个**唯一出口**上，而不是在调用处
   *    逐个判断：念白有好几个来源（对话回复、主动搭话、定时提醒、摸头吐槽…），
   *    靠每一处自己记得判断，早晚会漏一个 —— 而"漏一个"的表现就是
   *    打游戏时角色突然开口说话，正是这个功能要消灭的东西。 */
  isQuiet: () => false
};
export function configureTTS(d) { Object.assign(deps, d); }

let ttsVoice = null;
let ttsReady = false;

export function initTTS() {
  if (typeof speechSynthesis === 'undefined') {
    console.warn('[pet] speechSynthesis 不可用，语音朗读关闭');
    return;
  }
  const pick = () => {
    const all = speechSynthesis.getVoices() || [];
    const zh = all.filter((v) => /^zh|Chinese|中文|Huihui|Yaoyao|Xiaoxiao/i.test(`${v.lang} ${v.name}`));
    ttsVoice = zh.find((v) => /Xiaoxiao|Natural|Yunxi/i.test(v.name)) || zh[0] || all[0] || null;
    ttsReady = all.length > 0;
    console.log('[pet] tts 可用音色', JSON.stringify({
      total: all.length,
      picked: ttsVoice ? `${ttsVoice.name} (${ttsVoice.lang})` : null
    }));
  };
  pick();
  // voices 是异步填充的，第一次拿往往为空
  speechSynthesis.onvoiceschanged = pick;
}

/* 现在能不能出声？三条都要满足：开关开着、浏览器有 speechSynthesis、
 * 音色表已经填好（异步）。 */
function canSpeak() {
  const cfg = deps.getCfg();
  return !!cfg?.tts?.enabled && typeof speechSynthesis !== 'undefined' && ttsReady;
}

/* ============================================================
 *  边收边念 —— 分句（纯函数，可单测）
 * ==========================================================
 *
 * 为什么要有这个：LLM 是流式的，但朗读原来是**整段收完才开口**
 * （`speak(replyBuffer)` 挂在 done 上）—— 回复长的时候，第一声要等
 * 好几秒，而气泡里的字早就一行行滚出来了。观感是"她先看完再念给你听"。
 *
 * 改法：每收到一段增量就往缓冲里追加，够一句就切出来丢进播放队列，
 * 队列在后台一条接一条念。首声延迟从"整段生成时间"降到"第一句话的时间"。
 *
 * ⚠️ 分句必须接在**清洗之后**：pet.js 收到的 chunk 已经过 llm.js 的
 *    createStreamFilter 三级清洗（markdown / emoji / [emo:] 标签都剥干净了），
 *    在这里切出来的才不会念出星号和方括号。
 * ⚠️ 分句只按标点切，**不改一个字** —— 不做省略、不做替换。
 * ========================================================== */

/* 分句参数。放这里的理由和 deps 一样：这套规则只服务朗读，
 * 跟模型、情绪、窗口尺寸都无关，不占 params.js 的口径表。 */
const SENT_STOP = /[。！？!?；;…]+|\n+/g;   // 句末 / 换行 → 切（g：一次调用里要连续找）
const SENT_SOFT = /[，,、：:]+/;             // 句读 → 只在攒够字时才切
const SOFT_MIN = 24;   // 逗号切句的最小字数：低于它继续攒（否则"你好，"被单独念一句）
const SHORT_KEEP = 4;  // 句末切句的最小字数："好。"这种太短的并到下一句去念
const HARD_MAX = 60;   // 一直没有标点时在这里强制切一刀（防模型不写标点退化成整段念）

/**
 * 从缓冲里切出「现在就能念的完整句」。
 *
 * @param {string}  buf   累积的待念文本
 * @param {boolean} final 是不是最后一段（最后一段把剩下的全切出来，不管有没有标点）
 * @returns {{sentences: string[], rest: string}} rest 是留给下一次的尾巴
 *
 * 纯函数（无状态、无 DOM、不依赖 speechSynthesis）—— 所以 verify-tts.js
 * 能直接 import 真调，把边界用例一次跑完。
 */
export function takeSentences(buf, final = false) {
  const sentences = [];
  let rest = String(buf || '');

  while (rest) {
    let cut = -1;

    /* 句末 / 换行：从头找**第一个够长**的停顿点。
     * ⚠️ 不能只看第一个匹配就放弃："好。我这就去办。" 的第一个句号太靠前
     *    （不足 SHORT_KEEP），但后面那个句号是合格切点 —— 直接 break 会让
     *    整句一直憋着不念（首声延迟又退化成"整段收完"）。 */
    SENT_STOP.lastIndex = 0;
    let m;
    while ((m = SENT_STOP.exec(rest))) {
      const end = m.index + m[0].length;
      if (end >= SHORT_KEEP || rest.length >= HARD_MAX) { cut = end; break; }
    }

    if (cut < 0) {
      const soft = SENT_SOFT.exec(rest);
      if (soft && soft.index + soft[0].length >= SOFT_MIN) cut = soft.index + soft[0].length;
    }
    if (cut < 0 && rest.length >= HARD_MAX) cut = rest.length;   // 无标点 → 硬切
    if (cut <= 0) break;                                          // 切不动了，留到下一段

    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut);
    if (piece) sentences.push(piece);
  }

  if (final) {
    const tail = rest.trim();
    if (tail) sentences.push(tail);
    rest = '';
  }
  return { sentences, rest };
}

/* ============================================================
 *  播放队列（串行）
 * ==========================================================
 *
 * 原来每次 speak() 开头就是 `speechSynthesis.cancel()` —— 那是一句式的写法：
 * 新的一句压掉旧的。流式分句之后这就不行了：第二句一进来就把第一句掐掉，
 * 结果只能听见最后一句。所以分句走队列，**只有 speak() 保持"打断"语义**。
 */
let ttsQueue = [];      // 待念的句子
let ttsActive = false;  // 队列里有一条正在念
let ttsGuard = null;    // 当前这条的兜底定时器（onend 偶尔不触发，见下）
/* 代际令牌（同 motion.js 的规矩）：stopSpeak / speak 打断时 +1，
 * 让正在播那条的 finish 回调**失效**——否则被掐掉的那条的 onend 会
 * 推进一个新队列（用户按了停止，却听见下一句接着念）。 */
let ttsGen = 0;

/* 队列上限。正常情况根本到不了（边说边念，队列基本 0~2 条），
 * 纯粹是防御：模型一口气吐一堆短句、而 TTS 又比生成慢时，
 * 别让它无限堆积成一分钟的延迟。满了丢**最旧的** —— 要念就念最新的。 */
const MAX_QUEUE = 8;

/* 诊断观察钩子（?snap=tts 用）：每次真的把文本交给引擎时回调一次。
 * 默认 null —— 正常运行时零开销。装了钩子也**绝不许影响朗读**，
 * 所以调用点包了 try。 */
let speechObserver = null;
export function setSpeechObserver(fn) { speechObserver = fn; }

/* 念掉一条，完了回调 onDone（onend / onerror / 兜底定时器三者竞速，
 * 只回调一次）。 */
function playOne(text, onDone) {
  const gen = ttsGen;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (ttsGuard) { clearTimeout(ttsGuard); ttsGuard = null; }
    if (gen !== ttsGen) return;      // 已被打断：不推进队列、不动状态
    try { onDone(); } catch { /* 队列推进不许被回调里的异常打断 */ }
  };

  try {
    try { speechObserver?.(text, Date.now()); } catch { /* 诊断钩子不许影响朗读 */ }
    const u = new SpeechSynthesisUtterance(text);
    if (ttsVoice) u.voice = ttsVoice;
    u.lang = ttsVoice?.lang || 'zh-CN';
    const cfg = deps.getCfg();
    u.rate = cfg?.tts?.rate ?? 1.05;
    u.pitch = cfg?.tts?.pitch ?? 1.0;
    u.onstart = () => deps.setState(State.SPEAKING);
    u.onend = finish;
    /* ⚠️ onerror 也必须推进队列。不接的话：合成失败的那一条永远不回调，
     *    队列卡在 ttsActive=true，后面所有句子全部哑掉（而且不报错）。 */
    u.onerror = finish;
    speechSynthesis.speak(u);

    /* 兜底：onend 偶尔不触发（合成被中断、引擎抽风），会让队列永远卡住。
     * 按字数粗估一个上限，到点强制推进。 */
    ttsGuard = setTimeout(finish, Math.max(2000, text.length * 260) + 2500);
  } catch (err) {
    console.warn('[pet] 朗读失败:', err?.message || err);
    finish();                        // 抛错也要推进，别卡住队列
  }
}

/* 队列泵：空闲且有货就播下一条。 */
function pump() {
  if (ttsActive || !ttsQueue.length) return;
  if (!canSpeak() || deps.isQuiet()) { ttsQueue.length = 0; return; }
  ttsActive = true;
  const text = ttsQueue.shift();
  playOne(text, () => {
    ttsActive = false;
    if (ttsQueue.length) { pump(); return; }
    /* 只有队列彻底空了才可能回空闲。⚠️ busy 时不能回 ——
     * 对话流程自己会在回复收尾后把状态收回 IDLE（sendMessage 里那 1400ms）。 */
    if (deps.getState() === State.SPEAKING && !deps.isBusy()) deps.setState(State.IDLE);
  });
}

/* 清场：掐掉在念的、清空队列、作废在途回调。 */
function interrupt() {
  ttsGen++;
  ttsQueue.length = 0;
  ttsActive = false;
  if (ttsGuard) { clearTimeout(ttsGuard); ttsGuard = null; }
  try { speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/* ---- 对外接口 ---- */

/** 打断式：立刻念这一条（清空队列）。提醒 / 摸头抗议 / 离线短句 pool 用。 */
export function speak(text) {
  const t = String(text || '').trim();
  if (!t || !canSpeak() || deps.isQuiet()) return;
  interrupt();
  ttsActive = true;
  playOne(t, () => {
    ttsActive = false;
    if (deps.getState() === State.SPEAKING && !deps.isBusy()) deps.setState(State.IDLE);
  });
}

/** 排队式：追加到队尾，一条念完接着下一条。流式回复用（见 takeSentences）。 */
export function enqueueSpeech(text) {
  const t = String(text || '').trim();
  if (!t || !canSpeak() || deps.isQuiet()) return;
  if (ttsQueue.length >= MAX_QUEUE) ttsQueue.shift();
  ttsQueue.push(t);
  pump();
}

export function stopSpeak() {
  interrupt();
}

/* 诊断用：当前选中的音色名（"Microsoft Huihui / zh-CN" 这样）。 */
export function ttsVoiceInfo() {
  return ttsVoice ? `${ttsVoice.name} / ${ttsVoice.lang}` : null;
}

/* 诊断用：队列快照（?snap=tts 探针读它）。 */
export function ttsQueueState() {
  return { queued: ttsQueue.length, active: ttsActive, gen: ttsGen };
}
