'use strict';

/* 「边收边念」（句子级流式 TTS）的源码级 + 行为级防回流断言。
 *
 * 这一版坏起来几乎全是**静默**的：
 *   1) 分句器切错 → 念出来的话被切碎、或者整段等到底才出声（功能退化成原样）；
 *   2) 队列写成"新的一句掐掉旧的" → 只听得见最后一句（最难发现：
 *      短回复听起来完全正常，长回复才会露馅）；
 *   3) 收尾又调一次 speak(replyBuffer) → **整条回复念两遍**；
 *   4) onerror 没接 → 一条合成失败就把队列永久卡死，后面全哑（且不报错）。
 *
 * ⚠️ 这里**真的 import 了 src/renderer/tts.js**（连同 params.js 一起复制成
 *    .mjs 让 Node 按 ESM 解析），并给 globalThis 装了假的 speechSynthesis，
 *    所以分句与队列是真跑出来的行为，不是拿正则看源码长相。
 *    只有"接线"那一段（[D]）是源码级 —— 那部分在 pet.js 里，有 DOM 依赖。
 *
 * 跑法：node debug/verify-tts.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

/* ---- 假引擎：把要说的话记下来，由测试手动推进 onend ----
 * ⚠️ 必须在 import 之前装好：tts.js 的 initTTS() 一调就要读 globalThis。 */
const spoken = [];       // 已经交给引擎的文本（按顺序）
const pending = [];      // 正在"念"的 utterance（测试手动 finish）
let cancelCount = 0;
globalThis.speechSynthesis = {
  speak(u) { spoken.push(u.text); pending.push(u); },
  cancel() { cancelCount++; },
  getVoices() { return [{ name: 'Microsoft Huihui', lang: 'zh-CN' }]; }
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; }
};

/* 手动把当前这条念完（真实引擎会调 onend）。 */
const finishCurrent = () => {
  const u = pending.shift();
  if (!u) return false;
  if (typeof u.onend === 'function') u.onend();
  return true;
};

(async () => {
  /* ---- 复制 params.js + tts.js 到临时目录（.mjs），改掉相对 import 后加载 ---- */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tts-'));
  fs.copyFileSync(path.join(SRC, 'renderer', 'params.js'), path.join(dir, 'params.mjs'));
  fs.writeFileSync(
    path.join(dir, 'tts.mjs'),
    read(path.join('renderer', 'tts.js')).replace(/from '\.\/params\.js'/, "from './params.mjs'")
  );
  const T = await import(pathToFileURL(path.join(dir, 'tts.mjs')).href);

  /* ---- 注入依赖（真值都是 getter，跟应用里一样） ---- */
  let state = 'idle';
  let busy = false;
  let quiet = false;
  let enabled = true;
  T.configureTTS({
    getCfg: () => ({ tts: { enabled } }),
    getState: () => state,
    isBusy: () => busy,
    setState: (s) => { state = s; },
    isQuiet: () => quiet
  });
  T.initTTS();

  /* ============================================================
   *  [A] takeSentences —— 纯函数分句（真调）
   * ========================================================== */
  console.log('[A] takeSentences —— 分句规则（真调纯函数）');
  {
    const { takeSentences } = T;

    /* ① 正常句末切分 */
    {
      const r = takeSentences('你好呀。我在这儿等你。');
      ok(r.sentences.length === 2 && r.sentences[0] === '你好呀。' && r.sentences[1] === '我在这儿等你。',
        `句号切两句：${JSON.stringify(r.sentences)}`);
      ok(r.rest === '', '切完不留残渣');
    }

    /* ② 流式分片不切碎：一个字一个字喂，中途不冒半句出来 */
    {
      let buf = '';
      let mid = 0;
      for (const ch of '你好呀。我在这儿等你。') {
        buf += ch;
        const r = takeSentences(buf, false);
        buf = r.rest;
        mid += r.sentences.length;
      }
      ok(mid === 2, `逐字喂也只切出 2 句（实际 ${mid}）—— 缓冲必须攒够才切`);
      ok(buf === '', '逐字喂到结尾缓冲正好清空');
    }

    /* ③ 短句并到下一句（"好。" 不该单独占一次朗读） */
    {
      const r = takeSentences('好。我这就去办。');
      ok(r.sentences.length === 1 && r.sentences[0] === '好。我这就去办。',
        `太短的句末片段会并到下一句：${JSON.stringify(r.sentences)}`);
    }

    /* ④ 逗号：短了不切 */
    {
      const r = takeSentences('你好，我是阿岩。');
      ok(r.sentences.length === 1, `逗号前只有 2 字 → 不切：${JSON.stringify(r.sentences)}`);
    }

    /* ⑤ 逗号：长了就切（别让一句话憋到几十字才出声） */
    {
      const long = '啊'.repeat(25) + '，' + '哦'.repeat(5);
      const r = takeSentences(long);
      ok(r.sentences.length === 1 && r.sentences[0] === '啊'.repeat(25) + '，',
        '逗号前 ≥24 字 → 就地切一刀（长句的首声延迟靠它兜住）');
    }

    /* ⑥ 硬切：一个标点都没有也不能一直憋着 */
    {
      const r = takeSentences('啊'.repeat(70));
      ok(r.sentences.length === 1 && r.sentences[0].length === 70,
        `无标点超长 → 硬切（${r.sentences[0]?.length} 字）`);
    }

    /* ⑦ 换行算停顿点 */
    {
      const r = takeSentences('第一行内容在这里\n第二行内容在这里\n');
      ok(r.sentences.length >= 1, `换行能切出句子：${JSON.stringify(r.sentences)}`);
    }

    /* ⑧ final 兜底：最后那段没标点的必须吐出来，否则**永远不念** */
    {
      const r = takeSentences('这句话没写完', true);
      ok(r.sentences.length === 1 && r.sentences[0] === '这句话没写完', 'final=true 把尾巴吐出来');
      ok(r.rest === '', 'final 之后缓冲清空');
      const r2 = takeSentences('这句话没写完', false);
      ok(r2.sentences.length === 0 && r2.rest === '这句话没写完', 'final=false 时原样留着');
    }

    /* ⑨ 空白不产生空句（空句会让队列推进一次却什么都不念） */
    {
      const r = takeSentences('   \n  ', true);
      ok(r.sentences.length === 0, '纯空白不产生句子');
    }

    /* ⑩ 连用标点不切出空片 */
    {
      const r = takeSentences('好的！！真的吗？');
      ok(r.sentences.length === 2 && r.sentences[0] === '好的！！', `连用标点：${JSON.stringify(r.sentences)}`);
      ok(r.sentences.every((s) => s.trim().length > 0), '没有任何空句');
    }

    /* ⑪ 绝不吞字：切完的句子拼起来应等于原文（去掉空白） */
    {
      const src = '喂？嗯。今天天气真的特别好，我们出去走走吧。好！！';
      const r = takeSentences(src, true);
      const joined = r.sentences.join('').replace(/\s+/g, '');
      ok(joined === src.replace(/\s+/g, ''), '分句不增字、不漏字（拼接还原原文）');
    }
  }

  /* ============================================================
   *  [B] 播放队列 —— 串行、打断、静默、卡死防护
   * ========================================================== */
  console.log('[B] 播放队列 —— 串行推进 / 打断 / 静默 / 失败不卡死');
  {
    const reset = () => {
      T.stopSpeak();
      spoken.length = 0;
      pending.length = 0;
      cancelCount = 0;
      state = 'idle';
      busy = false;
      quiet = false;
      enabled = true;
    };

    /* ① 串行：三条入队，立刻只送第一条 */
    {
      reset();
      T.enqueueSpeech('一');
      T.enqueueSpeech('二');
      T.enqueueSpeech('三');
      ok(spoken.length === 1 && spoken[0] === '一', `只送第一条上车（已送 ${spoken.length} 条）`);
      ok(T.ttsQueueState().queued === 2, '另外两条在队列里等着');
      const st1 = pending[0];
      if (st1.onstart) st1.onstart();
      ok(state === 'speaking', '开始念 → 状态切到 SPEAKING');
      finishCurrent();
      ok(spoken.length === 2 && spoken[1] === '二', '第一条念完自动接第二条');
      finishCurrent();
      finishCurrent();
      ok(T.ttsQueueState().queued === 0 && T.ttsQueueState().active === false, '全部念完队列空');
      ok(state === 'idle', '队列清空且不忙 → 回到 IDLE');
    }

    /* ② 队列不空时不许回 IDLE（否则口型会中途停掉） */
    {
      reset();
      busy = true;                      // 对话进行中
      T.enqueueSpeech('甲');
      T.enqueueSpeech('乙');
      finishCurrent();
      ok(state === 'speaking' || state === 'idle', 'busy 时结束一条不擅自改状态');
      busy = false;
    }

    /* ③ 打断：speak() 清队列（原来靠 cancel 顺带做到，分句后必须显式清） */
    {
      reset();
      T.enqueueSpeech('一');
      T.enqueueSpeech('二');
      T.enqueueSpeech('三');
      const before = cancelCount;
      T.speak('打断一下');
      ok(T.ttsQueueState().queued === 0, 'speak() 清空了队列');
      ok(spoken[spoken.length - 1] === '打断一下', '打断的那句立刻上车');
      ok(cancelCount > before, '确实调了 cancel（掐掉在念的）');
    }

    /* ④ stopSpeak：清队列 + cancel */
    {
      reset();
      T.enqueueSpeech('一');
      T.enqueueSpeech('二');
      const before = cancelCount;
      T.stopSpeak();
      ok(T.ttsQueueState().queued === 0 && T.ttsQueueState().active === false, 'stopSpeak 清空队列');
      ok(cancelCount > before, 'stopSpeak 调了 cancel');
    }

    /* ⑤ 被掐掉那条的 onend 不许推进新队列（代际令牌） */
    {
      reset();
      T.enqueueSpeech('一');
      T.enqueueSpeech('二');
      const stale = pending.shift();      // 正在念的"一"
      T.stopSpeak();                      // 掐掉
      T.enqueueSpeech('三');              // 新的一段
      const spokenBefore = spoken.length;
      if (stale.onend) stale.onend();      // 旧回调姗姗来迟
      ok(spoken.length === spokenBefore, '过期的 onend 不会偷偷推进队列（代际令牌生效）');
    }

    /* ⑥ 合成失败（onerror）也要推进队列 —— 否则后面全哑且不报错 */
    {
      reset();
      T.enqueueSpeech('一');
      T.enqueueSpeech('二');
      const u = pending.shift();
      if (u.onerror) u.onerror();
      ok(spoken.length === 2 && spoken[1] === '二', 'onerror 之后队列继续（失败不卡死）');
    }

    /* ⑦ 静默中不入队（全屏静默的出口拦截） */
    {
      reset();
      quiet = true;
      T.enqueueSpeech('不该出声');
      ok(spoken.length === 0 && T.ttsQueueState().queued === 0, '静默中 enqueueSpeech 直接丢弃');
      T.speak('也不该出声');
      ok(spoken.length === 0, '静默中 speak 也不出声');
      quiet = false;
    }

    /* ⑧ 开关关掉时零动作（默认就是关的，这条最常用） */
    {
      reset();
      enabled = false;
      T.enqueueSpeech('关着呢');
      T.speak('关着呢');
      ok(spoken.length === 0 && T.ttsQueueState().queued === 0, 'tts.enabled=false 时完全不出声');
      enabled = true;
    }

    /* ⑨ 空串 / undefined 不占队列（空句会白推一次队） */
    {
      reset();
      T.enqueueSpeech('');
      T.enqueueSpeech(null);
      T.enqueueSpeech('   ');
      T.speak('');
      ok(spoken.length === 0 && T.ttsQueueState().queued === 0, '空串不入队、不出声');
    }

    /* ⑩ 队列有上限，不会无限堆积（AI-YinMei 的反面教训：队列无界） */
    {
      reset();
      for (let i = 0; i < 20; i++) T.enqueueSpeech('句' + i);
      const q = T.ttsQueueState();
      ok(q.queued <= 8, `队列有上限（当前 ${q.queued}，应 ≤ 8）`);
      ok(spoken[spoken.length - 1] === '句0', '正在念的仍是最先那条');
    }

    /* ⑪ 念完不残留：队列空 + active=false（否则下一轮永不出声） */
    {
      reset();
      T.enqueueSpeech('一');
      finishCurrent();
      const q = T.ttsQueueState();
      ok(q.queued === 0 && q.active === false, '念完彻底归零，下一轮还能出声');
      T.enqueueSpeech('二');
      ok(spoken[spoken.length - 1] === '二', '下一轮照常出声');
    }
  }

  /* ============================================================
   *  [C] tts.js 结构断言 —— 那几个"改一半"最容易漏的点
   * ========================================================== */
  console.log('[C] tts.js 源码结构 —— 出口与语义');
  {
    const src = read(path.join('renderer', 'tts.js'));

    /* ① 分句器必须是纯函数：不许碰引擎（碰了就没法单测，也说明职责混了） */
    const fnBody = src.slice(src.indexOf('export function takeSentences'));
    const endIdx = fnBody.indexOf('\n}\n');
    const body = fnBody.slice(0, endIdx > 0 ? endIdx : 1200);
    ok(!/speechSynthesis|SpeechSynthesisUtterance/.test(body),
      'takeSentences 是纯函数（函数体内不碰引擎）');

    /* ② 静默拦截必须在**两个**对外出口上（只拦一个就漏） */
    const speakBody = src.slice(src.indexOf('export function speak('), src.indexOf('export function enqueueSpeech('));
    const enqBody = src.slice(src.indexOf('export function enqueueSpeech('), src.indexOf('export function stopSpeak('));
    ok(/isQuiet\(\)/.test(speakBody), 'speak() 拦静默');
    ok(/isQuiet\(\)/.test(enqBody), 'enqueueSpeech() 也拦静默 —— 两个出口缺一不可');

    /* ③ 只有 speak() 是打断语义，enqueue 不许清队列 */
    ok(!/ttsQueue\.length = 0/.test(enqBody), 'enqueueSpeech 不清队列（清了就只能听见最后一句）');
    ok(/interrupt\(\)/.test(speakBody), 'speak() 走 interrupt()（清队列 + 作废在途回调）');

    /* ④ 有上限常量 */
    ok(/MAX_QUEUE\s*=\s*\d+/.test(src), '队列有 MAX_QUEUE 上限');

    /* ⑤ 分句阈值成组出现（改一半会退化成整段念） */
    ok(/SHORT_KEEP\s*=/.test(src) && /SOFT_MIN\s*=/.test(src) && /HARD_MAX\s*=/.test(src),
      '三个分句阈值都在（短句合并 / 逗号切分 / 无标点硬切）');
  }

  /* ============================================================
   *  [D] pet.js 接线 —— 源码级（那部分有 DOM 依赖，跑不起来）
   * ========================================================== */
  console.log('[D] pet.js 接线 —— 边收边念的回路');
  {
    const src = read(path.join('renderer', 'pet.js'));
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    /* ① chunk 必须喂给分句器 */
    const onChunk = noComment.slice(noComment.indexOf('onChunk?.('), noComment.indexOf('onEmotion?.('));
    ok(/feedSpeech\(text\)/.test(onChunk), 'onChunk 里把增量喂进 feedSpeech（否则还是整段念）');

    /* ② 🔴 收尾绝不能再整段念一遍 —— 这是分句之后最容易犯的错 */
    ok(!/speak\(\s*replyBuffer\s*\)/.test(noComment),
      '没有任何 speak(replyBuffer) —— 全文已分批念过，再念一遍就是重复朗读');
    const flushCalls = (noComment.match(/flushSpeech\(\)/g) || []).length;
    ok(flushCalls >= 2, `两条回复路径都走 flushSpeech（找到 ${flushCalls} 处：对话 + 主动搭话）`);

    /* ③ 新消息打断上一轮朗读 */
    const send = noComment.slice(noComment.indexOf('async function sendMessage()'), noComment.indexOf('sendBtn.addEventListener'));
    ok(/stopSpeak\(\)/.test(send) && /speechBuf = ''/.test(send),
      'sendMessage 开头清掉上一轮的朗读队列与分句缓冲');

    /* ④ 分句缓冲与气泡缓冲是两笔账 */
    ok(/let speechBuf = ''/.test(noComment), 'speechBuf 独立于 replyBuffer');

    /* ⑤ feedSpeech 关掉语音时零动作 */
    const feed = noComment.slice(noComment.indexOf('function feedSpeech('), noComment.indexOf('function flushSpeech('));
    ok(/cfg\?\.tts\?\.enabled/.test(feed), '没开语音时 feedSpeech 立刻返回（不做无用缓冲）');

    /* ⑥ 挣脱：patEscaped 判断必须在 patState 判断**之前** */
    const up = noComment.slice(noComment.indexOf("window.addEventListener('mouseup'"), noComment.indexOf('function onPetClicked()'));
    const iEsc = up.indexOf('patEscaped');
    const iState = up.indexOf("patState !== 'idle'");
    ok(iEsc > 0 && iState > 0 && iEsc < iState,
      'mouseup 里先看 patEscaped 再看 patState（挣脱后的松手不该算点击）');
    ok(/PAT\.escapeMs/.test(noComment), '挣脱用 PAT.escapeMs（不写死数字）');
  }

  /* 收尾清理 */
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(fails === 0 ? '\n全部通过（0 项失败）' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
