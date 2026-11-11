'use strict';
/**
 * affinity.js —— 好感度等级（W65）
 *
 * 出处：zhu1090093659/dsh-pet（Apache-2.0）的好感度 9 级成长体系
 * （幼鲸→伙伴→挚友→…→鲸生共渡，+1/轮，喂食 +5）。
 * 我们只借「等级成长」的形态，不搬其喂食 / 任务 / gacha 系统。
 *
 * 设计要点：
 *   · 9 级，每级一个阈值（points 累计达到即升级）。
 *   · 增长：每轮对话 +1（chat），摸头 +5（pat —— 喂食在我们这儿的对应物）。
 *   · **纯累计、不衰减**：好感不会倒退 —— 与 mood 的漂移轴是两回事
 *     （mood 管「此刻的情绪」，affinity 管「长年累月的关系深度」）。
 *   · 存档：userData/affinity.json（points + totalLevelUps）。
 *
 * ⚠️ 开关口径（与 W64 一致）：**一直累计**（计数器增量，零开销），
 *    开关 monitor.affinity 只控制「是否在底座显示」。
 *    —— 关掉不丢进度，打开就看到当前等级；不因开关而冻结数字。
 */

const fs = require('fs');

/* 9 级成长体系。threshold = 进入该级所需的累计 points。
 * 名字走鲸鱼娘谱系（产品主线是鲸鱼），与 deepfish/whale 一致。 */
const LEVELS = [
  { name: '幼鲸', threshold: 0 },
  { name: '玩伴', threshold: 10 },
  { name: '伙伴', threshold: 30 },
  { name: '好友', threshold: 60 },
  { name: '挚友', threshold: 100 },
  { name: '知心', threshold: 160 },
  { name: '莫逆', threshold: 240 },
  { name: '至交', threshold: 340 },
  { name: '鲸生共渡', threshold: 460 }
];

/* 事件增量。出处 dsh-pet：+1/轮，喂食 +5。
 * 我们没有「喂食」动作，摸头（pat）是等价的身体互动 → +5。 */
const GAIN = {
  chat: 1,
  pat: 5
};

let storePath = null;
let points = 0;
let totalLevelUps = 0;
let saveTimer = null;

function setStorePath(p) {
  storePath = p;
  load();
}

function load() {
  if (!storePath) return;
  try {
    const d = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (Number.isFinite(Number(d.points))) {
      points = Math.max(0, Math.floor(Number(d.points)));
    }
    if (Number.isFinite(Number(d.totalLevelUps))) {
      totalLevelUps = Math.max(0, Math.floor(Number(d.totalLevelUps)));
    }
  } catch { /* 首次运行 / 坏档 → 用初值（0 级） */ }
}

function scheduleSave() {
  if (!storePath) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flush();
  }, 1500);
}

function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!storePath) return;
  try {
    const tmp = storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ points, totalLevelUps, t: Date.now() }));
    fs.renameSync(tmp, storePath);
  } catch { /* 记不住就记不住，不影响互动 */ }
}

/* 累计 points → 等级索引（最高满足 threshold 的那一级）。 */
function levelOf(p) {
  let lv = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (p >= LEVELS[i].threshold) lv = i;
  }
  return lv;
}

/** 加积分。返回 { leveledUp, from, to, name }。
 *  ⚠️ 只加不减（好感不倒退）；n 非法时静默忽略。 */
function addPoints(n, _reason) {
  const inc = Number(n);
  if (!Number.isFinite(inc) || inc <= 0) return { leveledUp: false, from: levelOf(points), to: levelOf(points) };
  const from = levelOf(points);
  points += Math.floor(inc);
  const to = levelOf(points);
  if (to > from) totalLevelUps += (to - from);
  scheduleSave();
  return { leveledUp: to > from, from, to, name: LEVELS[to].name };
}

/** 汇总（给渲染层显示）。 */
function info() {
  const lv = levelOf(points);
  const cur = LEVELS[lv];
  const next = LEVELS[lv + 1] || null;
  return {
    points,
    level: lv,
    name: cur.name,
    nextName: next ? next.name : null,
    nextThreshold: next ? next.threshold : null,
    progress: next ? (points - cur.threshold) / (next.threshold - cur.threshold) : 1,
    totalLevelUps,
    maxLevel: LEVELS.length - 1
  };
}

function resetForTest() {
  points = 0;
  totalLevelUps = 0;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

module.exports = {
  LEVELS, GAIN, setStorePath, addPoints, info, levelOf, flush, resetForTest,
  _points: () => points,
};
