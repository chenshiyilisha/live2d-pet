'use strict';
/* G5：cdi3 + physics3 → 档案骨架。用法：node debug/verify-model-scan.js */

const fs = require('fs');
const path = require('path');
const {
  scanModelProfile, physicsOutputIds, CHANNEL_CANDIDATES
} = require('../src/main/model-scan');

let fails = 0;
const ok = (c, m) => {
  if (c) console.log('  PASS', m);
  else { console.log('  FAIL', m); fails++; }
};

const ROOT = path.join(__dirname, '..');
const HIYORI = path.join(ROOT, 'build', 'stage', 'src', 'assets', 'models', 'hiyori');

console.log('\n[A] 纯函数边界');
ok(physicsOutputIds(null).size === 0, 'physics 空 → 空集');
ok(scanModelProfile({}).paramCount === 0, '无 cdi → 0 参数');
ok(Object.keys(CHANNEL_CANDIDATES).length >= 16, '通道表至少 16');

console.log('\n[B] hiyori 真模型（build/stage）');
const cdiPath = path.join(HIYORI, 'Hiyori.cdi3.json');
const physPath = path.join(HIYORI, 'Hiyori.physics3.json');
if (!fs.existsSync(cdiPath) || !fs.existsSync(physPath)) {
  console.log('  SKIP 缺 hiyori 素材（build/stage）');
} else {
  const cdi = JSON.parse(fs.readFileSync(cdiPath, 'utf8'));
  const physics = JSON.parse(fs.readFileSync(physPath, 'utf8'));
  const r = scanModelProfile({ cdi, physics });
  ok(r.paramCount >= 60, `参数数 ≥60（实测 ${r.paramCount}）`);
  ok(r.physicsOutputs.length > 0, `物理输出非空（${r.physicsOutputs.length}）`);
  ok(r.suggestedParam.MOUTH_OPEN === 'ParamMouthOpenY', '猜到 MOUTH_OPEN');
  ok(r.suggestedParam.EYE_L === 'ParamEyeLOpen', '猜到 EYE_L');
  ok(r.coverage.hit >= 14, `覆盖率 hit≥14（${r.coverage.hit}/${r.coverage.total}）`);
  ok(r.conflicts.length === 0, '建议 param 与物理输出无冲突');
  /* BODY_Y/Z 在 hiyori 是物理输入也常是输出 —— 若被标为输出应跳过留空 */
  if (r.physicsOutputs.includes('ParamBodyAngleY')) {
    ok(!r.suggestedParam.BODY_Y, 'BODY_Y 是物理输出时建议为空');
  }
  ok(r.skeleton.param.MOUTH_OPEN === 'ParamMouthOpenY', 'skeleton.param 带建议值');
  ok(r.skeleton.model.petScale === null, '几何标定故意留空（不编造）');
}

console.log('\n[C] 负对照');
const fake = scanModelProfile({
  cdi: { Parameters: [{ Id: 'ParamMouthOpenY', Name: '嘴' }] },
  physics: {
    PhysicsSettings: [{
      Output: [{ Destination: { Id: 'ParamMouthOpenY' } }]
    }]
  }
});
ok(!fake.suggestedParam.MOUTH_OPEN, '负对照：嘴是物理输出 → 建议为空');
ok(fake.skippedPhysics.some((s) => s.channel === 'MOUTH_OPEN'),
  '负对照：记入 skippedPhysics');

console.log('\n[D] CLI / 接线');
const tool = fs.readFileSync(path.join(ROOT, 'tools', 'scan-model-profile.js'), 'utf8');
ok(/scanModelProfile/.test(tool), 'tools/scan-model-profile.js 调用扫描');
ok(fs.existsSync(path.join(ROOT, 'src', 'main', 'model-scan.js')), 'model-scan.js 存在');

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
