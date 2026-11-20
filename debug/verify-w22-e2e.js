'use strict';
/* W22 端到端闭环（纯 Node，临时 store，不碰真实记忆）：
 *   store → exportWorkspace → 用户改一个字 → parseWorkspace → upsertFacts → store
 * 断言：① 导出文件齐全 ② 改正文后导入 = 旧值留档 + 新值在（W49 replace 流程）
 *      ③ 原样导入（没改）= 幂等，不新增不更新重复 ④ 归档不复活
 * 这道关卡补 verify-w22.js 的盲区：纯函数对，不代表接上 upsertFacts 也对。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mem = require(path.join(__dirname, '..', 'src', 'main', 'memory.js'));
const ws = require(path.join(__dirname, '..', 'src', 'main', 'memory-workspace.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-w22-e2e-'));
const file = path.join(tmp, 'memory-facts.json');
mem.configureMemory({ getPath: () => file, getSupersede: () => true });
mem._resetCache();

console.log('\n[1] 建库（2 条活档）');
const now = Date.now();
let r = mem.upsertFacts([
  { text: '我叫阿岩', kind: 'name', source: 'user' },
  { text: '喜欢冰美式', kind: 'pref', source: 'user' }
], { now });
ok(r.added === 2, `两条都入库（实测 added=${r.added}）`);
let store = mem.loadStore();
ok(store.facts.length === 2, 'store 里 2 条活档');

console.log('\n[2] 导出');
const files = ws.exportWorkspace(store, now);
ok(Object.keys(files).length === 5, '导出 5 份文件');
ok(/我叫阿岩/.test(files['PARTNER.md']) && /喜欢冰美式/.test(files['partner/pref.md']), '内容分文件正确');

console.log('\n[3] 原样导入（幂等）');
let drafts = ws.parseWorkspace(files);
ok(drafts.length === 2, '解析回 2 条草稿');
r = mem.upsertFacts(drafts, { now: now + 1000 });
ok(r.added === 0, `原样导入不新增（added=${r.added}）`);
store = mem.loadStore();
ok(store.facts.filter((f) => !f.forgotten).length === 2, '原样导入后仍 2 条活档');

console.log('\n[4] 改正文后导入（W49 换值留档）');
/* 模拟用户在 Markdown 里把「冰美式」改成「热美式」——同 id 锚点不变。 */
const edited = files['partner/pref.md'].replace('喜欢冰美式', '喜欢热美式');
ok(/\[/.test(edited) && /喜欢热美式/.test(edited), '改后的 Markdown 仍带 id 锚点');
drafts = ws.parseWorkspace({ 'partner/pref.md': edited });
ok(drafts.length === 1 && drafts[0].text === '喜欢热美式', '解析出改后的正文');
r = mem.upsertFacts(drafts, { now: now + 2000 });
store = mem.loadStore();
const live = store.facts.filter((f) => !f.forgotten && !f.superseded);
ok(live.some((f) => f.text === '喜欢热美式'), '新值在库里');
ok(store.facts.some((f) => f.superseded === true && /冰美式/.test(f.text || '')), '旧值留档不删（W49）');

console.log('\n[5] 归档不复活');
/* 墓碑行 + 被取代行单独成 archive.md，导入必须 0 条。 */
const archiveOnly = ws.exportWorkspace(store, now)['archive.md'];
ok(/archive/.test(archiveOnly) || archiveOnly.length > 0, 'archive.md 有内容（含留档旧值）');
ok(ws.parseWorkspace(archiveOnly).length === 0, 'archive.md 导入 0 条（不复活）');

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（${pass} PASS / ${fail} FAIL）`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不判红 */ }
process.exit(fail === 0 ? 0 : 1);
