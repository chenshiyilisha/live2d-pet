'use strict';
/* 解析 whale 模型包里全部 exp3，看清每个"表情"到底是参数插值还是道具开关。
 *
 * 为什么需要它：VTube Studio 模型包的 expressions/ 目录是**热键表**，
 * 里面混着眼镜、头箍、蛋包饭、鲸鱼这些道具开关 —— 名字叫"表情"，
 * 实际是贴图切换。凭文件名分类一定会错，只有看参数构成才知道真相。
 *
 * 跑法：node debug/analyze-exp3.js            （摘要：每个文件一行）
 *      node debug/analyze-exp3.js --full     （附每个参数的 id/值/Blend）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'assets', 'models', 'whale');
const CORE = path.join(ROOT, 'c_0120.model3.json');

/* 16 字段（连续插值那批）—— 与 profiles/whale.js 的 param 表同源。
 * 这里独立抄一份是为了在**不起 Electron**的前提下判"共享参数"，
 * ⚠️ 改了档案必须同步改这里（analyze 只是分析工具，不参与运行时）。 */
const EMOTION_PARAMS = new Set([
  'ParamMouthOpenY', 'ParamMouthForm',
  'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLX', 'ParamBrowRX',
  'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'Paramhh2',
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ'
]);

function readNames() {
  // cdi3.json：参数 id -> 中文名（Name 字段），唯一能读懂"这参数干什么"的来源
  const p = path.join(ROOT, 'c_0120.cdi3.json');
  if (!fs.existsSync(p)) return new Map();
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const m = new Map();
  for (const x of d.Parameters || []) m.set(x.Id, x.Name || '');
  return m;
}

function main() {
  const full = process.argv.includes('--full');
  const names = readNames();
  const dir = path.join(ROOT, 'expressions');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.exp3.json')).sort();

  let shared = 0;
  const rows = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const ps = j.Parameters || [];
    const sharedIds = ps.filter((x) => EMOTION_PARAMS.has(x.Id)).map((x) => x.Id);
    if (sharedIds.length) shared++;
    rows.push({ f, ps, sharedIds });
  }

  console.log(`模型包：${ROOT}`);
  console.log(`exp3 共 ${files.length} 个；其中 ${shared} 个动了「16 字段」里的参数（不能当纯贴纸）\n`);
  console.log('文件'.padEnd(26), '参数', ' 共享', ' 值分布');
  console.log('─'.repeat(78));
  for (const { f, ps, sharedIds } of rows) {
    const vals = [...new Set(ps.map((x) => x.Value))].sort((a, b) => a - b);
    const blends = [...new Set(ps.map((x) => x.Blend || 'Add'))].join('/');
    const vs = vals.length > 4 ? `${vals.slice(0, 4).join(',')}…` : vals.join(',');
    console.log(
      f.replace('.exp3.json', '').padEnd(26),
      String(ps.length).padStart(3),
      String(sharedIds.length).padStart(4),
      ` ${vs} · ${blends}`
    );
    if (full || sharedIds.length) {
      for (const x of ps) {
        const tag = EMOTION_PARAMS.has(x.Id) ? '★共享' : '  专属';
        console.log(`      ${tag} ${x.Id.padEnd(20)} = ${String(x.Value).padEnd(6)} ${(x.Blend || 'Add').padEnd(6)} ${names.get(x.Id) || ''}`);
      }
    }
  }

  /* 汇总：专属参数全集（= 贴纸可用的参数面）。
   * 🔴 只要某参数在任何一个 exp3 里与 16 字段重叠，就不能进 stickers 的
   *    绝对写面板（会和撤销法打架），所以这份名单要按"是否出现过共享"筛。 */
  const allOwn = new Map();
  for (const { ps, sharedIds } of rows) {
    const bad = new Set(sharedIds);
    for (const x of ps) {
      if (bad.has(x.Id)) continue;
      allOwn.set(x.Id, (allOwn.get(x.Id) || 0) + 1);
    }
  }
  console.log(`\n只出现在专属位的参数：${allOwn.size} 个`);
  console.log('─'.repeat(78));
  for (const [id, n] of [...allOwn].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${id.padEnd(20)} 出现 ${String(n).padStart(2)} 次  ${names.get(id) || ''}`);
  }
}

main();
