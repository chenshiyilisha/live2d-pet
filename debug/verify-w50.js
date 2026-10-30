/**
 * W50 回归：心境→temperature 映射（mood.js 纯函数）
 *
 * 覆盖：
 *   [A] moodTemperature 纯函数：高情绪→0.9、低情绪→0.7、低活力→0.7、中段→0.8
 *   [B] NaN/缺字段 → 0.8（默认，不误伤）
 *   [C] 边界：刚好在阈值上（VAL_HAPPY/VAL_SERIOUS/ENERGY_LOW）
 *   [D] config.js 默认值：moodTemperature=true
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const mood = require(path.join(__dirname, '..', 'src', 'main', 'mood.js'));
const { moodTemperature, VAL_HAPPY, VAL_SERIOUS, ENERGY_LOW } = mood;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; failures.push(name + ' :: ' + String(err && err.message || err)); }
}

console.log('== W50 心境→temperature ==');

/* ---------- [A] 基本映射 ---------- */
console.log('[A] moodTemperature 基本映射');
check('A1 高情绪(valence=0.9) → 0.9', () => {
  assert.strictEqual(moodTemperature({ valence: 0.9, energy: 0.8 }), 0.9);
});
check('A2 低情绪(valence=0.1) → 0.7', () => {
  assert.strictEqual(moodTemperature({ valence: 0.1, energy: 0.8 }), 0.7);
});
check('A3 低活力(energy=0.1) → 0.7', () => {
  assert.strictEqual(moodTemperature({ valence: 0.5, energy: 0.1 }), 0.7);
});
check('A4 中段 → 0.8', () => {
  assert.strictEqual(moodTemperature({ valence: 0.5, energy: 0.6 }), 0.8);
});
check('A5 高情绪优先于低活力', () => {
  assert.strictEqual(moodTemperature({ valence: 0.9, energy: 0.1 }), 0.9);
});
check('A6 低情绪优先于低活力', () => {
  assert.strictEqual(moodTemperature({ valence: 0.1, energy: 0.1 }), 0.7);
});

/* ---------- [B] NaN/缺字段 → 默认 ---------- */
console.log('[B] 异常输入 → 默认 0.8');
check('B1 undefined axes → 0.8', () => {
  assert.strictEqual(moodTemperature(undefined), 0.8);
});
check('B2 null axes → 0.8', () => {
  assert.strictEqual(moodTemperature(null), 0.8);
});
check('B3 valence=NaN → 0.8', () => {
  assert.strictEqual(moodTemperature({ valence: NaN, energy: 0.5 }), 0.8);
});
check('B4 energy=NaN → 0.8', () => {
  assert.strictEqual(moodTemperature({ valence: 0.5, energy: NaN }), 0.8);
});
check('B5 空对象 → 0.8', () => {
  assert.strictEqual(moodTemperature({}), 0.8);
});

/* ---------- [C] 边界值 ---------- */
console.log('[C] 边界值（刚好在阈值上）');
check('C1 valence 刚好=VAL_HAPPY → 0.9', () => {
  assert.strictEqual(moodTemperature({ valence: VAL_HAPPY, energy: 0.8 }), 0.9);
});
check('C2 valence 刚好=VAL_SERIOUS → 0.7', () => {
  assert.strictEqual(moodTemperature({ valence: VAL_SERIOUS, energy: 0.8 }), 0.7);
});
check('C3 energy 刚好=ENERGY_LOW → 0.7', () => {
  assert.strictEqual(moodTemperature({ valence: 0.5, energy: ENERGY_LOW }), 0.7);
});
check('C4 valence 略高于 VAL_HAPPY → 0.9', () => {
  assert.strictEqual(moodTemperature({ valence: VAL_HAPPY + 0.001, energy: 0.8 }), 0.9);
});
check('C5 valence 略低于 VAL_SERIOUS → 0.7', () => {
  assert.strictEqual(moodTemperature({ valence: VAL_SERIOUS - 0.001, energy: 0.8 }), 0.7);
});

/* ---------- [D] config.js 默认值 ---------- */
console.log('[D] config.js 默认值');
{
  const cfgPath = path.join(__dirname, '..', 'src', 'main', 'config.js');
  const src = fs.readFileSync(cfgPath, 'utf8');
  check('D1 config.js 有 moodTemperature 开关', () => {
    assert.ok(src.includes('moodTemperature'), 'config.js 缺 moodTemperature');
  });
  check('D2 moodTemperature 默认 true', () => {
    assert.ok(/moodTemperature\s*:\s*true/.test(src), 'moodTemperature 默认应为 true');
  });
}

/* ---------- 清理 ---------- */
console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ 有失败'));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  console.log('失败清单：');
  for (const f of failures) console.log('  -', f);
}
process.exit(fail === 0 ? 0 : 1);
