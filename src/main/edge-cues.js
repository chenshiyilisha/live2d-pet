'use strict';

/* ============================================================
 *  边缘搭话线索（X5）
 * ==========================================================
 *
 *  把 CPU / 电量 / 刚切应用 收成一句短 hint，塞进主动搭话 user 泡。
 *  可沉默：线索弱或不适合开口时返回 preferSilent 提示，由模型回 [silent]。
 *
 *  纯函数；阈值故意保守 —— 误报比漏报更烦。
 * ========================================================== */

const CPU_BUSY = 85;
const BATTERY_LOW = 18;

/**
 * @param {{ cpu?: number|null, battery?: { percent?: number, charging?: boolean }|null, fgSwitched?: boolean }} snap
 * @returns {{ hint: string, preferSilent: boolean }}
 */
function edgeCueFrom(snap) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const cpu = typeof s.cpu === 'number' && Number.isFinite(s.cpu) ? s.cpu : null;
  const bat = s.battery && typeof s.battery === 'object' ? s.battery : null;
  const pct = typeof bat?.percent === 'number' ? bat.percent : null;
  const charging = !!bat?.charging;
  const switched = !!s.fgSwitched;

  if (pct != null && !charging && pct <= BATTERY_LOW) {
    return {
      hint: `主机电量大约 ${Math.round(pct)}%，可以随口提一句接电源或歇会儿，别念百分比。`,
      preferSilent: false
    };
  }
  if (cpu != null && cpu >= CPU_BUSY) {
    return {
      hint: '机器有点忙，别催干活；轻声一句或只回 [silent]。',
      preferSilent: true
    };
  }
  if (switched) {
    return {
      hint: '主人刚切了前台应用，点到为止，别追问窗口内容；没什么可说就 [silent]。',
      preferSilent: true
    };
  }
  return { hint: '', preferSilent: false };
}

module.exports = {
  CPU_BUSY,
  BATTERY_LOW,
  edgeCueFrom
};
