'use strict';

/* ============================================================
 *  TTS 语音合成 provider（W47）
 * ==========================================================
 *
 *  这一层**只有数据与纯函数**：预设表、端点判定、一键测试。
 *  不 require electron、不碰窗口、不落盘 —— 于是
 *  `debug/verify-tts-providers.js` 能直接 node 跑它做断言。
 *
 *  为什么需要这一层（原先只有 winrt 一个引擎）：
 *  WinRT 系统音色是「电脑自带的」，不是她的声音。gsv-rvc-voice-bridge
 *  这类本地网关把 GPT-SoVITS + RVC 串起来，对外伪装成 OpenAI 语音接口 ——
 *  于是只要 baseUrl 指向网关，她就能用自己的角色音色说话。
 *
 *  🔴 **连不上网关必须静默回落 WinRT**（否则她变哑巴）。
 *     回落只记一行日志不弹窗 —— 她不该因为一个可选功能报错。
 *
 *  ⚠️ 预设里的 baseUrl 一律是**到 /v1 这一级**（不带 /audio/speech）——
 *     openaiSynthWav 里是 `${baseUrl}/audio/speech` 拼的。
 *
 *  ⚠️ 这份表**不是**能力声明。哪一家能用，只有真发一句才知道
 *     （见 main.js 的 ttsTest）—— 别在 UI 上给未验证的条目打勾。
 * ========================================================== */

/* gsv 网关的 maxChars 是**文本**限制（不是音频时长限制）。
 * 默认 200 字符。截断在 synthWav 里做，防超限被网关拒。 */
const MAX_TEXT_CHARS = 500;

/* 合成超时。本地网关首次加载权重可能十几秒；云端一般 2 秒内。
 * 15 秒对两边都够。 */
const SYNTH_TIMEOUT_MS = 15000;

/* 预设目录。顺序 = 菜单顺序。
 *
 * 选谁进这张表的标准：① 国内可直接访问（或本地）② 有 OpenAI 兼容端点
 * ③ 名字稳定。故意**不**放需要额外协议适配的家。 */
const PROVIDERS = [
  {
    id: 'gsv',
    label: 'gsv 网关（本地）',
    local: true,
    baseUrl: 'http://127.0.0.1:8790/v1',
    model: '',        // gsv 的 /v1/models 返回当前模型 ID；空 = 自动拉
    voice: '',        // gsv 的 voice 映射在网关侧；空 = 默认
    featured: true
  },
  {
    id: 'openai',
    label: 'OpenAI TTS',
    local: false,
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1',
    voice: 'alloy',
    featured: true
  },
  {
    id: 'custom',
    label: '自定义',
    custom: true,
    baseUrl: '',
    model: '',
    voice: '',
    featured: false
  }
];

function ttsProviderById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/* 这个地址是不是本机。同 llm-providers.isLocalUrl 的判据。 */
function ttsIsLocalUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  let u;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
}

/* 当前配置「能不能真的发请求」。
 * 同 llm 的 isUsable：本地端点不用 key，云端必须有 key。 */
function ttsIsUsable(tts) {
  const baseUrl = tts?.baseUrl ?? '';
  if (typeof tts?.apiKey === 'string' && tts.apiKey.trim()) return true;
  return ttsIsLocalUrl(baseUrl);
}

/* 当前生效的是哪条预设。
 * 优先信 `tts.provider`；旧配置没有这个键就按 baseUrl 反查。
 * 两边都对不上才是 custom。 */
function ttsCurrentProviderId(tts) {
  const id = tts?.provider;
  if (typeof id === 'string' && ttsProviderById(id)) return id;
  const base = typeof tts?.baseUrl === 'string' ? tts.baseUrl.trim().replace(/\/+$/, '') : '';
  if (base) {
    const hit = PROVIDERS.find((p) => !p.custom && p.baseUrl === base);
    if (hit) return hit.id;
  }
  return 'custom';
}

/* 把一条预设转成要写进 config.tts 的那几个键。
 * custom 不覆盖地址/模型/音色。 */
function ttsToPatch(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (provider.custom) return { provider: provider.id };
  return {
    provider: provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
    voice: provider.voice
  };
}

/* ============================================================
 *  一键测试（ttsTest）
 * ==========================================================
 *
 *  真发一句「你好」，能拿到音频字节就算通。
 *  只判「能不能出声」，不判音色好坏 —— 那是耳朵的事。
 *
 *  @param {object} override 设置页里「先测再存」：用表单当前值，不强制已落盘。
 *  @returns {Promise<{ok:true, bytes:number} | {ok:false, error:string}>}
 *            永远 resolve，不 reject —— 调用方（托盘菜单）要 toast，不能抛。
 */
async function ttsTest(override) {
  const tts = { ...(override && typeof override === 'object' ? override : {}) };
  if (!ttsIsUsable(tts)) {
    return { ok: false, error: '没 key / 未配端点' };
  }
  const url = `${String(tts.baseUrl || '').replace(/\/+$/, '')}/audio/speech`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SYNTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(tts.apiKey ? { Authorization: `Bearer ${tts.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: tts.model || 'tts-1',
        voice: tts.voice || 'alloy',
        input: '你好',
        response_format: 'wav'
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${String(body).slice(0, 200)}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2048) {
      return { ok: false, error: `音频太短（${buf.length} 字节），不是有效 wav` };
    }
    return { ok: true, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? '超时' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/* 空 model 时自动拉取（gsv 网关的 /v1/models 返回当前模型 ID）。
 * 按 baseUrl 缓存，避免每句都拉。 */
const modelCache = new Map();

async function resolveModel(baseUrl, apiKey, fallback) {
  if (fallback) return fallback;
  const key = String(baseUrl).replace(/\/+$/, '');
  if (modelCache.has(key)) return modelCache.get(key);
  try {
    const res = await fetch(`${key}/models`, {
      signal: AbortSignal.timeout(3000),
      ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {})
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const id = data?.data?.[0]?.id || data?.models?.[0]?.id || data?.[0]?.id;
      if (typeof id === 'string' && id.trim()) {
        modelCache.set(key, id.trim());
        return id.trim();
      }
    }
  } catch { /* 拉不到就用 fallback */ }
  return fallback || 'tts-1';
}

/* ============================================================
 *  合成一句话 → wav 字节（OpenAI 兼容）
 * ==========================================================
 *
 *  ⚠️ 永远 resolve，不 reject —— 调用方要在「合成不出来」时无缝回退
 *     到 WinRT，抛异常会把朗读队列卡住。
 *
 *  @param {string} text
 *  @param {object} opts { rate?, voice?, provider?, baseUrl?, apiKey?, model? }
 *  @returns {Promise<{ok:true, wav:Buffer} | {ok:false, error:string}>}
 */
async function openaiSynthWav(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, error: 'empty' };
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'no-baseUrl' };

  const model = await resolveModel(baseUrl, opts.apiKey, opts.model && opts.model.trim() ? opts.model.trim() : null);

  const url = `${baseUrl}/audio/speech`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SYNTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: model,
        voice: opts.voice || 'alloy',
        input: t.slice(0, MAX_TEXT_CHARS),
        response_format: 'wav',
        ...(Number.isFinite(opts.rate) ? { speed: opts.rate } : {})
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${String(body).slice(0, 200)}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 2048) {
      return { ok: false, error: `音频太短（${buf.length} 字节）` };
    }
    return { ok: true, wav: buf };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? '超时' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  PROVIDERS,
  MAX_TEXT_CHARS,
  SYNTH_TIMEOUT_MS,
  ttsProviderById,
  ttsIsLocalUrl,
  ttsIsUsable,
  ttsCurrentProviderId,
  ttsToPatch,
  ttsTest,
  openaiSynthWav
};
