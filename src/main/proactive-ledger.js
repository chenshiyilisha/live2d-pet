'use strict';

const fs = require('fs');
const path = require('path');
const { shouldProactiveSpeak } = require('./info-gain');

/* W26 / W27：主动搭话账本 + 零副作用 preview。
 *
 * 先记账（pending）再调模型；成功 → delivered；中途 abort → interrupted。
 * preview 只跑 shouldProactiveSpeak，不写盘、不调模型。
 */

let dataDir = null;
let seq = 0;

function configureLedger(dir) {
  dataDir = dir || null;
}

function ledgerPath() {
  if (!dataDir) return null;
  return path.join(dataDir, 'proactive-log.jsonl');
}

function appendRow(row) {
  const p = ledgerPath();
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
    return true;
  } catch (err) {
    console.warn('[proactive-ledger] write fail:', String(err?.message || err).slice(0, 120));
    return false;
  }
}

/** W26：开生成前先落一条 pending。 */
function bookDelivery(meta = {}) {
  const id = `p${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const row = {
    id,
    at: Date.now(),
    status: 'pending',
    reason: meta.reason || '',
    head: meta.head || '',
    preferSilent: !!meta.preferSilent
  };
  appendRow(row);
  return row;
}

/** 收尾：delivered | interrupted | silent | skipped | error */
function settleDelivery(id, status, extra = {}) {
  if (!id) return false;
  return appendRow({
    id,
    at: Date.now(),
    status: String(status || 'error'),
    ...extra
  });
}

/**
 * W27：零副作用 preview —— 只返回具名 reason / head，不记账不调模型。
 * @returns {{ speak, reason, preferSilent, head }}
 */
function previewProactive(ctx) {
  return shouldProactiveSpeak(ctx);
}

module.exports = {
  configureLedger,
  bookDelivery,
  settleDelivery,
  previewProactive,
  ledgerPath
};
