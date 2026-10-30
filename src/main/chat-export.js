'use strict';

/* ============================================================
 *  对话导出 MD / JSON（G13）
 * ==========================================================
 *
 *  纯函数：把 history 数组渲成字符串。不碰磁盘 / Electron ——
 *  落盘与弹窗在 main.js。
 * ========================================================== */

function normalizeHistory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      role: m.role,
      content: String(m.content).replace(/\r\n/g, '\n').trim()
    }))
    .filter((m) => m.content);
}

function toJson(arr, meta = {}) {
  const messages = normalizeHistory(arr);
  return JSON.stringify({
    exportedAt: meta.exportedAt || new Date().toISOString(),
    name: meta.name || '',
    count: messages.length,
    messages
  }, null, 2);
}

function toMarkdown(arr, meta = {}) {
  const messages = normalizeHistory(arr);
  const title = meta.name ? `与「${meta.name}」的对话` : '对话导出';
  const lines = [
    `# ${title}`,
    '',
    `> 导出时间：${meta.exportedAt || new Date().toISOString()} · ${messages.length} 条`,
    ''
  ];
  for (const m of messages) {
    const who = m.role === 'user' ? '主人' : (meta.name || '助手');
    lines.push(`## ${who}`, '', m.content, '');
  }
  return lines.join('\n');
}

module.exports = { normalizeHistory, toJson, toMarkdown };
