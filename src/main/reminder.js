'use strict';

const { clamp } = require('./util');
const { loadConfig } = require('./config');

/* ============================================================
 *  定时提醒 / 番茄钟
 * ==========================================================
 *
 * 「到点了」这件事本身（弹气泡 + 必要时把窗口唤出来）要碰窗口，所以由
 * main.js 用 setReminderSink() 注入一个出口。除此之外这一层是自包含的：
 * 计时器、队列、番茄钟状态机全在这里。
 * ========================================================== */

let reminders = [];        // { id, at, text, kind }
let reminderSeq = 1;
let reminderTimer = null;
let pomodoro = null;       // { workMin, breakMin, phase, endAt, timer, round }

/* 到点时的出口。main.js 启动时注入；没注入就静默丢弃（不该发生）。 */
let emitReminder = null;
function setReminderSink(fn) { emitReminder = fn; }

function fireReminder(r) {
  if (typeof emitReminder !== 'function') return;
  const text = r.kind === 'pomodoro'
    ? r.text
    : (r.text || '时间到了。');
  emitReminder({
    text,
    kind: r.kind,
    emotion: r.kind === 'pomodoro' ? 'happy' : 'surprised'
  });
}

function scheduleReminders() {
  clearTimeout(reminderTimer);
  if (!reminders.length) return;
  reminders.sort((a, b) => a.at - b.at);
  const next = reminders[0];
  const delay = Math.max(50, next.at - Date.now());
  reminderTimer = setTimeout(() => {
    reminders = reminders.filter((r) => r.id !== next.id);
    fireReminder(next);
    scheduleReminders();
  }, delay);
}

function addReminder(minutes, text, kind = 'reminder') {
  const cfg = loadConfig();
  if (cfg.reminder?.enabled === false) return null;
  const mins = clamp(Number(minutes) || 0, 0.05, 24 * 60);
  const r = { id: reminderSeq++, at: Date.now() + mins * 60000, text, kind };
  reminders.push(r);
  scheduleReminders();
  return r;
}

function clearReminders() {
  reminders = [];
  clearTimeout(reminderTimer);
}

function reminderCount() { return reminders.length; }

function listReminders() {
  return reminders.map((r) => ({ id: r.id, at: r.at, text: r.text, kind: r.kind }));
}

/* 番茄钟：默认 25 分钟专注 + 5 分钟休息，循环。
 * 每段结束走同一条提醒通道，渲染层拿到的就是一条普通提醒。 */
function startPomodoro(workMin = 25, breakMin = 5) {
  stopPomodoro(true);
  pomodoro = { workMin, breakMin, phase: 'work', round: 1, timer: null, endAt: 0 };
  pumpPomodoro();
}

function pumpPomodoro() {
  if (!pomodoro) return;
  const isWork = pomodoro.phase === 'work';
  const mins = isWork ? pomodoro.workMin : pomodoro.breakMin;
  pomodoro.endAt = Date.now() + mins * 60000;

  clearTimeout(pomodoro.timer);
  pomodoro.timer = setTimeout(() => {
    if (!pomodoro) return;
    fireReminder({
      kind: 'pomodoro',
      text: isWork
        ? `第 ${pomodoro.round} 轮结束，起来走两步，休息 ${pomodoro.breakMin} 分钟。`
        : '休息结束，回来接着干。'
    });
    if (isWork) {
      pomodoro.phase = 'break';
    } else {
      pomodoro.phase = 'work';
      pomodoro.round += 1;
    }
    pumpPomodoro();
  }, mins * 60000);
}

function stopPomodoro(silent = false) {
  if (pomodoro?.timer) clearTimeout(pomodoro.timer);
  const had = !!pomodoro;
  pomodoro = null;
  if (had && !silent) {
    fireReminder({ kind: 'pomodoro', text: '番茄钟停了。', emotion: 'calm' });
  }
}

function pomodoroStatus() {
  if (!pomodoro) return null;
  const left = Math.max(0, Math.round((pomodoro.endAt - Date.now()) / 1000));
  return { phase: pomodoro.phase, round: pomodoro.round, leftSec: left };
}

/* 退出时清干净。 */
function disposeReminders() {
  clearTimeout(reminderTimer);
  if (pomodoro?.timer) clearTimeout(pomodoro.timer);
  pomodoro = null;
}

module.exports = {
  setReminderSink,
  addReminder,
  clearReminders,
  reminderCount,
  listReminders,
  startPomodoro,
  stopPomodoro,
  pomodoroStatus,
  disposeReminders
};
