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

const { collectStats, formatStats, startSensorWatch, stopSensorWatch, waitForFirstGpu, HUD_FIELDS, FULL_FIELDS } =
  require('../src/main/sysinfo');

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
   *    早先 GPU 走 WMI 累计计数器求差时，两次采样挨太近会时间窗不合法、
   *    这一帧出不了数（正确行为），连打两枪量出来的"热路径 2.2s"全是假象。
   *    2026-10-13 起 GPU 改由 nvidia-smi 直读，没有求差这一步了，
   *    但"按真实节奏量"这条纪律仍然保留（慢字段的启动开销是真的）。 */
  console.log('\n第二枪（已有基线，按真实 3 秒节奏量 —— 应该只花一枪 PowerShell 的钱）');
  await new Promise((r) => setTimeout(r, 3000));
  t0 = Date.now();
  const hudWarm = await collectStats(HUD_FIELDS);
  const warmMs = Date.now() - t0;
  console.log('  耗时 ' + warmMs + ' ms');
  console.log('  ' + dump(hudWarm) + '\n');

  check(typeof hudWarm.gpu === 'number', '热路径有 GPU 占用');
  check(typeof hudWarm.tempC === 'number', '热路径有温度');

  /* 连打一枪不该另起进程 —— 直接命中常驻读数（这是"不抢、不重复起"的回归点）。 */
  console.log('\n连打一枪（直接命中常驻读数，应该**不启进程**）');
  t0 = Date.now();
  const hudBurst = await collectStats(HUD_FIELDS);
  const burstMs = Date.now() - t0;
  console.log('  耗时 ' + burstMs + ' ms  gpu=' + hudBurst.gpu);
  check(burstMs < 1600, '连打一枪不启进程（< 1600ms）');

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

  /* ══════ 3. 常驻采样器 ══════
   *
   * ⚠️ 这一段是「GPU 占用慢一拍」那个坑的**回归锁**，别删。
   *    常驻采样器让每次推送**不再启进程**（powershell 固定启动开销 ~500ms），
   *    并让读数足够新鲜（每 1 秒一枪，而不是"上一次推送到现在"）。
   *    下面两条断言分别锁住这两件事：读数是常驻来的（采集极快）、且有值。
   *    （历史：最初是为了压 GPU 的求差窗口 —— 那时 GPU 走 WMI 累计计数器，
   *      2026-10-13 改成 nvidia-smi 直读后窗口问题本身消失了。） */
  console.log('\n══════ 3. 常驻传感器采样器（GPU 不再慢一拍）══════\n');

  startSensorWatch();

  /* 🔴 下面两条是「首次加载时 GPU 比别的项慢一拍」的回归锁，别删。
   *    GPU 读数要等常驻采样器把 powershell 拉起来、跑完一次 nvidia-smi（≈1.5s）。
   *    主进程第一次推送前会先 waitForFirstGpu() —— 等它一次，
   *    换来「第一次出现就是完整的一张牌」，而不是先给半张（CPU/内存）
   *    再补上 GPU 那一格 —— 后者正是用户看到的现象。 */
  console.log('等第一个 GPU 读数（模拟主进程首次推送前的等待）');
  const tWait = Date.now();
  const gotGpu = await waitForFirstGpu(6000);
  const waitMs = Date.now() - tWait;
  console.log(`  等待 ${waitMs} ms，拿到 = ${gotGpu}`);
  check(gotGpu === true, '⚠️ 关键：等到了第一个 GPU 读数（不是超时放弃）');
  /* ⚠️ 只卡上界。下界不做断言：等多久取决于 PowerShell 启动快慢。 */
  check(waitMs <= 6000, `等待时长 ${waitMs}ms ≤ 6s（没有干等到超时）`);

  const tLive = Date.now();
  const live = await collectStats(HUD_FIELDS);
  const liveMs = Date.now() - tLive;
  console.log(`  采样器在跑时，一次采集耗时 ${liveMs} ms`);
  console.log('  ' + dump(live) + '\n');

  /* 阈值给得很松（60ms）：重点不是"有多快"，而是"有没有起 PowerShell"。
   * 一旦退回"每次推送现打一枪"，这里立刻会变成 400~1000ms。
   * ⚠️ 这条同时锁住"采样器活着时不另起进程抢它的基线"—— 抢的那一枪窗口非法，
   *    会把这一帧的 GPU 静默打没（sensorAlive 上面那段）。 */
  check(liveMs < 60, `⚠️ 关键：采集不启进程、直接命中常驻读数（${liveMs} ms < 60 ms）`);
  check(typeof live.gpu === 'number', '⚠️ 关键：等到之后一定拿得到 GPU —— 首帧不会是"半张牌"');
  check(typeof live.tempC === 'number', '常驻采样器给出了温度');
  check(live.gpu === null || (live.gpu >= 0 && live.gpu <= 100), 'GPU 占用落在 0–100');

  /* GPU 口径的源码级断言（2026-10-13 用户报"取的好像不是独立显卡的"之后立的规矩）：
   *   ① 不许再出现 WMI 的 GPUEngine 求和路径 —— 双 GPU 机器上那些实例是
   *      按 luid 分的，求和把核显和独显加在一起，既不等于核显也不等于独显；
   *      而本机桌宠渲染在核显上（ANGLE/Intel），于是显示出来几乎全是核显的数。
   *   ② GPU 占用与温度必须取自**同一次** nvidia-smi 调用 —— 同源、同生共死。
   *   ③ 两者都只在 nvidia-smi 取到时才填 —— 没有 N 卡就整项不画（用户："没有就不取"）。 */
  const srcInfo = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/main/sysinfo.js'), 'utf8');
  check(!srcInfo.includes('Win32_PerfRawData_GPUPerformanceCounters_GPUEngine'),
    '⚠️ 关键：GPU 占用不再走 WMI 求和（双 GPU 机器上求和 = 核显 + 独显，口径错）');
  check(/--query-gpu=utilization\.gpu,temperature\.gpu/.test(srcInfo),
    '⚠️ 关键：GPU 占用与温度取自同一次 nvidia-smi 调用（同源，少起一次进程）');
  check(/\$o\.nvGpu = \[int\]/.test(srcInfo) && /\$o\.tempC = \[int\]/.test(srcInfo),
    '两者都由 nvidia-smi 填入 —— 没有 N 卡就整项不画，不硬凑（用户："没有就不取"）');

  stopSensorWatch();
  console.log('  （采样器已停）');

  console.log('\n══════ 4. formatStats（气泡里那句话）══════\n');
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
