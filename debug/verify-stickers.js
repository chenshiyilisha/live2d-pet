'use strict';

/* ============================================================
 *  情绪贴纸（exp3 叠加）防回流断言（源码级 + 素材级，不起 Electron）
 * ==========================================================
 *
 *  背景（2026-10-29）：whale 模型包自带 44 个 exp3 但 model3.json 没注册
 *  （VTS 通病）→ 自己 fetch 解析，把"贴纸类专属参数"叠到情绪档上。
 *  链路：profiles/whale.js stickers 映射 → params.js STICKERS →
 *        pet.js loadStickers（过滤共享参数）→ applyStickers（每帧绝对写）。
 *
 *  跑法：node debug/verify-stickers.js
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('[A] 档案映射与素材文件一一对应');
{
  const whaleSrc = read('renderer/profiles/whale.js');
  // 从源码里抠 stickers 段（避免在 node 里 import 带浏览器依赖的模块链）
  const m = whaleSrc.match(/stickers:\s*\{([\s\S]*?)\n\s*\}/);
  ok(!!m, 'whale.js 有 stickers 段');
  if (m) {
    const pairs = [...m[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)];
    ok(pairs.length >= 6, `映射至少 6 档（实测 ${pairs.length}）`);
    ok(!pairs.some(([, emo]) => emo === 'calm'), 'calm 不配贴纸（平静就该是素脸）');
    ok(pairs.every(([, emo]) => ['happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'].includes(emo)),
      '每个键都是 8 情绪档之一');
    // 素材文件必须真实存在 + exp3 引用的参数必须真的在模型里
    const cdi = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'assets/models/whale/c_0120.cdi3.json'), 'utf8'));
    const ids = new Set(cdi.Parameters.map((p) => p.Id));
    const dir = path.join(ROOT, 'assets/models/whale/expressions');
    for (const [, emo, file] of pairs) {
      const f = path.join(dir, `${file}.exp3.json`);
      ok(fs.existsSync(f), `expressions/${file}.exp3.json 存在（${emo}）`);
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        const ps = j.Parameters ?? [];
        ok(ps.length > 0, `${file} 至少 1 个参数`);
        // 共享参数过滤的正确性由运行时 owned 集合保证，这里只守"专属参数真实存在"
        const whaleParams = whaleSrc.match(/param:\s*\{([\s\S]*?)\n\s*\}/)[1];
        const owned = new Set([...whaleParams.matchAll(/'(\w+)'/g)].map((x) => x[1]));
        const shared = ps.filter((p) => owned.has(p.Id)).map((p) => p.Id);
        ok(shared.length < ps.length,
          `${file} 不是全部参数都与 16 字段共享（全共享 = 贴上去什么都没有）`);
        for (const p of ps) {
          ok(ids.has(p.Id), `${file} 的 ${p.Id} 在模型参数表里`);
        }
      }
    }
  }
}

console.log('[B] 渲染层链路（源码级）');
{
  ok(/export const STICKERS =/.test(read('renderer/params.js')), 'params.js 导出 STICKERS');
  const pet = stripComments(read('renderer/pet.js'));
  ok(/function loadStickers\(/.test(pet), 'loadStickers 存在');
  ok(/function applyStickers\(/.test(pet), 'applyStickers 存在');
  ok(/loadStickers\(name\)/.test(pet),
    '调用点用 mountModel 的 name 参数（⚠️ 别挪去 boot：那里裸写 name 是 window.name=""，曾静默失效）');
  ok(/owned\.has\(p\.Id\)/.test(pet), '共享参数按档案 param 表过滤（owned 集合）');
  // 绝对写：def + value×amt；归零必须还默认值（贴纸参数没人接管，漏写 = 残影）
  ok(/p\.def \+ p\.value \* amt/.test(pet), '贴纸是绝对写 def + value×强度（不是 Add 累加）');
  ok(/setParam\(p\.id, p\.def\)/.test(pet), '强度归零时把参数写回默认值（防残影）');
  ok(/appearance\?\.stickers !== false/.test(pet), '开关读 appearance.stickers（默认开）');
  ok(/8000/.test(pet), 'fetch 带 8s 超时（中文文件名可能让 dev server 挂起不响应）');
}

console.log('[C] 配置与托盘');
{
  const cfg = read('main/config.js');
  ok(/stickers: true/.test(cfg), 'DEFAULT_CONFIG appearance.stickers 默认开');
  const main = read('main/main.js');
  ok(/flag\('appearance', 'stickers'/.test(main), '托盘外观子菜单有勾选项（规矩 4）');
}

process.exit(fails ? 1 : 0);
