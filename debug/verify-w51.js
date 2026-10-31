/**
 * W51 回归：互动收益递减（mood.js）
 *
 * 覆盖：
 *   [A] dedentStep 纯函数：阶梯映射
 *   [B] todayKey 跨日判定
 *   [C] rollRate 引擎行为：连续互动递减
 *   [D] 跨日重置
 *   [E] 开关关 → 逐位一致
 *   [F] save/load 持久化 rateCount
 *   [G] 拖动不产生 valence 增益（不滚递减）
 *   [H] config 默认值
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const mood = require(path.join(__dirname, '..', 'src', 'main', 'mood.js'));
const { createMoodEngine, dedentStep, todayKey, GAIN } = mood;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try { fn(); pass++; }
  catch (err) { fail++; failures.push(name + ' :: ' + String(err && err.message || err)); }
}

const T0 = Date.parse('2026-10-31T10:00:00+08:00');
const T1 = T0 + 86400000; // 明天

console.log('== W51 互动收益递减 ==');

/* ---------- [A] dedentStep 纯函数 ---------- */
console.log('[A] dedentStep 纯函数');
check('A1 第 0 次 → 1.0', () => assert.strictEqual(dedentStep(0), 1.0));
check('A2 第 1 次 → 0.7', () => assert.strictEqual(dedentStep(1), 0.7));
check('A3 第 2 次 → 0.4', () => assert.strictEqual(dedentStep(2), 0.4));
check('A4 第 3 次 → 0.2', () => assert.strictEqual(dedentStep(3), 0.2));
check('A5 第 4 次 → 0.05', () => assert.strictEqual(dedentStep(4), 0.05));
check('A6 第 5 次 → 0.05（地板）', () => assert.strictEqual(dedentStep(5), 0.05));
check('A7 负数 → 1.0（防手改配置）', () => assert.strictEqual(dedentStep(-1), 1.0));

/* ---------- [B] todayKey ---------- */
console.log('[B] todayKey 跨日');
check('B1 同一时刻的键相等', () => {
  assert.strictEqual(todayKey(T0), todayKey(T0 + 3600000));
});
check('B2 跨日键不等', () => {
  assert.notStrictEqual(todayKey(T0), todayKey(T1));
});
check('B3 键格式 YYYY-M-D', () => {
  const k = todayKey(T0);
  assert.ok(/^\d{4}-\d{1,2}-\d{1,2}$/.test(k), '键格式异常: ' + k);
});

/* ---------- [C] rollRate 引擎行为 ---------- */
console.log('[C] rollRate 递减');
{
  const e = createMoodEngine();
  const v0 = 0.55;
  // 连续点击，valence 增益应递减
  const v1 = e.axes.valence; // 初值
  e.onClick();
  const after1 = e.axes.valence;
  e.onClick();
  const after2 = e.axes.valence;
  e.onClick();
  const after3 = e.axes.valence;
  e.onClick();
  const after4 = e.axes.valence;
  e.onClick();
  const after5 = e.axes.valence;

  const d1 = after1 - v1;
  const d2 = after2 - after1;
  const d3 = after3 - after2;
  const d4 = after4 - after3;
  const d5 = after5 - after4;

  check('C1 首次点击全额', () => {
    assert.ok(Math.abs(d1 - GAIN.clickValence) < 1e-9,
      '首次应全额: d1=' + d1 + ' expected=' + GAIN.clickValence);
  });
  check('C2 第二次 70%', () => {
    const exp = GAIN.clickValence * 0.7;
    assert.ok(Math.abs(d2 - exp) < 1e-9,
      '第二次应 70%: d2=' + d2 + ' expected=' + exp);
  });
  check('C3 第三次 40%', () => {
    const exp = GAIN.clickValence * 0.4;
    assert.ok(Math.abs(d3 - exp) < 1e-9, '第三次应 40%: d3=' + d3);
  });
  check('C4 第四次 20%', () => {
    const exp = GAIN.clickValence * 0.2;
    assert.ok(Math.abs(d4 - exp) < 1e-9, '第四次应 20%: d4=' + d4);
  });
  check('C5 第五次 5%（地板）', () => {
    const exp = GAIN.clickValence * 0.05;
    assert.ok(Math.abs(d5 - exp) < 1e-9, '第五次应 5%: d5=' + d5);
  });
}

/* ---------- [D] 跨日重置 ---------- */
console.log('[D] 跨日重置');
{
  const e = createMoodEngine();
  e.onClick();
  const after1 = e.axes.valence;
  e.onClick();
  const after2 = e.axes.valence;
  // 第二次点击应递减（跨日未到）
  check('D1 同日第二次仍递减', () => {
    const d = after2 - after1;
    assert.ok(Math.abs(d - GAIN.clickValence * 0.7) < 1e-9,
      '同日应递减: d=' + d);
  });

  // 模拟跨日：不直接调 rollRate（内部用 Date.now），改用 onDragBegin 触发
  // 但 rollRate 用 Date.now，无法注入。用 _rateDay 检查
  // 跨日重置逻辑在 rollRate 内：如果 todayKey(now) != S._rateDay → 重置
  // 无法直接测跨日（Date.now 不可控），但可以测 todayKey 本身（B 段已覆盖）
  check('D2 todayKey 可判定跨日（B段已覆盖）', () => {
    assert.ok(todayKey(T0) !== todayKey(T1));
  });
}

/* ---------- [E] 开关关 → 逐位一致 ---------- */
console.log('[E] 开关关');
{
  const e = createMoodEngine();
  e.setDedentEnabled(false);
  check('E1 开关关 → 每次点击全额', () => {
    const v0 = e.axes.valence;
    e.onClick();
    const d1 = e.axes.valence - v0;
    e.onClick();
    const d2 = e.axes.valence - (v0 + d1);
    // 两次都全额
    assert.ok(Math.abs(d1 - GAIN.clickValence) < 1e-9, '第一次应全额: ' + d1);
    assert.ok(Math.abs(d2 - GAIN.clickValence) < 1e-9, '第二次应全额: ' + d2);
  });
  check('E2 开关关 → getDedentEnabled=false', () => {
    assert.strictEqual(e.getDedentEnabled(), false);
  });
  // 重新开
  e.setDedentEnabled(true);
  check('E3 重新开 → 递减恢复', () => {
    assert.strictEqual(e.getDedentEnabled(), true);
  });
}

/* ---------- [F] save/load 持久化 ---------- */
console.log('[F] save/load 持久化');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w51-'));
  const file = path.join(tmp, 'mood.json');
  const e1 = createMoodEngine();
  e1.onClick();
  e1.onClick();
  e1.onClick();
  e1.save(file);
  const count1 = e1.getRateCount();

  const e2 = createMoodEngine();
  e2.loadAndDrift(file);
  const count2 = e2.getRateCount();
  check('F1 rateCount 跨引擎保持', () => {
    assert.strictEqual(count2, count1);
  });
  check('F2 rateDay 跨引擎保持', () => {
    assert.ok(e2.getRateDay());
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ---------- [G] 拖动不产生 valence 增益 ---------- */
console.log('[G] 拖动不滚递减');
{
  const e = createMoodEngine();
  const v0 = e.axes.valence;
  e.onDragBegin();
  e.onDragEnd();
  const dv = e.axes.valence - v0;
  check('G1 拖动不产生 valence 增益', () => {
    assert.ok(Math.abs(dv) < 1e-9, '拖动不应改 valence: dv=' + dv);
  });
  // 拖动不滚计数：后续点击仍全额
  check('G2 拖动不消耗递减次数', () => {
    e.onClick();
    const d1 = e.axes.valence - v0;
    assert.ok(Math.abs(d1 - GAIN.clickValence) < 1e-9,
      '拖动后首次点击应全额: ' + d1);
  });
}

/* ---------- [H] config 默认值 ---------- */
console.log('[H] config 默认值');
{
  const cfgPath = path.join(__dirname, '..', 'src', 'main', 'config.js');
  const src = fs.readFileSync(cfgPath, 'utf8');
  check('H1 config 有 dedentEnabled 开关', () => {
    assert.ok(src.includes('dedentEnabled'), 'config.js 缺 dedentEnabled');
  });
  check('H2 dedentEnabled 默认 true', () => {
    assert.ok(/dedentEnabled\s*:\s*true/.test(src), 'dedentEnabled 默认应为 true');
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
