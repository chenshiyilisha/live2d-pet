'use strict';

/* ============================================================
 *  LLM 多配置档（M6）
 * ==========================================================
 *
 *  「家里 Ollama / 公司 DeepSeek」各存一份完整连接参数，一键切换。
 *  纯函数：不碰 electron / 不落盘 —— verify 可直接 node 跑。
 *
 *  存储形状（落在 config.llm 上）：
 *    profiles: { [id]: { id, label, provider, baseUrl, apiKey, model,
 *                        extraBody, stallMs, totalMs } }
 *    activeProfile: id | ''
 *
 *  真正发请求仍读 llm 顶层的 baseUrl/model/…（与旧代码兼容）。
 *  切换 = 把某档字段**拷到顶层**；「存当前」= 把顶层**拷进 profiles[id]**。
 * ========================================================== */

const SNAP_KEYS = ['provider', 'baseUrl', 'apiKey', 'model', 'extraBody', 'stallMs', 'totalMs'];

function newId() {
  return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
}

function snapFromLlm(llm, label) {
  const src = llm && typeof llm === 'object' ? llm : {};
  const out = { id: newId(), label: String(label || '未命名').trim() || '未命名' };
  for (const k of SNAP_KEYS) {
    if (k === 'extraBody') {
      out.extraBody = src.extraBody && typeof src.extraBody === 'object' && !Array.isArray(src.extraBody)
        ? { ...src.extraBody } : {};
    } else if (k === 'stallMs' || k === 'totalMs') {
      const n = Number(src[k]);
      out[k] = Number.isFinite(n) ? n : (k === 'stallMs' ? 20000 : 120000);
    } else {
      out[k] = src[k] == null ? '' : src[k];
    }
  }
  return out;
}

function applySnapToLlm(llm, snap) {
  const next = { ...(llm && typeof llm === 'object' ? llm : {}) };
  if (!snap) return next;
  for (const k of SNAP_KEYS) {
    if (k === 'extraBody') {
      next.extraBody = snap.extraBody && typeof snap.extraBody === 'object'
        ? { ...snap.extraBody } : {};
    } else if (snap[k] !== undefined) {
      next[k] = snap[k];
    }
  }
  next.activeProfile = snap.id || '';
  return next;
}

function listProfiles(llm) {
  const map = llm?.profiles && typeof llm.profiles === 'object' ? llm.profiles : {};
  return Object.values(map)
    .filter((p) => p && typeof p === 'object' && p.id)
    .sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh'));
}

function getProfile(llm, id) {
  const map = llm?.profiles && typeof llm.profiles === 'object' ? llm.profiles : {};
  return map[id] || null;
}

/** 把当前顶层连接存成一档（新建）。返回新 snap。 */
function saveCurrentAs(llm, label) {
  const snap = snapFromLlm(llm, label);
  return snap;
}

/** 用当前顶层覆盖已有一档。没有该 id 则当新建。 */
function overwriteProfile(llm, id, label) {
  const prev = getProfile(llm, id);
  const snap = snapFromLlm(llm, label || prev?.label || '未命名');
  snap.id = id || snap.id;
  return snap;
}

module.exports = {
  SNAP_KEYS,
  newId,
  snapFromLlm,
  applySnapToLlm,
  listProfiles,
  getProfile,
  saveCurrentAs,
  overwriteProfile
};
