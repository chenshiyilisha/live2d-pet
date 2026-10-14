'use strict';

/* ============================================================
 *  LLM 对话
 * ==========================================================
 *
 *  这一层**不碰窗口** —— 要往渲染层发的每一段文本都通过调用方传进来的
 *  send / sendEmotion 回调走。这样它才能被单独 require、单独测，
 *  也不会和 main.js 绕出循环依赖。
 * ========================================================== */

/* 没接对话后端时的回复池。
 *
 * 判断入口是 streamLLM() 里的 `if (!apiKey)` —— 只要 llm.apiKey 为空就走这里。
 *
 * ⚠️ 这批文案的定位是「还没连上大脑的桌宠在陪你待着」，**不是错误提示**。
 * 原先只有 2 条、且都在催用户去配 API Key，每次聊天都重复同一句唠叨，
 * 观感很像报错。现在改成十来句随机、口吻自然的短句，并保留 1 条
 * 真正说明怎么接模型的（随机命中，不刷屏）。
 *
 * 每条都带 [emo:xxx] 尾巴，会走完整链路：流式剥离标签 → 改表情 → TTS 朗读，
 * 所以别写太长（TTS 是逐字念的，超过 30 字会显得啰嗦）。
 */
const OFFLINE_REPLIES = [
  '我在呢。\n[emo:smile]',
  '嗯，听着呢。\n[emo:calm]',
  '唔……这句我接不太上来。\n[emo:think]',
  '你说话的时候我都在。\n[emo:happy]',
  '现在的我只会背稿子，别嫌弃。\n[emo:shy]',
  '记下了。\n[emo:smile]',
  '有点困，你叫我干嘛呀。\n[emo:sleepy]',
  '这个我暂时答不上来。\n[emo:calm]',
  '你今天过得怎么样？\n[emo:smile]',
  '陪你待着也行，不用非得说话。\n[emo:calm]',
  '又来找我啦。\n[emo:surprised]',
  '要是给我接上模型，我能聊的可就多了。\n[emo:smile]',
  '想让我真的会聊天？托盘右键 →「打开配置文件」，把 llm.apiKey 填上就行。\n[emo:think]'
];

/* ══════════════════════════════════════════════════════════
 *  ① 回复后处理 —— 把「AI 味」从字面上抹掉
 * ══════════════════════════════════════════════════════════
 *
 *  气泡只有 272px 宽，还要被 TTS 逐字念出来 —— markdown 在这里没有任何用途，
 *  只会变成给主人看的噪音。所以这里做**字符级**清洗，可以在流式里边收边判：
 *
 *    · markdown 记号：行内的 * 和 ` 直接丢；行首的 # / - / + / > / 「1.」整段丢
 *    · emoji 直接丢 —— 她有一张会动的脸，情绪走 [emo:xxx]，文字里再塞一遍
 *      只会让 TTS 念出「笑脸」两个字
 *    · 开头的填充词（「好的，」「作为一个AI…」）剥掉
 *
 *  ⚠️ **助手腔的整句没法在流里删** —— 字已经吐进气泡了，删不掉。
 *     那部分走两条路：提示词里明令禁止（config.js 的 style / format 两项），
 *     以及收完后 hitAssistantTone() 判一次、交给上层记日志，
 *     好让我们知道提示词到底管不管得住。命中率高就该升级成硬拦。
 *
 *  ⚠️ 清洗的底线是**绝不吞字**：任何判不准的地方一律原样放行。
 *     宁可漏掉一个 markdown 星号，也不能让她的半句话凭空消失。
 *     所以下面每条"扣住"的分支都配了一个长度上限，超了立刻放行。
 */

/* 一个字符是不是 emoji。
 * ⚠️ 范围刻意保守：不含箭头（→ 在中文里是正常符号）、不含 ①②③（0x2460 段）、
 *    不含 ※（0x203B）。宁少勿滥，多丢一个「★」无所谓，丢掉一个「→」是 bug。 */
function isEmoji(cp) {
  return (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) ||
    cp === 0xfe0f || cp === 0x200d || cp === 0x20e3 ||
    cp === 0x203c || cp === 0x2049 || cp === 0x3030 || cp === 0x303d;
}

/* 行首的 markdown 记号。只在**行首**才有意义 —— 行内的 - 和 # 是正常内容
 * （「C#」「3-2」「-5 度」），一律不动。 */
const LINE_HEAD = /^[ \t]*(?:[-*+#>]{1,4}|\d+\.)[ \t]/;
const LINE_RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/* 还处在"可能长成记号"的形态：纯空白、纯记号字符、或 1~2 位数字（「1.」的前半）。 */
const LINE_HEAD_PARTIAL = /^[ \t]*(?:[-*+#>]{0,4}|[0-9]{1,2}\.?)$/;

/* 逐字符清洗。返回"这一批应该出去的文本"。 */
function createCleaner() {
  let atLineStart = true;
  let head = '';        // 行首待定区：只可能是空白 + 记号字符
  let prevSpace = false;

  /* 连续空格收敛成一个。
   * 丢掉的 emoji 会在原地留下空缺（「不错 ☀️ 出门」→ 两个空格夹一段空白），
   * 在 272px 的气泡里看就是"字突然跳了一格"。 */
  function add(out, ch) {
    if (ch === ' ' || ch === '\t') {
      if (prevSpace) return;
      prevSpace = true;
    } else if (ch !== '') {
      prevSpace = false;
    }
    out.push(ch);
  }

  return {
    push(text) {
      const out = [];
      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (isEmoji(cp)) continue;                  // emoji 一律丢
        if (ch === '*' || ch === '`') continue;     // 行内 markdown 记号丢

        if (ch === '\n') {
          if (head) {
            // 整行就是一条分隔线（--- / *** / ___）→ 连换行一起吞掉，不留空行
            if (LINE_RULE.test(head)) { head = ''; continue; }
            for (const c of head) add(out, c);
            head = '';
          }
          prevSpace = false;
          out.push('\n');
          atLineStart = true;
          continue;
        }

        if (atLineStart) {
          head += ch;
          if (LINE_HEAD_PARTIAL.test(head)) continue;          // 还没定性，继续扣
          if (LINE_HEAD.test(head)) head = head.replace(LINE_HEAD, '');
          for (const c of head) add(out, c);
          head = '';
          atLineStart = false;
          continue;
        }

        add(out, ch);
      }
      return out.join('');
    },

    end() {
      const h = head;
      head = '';
      return h;
    }
  };
}

/* 开头的填充词。分两类：
 *   BARE   —— 纯应答，删掉不丢信息（「好的，」）
 *   TO_END —— 助手式开场句，删到句末标点为止（「作为一个AI，我……」）
 * ⚠️ 「没问题」「当然」「行」这类**本身就是回答**的词不能进这张表 ——
 *    删掉就等于把她的答案删了。表里只放"删掉之后语义一点没少"的词。 */
const BARE_OPENERS = ['好的', '好嘞', '好呀', '好滴'];
const TO_END_OPENERS = [
  '作为一个', '作为人工智能', '作为AI', '作为一位AI', '作为语言模型',
  '很高兴', '我很高兴', '很荣幸', '很乐意', '我很乐意',
  '让我来', '让我帮你', '让我看看', '让我想想', '我来帮你',
  '首先'
];
const OPEN_ALL = [...BARE_OPENERS, ...TO_END_OPENERS];
/* 待定区上限：超过这么多字还没定性，就放弃剥离、原样放行。 */
const OPEN_MAX = 40;
/* 句末标点。逗号也算 —— 助手腔的开场句常常是「作为一个AI，……」这种从句。 */
const SENT_END = /[。！？；;!?，,：:\n]/;

/* 剥掉开头的填充词。
 *
 * 用**增量前缀匹配**：只有当已收到的字还可能是某个填充词的开头时才扣住，
 * 一旦确定不是就立刻放行。所以「我在呢」只会在第一个字上停一帧，
 * 而「前半[未完」这种根本不扣 —— 这是它和"无脑缓存前 20 字"的区别，
 * 后者会让每句话的开头都晚一拍才出现。
 *
 * ⚠️ 只有「删完后面还有内容」时才真的删。整条回复就是「好的」或
 *    「很高兴为您服务。」时原样放行 —— 否则会删成空字符串。 */
function createOpenerStripper() {
  let open = true;      // 还在开头、还没定性
  let buf = '';

  function release() {
    const b = buf;
    buf = '';
    open = false;
    return b;
  }

  return {
    push(text) {
      if (!open) return text;
      let out = '';
      for (const ch of text) {
        if (!open) { out += ch; continue; }
        /* 还没见到任何实字符时，空白（尤其是正文开头那个换行）直接放行 ——
         * 它不算"开头已经过去了"。
         * ⚠️ 少了这一条，一句以 [think:…] 起头、正文另起一行的回复就会失手：
         *    正文的第一个字符是 '\n'，剥离器一眼判定开头已过，
         *    后面那半句开头的「好的，」再也不会被剥。 */
        if (!buf && /\s/.test(ch)) { out += ch; continue; }
        buf += ch;

        // 1) 还可能长成某个填充词 → 继续扣
        if (buf.length < OPEN_MAX && OPEN_ALL.some((p) => p !== buf && p.startsWith(buf))) continue;

        // 2) 已经确认是某个填充词（取最长匹配，「我很高兴」优先于「很高兴」）
        const hit = OPEN_ALL.filter((p) => buf.startsWith(p)).sort((a, b) => b.length - a.length)[0];
        if (!hit) { out += release(); continue; }

        const rest = buf.slice(hit.length);
        let cut = -1;
        if (BARE_OPENERS.includes(hit)) {
          cut = hit.length + rest.match(/^[，,。！!～~\s]*/)[0].length;
        } else {
          const idx = rest.search(SENT_END);
          if (idx >= 0) cut = hit.length + idx + 1;
        }

        // 没算出来，或者删完就什么都不剩 → 再等等；等超长了就原样放行
        if (cut < 0 || buf.length <= cut) {
          if (buf.length < OPEN_MAX) continue;
          out += release();
          continue;
        }
        out += buf.slice(cut);
        buf = '';
        open = false;
      }
      return out;
    },

    end() {
      const b = open ? release() : '';
      return b;
    }
  };
}

/* 助手腔短语表 —— **只用于事后统计，不从文本里删**（流式的字已经进气泡了）。
 * 它是提示词有没有管住的探针：日志里频繁出现就说明该把禁用语写得更狠。
 * 纯中文、且只收"一眼看出是助手"的写法；正常的日常口语不进来。 */
const TONE_PHRASES = [
  '作为一个AI', '作为一个人工智能', '作为人工智能', '作为语言模型',
  '希望这对你有所帮助', '希望这能帮到你', '希望对你有帮助', '希望能帮到你', '希望对你有所帮助',
  '很高兴为您服务', '很高兴为你服务', '很乐意为您', '很乐意为你',
  '如有需要', '如有任何问题', '请随时',
  '总的来说', '综上所述', '总而言之', '需要注意的是', '值得一提的是', '总结一下',
  '首先，其次', '让我来为你', '我们来分析一下'
];

function hitAssistantTone(text) {
  if (!text) return [];
  return TONE_PHRASES.filter((p) => text.includes(p));
}

/* ══════════════════════════════════════════════════════════
 *  ② 请求超时
 * ══════════════════════════════════════════════════════════
 *
 *  在这之前 fetch 是**完全没有超时**的：服务端连上之后不再吐数据，请求就
 *  永远不返回，气泡永远停在"打字中"那一帧，用户只能杀进程。
 *
 *  要两个上限，因为它们拦的是两种不同的坏情况：
 *    stallMs —— 连上了 / 正在吐，但突然不再有新数据（服务挂了、网断了、
 *               被中间设备静默掐了）。**每收到一段就重新计时**，
 *               所以正常的长回答不会被它误杀。
 *    totalMs —— 整体上限，拦那种一直慢慢吐、永远吐不完的。
 *
 *  ⚠️ 这两个数只在这里定义；config.js 的 DEFAULT_CONFIG.llm 里那份是给
 *     用户看的默认值，改一处必须改两处（verify-llm 有断言拦这条）。 */
const LLM_TIMEOUT = {
  stallMs: 20000, stallMin: 500, stallMax: 120000,
  totalMs: 120000, totalMin: 1000, totalMax: 600000
};

function clampInt(v, def, min, max) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/* ---------- [think:…] —— 「心里想的」第二通道 ----------
 *
 * 除了说出口的话，她还能有一点没说出口的念头。`[think:…]` 里的内容
 * **不进正文、不进历史、不朗读**，只显示成气泡顶上的一行小字。
 *
 * 和 [emo:xxx] 比，两处必须区别对待：
 *   · 它的内容是一整段话（不是枚举值），所以未闭合时的扣留上限要宽得多；
 *   · 它会显示出来，所以要过一遍清洗（模型在想法里照样写 markdown 和 emoji），
 *     并且**压成一行 + 截断** —— 它长在正文上方，太长会把正文挤没。
 */
const THINK_MAX = 80;      // 想法字数上限，超出截断（见 cleanThink）
const THINK_HOLD = 160;    // 未闭合的 `[think:` 最多扣住多少字符（要 > 上限 + 标签长）
const THINK_TAG = '[think:';

/* pending 里从 '[' 起的那一段，还有没有可能长成 `[think:…]`。
 * 判据：去掉空白后的前几个字符是 `[think:` 的**前缀** —— 含只收到 '[' 的中间态。
 * 只比前 7 个字符，所以「[这是个括号」一眼就不算，不会被多扣。 */
function couldBeThink(tail) {
  const s = tail.replace(/\s+/g, '').toLowerCase().slice(0, THINK_TAG.length);
  return s.length > 0 && THINK_TAG.startsWith(s);
}

/* 想法：洗脏字符 → 压成一行 → 超长截断。
 * 洗完是空串（整条就是个 emoji）就返回 ''，调用方据此不发。 */
function cleanThink(raw) {
  const c = createCleaner();
  const out = (c.push(raw) + c.end()).replace(/\s+/g, ' ').trim();
  return out.length > THINK_MAX ? out.slice(0, THINK_MAX) + '…' : out;
}

/* 从流式文本里摘掉 [emo:xxx] / [think:…] 标签，把情绪和想法分别发出去。
 *
 * 为什么不能等整段收完再过滤：气泡是逐字显示的，收完才过滤的话，
 * 用户会先看到 "[emo:hap" 从气泡里冒出来再消失。所以这里边收边切：
 * 一遇到 '[' 就把它之后的内容扣住，等 ']' 出现再判断是不是标签。
 * 只有当 '[' 后面一直等不到 ']' 且长度离谱时，才认定它不是标签、原样放行。
 *
 * 进到这里的文本都会先过一遍清洗器（markdown / emoji / 开头填充词），
 * 见上面 ① 那段 —— 顺序是「清洗 → 剥开头词 → 找标签」，
 * 标签必须最后找，否则前面的步骤可能改变 '[' 的位置。
 *
 * ⚠️ `sendThink` 有默认值：这个函数被 verify-llm 直接调用过很多次，
 *    漏传第三个参数不该把它变成 TypeError。 */
function createStreamFilter(send, sendEmotion, sendThink = () => {}) {
  let pending = '';
  let emotion = null;
  let thought = null;
  let emitted = '';
  const cleaner = createCleaner();
  const opener = createOpenerStripper();

  /* 真正的出口（在填充词剥离之后）。emitted 在这里累积 ——
   * 它统计的始终是"实际说出口的话"，和加想法通道之前一致。 */
  const raw = (t) => {
    if (!t) return;
    emitted += t;
    send(t);
  };

  /* drain() 里的正文都从这儿走：先过填充词剥离器，再出去。
   *
   * ⚠️⚠️ 顺序是这里最容易错的一处：剥离器必须接在**标签剥离之后**。
   *    加想法通道之前它是接在清洗器后面的（那时流里只有 emo 标签，
   *    而且总在末尾，撞不上）。现在想法写在**回复最开头**，剥离器第一眼
   *    看到的就是 '[' —— 一个绝无可能是填充词开头的字符，于是它立刻判定
   *    "开头已经过去了"，后面正文里的「好的，」再也不会被剥。
   *    接在标签之后，它看到的就永远是正文的开头。 */
  const emit = (t) => { if (t) raw(opener.push(t)); };

  /* 把 pending 里能定下来的部分发出去。
   * final=true 表示这是收尾调用：还扣着的一律原样吐出来 —— 一个半截的
   * 「[未完」也是模型说的话，丢了就是吞字（老实现就是 end() 直接原样发）。 */
  function drain(final) {
    for (;;) {
      const i = pending.indexOf('[');
      if (i === -1) break;

      const j = pending.indexOf(']', i + 1);
      if (j === -1) {
        // 还没闭合：扣住从 '[' 开始的部分，等后续分片。
        // 可能长成 [think:…] 的放宽上限 —— 想法本来就是一段话，64 不够装。
        const tail = pending.slice(i);
        const cap = couldBeThink(tail) ? THINK_HOLD : 64;
        if (!final && tail.length <= cap) {
          if (i > 0) { emit(pending.slice(0, i)); pending = pending.slice(i); }
          return true;
        }
        emit(pending);
        pending = '';
        return false;
      }

      const seg = pending.slice(i, j + 1);
      const mEmo = /^\[\s*emo\s*:\s*([a-z]+)\s*\]$/i.exec(seg);
      const mThink = /^\[\s*think\s*:\s*([\s\S]*?)\s*\]$/i.exec(seg);
      if (mEmo) {
        emotion = mEmo[1].toLowerCase();
        sendEmotion(emotion);
        if (i > 0) emit(pending.slice(0, i));
      } else if (mThink) {
        // 想法走独立通道：正文里不留一个字符，也不进 emitted（它不算"说出口的话"）
        const clean = cleanThink(mThink[1]);
        if (clean) { thought = clean; sendThink(clean); }
        if (i > 0) emit(pending.slice(0, i));
      } else {
        // 不是标签（模型自己用了方括号），原样发出去
        emit(pending.slice(0, j + 1));
      }
      pending = pending.slice(j + 1);
    }
    if (pending) { emit(pending); pending = ''; }
    return false;
  }

  return {
    push(text) {
      /* 清洗器在 drain 之前（markdown / emoji / 行首记号先没了，'[' 的位置才准），
       * 填充词剥离器在 drain 之后（见上面 emit 的注释）。 */
      pending += cleaner.push(text);
      drain(false);
    },

    end() {
      pending += cleaner.end();     // 清洗器的行首待定区先补进来
      drain(true);                  // final 分支不扣留，这一步会把 pending 全部吐完
      const tail = opener.end();    // 剥离器自己扣着的尾巴（只可能是"可能长成填充词"的前缀）
      if (tail) raw(tail);
      return emotion;
    },

    /* 这一轮命中了哪些助手腔短语（只统计，不改文本）。给上层记日志用。 */
    tone() { return hitAssistantTone(emitted); },

    /* 这一轮解析出的想法（没有则 null）。
     * ⚠️ 必须在 end() 之后读 —— 最后一个标签是 end() 里 drain(true) 才定下来的。 */
    think() { return thought; }
  };
}

/* 流式对话。
 *
 * 参数：messages + { baseUrl, apiKey, model, extraBody, stallMs, totalMs,
 *                    send, sendEmotion, sendThink }
 * 没配 apiKey 时从 OFFLINE_REPLIES 里随机挑一句逐字吐出去 —— 走的是
 * 和真实回复**完全同一条通道**，渲染层不需要区分在线还是离线。
 *
 * `extraBody` 是给「各家服务自己的开关」留的口子，会浅合并进请求体。
 * 为什么需要它：现在主流的混合思考模型（Qwen3 系、GLM、DeepSeek 的
 * reasoning 版）**默认开着思考**，会在正文之前先流一段 `delta.reasoning_content`。
 * 而下面只认 `delta.content`（见 while 循环里的注释），那段推理就被静默丢掉了 ——
 * 现象是「气泡开着，半天不吐一个字」。实测魔搭的 Qwen3.8-Flash-Next：
 * 不加这个开关首字 1087ms（其中 14 个推理分片），加 `{"enable_thinking":false}`
 * 后 523ms，推理分片 0。各家键名不一样（`enable_thinking` / `thinking` /
 * `chat_template_kwargs` 都见过），所以这里不做语义解释，原样透传。
 * ⚠️ 合并顺序把 model / messages / stream 放在后面 —— 这三个是本层的契约，
 *    不许被 extraBody 顶掉（verify-llm.js 有断言拦这条）。
 *
 * 返回值：{ ok, emotion, think, tone, offline? } / { ok:false, error }
 *   · emotion —— 这一轮的情绪标签（没有则 null）
 *   · think   —— 这一轮的想法（[think:…] 的内容，没有则 null）；**不在正文里**
 *   · tone    —— 命中的助手腔短语，**只统计不改文本**，给上层记日志用
 *   · error   —— 出错时一定是**可读的一句话**，包含超时的原因和实际等了多少 */
async function streamLLM(messages, { baseUrl, apiKey, model, extraBody, send, sendEmotion, sendThink, stallMs, totalMs }) {
  const filter = createStreamFilter(send, sendEmotion, sendThink);

  if (!apiKey) {
    const text = OFFLINE_REPLIES[Math.floor(Math.random() * OFFLINE_REPLIES.length)];
    for (const ch of text) {
      filter.push(ch);
      await new Promise((r) => setTimeout(r, 18));
    }
    filter.end();
    return { ok: true, offline: true };
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const extra = extraBody && typeof extraBody === 'object' && !Array.isArray(extraBody) ? extraBody : {};

  /* 上下限都要钳：手改配置写成 0 会让每一轮请求立刻中断，
   * 现象是"接上模型之后一个字都不说"，从界面上完全看不出原因。 */
  const stall = clampInt(stallMs, LLM_TIMEOUT.stallMs, LLM_TIMEOUT.stallMin, LLM_TIMEOUT.stallMax);
  const total = clampInt(totalMs, LLM_TIMEOUT.totalMs, LLM_TIMEOUT.totalMin, LLM_TIMEOUT.totalMax);

  const ac = new AbortController();
  let abortWhy = null;
  let stallTimer = null;

  /* 每收到一段数据就重新计时 —— 所以它拦的是"卡住"，不是"慢"。 */
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { abortWhy = 'stall'; ac.abort(); }, stall);
  };
  const totalTimer = setTimeout(() => { abortWhy = 'total'; ac.abort(); }, total);

  /* ⚠️ 不要 unref()。挂起的 Promise 保不住事件循环，只有定时器能 ——
   * unref 掉就等于"还没开始读就已经没事可做了"，进程会在请求中途直接退出。
   * 不会泄漏：下面每条返回路径都会 stopTimers()（两个早退分支各自调，
   * 读循环那条走 finally）。 */
  const stopTimers = () => { clearTimeout(stallTimer); clearTimeout(totalTimer); };
  const timeoutMsg = () => (abortWhy === 'total'
    ? `响应超时：整轮超过 ${(total / 1000).toFixed(0)} 秒还没收完`
    : `响应中断：${(stall / 1000).toFixed(0)} 秒没有收到新数据`);

  let res;
  try {
    armStall();
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ ...extra, model, messages, stream: true }),
      signal: ac.signal
    });
  } catch (err) {
    stopTimers();
    return { ok: false, error: abortWhy ? timeoutMsg() : `连接失败：${err.message}` };
  }

  if (!res.ok) {
    stopTimers();
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    return { ok: false, error: `HTTP ${res.status} ${detail}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      armStall();                      // 每一轮读之前重新计时
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          // ⚠️ 只取 delta.content。推理型模型会另发 delta.reasoning_content，
          //    这里**故意丢掉** —— 思考过程不该念给用户听（气泡 + TTS 都会念）。
          //    代价是推理期间界面上什么都不出来，所以配了 extraBody 让上层能关掉思考。
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) filter.push(delta);
        } catch { /* 跳过不完整分片 */ }
      }
    }
  } catch (err) {
    // 中断（超时）和被服务端掐断都走这里。前面已经吐进气泡的半句话由上层
    // 按"这一轮失败了"处理（main.js 会 bubble.abortStream()），不留半截。
    return { ok: false, error: abortWhy ? timeoutMsg() : `读取中断：${err.message}` };
  } finally {
    stopTimers();
  }

  /* ⚠️ 先 end() 再 think()：最后一个标签（含想法）是 end() 里那次
   * drain(true) 才定下来的，顺序反了会漏掉收尾那一个。 */
  const emotion = filter.end();
  return { ok: true, emotion, think: filter.think(), tone: filter.tone() };
}

module.exports = {
  createStreamFilter, streamLLM, LLM_TIMEOUT, hitAssistantTone,
  THINK_MAX, THINK_HOLD
};
