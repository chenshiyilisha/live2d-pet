'use strict';
/* 全屏检测 / 静默判定的验收脚本。
 *
 * 两块内容：
 *   A. 纯逻辑单测 —— evaluateSample（判定）与 Hysteresis（迟滞）。
 *      全部用假时钟和手造样本，确定性 100%，不依赖当前桌面状态。
 *   B. 实跑一次采样 —— 真的起 PowerShell、真的解析，确认"Win32 → JSON → JS"
 *      这条链路在**这台机器上今天**是通的（A 部分测不到这个）。
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-quiet.js
 */

const { evaluateSample, Hysteresis, startFullscreenWatch, stopFullscreenWatch } =
  require('../src/main/fullscreen');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

/* 假时钟：把 Hysteresis 的 setTimeout 换成"可手动推进"的版本，
 * 这样"等 4 秒"在测试里是瞬时且确定的。 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setT: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn });
      return id;
    },
    clearT: (id) => { timers.delete(id); },
    pending: () => timers.size,
    advance: (ms) => {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard++) {
        let best = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (!best || t.at < best.t.at)) best = { id, t };
        }
        if (!best) break;
        timers.delete(best.id);
        now = best.t.at;
        best.t.fn();
      }
      now = target;
    }
  };
}

// 造样本：[l,t,r,b] 矩形
const S = (r, m, c, p) => ({ r, m, c, p });

console.log('══════ 1. evaluateSample —— 是不是全屏 ══════\n');

/* 基准：1920x1080 的屏，桌宠自己的 pid 是 999。 */
const MON = [0, 0, 1920, 1080];
const SELF = 999;

check(
  evaluateSample(S([0, 0, 1920, 1080], MON, 'GameWin', 100), SELF).full === true,
  '贴满整块显示器的窗口 → 全屏'
);
check(
  evaluateSample(S([-8, -8, 1928, 1080], MON, 'GameWin', 100), SELF).full === true,
  '带边框溢出的全屏窗口（真实全屏常见形态）→ 全屏'
);

/* ⚠️ 这条是整个功能的分水岭：把"最大化"误判成全屏的话，
 *    写文档、看表格时她都会莫名静默。 */
const maxSample = S([-8, -8, 1928, 1040], MON, 'Notepad', 100);
const maxVerdict = evaluateSample(maxSample, SELF);
check(maxVerdict.full === false, '⚠️ 关键：最大化窗口（差一条 40px 任务栏）→ 不算全屏');
check(maxVerdict.why === 'windowed', '  判据是 windowed（说明是被矩形覆盖条件挡下的）');

check(
  evaluateSample(S([0, 0, 1920, 1080], MON, 'WorkerW', 100), SELF).why === 'shell:WorkerW',
  '桌面壁纸层（WorkerW）→ 不算全屏'
);
check(
  evaluateSample(S([0, 0, 1920, 1080], MON, 'Progman', 100), SELF).why === 'shell:Progman',
  '桌面（Progman）→ 不算全屏'
);
check(
  evaluateSample(S([0, 1040, 1920, 1080], MON, 'Shell_TrayWnd', 100), SELF).full === false,
  '任务栏 → 不算全屏'
);

/* 自我排除 —— 不做这条的话，一旦桌宠自己被判成全屏就会"自我静默"且
 * 永远醒不过来（静默本身不会改变前台窗口）。 */
check(
  evaluateSample(S([0, 0, 1920, 1080], MON, 'Chrome_WidgetWin_1', SELF), SELF).why === 'self',
  '⚠️ 关键：前台是我们自己（pid 相同）→ 一律不算全屏'
);

check(
  evaluateSample({ r: null }, SELF).why === 'no-foreground',
  '没有前台窗口 → 不算全屏'
);
check(
  evaluateSample(null, SELF).full === false,
  '样本为空 → 不算全屏（不抛）'
);

/* 副屏：主屏右侧的第二块屏，坐标是正的偏移；左侧副屏坐标是负的。
 * 拿主屏的边界去比副屏上的窗口会永远判 false —— 所以样本里必须带
 * "窗口所在那块屏"的边界（这正是 MonitorFromWindow 的作用）。 */
const MON2 = [-1920, 0, 0, 1080];
check(
  evaluateSample(S([-1920, 0, 0, 1080], MON2, 'GameWin', 100), SELF).full === true,
  '副屏（负坐标）上的全屏窗口 → 全屏'
);
check(
  evaluateSample(S([-1920, 0, 0, 1080], MON, 'GameWin', 100), SELF).full === false,
  '副屏上的窗口拿主屏边界去比 → 不算全屏（说明"按窗口所在屏判"是必要的）'
);

/* 最小化的窗口矩形会跑到 (-32000, -32000) 这种地方 */
check(
  evaluateSample(S([-32000, -32000, -31840, -31960], MON, 'Notepad', 100), SELF).full === false,
  '最小化窗口（矩形在 -32000 附近）→ 不算全屏'
);

console.log('\n══════ 2. Hysteresis —— 进出的不对称与防抖 ══════\n');

/* 场景一：进立刻、出等 4 秒（生产参数）。 */
{
  const clk = fakeClock();
  const log = [];
  const h = new Hysteresis({
    onChange: (v, why) => log.push(`${v ? 'IN' : 'OUT'}@${clk.now()}(${why})`),
    enterMs: 0,
    exitMs: 4000,
    setT: clk.setT,
    clearT: clk.clearT
  });

  h.push(true, 'fullscreen:Game');
  check(log.join() === 'IN@0(fullscreen:Game)', '进入是全屏就**立刻**生效（不等）');

  h.push(true, 'fullscreen:Game');
  h.push(true, 'fullscreen:Game');
  check(log.length === 1, '持续全屏期间不重复回调（只有状态真的变了才通知）');

  h.push(false, 'windowed');
  clk.advance(3900);
  check(log.length === 1, '退出在 3.9 秒时还没生效（迟滞期内）');
  clk.advance(200);
  check(log.join().endsWith('OUT@4000(windowed)'), '满 4 秒才退出，且带上了原因');
}

/* 场景二：Alt+Tab 出去瞄一眼再切回来 —— 这是迟滞存在的**唯一理由**。
 * 没有它，每次切窗口都会"醒一轮再睡回去"，还可能在游戏画面上闪一下。 */
{
  const clk = fakeClock();
  const log = [];
  const h = new Hysteresis({
    onChange: (v) => log.push(v),
    enterMs: 0,
    exitMs: 4000,
    setT: clk.setT,
    clearT: clk.clearT
  });

  h.push(true, 'a');            // 进游戏
  clk.advance(1000);
  h.push(false, 'b');           // Alt+Tab 出去（排了 4 秒的退出）
  clk.advance(2000);
  check(h.pending === false, '中途退出时"待发出"的状态是 false');
  h.push(true, 'c');            // 2 秒后切回游戏
  clk.advance(10000);
  check(log.join() === 'true', '⚠️ 关键：切出去 2 秒又切回来 → 全程只通知过一次，没醒也没睡');
}

/* 场景三：真的退出了，之后又进 —— 两次都要通知 */
{
  const clk = fakeClock();
  const log = [];
  const h = new Hysteresis({
    onChange: (v) => log.push(v),
    enterMs: 0,
    exitMs: 4000,
    setT: clk.setT,
    clearT: clk.clearT
  });

  h.push(true, 'a');
  clk.advance(5000);
  h.push(false, 'b');
  clk.advance(5000);
  check(log.join() === 'true,false', '真的退出超过迟滞期 → 照常通知 false');

  h.push(true, 'c');
  clk.advance(100);
  check(log.join() === 'true,false,true', '再次进入 → 立刻通知（第二次也能正常工作）');
}

/* 场景四：stop 之后不得留下任何待触发的定时器 —— 退出应用时如果还挂着一个
 * 4 秒后回调的定时器，它会在窗口已经销毁之后去 setQuiet，日志里就会出现
 * 一串莫名其妙的报错。 */
{
  const clk = fakeClock();
  const log = [];
  const h = new Hysteresis({
    onChange: (v) => log.push(v),
    enterMs: 0,
    exitMs: 4000,
    setT: clk.setT,
    clearT: clk.clearT
  });
  h.push(true, 'a');
  h.push(false, 'b');
  check(clk.pending() === 1, '退出静默时确实排着一个待触发的定时器');
  h.stop();
  clk.advance(10000);
  check(clk.pending() === 0 && log.join() === 'true', 'stop() 之后定时器被清掉，不再回调');
}

console.log('\n══════ 3. 实跑一次采样（真的起 PowerShell）══════\n');

(async () => {
  let samples = [];
  let watchOk = false;
  try {
    watchOk = startFullscreenWatch(() => {}, {
      onSample: (s, r) => samples.push({ s, r })
    });
  } catch (err) {
    no('起监视进程抛错: ' + (err?.message || err));
  }

  check(watchOk === true, '监视进程起来了（Windows 上应返回 true）');

  await new Promise((r) => setTimeout(r, 4000));
  const live = samples.slice();
  console.log(`  4 秒收到 ${live.length} 个样本：`);
  if (live.length) console.log('  ' + JSON.stringify(live[live.length - 1].s));

  check(live.length >= 3, `采样频率正常（4 秒至少 3 个，实际 ${live.length} 个）`);

  const last = live[live.length - 1];
  check(!!last, '拿到了至少一个样本');
  if (last) {
    const s = last.s;
    const shapeOk = (Array.isArray(s.r) || s.r === null) && Array.isArray(s.m) &&
      s.m.length === 4 && typeof s.c === 'string' && typeof s.p === 'number';
    check(shapeOk, '样本结构完整（r/m/c/p 都在，说明 Win32 → JSON → JS 这条链是通的）');
    check(
      Array.isArray(s.m) && s.m[2] - s.m[0] > 200 && s.m[3] - s.m[1] > 200,
      `显示器边界合理（${Array.isArray(s.m) ? s.m[2] - s.m[0] + '×' + (s.m[3] - s.m[1]) : '?'}）`
    );
    console.log(`  当前判定：full=${last.r.full}  why=${last.r.why}`);
    console.log('  （此刻桌面上没有全屏应用的话，full=false 就是对的）');
  }

  /* ⚠️ 停掉之后必须**真的收不到数据**了。
   *    Windows 上父进程退出不会带走子进程，如果 kill 没生效，
   *    就会留下一个永远在跑的 powershell.exe —— 只能靠这个断言发现。 */
  stopFullscreenWatch();
  const before = samples.length;
  await new Promise((r) => setTimeout(r, 2500));
  check(samples.length === before, '⚠️ 关键：stop() 之后不再有样本（采样进程确实被杀了，不是野进程）');

  /* ══════ 4. 静默"七处一起收手"里，朗读那一路必须收干净 ══════
   * 2026-10-15 修的真 bug：这里原来只写了 stopSpeak()。tts.js 的 interrupt
   * 靠**代际令牌**作废在途回调，而被作废的那条**不会**再推状态
   * （finish 里 `if (gen !== ttsGen) return`），于是 pet.js 的 state 留在 SPEAKING。
   * 两个后果都是静默的：
   *   · 嘴闭着还在跑正弦波（渲染循环那个分支要 state === SPEAKING）；
   *   · 静默解除之后，proactive 的 `state !== IDLE` 判据**永久拦死**她开口
   *     —— 用户看到的是"打了一把游戏回来她再也不主动说话了"。 */
  {
    const fs = require('fs');
    const path = require('path');
    const PET = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pet.js'), 'utf8');

    const iQ = PET.indexOf("window.pet?.on?.('pet:quiet'");
    const quietTick = PET.slice(iQ, PET.indexOf('applyFrameCap();', iQ));
    check(/stopSpeaking\(\);/.test(quietTick),
      '进静默时用的是 stopSpeaking()（不是裸的 stopSpeak）');
    check(!/stopSpeak\(\);/.test(quietTick.replace(/stopSpeaking\(\);/g, '')),
      '同一段里没有裸的 stopSpeak() 残留（它不收状态）');

    const iS = PET.indexOf('function stopSpeaking()');
    const fn = PET.slice(iS, iS + 500);
    check(/state === State\.SPEAKING && !busy/.test(fn) && /setState\(State\.IDLE\)/.test(fn),
      'stopSpeaking 把状态机一起收回 IDLE（busy 时不抢 —— 对话流程自己会收）');
    check(/resetSpoken\(\)/.test(fn), '顺带把"念到哪"那笔账清掉');
  }

  console.log('\n════════════════════════════════════════');
  if (failures) {
    console.log('❌ ' + failures + ' 项未通过');
    process.exit(1);
  }
  console.log('✅ 全部通过');
  process.exit(0);
})();
