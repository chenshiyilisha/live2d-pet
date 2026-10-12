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

/* 从流式文本里摘掉 [emo:xxx] 标签，同时把情绪单独发出去。
 *
 * 为什么不能等整段收完再过滤：气泡是逐字显示的，收完才过滤的话，
 * 用户会先看到 "[emo:hap" 从气泡里冒出来再消失。所以这里边收边切：
 * 一遇到 '[' 就把它之后的内容扣住，等 ']' 出现再判断是不是情绪标签。
 * 只有当 '[' 后面一直等不到 ']' 且长度离谱时，才认定它不是标签、原样放行。 */
function createStreamFilter(send, sendEmotion) {
  let pending = '';
  let emotion = null;

  return {
    push(text) {
      pending += text;

      for (;;) {
        const i = pending.indexOf('[');
        if (i === -1) break;

        const j = pending.indexOf(']', i + 1);
        if (j === -1) {
          // 还没闭合：扣住从 '[' 开始的部分，等后续分片
          if (pending.length - i > 64) {
            send(pending);
            pending = '';
            return;
          }
          if (i > 0) { send(pending.slice(0, i)); pending = pending.slice(i); }
          return;
        }

        const seg = pending.slice(i, j + 1);
        const m = /^\[\s*emo\s*:\s*([a-z]+)\s*\]$/i.exec(seg);
        if (m) {
          emotion = m[1].toLowerCase();
          sendEmotion(emotion);
          if (i > 0) send(pending.slice(0, i));
        } else {
          // 不是情绪标签（模型自己用了方括号），原样发出去
          send(pending.slice(0, j + 1));
        }
        pending = pending.slice(j + 1);
      }

      if (pending) { send(pending); pending = ''; }
    },

    end() {
      if (pending) { send(pending); pending = ''; }
      return emotion;
    }
  };
}

/* 流式对话。
 *
 * 参数：messages + { baseUrl, apiKey, model, send, sendEmotion }
 * 没配 apiKey 时从 OFFLINE_REPLIES 里随机挑一句逐字吐出去 —— 走的是
 * 和真实回复**完全同一条通道**，渲染层不需要区分在线还是离线。 */
async function streamLLM(messages, { baseUrl, apiKey, model, send, sendEmotion }) {
  const filter = createStreamFilter(send, sendEmotion);

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
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, stream: true })
    });
  } catch (err) {
    return { ok: false, error: `连接失败：${err.message}` };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    return { ok: false, error: `HTTP ${res.status} ${detail}` };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
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
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) filter.push(delta);
      } catch { /* 跳过不完整分片 */ }
    }
  }

  return { ok: true, emotion: filter.end() };
}

module.exports = { createStreamFilter, streamLLM };
