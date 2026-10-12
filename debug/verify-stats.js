'use strict';
/* 系统状态采集的验收脚本。
 *
 * 只 require sysinfo.js —— 它只依赖 fs / os / child_process，不碰 electron，
 * 所以能直接用 node 跑，不用起整个应用。
 *
 * ⚠️ 判定必须计数。这个项目踩过一次坑：脚本里 ok/no 只打印不累计，
 *    结果全红还是退出码 0，被当成"通过"。
 *
 * 用法：node debug/verify-stats.js
 */

const { collectStats, formatStats, HUD_FIELDS, FULL_FIELDS } = require('../src/main/sysinfo');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

const dump = (s) => JSON.stringify(s, (k, v) => (v instanceof Map ? '[Map]' : v));

(async () => {
  console.log('══════ 1. 悬浮小字那一路（HUD_FIELDS = ' + JSON.stringify(HUD_FIELDS) + '）══════\n');

  console.log('第一枪（冷启动 —— 没有基线，必须自己补第二枪）');
  let t0 = Date.now();
  const hudCold = await collectStats(HUD_FIELDS);
  const coldMs = Date.now() - t0;
  console.log('  耗时 ' + coldMs + ' ms');
  console.log('  ' + dump(hudCold) + '\n');

  check(typeof hudCold.cpu === 'number', '冷启动就有 CPU');
  check(!!hudCold.mem, '冷启动就有内存');
  check(typeof hudCold.gpu === 'number', '⚠️ 关键：冷启动第一枪就补出了 GPU 占用（说明补枪逻辑生效）');
  check(
    typeof hudCold.gpu !== 'number' || (hudCold.gpu >= 0 && hudCold.gpu <= 100),
    'GPU 占用落在 0–100'
  );
  check(
    typeof hudCold.tempC !== 'number' || (hudCold.tempC >= 15 && hudCold.tempC <= 110),
    '温度落在合理区间（15–110°C）'
  );

  /* ⚠️ 热路径必须**按真实节奏**量，不能连打两枪。
   *    GPU 占用是累计值求差，两次采样挨得太近（< GPU_WIN_MIN = 800ms）时
   *    时间窗不合法 → 这一帧出不了数，这是**正确行为**。
   *    早先这个脚本连打两枪，量出来的"热路径 2.2s"全是假象：
   *    它把"窗口太短的正常拒绝"当成了"冷启动要补枪"，白等 1.2s 再打一枪。
   *    真实节奏（默认 3s 间隔）下热路径只有 ~450ms、一枪搞定。 */
  console.log('\n第二枪（已有基线，按真实 3 秒节奏量 —— 应该只花一枪 PowerShell 的钱）');
  await new Promise((r) => setTimeout(r, 3000));
  t0 = Date.now();
  const hudWarm = await collectStats(HUD_FIELDS);
  const warmMs = Date.now() - t0;
  console.log('  耗时 ' + warmMs + ' ms');
  console.log('  ' + dump(hudWarm) + '\n');

  check(typeof hudWarm.gpu === 'number', '热路径有 GPU 占用');
  check(typeof hudWarm.tempC === 'number', '热路径有温度');

  /* 连打两枪不该白等补枪 —— 这是"区分 no-baseline / bad-window"的回归点。 */
  console.log('\n连打一枪（窗口太短，应该**不补枪**、直接放弃这一帧的 GPU）');
  t0 = Date.now();
  const hudBurst = await collectStats(HUD_FIELDS);
  const burstMs = Date.now() - t0;
  console.log('  耗时 ' + burstMs + ' ms  gpu=' + hudBurst.gpu);
  check(burstMs < 1600, '窗口太短时不触发 1.2s 补枪（< 1600ms）');

  console.log('\n── 字段取舍 ──');
  check(!('battery' in hudWarm), '悬浮小字那一路**没有**取电量（它不显示电量）');
  check(!('net' in hudWarm), '悬浮小字那一路**没有**取网速（它不显示网速）');

  console.log('\n── 耗时对比 ──');
  console.log('  冷启第一枪 ' + coldMs + ' ms（含补枪的 1200ms 等待）');
  console.log('  热路径一枪 ' + warmMs + ' ms（真实 3s 节奏，单枪 PowerShell）');
  check(warmMs < 1600, 'HUD 常态开销 < 1600ms（真实节奏下应 ~450ms；改之前一把梭是 ~2500ms）');

  console.log('\n══════ 2. 问"系统状态"那一路（FULL_FIELDS）══════\n');
  /* 同样要等一个真实间隔：紧挨着上一枪打，GPU 时间窗又不合法了。 */
  await new Promise((r) => setTimeout(r, 3000));
  t0 = Date.now();
  const full = await collectStats(FULL_FIELDS);
  const fullMs = Date.now() - t0;
  console.log('  耗时 ' + fullMs + ' ms');
  console.log('  ' + dump(full) + '\n');

  check(!!full.battery, '全量那一路有电量');
  check(typeof full.battery?.percent === 'number', '电量有数值');
  check(!!full.net, '全量那一路有网速');
  check(typeof full.gpu === 'number', '全量那一路也有 GPU 占用');
  check(typeof full.tempC === 'number', '全量那一路也有温度');
  check(!!full.disk, '全量那一路有磁盘');

  console.log('\n══════ 3. formatStats（气泡里那句话）══════\n');
  const text = formatStats(full);
  console.log('  ' + text + '\n');
  check(/GPU \d+%/.test(text), '话里有 GPU 占用');
  check(/GPU 温度 \d+℃/.test(text), '话里的温度写明是「GPU 温度」（不是含糊的"温度"）');
  check(!/CPU 温度/.test(text), '没有谎报 CPU 温度');

  console.log('\n════════════════════════════════════════');
  if (failures) {
    console.log('❌ ' + failures + ' 项未通过');
    process.exit(1);
  }
  console.log('✅ 全部通过');
})();
