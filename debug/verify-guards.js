'use strict';
/* 「悄无声息就坏掉」的几处护栏（源码级断言）。
 *
 * 这里断言的是**「那段难写的代码还在」**，不是「它逻辑对」——
 * 它防的是被人无意改掉 / 抄回老写法。逻辑本身的验证在别处：
 *   · 溜达（走走停停）+ 回位 + 用户打断的时序  → debug/verify-wander.js（真跑）
 *   · 全屏静默的七处收手与恢复                → debug/verify-quiet.js（真跑）
 *
 *   node debug/verify-guards.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (c, m) => (c ? ok(m) : no(m));

const ROOT = path.join(__dirname, '..');

/* ⚠️ 工作区是 CRLF（仓库 .gitattributes 是 `* text=auto`，检出即 CRLF），
 *    所以**一律先归一成 LF 再匹配**。不归一的话任何跨行模式一条都命中不了 ——
 *    2026-10-13 被这个坑掉过一次（tray-dump / verify-rename 双双报"找不到结尾"）。 */
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

/** 从某个签名开始截一段源码，够断言用就行（不追求精确到函数结尾）。 */
function sliceFn(src, sig, span = 1600) {
  const i = src.indexOf(sig);
  return i < 0 ? '' : src.slice(i, i + span);
}

/** 去掉注释，只留真代码 —— 否则"注释里提到过的关键字"会污染计数。
 * ⚠️ 很朴素（不认字符串字面量里的 //），只在确认没有 URL 字面量的文件上用。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const motionSrc = read('src/main/motion.js');
const mainSrc = read('src/main/main.js');

/* ══════════════════ A. 溜达循环的三条硬约束 ══════════════════ */
console.log('\n═══ A. 自主漫步的循环写法没被改回老样子 ═══\n');
{
  /* A1. 自调度 + 代际令牌。
   * 老写法是 `setTimeout(doWander, 分钟*60000)` 一次性排队，看不出问题；
   * 换成"走走停停"的循环之后，一旦有人用 setInterval 排下一步，
   * 两次 push 会重叠 → 两条 setBounds 同时写窗口位置 → 抽搐。 */
  check(/let GEN = 0;/.test(motionSrc), 'motion.js 保留了代际令牌 GEN');
  const genChecks = (motionSrc.match(/gen !== GEN/g) || []).length;
  check(genChecks >= 3,
    `每个 await 前后都查代际（找到 ${genChecks} 处 gen !== GEN，至少要有 3 处）`);
  check(!/setTimeout\(\s*(doWander|wanderLoop)/.test(motionSrc),
    '没有把循环退回成 setTimeout 一次性排队（老写法）');
  const sleepIdx = motionSrc.indexOf('const sleep = (ms)');
  check(sleepIdx > 0, '保留可中断的等待原语 sleep()');

  /* A2. pet:wander-end 必须**无条件**发得出去。
   * 这是真出过事的：老实现把它挂在 animateTo 之外的一个 1250ms 定时器上，
   * 而 animateTo 自己跑完（约 1104ms）会调 cancelMoveAnim() 顺手把那个
   * 定时器清掉 → wander-end 从来没发出去过。以前她溜达时人不动（只挪窗口）
   * 所以看不出来；换成播 Walk 之后就是"溜达完一直原地走"。 */
  const walkTo = sliceFn(motionSrc, 'async function walkTo(');
  check(/pet:wander-start/.test(walkTo) && /pet:wander-end/.test(walkTo),
    'walkTo 里**成对**发 wander-start / wander-end');
  check(/await waitMoveEnd\(gen\)/.test(walkTo),
    'walkTo 是 await 到这一趟结束之后才发 end（不是另排一个定时器）');
  const endSites = (stripComments(motionSrc).match(/pet:wander-end/g) || []).length;
  check(endSites === 1,
    `全文件只有一处真代码在发 wander-end（找到 ${endSites} 处）—— 分散到多个定时器就又会漏`);
  check(!/snapGuard/.test(motionSrc),
    '老的 snapGuard 写法没有回流（它是上面那个漏发的根因）');

  /* A3. 用户一上手必须**整体**收手（当前这趟 + 循环），不能只停动画。
   * 甩抛接入后 onUserDragMove 改成内联 GEN++/mode=idle/cancelMoveAnim
   * （不能走 cancelAutoMotion —— 那条会清 throwSamples，估不出初速）。
   * 两种写法等价，只要 ++GEN 且退出溜达态就算过。 */
  const dragMove = sliceFn(motionSrc, 'function onUserDragMove(');
  const dragStopsLoop = /cancelAutoMotion\(\)/.test(dragMove) ||
    (/GEN\+\+/.test(dragMove) && /mode = 'idle'/.test(dragMove) && /cancelMoveAnim\(\)/.test(dragMove));
  check(dragStopsLoop,
    'onUserDragMove 会停溜达循环（cancelAutoMotion 或内联 GEN++/idle/cancelMoveAnim）');
  const cam = sliceFn(motionSrc, 'function cancelAutoMotion(');
  check(/GEN\+\+/.test(cam) && /mode = 'idle'/.test(cam),
    'cancelAutoMotion 同时 ++GEN 并退出溜达态（否则循环会接着排下一步）');
}

/* ══════════════════ B. 自动移动不许污染「家」 ══════════════════ */
console.log('\n═══ B. 溜达 / 回位不许把「家」写进配置 ═══\n');
{
  /* 用户在 2026-10-13 定了「初始位置 = 启动时的位置」。而启动位置是从配置的
   * window.x/y 读的 —— 如果溜达期间也把它落盘，那"家"每轮都往下一次溜达到的
   * 随机点漂，几轮之后她就换地方住了，而且用户完全看不出原因。 */
  const movedHandler = sliceFn(mainSrc, "mainWindow.on('moved'", 900);
  check(/isMoveAnimRunning\(\)/.test(movedHandler),
    "main.js 的 moved 处理器里判了 isMoveAnimRunning()（自动移动期间不落盘）");
  const dragEnd = sliceFn(mainSrc, "ipcMain.on('pet:drag-end'", 900);
  check(/onUserDragEnd\(\)/.test(dragEnd) && /saveConfig\(/.test(dragEnd),
    'pet:drag-end 走 onUserDragEnd + 补一次位置落盘（贴边后的最终坐标）');
  check(/setHome\(/.test(mainSrc), 'main.js 会 setHome（启动 / 回右下角 / 换屏三处）');
}

/* ══════════════════ C. 春已经真的走干净 ══════════════════ */
console.log('\n═══ C. 春已经真的走干净（删一个模型最容易留半截）═══\n');
{
  /* 2026-10-13 用户『春去掉』。删模型最容易出的错是"改一半"：菜单没了、
   * 配置键没了，但某个分支还在比那个名字，或者素材还留在 src/ 里跟着进安装包。
   * 下面按文件逐个扫，比人眼可靠。 */
  for (const f of [
    'src/renderer/pet.js',
    'src/renderer/params.js',
    'src/main/main.js',
    'src/main/config.js',
    'tools/prepare-stage.js',
    'debug/acceptance.js'
  ]) {
    check(!/haru/i.test(read(f)), `${f} 里没有 haru 残留`);
  }
  const petSrc = read('src/renderer/pet.js');
  check(!/mountTarget/.test(petSrc),
    '换模型的单飞守卫（mountTarget）已随多模型一起删掉');
  check(!/\bMAP\b/.test(petSrc.replace(/见 MAP|（见 MAP）/g, '')),
    '没人读的 MAP 变量已经清掉（不会又长回来）');
  check(!fs.existsSync(path.join(ROOT, 'src/assets/models/haru')),
    'src/assets/models/haru 已经从仓库目录移走（素材不该继续进安装包）');
}

/* ══════════════════ D. 自制动作的接线 ══════════════════ */
console.log('\n═══ D. 自制动作（Drag / Walk）的接线还在 ═══\n');
{
  /* 这两个动作是 2026-10-13 手写的（tools/make-motions.js），专门解决
   * 「拖拽 / 溜达没有动作」。鼠标交互那条路容易在重构里被顺手改回去。 */
  const petSrc = read('src/renderer/pet.js');
  const pubSrc = read('src/renderer/profiles/hiyori.js');
  check(/keepLoopGroups: \['Drag', 'Walk'\]/.test(pubSrc),
    '档案（profiles/hiyori.js）里 Drag / Walk 仍标着"保持循环"（不 loop 的话动作播一次就停）');
  check(/fadeOverride: \{ Drag:/.test(pubSrc), 'Drag 的淡化覆盖还在');
  check(/playEventMotion\('Drag'\)/.test(petSrc), '拖拽仍走 playEventMotion(Drag)');
  check(/on\?\.\('pet:wander-start'[\s\S]{0,120}playEventMotion\('Walk'\)/.test(petSrc),
    '溜达开始时仍走 playEventMotion(Walk)');
  check(/stopEventMotions\(\)/.test(petSrc), '停手那条路（stopEventMotions）还在');
  check(!/model\?\.motion\?\.\('TapBody'\)[\s\S]{0,80}dragReacted/.test(petSrc),
    '拖拽没有退回成"播 TapBody"（那是"被戳一下"，不是"被拎起来"）');
}

console.log('');
console.log(failures === 0
  ? '✅ verify-guards 全绿'
  : `❌ verify-guards 有 ${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
