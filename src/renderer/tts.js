import { State } from './params.js';

/* ============================================================
 *  语音朗读
 * ==========================================================
 *
 *  **两种引擎**（`tts.engine`，见 src/main/tts.js）：
 *
 *  · `'system'` —— Chromium 内置的 speechSynthesis，Windows 上就是系统 SAPI。
 *    零依赖、启动最快，但它的声音**不进 WebAudio 的图**：拿不到波形，
 *    说话时嘴巴只能跑一条与音量无关的正弦波（"机器人张嘴"）。
 *
 *  · `'winrt'`（默认）—— 主进程用 Windows 语音合成吐一段 wav 回来，
 *    这里用 AudioContext 播。声音走 WebAudio，于是能挂 AnalyserNode
 *    取真实音量包络 → **真口型**（见文件末尾的 lipEnv）。
 *    代价：多一个常驻合成进程（只在 tts 开着时起）。
 *
 *  ⚠️ winrt 那条路**任何一步失败都退回 system**（合成不出来 / 解码失败 /
 *     播不了）。退回是静默的、逐句生效的 —— 宁可这一句换回机械口型，
 *     也不能让朗读哑掉：用户不知道发生了什么，只会以为"朗读坏了"。
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
  isQuiet: () => false,
  /* 让主进程用 Windows 语音合成吐一段 wav（见 src/main/tts.js）。
   * 默认 null —— 没有它（旧版 preload、或被裁掉的构建）就整个功能退回
   * 系统内置音色，一行都不能炸。 */
  synth: null
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

/* 这一句用哪个引擎。
 * ⚠️ 只有"配置选了 winrt" **且** "合成通道真的注入了"才算 winrt。
 *    少判后半个条件，旧 preload（没有 synthSpeech）就会让每一句都
 *    先等一次必然失败的合成 —— 观感是"朗读要停两秒才开口"。 */
const ENGINE_SYSTEM = 'system';
const ENGINE_WINRT = 'winrt';

function engineOf() {
  const e = deps.getCfg()?.tts?.engine;
  return e === ENGINE_WINRT && typeof deps.synth === 'function' ? ENGINE_WINRT : ENGINE_SYSTEM;
}

/* 合成参数。两个引擎的语速/音调语义一致（都是 1 = 正常），所以同一份
 * 配置直传，只做钳制 —— winrt 那边超出范围会抛。 */
function synthOpts() {
  const t = deps.getCfg()?.tts || {};
  const r = Number(t.rate);
  const p = Number(t.pitch);
  return {
    rate: Number.isFinite(r) ? Math.min(3, Math.max(0.5, r)) : 1.05,
    pitch: Number.isFinite(p) ? Math.min(2, Math.max(0, p)) : 1,
    voice: String(t.voice || '')
  };
}

/* ============================================================
 *  真实口型包络（WebAudio）
 * ==========================================================
 *
 *  winrt 引擎的声音是我们自己播的，所以能挂分析器取波形；
 *  取出来的 RMS 经「快攻慢放」平滑后就是嘴巴的开合度。
 *
 *  ⚠️ fftSize 512：@16kHz 是 32ms 窗口，约一个音节的粒度。
 *     用默认的 2048（128ms）会把音节之间的差别糊平，嘴巴变成"一直半张"。
 *  ⚠️ 快攻慢放（40 / 12）不是装饰：真人说「爸爸」时嘴是"啪"地闭上、
 *     嘴唇再慢慢归位；两个方向用同一个速度会让嘴巴像节拍器。
 * ========================================================== */

const FFT_SIZE = 512;
const LIP_GAIN = 9;        // RMS → 0..1（16k 语音的 RMS 大致 0.02~0.15）
const LIP_ATTACK = 40;
const LIP_RELEASE = 12;

let ac = null;             // AudioContext（懒建：没有朗读就一个都不建）
let analyser = null;
let envBuf = null;
let currentSrc = null;     // 正在播的那一段
let lipActive = false;     // 这一轮朗读是有真实波形的（false → pet.js 回正弦波）
let lipLevel = 0;

function getAC() {
  if (ac) return ac;
  /* `typeof window` 这一层是给单测留的：verify-tts 在 Node 里直接 import
   * 这个文件，那里没有 window —— 直接取会抛 ReferenceError，
   * 而它冒出去就是一条 unhandled rejection（调用点没 await）。 */
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!Ctx) return null;
  try {
    ac = new Ctx();
    analyser = ac.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    envBuf = new Float32Array(analyser.fftSize);
    analyser.connect(ac.destination);
  } catch (err) {
    console.warn('[pet] AudioContext 建不起来，口型退回正弦:', err?.message || err);
    ac = null;
    analyser = null;
    return null;
  }
  return ac;
}

/**
 * 当前的口型强度。**每帧调用一次**（内部带平滑，调用频率变了平滑就变）。
 *
 * @param {number} dt 距上一帧的秒数
 * @returns {number|null} 0..1 的真实包络；**null = 这一段没有波形**，
 *                        调用方（pet.js）应退回它自己的正弦波动画。
 */
export function lipEnv(dt) {
  if (!lipActive) return null;

  let target = 0;
  if (currentSrc && analyser && envBuf) {
    analyser.getFloatTimeDomainData(envBuf);
    let sum = 0;
    for (let i = 0; i < envBuf.length; i++) sum += envBuf[i] * envBuf[i];
    const rms = Math.sqrt(sum / envBuf.length);
    target = Math.min(1, rms * LIP_GAIN);
  }

  const k = target > lipLevel ? LIP_ATTACK : LIP_RELEASE;
  lipLevel += (target - lipLevel) * (1 - Math.exp(-(dt || 0) * k));
  if (target === 0 && lipLevel < 0.002) lipLevel = 0;
  return lipLevel;
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
let ttsQueue = [];      // 待念的条目 { text, pcm }（pcm = 在途的预合成结果，可能 null）
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

/* 用**系统内置音色**念一条（Chromium speechSynthesis）。
 * 它也是 winrt 那条路的兜底 —— 所以这里必须一条路都能走通、不依赖
 * 任何 winrt 侧的状态。 */
function playSystem(text, finish) {
  /* 回到机械口型：这一段没有波形可分析，嘴巴交回 pet.js 的正弦波。
   * （winrt 和 system 在同一轮里混着出现是可能的 —— 中间某句合成失败。） */
  lipActive = false;
  lipLevel = 0;

  try {
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

/* 用 **Windows 合成 + WebAudio 播放**念一条 —— 顺带产出真实口型包络。
 *
 * ⚠️ 这里有一条**逐句回退**：合成不出来 / 解码失败 / 播不了，都退回
 *    playSystem 念同一句。绝不"这一句算了" —— 用户只会觉得朗读坏了。 */
async function playWinrt(text, gen, finish, pcm) {
  let buf = null;
  try {
    buf = pcm ? await pcm : await deps.synth(text, synthOpts());
  } catch (err) {
    console.warn('[pet] 语音合成失败，本句回退系统音色:', err?.message || err);
    buf = null;
  }
  /* 合成要等在途的进程，这期间可能已经被打断（用户发了新消息、
   * 按了停止、全屏静默）—— 那就什么都不做。 */
  if (gen !== ttsGen) { finish(); return; }

  const ctx = buf ? getAC() : null;
  if (!buf || !ctx) { playSystem(text, finish); return; }

  let audio = null;
  try {
    /* 音频自动播放策略：Electron 默认放行，但被系统休眠/静默策略挂起过
     * 就再也起不来 —— 每次播前确认一下，成本近零。 */
    if (ctx.state === 'suspended') ctx.resume();
    /* ⚠️ decodeAudioData 会**接管**传进去的 ArrayBuffer（detach），
     *    所以必须是这一句独占的一份，不能缓存复用。 */
    audio = await ctx.decodeAudioData(buf);
  } catch (err) {
    console.warn('[pet] 音频解码失败，本句回退系统音色:', err?.message || err);
  }
  if (gen !== ttsGen) { finish(); return; }
  if (!audio || !audio.duration) { playSystem(text, finish); return; }

  try {
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(analyser);
    const end = () => {
      if (currentSrc === src) currentSrc = null;
      finish();
    };
    src.onended = end;
    currentSrc = src;
    lipActive = true;
    lipLevel = 0;
    src.start();
    deps.setState(State.SPEAKING);
    /* 兜底：onended 偶尔不触发（音频设备被拔、被系统掐），到点强制推进。
     * 用音频真实时长而不是字数估计 —— 这个数是准的。 */
    ttsGuard = setTimeout(end, audio.duration * 1000 + 2000);
  } catch (err) {
    console.warn('[pet] 播放失败，本句回退系统音色:', err?.message || err);
    currentSrc = null;
    lipActive = false;
    playSystem(text, finish);
  }
}

/* 念掉一条，完了回调 onDone（onend / onerror / 兜底定时器三者竞速，
 * 只回调一次）。
 * @param {Promise<ArrayBuffer|null>|null} pcm 预合成结果（见 enqueueSpeech 的流水线） */
function playOne(text, onDone, pcm = null) {
  const gen = ttsGen;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (ttsGuard) { clearTimeout(ttsGuard); ttsGuard = null; }
    if (gen !== ttsGen) return;      // 已被打断：不推进队列、不动状态
    try { onDone(); } catch { /* 队列推进不许被回调里的异常打断 */ }
  };

  try { speechObserver?.(text, Date.now()); } catch { /* 诊断钩子不许影响朗读 */ }

  if (engineOf() === ENGINE_WINRT) {
    playWinrt(text, gen, finish, pcm);
    return;
  }
  playSystem(text, finish);
}

/* 预合成：把"合成"这一步提前到**入队时**，这样播上一句的时候下一句
 * 已经合成好了，句子之间没有等待。
 * ⚠️ 失败一律收敛成 null，绝不 reject —— 它挂在队列项上，
 *    没人接的 rejection 会变成 unhandled。 */
function prefetch(text) {
  if (engineOf() !== ENGINE_WINRT) return null;
  try {
    return Promise.resolve(deps.synth(text, synthOpts())).then((b) => b || null, () => null);
  } catch {
    return null;
  }
}

/* 队列泵：空闲且有货就播下一条。 */
function pump() {
  if (ttsActive || !ttsQueue.length) return;
  if (!canSpeak() || deps.isQuiet()) { ttsQueue.length = 0; return; }
  ttsActive = true;
  const item = ttsQueue.shift();
  playOne(item.text, () => {
    ttsActive = false;
    if (ttsQueue.length) { pump(); return; }
    /* 只有队列彻底空了才可能回空闲。⚠️ busy 时不能回 ——
     * 对话流程自己会在回复收尾后把状态收回 IDLE（sendMessage 里那 1400ms）。 */
    if (deps.getState() === State.SPEAKING && !deps.isBusy()) deps.setState(State.IDLE);
  }, item.pcm);
}

/* 停掉正在播的那一段（如果有）。打断时必须调 ——
 * 只 `speechSynthesis.cancel()` 拦不住自己播的那条，它会继续念完。 */
function stopAudio() {
  const src = currentSrc;
  currentSrc = null;
  if (src) { try { src.stop(); } catch { /* ignore */ } }
  lipActive = false;
  lipLevel = 0;
}

/* 清场：掐掉在念的、清空队列、作废在途回调。 */
function interrupt() {
  ttsGen++;
  ttsQueue.length = 0;
  ttsActive = false;
  if (ttsGuard) { clearTimeout(ttsGuard); ttsGuard = null; }
  stopAudio();
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

/** 排队式：追加到队尾，一条念完接着下一条。流式回复用（见 takeSentences）。
 *  ⚠️ **入队即发起合成**（winrt 引擎）：播上一句的时候下一句已经在合成了，
 *     句子之间没有等待。代价是打断时那几次在途合成白做 —— 几十毫秒的事。 */
export function enqueueSpeech(text) {
  const t = String(text || '').trim();
  if (!t || !canSpeak() || deps.isQuiet()) return;
  if (ttsQueue.length >= MAX_QUEUE) ttsQueue.shift();   // 丢最旧的，连它的在途合成一起放弃
  ttsQueue.push({ text: t, pcm: prefetch(t) });
  pump();
}

export function stopSpeak() {
  interrupt();
}

/* 诊断用：当前生效的引擎与音色（"Microsoft Huihui / zh-CN" 这样）。
 * winrt 引擎下实际音色由主进程的合成进程挑（OneCore 语音），渲染层不知道，
 * 这里只标注引擎 —— 免得诊断页把"回退用的系统音色"当成正在用的音色。 */
export function ttsVoiceInfo() {
  const v = ttsVoice ? `${ttsVoice.name} / ${ttsVoice.lang}` : null;
  if (engineOf() === ENGINE_WINRT) return `Windows 合成${v ? `（回退备用：${v}）` : ''}`;
  return v;
}

/* 诊断用：队列快照（?snap=tts 探针读它）。 */
export function ttsQueueState() {
  return {
    queued: ttsQueue.length, active: ttsActive, gen: ttsGen,
    engine: engineOf(), lip: lipActive, lipLevel
  };
}
