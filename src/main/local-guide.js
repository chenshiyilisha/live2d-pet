'use strict';

/* ============================================================
 *  本地首包引导（M7）
 * ==========================================================
 *
 *  探测本机常见推理端口是否在听，给「下一步怎么装」文案。
 *  **不内置权重、不替用户 pull** —— 只指路。
 *
 *  纯探测函数 + 文案；verify 可 mock fetch。
 * ========================================================== */

const ENDPOINTS = Object.freeze([
  {
    id: 'ollama',
    label: 'Ollama',
    url: 'http://127.0.0.1:11434/api/tags',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    hint: '已在听。托盘选 Ollama，模型名填本地已 pull 的（如 qwen2.5:7b）。还没有模型就在终端跑：ollama pull qwen2.5:7b'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    url: 'http://127.0.0.1:1234/v1/models',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    hint: '已在听。托盘选 LM Studio，把 Local Server 里显示的模型名填上即可。'
  }
]);

/**
 * 探测一条端点。可注入 fetch 方便测。
 * @returns {Promise<{ id, label, ok, baseUrl, model, hint, error? }>}
 */
async function probeOne(ep, fetchImpl = globalThis.fetch, timeoutMs = 1200) {
  if (typeof fetchImpl !== 'function') {
    return { ...pick(ep), ok: false, error: 'no-fetch' };
  }
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ac?.abort(); } catch { /* */ } }, timeoutMs);
  try {
    const res = await fetchImpl(ep.url, {
      method: 'GET',
      signal: ac?.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timer);
    return { ...pick(ep), ok: !!res && res.ok !== false && (res.status == null || (res.status >= 200 && res.status < 500)) };
  } catch (err) {
    clearTimeout(timer);
    return { ...pick(ep), ok: false, error: String(err?.name || err?.message || err) };
  }
}

function pick(ep) {
  return {
    id: ep.id,
    label: ep.label,
    baseUrl: ep.baseUrl,
    model: ep.model,
    hint: ep.hint
  };
}

/** 扫全部本地端点。 */
async function probeLocalEndpoints(fetchImpl, timeoutMs) {
  const out = [];
  for (const ep of ENDPOINTS) {
    out.push(await probeOne(ep, fetchImpl, timeoutMs));
  }
  return out;
}

/** 生成给用户看的短结论文案。 */
function summarizeProbes(results) {
  const ok = (results || []).filter((r) => r && r.ok);
  if (!ok.length) {
    return {
      toast: '本机还没侦测到 Ollama(11434) 或 LM Studio(1234)。装好并启动后再点检测。',
      lines: [
        'Ollama：https://ollama.com → 安装后终端 ollama pull qwen2.5:7b',
        'LM Studio：打开 Local Server，端口默认 1234'
      ]
    };
  }
  return {
    toast: ok.map((r) => `${r.label} ✓`).join(' · ') + ' —— 详情见下方',
    lines: ok.map((r) => r.hint)
  };
}

module.exports = {
  ENDPOINTS,
  probeOne,
  probeLocalEndpoints,
  summarizeProbes
};
