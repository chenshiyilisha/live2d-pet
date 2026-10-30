#!/usr/bin/env node
'use strict';
/* CLI：扫描某模型目录的 cdi3 + physics3 → 打印档案骨架摘要。
 *
 * 用法：
 *   node tools/scan-model-profile.js <modelDir>
 *   node tools/scan-model-profile.js --json <modelDir>
 *
 * 例：
 *   node tools/scan-model-profile.js build/stage/src/assets/models/hiyori
 */

const fs = require('fs');
const path = require('path');
const { scanModelProfile } = require('../src/main/model-scan');

function findJson(dir, re) {
  const names = fs.readdirSync(dir);
  const hit = names.find((n) => re.test(n));
  return hit ? path.join(dir, hit) : null;
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const dir = args.find((a) => a !== '--json');
  if (!dir) {
    console.error('用法: node tools/scan-model-profile.js [--json] <modelDir>');
    process.exit(2);
  }
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error('不是目录:', abs);
    process.exit(2);
  }
  const cdiPath = findJson(abs, /\.cdi3\.json$/i);
  const physPath = findJson(abs, /\.physics3\.json$/i);
  if (!cdiPath) {
    console.error('目录里没有 *.cdi3.json:', abs);
    process.exit(2);
  }
  const cdi = JSON.parse(fs.readFileSync(cdiPath, 'utf8'));
  const physics = physPath
    ? JSON.parse(fs.readFileSync(physPath, 'utf8'))
    : null;
  const report = scanModelProfile({ cdi, physics });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`模型目录: ${abs}`);
  console.log(`cdi3: ${path.basename(cdiPath)}  参数 ${report.paramCount}`);
  console.log(`physics3: ${physPath ? path.basename(physPath) : '（无）'}  输出 ${report.physicsOutputs.length}`);
  console.log(`覆盖率: ${report.coverage.hit}/${report.coverage.total} (${(report.coverage.ratio * 100).toFixed(0)}%)`);
  if (report.coverage.missing.length) {
    console.log('  缺通道:', report.coverage.missing.join(', '));
  }
  if (report.skippedPhysics.length) {
    console.log('  因物理输出跳过:');
    for (const s of report.skippedPhysics) console.log(`    ${s.channel} ← ${s.id}`);
  }
  console.log('建议 param:');
  for (const [k, v] of Object.entries(report.suggestedParam)) {
    console.log(`  ${k}: ${v || '（空）'}`);
  }
}

main();
