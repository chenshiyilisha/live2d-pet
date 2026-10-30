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
 *
 * W7（PawPal 同款）：锁屏 / 睡眠期间**不算桌面使用时间**。
 *   · 锁屏：清掉正在跑的 timeout（倒计时「清零」）
 *   · 解锁：按**完整原间隔**重排（「重计」）—— 不会一回来就炸一堆过期提醒
 * 番茄钟当前相位同样：解锁后从完整 work/break 分钟重开这一段。
 * ========================================================== */

let reminders = [];        // { id, at, text, kind, durationMs }
let reminderSeq = 1;
let reminderTimer = null;
let pomodoro = null;       // { workMin, breakMin, phase, endAt, timer, round }
let screenLocked = false;

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
  reminderTimer = null;
  if (screenLocked) return;          // W7：锁着不排
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
  const durationMs = mins * 60000;
  const r = {
    id: reminderSeq++,
    at: Date.now() + durationMs,
    text,
    kind,
    durationMs          // W7：解锁重计用完整间隔
  };
  reminders.push(r);
  scheduleReminders();
  return r;
}

function clearReminders() {
  reminders = [];
  clearTimeout(reminderTimer);
  reminderTimer = null;
}

function reminderCount() { return reminders.length; }

function listReminders() {
  return reminders.map((r) => ({
    id: r.id,
    at: r.at,
    text: r.text,
    kind: r.kind,
    durationMs: r.durationMs
  }));
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
  if (screenLocked) return;          // W7：锁着不排当前段
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
  const left = screenLocked
    ? Math.round((pomodoro.phase === 'work' ? pomodoro.workMin : pomodoro.breakMin) * 60)
    : Math.max(0, Math.round((pomodoro.endAt - Date.now()) / 1000));
  return { phase: pomodoro.phase, round: pomodoro.round, leftSec: left, locked: screenLocked };
}

/* W7：锁屏 —— 清掉进行中的 timeout（倒计时「清零」）。 */
function onScreenLock() {
  if (screenLocked) return;
  screenLocked = true;
  clearTimeout(reminderTimer);
  reminderTimer = null;
  if (pomodoro?.timer) {
    clearTimeout(pomodoro.timer);
    pomodoro.timer = null;
  }
}

/* W7：解锁 —— 按完整原间隔重排（「重计」）。 */
function onScreenUnlock() {
  if (!screenLocked) return;
  screenLocked = false;
  const now = Date.now();
  for (const r of reminders) {
    const ms = Number(r.durationMs) > 0 ? r.durationMs : Math.max(60000, r.at - now);
    r.at = now + ms;
  }
  scheduleReminders();
  if (pomodoro) pumpPomodoro();   // 当前相位从完整 work/break 重开
}

function isReminderScreenLocked() { return screenLocked; }

/* 退出时清干净。 */
function disposeReminders() {
  clearTimeout(reminderTimer);
  if (pomodoro?.timer) clearTimeout(pomodoro.timer);
  pomodoro = null;
  screenLocked = false;
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
  disposeReminders,
  onScreenLock,
  onScreenUnlock,
  isReminderScreenLocked
};
