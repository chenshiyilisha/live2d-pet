'use strict';

/* ============================================================
 *  Agent 事件只读 JSONL（W29）
 * ==========================================================
 *  蓝本 dsh-pet AGENT_LINK_PROTOCOL（只借机制）：
 *    · 六态 thinking/working/attention/error/idle/sleeping
 *    · Claude hooks 事件名映射；表外忽略
 *    · byte-offset tail；半行缓冲；单次 ≤64KB；失败静默
 *    · 不写代码/命令/文件内容
 * ========================================================== */

const fs = require('fs');
const path = require('path');
const { WORK_STATUS } = require('./work-cues');

const STATES = Object.freeze([
  'thinking', 'working', 'attention', 'error', 'idle', 'sleeping'
]);

/** Claude Code hooks → 六态 */
const EVENT_MAP = Object.freeze({
  SessionStart: 'idle',
  SessionEnd: 'idle',
  UserPromptSubmit: 'thinking',
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'error',
  StopFailure: 'error',
  Stop: 'attention',
  SubagentStop: 'attention'
});

const READ_CAP = 64 * 1024;

function normalizeState(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return STATES.includes(s) ? s : null;
}

/**
 * 解析一行。表外事件 → null（绝不默认 working）。
 * @returns {{ state: string, agent?: string, tool?: string, ts?: number }|null}
 */
function parseAgentLine(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  let obj;
  try { obj = JSON.parse(t); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  let state = normalizeState(obj.state);
  if (!state && obj.event != null) {
    const mapped = EVENT_MAP[String(obj.event)];
    state = mapped || null;
  }
  if (!state) return null;

  const out = { state };
  if (typeof obj.agent === 'string' && obj.agent) out.agent = obj.agent.slice(0, 64);
  if (typeof obj.tool === 'string' && obj.tool) out.tool = obj.tool.slice(0, 64);
  const ts = Number(obj.ts);
  if (Number.isFinite(ts)) out.ts = ts;
  return out;
}

/** 工作态 IPC 用的 phase（sleeping→idle；attention 保留）。 */
function stateToWorkPhase(state) {
  const s = normalizeState(state);
  if (!s || s === 'idle' || s === 'sleeping') return 'idle';
  if (WORK_STATUS.includes(s) || s === 'attention') return s;
  return 'idle';
}

/**
 * 增量读一个 JSONL 尾。
 * @param {{ path: string, offset: number, pending?: string }} cursor
 * @returns {{ cursor, events: object[] }}
 */
function readAgentTail(cursor = {}) {
  const file = String(cursor.path || '');
  let offset = Math.max(0, Number(cursor.offset) || 0);
  let pending = typeof cursor.pending === 'string' ? cursor.pending : '';
  const events = [];

  if (!file) {
    return { cursor: { path: '', offset: 0, pending: '' }, events };
  }

  let st;
  try { st = fs.statSync(file); } catch {
    return { cursor: { path: file, offset: 0, pending: '' }, events };
  }

  /* 轮转 / 截断：offset 超出 → 从头 */
  if (offset > st.size) {
    offset = 0;
    pending = '';
  }

  const toRead = Math.min(READ_CAP, Math.max(0, st.size - offset));
  if (toRead <= 0) {
    return { cursor: { path: file, offset, pending }, events };
  }

  let buf;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, offset);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { cursor: { path: file, offset, pending }, events };
  }

  offset += toRead;
  const text = pending + buf.toString('utf8');
  const parts = text.split('\n');
  pending = parts.pop() || '';
  for (const line of parts) {
    const ev = parseAgentLine(line);
    if (ev) events.push(ev);
  }
  /* 半行过长保护：丢弃避免内存涨 */
  if (pending.length > 8 * 1024) pending = '';

  return { cursor: { path: file, offset, pending }, events };
}

/**
 * 列目录下 *.jsonl（失败 → []）。
 * @param {string} dir
 */
function listAgentFiles(dir) {
  try {
    const names = fs.readdirSync(dir);
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n))
      .sort();
  } catch {
    return [];
  }
}

module.exports = {
  STATES,
  EVENT_MAP,
  READ_CAP,
  normalizeState,
  parseAgentLine,
  stateToWorkPhase,
  readAgentTail,
  listAgentFiles
};
