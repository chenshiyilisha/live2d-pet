'use strict';

/* ============================================================
 *  药盒式一次性指令（G6 / pilulier 味道）
 * ==========================================================
 *
 *  只影响**下一句**回复，用完即焚，不写进 persona / 不进长期记忆。
 *  状态放进程内存 —— 重启即丢是故意的（一次性纠偏不该隔夜还挂着）。
 *
 *  注入位置：system 人设正文末尾加「【仅本轮】…」一段；consume() 在
 *  组装 messages 时取走并清空。
 * ========================================================== */

const PILLS = [
  { id: 'short', label: '简短回答', text: '这一轮请用一两句短话回答，别展开。' },
  { id: 'lively', label: '更活泼', text: '这一轮语气更活泼一点，可以带点俏皮，别端着。' },
  { id: 'no-cs', label: '别客服腔', text: '这一轮禁止客服腔和模板套话，像朋友随口说。' },
  { id: 'serious', label: '认真正经', text: '这一轮认真、克制、少情绪词，先把事说清楚。' },
  { id: 'think', label: '先想再说', text: '这一轮可以先用 [think:…] 写一句心里话，再说出口。' }
];

let pending = '';

function listPills() {
  return PILLS.slice();
}

function getPending() {
  return pending;
}

function setPending(text) {
  const t = String(text || '').trim().slice(0, 200);
  pending = t;
  return pending;
}

function clearPending() {
  pending = '';
}

/* 取走并清空。空串 = 本轮没有药。 */
function consume() {
  const t = pending;
  pending = '';
  return t;
}

function pillById(id) {
  return PILLS.find((p) => p.id === id) || null;
}

module.exports = {
  PILLS,
  listPills,
  getPending,
  setPending,
  clearPending,
  consume,
  pillById
};
