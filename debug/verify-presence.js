'use strict';
/* X2 专注/勿扰三档 + G2 前台名清洗 */

const fs = require('fs');
const path = require('path');
const {
  MODES, normalizeMode, presenceBlocksProactive, ignoreQuietHours, presenceIdleMul
} = require('../src/main/presence');
const { sanitizeFgName } = require('../src/main/fullscreen');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('[A] presence 三档');
{
  ok(MODES.map((m) => m.id).join(',') === 'companion,normal,focus', '三档顺序');
  ok(normalizeMode('') === 'normal' && normalizeMode('nope') === 'normal', '未知回落日常');
  ok(presenceBlocksProactive('focus') === 'focus', '勿扰拦主动');
  ok(presenceBlocksProactive('normal') === '' && presenceBlocksProactive('companion') === '',
    '日常/陪伴本档不拦');
  ok(ignoreQuietHours('companion') === true && ignoreQuietHours('normal') === false,
    '仅陪伴忽略 quietHours');
  ok(presenceIdleMul('companion') < 1 && presenceIdleMul('normal') === 1, '陪伴 idle 更短');
}

console.log('\n[B] 前台名清洗（G2）');
{
  ok(sanitizeFgName('Code') === 'Code', '正常进程名');
  ok(sanitizeFgName('explorer') === '' && sanitizeFgName('Explorer') === '', 'explorer 丢掉');
  ok(sanitizeFgName('evil";drop') === 'evildrop', '危险字符剥掉');
  ok(sanitizeFgName('').length === 0, '空串');
  ok(sanitizeFgName('a'.repeat(50)).length <= 24, '长度封顶');
}

console.log('\n[C] 接线');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/require\('\.\/presence'\)/.test(main), 'main 引入 presence');
  ok(/状态（/.test(main) || /presenceItem/.test(main), '托盘有状态三档');
  ok(/foregroundHint|getForeground/.test(main), '主动搭话接前台 hint');
  ok(/chatAbort/.test(main), 'G3 chatAbort 掐旧流');
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');
  ok(/presence\?\.mode === 'focus'/.test(pet), '渲染层认勿扰');
  ok(/companion/.test(pet) && /quiet_hours/.test(pet), '陪伴忽略安静时段');
  ok(/streaming && \(!last \|\| last\.role !== 'assistant'\)/.test(pet),
    'G3 流式中断落半截历史');
  ok(/decayAmt <= 0 && emotion !== 'calm'/.test(pet), 'G4 衰减到底回 calm 标签');
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.js'), 'utf8');
  ok(/presence:\s*\{[\s\S]*mode:\s*'normal'/.test(cfg), 'DEFAULT presence.mode=normal');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
