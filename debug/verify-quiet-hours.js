'use strict';
/* 免打扰时段（src/renderer/quiet-hours.js）的验收。
 *
 * 纯函数，所以**真跑**（vm 沙箱剥掉 export，同 verify-jitter / verify-proactive
 * 处理 params.js 的手法），不是正则看长相。
 *
 * 这个模块的坏法只有一种，但后果很大：**解析判错 → 用户被静音一整天**。
 * 所以下面的用例分成两组：
 *   · 正常区间（跨零点 / 同日 / 边界闭合方向）；
 *   · **写错的配置一律当"不设"**（空串、缺横杠、越界、"0-0"）——
 *     这组的每一条都对应一种"手滑一个字符"的现实写法。
 *
 * 用法：node debug/verify-quiet-hours.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  ✅ ' + msg); return; }
  failures++;
  console.log('  ❌ ' + msg);
};

/* 沙箱里也要有 Date（模块内部用 `date instanceof Date` 判参）——
 * 不注入的话 `at()` 造的宿主 Date 跨 realm 过不了 instanceof，
 * 函数会静默改用"当前时间"，几条用例就变成随机通过/失败了。 */
const sandbox = { console, Date };
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, 'src/renderer/quiet-hours.js'), 'utf8').replace(/^export\s+/gm, '') +
  '\n;globalThis.__api = { parseQuietHours, inQuietHours, msUntilQuietEnd };',
  sandbox
);
const { parseQuietHours, inQuietHours, msUntilQuietEnd } = sandbox.__api;

/* 固定的一天（2026-01-15），只动小时/分钟 —— 结果与时区无关。 */
const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0);
const M = 60 * 1000;

console.log('══════ A. 解析：认得对的、拦掉错的 ══════\n');

{
  const r = parseQuietHours('23-8');
  ok(r && r.start === 23 * 60 && r.end === 8 * 60, '"23-8" → 1380..480（跨零点）');

  const r2 = parseQuietHours('9-17');
  ok(r2 && r2.start === 540 && r2.end === 1020, '"9-17" → 540..1020（同日）');

  ok(parseQuietHours('  23 - 8  ') !== null, '前后空白与横杠两侧的空格都能容错');
  ok(parseQuietHours('1-7') !== null, '调研里 astrbot 的默认值 "1-7" 认得');

  /* ---- 这一组是重点：全都必须当"不设" ---- */
  const bad = [
    ['', '空串（= 用户想关掉免打扰）'],
    ['  ', '纯空白'],
    ['23', '只有开始'],
    ['23-', '缺结束'],
    ['-8', '缺开始'],
    ['23..8', '分隔符写错'],
    ['24-8', '小时越界（24）'],
    ['23-25', '结束越界（25）'],
    ['8-8', '起止相同（零长度区间）'],
    ['0-0', '0-0 —— 按区间语义算出来是整整 24 小时，必须拦'],
    ['8点半-9点', '写了中文'],
    ['23-8-9', '三段'],
    [null, 'null（键被手删）'],
    [undefined, 'undefined'],
    [23, '写成了数字'],
    [{ start: 1, end: 2 }, '写成了对象']
  ];
  for (const [v, why] of bad) {
    ok(parseQuietHours(v) === null, `"${String(v)}" → 不设免打扰（${why}）`);
  }
}

console.log('\n══════ B. 判据：跨零点的闭合方向 ══════\n');
{
  const night = parseQuietHours('23-8');

  ok(inQuietHours(night, at(23, 0)) === true, '23:00 已进入（start 闭合）');
  ok(inQuietHours(night, at(23, 30)) === true, '23:30 在区间内');
  ok(inQuietHours(night, at(0, 30)) === true, '00:30 还在（跨了零点）');
  ok(inQuietHours(night, at(7, 59)) === true, '07:59 是在区间内的最后一分钟');
  ok(inQuietHours(night, at(8, 0)) === false, '08:00 已经放行（end 开区间）');
  ok(inQuietHours(night, at(22, 59)) === false, '22:59 还没到');
  ok(inQuietHours(night, at(12, 0)) === false, '中午当然不在');

  const noon = parseQuietHours('13-14');
  ok(inQuietHours(noon, at(12, 59)) === false, '同日区间：13 点之前不算');
  ok(inQuietHours(noon, at(13, 0)) === true, '同日区间：13:00 算');
  ok(inQuietHours(noon, at(13, 30)) === true, '同日区间：中间算');
  ok(inQuietHours(noon, at(14, 0)) === false, '同日区间：14:00 放行');

  ok(inQuietHours(null, at(3, 0)) === false, 'range 为 null（不设）→ 任何时候都不静默');
  ok(inQuietHours(null, undefined) === false, 'range 为 null 且不传时间也不炸');
}

console.log('\n══════ C. 距离时段结束还有多久（排定时器用它） ══════\n');
{
  const night = parseQuietHours('23-8');

  ok(msUntilQuietEnd(night, at(23, 30)) === 510 * M, '23:30 起算：还要 8.5 小时（=510 分钟）');
  ok(msUntilQuietEnd(night, at(0, 30)) === 450 * M, '跨过零点之后：00:30 还剩 7.5 小时');
  ok(msUntilQuietEnd(night, at(7, 30)) === 30 * M, '07:30 只剩 30 分钟');
  ok(msUntilQuietEnd(night, at(8, 0)) === 0, '已经出区间 → 0（调用方据此知道不用排）');
  ok(msUntilQuietEnd(night, at(12, 0)) === 0, '白天 → 0');

  const noon = parseQuietHours('13-14');
  ok(msUntilQuietEnd(noon, at(13, 15)) === 45 * M, '同日区间：13:15 还剩 45 分钟');
  ok(msUntilQuietEnd(null, at(3, 0)) === 0, 'range 为 null → 0');
  ok(msUntilQuietEnd(night, at(23, 0)) === 540 * M, '刚进区间那一刻：整整 9 小时');
}

console.log('\n══════ D. 与 pet.js / config.js 的接线 ══════\n');
{
  const PET = fs.readFileSync(path.join(ROOT, 'src/renderer/pet.js'), 'utf8');
  const CFG = fs.readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8');

  ok(/import \{ parseQuietHours, inQuietHours, msUntilQuietEnd \} from '\.\/quiet-hours\.js'/.test(PET),
    'pet.js 把三个函数都引进来了');
  ok(/inQuietHours\(quietRange, new Date\(\)\)/.test(PET) && /return 'quiet_hours'/.test(PET),
    "闸门里有免打扰这一条（返回 'quiet_hours' 供日志辨认）");
  ok(/if \(why === 'quiet_hours'\) \{ scheduleAfterQuietHours\(\); return; \}/.test(PET),
    '🔴 撞上免打扰**不是** 2 秒重试 —— 走排到时段结束那条路（否则空转一整晚）');
  const sched = PET.slice(PET.indexOf('function scheduleAfterQuietHours()'), PET.indexOf('function pokeIdleTimer()'));
  ok(/Math\.min\(Math\.max\(ms, 60 \* 1000\), 12 \* 60 \* 60 \* 1000\)/.test(sched),
    '排的时长两头都夹住了（下限 1 分钟、上限 12 小时 —— 盖住默认 23-8，不整夜空转）');
  ok(/quietRange = parseQuietHours\(cfg\?\.proactive\?\.quietHours\)/.test(PET),
    '区间在配置变更时重算（refreshProactiveConfig）');

  /* 配置默认值：错一个字符就静音一整天，所以这几条要盯着 */
  const seg = CFG.slice(CFG.indexOf('proactive: {'), CFG.indexOf('media: {'));
  ok(/quietHours:\s*'23-8'/.test(seg), "默认免打扰时段是 '23-8'");
  ok(/maxUnanswered:\s*2/.test(seg), '默认未回复上限 2');
}

console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（免打扰时段）');
