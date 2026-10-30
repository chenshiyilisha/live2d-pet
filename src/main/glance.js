'use strict';

/* G23 / W15：看一眼屏幕。
 *
 * 纯函数 + 截屏拼装；藏窗 / desktopCapturer 由调用方注入（好测、不环依赖 main）。
 *
 * 安全口径：
 *   · 默认关（interaction.glance）
 *   · 截前藏自己，避免把自己截进图
 *   · 缩到 ≤768 宽 JPEG ~70（内存不落盘）
 *   · 口令匹配要**短且整句**是看屏意图，长句仍走普通对话
 */

const DEFAULT_MAX_W = 768;
const DEFAULT_JPEG_Q = 70;

/** W15：整句口令。过长 / 夹带别的事 → false（交给普通对话）。 */
function isGlancePhrase(text) {
  const q = String(text || '').trim();
  if (!q || q.length > 24) return false;
  return /^(?:帮我)?看(?:看|一眼)(?:一下)?(?:屏幕|桌面)?[.!！?？。…\s]*$/u.test(q)
    || /^看一下(?:屏幕|桌面)?[.!！?？。…\s]*$/u.test(q);
}

/** 按长边缩 thumbnail 目标尺寸（device px）。 */
function glanceThumbSize(display, maxW = DEFAULT_MAX_W) {
  const d = display || {};
  const sf = Number(d.scaleFactor) > 0 ? Number(d.scaleFactor) : 1;
  const sw = Math.max(1, Math.round((d.size?.width || 1280) * sf));
  const sh = Math.max(1, Math.round((d.size?.height || 720) * sf));
  const tw = Math.min(Math.max(160, Number(maxW) || DEFAULT_MAX_W), sw);
  const th = Math.max(1, Math.round(sh * (tw / sw)));
  return { width: tw, height: th };
}

/** NativeImage / Buffer → data URL（JPEG）。 */
function toGlanceDataUrl(image, quality = DEFAULT_JPEG_Q) {
  if (!image) return null;
  const q = Math.min(95, Math.max(40, Number(quality) || DEFAULT_JPEG_Q));
  let buf = null;
  try {
    if (typeof image.toJPEG === 'function') buf = image.toJPEG(q);
    else if (Buffer.isBuffer(image)) buf = image;
  } catch { return null; }
  if (!buf || !buf.length) return null;
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** 组装多模态 user 消息（OpenAI 兼容）。 */
function buildGlanceUserMessage(dataUrl, extra = '') {
  const tip = String(extra || '').trim();
  const text = tip
    || '（主人让你看一眼屏幕。用一两句说说你看到了什么：口语、短、别列清单、别读聊天全文/密码/证件号。）';
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: String(dataUrl) } }
    ]
  };
}

/**
 * 藏窗 → 等一拍 → 截主屏 → 恢复。
 * deps: { hidePet, showPet, getDisplay, getSources, sleep? }
 */
async function captureGlanceScreen(deps = {}) {
  const hidePet = deps.hidePet || (() => {});
  const showPet = deps.showPet || (() => {});
  const getDisplay = deps.getDisplay || (() => null);
  const getSources = deps.getSources;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxW = deps.maxW ?? DEFAULT_MAX_W;
  const quality = deps.quality ?? DEFAULT_JPEG_Q;

  if (typeof getSources !== 'function') {
    return { ok: false, error: 'no-capturer' };
  }

  let hidden = false;
  try {
    hidePet();
    hidden = true;
    await sleep(deps.hideWaitMs ?? 200);

    const disp = getDisplay();
    const thumb = glanceThumbSize(disp, maxW);
    const sources = await getSources({
      types: ['screen'],
      thumbnailSize: thumb
    });
    const list = Array.isArray(sources) ? sources : [];
    const src = list.find((s) => s && s.thumbnail && !s.thumbnail.isEmpty?.()) || list[0];
    if (!src?.thumbnail) return { ok: false, error: 'no-source' };
    if (typeof src.thumbnail.isEmpty === 'function' && src.thumbnail.isEmpty()) {
      return { ok: false, error: 'empty-thumb' };
    }
    const dataUrl = toGlanceDataUrl(src.thumbnail, quality);
    if (!dataUrl) return { ok: false, error: 'encode-fail' };
    return { ok: true, dataUrl, width: thumb.width, height: thumb.height };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 160) };
  } finally {
    if (hidden) {
      try { showPet(); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  DEFAULT_MAX_W,
  DEFAULT_JPEG_Q,
  isGlancePhrase,
  glanceThumbSize,
  toGlanceDataUrl,
  buildGlanceUserMessage,
  captureGlanceScreen
};
