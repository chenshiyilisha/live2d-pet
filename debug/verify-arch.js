'use strict';

/* G30：架构边界审查 —— 扫 src/ 的 require/import，守分层。
 * 蓝本味道：Nexus architecture-boundary-audit（只借机制）。
 *
 * 规则：
 *   1) src/main/* 互不 require main.js（循环依赖会静默 undefined）
 *   2) src/renderer/* 不 require('electron') / 不碰 src/main
 *   3) features/（若有）不碰 Electron
 *
 * 跑法：node debug/verify-arch.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(js|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

function reqs(src) {
  const out = [];
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  const im = /from\s+['"]([^'"]+)['"]/g;
  while ((m = im.exec(src))) out.push(m[1]);
  return out;
}

const mainFiles = walk(path.join(ROOT, 'main'));
const rendFiles = walk(path.join(ROOT, 'renderer'));
const featFiles = walk(path.join(ROOT, 'features'));

console.log('\n[A] main 不 require main.js');
{
  let bad = 0;
  for (const f of mainFiles) {
    const base = path.basename(f);
    if (base === 'main.js') continue;
    const hits = reqs(fs.readFileSync(f, 'utf8')).filter((r) =>
      r === './main' || r === './main.js' || /\/main(\.js)?$/.test(r));
    if (hits.length) {
      bad++;
      console.log('  FAIL', path.relative(ROOT, f), hits);
    }
  }
  ok(bad === 0, `main 子模块不 require main.js（${mainFiles.length - 1} 个文件）`);
}

console.log('\n[B] renderer 不碰 Electron / main');
{
  let bad = 0;
  for (const f of rendFiles) {
    const hits = reqs(fs.readFileSync(f, 'utf8')).filter((r) =>
      r === 'electron' || r.startsWith('../main') || r.startsWith('../../main') ||
      r.includes('/main/'));
    if (hits.length) {
      bad++;
      console.log('  FAIL', path.relative(ROOT, f), hits);
    }
  }
  ok(bad === 0, `renderer 无 electron/main require（${rendFiles.length} 个文件）`);
}

console.log('\n[C] features（若有）不碰 Electron');
{
  if (!featFiles.length) {
    console.log('  SKIP 无 features/');
  } else {
    let bad = 0;
    for (const f of featFiles) {
      const hits = reqs(fs.readFileSync(f, 'utf8')).filter((r) => r === 'electron');
      if (hits.length) { bad++; console.log('  FAIL', path.relative(ROOT, f)); }
    }
    ok(bad === 0, `features 无 electron（${featFiles.length}）`);
  }
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);