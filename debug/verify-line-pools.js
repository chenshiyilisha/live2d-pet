'use strict';
/* 状态台词池（P2）+ 人设预设（P1）源码级断言 */

const fs = require('fs');
const path = require('path');
const { WORK_LINES, FAREWELL_LINES, pick, workLine, farewellLine } = require('../src/main/line-pools');
const {
  PERSONA_PRESETS, personaPresetById, renderPersonaPreset, PERSONA_PARTS
} = require('../src/main/config');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

console.log('[A] line-pools');
{
  ok(WORK_LINES.success.length >= 3 && WORK_LINES.error.length >= 3, 'success/error 各至少 3 句');
  ok(typeof workLine('success', () => 0) === 'string' && workLine('success', () => 0).length > 0,
    'workLine 可注入 rand');
  ok(workLine('nope', () => 0) === '', '未知 kind 回空串（不抛）');
  ok(farewellLine(() => 0) === FAREWELL_LINES[0], 'farewellLine 可复现');
  ok(pick([], () => 0, 'x') === 'x', '空池走 fallback');
}

console.log('\n[B] 渲染层久别池与主进程逐字同步');
{
  const pet = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');
  const m = pet.match(/const FAREWELL_LINES = \[([^\]]+)\]/);
  ok(!!m, 'pet.js 有 FAREWELL_LINES');
  const rendered = m
    ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
    : [];
  ok(rendered.length === FAREWELL_LINES.length &&
    rendered.every((s, i) => s === FAREWELL_LINES[i]),
    'pet.js 与 line-pools.FAREWELL_LINES 逐字一致');
  ok(/FAREWELL_AFTER_MS = 4 \* 60 \* 60 \* 1000/.test(pet), '久别阈值 4 小时');
  ok(/workLine\(\s*['"]success['"]/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8')),
    'emitWorkState success 走 workLine');
}

console.log('\n[C] 人设预设 P1');
{
  ok(PERSONA_PRESETS.length >= 6, `至少 6 套预设（实测 ${PERSONA_PRESETS.length}）`);
  ok(PERSONA_PRESETS[0].id === 'default', '第一档是默认');
  const ids = PERSONA_PRESETS.map((p) => p.id);
  ok(new Set(ids).size === ids.length, 'id 不重复');
  const labels = ['傲娇', '元气', '天然呆', '三无', '温柔', '冷静'];
  ok(labels.every((lb) => PERSONA_PRESETS.some((p) => p.label === lb)),
    '六个性格标签齐全');
  const tsun = renderPersonaPreset(personaPresetById('tsundere'), { name: '阿岩' });
  ok(tsun.identity.includes('阿岩') && tsun.style && !tsun.emotion && !tsun.thought,
    '傲娇预设带名字、有 style、不碰 emotion/thought');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  ok(/function applyPersonaPreset\(/.test(main) && /PERSONA_PRESETS\.map/.test(main),
    '托盘/菜单接 applyPersonaPreset');
  ok(PERSONA_PARTS.some((p) => p.key === 'emotion'), 'PERSONA_PARTS 仍含协议槽');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
