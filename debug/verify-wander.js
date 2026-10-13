'use strict';
/* 自主漫步（走走停停）+ 有人操作就走回家 —— motion.js 的**逻辑单测**。
 *
 * 为什么要有这个脚本（而不是只靠实跑）：
 *   这一段是纯时序逻辑（循环、取消、代际令牌、门槛判定），在真机上验一次要
 *   几十秒、还得靠肉眼；在这里用假窗口跑，每个断言都是毫秒级的确定性结论。
 *   而且它守住的是一个**已经真出过事**的地方：
 *     · 溜达那趟的 pet:wander-end 曾经**从来没发出去过**
 *       （老的 snapGuard 被 animateTo 自己跑完时顺手清掉了）——
 *       以前人不动（只挪窗口）看不出来，换成播 Walk 之后就变成
 *       "溜达完一直原地走"。所以「每趟必须成对收发」这里是硬断言。
 *     · 「用户操作优先于自动动作」：他上手拖窗口时，循环 + 动画必须一起停。
 *
 *   node debug/verify-wander.js
 */
const { makeMotionEnv } = require('./lib-motion-stub');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (c, m) => (c ? ok(m) : no(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, step = 60) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await sleep(step);
  }
  return !!pred();
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const env = makeMotionEnv();
const { motion, state } = env;

/* 走一趟：等到**又有一趟走完**。
 * 判据用 pet:wander-end 的计数而不是 wanderMoved 标志 —— 后者是跨用例留着的
 * 状态（"跑远过"这件事一次为真就一直为真，直到回位或用户拖拽才清），
 * 拿它当边沿会漏。 */
async function oneStep(timeoutMs = 6000) {
  const before = env.countOf('pet:wander-end');
  const got = await waitFor(() => env.countOf('pet:wander-end') > before, timeoutMs);
  await sleep(120);                         // 等 wanderLoop 把 wanderMoved 置上位
  return got;
}

/* 把"她跑远过"这个状态清掉，好让每个用例都从干净状态起步。
 * 走公开 API 而不是直接改内部变量 —— 顺带也验证了 onUserDragEnd 的语义。 */
function resetAwayFlag() {
  env.motion.onUserDragEnd();
}

async function main() {
  /* ── 1. 走走停停：没人操作就自己一趟一趟地走 ─────────────── */
  console.log('\n═══ 1. 走走停停（没人操作时的自主漫步）═══\n');
  {
    motion.setHome(state.bounds.x, state.bounds.y);
    const home = { ...state.bounds };
    state.idleSec = 9999;
    env.clear();
    env.resetBoundsCount();

    const t0 = Date.now();
    motion.startWander();
    check(motion.wanderState().mode === 'wander', 'startWander 进入溜达态');
    check(motion.isMoveAnimRunning(), '立刻起了平滑移动');
    check(env.countOf('pet:wander-start') === 1, '第一趟就发了 pet:wander-start（渲染层据此播 Walk）');

    await sleep(6000);
    const starts = env.countOf('pet:wander-start');
    const ends = env.countOf('pet:wander-end');
    check(starts >= 2, `6 秒内真的走了多趟（wander-start × ${starts}）—— 是"走走停停"不是挪一下就完`);
    check(ends >= starts - 1,
      `每趟都成对收到 wander-end（${ends}/${starts}）—— 这是"到点必收手"的护栏，` +
      '老实现就是这里漏了、导致 Walk 永远不停');
    check(state.setBoundsCalls > 0, `确实在写窗口位置（setBounds × ${state.setBoundsCalls}）`);
    console.log(`       ↳ 起点 (${home.x},${home.y}) → 现在 (${state.bounds.x},${state.bounds.y})，` +
      `离家 ${Math.round(dist(state.bounds, home))}px，用了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* ── 2. 用户一上手：循环 + 动画整体收手 ───────────────────── */
  console.log('\n═══ 2. 用户拖窗口 → 一切自动移动立刻让位 ═══\n');
  {
    await sleep(900);                       // 让它走到"正在走"或"正在歇"的中间态
    env.clear();
    motion.onUserDragMove();
    check(!motion.isMoveAnimRunning(), 'onUserDragMove 停掉了当前这趟平滑移动');
    check(motion.wanderState().mode === 'idle', '循环也退出了（mode=idle）');

    await sleep(1200);
    env.resetBoundsCount();
    await sleep(1500);
    check(state.setBoundsCalls === 0,
      '接下来 1.5 秒一次都没再写窗口位置（溜达循环真的死了，不是排着下一步）');
    check(env.countOf('pet:wander-start') === 0, '也没有新的 wander-start');
  }

  /* ── 3. 他回来了 → 把跑远的她收回原位 ────────────────────── */
  console.log('\n═══ 3. 有人操作 → 走回家（家的定义 = 启动时的位置）═══\n');
  {
    resetAwayFlag();
    motion.setHome(state.bounds.x, state.bounds.y);
    const home = { ...state.bounds };
    state.idleSec = 9999;

    motion.startWander();
    const stepped = await oneStep(6000);
    check(stepped, '先让她自己溜达了一趟（wanderMoved 置位）');
    check(motion.wanderState().wanderMoved === true, '「她跑远过」的标志已置位');
    const away = { ...state.bounds };
    const dAway = dist(away, home);
    check(dAway > 40, `她确实跑远了（离家 ${Math.round(dAway)}px）`);

    env.clear();
    state.idleSec = 0;                     // ← "有人操作了"（鼠标动 / 敲键盘）
    motion.notifyUserActivity();
    check(env.countOf('pet:noticed') === 1, '发了一条 pet:noticed（她"注意到你回来了"）');
    check(motion.wanderState().mode === 'home', '进入回位态');

    const back = await waitFor(() => motion.wanderState().mode === 'idle', 8000);
    check(back, '回位动作跑完了');
    const dHome = dist(state.bounds, home);
    check(dHome <= 3, `回到原位（残差 ${Math.round(dHome)}px）`);
    check(motion.wanderState().wanderMoved === false, '待回位标志已清零');
  }

  /* ── 4. 人已经在家 → 不白走一趟 ─────────────────────────── */
  console.log('\n═══ 4. 已经在家就别演一遍"走回去" ═══\n');
  {
    resetAwayFlag();
    motion.setHome(state.bounds.x, state.bounds.y);
    const home = { ...state.bounds };
    state.idleSec = 9999;
    motion.startWander();
    await oneStep(6000);                    // 跑远（wanderMoved = true）
    motion.stopWander();

    state.bounds = { ...home };             // 手动把她摆回原位（模拟"其实没跑远"）
    env.resetBoundsCount();
    env.clear();
    state.idleSec = 0;
    motion.notifyUserActivity();
    await sleep(500);
    check(state.setBoundsCalls === 0, '一次窗口位置都没写（没有多余的"回家"动画）');
    check(motion.wanderState().wanderMoved === false, '待回位标志被就地清掉');
  }

  /* ── 5. 用户手动拖放 → 尊重他的摆放，不把她拽回去 ────────── */
  console.log('\n═══ 5. 他亲手拖过她之后，别自作主张把人拽回原位 ═══\n');
  {
    resetAwayFlag();
    motion.setHome(state.bounds.x, state.bounds.y);
    state.idleSec = 9999;
    motion.startWander();
    const stepped = await oneStep(6000);
    check(stepped && motion.wanderState().wanderMoved === true, '先让她溜达跑远');
    motion.onUserDragEnd();                 // ← 松手（拖拽结束）
    await sleep(600);
    const placed = { ...state.bounds };
    env.resetBoundsCount();
    state.idleSec = 0;
    motion.notifyUserActivity();
    await sleep(500);
    check(state.setBoundsCalls === 0, '不回位：他刚把人放下，位置由他说了算');
    check(dist(state.bounds, placed) === 0, '窗口一动不动');
  }

  /* ── 6. 开关 / 静默：该不动就不动 ───────────────────────── */
  console.log('\n═══ 6. 开关与静默 ═══\n');
  {
    env.writeConfig({ motion: { enabled: true, wander: false, wanderIdleMin: 0.2, returnOnActivity: true } });
    env.clear();
    motion.startWander();
    await sleep(400);
    check(motion.wanderState().mode === 'idle' && env.countOf('pet:wander-start') === 0,
      'motion.wander=false 时 startWander 不干活');

    env.writeConfig({ motion: { enabled: true, wander: true, wanderIdleMin: 0.2, returnOnActivity: true } });
    motion.setMotionPaused(true);
    env.clear();
    motion.startWander();
    await sleep(400);
    check(motion.wanderState().mode === 'idle' && env.countOf('pet:wander-start') === 0,
      '全屏静默期间不溜达');

    motion.setMotionPaused(false);
    state.idleSec = 9999;
    motion.startWander();
    check(motion.wanderState().mode === 'wander', '退出静默后能照常溜达');
    motion.cancelAutoMotion();
    await sleep(300);
    check(state.sent.filter((c) => c === 'pet:wander-end').length > 0,
      'cancelAutoMotion 也会补上 wander-end（不会把 Walk 动作丢在半路）');
  }

  /* ── 7. 闲置门槛 ────────────────────────────────────────── */
  console.log('\n═══ 7. 闲置门槛（刚打开开关不许她立刻就走）═══\n');
  {
    motion.stopWander();
    motion.disposeMotion();
    env.writeConfig({ motion: { enabled: true, wander: true, wanderIdleMin: 0.2, returnOnActivity: true } });

    state.idleSec = 9999;                   // 系统侧：早没人动了
    env.clear();
    motion.startIdleWatcher();              // 刚"武装"，同一次闲置时长还没走完
    await sleep(1800);
    check(motion.wanderState().mode === 'idle' && env.countOf('pet:wander-start') === 0,
      '刚武装 1.8 秒时不溜达（虽然系统已经闲置很久）');

    state.idleSec = 3;                      // 系统侧：3 秒前刚有输入，不到 12 秒门槛
    await sleep(1200);
    check(motion.wanderState().mode === 'idle', '闲置不足门槛也不溜达');

    motion.disposeMotion();
  }

  /* ── 8. 关掉开关要立刻收手 ──────────────────────────────── */
  console.log('\n═══ 8. 托盘里关掉"闲置时自己溜达" → 正在走也要停 ═══\n');
  {
    env.writeConfig({ motion: { enabled: true, wander: true, wanderIdleMin: 0.2, returnOnActivity: true } });
    state.idleSec = 9999;
    motion.startWander();
    await sleep(300);
    check(motion.wanderState().mode === 'wander', '先让她走起来');
    env.writeConfig({ motion: { enabled: true, wander: false, wanderIdleMin: 0.2, returnOnActivity: true } });
    motion.refreshWanderConfig();
    check(motion.wanderState().mode === 'idle', '改配置后立刻停');
    check(!motion.isMoveAnimRunning(), '平滑移动也停了');
  }

  motion.disposeMotion();
  console.log('');
}

main().then(() => {
  console.log(failures === 0
    ? '✅ verify-wander 全绿'
    : `❌ verify-wander 有 ${failures} 项没过`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  console.log('❌ EXCEPTION ' + ((e && e.stack) || e));
  process.exit(1);
});
