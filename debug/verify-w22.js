/* W22 记忆 Markdown 工作区的回归（纯函数，零 IO、零 Electron）。
 *
 * 借鉴 Coopanion 的组织形态（AGPL 只借思想不搬代码）：
 *   [A] 导出分主题：PARTNER.md / partner/<kind>.md / archive.md，空类也出文件
 *   [B] 日期具体化：写 YYYY-MM-DD，不写「今天/昨天」；未知日期有兜底
 *   [C] 归档只读：墓碑 / 被取代 / trace 进 archive.md，不进注入文件
 *   [D] 解析往返：export → parse 文本还原（元数据不混进正文）
 *   [E] 幂等 / 合并：同 id 重复只收一次
 *   [F] 负对照：改坏行首标记 / 丢 id → 必须拒绝（证明不是「随便一行都收」）
 *
 * 跑法：node debug/verify-w22.js
 */
const path = require('path');
const M = require(path.join(__dirname, '..', 'src', 'main', 'memory-workspace.js'));

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
function head(s) { console.log('\n' + s); }

/* 固定的「今天」，断言全部围绕它 —— 不依赖真实时钟。 */
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();   // 2026-11-20 本地
const D = (s) => new Date(s + 'T12:00:00').getTime();

const store = {
  version: 2,
  facts: [
    { id: 'id-name', text: '我叫阿岩', kind: 'name', clarity: 'clear', at: D('2026-09-01'), updated: D('2026-09-01') },
    { id: 'id-bound', text: '别在我面前提那个', kind: 'boundary', clarity: 'vivid', at: D('2026-09-02') },
    { id: 'id-pref', text: '喜欢喝冰美式', kind: 'pref', clarity: 'clear', at: D('2026-09-03') },
    { id: 'id-rel', text: '下周二交稿', kind: 'relation', clarity: 'clear', at: D('2026-09-04') },
    { id: 'id-other', text: '养了只猫', kind: 'other', clarity: 'fuzzy', at: D('2026-09-05') },
    { id: 'id-sup', text: '旧的称呼', kind: 'name', clarity: 'clear', at: D('2026-08-01'), superseded: true },
    { id: 'id-trace', text: '好像说过要去爬山', kind: 'other', clarity: 'trace', at: D('2026-08-02') },
    { id: 'id-tomb', forgotten: true, text: '', key: '不吃香菜', at: D('2026-08-03'), forgottenAt: D('2026-10-01') }
  ]
};

(async () => {
  head('[A] 导出分主题');
  const out = M.exportWorkspace(store, NOW);
  const expectFiles = ['PARTNER.md', 'partner/pref.md', 'partner/relation.md', 'partner/other.md', 'archive.md'];
  ok(expectFiles.every((f) => typeof out[f] === 'string'), '五份文件全部产出（含空类）');
  ok(/我叫阿岩/.test(out['PARTNER.md']) && /别在我面前提那个/.test(out['PARTNER.md']),
    'name + boundary 都进 PARTNER.md（常驻画像）');
  ok(/喜欢喝冰美式/.test(out['partner/pref.md']), 'pref 进 partner/pref.md');
  ok(/下周二交稿/.test(out['partner/relation.md']), 'relation 进 partner/relation.md');
  ok(/养了只猫/.test(out['partner/other.md']), 'other 进 partner/other.md');
  ok(!/喜欢喝冰美式/.test(out['PARTNER.md']), '主题不串文件（pref 不在 PARTNER）');

  head('[B] 日期具体化');
  ok(/2026-09-03/.test(out['partner/pref.md']), '写具体日历日 YYYY-MM-DD');
  ok(!/今天|昨天|刚刚/.test(JSON.stringify(out)), '全文不含「今天/昨天/刚刚」');
  ok(M.dayText(0, NOW) === '日期未知', '未知日期有兜底，不吐「今天」');
  ok(M.dayText(D('2026-11-20'), NOW) === '2026-11-20', 'dayText 对齐本地日历日');

  head('[C] 归档只读');
  ok(/旧的称呼/.test(out['archive.md']), '被取代条进 archive');
  ok(/好像说过要去爬山/.test(out['archive.md']), 'trace 淡忘条进 archive');
  ok(/不吃香菜/.test(out['archive.md']) && /已删除/.test(out['archive.md']), '墓碑进 archive（留 key 不复活正文）');
  ok(!/旧的称呼|好像说过要去爬山/.test(JSON.stringify(Object.entries(out).filter(([k]) => k !== 'archive.md').map(([, v]) => v))),
    '不注入的条目不出现在任何注入文件');

  head('[D] 解析往返');
  const drafts = M.parseWorkspace(out);
  ok(drafts.length === 5, `活档 5 条全部解析回来（实测 ${drafts.length}）`);
  ok(drafts.some((d) => d.text === '我叫阿岩' && d.kind === 'name'), '正文还原、类别从元数据读');
  ok(drafts.some((d) => d.text === '别在我面前提那个' && d.kind === 'boundary'),
    'PARTNER.md 里 boundary 导回仍是 boundary（不串成 name）');
  ok(drafts.some((d) => d.text === '喜欢喝冰美式' && d.kind === 'pref'), 'pref 正文干净（元数据没混进去）');
  ok(!drafts.some((d) => /2026-09|清楚|记得不太清/.test(d.text)), '日期/清晰度元数据不进正文');
  ok(!drafts.some((d) => d.text.includes('[') || d.text.includes(']')), 'id 方括号不残留在正文');
  const tombDrafts = M.parseWorkspace(out['archive.md']);
  ok(tombDrafts.length === 0, 'archive.md 解析出 0 条（只读，不复活墓碑/被取代）');

  head('[E] 幂等 / 合并');
  const again = M.parseWorkspace(out);
  ok(JSON.stringify(again) === JSON.stringify(drafts), '同一份文本解析两次逐字节相同（幂等）');
  const dup = { 'partner/pref.md': out['partner/pref.md'] + out['partner/pref.md'] };
  const dupDrafts = M.parseWorkspace(dup);
  ok(dupDrafts.length === 1, `同 id 重复只收一次（实测 ${dupDrafts.length}）`);
  const f = store.facts[0];
  ok(M.factLine(f, NOW) === M.factLine(f, NOW), 'factLine 同输入同输出（纯函数）');

  head('[F] 负对照：坏格式必须拒');
  ok(M.parseLine('我叫阿岩') === null, '无 `- [id]` 行首 → 拒绝');
  ok(M.parseLine('- [] 我叫阿岩') === null, '空 id → 拒绝');
  ok(M.parseLine('- [id] a') === null, '正文 <2 字 → 拒绝');
  ok(M.parseLine('- [id] （已删除 2026-01-01）不吃香菜') === null, '删除行 → 拒绝（不复活）');
  /* 真·负对照：把行首 `- [` 改成 `x [`，parseWorkspace 必须一条都收不到。
   * 证明「收进来」是因为格式对，而不是「随便一行都当记忆」。 */
  const broken = Object.fromEntries(Object.entries(out).map(([k, v]) =>
    [k, v.replace(/^- \[/gm, 'x [')]));
  ok(M.parseWorkspace(broken).length === 0, '把行首标记改坏 → 0 条（负对照生效）');

  console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}（${pass} PASS / ${fail} FAIL）`);
  process.exit(fail === 0 ? 0 : 1);
})();
