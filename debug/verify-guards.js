'use strict';
/* 三处"悄无声息就坏掉"的护栏（2026-10-13 修复，见当天的审查记录）。
 *
 *   A. motion.js —— 用户一上手（拖拽）就把溜达排下的那次**自动贴边**一起撤掉。
 *      这条只能真跑：它是"两个定时器谁先动窗口位置"的时序问题。
 *      所以 A 用桩替掉 electron，直接驱 motion.js。
 *   B. pet.js —— 换模型的单飞守卫（连点两次不能并发挂两份纹理）。
 *      这需要真的 Live2D 运行时，起不来，所以退而求其次做**源码级断言**：
 *      断言的是"守卫代码还在"，不是"守卫逻辑对"—— 它防的是**被人删掉**。
 *
 *   node debug/verify-guards.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (c, m) => (c ? ok(m) : no(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');

/* ══════════════════ B. 源码级断言（先做，不依赖运行时） ══════════════════ */
console.log('\n═══ B. pet.js：换模型的单飞守卫还在不在 ═══\n');
{
  const petSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/pet.js'), 'utf8');
  check(/mountTarget = def;/.test(petSrc),
    'mountModel 进 await 之前先登记目标模型');
  check(/if \(mountTarget !== def\) \{[\s\S]{0,200}?return false;/.test(petSrc),
    '加载完成时比对目标：变过就销毁刚加载的模型并 return false');
  check(/const mounted = await mountModel\(a\.model\);\s*\n\s*if \(!mounted\) return;/.test(petSrc),
    '调用方按返回值决定要不要报「换好了」');
  check(!/\bMAP\b/.test(petSrc.replace(/见 MAP|（见 MAP）/g, '')),
    '没人读的 MAP 变量已经清掉（不会又长回来）');
}

/* ══════════════════ A. 真跑 motion.js ══════════════════ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-guard-'));
/* 这块屏故意开得很小：doWander 的目标点被夹在 [MARGIN, 屏 - 窗口 - MARGIN] 里，
 * 屏小 → 目标点必然离边缘很近 → 到点那次 edgeSnap() 一定会真的动窗口。
 * 屏大的话她就溜达到屏幕中间，edgeSnap 因为"离边太远"直接 return，
 * 对照组反而测不出东西（探针失效，白绿）。 */
const DISPLAY = { x: 0, y: 0, width: 400, height: 400 };

let setBoundsCalls = 0;
let winBounds = { x: 10, y: 10, width: 308, height: 342 };

const fakeWin = {
  isDestroyed: () => false,
  isVisible: () => true,
  getBounds: () => ({ ...winBounds }),
  setBounds: (b) => { winBounds = { ...b }; setBoundsCalls++; },
  webContents: { send: () => {} }
};

const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron') {
    return {
      app: { getPath: () => tmp, getVersion: () => '0.0.0-test' },
      screen: {
        // 光标离得远远的 —— 否则 doWander 会判成"注意到你了"直接不溜达
        getCursorScreenPoint: () => ({ x: -9999, y: -9999 }),
        getDisplayMatching: () => ({ workArea: DISPLAY }),
        getPrimaryDisplay: () => ({ workArea: DISPLAY }),
        getAllDisplays: () => [{ workArea: DISPLAY }],
        on: () => {}
      }
    };
  }
  return origRequire.apply(this, arguments);
};

fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  motion: { enabled: true, edgeSnap: true, wander: true, wanderIdleMin: 3 }
}), 'utf8');

const motion = require(path.join(ROOT, 'src/main/motion.js'));

async function main() {
  motion.configureMotion(() => fakeWin);

  console.log('\n═══ A. motion.js：溜达途中被抓住，自动贴边必须一起收手 ═══\n');

  /* 对照组：不打断。证明这个探针真的能看见"到点自动贴边"。 */
  setBoundsCalls = 0;
  winBounds = { x: 10, y: 10, width: 308, height: 342 };
  motion.doWander();
  check(motion.isMoveAnimRunning(), 'doWander 起了平滑移动（对照组）');
  await sleep(1700);
  const autoCalls = setBoundsCalls;
  check(autoCalls > 0,
    '对照组：没人打断时，到点确实会自动贴边写窗口位置（' + autoCalls + ' 次）—— 说明探针有效');
  check(!motion.isMoveAnimRunning(), '对照组：动画已经自己跑完了');

  /* 实验组：溜达刚开始就被"用户抓住"（主进程收到 pet:drag-move 就是这么做的）。 */
  setBoundsCalls = 0;
  winBounds = { x: 10, y: 10, width: 308, height: 342 };
  motion.doWander();
  motion.cancelMoveAnim();          // ← 用户一上手
  const atCancel = setBoundsCalls;
  check(!motion.isMoveAnimRunning(), 'cancelMoveAnim 停掉了平滑移动');

  await sleep(1700);                // 越过 snapGuard 的 1250ms
  check(setBoundsCalls === atCancel,
    '打断后 1700ms 内**一次都没再写窗口位置**（溜达那次自动贴边已被撤掉）');
  if (setBoundsCalls !== atCancel) {
    console.log('       ↳ 多出来的 ' + (setBoundsCalls - atCancel) +
      ' 次就是 snapGuard 漏网、和用户拖拽打架的那几次 setBounds');
  }

  motion.disposeMotion();
}

main().then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  Module.prototype.require = origRequire;
  console.log('\n════════════════════════════════════════');
  if (failures) {
    console.log('❌ ' + failures + ' 项未通过');
    process.exit(1);
  }
  console.log('✅ 全部通过');
  process.exit(0);
});
