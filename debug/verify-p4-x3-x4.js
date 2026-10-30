'use strict';
const fs = require('fs');
const path = require('path');
const {
  SIGNATURE_LINES, SIGNATURE_EMO, workLine, signatureEmo
} = require('../src/main/line-pools');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('[A] P4 招牌池');
{
  const ids = Object.keys(SIGNATURE_LINES);
  ok(ids.length >= 6, `至少 6 套人格招牌（${ids.length}）`);
  ok(ids.every((id) => {
    const s = SIGNATURE_LINES[id];
    return s.idle?.length && s.working?.length && s.success?.length && s.error?.length;
  }), '每套都有 idle/working/success/error');
  ok(workLine('success', () => 0, 'kuudere') === SIGNATURE_LINES.kuudere.success[0],
    'workLine 走招牌池');
  ok(workLine('success', () => 0, 'default') === '搞定啦 ✓' ||
    workLine('success', () => 0) === '搞定啦 ✓',
    'default / 空 id 回落通用池');
  ok(signatureEmo('tsundere', 'success') === 'shy', '傲娇成功 → shy');
  ok(signatureEmo('nope', 'success') === '', '未知人格无表情偏置');
}

console.log('\n[B] P4 接线');
{
  const main = read('src/main/main.js');
  ok(/personaId: preset\.id/.test(main), '套预设写 personaId');
  ok(/signatureEmo\(personaId/.test(main), 'emitWorkState 带招牌表情');
  ok(/workLine\('success',\s*Math\.random,\s*personaId\)/.test(main),
    'success 短句按人格');
  const cfg = read('src/main/config.js');
  ok(/personaId:\s*'default'/.test(cfg), 'DEFAULT personaId');
}

console.log('\n[C] X3 吃文件');
{
  const pet = read('src/renderer/pet.js');
  ok(/eatDroppedFiles|EAT_EXT/.test(pet), '渲染层有拖放入口');
  ok(/eatFile/.test(read('src/main/preload.js')), 'preload 暴露 eatFile');
  ok(/memory:eat-file/.test(read('src/main/main.js')), '主进程有 eat-file');
  ok(/吃掉了/.test(read('src/main/main.js')), '吃成功有 toast');
}

console.log('\n[D] X4 单摆/翻转');
{
  const cfg = read('src/main/config.js');
  ok(/swing:\s*false/.test(cfg) && /flip:\s*false/.test(cfg), 'swing/flip 默认关');
  const main = read('src/main/main.js');
  ok(/拖着走会单摆摇晃/.test(main) && /往左飞时左右翻转/.test(main), '托盘两项');
  const motion = read('src/main/motion.js');
  ok(/onDragTilt/.test(motion) && /onFacing/.test(motion), 'motion 推 tilt/facing');
  const pet = read('src/renderer/pet.js');
  ok(/pet:tilt/.test(pet) && /pet:facing/.test(pet) && /facingDir/.test(pet),
    '渲染层接 tilt/facing');
  ok(/pet:tilt/.test(read('src/main/preload.js')), 'preload 白名单含 tilt');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
