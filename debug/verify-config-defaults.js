'use strict';
/* 默认值取舍的验收脚本（2026-10-13，用户："部分设置不需要默认勾选"）。
 *
 * 背景：新装即勾选的只能是不勾就不好用的基础行为 —— 窗口置顶、互动、贴边、
 * 摸头、右键菜单、全屏静默、自动更新。**会主动打扰用户**（出声 / 自己说话 /
 * 弹提醒）或**要常驻占资源**（多一个采样进程）的一律默认不勾选：
 *   tts.enabled · proactive.enabled · motion.wander · reminder.enabled
 *   （monitor.floating / asr / update.autoDownload 本来就没默认开，见 STILL_OFF）
 *
 * 这条规则**从界面上看不出来**（装好了才发现她在自言自语），
 * 而且很容易被后来加功能的人顺手改回去，所以在这里锁死。
 *
 * 两块内容：
 *   A. 真跑一遍 config.js 的 loadConfig（stub 掉 electron，指到临时目录）——
 *      新装、老配置、缺键三种情形下分别读到什么；
 *   B. 行为侧：开关关着时 addReminder() 必须返回 null（这条决定了托盘
 *      「小工具 → 定时提醒」要不要在关闭时收起来，别让它点了没反应）。
 *
 * ⚠️ 计数必须累计（这个项目踩过：只打印不计数 → 全红也退 0）。
 *
 * 用法：node debug/verify-config-defaults.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

/* ══════ 先把 electron 换成桩 ══════
 * config.js 只用到 `app.getPath('userData')`，把它指到一个临时目录，
 * 就能在不启动 Electron 的前提下走完**真实的** loadConfig()/saveConfig()。 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-cfg-'));
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return { app: { getPath: () => tmp, getVersion: () => '0.0.0-test' } };
  }
  return origRequire.apply(this, arguments);
};

const config = require('../src/main/config');
const reminders = require('../src/main/reminder');

const cfgFile = path.join(tmp, 'config.json');
const writeCfg = (obj) => fs.writeFileSync(cfgFile, JSON.stringify(obj, null, 2), 'utf8');
const rmCfg = () => { try { fs.unlinkSync(cfgFile); } catch { /* 不在 */ } };

/* 默认该**关**的（打扰类 / 抢资源类）与默认该**开**的（不勾就不好用）。 */
const OFF_BY_DEFAULT = [
  ['tts', 'enabled', '语音朗读'],
  ['proactive', 'enabled', '主动搭话'],
  ['motion', 'wander', '闲置时自己溜达'],
  ['reminder', 'enabled', '定时提醒']
];
const ON_BY_DEFAULT = [
  ['appearance', 'alwaysOnTop', '窗口置顶'],
  ['motion', 'enabled', '互动总开关'],
  ['motion', 'edgeSnap', '拖动后贴屏幕边缘'],
  ['interaction', 'rightMenu', '在角色身上右键出菜单'],
  ['interaction', 'headPat', '摸头有专属反应'],
  ['quiet', 'enabled', '全屏时自动静默'],
  ['update', 'enabled', '自动检查更新']
];
/* 本来就默认关、这次没动的两项 —— 一起锁住，免得被"顺手打开"。 */
const STILL_OFF = [
  ['monitor', 'floating', '系统状态悬浮显示'],
  ['asr', 'enabled', '语音输入（离线识别）'],
  ['update', 'autoDownload', '发现新版直接下载']
];

console.log('\n══════ 1. 新装（没有配置文件）走默认值 ══════\n');
rmCfg();
{
  const cfg = config.loadConfig();
  for (const [s, k, label] of OFF_BY_DEFAULT) {
    check(cfg[s]?.[k] === false, `默认**不勾选**：${label}（${s}.${k}）`);
  }
  for (const [s, k, label] of ON_BY_DEFAULT) {
    check(cfg[s]?.[k] !== false, `默认仍勾选：${label}（${s}.${k}）`);
  }
  for (const [s, k, label] of STILL_OFF) {
    check(cfg[s]?.[k] === false, `仍默认不勾选：${label}（${s}.${k}）`);
  }
  check(config.DEFAULT_CONFIG.motion.wanderIdleMin === 3,
    '溜达的间隔参数保留（关的是开关，不是参数 —— 用户打开后立刻可用）');
}

console.log('\n══════ 2. 老配置里已经写过的选择不被顶掉 ══════\n');
{
  /* 关键语义：改默认值**只影响没写过这个键的配置**。逐段合并是「默认 ← 配置」，
   * 用户自己点开的开关必须原样保留，否则等于每次升级都重置用户设置。 */
  writeCfg({ tts: { enabled: true }, proactive: { enabled: true }, reminder: { enabled: true },
             motion: { wander: true } });
  const cfg = config.loadConfig();
  check(cfg.tts.enabled === true && cfg.proactive.enabled === true &&
        cfg.reminder.enabled === true && cfg.motion.wander === true,
    '老配置里的 true 保持 true（升级不重置用户选择）');
}

/* 快捷键功能 2026-10-13 整体移除（用户："去掉快捷键"），默认值里已经没有
 * hotkeys 段。老配置里可能留有它 —— 必须**无害**：不报错、不影响别的段。 */
{
  writeCfg({ hotkeys: { enabled: true }, llm: { apiKey: 'keep-me' } });
  const cfg = config.loadConfig();
  check(cfg.llm.apiKey === 'keep-me', '老配置残留的 hotkeys 段不影响其余配置读取');
  check(cfg.appearance.scale === 1, '残留段不影响默认值补齐');
}

console.log('\n══════ 3. 老配置缺键时按新默认值补齐 ══════\n');
{
  writeCfg({ llm: { apiKey: 'keep-me' } });
  const cfg = config.loadConfig();
  check(cfg.llm.apiKey === 'keep-me', '用户数据仍在（llm.apiKey 未被默认值覆盖）');
  check(cfg.tts.enabled === false && cfg.proactive.enabled === false,
    '配置里没写的键落到新默认值（false）');
  check(cfg.appearance.scale === 1, '数值型默认值不受影响（appearance.scale = 1）');
}

console.log('\n══════ 4. 关掉的开关不会"点了没反应" ══════\n');
{
  rmCfg();
  check(reminders.addReminder(5, 'test') === null,
    '定时提醒关着时 addReminder() 返回 null（所以菜单必须收成「启用定时提醒」）');
  writeCfg({ reminder: { enabled: true } });
  check(!!reminders.addReminder(5, 'test'),
    '打开后 addReminder() 正常返回对象');
  reminders.disposeReminders();
}

/* 清理：临时目录 + 撤销 require 劫持 */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
Module.prototype.require = origRequire;

console.log('\n════════════════════════════════════════');
if (failures) {
  console.log('❌ ' + failures + ' 项未通过');
  process.exit(1);
}
console.log('✅ 全部通过');
process.exit(0);
