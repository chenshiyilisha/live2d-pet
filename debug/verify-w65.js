'use strict';
/**
 * verify-w65.js —— 好感度等级验收
 *
 * 分两段：
 *   A. affinity.js 纯模块真跑（等级映射 / 积分累计 / 升级 / 持久化）。
 *   B. 接线源码级断言（main.js 事件点积分 + 推送 + 托盘、config.js 配置键、
 *      pet.js STAT_ITEMS 好感项）。
 *
 * 规矩 28：负对照 —— 把某处改坏后断言必须变红。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC = (p) => path.join(ROOT, 'src', p);

let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); } };
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================================================
 *  A. affinity.js 纯模块
 * ========================================================== */
const affinity = require(SRC('main/affinity.js'));

// A1: 9 级体系
eq(affinity.LEVELS.length, 9, 'A1 9 级体系');
eq(affinity.LEVELS[0].name, '幼鲸', 'A1 第 0 级是幼鲸');
eq(affinity.LEVELS[8].name, '鲸生共渡', 'A1 第 8 级是鲸生共渡');
// 阈值递增
let mono = true;
for (let i = 1; i < affinity.LEVELS.length; i++) {
  if (affinity.LEVELS[i].threshold <= affinity.LEVELS[i - 1].threshold) mono = false;
}
ok(mono, 'A1 阈值递增');

// A2: 用临时文件隔离持久化
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w65-'));
const tmpFile = path.join(tmpDir, 'affinity.json');
affinity.setStorePath(tmpFile);
affinity.resetForTest();

// A3: 初始 0 级
let info = affinity.info();
eq(info.level, 0, 'A3 初始 0 级');
eq(info.name, '幼鲸', 'A3 初始名字幼鲸');
eq(info.points, 0, 'A3 初始 points=0');
eq(info.totalLevelUps, 0, 'A3 初始 totalLevelUps=0');

// A4: 对话 +1
let r = affinity.addPoints(affinity.GAIN.chat, 'chat');
eq(r.leveledUp, false, 'A4 对话 +1 不升级（<10）');
eq(affinity._points(), 1, 'A4 points=1');

// A5: 累积到升级（再 +9 → 10 分 → 第 1 级玩伴）
for (let i = 0; i < 9; i++) affinity.addPoints(1, 'chat');
info = affinity.info();
eq(info.level, 1, 'A5 10 分 → 第 1 级');
eq(info.name, '玩伴', 'A5 第 1 级是玩伴');
eq(info.totalLevelUps, 1, 'A5 totalLevelUps=1');

// A6: 摸头 +5
affinity.addPoints(affinity.GAIN.pat, 'pat');
eq(affinity._points(), 15, 'A6 摸头 +5 → points=15');

// A7: 非法积分不加分
affinity.addPoints(-3, 'x');
affinity.addPoints(NaN, 'x');
affinity.addPoints(0, 'x');
eq(affinity._points(), 15, 'A7 负数/NaN/0 不加分');

// A8: 只升不降（好感不倒退）
const before = affinity._points();
affinity.addPoints(100, 'chat');
ok(affinity._points() > before, 'A8 加分后 points 增加');

// A9: 持久化
affinity.flush();
const saved = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
ok(saved && Number.isFinite(Number(saved.points)), 'A9 持久化落盘');
eq(Number(saved.points), affinity._points(), 'A9 落盘 points 一致');

// A10: 重新加载
affinity.resetForTest();
affinity.setStorePath(tmpFile);
eq(affinity._points(), Number(saved.points), 'A10 重载后 points 恢复');

/* ============================================================
 *  B. 接线源码级断言
 * ========================================================== */
const mainSrc = read(SRC('main/main.js'));
const cfgSrc = read(SRC('main/config.js'));
const petSrc = read(SRC('renderer/pet.js'));

// B1: main.js 初始化
ok(mainSrc.includes('affinity.setStorePath'), 'B1 main.js 初始化 affinity.setStorePath');
ok(mainSrc.includes('affinity.json'), 'B1 main.js 用 affinity.json');

// B2: main.js 事件点积分
ok(mainSrc.includes('affinity.addPoints'), 'B2 main.js 有 affinity.addPoints');
ok(mainSrc.includes("affinity.GAIN.pat"), 'B2 main.js 摸头用 GAIN.pat');
ok(mainSrc.includes("affinity.GAIN.chat"), 'B2 main.js 对话用 GAIN.chat');

// B3: main.js 推送
ok(mainSrc.includes('affinitySummaryForPush'), 'B3 main.js 有 affinitySummaryForPush');
ok(mainSrc.includes('s.affinity = affinitySummaryForPush()'), 'B3 main.js push 带 s.affinity');

// B4: main.js 托盘 flag
ok(mainSrc.includes("flag('monitor', 'affinity'"), 'B4 main.js 托盘 monitor.affinity flag');

// B5: config.js 配置键
ok(cfgSrc.includes('affinity: false'), 'B5 config monitor.affinity 默认关');

// B6: pet.js STAT_ITEMS 好感项
ok(/key:\s*'affinity'/.test(petSrc), 'B6 pet.js STAT_ITEMS 有 affinity 项');
ok(petSrc.includes('s?.affinity'), 'B6 pet.js 读 s.affinity');
ok(petSrc.includes('nextThreshold'), 'B6 pet.js 读 nextThreshold');

/* ============================================================
 *  负对照（规矩 28）
 * ========================================================== */
// C1: 若 pet.js 没有 affinity 项，B6 应红
const petNoAffinity = petSrc.replace(/key:\s*'affinity'/g, "key: 'noaffinity'");
ok(!/key:\s*'affinity'/.test(petNoAffinity), 'C1 负对照：替换 affinity 项后不再匹配（B6 会红）');

// C2: 若 main.js 没有 GAIN.pat 积分，B2 应红
const mainNoPat = mainSrc.replace(/affinity\.GAIN\.pat/g, 'affinity.GAIN.none');
ok(!mainNoPat.includes('affinity.GAIN.pat'), 'C2 负对照：移除 GAIN.pat 后不再含（B2 会红）');

console.log(`\n${failed === 0 ? '✅ verify-w65 全绿' : '❌ verify-w65 有失败'}：${passed} 通过 / ${failed} 失败`);
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
