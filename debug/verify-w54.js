'use strict';
/* W54：配置改动来路记录——config-changes.jsonl 台账验收。
 *
 * 规矩 28：正对照（记录/不记录/裁剪）+ 负对照（台账失败不影响落盘、
 * diffKeys 对数组/整段替换的行为）。
 *
 * 用法：node debug/verify-w54.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

/* ---- electron 桩：config.js / config-ledger.js 都只要 app.getPath ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w54-'));
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') return { app: { getPath: () => tmp, getVersion: () => '0.0.0-test' } };
  return origRequire.apply(this, arguments);
};

const config = require(path.join(__dirname, '..', 'src', 'main', 'config'));
const ledger = require(path.join(__dirname, '..', 'src', 'main', 'config-ledger'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); fail++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + ' 实际 ' + a); pass++; }
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); pass++; }
function section(t) { console.log('\n[' + t + ']'); }

const base = JSON.parse(JSON.stringify(config.DEFAULT_CONFIG));
ledger.resetLedger();

section('A. 落盘记台账');
let r1 = config.saveConfig({ ...base }, 'first-boot');
eq(r1, true, '首次落盘应成功');
let lines = ledger.readLedger();
eq(lines.length, 1, '首次落盘应记 1 行');
eq(lines[0].reason, 'first-boot', 'reason 透传');
eq(lines[0].changed.length, Object.keys(base).length, '首次应记录全部键（from undefined）');
ok(lines[0].ts, '有时间戳');
ok(lines[0].session && lines[0].session.startsWith('sess-'), '有会话 id');

section('B. 值没变不记');
ledger.resetLedger();
config.saveConfig({ ...base }, 'seed-B');
eq(ledger.readLedger().length, 1, 'seed 记 1 行');
config.saveConfig({ ...base }, 'same-again');
eq(ledger.readLedger().length, 1, '完全相同 → 不记');
config.saveConfig({ ...base, chat: { ...base.chat } }, 'same-again-2');
eq(ledger.readLedger().length, 1, '逐段复制同值 → 不记');

section('C. 只记变化的键');
ledger.resetLedger();
config.saveConfig({ ...base }, 'seed');
config.saveConfig({ ...base, chat: { ...base.chat, mode: 'work' } }, 'tray:mode');
const e2 = ledger.readLedger();
eq(e2.length, 2, 'seed 1 行 + 变化 1 行');
eq(e2[1].reason, 'tray:mode', '最后一行是变化那次');
eq(e2[1].changed.length, 1, '只记 1 个键');
eq(e2[1].changed[0].path, 'chat.mode', '键路径正确');
eq(e2[1].changed[0].from, 'companion', '旧值');
eq(e2[1].changed[0].to, 'work', '新值');

section('D. 开关关了不记');
ledger.resetLedger();
config.saveConfig({ ...base }, 'seed-off');
config.saveConfig({ ...base, ledgerEnabled: false, chat: { ...base.chat, mode: 'work' } }, 'user-disable');
eq(ledger.readLedger().length, 1, '关掉开关 → 不再追加');
/* 关开关本身这一行照记（关的时候是开启状态）。再开回来又能记。 */
config.saveConfig({ ...base, ledgerEnabled: true, chat: { ...base.chat, mode: 'companion' } }, 'user-reenable');
eq(ledger.readLedger().length, 2, '重新打开 → 继续记');

section('E. 裁剪');
ledger.resetLedger();
config.saveConfig({ ...base }, 'seed-trim');
for (let i = 0; i < ledger.MAX_ENTRIES + 10; i++) {
  config.saveConfig({ ...base, chat: { ...base.chat, composerIdleSec: 60 + i } }, 'bulk');
}
const all = ledger.readLedger();
eq(all.length, ledger.MAX_ENTRIES, '裁剪到上限');
eq(all[all.length - 1].changed[0].to, 60 + (ledger.MAX_ENTRIES + 9), '保留的是最新的');

section('F. 负对照 0：对象递归、数组当叶子');
ledger.resetLedger();
config.saveConfig({ ...base }, 'seed-arr');
config.saveConfig({ ...base, llm: { ...base.llm, profiles: { p1: 1 } } }, 'obj-replace');
const arr = ledger.readLedger();
eq(arr.length, 2, 'seed 1 行 + 替换 1 行');
eq(arr[1].changed[0].path, 'llm.profiles.p1', '普通对象递归到叶子键');
eq(arr[1].changed[0].from, undefined, 'from 为 undefined（新增）');
/* 数组：内容整体替换记为叶子（空数组相等不算变）。 */
config.saveConfig({ ...base, mcp: { ...base.mcp, servers: ['a'] } }, 'arr-replace');
config.saveConfig({ ...base, mcp: { ...base.mcp, servers: ['a', 'b'] } }, 'arr-grow');
const arr2 = ledger.readLedger();
eq(arr2[arr2.length - 1].changed[0].path, 'mcp.servers', '数组整体替换 = 叶子键');
eq(JSON.stringify(arr2[arr2.length - 1].changed[0].from), '["a"]', '旧值');
eq(JSON.stringify(arr2[arr2.length - 1].changed[0].to), '["a","b"]', '新值');

section('G. 负对照：台账写失败不影响 saveConfig 返回值');
/* 先清掉前面几节写进真台账的文件，才能断言"没写成功"。 */
try { fs.unlinkSync(ledger.ledgerPath()); } catch { /* 不在 */ }
/* 把台账路径指到不存在目录的深处（写不进去），saveConfig 必须仍成功。
 * ⚠️ 不能直接覆盖 ledger.ledgerPath —— 那是导出对象上的属性，
 *   模块内部调用走局部绑定，覆盖不生效（本轮实测踩过）。用 setLedgerPathForTest。 */
const realLedgerPath = ledger.ledgerPath;
ledger.setLedgerPathForTest(path.join(tmp, 'no-such-dir', 'sub', 'ledger.jsonl'));
ledger.resetLedger();
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ ...base }, null, 2));
let res = config.saveConfig({ ...base, chat: { ...base.chat, mode: 'work' } }, 'fail-ledger');
ledger.setLedgerPathForTest(null);
ok(res === true, '台账写失败时 saveConfig 仍返回 true');
eq(ledger.readLedger().length, 0, '台账确实没写成功（失败被吞掉）');

section('G2. 脏输入不抛');
ledger.resetLedger();
let threw = false;
try { ledger.recordChange(null, 'x'); } catch { threw = true; }
eq(threw, false, 'cfg=null 不抛');
try { ledger.recordChange({ ledgerEnabled: false }, 'off'); } catch { threw = true; }
eq(threw, false, '只有开关的 cfg 不抛');
/* 坏快照（直接塞坏 JSON 再走 recordChange）→ 解析失败当空对象，不抛。 */
const realParse = JSON.parse;
JSON.parse = () => { throw new SyntaxError('x'); };
try {
  ledger.recordChange({ chat: { mode: 'work' } }, 'bad-snap');
} catch { threw = true; }
JSON.parse = realParse;
eq(threw, false, '坏快照解析失败兜底不抛');

section('H. 与默认值取舍（verify-config-defaults）不冲突');
eq(config.DEFAULT_CONFIG.ledgerEnabled, true, '默认开（零打扰纯记录）');

console.log('\nW54: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
