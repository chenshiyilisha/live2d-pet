import * as PIXI from 'pixi.js';
import { Live2DModel, MotionPriority } from '@naari3/pixi-live2d-display/cubism5';

/* 模型表 / 参数表 / 情绪姿态表 —— 全是只读的真相，见 params.js。
 * ⚠️ P 是 ESM 的 live binding：这里只能**读** P.XXX，不能赋值。 */
import {
  MODELS, MODEL_NAME, INK_TOP_C_RATIO, P, State, EMOTION,
  EMO_SPEED, EMO_SPEED_DEFAULT, PAT, buildEmoTarget
} from './params.js';
import { configureTTS, initTTS, speak, enqueueSpeech, takeSentences, stopSpeak, ttsVoiceInfo, ttsQueueState, setSpeechObserver, lipEnv } from './tts.js';
import { abortRecording, configureRecorder } from './recorder.js';
import { rollFactors } from './jitter.js';

// 渲染进程崩溃时默认什么线索都拿不到，先把未捕获异常转发出来
window.addEventListener('error', (e) => {
  console.error('[uncaught]', e.message, '|', e.filename, ':', e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandled]', e.reason?.message || String(e.reason));
});

// 插件内部要靠全局 PIXI 才能拿到 Ticker 自动更新模型
window.PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

console.log('[pet] modules loaded');

/* 当前生效的模型名（初值来自 params.js 的 MODEL_NAME）。
 * 是**可变状态**、且只有本文件写，所以不搬去 params.js ——
 * ESM 的 import 绑定是只读的，跨模块赋值不成立。
 *
 * ⚠️ 这里曾经还有一个"单飞守卫"（记下最近一次请求挂载的模型，加载完比对，
 *    不一致就把刚拿到的资源丢掉）。春移除后模型固定、mountModel 只在 boot
 *    里调一次，守卫再没有能触发的路径 —— 连同它的源码级断言一起删了，
 *    别让它烂在这儿冒充保护。 */
let curModelName = MODEL_NAME;

/* ============================================================
 *  DOM
 * ========================================================== */

const canvas = document.getElementById('canvas');
const stageEl = document.getElementById('stage');
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
/* 「心里想的」那一行。和 bubbleText 分开：它不进 replyBuffer、不朗读、不进历史，
 * 只在气泡里显示成一行灰色小字（回退布局用；浮窗布局在 bubble.html 里同款）。 */
const bubbleThink = document.getElementById('bubble-think');
const composer = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');

/* ============================================================
 *  运行时状态
 * ========================================================== */

let app = null;
let model = null;
// 承载模型的外层容器（见 boot 里的说明）
let holder = null;
let state = State.IDLE;

// 鼠标穿透：true = 整窗穿透（光标不在角色上）
let ignoringMouse = true;
// 拖拽
let dragging = false;
let dragMoved = false;
let lastScreenX = 0;
let lastScreenY = 0;
// 按下的位置（窗口坐标）—— 松手时用来判断"点到的是头还是身子"
let downX = 0;
let downY = 0;
// 本轮拖动是否已经给过挣扎反馈（一次拖动只反馈一次）
let dragReacted = false;
// 连戳计数：900ms 内的连续点击算一串
let clickStreak = 0;
let lastClickAt = 0;
// 提醒气泡的自动隐藏计时器
let remindHideTimer = null;
// 光标位置（相对窗口左上角，单位 CSS px；**可以是负数或超出窗口**），用于视线跟随。
// 由窗口内 mousemove + 主进程 30fps 轮询两条来源共同更新，见 updatePointer()。
let pointer = null;
// 对话
const history = [];
let replyBuffer = '';
let gotFirstChunk = false;
let busy = false;
/* 朗读的**分句缓冲**（边收边念，见下面 feedSpeech）。
 * ⚠️ 和 replyBuffer 是两笔账，别合并：
 *   · replyBuffer 给气泡和历史，收尾时要 `replace(/\s+$/, '')`；
 *   · speechBuf 是"还没念出口的字"，够一句就被切走，念完即空。
 *   合并的话，尾巴上的空行会被念一遍、而切走的句子又会从气泡里消失。 */
let speechBuf = '';
// 口型
let mouthPhase = 0;
let mouthLevel = 0;
// 说话时视线游移的相位（累积秒数，见 updateGaze 的 SPEAKING 分支）
let speakPhase = 0;

// 情绪
let emotion = 'calm';
let emoTarget = { ...EMOTION.calm };
let emoCur = { ...EMOTION.calm };
/* 本帧的**有效目标** = emoTarget + 摸头调制。每帧由 buildEmoTarget()
 * 重填（复用同一个对象，不分配），插值循环逼近的是它而不是 emoTarget。
 * 没摸头（patAmt === 0）时是逐字段等值拷贝 —— 与改动前逐位一致。 */
const emoEff = { ...EMOTION.calm };

/* 本套情绪过渡的**速度抖动因子**（键同 EMO_SPEED，值 ≈1±JITTER_RATIO）。
 *
 * 每次 setEmotion 重抽一整套（见 jitter.js 的说明：过渡期间必须固定，
 * 每帧重抽就是噪声）。开关 `appearance.jitter` 关掉时置 null ——
 * 主循环读到 null 就乘 1，行为与加这个功能之前**逐位一致**。 */
let emoJitter = rollFactors(Object.keys(EMOTION.calm));

/* ── 摸头（按住 = 一直蹭）的状态机。见 params.js 的 PAT 段说明。
 * 规矩 7：异步等待的状态一律用状态机，不用一堆 bool。
 *   idle ──按下(在头顶)──▶ rising ──amt到1──▶ holding ──松手──▶ falling ──amt到0──▶ idle
 *                                     └───── 松手（rising 期间）──────┘
 *   holding 里按时间依次触发：shyMs 害羞 → nagMs 抗议 → escapeMs **自己挣脱**
 *   （挣脱也走 falling，且置 patEscaped 让随后那次 mouseup 不算点击）。
 * 规矩 6/26：被拖拽、被静默抢占时走 patAbort()（立刻归零，不走回落）——
 * 因为紧接着就有别的动作接管，慢慢回落会和它叠在一起。 */
let patState = 'idle';    // idle | rising | holding | falling
let patAmt = 0;           // 调制强度 0~1
let patPhase = 0;         // B 段摆动相位（弧度，按 PAT.wiggleHz 累积）
let patMs = 0;            // 本次摸头已持续毫秒（只在 rising/holding 里累加）
let patReleased = false;  // rising 期间就松手了 —— 等它升完再回落，别半途砍断
let patNagged = false;    // 这次已经抗议过了（只抗议一次）
let patShy = false;       // 这次已经转过 shy（只转一次）
let patEscaped = false;   // 她已经自己挣脱过 —— 随后那次鼠标松开不算点击
// 上一帧往各参数里叠加的增量。每帧先把上一帧的增量减掉再写新的，
// 否则叠加会一层层累积下去（尤其是被 focus()/motion 也在写的头部角度）。
const emoApplied = {};

// 配置（TTS / 主动搭话的开关都在里面）
let cfg = null;
// 有没有配 API Key。config:get 会把 key 遮成 '***'，非空即说明配了
let hasApiKey = false;
// 主动搭话计时器
let idleTimer = null;
let lastActivityPoke = 0;

/* ============================================================
 *  工具
 * ========================================================== */

let statusTimer = null;
function showStatus(msg) {
  statusEl.textContent = msg;
  statusEl.classList.add('show');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove('show'), 6000);
}

function setIgnoreMouse(ignore) {
  if (ignoringMouse === ignore) return;
  ignoringMouse = ignore;
  window.pet?.setIgnoreMouse(ignore);
}

function setParam(id, value) {
  if (!id) return;              // PARAM 表里没定义的键（占位，见 params.js）
  try {
    model?.internalModel?.coreModel?.setParameterValueById(id, value);
  } catch { /* 模型未就绪时忽略 */ }
}

function readParam(id) {
  if (!id) return undefined;
  try {
    return model?.internalModel?.coreModel?.getParameterValueById(id);
  } catch {
    return undefined;
  }
}

/* 播 / 停一个**事件驱动**的动作组（目前只有 Drag / Walk，都是本项目自制的，
 * 见 tools/make-motions.js）。
 *
 * ⚠️ 别拿它播 Idle —— 待机是插件的内建调度（见 setState 附近那段说明），
 *    手动播 Idle 用 NORMAL 优先级会抢断正在播的待机动作，把平滑交叉淡化
 *    打成一次硬切。Drag / Walk 要的恰恰是「抢断」：抓住她 / 开始溜达的
 *    那一刻必须立刻切过去，所以用 FORCE。
 *
 * 停止必须显式调 stopAllMotions()：这俩是 Loop:true 的持续动作，永远不
 * finish，不停它就永远交不回给 idle 调度（画面会一直定格在挣扎/走路）。 */
function playEventMotion(group) {
  try { model?.motion?.(group, undefined, MotionPriority.FORCE); }
  catch { /* 模型没这个组就算了 */ }
}

function stopEventMotions() {
  try { model?.internalModel?.motionManager?.stopAllMotions?.(); }
  catch { /* ignore */ }
}

/* 切情绪。目标变了之后由 ticker 逐帧插值过去，不会硬切。 */
function setEmotion(name) {
  if (!EMOTION[name] || name === emotion) return;
  emotion = name;
  emoTarget = EMOTION[name];
  /* 重抽这一趟的节奏抖动（就为这一件事：同一句情绪两次进入别长得一模一样）。
   * ⚠️ 必须先判开关再抽 —— 关掉时也要走"不抽"的分支，否则**随机数序列
   *    会被白白推进**，开关来回切一次就换了一套抖动（不可复现）。 */
  emoJitter = cfg?.appearance?.jitter === false
    ? null
    : rollFactors(Object.keys(emoTarget));
}

/* ============================================================
 *  摸头（按住 = 一直蹭）—— A-B-C 三段式
 *
 *  设计说明在 params.js 的 PAT 段（为什么不是播三段动画、为什么做在
 *  情绪目标上）。这里只有状态机和接线。
 *
 *  原来的行为是：`mousedown` 什么都不播，`mouseup` 才播一次 TapBody
 *  ——手感是"点一下弹一下"，**按住期间完全没反应**。现在：在头顶按下
 *  就起手，按住多久就蹭多久，松手才收尾。
 * ========================================================== */

/* ── 实量头顶 y ──────────────────────────────────────────────
 * 「头顶在哪」不能用 petRect.y：那是解析推算的**松边界**（穿透预筛、
 * 宽度估算用），而取景特意在头顶上方留了一大段呼吸空间放气泡 ——
 * 实测窗口 342 高时真头顶在 y≈137，petRect.y 按公式算出来只有 14
 * （bubble.js 的 measureHead 量到过同一个数）。拿它当「上 30%」的锚，
 * 整条带都落在她头顶上方的空地里，永远起不了手（2026-10-14 实测踩过）。
 *
 * 量法：模型画完之后沿**身体中心那一竖条** readPixels，从上往下找
 * 第一行「不透明像素够数」的行 —— 与 bubble.js 的 measureHead 同一思想，
 * 但必须在这里做：mousedown 起手要**同步**判，走不了 IPC 往返。
 * 只扫一竖条还有个好处：底座牌（DOM，画不进 canvas）不干扰（规矩 23），
 * 而且一次 readPixels 就够，不用逐行读。
 *
 * 时机：layout() 之后隔几帧再量（那时新几何才真的画出来）。
 * 呼吸 / 眨眼只让头顶上下浮动几 px，条带本身有几十 px 容差，不必追帧；
 * 量不到（模型还没画出第一帧 / 上下文丢了）就保留旧值，不往 0 写。 */
let headTopY = 0;              // 实量头顶（窗口 CSS px）。0 = 还没量到
let headMeasureTimer = 0;
let headMeasureTries = 0;
let headColBuf = null;

function scheduleHeadMeasure() {
  if (headMeasureTimer) return;
  headMeasureTimer = setTimeout(() => {
    headMeasureTimer = 0;
    measureHeadTop();
  }, 150);                      // ≈9 帧：等 layout() 的新几何真的渲染出来
}

/* 布局变化时调：重试计数清零，重新排一次量。 */
function queueHeadMeasure() {
  headMeasureTries = 0;
  scheduleHeadMeasure();
}

function measureHeadTop() {
  if (!hitGl || hitGl.isContextLost?.() || !model || !petRect.w) return;
  const res = app.renderer.resolution || 1;
  const bh = hitGl.drawingBufferHeight;
  const bw = hitGl.drawingBufferWidth;
  if (!bh || !bw) return;
  /* 条带：身体中心左右各 20 CSS px（呆毛偏细，太窄容易从它和头之间漏过去） */
  const cx = Math.round((petRect.x + petRect.w / 2 - CANVAS_OFF.x) * res);
  const hw = Math.round(20 * res);
  const x0 = Math.max(0, cx - hw);
  const w = Math.min(bw, cx + hw) - x0;
  if (w <= 0) return;
  const need = w * bh * 4;
  if (!headColBuf || headColBuf.length < need) headColBuf = new Uint8Array(need);

  let prev = null;
  try {
    prev = hitGl.getParameter(hitGl.FRAMEBUFFER_BINDING);
    if (prev) hitGl.bindFramebuffer(hitGl.FRAMEBUFFER, null);
    hitGl.readPixels(x0, 0, w, bh, hitGl.RGBA, hitGl.UNSIGNED_BYTE, headColBuf);
  } catch { return; }
  finally {
    try { if (prev) hitGl.bindFramebuffer(hitGl.FRAMEBUFFER, prev); } catch { /* ignore */ }
  }

  /* 从上往下（缓冲区行号 = bh-1-r）找第一行不透明像素够数的。
   * 阈值与抽样步长跟 bubble.js 的 measureHead 一致（>40、隔 2px、≥4 个）。 */
  for (let r = 0; r < bh; r++) {
    const row = (bh - 1 - r) * w * 4;
    let cnt = 0;
    for (let i = 3; i < w * 4; i += 8) {       // 隔 2 像素取一个 alpha
      if (headColBuf[row + i] > 40 && ++cnt >= 4) {
        headTopY = CANVAS_OFF.y + r / res;     // 缓冲行号 → 窗口 CSS y
        return;
      }
    }
  }
  /* 没量到：多半是模型还没画出第一帧。自动重试几次，超过就放弃
   * （等下一次布局变化再量），别无限空转。 */
  if (headTopY <= 0 && ++headMeasureTries < 20) scheduleHeadMeasure();
}

/* 头顶那片 = 落在她身上、且在**实量头顶**之下的那一段。
 * ⚠️ 必须能在**按下时**就判出来 —— 这段判定原来写在 onPetClicked() 里，
 *    而那是松手才跑的，按住期间根本无从判断。
 *    isOverPet() 是同步的（读 GL 帧缓冲、带缓存），按下时调一次可以接受。 */
function isHeadPatTarget(x, y) {
  if (cfg?.interaction?.headPat === false) return false;
  if (headTopY <= 0) return false;   // 还没量到：宁可不认，别在空气里起手
  if (!isOverPet(x, y)) return false;
  return y <= headTopY + headBandH();
}

/* 条带高度 =（窗口底 − 实量头顶）的三成。日和半身像的头+发约占可见
 * 高度的四分之一，三成略宽松、好摸；锚在实量值上，窗口/缩放变了自己跟着走。 */
function headBandH() {
  const H = stageEl?.clientHeight || 0;
  return Math.max(0, (H - headTopY) * 0.30);
}

/* A 段 · 起手：patAmt 0→1（快），再叠上错峰插值本身的爬升。 */
function patStart() {
  patState = 'rising';
  patAmt = 0;
  patPhase = 0;
  patMs = 0;
  patReleased = false;
  patNagged = false;
  patShy = false;
  patEscaped = false;
  window.pet?.activity?.();   // 手放上来了就算"有活动"：别在这时候溜达走
  setEmotion('happy');
}

/* C 段 · 收尾：patAmt 1→0（慢）。
 * ⚠️ rising 期间松手**不打断起手** —— 等它升到 1 再回落。在半途砍断，
 *    观感是"手刚放上去她就弹回来"，很假。 */
function patRelease() {
  if (patState === 'idle') return;
  patReleased = true;
  if (patState === 'holding') patState = 'falling';
  /* 没闹脾气的当场回落；闹了脾气的保持 shy 把气生完（falling 结束才 calm） */
  if (!patNagged) setEmotion('calm');
}

/* 抢占（被拖拽 / 进水静默）：立刻归零，**不走回落** ——
 * 紧接着就有别的动作接管，慢慢回落会和它叠在一起。 */
function patAbort() {
  patState = 'idle';
  patAmt = 0;
  patPhase = 0;
  patMs = 0;
  patReleased = false;
  patNagged = false;
  patShy = false;
  patEscaped = false;
}

/* 每帧推进。⚠️ 必须在 buildEmoTarget() 之前调（它要用 patAmt/patPhase）。 */
function updatePat(dt) {
  if (patState === 'idle') return;
  patPhase += dt * 2 * Math.PI * PAT.wiggleHz;

  if (patState === 'rising') {
    patMs += dt * 1000;
    patAmt = Math.min(1, patAmt + dt * PAT.rise);
    if (patAmt >= 1) patState = patReleased ? 'falling' : 'holding';
    return;
  }

  if (patState === 'holding') {
    patMs += dt * 1000;
    /* 害羞和抗议都发生在**按住的过程中**，不是等松手才反应 ——
     * 你一直按着不放，她中途就开始不自在。 */
    if (!patShy && patMs >= PAT.shyMs) { patShy = true; setEmotion('shy'); }
    if (!patNagged && patMs >= PAT.nagMs) {
      patNagged = true;
      say('别摸啦，头发要乱了。');
    }
    /* 抗议过还不撒手 → 她自己挣脱（走 C 段回落，不理会手还在不在）。
     * ⚠️ 置 patEscaped 是为了让随后那一次 mouseup **不算点击** ——
     *    否则她挣脱完、用户松手，会被当成"戳了一下"再播一次 TapBody。 */
    if (!patEscaped && patMs >= PAT.escapeMs) {
      patEscaped = true;
      say('……不理你了。');
      patRelease();
    }
    return;
  }

  // falling
  patAmt -= dt * PAT.fall;
  if (patAmt <= 0) {
    patAmt = 0;
    patState = 'idle';
    setEmotion('calm');        // 闹脾气的到这儿也把气生完了
  }
}

/* 连点计数（900ms 之内的算"连着点"）。摸头那一类和"戳"那一类都要用，
 * 所以收成一个函数 —— 免得两条路各写一份、日后只改一边。 */
function bumpClickStreak() {
  const now = Date.now();
  clickStreak = (now - lastClickAt < 900) ? clickStreak + 1 : 1;
  lastClickAt = now;
  return clickStreak;
}

/* 把当前情绪姿态写进模型。
 *
 * 这里用「先撤销上一帧增量、再写新值」的写法，而不是直接覆盖：
 * ParamAngleY 这类参数 focus() 每帧也在写，直接覆盖会把视线跟随压掉；
 * 而如果某个参数根本没别人写，直接写又会在帧间一层层累积。
 * 撤销法对这两种情况都成立 —— 但它**只在调用顺序正确时**才成立：
 * 必须在 updateGaze() 之后调（见主循环里那段说明）。
 *
 * ⚠️ 每个字段都要有对应的一行 put。EMOTION 表里加了字段、这里忘了写，
 *    表现是"怎么调都不生效"而且完全不报错（verify-expressive.js 有断言）。 */
function applyEmotion() {
  const put = (id, v) => {
    if (v === undefined) return;
    const prev = emoApplied[id] || 0;
    setParam(id, (readParam(id) ?? 0) - prev + v);
    emoApplied[id] = v;
  };

  // 眉 —— 左右分开写。这是"像人"和"像图"的分界：真实的表情从不完全对称
  put(P.BROW_L_Y, emoCur.browLY);
  put(P.BROW_R_Y, emoCur.browRY);
  put(P.BROW_L_X, emoCur.browLX);
  put(P.BROW_R_X, emoCur.browRX);
  put(P.BROW_L_ANGLE, emoCur.browAngle);
  put(P.BROW_R_ANGLE, emoCur.browAngle);
  put(P.BROW_L_FORM, emoCur.browForm);
  put(P.BROW_R_FORM, emoCur.browForm);
  // 眼 / 嘴 / 脸红 / 肩
  put(P.MOUTH_FORM, emoCur.mouthForm);
  put(P.EYE_L_SMILE, emoCur.eyeSmile);
  put(P.EYE_R_SMILE, emoCur.eyeSmile);
  put(P.CHEEK, emoCur.cheek);
  put(P.SHOULDER, emoCur.shoulder);
  put(P.EYE_L, emoCur.eyeOpen);
  put(P.EYE_R, emoCur.eyeOpen);
  // 头（歪 / 点）—— 会和 focus() 抢 ANGLE_Y/_Z，靠顺序共存，别提前
  put(P.ANGLE_Z, emoCur.headZ);
  put(P.ANGLE_Y, emoCur.headY);
  // 呆毛（纯自由参数）+ 身体（物理输入 → 顺带带动头发/裙摆/缎带）
  put(P.AHOGE, emoCur.ahoge);
  put(P.BODY_Y, emoCur.bodyY);
  put(P.BODY_Z, emoCur.bodyZ);
}

/* 视线 / 头部朝向。
 *
 * 四种状态各有各的「眼神」：
 *   IDLE               —— 跟着光标跑（桌宠最基本的"她注意到你了"）
 *   LISTENING/THINKING —— 看向正前方（用户在说话 / 她在想怎么说）
 *   SPEAKING           —— 小幅游移。**原来这里根本没有这一支**，
 *                         一开口眼珠就死盯一个方向冻住 —— 是"活"和"僵"
 *                         之间最明显的一道线（2026-10-13 补上）。
 *
 * pointer 为 null（光标不在窗口内 / 还没收到第一帧）时**什么都不做**，
 * 让情绪自己的歪头点头完整生效，而不是被一句"看向正前方"抹平。 */
function updateGaze(dt) {
  if (!pointer) return;
  const w = app.screen.width;
  const h = app.screen.height;

  if (state === State.IDLE) {
    /* 光标和人物在同一套窗口坐标里，直接喂原始坐标 —— 人物恒居中，
     * 窗口中心就是"正前方"，相对位置自动是对的，不用自己减中心。 */
    model.focus(pointer.x, pointer.y, { instant: false });
  } else if (state === State.LISTENING || state === State.THINKING) {
    model.focus(w / 2, h * 0.35, { instant: false });
  } else if (state === State.SPEAKING) {
    /* 两条**互不成整数倍**的低频正弦叠加。
     * 单条正弦的周期感很重，一看就是"程序在摆"；两个不相关的频率叠起来
     * 才像无意识的视线游移。幅度压得很小 —— 要的是"边说边想"，
     * 不是"边说边摇头"。 */
    speakPhase += dt;
    const gx = w / 2 + Math.sin(speakPhase * 0.83) * 22 + Math.sin(speakPhase * 0.31) * 11;
    const gy = h * 0.35 + Math.sin(speakPhase * 0.57 + 1.7) * 12;
    model.focus(gx, gy, { instant: false });
  }
}

/* ============================================================
 *  语音朗读（实现在 tts.js）
 *
 *  依赖注入见下面 boot() 里的 configureTTS() —— cfg / state / busy
 *  全在变，只能给 getter，不能传值快照。
 * ========================================================== */

/* ============================================================
 *  状态机
 * ========================================================== */

function setState(next) {
  if (state === next) return;
  state = next;

  // 状态自带的表情。SPEAKING 不在这里定 —— 那个由模型回复里的
  // [emo:xxx] 标签决定，说话时脸上的表情应该跟着内容走。
  if (next === State.THINKING) setEmotion('think');
  if (next === State.LISTENING) setEmotion('calm');
  if (next === State.SLEEP) setEmotion('sleepy');
}

// ⚠️ 这里**不要**手动去播 idle 动作。
//
//   pixi-live2d-display 的 MotionManager.update() 每帧都会检查：
//       if (isFinished() && state.shouldRequestIdleMotion())
//           startRandomMotion(groups.idle, MotionPriority.IDLE)
//   也就是说「动作播完了自动挑一个 idle 接着播」是插件内建行为，而且带
//   0.5s 交叉淡化，本来就平滑。
//
//   手动干预只会帮倒忙，这是「动作切换时卡一下」的真正原因：
//     - model.motion('Idle') 的默认优先级是 NORMAL，会**抢断**插件正在播的
//       IDLE 动作，把平滑交叉淡化打成一次硬切。
//     - 而且 `await model.motion('Idle')` 是陷阱：Hiyori 的 idle 全是
//       Loop:true，这种动作返回的 MotionPromise 永远不 resolve，await 永久挂住。
//   所以这里彻底交给插件自己调度，一行都不写。

/* ============================================================
 *  初始化
 * ========================================================== */

/* ============================================================
 *  加载 / 切换模型
 * ==========================================================
 *
 * boot() 里调一次（名字与入参保留 —— name 是 MODELS 表的查表键）。
 * 里面包含四件事：
 *   1) 加载 model3.json + 建 holder 容器
 *   2) 取景（layout）
 *   3) 动作播放参数规整（关循环 / 钉死淡化时长）
 *   4) pose 部件淡化收紧 + 手臂参数残值释放
 *
 * ⚠️ 第 3、4 步是**贴着这份素材的实测特性**写的（见各段注释）——
 *    真换一套素材时必须重新核对，不能照抄。
 */

/* ---- 纹理 LOD：屏幕用不完的分辨率就别占显存 ----
 *
 * 实测（2026-10-14，窗口 308×342 / DPR 1.5）：人物墨迹在屏幕上只有约
 * 120 CSS px 宽（180 物理px，见 debug/pet-window.png 的像素包围盒），而
 * hiyori 的两张纹理都是 2048×2048 RGBA —— 一张 16MB，两张 32MB 显存。
 * 折算 1 个纹素只落到约 0.06 屏幕像素，**过采样 17 倍**：这些显存买的
 * 是屏幕根本显示不出来的细节。
 *
 * 做法：模型挂载后把每张纹理按 2^level 缩小，换掉 TextureSource 的
 * resource。UV 是模型定义的，纹素变疏只影响清晰度、不会让画面错位。
 * level 由「人物屏幕宽 × DPR × margin」反推，封顶 maxLevel：
 *   · 1024 档在本机 DPR 1.5 下仍剩约 1.9 倍过采样，肉眼不可辨；
 *   · 再往下（512）开始临界，不值得为 8MB 冒变糊的险 —— 所以 maxLevel=1。
 *
 * ⚠️ 介入点必须在**首次渲染之前**（mountModel 里 layout() 刚跑完）：
 *    pixi 的纹素到首次 draw 才上传 GPU，之前换 resource 一分钱不花；
 *    渲染过再换就要先传大的再换小的，白烧一轮带宽。
 * ⚠️ 只换 resource + update()（resize 会刷新 _resourceId 触发重传），
 *    采样样式（scaleMode / addressMode / alphaMode）都在原 source 上，
 *    一个都不用手抄 —— 另建 TextureSource 漏抄一个就是渲染异常。
 * ⚠️ 屏幕宽用放宽的 INK_W（比真实墨迹大四成，穿透判定故意取的松值）——
 *    在这里方向正好是"少降"，偏保守。
 * ⚠️ 只在挂载时算一次：用户后来放大（≤1.4×）由 margin=2 覆盖；真要
 *    跟随缩放动态升降就得在 layout 里反复重采样，复杂度不值当。
 */
const TEX_LOD = { maxLevel: 1, margin: 2 };

function applyTextureLod(m) {
  if (cfg?.appearance?.textureLod === false) return;
  const textures = m?.textures;
  if (!Array.isArray(textures) || !textures.length) return;
  const s = holder?.scale?.x || 0;
  if (!s) return;
  const onScreenPx = INK_W * s * (window.devicePixelRatio || 1) * TEX_LOD.margin;
  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const src = tex?.source;
    const w = src?.resourceWidth || 0;
    const h = src?.resourceHeight || 0;
    if (!w || !h || !src.resource) continue;
    const level = Math.max(0, Math.min(
      TEX_LOD.maxLevel,
      Math.floor(Math.log2(w / Math.max(1, onScreenPx)))
    ));
    if (level <= 0) continue;
    const nw = w >> level;
    const nh = h >> level;
    /* ImageBitmap / Image 都能 drawImage；canvas 2d 存非预乘像素，
     * 上传时仍按 source.alphaMode 走 —— 与原来的 ImageBitmap 一致。
     * （webgl 的 texImage2D 本来就同时吃 canvas / ImageBitmap。） */
    const cv = document.createElement('canvas');
    cv.width = nw;
    cv.height = nh;
    cv.getContext('2d').drawImage(src.resource, 0, 0, nw, nh);
    src.resource = cv;
    src.update();
    console.log('[pet] textureLod', JSON.stringify({ i, from: [w, h], to: [nw, nh], level }));
  }
}

async function mountModel(name) {
  const def = MODELS[name] || MODELS.hiyori;

  /* 切模型会重挂整套渲染资源（AudioContext / 纹理 / 画布），
   * 先把正在进行的录音作废 —— 否则麦克风会一直开着，而且录到的样本
   * 会跨在新旧两个模型之间。 */
  abortRecording();

  /* ---- 1) 先把新模型加载好，**再**拆旧的 ----
   * boot 时 model / holder 都还是 null，下面"拆旧的"那几行其实是空转。
   * 这个顺序不改成"先拆后建"，是为了保住当初踩出来的两条结论（真加第二套
   * 素材时它们立刻又成立）：旧的拆早了会有几百毫秒空屏；那段窗口里
   * model 是 null，常驻 ticker 会踩空
   * `Cannot read properties of null (reading 'focus')`。 */
  const next = await Live2DModel.from(def.url, {
    autoInteract: false,
    // 插件的默认策略只预加载 idle 那一组，TapBody 要等第一次点击才去 fetch
    // 动作文件 —— 表现就是「点一下先僵住半秒才动」。一共才 11 个动作文件，
    // 全部预加载掉，切换就是零延迟的。
    motionPreload: 'ALL'
  });
  next.anchor.set(0, 0);

  /* ---- 2) 拆旧的。Cubism 的 GL 资源不主动释放就会一直挂着
   *         （这套画布 2976x4175，纹理不小）—— boot 时为空转，
   *         真加第二套素材时这就是热换的那条路。 ---- */
  const prevModel = model;
  if (holder) {
    try { app.stage.removeChild(holder); } catch { /* ignore */ }
    /* destroy({children:true}) **已经**把 holder 底下的 model 一并销毁了
     * （pixi 递归 destroy 子节点，Live2DModel 的 destroy 会释放 internalModel
     * 和 GL 纹理）。所以原来后面那次 prevModel.destroy() 是重复销毁：
     * 对一个已经 destroyed 的对象再 destroy，会去碰已经被释放的字段，
     * 异常又被空 catch 吞掉 —— 表现就是偶发的纹理告警，很难查。
     * 用 destroyed 标志挡掉重复的那次，同时保留「model 万没挂在 holder 上」
     * 的兜底（那样 destroyed 仍是 false，会正常走到 destroy）。 */
    try { holder.destroy({ children: true }); } catch { /* ignore */ }
    holder = null;
  }
  if (prevModel && !prevModel.destroyed) {
    try { prevModel.destroy?.(); } catch { /* ignore */ }
  }
  model = null;

  /* ---- 3) 换全局：取景几何与参数表都按新模型刷一遍 ---- */
  applyModelGeometry(name);
  // 取景几何整体换掉了，命中测试的位置缓存必须作废，否则会拿旧坐标读像素
  hitCache = { x: NaN, y: NaN, a: -1, t: 0 };

  model = next;

  /* 取景变换放在外层普通 Container 上。
   * 直接改 Live2DModel 自身的 position 不生效 —— 实测把 model.position.y 上移
   * 200px 后，窗口里的画面一动都不动（像素包围盒只差 2px，那是 idle 动作造成的）。
   * 原因是 Cubism 的绘制用的是 internalModel 自己那套投影，不认 Live2DModel
   * 的 position；但 scale 是认的（内部会按 scale 换算画布尺寸）。
   * 所以这里用一层普通 Container 承载 position/scale，让 pixi 正常合成。 */
  holder = new PIXI.Container();
  holder.addChild(model);
  app.stage.addChild(holder);

  layout();

  applyTextureLod(next);

  /* 运行时规整动作播放参数（**卡顿的真正修复在这里**）
   *
   * 症状：待机动作播到结尾时会「卡一下 / 抽一下」。
   *
   * 排查过程（别重复走）：
   *   1) 先怀疑帧率 —— 实测 60fps、avg 16.7ms、jank 0，排除性能。
   *   2) 再怀疑动作没预加载 —— loaded 显示 Idle 9/9、TapBody 1/1，排除。
   *   3) 把 11 个 motion3.json 全部解析一遍，发现 **每一个动作的 Meta 都是
   *      Loop: true，但所有参数曲线首尾都不闭合**（10 个文件合计 147 条曲线
   *      在 t=Duration 处的值与 t=0 处对不上，最狠的 ParamAngleY 直接从 0
   *      跳到 -30）。
   *
   * 结论：这批素材是「播一次就换下一个」的设计，Meta 里的 Loop 标错了。
   * Cubism 照着 Loop 跑，播到 Duration 就瞬间回绕到开头 → 参数一帧内跳变，
   * 观感就是「动作结束卡一下」。更糟的是回绕会让 motionQueueEntry 永远
   * 不满足 isFinished()，于是插件内建的「播完自动挑下一个待机动作」
   * （MotionManager.update → shouldRequestIdleMotion → startRandomMotion）
   * 永远不触发，模型会被永久钉死在同一个动作上反复抽。
   *
   * 修法：运行时把 Loop 关掉，动作播完正常 finish，后续交给插件自带调度。
   * 插件在 isFinished 那一帧先 startRandomMotion（此时旧 entry 还在队列里，
   * 会先被置上 fadeOut）再 updateParameters，所以切换是交叉淡化、不是硬切。
   *
   * ⚠️ 不能去改模型自带的 motion3.json —— Hiyori 是 Live2D 官方示例模型，
   *    授权条款不允许修改素材（包括设计）。所以只在运行时覆盖这些播放参数。
   *
   * ⚠️ FadeIn/FadeOut 必须保持素材自带的 0.5s，**不要为了「柔和」去拉长**。
   *
   * 原因：Hiyori 的 10 个待机动作分成两族，手臂参数完全不重叠 ——
   *   A 族（m01~m05/m07/m09/m10）只写 ParamArmLA/RA（手臂垂下）
   *   B 族（m06/m08）只写 ParamArmLB/RB + ParamHandLB/RB（手臂抬起）
   * 手臂的最终姿态由 A、B 两个旋转轴共同决定，所以 A↔B 切换时两个轴同时在
   * 插值，中间必然存在一个「手既没放下、也没抬起」的过渡姿态。
   * 淡化窗口越长，这个中间态停留越久、越显眼（观感就是「残影」）。
   * 0.5s 是素材作者调好的值；0.8s 反而放大了这个问题。
   */
  {
    /* ⚠️ 认准 API 名字，别想当然（踩过）：
     *   CubismMotion 上设置淡化时长的方法是 setFadeInTime() / setFadeOutTime()，
     *   单位【秒】。**没有** setFadeIn() / setFadeOut() 这两个方法 ——
     *   setFadeOut() 是 CubismMotionQueueEntry 的方法，跟 motion 不是一回事。
     *   之前这里写的是 motion?.setFadeIn?.(0.5)，可选链把「方法不存在」
     *   静默吞掉，等于一行都没执行，白折腾。
     *
     * 另外：官方动作的淡化时长写在 model3.json 的 definition 里（0.5s，
     *   素材 motion3.json 的 Meta 里没有），插件 createMotion() 会优先用
     *   definition 的值 —— 所以这里只是把值钉死，防止将来换组时被插件的
     *   默认值（idle 组默认 2000ms！）悄悄改掉。
     *   自制的 Drag / Walk 在 definition 里写的是各自的快慢值（Drag 要快，
     *   被抓住得立刻有反应），下面按 FADE_OVERRIDE 再钉一遍。
     */
    const FADE_SECONDS = 0.5;
    /* 组级覆盖，来自 params.js 的 MODELS 表（那是唯一真相，别在这抄一份）。 */
    const FADE_OVERRIDE = def.fadeOverride || {};
    const mm = model.internalModel?.motionManager;
    if (mm) {
      /* 哪些动作组**保持循环播放** —— 白名单：只有列进去的组才 loop。
       *
       * 官方的 11 个动作（Idle 10 + TapBody 1）曲线首尾全都不闭合（Meta 里的
       * Loop:true 是标错的）→ 一律要关：否则播到 Duration 会瞬间回绕，
       * 观感就是「动作结尾卡一下」；更糟的是回绕让 isFinished()
       * 永远不成立，插件内建的 idle 自动调度（MotionManager.update
       * → shouldRequestIdleMotion → startRandomMotion）也就永远不触发。
       *
       * 例外是自己手写的 Drag / Walk（见 tools/make-motions.js）：那两组就是
       * 按「首尾闭合的持续动作」设计的，必须 loop —— 拖拽期间和溜达期间
       * 一直播，松手 / 到点才交给 idle 调度。 */
      const KEEP_LOOP = new Set(def.keepLoopGroups || []);
      const retime = (motion, group) => {
        try {
          const o = (group && FADE_OVERRIDE[group]) || {};
          motion?.setFadeInTime?.(o.in ?? FADE_SECONDS);
          motion?.setFadeOutTime?.(o.out ?? FADE_SECONDS);
          motion?.setLoop?.(!!(group && KEEP_LOOP.has(group)));
        } catch { /* 个别动作不支持就算了 */ }
      };
      // 预加载是异步的，先补一遍已经加载好的，再盯住后续加载完的
      const retimeAll = () => {
        for (const [g, arr] of Object.entries(mm.motionGroups || {})) {
          for (const m of arr) retime(m, g);
        }
      };
      mm.on?.('motionLoaded', (group, _index, motion) => retime(motion, group));
      retimeAll();
      setTimeout(retimeAll, 1500);
    }

    /* ── 手臂 A/B 部件「双影」= 举手放下残影的真正主因 ──────────────
     *
     * Hiyori 的手臂是**两套完整绘制**，靠部件不透明度二选一：
     *   PartArmA = 手臂垂下（m01~m05/m07/m09/m10 用）
     *   PartArmB = 手臂举起（m06/m08 用）
     * 实测素材里这两个值恒为 1/0，两族动作严格互斥（10 个动作 span 全是 0）。
     *
     * 关键在于**它们之间怎么切**：
     *   1) 动作里的 PartOpacity 曲线（值 0/1）确实会写，但 pixi 封装那段
     *      走的是「无权重直接覆盖」→ 切换是**瞬时**的；
     *   2) 真正让透明度平滑过渡的是 **pose 层**：
     *        Hiyori.pose3.json → { "FadeInTime": 0.5,
     *                              "Groups": [[PartArmA, PartArmB]] }
     *      CubismPose.doFade() 每帧做 `opacity += dt / _fadeTimeSeconds`，
     *      也就是**用 0.5 秒**把 PartArmA 从 0 线性拉到 1，同时把 PartArmB
     *      压到互补值（两者之和≈1）。
     *
     *   结果：「举手(m08) → 放下(m01)」时，有整整 0.5 秒两套手臂各半透明，
     *   叠在一起 → 观感就是「手和手之间有一道残影」。
     *
     * ⚠️ 这跟动作自身的 fadeIn/fadeOut 一点关系都没有 —— 残影发生在 pose 层，
     *    所以之前调 motion 的淡化（不管是 0.5 还是 0.8）都不会有任何变化。
     *
     * 修法：把 pose 的 fade 时间收紧到 0.08s（约 5 帧）。
     *   给 0 = 硬切（能看到手臂形状瞬间跳变）；
     *   给 0.5 = 素材原值（双影 0.5 秒，正是用户看到的）。
     *   0.08 是折中：双影短到看不出，又不至于硬跳。
     *   只改运行时实例字段，不动素材文件（Hiyori 官方示例，授权不允许改）。
     */
    {
      const pose = model.internalModel?.pose;
      // ?pf=0 关掉本修复，用来做「修前 / 修后」对照
      const POSE_FADE = new URLSearchParams(location.search).get('pf') === '0' ? null : 0.08;
      if (pose && typeof pose._fadeTimeSeconds === 'number' && POSE_FADE !== null) {
        const before = pose._fadeTimeSeconds;
        pose._fadeTimeSeconds = POSE_FADE;
        console.log('[pet] pose-fade', JSON.stringify({ before, after: pose._fadeTimeSeconds }));
      } else {
        console.warn('[pet] pose-fade 未生效（?pf=0 或 internalModel.pose 不可用）');
      }
    }
  }

  /* ── 手臂参数「残值释放」：修「举手放下留残影」───────────────
   *
   * 病根（读插件 updateParameters 才能看清）：
   *   CubismMotion.updateParameters() 只遍历【自己文件里声明过的曲线】，
   *   对每条调 setParameterValueByIndex(idx, value, weight)，而它是
   *   **按权重混合** v = v*(1-w) + value*w —— 淡出结束 weight=0 时，
   *   引擎就把这条 motion 移出队列，它写过的参数从此【没人再写】，
   *   于是永久冻结在最后一帧的值上。
   *
   * 而 Hiyori 的待机动作恰好按手臂参数分成两族、完全不重叠：
   *   A 族（m01~m05/m07/m09/m10）只写 ParamArmLA/RA（垂下）
   *   B 族（m06/m08）          只写 ParamArmLB/RB + ParamHandLB/RB（抬起）
   * 手臂最终姿态 = A 轴 + B 轴共同决定 →
   *   **B 族播完后 ArmLB/RB 卡在「抬起」值，切回 A 族时没人把它放下来**，
   *   两个轴叠加出手臂的错乱姿态，观感就是「举手放下时有残影」。
   *   而且每播一次 B 族动作都会把残值刷新一遍，越用越明显。
   *
   * 修法：在 afterMotionUpdate（motion 刚写完参数、物理演算之前）补一刀 ——
   *   1) 把【当前队列里所有活跃 motion 正在写】的手臂参数收集起来；
   *   2) 剩下【无人接管】的，按指数平滑放回中立位。
   * 交叉淡化期间两族都还在队列里、都在写 → written 覆盖全部，我们完全不动手，
   * 过渡仍由引擎自己混；等旧 motion 被移出队列，残值才被平滑释放。
   */
  {
    const im = model.internalModel;
    const core = im?.coreModel;
    const mm = im?.motionManager;

    /* 「只有部分动作写」的参数全集 —— 从 10 个 motion3.json 的曲线并集统计来的：
     *     ParamHandLB/RB   2/10  只 m06 m08 写
     *     ParamHandL/R     3/10  只 m02 m03 m06 写
     *     ParamArmLB       5/10  m06 m07 m08 m09 m10
     *     ParamArmRB       6/10  m05~m10
     *     ParamArmLA/RA    9/10  只有 m06 不写
     *     ParamLeg         9/10  只有 m07 不写
     * 只有这 9 个会「没有别的动作接着写 → 永久冻结」；
     * 其余 28 个参数每个动作都写，不存在残留问题，不用管。
     *
     * ⚠️ 上一版只列了 8 个手臂参数、漏了 ParamLeg，而且把两族的关系写错了：
     *    m08 其实**同时**写 ParamArmLA/RA 和 ParamArmLB/RB，真正独占的只有
     *    ParamHandLB/RB（m06 m08）、ParamHandL/R（m02 m03 m06）这几个。
     */
    const DRIFT_NAMES = [
      'ParamArmLA', 'ParamArmRA',
      'ParamArmLB', 'ParamArmRB',
      'ParamHandLB', 'ParamHandRB',
      'ParamHandL', 'ParamHandR',
      'ParamLeg'
    ];

    // CubismId → 字符串
    //
    // ⚠️ 关键坑：getString() 返回的是 **csmString 对象**（{s:"ParamAngleX"}），
    //    不是字符串！直接拿它 `=== 'ParamAngleX'` 永远为 false，
    //    表现成「参数表读不出来 / findIdx 全返回 -1」。必须再取一层 .s。
    const idToStr = (id) => {
      if (typeof id === 'string') return id;
      try {
        const a = id?.getString?.();
        if (typeof a === 'string') return a;
        if (a && typeof a.s === 'string') return a.s;
        const b = id?.s;
        if (typeof b === 'string') return b;
        if (b && typeof b.s === 'string') return b.s;
      } catch { /* ignore */ }
      return '';
    };

    // 建「参数名 ↔ 索引」表；先走索引表，读不到再退回按名取索引
    const nameToIdx = new Map();
    const idxToName = new Map();
    const paramCount = core?.getParameterCount?.() ?? 0;
    for (let i = 0; i < paramCount; i++) {
      let s = '';
      try { s = idToStr(core.getParameterId(i)); } catch { s = ''; }
      if (s) { nameToIdx.set(s, i); idxToName.set(i, s); }
    }
    if (!nameToIdx.size) {
      for (const n of DRIFT_NAMES) {
        let i = -1;
        try { i = core?.getParameterIndex?.(n); } catch { i = -1; }
        if (i >= 0) { nameToIdx.set(n, i); idxToName.set(i, n); }
      }
    }

    const ARMS = DRIFT_NAMES.filter((n) => nameToIdx.has(n)).map((n) => {
      const idx = nameToIdx.get(n);
      let def = 0;
      try {
        const d = core?.getParameterDefaultValue?.(idx);
        if (typeof d === 'number' && Number.isFinite(d)) def = d;
      } catch { /* 拿不到就用 0（手臂的中立位就是 0） */ }
      return { name: n, idx, def };
    });

    // 曲线上的 CubismId → 参数索引
    const idxOfId = (id) => {
      const s = idToStr(id);
      if (s && nameToIdx.has(s)) return nameToIdx.get(s);
      try { return core.getParameterIndex(id); } catch { return -1; }
    };

    console.log('[pet] arm-release', JSON.stringify({
      params: paramCount,
      arms: ARMS.length,
      // 附上每个参数的默认值 —— 释放逻辑的目标就是它，得先确认取到的是真值
      detail: ARMS.map((a) => `${a.name.replace('Param', '')}=${a.def}`)
    }));

    // 诊断用：?rel=0 临时关掉本修复，方便做「修复前 vs 修复后」对照
    const REL_OFF = new URLSearchParams(location.search).get('rel') === '0';
    if (ARMS.length >= 2 && mm && typeof im.on === 'function' && !REL_OFF) {
      const nameOfIdx = new Map(ARMS.map((a) => [a.idx, a.name]));

      // 单个 motion 写了哪些手臂参数（只算一次，挂在 motion 上缓存）
      const armSetOf = (motion) => {
        if (!motion) return null;
        if (motion.__petArmSet) return motion.__petArmSet;
        const set = new Set();
        const md = motion._motionData;
        const cnt = md?.curveCount ?? 0;
        for (let i = 0; i < cnt; i++) {
          let nm = '';
          try { nm = nameOfIdx.get(idxOfId(md.curves.at(i).id)) ?? ''; } catch { nm = ''; }
          if (nm) set.add(nm);
        }
        motion.__petArmSet = set;
        return set;
      };

      let lastT = 0;
      im.on('afterMotionUpdate', () => {
        // 活跃队列：MotionManager.queueManager._motions（csmVector of MotionQueueEntry）
        const qm = mm.queueManager || mm._queueManager;
        const q = qm?._motions;
        const n = q?.getSize?.() ?? 0;
        if (!n) { lastT = 0; return; }   // 一个动作都没有：交给默认位，不动手

        const written = new Set();
        for (let i = 0; i < n; i++) {
          let mo = null;
          try { mo = q.at(i)?._motion; } catch { mo = null; }
          const set = armSetOf(mo);
          if (set) for (const nm of set) written.add(nm);
        }

        const now = performance.now();
        const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 1 / 60;
        lastT = now;
        // 时间常数 0.15s，约 0.45s 收敛 —— 刻意跟引擎那 0.5s 的淡入淡出同量级。
        // （早先给的是 0.1s：残值 0.3s 就归位，而新动作还在淡入途中，
        //   两个时间尺度差一倍，过渡里会看到手臂「抽」一下。）
        const k = 1 - Math.exp(-dt / 0.15);

        for (const { name, idx, def } of ARMS) {
          if (written.has(name)) continue;   // 有动作在写，别插手
          let cur = NaN;
          try { cur = core.getParameterValueByIndex(idx); } catch { continue; }
          if (typeof cur !== 'number' || !Number.isFinite(cur)) continue;
          if (Math.abs(cur - def) < 0.005) continue;
          const next = cur + (def - cur) * k;
          try {
            core.setParameterValueByIndex(idx, Math.abs(next - def) < 0.005 ? def : next, 1);
          } catch { /* ignore */ }
        }
      });
    }
  }

  console.log('[pet] model mounted', JSON.stringify({
    name,
    drawables: model.internalModel?.coreModel?.getDrawableCount?.(),
    params: model.internalModel?.coreModel?.getParameterCount?.(),
    /* 有哪些动作组是「模型真的认得」的 —— 接线对不对，看这一行最快：
     * 期望 Idle / TapBody / Drag / Walk 四组（后两个是自制动作）。 */
    motions: Object.keys(model.internalModel?.motionManager?.motionGroups || {})
  }));
  /* 人物刚画出来 → 重量一次头顶 y（悬浮气泡锚点）。慢一点等首帧画稳。 */
  setTimeout(() => window.pet?.requestHeadMeasure?.(), 1500);
  /* 摸头条带的锚（渲染层自己的实量头顶）也要量一次 —— 量不到会自动重试。 */
  queueHeadMeasure();
  return true;
}

async function boot() {
  // 先把配置和上次的聊天记录捞回来：TTS / 主动搭话都要看配置，
  // 历史得在第一次对话之前就位。
  try {
    cfg = await window.pet?.getConfig?.();
    hasApiKey = !!cfg?.llm?.apiKey;
    // 用户调的人物大小（托盘 / 右键菜单），必须在 mountModel 之前生效 ——
    // mountModel 里的 applyModelGeometry() 会把它乘进 PET_SCALE
    setUserScale(cfg?.appearance?.scale);
  } catch { cfg = null; }
  try {
    const h = await window.pet?.loadHistory?.();
    if (Array.isArray(h) && h.length) {
      history.push(...h);
      console.log('[pet] 载入历史', h.length, '条');
    }
  } catch { /* ignore */ }

  app = new PIXI.Application();
  await app.init({
    canvas,
    backgroundAlpha: 0,            // 关键：透明背景，否则会出现黑底方块
    // 画布尺寸由 layout() 自己定：要做成窗口的 ZOOM 倍，比窗口大，
    // 多出来的部分由 #stage 裁掉（模型溢出画布会让裁剪遮罩渲染失败）。
    // ⚠️ antialias 必须关（2026-10-12 实测）：MSAA 在这里纯烧显存。
    //   canvas 已经是显示尺寸的 ~4.6 倍超采样（ZOOM 2.898 × DPR 1.5），
    //   合成时的降采样本身就是最好的抗锯齿，MSAA 属于重复劳动 ——
    //   实拍对比（debug/pet-bar-*.png）发丝 / 眼睛 / 衣缘看不出任何差别，
    //   而 GPU 进程内存 333MB → 265MB（-68MB，见 debug/baseline-empty.js 的对照法）。
    antialias: false,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
    // pixi v8 默认会优先尝试 WebGPU；在禁用了 WebGPU 的 Chromium 上这条路径
    // 会让渲染进程直接崩掉（STATUS_BREAKPOINT），所以显式钉死在 WebGL2
    preference: 'webgl',
    preferWebGLVersion: 2,
    // 像素级命中测试要读回 framebuffer（见 maxAlphaNear）。
    // 默认 false 时浏览器合成后会清掉绘制缓冲，渲染循环之外 readPixels
    // 只能读到空白 —— 所以必须开。代价是合成时多一次拷贝，这个尺寸无感。
    preserveDrawingBuffer: true    // [实验2] 恢复 true，单独测 antialias 的贡献
  });

  // ⚠️ 必须把 Application 实例挂到 window.app 上。
  //   pixi-live2d-display 的 _onRenderCallback 开头是这样拿 renderer 的：
  //     let webglRenderer = this.renderer
  //     if (!webglRenderer) {
  //       const app = globalThis.app || window.app
  //       if (!app?.renderer) return          // ← 直接静默返回，什么也不画
  //       ...
  //     }
  //   没有 window.app 时它每帧都在第一行就 return，于是模型数据全部正常
  //   （网格、参数、不透明度、顶点都在），帧率也在跑，但画面永远是空的。
  window.app = app;

  // 像素级命中测试要用的 GL 上下文，在这里抓一次（见 maxAlphaNear）
  initHitTest();

  /* ⚠️ 透明背景的真正坑（踩了很久，记下来）
   *
   * 现象：窗口配置全对、pixi 的 context 属性全对（alpha:true、背景 [0,0,0,0]、
   *      页面各元素 background 全是 transparent），但屏幕上是**一块纯白底板**。
   *      把 canvas 藏掉窗口立刻全透明 —— 说明白底就是这块 canvas 输出的。
   *
   * 根因是一条跨库的交互 bug：
   *   1) pixi-live2d-display 渲染 Cubism 的「高精度掩码」时，会
   *      gl.clearColor(1,1,1,1) 去清空那张 mask FBO（白色是掩码的"未覆盖"值，
   *      这一步本身没错），但**清完没有把 clearColor 恢复回去**。
   *   2) pixi 自己维护了一个 clearColor 缓存（_clearColorCache），只在
   *      「期望值 ≠ 缓存值」时才真的调 gl.clearColor。缓存里一直存着 [0,0,0,0]，
   *      所以 pixi 认为无需设置，直接 gl.clear() —— 用的却是插件留下的白色。
   *   3) 于是主 framebuffer 每帧都被清成不透明白，连带把窗口的 alpha 一起抹掉。
   *      前几帧是透明的，因为那时掩码渲染还没被触发，极具误导性。
   *
   * 修法：接管 gl.clear —— 凡是对「主 framebuffer」做的颜色清除，一律先把
   *      clearColor 拨回透明。插件给 mask FBO 清白色时绑定的是非默认
   *      framebuffer，走不到这条分支，掩码逻辑不受影响。
   */
  try {
    const gl = app.renderer.gl;
    const origClear = gl.clear.bind(gl);
    const origClearColor = gl.clearColor.bind(gl);
    gl.clear = function clearPatched(mask) {
      if (mask & gl.COLOR_BUFFER_BIT) {
        try {
          // 只有默认 framebuffer（窗口背景）才强制透明
          if (!gl.getParameter(gl.FRAMEBUFFER_BINDING)) origClearColor(0, 0, 0, 0);
        } catch { /* 状态查询失败就按原样 clear */ }
      }
      return origClear(mask);
    };
  } catch (e) {
    console.log('[pet] clearpatch err', String(e));
  }

  await mountModel(MODEL_NAME);
  // 加载成功的显式证据：若模型没真正就绪，这里会先炸
  const core = model.internalModel?.coreModel;
  console.log('[pet] model ready', JSON.stringify({
    canvas: `${app.screen.width}x${app.screen.height}`,
    modelW: Math.round(model.width),
    modelH: Math.round(model.height),
    scale: Number(model.scale.x.toFixed(3)),
    drawables: core?.getDrawableCount?.(),
    params: core?.getParameterCount?.(),
    motions: Object.keys(model.internalModel?.motionManager?.definitions || {}).length,
    ready: model.internalModel?.ready
  }));

  // 主循环：情绪 + 口型 + 视线
  //
  // 用低优先级注册，确保在模型自身的 update（motion / 物理演算）之后执行 ——
  // 否则这一帧写进去的表情参数会被 motion 覆盖，表情就白写了。
  app.ticker.add((ticker) => {
    const dt = ticker.deltaMS / 1000;

    /* ⚠️ 切模型的时候 model 会有一段为 null 的窗口（mountModel 先把旧的 destroy
     * 掉，新的还在 await 加载）。ticker 是常驻的，不挡一下就会在那一瞬间
     * 抛 "Cannot read properties of null (reading 'focus')" —— 实测切模型必现。
     * 切模型时整段跳过就好（参数插值那些丢几帧无所谓，emotion 目标值还在）。 */
    if (!model) return;

    /* 🔴 顺序：视线**先**，情绪**后**（2026-10-13 修，原来反了）。
     *
     * focus() 写的是 ParamAngleX/Y/Z 的**绝对值**。原来的顺序是先
     * applyEmotion 写情绪的头部姿态、紧接着 focus 覆盖掉 —— 于是
     * 只要光标存在（IDLE 场景下光标一直在），所有情绪的 headY/headZ
     * 都被抹掉，等于歪头点头从来没真正生效过。
     *
     * 而 applyEmotion 的撤销法算的是
     *     新值 = 当前值 − 我上帧写的 + 我本帧要写的
     * 只有"当前值"里**已经含 focus 本帧写的量**时，减掉自己的历史增量
     * 才等于"别人的贡献"，再加自己的值 —— 这才是叠加。放到 focus 前面，
     * 读到的就是上帧的残留，视线的贡献会被吃掉。
     * 两件事合起来只有一个正确顺序：focus 在前，applyEmotion 在后。 */
    updateGaze(dt);

    /* 摸头（按住）：先推进状态机（patAmt / patPhase），再由它算出本帧的
     * **有效目标**。⚠️ 必须在插值循环之前 —— 插值逼近的是 emoEff。 */
    updatePat(dt);
    buildEmoTarget(emoEff, emoTarget, patAmt, patPhase);

    /* 情绪插值：指数逼近（与帧率无关），但**每个字段一个速度** ——
     * 一张脸同时到位是木偶，错峰到位才像活人。速度表见 params.js 的 EMO_SPEED。
     * 用 1 − e^(−dt·s) 而不是乘一个固定 k，是为了不同帧率下轨迹一致。
     * 速度再乘这一趟的抖动因子（jitter.js）—— 开关关掉时是 1（逐位同旧版）。 */
    for (const key in emoEff) {
      const sp = (EMO_SPEED[key] ?? EMO_SPEED_DEFAULT) * (emoJitter ? emoJitter[key] ?? 1 : 1);
      emoCur[key] += (emoEff[key] - emoCur[key]) * (1 - Math.exp(-dt * sp));
    }
    applyEmotion();

    /* 口型。两条路：
     *   · 有真实包络（`tts.engine='winrt'`，声音由我们自己用 WebAudio 播，
     *     见 tts.js 的 lipEnv）→ 嘴直接跟随真实音量；
     *   · 没有（系统音色，或这一句刚回退过）→ 退回原来的正弦波。
     * ⚠️ lipEnv 必须**每帧都调**：它内部带快攻慢放的平滑，调用频率变了
     *    平滑就变；而且队列空了（state 已回 IDLE）时还要靠它把嘴收回去。 */
    const env = lipEnv(dt);
    if (env !== null) {
      mouthLevel = env;
      setParam(P.MOUTH_OPEN, mouthLevel);
    } else if (state === State.SPEAKING) {
      mouthPhase += dt * 10;
      mouthLevel = (Math.sin(mouthPhase) * 0.5 + 0.5) * 0.7 + 0.15;
      setParam(P.MOUTH_OPEN, mouthLevel);
    } else if (mouthLevel > 0) {
      mouthLevel = Math.max(0, mouthLevel - dt * 4);
      setParam(P.MOUTH_OPEN, mouthLevel);
    }
  }, null, PIXI.UPDATE_PRIORITY.LOW);

  /* 把两个模块需要的外部状态注入进去。
   *
   * 全部用 getter / 闭包，**不能传值快照** —— cfg 会随托盘改配置变、
   *  state / busy 每帧都在变，传进去的那一刻的值下一帧就过期了。 */
  configureTTS({
    getCfg: () => cfg,
    getState: () => state,
    isBusy: () => busy,
    setState,
    isQuiet: () => quiet,
    /* 主进程的 Windows 合成通道（见 src/main/tts.js）。
     * ⚠️ 调顶层桥必须 `window.pet?.xxx?.(` —— `.?.` 只护对象不护方法，
     *    写成 `window.pet.synthSpeech?.()` 在旧版本 preload 下会直接崩。 */
    synth: (text, opts) => window.pet?.synthSpeech?.(text, opts)
  });
  configureRecorder({
    getCfg: () => cfg,
    showStatus,
    setEmotion,
    setIgnoreMouse,
    setState,
    onRecognized: (text) => {
      input.value = text;
      showComposer();
      sendMessage();                 // 说完就发，不用再点一次
    }
  });

  initTTS();
  pokeIdleTimer();

  /* 底座先摆个转圈顶着：第一条 monitor:stats 要等主进程采到数才来
   * （常驻采样器得先跑一次 nvidia-smi，冷启动必然晚一拍）。不摆的话这段时间
   * 窗口底部是空的，看着像"今天没开悬浮显示"。
   * ⚠️ 放在这里（模型挂好之后）而不是读配置的时候：renderStatsLoading 会量高度
   *    并调 layout()，那会儿 app / model / holder 得已经就位。 */
  scheduleStatsLoading();

  /* ?snap= 探针在 diag.js。不带这个参数时不加载。 */
  if (new URLSearchParams(location.search).has('snap')) {
    /* 顺手报一次 WebGL 后端 —— 双 GPU 机器上「到底用了哪块卡」只能问 GL 自己。
     * WMI 的 GPUEngine 计数器是**按 luid 分实例**的，光看计数器分不出归属
     * （核显和独显各有一串实例，加起来是个四不像的数）。
     * 拿不到 debug 扩展时退回被脱敏的 gl.RENDERER，仍能看出厂商。 */
    try {
      const gl = app.renderer.gl;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const rd = (k, fallback) => (dbg ? gl.getParameter(dbg[k]) : gl.getParameter(fallback));
      console.log('[pet] webgl backend RENDERER=' + rd('UNMASKED_RENDERER_WEBGL', gl.RENDERER) +
                  ' | VENDOR=' + rd('UNMASKED_VENDOR_WEBGL', gl.VENDOR));
    } catch (e) { console.log('[pet] webgl 后端探测失败:', e && e.message); }

    const { attachSnapProbes } = await import('./diag.js');
    attachSnapProbes({
      app: () => app,
      model: () => model,
      holder: () => holder,
      petRect: () => petRect,
      headTop: () => headTopY,   // 实量头顶（诊断探针用；0 = 还没量到）
      pointer: () => pointer,
      emotion: () => emotion,
      /* 摸头（A-B-C）的状态机快照。露出来是为了让诊断脚本能**读真实状态**
       * 判断"按下到底有没有起手、按住期间在不在摆"，而不是靠盯截图猜。 */
      pat: () => ({
        state: patState, amt: patAmt, phase: patPhase, ms: patMs,
        released: patReleased, nagged: patNagged, shy: patShy
      }),
      cfg: () => cfg,
      setCfg: (v) => { cfg = v; },
      replyBuffer: () => replyBuffer,
      gotFirstChunk: () => gotFirstChunk,
      P: () => P,
      readParam,
      maxAlphaNear,
      HIT_ALPHA_MIN,
      setEmotion,
      setState,
      State,
      stageEl,
      canvas,
      bubble,
      bubbleText,
      input,
      showComposer,
      hideUI,
      say,
      sendMessage,
      pokeIdleTimer,
      /* ?snap=load 用它**强制**摆一次加载态（真的去调 builder，不是复制一份 DOM），
       * 好把"转圈时的牌"和"出数后的牌"量下来比尺寸 —— 这是加载态唯一会出错的地方。 */
      renderStatsLoading,
      /* ── ?snap=tts 用的朗读探针 ──────────────────────────────
       * 两件事在 mock 里测不到，只能在真实渲染层里跑：
       *   ① 系统 TTS 引擎的 onend 到底会不会按时触发（兜底定时器就是为它写的）；
       *   ② 队列在真引擎下是否真的一条条推进。
       * ⚠️ forceTTS 只改**本进程内存里**的 cfg（默认 tts 是关的，不改它测不了）；
       *    它不是配置写入路径 —— 正常开关仍然只走主进程的 patchConfig。 */
      forceTTS: () => { if (cfg?.tts) cfg.tts.enabled = true; },
      ttsState: () => ttsQueueState(),
      ttsVoice: () => ttsVoiceInfo(),
      setSpeechObserver,
      feedSpeech,
      enqueueSpeech,
      stopSpeak
    });
  }

}

/* ============================================================
 *  取景：半身（头顶 → 腰）
 *
 *  Cubism 画布（2976x4175）里角色本体只占其中一块，四周全是留白。
 *  按画布尺寸适配会让角色又小又偏，
 *  所以直接按半身取景。本体的坐标是量出来的：把模型缩到「画布刚好装进窗口
 *  高度」，截下窗口，统计「非透明 且 非纯白」像素的包围盒再反推。
 *
 *  最终做法只有三步：
 *      1) canvas 做成窗口的 ZOOM 倍（比窗口大，超出的由 #stage 裁掉）
 *      2) holder.scale 设为 vh/4500 —— 整张画布恰好等于 canvas 高度
 *      3) canvas 的 left/top 负责平移（实测 1:1 生效）
 *
 *  ⚠️ 连环踩过的坑，按严重程度排：
 *
 *  1. 模型绝不能溢出 canvas。一旦溢出，Cubism 的裁剪遮罩就会渲染失败，
 *     整块画布糊成一片没有 alpha 的白色（ink 恒为空）。所以 canvas 必须
 *     比放大后的模型大 —— 这也是 ZOOM 存在的唯一理由。
 *
 *  2. 缩放只认 holder.scale，平移不认 holder.position。实测把
 *     model.position.y 上移 200 画面纹丝不动（包围盒只差 2px，那是 idle
 *     抖动）。别浪费时间去调它，平移交给 canvas 的 left/top。
 *
 *  3. 别想推公式算落位。插件的 gl.viewport 是按「逻辑尺寸」写入的，
 *     却被 GL 当设备像素用（resolution=1.5 时画面只占画布左上 2/3），
 *     且真正生效的视口又不是 internalModel.viewport 里那个值。
 *     所以 window = s×画布坐标 + 常数 里的那个常数只能实测标定。
 *
 *  4. 别想遍历 drawable 顶点自动量包围盒。Cubism Core 每调一次
 *     getDrawableVertexPositions 都在 WASM 堆上分配数组，几十个 drawable
 *     连读会把内部缓冲搞坏，结果是模型彻底不渲染。
 *
 *  5. 也别去动 internalModel.setupLayout()。里面的 scale()/translate()
 *     是在旧值上累乘/累加的，centeringTransform 会被再乘一次 pixelsPerUnit
 *     （= 画布的 pixelsPerUnit），画布瞬间放大几千倍 —— 又一个"糊成一片白"。
 * ========================================================== */

/* ---- 取景参数（换模型必须重标）----
 * 画布尺寸改成运行时从 internalModel 读，所以换模型不用改这里；
 * 下面这几组才是要标定的东西，换模型得重新量。 */
let CANVAS_W = 2976;                     // Cubism 画布宽（兜底值，运行时会覆盖成真值）
let CANVAS_H = 4175;                     // Cubism 画布高

let ZOOM = 2.898;                        // 画布相对窗口的放大倍数（见坑 1）

/* 人物缩放 = 当前模型的基准值 × 用户倍率。
 *
 *   基准值写死在 MODELS 表里（改动要重新标定几何，别乱调）；
 *   用户倍率来自 appearance.scale，托盘 / 右键菜单都能实时改。
 *
 * 缩放只乘在 holder.scale 上，不改 canvas 尺寸，所以**缩小永远安全**；
 * 调大要小心模型溢出 canvas（溢出会让 Cubism 的裁剪遮罩渲染失败，整块糊白）。
 *
 * ⚠️ ?pet=NNN 是诊断覆盖：把模型压小到完整落在窗口里，才能量出真实包围盒
 *    （被窗口裁掉的部分 capturePage 截不到）。给了它就忽略用户倍率。 */
const PET_SCALE_OVERRIDE = (() => {
  const q = Number(new URLSearchParams(location.search).get('pet'));
  return Number.isFinite(q) && q > 0 ? q : null;
})();

let userScale = 1;                 // appearance.scale，实时可调
let PET_SCALE = MODELS[curModelName].petScale;
let HEAD_PAD_RATIO = MODELS[curModelName].headPadRatio;

/* 用户缩放的合法区间 —— 必须与主进程 src/main/config.js 的 `LIMITS.scale`
 * 一致（那边是唯一的真相，渲染层拿不到它，只能靠这两个数跟住）。 */
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.4;

/* 设定用户缩放并重算 PET_SCALE。
 *
 * 先前这段（钳位 + 重算）在四处各写了一遍：boot 读配置、onConfigChanged
 * 回读、onAppearance 收到推送、以及菜单里的放大/缩小。漏改任何一处都会
 * 出现「菜单显示 100% 但模型没跟着变」这类只在一半路径上复现的 bug，
 * 所以收成一个入口。raw 是脏数据（undefined / NaN / 字符串）也认。 */
function setUserScale(raw) {
  const n = Number(raw);
  userScale = Number.isFinite(n) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, n)) : 1;
  PET_SCALE = PET_SCALE_OVERRIDE ?? (MODELS[curModelName].petScale * userScale);
}

/* 模型墨水的实测几何（canvas 坐标系）。换模型时由 applyModelGeometry() 整体换掉。
 *
 * ⚠️ 这一组数**不是推出来的，是实测拟合的**。
 * 🔴 关键教训 —— 模型在 canvas 内的位置**不是**「画布坐标 × s」的纯比例：
 *    它带一项**上边距**。但它同样**不是常数** —— 它正比于画布高 vh
 *    （= vh × INK_TOP_C_RATIO，见文件顶部模型表的坑）。原先写死 242 时，
 *    在标定用的那个窗口尺寸下严丝合缝，换显示器立刻跑偏（实测 H=560 低 85px）。
 *    所以这里只留与窗口无关的 INK_TOP_K，C 由 layout() 按 vh 现算。 */
let INK_TOP_K = MODELS[curModelName].inkTopK;
let INK_H = MODELS[curModelName].inkH;
let INK_W = MODELS[curModelName].inkW;
let INK_CX_K = MODELS[curModelName].inkCxK;

/* 把 geometry / scale 从 MODELS 表刷进上面这些运行时变量。
 * 改用户缩放走它，保证只剩一处真相（MODELS 表）。 */
function applyModelGeometry(name) {
  const m = MODELS[name];
  if (!m) return;
  curModelName = name;
  INK_TOP_K = m.inkTopK;
  INK_H = m.inkH;
  INK_W = m.inkW;
  INK_CX_K = m.inkCxK;
  HEAD_PAD_RATIO = m.headPadRatio;
  PET_SCALE = PET_SCALE_OVERRIDE ?? (m.petScale * userScale);
}
applyModelGeometry(curModelName);

/* 诊断用：?pad=NNN 直接指定留白像素数，跳过比例。
 * 量「模型到底超出窗口多少」时必须先给个足够大的值把模型压进窗口，
 * 否则被裁的部分根本截不到（capturePage 只能拿到窗口内的像素）。
 * ⚠️ query 里没有 pad 时 get() 返回 null，而 Number(null) === 0 —— 必须先把
 *    空串/null 挡掉，否则「没传参数」会被当成「留白 = 0」，头顶直接贴顶。 */
function headPadPx(H) {
  const raw = new URLSearchParams(location.search).get('pad');
  const q = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(q) && q >= 0) return q;
  return Math.round(H * HEAD_PAD_RATIO);
}

/* ---- 模型墨水的实测几何（canvas 坐标系）----
 *
 * ⚠️ 这一组数**不是推出来的，是实测拟合的**。换模型必须重新标。
 *
 * 量法：用 ?snap=ink&pet=..&pad=.. 把模型压到完整可见（被窗口裁掉的部分
 * capturePage 截不到），逐帧量像素包围盒，取多组缩放点。
 *
 * 🔴 关键教训 —— 模型在 canvas 内的位置**不是**「画布坐标 × s」的纯比例：
 *    它带一项**固定上边距**。这是 pixi-live2d-display 按 canvas 尺寸自己给模型
 *    做布局留下的，光靠 holder.scale 消不掉。
 *    旧代码按纯比例算（BODY.y=1608.5），把墨水顶部算低了 90~116px，
 *    窗口一小的时候只裁掉边边看不出来，窗口一变大（换显示器）就变成「头顶被切」。
 *
 * 实测数据（s → 墨水顶部在 canvas 内的 y）：
 *   0.05801→256.1  0.10152→265.3  0.11602→269.8  0.26105→303.9
 * 拟合 inkTopY(s) = 242 + 236.8·s，四点误差 < 1px。
 * 墨水总高/总宽则老老实实正比于 s（3006.4 / 897 画布单位）。 */
// （这 5 个量已上移到 MODELS 表 —— 那里是唯一真相，且按模型区分；
//   上面的实测数据是 hiyori 那一组。）

// 取景想要「显示到哪」—— 全身的 55% 处（腰际）。改大 = 露更多腿、人物显小。
const SHOW_FRACTION = 0.55;

/* 舞台底部预留的"呼吸位"（CSS px）：人物下沿与舞台底边（= 底座上沿）之间留的空。
 * 取景定义的那条 55% 线正好等于舞台高，所以不留白的话人直接贴到底座上。
 * 实测留 8px 时只剩 1px 透明缝（人下沿 y=472、底座顶边 y=474，1.5× 像素），
 * 太挤；14px 给出约 5px 的干净缝隙。见 layout() 里 H 的算法。 */
const STATS_GAP = 14;

/* 底座牌的半宽。牌宽 = 2×--stats-col(67) + 左右 padding 12 + 边框 2 = 148，
 * 半宽 74。改 style.css 的 --stats-col 要跟着改这里。
 * 用途只剩一个：syncStageWidth 里给窗口宽度托底（内容再少也不能比牌窄）。
 * （2026-10-12 起「内容右靠」机制已移除 —— 用户改要求人物恒居中、
 *  窗口固定为对话框那一档宽，见 syncStageWidth 那段。） */
const PLATE_HALF = 74;

/* 窗口宽度固定为「对话框那一档」（2026-10-12，用户："可以根据对话框固定位置
 * 大小，不需要点击后再调整"）：
 *   宽 = max( 人物墨水宽, 底座牌宽 ) + 左右各 CONTENT_PAD，**再对齐到 ≥ TALK_W**。
 * 也就是：平时就顶着气泡 / 输入条需要的宽度（两者 left/right:14 铺满窗口），
 * 点开 / 收起输入条**宽度一字不变** → 人物、底座、气泡全都不挪窝；
 * 只有换模型 / 改缩放（人物墨水变宽）时窗口才跟着变宽。
 * ⚠️ BUBBLE_W / UI_PAD 对应 style.css 里 #bubble / #composer 的
 *    left:14 / right:14，改那边要跟着改这里（同 PLATE_HALF 与 --stats-col 的关系）。 */
const CONTENT_PAD = 24;
const BUBBLE_W = 280;
const UI_PAD = 14;
const TALK_W = BUBBLE_W + UI_PAD * 2;

/* 实测标定值（本机 DPR 1.5 下量出，换模型/换屏幕缩放都要重标）
 *
 * 画布坐标 → 窗口坐标的实测关系（**仅对模型墨水整体有效，别用来推单个参数点**）：
 *     window_x = s × 画布x + CANVAS_OFF.x
 *     window_y = s × 画布y + CANVAS_OFF.y + 固定上边距
 * 注意最后那项固定上边距 —— 模型在 canvas 内的位置不是纯比例，见下面 INK_TOP_C 的说明。
 * CANVAS_OFF 就是 canvas 的 left/top，它 1:1 生效（实测斜率 1.0）。
 *
 * ⚠️ CANVAS_OFF 已改为 layout() 里**现算**（由 PET_SCALE / HEAD_PAD / INK_* 解出），
 *    下面的初值只是兜底，运行后会被覆盖。 */
let CANVAS_OFF = { x: -97.8, y: -378 };

let petRect = { x: 0, y: 0, w: 0, h: 0 };

function layout() {
  if (!app || !model || !holder) return;
  const W = stageEl.clientWidth;
  /* 舞台高再让出一条"呼吸位"（STATS_GAP），别让人物的下沿正好贴在底边上。
   * 取景的定义是「显示到全身的 55%（腰际）」，那条线**正好落在舞台底边**；
   * 舞台上方又有 #stats 底座时，底座上沿离底边还有几 px，#stage 又是
   * bottom: --stats-h 让出来的 —— 两边加起来，人物下沿会正好压到底座上沿。
   * 让出 STATS_GAP 之后人站在底座上方、留一线空白，视觉上才像"站在台子上"。
   * ⚠️ 没开底座时（--stats-h = 0）这 14px 是纯底部留白，人物略小于从前一丁点，
   *    属可接受的代价 —— 不区分开关状态能少一条分支、也少一处不一致。 */
  const H = stageEl.clientHeight - STATS_GAP;
  if (!W || !H) return;

  // ---- 0) 画布尺寸以模型真值为准（别信上面那两个兜底常量）----
  const im = model.internalModel;
  if (im?.originalWidth && im?.originalHeight) {
    CANVAS_W = im.originalWidth;
    CANVAS_H = im.originalHeight;
  }

  // ---- 1) 画布 = 窗口的 ZOOM 倍 ----
  // 模型放大后必须仍能完整装进画布：一旦溢出，Cubism 的裁剪遮罩就会渲染失败，
  // 整块画布糊成一片白（实测过：s=0.244 而画布只有窗口大时，ink 恒为空）。
  const vw = Math.round(W * ZOOM);
  const vh = Math.round(H * ZOOM);
  if (app.screen.width !== vw || app.screen.height !== vh) {
    app.renderer.resize(vw, vh);   // autoDensity 会同步写 canvas 的 style 尺寸
  }

  // ---- 2) 缩放：整张 Cubism 画布恰好等于画布高度，再乘人物缩放系数 ----
  const s = (vh / CANVAS_H) * PET_SCALE;
  holder.scale.set(s);

  // ---- 3) 平移：把**模型墨水的真实顶部**对到 HEAD_PAD、身体中心对到窗口中心 ----
  // 关系式是 window = canvas内坐标 + CANVAS_OFF（CANVAS_OFF 就是 canvas 的 left/top，
  // 1:1 生效，实测斜率 1.0）。而「canvas 内坐标」由上面那组实测几何给出：
  //     墨水顶部 canvas内 y = vh×INK_TOP_C_RATIO + INK_TOP_K × s   ← 第一项随画布高走
  //     身体中心 canvas内 x = INK_CX_K × s                          ← 水平方向是纯比例
  // 于是：
  //     y: HEAD_PAD     = (vh×INK_TOP_C_RATIO + INK_TOP_K×s) + CANVAS_OFF.y
  //     x: W/2 + 2      = INK_CX_K×s + CANVAS_OFF.x
  // 末尾那个 +2 是标定时量到的光学修正（人物实际中心比窗口中心右偏 2px），沿用它。
  // holder/model 的 position 对 Cubism 绘制无效、别去调，平移只走 canvas 的 left/top。
  //
  // ⚠️ INK_CX_K 是**身体中心线**，不是墨水包围盒中心（2026-10-12 修）。
  //    原先用的是包围盒中心，而日和的长发偏在一侧、包围盒中心 ≠ 视觉中心，
  //    结果人物整体偏左约 37px（底座居中、人物不居中）。详见 params.js 的模型表。
  const HEAD_PAD = headPadPx(H);
  const INK_TOP_C = vh * INK_TOP_C_RATIO;   // 随画布高现算，不能写死（见模型表的坑）
  /* 人物**恒居中**（2026-10-12 定稿，用户："人物要居中"+"按对话框固定大小，
   * 不需要点击后再调整"）：身体中心锚在窗口中线（+2 是标定时的光学修正）。
   * 底座牌与气泡小尖角在 CSS 里也各居中，大家天然对齐，不再有右靠量。
   * （曾经的「内容右靠」机制随窗口宽度固定而移除，别再往回加。） */
  CANVAS_OFF.x = (W / 2 + 2) - INK_CX_K * s;
  CANVAS_OFF.y = HEAD_PAD - (INK_TOP_C + INK_TOP_K * s);
  canvas.style.left = `${CANVAS_OFF.x}px`;
  canvas.style.top = `${CANVAS_OFF.y}px`;

  // ---- 4) 角色在窗口里的矩形（鼠标穿透判定用）----
  // 用实测墨水的宽高，比旧的 BODY 矩形准（旧值偏小、水平还偏右 48px，
  // 结果点头顶那一片会被判成"非角色"而穿透）。
  //
  // ⚠️ 中心写成 `INK_CX_K*s + CANVAS_OFF.x` 而不是 `W/2+2`：
  //    两者数学上**恒等**（因为 CANVAS_OFF.x 就是按 (W/2+2) − INK_CX_K*s
  //    解出来的），但这么写让「命中矩形锚在人物实际落点上」这件事一眼可见 ——
  //    2026-10-12 改 INK_CX_K 标定值时，中间的 canvas 偏移量变了一个大数，
  //    若沿用字面 W/2+2 会让人怀疑矩形没跟着动。用同一条式子的两面表达，
  //    就永远不会脱节。
  const bodyCx = INK_CX_K * s + CANVAS_OFF.x;    // 身体中心在窗口里的 x（≡ W/2+2）
  petRect = {
    x: bodyCx - (INK_W / 2) * s,
    y: HEAD_PAD,
    w: INK_W * s,
    h: Math.min(H - HEAD_PAD, INK_H * s)
  };

  /* 人物几何算完了 → 窗口宽度可能要跟着变（换模型 / 改缩放 / 开关底座都会走这里）。 */
  syncStageWidth();

  /* 人物落点变了 → 让主进程重量头顶 y（悬浮气泡的锚点。节流在主进程侧）。 */
  window.pet?.requestHeadMeasure?.();
  /* 几何变了 → 摸头条带的锚（实量头顶）也要跟着重新量。 */
  queueHeadMeasure();

  if (new URLSearchParams(location.search).has('snap')) {
    const r = (n) => Math.round(n);
    console.log('[pet] layout', JSON.stringify({
      stage: [W, H], canvas: [vw, vh], scale: Number(s.toFixed(5)),
      cubism: [CANVAS_W, CANVAS_H], zoom: ZOOM, off: [CANVAS_OFF.x, CANVAS_OFF.y],
      bodyCx: r(bodyCx),                                                 // 身体中心落点
      inkTopC: Number(INK_TOP_C.toFixed(2)),                             // = vh×0.2
      inkTopEst: r(petRect.y),                                           // 推算的墨水顶（**不是实量**，真头顶见 measureHeadTop）
      waistY: Math.round(HEAD_PAD + SHOW_FRACTION * INK_H * s),          // 腰际落点
      petRect: [r(petRect.x), r(petRect.y), r(petRect.w), r(petRect.h)]
    }));
  }
}

// 窗口尺寸 / 屏幕缩放变化时重算（桌宠窗口本身不可缩放，主要是防 DPR 变化）
window.addEventListener('resize', () => layout());

/* ============================================================
 *  穿透判定
 * ========================================================== */

function isOverUI(x, y) {
  const el = document.elementFromPoint(x, y);
  return !!(el && el.closest('#bubble, #composer'));
}

/* ============================================================
 *  像素级命中测试
 * ==========================================================
 *
 * 背景：`petRect` 是个**矩形**，而人是半身像 —— 矩形四角、两臂外侧、
 * 头发之间一大片都是透明像素。用矩形判定会把这些地方也算成"在她身上"，
 * 于是就出现了「点空白处也触发点击/拖动」「窗口范围内桌面图标点不着」。
 *
 * 做法：直接在 framebuffer 上读鼠标附近那一小块像素的 alpha，
 *      够大才算命中 —— 所见即所得，透明的地方天然不命中，
 *      遮挡、部件透明度、掩码这些复杂情况全都不用自己算。
 *
 * 两个必要前提：
 *   1) `preserveDrawingBuffer: true`（见 app.init）。默认 false 时浏览器
 *      合成后会清掉绘制缓冲，渲染循环之外再 readPixels 只会读到空。
 *   2) canvas 比窗口大（ZOOM 倍）并且带 CANVAS_OFF 偏移，窗口坐标必须先
 *      换算成 canvas 绘制缓冲坐标，否则读的是完全不相干的位置。
 *
 * 只读 7x7 一小块（不到 200 字节），开销可以忽略；
 * 判定取邻域的**最大值**而不是中心点，边缘抗锯齿的淡像素不会漏判。
 */
const HIT_RADIUS = 3;          // 读 (2*3+1)^2 = 49 个像素
const HIT_ALPHA_MIN = 24;      // alpha 低于此值视为透明（范围 0~255）
// 位置缓存：鼠标在同一处抖动 / 亚像素移动时不必重复 readPixels。
// 2px 内 alpha 基本不会变，超过 100ms 也强制重读，避免拿到过期结果。
const HIT_CACHE_PX = 2;
const HIT_CACHE_MS = 100;

let hitGl = null;
let hitBuf = new Uint8Array((HIT_RADIUS * 2 + 1) ** 2 * 4);
let hitCache = { x: NaN, y: NaN, a: -1, t: 0 };

function initHitTest() {
  try {
    hitGl = app?.renderer?.gl || null;
  } catch { hitGl = null; }
}

/* 返回 (x, y) 周围一小块里的最大 alpha（0~255）。
 * x/y 是**窗口 CSS 坐标**；返回 -1 表示读不到（没启用 / 越界 / 出错），
 * 调用方要回退到矩形判定 —— 探测失败不能让整个穿透逻辑失灵。
 *
 * ⚠️ WebGL 的像素原点在**左下角**，y 轴要翻过来。 */
function maxAlphaNear(x, y) {
  if (!hitGl || hitGl.isContextLost?.()) return -1;

  // 1) 位置缓存
  const now = performance.now();
  if (now - hitCache.t < HIT_CACHE_MS &&
      Math.abs(x - hitCache.x) <= HIT_CACHE_PX &&
      Math.abs(y - hitCache.y) <= HIT_CACHE_PX) {
    return hitCache.a;
  }

  const res = app.renderer.resolution || 1;
  const bw = hitGl.drawingBufferWidth;
  const bh = hitGl.drawingBufferHeight;
  if (!bw || !bh) return -1;

  // 窗口坐标 → canvas 绘制缓冲坐标（canvas 比窗口大，还带 CANVAS_OFF 偏移）
  const cx = Math.round((x - CANVAS_OFF.x) * res);
  const cy = Math.round((y - CANVAS_OFF.y) * res);

  let x0 = cx - HIT_RADIUS;
  let y0 = cy - HIT_RADIUS;          // 以画布顶部为原点
  let w = HIT_RADIUS * 2 + 1;
  let h = HIT_RADIUS * 2 + 1;

  // 裁进画布，越界的部分直接丢掉（readPixels 越界会报 INVALID_OPERATION）
  if (x0 < 0) { w += x0; x0 = 0; }
  if (y0 < 0) { h += y0; y0 = 0; }
  if (x0 + w > bw) w = bw - x0;
  if (y0 + h > bh) h = bh - y0;
  if (w <= 0 || h <= 0) return -1;

  const need = w * h * 4;
  if (hitBuf.length < need) hitBuf = new Uint8Array(need);
  const out = hitBuf;

  let prev = null;
  try {
    // 读之前确保绑的是默认 framebuffer（pixi 平时会切到自己的 RT 上）
    prev = hitGl.getParameter(hitGl.FRAMEBUFFER_BINDING);
    if (prev) hitGl.bindFramebuffer(hitGl.FRAMEBUFFER, null);
    // WebGL 的 y 从底部起算
    hitGl.readPixels(x0, bh - y0 - h, w, h, hitGl.RGBA, hitGl.UNSIGNED_BYTE, out);
  } catch {
    return -1;
  } finally {
    try { if (prev) hitGl.bindFramebuffer(hitGl.FRAMEBUFFER, prev); } catch { /* ignore */ }
  }

  let max = 0;
  for (let i = 3; i < need; i += 4) {
    const a = out[i];
    if (a > max) max = a;
  }
  hitCache = { x, y, a: max, t: now };
  return max;
}

function isOverPet(x, y) {
  if (!model || !petRect.w) return false;

  // 1) 矩形快速排除：连她所在的方框都没碰到，必然不在她身上。
  //    注意这里不能用 model.getBounds() —— 那给的是整张画布的范围，
  //    四周那一大片透明留白也会算进去。
  const pad = 8;
  if (!(x >= petRect.x - pad && x <= petRect.x + petRect.w + pad &&
        y >= petRect.y - pad && y <= petRect.y + petRect.h + pad)) {
    return false;
  }

  // 2) 像素判定：进了方框也要真的碰到实心像素才算
  const a = maxAlphaNear(x, y);
  if (a < 0) return true;          // 探测不可用 → 退回旧的矩形行为
  return a >= HIT_ALPHA_MIN;
}

/* ============================================================
 *  交互
 * ========================================================== */

/* 更新视线焦点。
 *
 * ⚠️ 别只依赖 mousemove —— 它只在**窗口内**触发，而窗口只有三百来像素宽，
 *    鼠标一移出去，pointer 就冻在最后那个点上，目光跟着停住。
 *    所以主进程会按 30fps 轮询系统光标位置发过来（preload 的 onCursor），
 *    坐标同样是「相对窗口左上角」，和 e.clientX/clientY 完全一致，
 *    两条来源共用这一个入口，窗口内外无缝衔接。
 *
 * 坐标可以是负数、也可以超出窗口 —— focus() 内部取的是 atan2 方向，
 * 距离多远都只看方向，所以窗口外的坐标照样正确。
 */
function updatePointer(x, y) {
  pointer = { x, y };
}

window.pet?.onCursor?.((p) => {
  // 主进程的轮询覆盖窗口内外，直接采用
  updatePointer(p.x, p.y);
});

/* 拖动前先接管：主进程轮询只负责视线，拖动位移仍由窗口内的 mousemove 出。 */

/* 悬停穿透判定 —— 用 rAF 合并成「每帧最多算一次」。
 *
 * ⚠️ 不能直接在 mousemove 里调 isOverPet()：它要 readPixels，而 readPixels 会
 *    强制同步等待 GPU 管线 flush。偏偏 mousemove 的触发频率可以远高于帧率
 *    （高刷鼠标上千 Hz），鼠标一划过就是几十上百次同步读像素。
 *    而 maxAlphaNear 里那点位置缓存救不了它 —— 移动过程中坐标一直在变，
 *    2px 的缓存必然 miss，于是每次移动都真的读一次。
 *    rAF 合并后观感完全不变，开销掉一个数量级。 */
let hitRaf = 0;
let hitPending = null;
function scheduleHitTest(x, y) {
  hitPending = { x, y };
  if (hitRaf) return;
  hitRaf = requestAnimationFrame(() => {
    hitRaf = 0;
    const p = hitPending;
    hitPending = null;
    if (!p) return;
    if (dragging) return;            // 拖动中固定不穿透，由下面的拖动分支接管
    setIgnoreMouse(!(isOverPet(p.x, p.y) || isOverUI(p.x, p.y)));
  });
}

window.addEventListener('mousemove', (e) => {
  // 鼠标在窗口上方划过也算"有活动"，把主动搭话的计时器往后推。
  // 节流到 5 秒 —— mousemove 太密集，每次重置定时器纯属浪费。
  const now = Date.now();
  if (now - lastActivityPoke > 5000) {
    lastActivityPoke = now;
    pokeIdleTimer();
  }

  updatePointer(e.clientX, e.clientY);

  if (dragging) {
    const dx = e.screenX - lastScreenX;
    const dy = e.screenY - lastScreenY;
    if (dx || dy) {
      lastScreenX = e.screenX;
      lastScreenY = e.screenY;
      dragMoved = true;
      /* 已经变成拖拽了 → 摸头这一路作废（规矩 6：用户操作优先于自动动作，
       * 这里反过来是"拖拽优先于摸头"，两者抢的是同一段按下-抬起）。 */
      if (patState !== 'idle') patAbort();
      window.pet?.dragMove(dx, dy);

      // 拖着走：拖出一段距离后挣扎一下（一次拖动只反馈一次，别一直嚎）
      if (!dragReacted &&
          Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 24) {
        dragReacted = true;
        if (cfg?.interaction?.dragReact !== false) {
          setEmotion('surprised');
          /* 以前这里播的是 TapBody —— 那是"被戳一下"，跟"被拎起来"是两回事。
           * Drag 是本项目自制的持续动作（tools/make-motions.js），
           * 一直播到松手，观感是"她一路在挣扎"。 */
          playEventMotion('Drag');
        }
      }
    }
    setIgnoreMouse(false);
    return;
  }

  scheduleHitTest(e.clientX, e.clientY);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  dragMoved = false;
  dragReacted = false;
  downX = e.clientX;
  downY = e.clientY;
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
  /* 摸头起手：**按下就反应**（原来要等松手才播一次 TapBody）。
   * 只有"在头顶按下"才算 —— 身上其他地方仍然是原来的"点一下"。 */
  if (isHeadPatTarget(e.clientX, e.clientY)) patStart();
  e.preventDefault();
});

/* 在角色身上右键 → 交给主进程弹原生菜单（表情 / 动作 / 外观 / 退出）。
 * 透明区域不弹 —— 和左键一样按像素判定，不然窗口那一大片空白也会吃掉右键。 */
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (cfg?.interaction?.rightMenu === false) return;
  if (!isOverPet(e.clientX, e.clientY)) return;
  window.pet?.contextMenu?.();
});

window.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  window.pet?.dragEnd?.();          // 让主进程判断要不要贴屏幕边缘
  if (dragMoved) {
    patAbort();                     // 拖走了：摸头这一路不算数
    if (dragReacted) {
      setEmotion('calm');          // 松手了，气消了
      stopEventMotions();          // 停掉 Drag，交还给插件的 idle 调度
    }
    return;
  }

  /* 她自己挣脱过了 → 这一次松手什么都不算。
   * ⚠️ 必须在 patState 判断**之前**：挣脱的 falling 只有 0.71s，
   *    用户往往在她已经回到 idle 之后才松手 —— 那时不拦就成了"戳了一下"，
   *    会凭空播一次 TapBody 并甩出输入框。 */
  if (patEscaped) {
    patEscaped = false;
    setState(State.IDLE);
    return;
  }

  /* 摸头这一路：走 A-B-C 的收尾，**不再**进 onPetClicked() ——
   * 否则会再播一次 TapBody（那是"被戳一下"，跟摸头是两回事），
   * 而且还会重复 setEmotion('happy')，把起手的势冲掉。 */
  if (patState !== 'idle') {
    bumpClickStreak();
    /* 两种"摸够了"：按住太久（patNagged，过程中已经喊过一嗓子），
     * 或者连着摸了三下（原来的规则，保留没删）。 */
    const annoyed = patNagged || clickStreak >= 3;
    patRelease();
    if (annoyed) {
      setEmotion('shy');
      if (!patNagged) say('别摸啦，头发要乱了。');
      return;                       // 闹脾气了，不甩输入框过来
    }
    setState(State.LISTENING);
    showComposer();
    pokeIdleTimer();
    return;
  }

  onPetClicked();
});

/* 点她一下。
 *
 * ⚠️ **摸头不在这个函数里了**（2026-10-14）—— 它挪到了 mousedown 上的
 *    patStart()，走 A-B-C 三段式（按住就一直蹭）。这里只剩"身上点一下"。
 *
 * 两种反应，都可以在托盘「互动行为」里单独关掉：
 *   - 连戳：在身上一串快点 → 惊讶反问
 *   - 普通：乐一下 + 打开输入框
 * 只有"普通"会弹输入框 —— 戳烦了她会闹脾气，不该还甩个输入框过来。 */
function onPetClicked() {
  if (!model) return;
  window.pet?.activity?.();
  bumpClickStreak();

  try { model.motion('TapBody'); } catch { /* 模型没这个组就算了 */ }

  if (cfg?.interaction?.pokeReact !== false && clickStreak >= 4) {
    setEmotion('surprised');
    say('戳够了没有。');
    return;
  }

  setEmotion('happy');
  setState(State.LISTENING);
  showComposer();
  pokeIdleTimer();
}

/* 说一句就走 —— 不打开输入框、不占住对话状态。
 * 摸头抗议、定时提醒、番茄钟都用它。（正在对话时不会抢气泡。） */
function say(text, autoHideMs = 9000) {
  // 浮窗模式：整段交给悬浮气泡窗（autoHide 也由那边管），主窗 #bubble 不动
  if (floatBubble()) {
    clearTimeout(remindHideTimer);
    window.pet?.floatSay?.(text, autoHideMs);
    speak(text);
    return;
  }
  bubbleText.textContent = text;
  bubble.classList.remove('hidden');
  speak(text);
  clearTimeout(remindHideTimer);
  remindHideTimer = setTimeout(() => {
    if (busy) return;
    bubble.classList.add('hidden');
    bubbleText.textContent = '';
    bubbleThink.textContent = '';
  }, autoHideMs);
}

function showComposer() {
  composer.classList.remove('hidden');
  setTimeout(() => input.focus(), 30);
}

function hideUI() {
  composer.classList.add('hidden');
  if (floatBubble()) {
    window.pet?.floatHide?.();
  } else {
    bubble.classList.add('hidden');
    bubbleText.textContent = '';
    bubbleThink.textContent = '';
  }
  setState(State.IDLE);
}

/* ---- 窗口宽度：固定为「对话框那一档」，只有内容真放不下才变宽 ----
 *
 * 演变史（改之前先读懂，别把删掉的东西加回来）：
 *   · 最早宽 308 恒定，但人物墨水只占右边 154 → 左边白占 135px（用户嫌空）。
 *   · 2026-10-12 上午改成「内容决定宽度」：常驻收窄到人物+底座，对话再撑开 ——
 *     结果点一下输入条窗口就伸缩一次，人物跟着挪，用户不满意。
 *   · 当晚定稿（用户："可以根据对话框固定位置大小，不需要点击后再调整"）：
 *     **恒 ≥ TALK_W**，宽度只在换模型 / 改缩放 / 开关底座时可能变，
 *     对话开关不动窗口分毫 → 人物、底座、气泡谁都不用"调整"。
 *
 * 为什么宽度由渲染层算：人物的墨水宽 = f(窗口高, 用户设的缩放, 模型)，
 * 只有这边量得到（petRect 就是它）。
 *
 * ⚠️ 主进程改宽度时**右边缘钉死**（见 main.js 的 setStageWidth）：人物恒居中，
 *    窗口在左边伸缩时她随窗口中心走 —— 但宽度已与对话态无关，
 *    日常使用中这条 setBounds 路径几乎不再触发。
 * ⚠️ 只在数值变了时上报：layout() 会因为尺寸 / 缩放 / 换模型反复重跑。 */
let stageWantW = 0;

function syncStageWidth() {
  /* 对话态挂 body（CSS 据此把底座牌整块淡出）：牌（bottom:4）与输入条
   * （bottom:14）都贴着窗口底，横向必然重叠 —— 牌会糊在输入条右端的
   * 麦克风 / 发送键上。⚠️ 只藏牌、不动 --stats-h：舞台不重新让高，
   * 人物不因对话开关而缩放一丁点。只看输入条：say() 的纯气泡不压着牌。 */
  const composerOpen = !composer.classList.contains('hidden');
  document.body.classList.toggle('talking', composerOpen);
  if (!app || !model || !petRect.w) return;    // 还没布局过，报出来的会是假值
  const contentW = Math.max(petRect.w, PLATE_HALF * 2) + CONTENT_PAD * 2;
  /* ⚠️ 宽度与对话态**无关**（恒 ≥ TALK_W）—— 点开 / 收起输入条不伸缩，
   *    这正是"按对话框固定大小，不需要点击后再调整"的落点。
   *    千万别把 talking 拌回这行算式：那会让每次对话开关都动一次窗口。 */
  const want = Math.round(Math.max(contentW, TALK_W));
  if (want === stageWantW) return;
  stageWantW = want;
  window.pet?.setStageWidth?.(want);
}

/* 气泡 / 输入条的显隐有十来处调用点，逐个补一行迟早漏一个 ——
 * 漏掉的表现就是「底座牌没让位、糊在输入条上」。
 * 直接盯 class 最保险：MutationObserver 的回调排在本次绘制之前，看不出延迟。
 * （宽度已不随对话态变，这里只剩 body.talking 一件事要跟着刷。） */
for (const el of [bubble, composer]) {
  new MutationObserver(syncStageWidth).observe(el, { attributes: true, attributeFilter: ['class'] });
}

/* 气泡摆哪里？chat.floatBubble 开（默认）= 漫画气泡挂头顶上方的独立小窗
 * （主进程 bubble.js），主窗里的 #bubble 不画 —— 否则它会压在人物胸口。
 * 关 = 老布局，气泡压在输入条上方（会挡胸口那段，胜在单窗口简单）。 */
const floatBubble = () => cfg?.chat?.floatBubble !== false;

/* ============================================================
 *  对话
 * ========================================================== */

/* ── 边收边念（流式朗读）──────────────────────────────────────
 *
 * 原来是"整段收完才开口"：speak(replyBuffer) 挂在回复结束那一步上。
 * 回复一长，第一声要等好几秒，而气泡里的字早就一行行滚出来了 ——
 * 观感是"她先看完再念给你听"。
 *
 * 现在：每收到一段增量就喂进缓冲，够一句立刻丢进 tts.js 的播放队列，
 * 队列在后台一条接一条念。首声延迟从"整段生成时间"降到"第一句话的时间"。
 *
 * ⚠️ 分句接到的是**清洗之后**的文本（llm.js 的三级清洗在 emitChatChunk 之前
 *    就跑完了），所以不会念出 markdown 星号和 [emo:] 标签。
 * ⚠️ `[think:…]` 走的是另一个通道（onThink），不进这里 —— 心声不该被念出来。
 * ⚠️ 没开语音时立刻返回（默认就是关的）：不做缓冲、不跑正则。 */
function feedSpeech(text) {
  if (!text || !cfg?.tts?.enabled) return;
  speechBuf += text;
  const { sentences, rest } = takeSentences(speechBuf, false);
  speechBuf = rest;
  for (const s of sentences) enqueueSpeech(s);
}

/* 回复收尾：把缓冲里剩下的（多半是最后那句没写标点的）念掉。
 * 🔴 这里**不能**写成 speak(replyBuffer) —— 全文已经分批念过了，
 *    那样会把整段再念一遍（这是分句之后最容易犯的错）。 */
function flushSpeech() {
  if (!cfg?.tts?.enabled) { speechBuf = ''; return; }
  const { sentences } = takeSentences(speechBuf, true);
  speechBuf = '';
  for (const s of sentences) enqueueSpeech(s);
}

/* 🔴 桥的调用一律写成 `window.pet?.fn?.(...)` —— **两个 `?.`，缺一不可**。
 *
 * `?.` 护的是**对象**，不是**方法**：`window.pet?.onThink(...)` 在
 * window.pet 存在、但 onThink 不存在时，会照旧去 call undefined，
 * 抛 TypeError。而下面这三条是**顶层**注册 —— 一条抛出去，整个模块体
 * 就断在这儿，后面所有 `let` 全部停在 TDZ，然后到处报
 * "Cannot access 'x' before initialization"（2026-10-14 实跑撞见：
 * 包里的 preload 还是旧版、渲染层是新的，日志里那串 TDZ 全是这一条的连锁）。
 *
 * 版本错配（预加载脚本比渲染层旧）的正确行为是**降级**：少一个监听就少
 * 一个功能，整页不该崩。onConfigChanged 那处本来就是这个写法。 */
window.pet?.onChunk?.((text) => {
  if (!gotFirstChunk) {
    gotFirstChunk = true;
    setState(State.SPEAKING);
    // 浮窗模式下 waiting 态由气泡窗自己摘，主窗 #bubble 躺平不动
    if (!floatBubble()) bubble.classList.remove('waiting');
  }
  replyBuffer += text;
  feedSpeech(text);              // 边收边念：够一句就送播放队列
  if (!floatBubble()) {
    bubbleText.textContent = replyBuffer;
    bubble.scrollTop = bubble.scrollHeight;
  }
});

// 情绪由主进程从回复的 [emo:xxx] 标签里解析出来后单独发过来，
// 气泡文本里那一段已经被剥干净了，不用在渲染层再过滤一次。
window.pet?.onEmotion?.((name) => setEmotion(name));

/* 「心里想的」([think:…]) —— 主进程剥出来后单独发来，整段到达。
 * ⚠️ 刻意**不进 replyBuffer**：那个变量驱动 TTS 朗读和聊天历史，
 *    想法是没打算说出口的东西，混进去就等于当众念心声了。
 *    这里只把它塞进气泡顶部那一行。 */
window.pet?.onThink?.((text) => {
  if (floatBubble()) return;          // 浮窗模式由气泡窗自己画那一行
  bubbleThink.textContent = text;
});

// 托盘 / 右键菜单里改了开关，重新读一遍配置
// （语音朗读、主动搭话、互动行为、系统状态显示等开关都在里面）
window.pet?.onConfigChanged?.(async () => {
  const wasFloating = cfg?.monitor?.floating === true;
  try {
    cfg = await window.pet.getConfig();
    hasApiKey = !!cfg?.llm?.apiKey;
    // 大小也可能是在配置里改的，跟着同步一次
    setUserScale(cfg?.appearance?.scale);
    /* 关掉悬浮显示时，除了藏底座还得把让出去的那条高度还回来 ——
     * 否则舞台一直矮着，人物白缩一圈（setStatsReserve 内部会重排 layout）。
     * ⚠️ 顺手把 statsSeen 清零：这样下一次再打开时又是"先转圈再出数"，
     *    而不是拿上一次的老数字顶上（那会让人以为数字是刚采的）。 */
    if (wasFloating && cfg?.monitor?.floating !== true) {
      statsSeen = false;
      cancelStatsLoading();
      statsEl?.classList.add('hidden');
      setStatsReserve(0);
    } else {
      /* 刚把悬浮显示打开：数据要等主进程下一次推送（~1s），先摆个转圈顶上。
       * statsSeen 为真时 scheduleStatsLoading 自己会跳过 —— 别拿转圈盖住真数字。 */
      if (!wasFloating && cfg?.monitor?.floating === true) scheduleStatsLoading();
      layout();
    }
  } catch { /* ignore */ }
  pokeIdleTimer();
});

window.pet?.onHistoryCleared?.(() => {
  history.length = 0;
  stopSpeak();
  hideUI();
});

/* ============================================================
 *  聊天记录 / 主动搭话
 * ========================================================== */

function saveHistory() {
  window.pet?.saveHistory?.(history);
}

// 没配 Key 时主动搭话走本地短句池 —— 否则每次都只会弹出那句
// "还没配 API Key"，反而更烦人。
const PROACTIVE_LINES = [
  '你盯着屏幕好久了，起来动动。',
  '安静这么半天，需要我搭把手吗。',
  '我还在，没跑。',
  '刚想到个事——算了，你先忙。'
];

function pokeIdleTimer() {
  clearTimeout(idleTimer);
  /* 全屏静默中不排新的主动搭话 —— 所有"人还在"的入口（点击、划过、提醒、
   * 改配置）都会走到这里，拦这一处就等于全部拦住。醒来时主进程那侧的
   * 闲置检测会重新武装（motion.js 的 refreshWanderConfig / setMotionPaused），
   * 这里不需要自己补。 */
  if (quiet) return;
  if (!cfg || cfg.proactive?.enabled === false) return;
  // 下限 0.05 分钟（3 秒）：配置写错时不至于让角色一直碎碎念
  const mins = Number(cfg.proactive?.idleMinutes);
  const safe = Number.isFinite(mins) && mins >= 0.05 ? mins : 8;
  idleTimer = setTimeout(proactiveSpeak, safe * 60 * 1000);
}

async function proactiveSpeak() {
  // 排好的定时器可能刚好落在"进入静默"那一刻之后，再挡一道
  if (quiet) return;
  // 正忙或不在空闲态就别打扰
  if (busy || state !== State.IDLE) {
    console.log('[pet] proactive skipped', JSON.stringify({ busy, state }));
    pokeIdleTimer();
    return;
  }

  if (!hasApiKey) {
    const line = PROACTIVE_LINES[Math.floor(Math.random() * PROACTIVE_LINES.length)];
    setEmotion('smile');
    replyBuffer = line;
    if (floatBubble()) window.pet?.floatSay?.(line);
    else {
      bubbleText.textContent = line;
      bubble.classList.remove('hidden');
    }
    speak(line);
    pokeIdleTimer();
    return;
  }

  busy = true;
  replyBuffer = '';
  gotFirstChunk = false;
  /* 浮窗模式下的等待态由主进程 chat:proactive 里的 beginStream() 负责，
   * 这里只管主窗 #bubble（回退模式）。 */
  if (!floatBubble()) {
    bubbleText.textContent = '';
    bubbleThink.textContent = '';
    bubble.classList.add('waiting');
    bubble.classList.remove('hidden');
  }

  let res;
  try { res = await window.pet.proactive(); } catch { res = { ok: false }; }
  if (!floatBubble()) bubble.classList.remove('waiting');
  busy = false;

  if (res?.ok) {
    replyBuffer = replyBuffer.replace(/\s+$/, '');   // 同 sendMessage：收掉标签留下的空行
    if (!floatBubble()) bubbleText.textContent = replyBuffer;
    history.push({ role: 'assistant', content: replyBuffer });
    saveHistory();
    flushSpeech();
  } else if (!floatBubble()) {
    bubble.classList.add('hidden');
    bubbleText.textContent = '';
    bubbleThink.textContent = '';
  }
  pokeIdleTimer();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || busy || !model) return;

  busy = true;
  input.value = '';

  /* 上一轮还没念完就被新消息打断 —— 清掉它的队列与分句缓冲，
   * 否则新回复的朗读要排在旧句后面（"怎么还在念上一句"）。
   * 原来整段念时靠 speak() 里的 cancel 顺带做到了，分句之后必须显式清。 */
  stopSpeak();
  speechBuf = '';

  history.push({ role: 'user', content: text });
  if (history.length > 16) history.splice(0, history.length - 16);

  // 立刻用思考态占住，避免流式首字返回前的空窗
  // （浮窗模式的等待态由主进程 chat:send 里的 beginStream() 负责）
  setState(State.THINKING);
  replyBuffer = '';
  gotFirstChunk = false;
  if (!floatBubble()) {
    bubbleText.textContent = '';
    bubbleThink.textContent = '';
    bubble.classList.add('waiting');
    bubble.classList.remove('hidden');
  }

  let res;
  try {
    res = await window.pet.chat(history);
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  if (!floatBubble()) bubble.classList.remove('waiting');

  if (!res?.ok) {
    showStatus(res?.error || '请求失败');
    history.pop();
    /* 已经念出去半句话，剩下的不念了 —— 失败时不该继续把残缺内容读完。 */
    stopSpeak();
    speechBuf = '';
    if (!floatBubble()) bubble.classList.add('hidden');
    setState(State.IDLE);
    busy = false;
    return;
  }

  /* 情绪标签剥离后会在末尾留下空行（标签一般独占一行）—— 收掉，
   * 否则每个气泡底下都挂着一两条空行。历史记录里也存干净的。 */
  replyBuffer = replyBuffer.replace(/\s+$/, '');
  if (!floatBubble()) bubbleText.textContent = replyBuffer;
  history.push({ role: 'assistant', content: replyBuffer });
  saveHistory();
  flushSpeech();        // 尾巴念掉；正文已经边收边念过（见 feedSpeech）

  // 说完了，稍微停一下再回到空闲
  setTimeout(() => {
    if (!busy) return;
    setState(State.IDLE);
    busy = false;
  }, 1400);

  pokeIdleTimer();
}

sendBtn.addEventListener('click', sendMessage);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    hideUI();
  }
});

// 拖动窗口或误点都不该让输入框失去焦点后没法再点回来
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !composer.classList.contains('hidden')) {
    hideUI();
  }
});

/* ============================================================
 *  语音输入（按住说话）—— 实现在 recorder.js
 *
 *  录音的三个触发点（mic 按下 / 全局松开 / 页面隐藏）都挂在那边，
 *  本文件只做依赖注入，见下面 boot() 里的 configureRecorder()。
 *  这里保留 abortRecording 的转发，切模型时要主动掐掉录音。
 * ========================================================== */

/* ============================================================
 *  主进程事件
 * ========================================================== */

/* 外观：主进程改了人物大小后推过来 —— 只需实时重算缩放，不重载模型。
 * 原本这里还有「模型」分支（运行时换模型 → 整套重新挂载：取景几何、
 * 动作调优都要跟着换），春移除后模型固定，那条分支没有了。 */
window.pet?.onAppearance?.((a) => {
  if (!a || typeof a.scale !== 'number') return;
  // 钳位后再比，否则主进程推来个越界值会每次都判定「变了」而反复重排
  const before = userScale;
  setUserScale(a.scale);
  if (Math.abs(userScale - before) > 0.001) layout();
});

// 操作反馈小字（改了大小 / 透明度时主进程会发过来）
window.pet?.on?.('pet:toast', (d) => { if (d?.text) showStatus(d.text); });

/* 定时提醒 / 番茄钟到点 —— 气泡 + 语音。
 * 人不在屏幕前的时候语音是唯一有效的通道，所以这里一定会念（除非关了朗读）。 */
window.pet?.on?.('pet:remind', (d) => {
  if (!d?.text) return;
  setEmotion(d.emotion || 'surprised');
  say(d.text, 15000);
  pokeIdleTimer();
});

// 右键菜单：换表情 / 播动作
window.pet?.on?.('pet:set-emotion', (d) => { if (d?.name) setEmotion(d.name); });
window.pet?.on?.('pet:play-motion', (d) => {
  try { model?.motion?.(d?.group || 'Idle'); } catch { /* ignore */ }
});

// 贴边 / 溜达 / 注意到你 —— 给点轻反馈，让人看得出"她是活的"
window.pet?.on?.('pet:snapped', () => { setEmotion('calm'); });
window.pet?.on?.('pet:noticed', () => { setEmotion('surprised'); });
/* 溜达：主进程只在开始 / 结束各发一条，中间的窗口平移它自己管。
 * Walk 是首尾闭合的循环动作（tools/make-motions.js），正好铺满这一段 ——
 * 以前这里只换表情，人是整个平移过去的，像张贴纸。 */
window.pet?.on?.('pet:wander-start', () => { setEmotion('happy'); playEventMotion('Walk'); });
window.pet?.on?.('pet:wander-end', () => { setEmotion('calm'); stopEventMotions(); });

/* ============================================================
 *  全屏静默（主进程判定你在打游戏 / 全屏看片）
 * ==========================================================
 *
 *  渲染层这边只做一件事：**降帧**。剩下的（停溜达、停状态轮询、取消置顶、
 *  不抢焦点）都在主进程，因为那些是窗口和系统层的动作。
 *
 *  ⚠️ 降帧而不是 `app.ticker.stop()`：ticker 一停，之后所有 setEmotion /
 *    气泡 / 模型动作的更新都不会再画出来，恢复时必须自己补一次全量重绘，
 *    很容易漏。而 maxFPS 只是节流，任何时刻恢复都是"下一帧照旧"，没有状态。
 *    12fps 也够看出她还活着（呼吸、眨眼都在），代价只有原来的 1/5。 */
let quiet = false;
let quietFps = 12;

/* 窗口被用户藏进托盘了（主进程按窗口的 show/hide 事件推过来）。 */
let hiddenByUser = false;

/* 平常的帧率上限。
 * ⚠️ 以前这里是 0（= 不限帧 = 跟着显示器刷新率跑）。这是个常驻挂件，待机动作
 *    只有呼吸和眨眼，60fps 绰绰有余；而在高刷屏（120/144/165Hz）上"不限帧"
 *    意味着白烧一倍以上的渲染开销，画面上却一个像素都看不出差别。 */
const IDLE_FPS = 60;
/* 藏进托盘时的帧率。不是 0、也不是 stop()（ticker 停了恢复要补一次全量重绘，
 * 容易漏 —— 见下面 applyFrameCap 的说明）：1fps 足够让"她还在"成立，开销近零。 */
const HIDDEN_FPS = 1;

function applyFrameCap() {
  // pixi v8 的语义：0 = 不限帧
  const fps = hiddenByUser ? HIDDEN_FPS : (quiet ? quietFps : IDLE_FPS);
  try { if (app?.ticker) app.ticker.maxFPS = fps; } catch { /* ignore */ }
  /* ⚠️ 必须**两个 ticker 一起降**，只降 app.ticker 会漏掉一半开销。
   *    这里是本文件里最容易看漏的一处：上面的 `Live2DModel.registerTicker(PIXI.Ticker)`
   *    在插件内部等价于 `defaultTicker = Ticker.shared` —— 也就是说**模型的动作与
   *    物理演算跑在 PIXI 的全局共享 ticker 上**（它自己 autoStart，和 app 无关），
   *    而 `app.ticker` 只负责"把舞台画出来"。
   *    只降后者 → 画面是 12fps 了，但 Cubism 依旧每帧算一遍顶点、物理、贴图更新，
   *    CPU 一点没省。两个都降才是真的"睡过去"。 */
  try { PIXI.Ticker.shared.maxFPS = fps; } catch { /* ignore */ }
}

window.pet?.on?.('pet:quiet', (d) => {
  const on = !!d?.quiet;
  const fps = Number(d?.fps);
  quietFps = Number.isFinite(fps) && fps >= 1 ? fps : 12;

  const changed = on !== quiet;
  quiet = on;

  if (changed && quiet) {
    stopSpeak();              // 正在念的那句立刻掐掉 —— 打游戏时突然出声最讨厌
    stopEventMotions();       // 拖拽 / 溜达的动作也一起收（规矩 19：静默七处一起收手）
    patAbort();               // 摸头也收（她进静默了，别再蹭）
    clearTimeout(idleTimer);  // 撤掉已经排好的主动搭话（醒来会重排）
    /* 静默期间主进程**不再推数据**（refreshStatsTimer 开头就 return），
     * 所以"还在等第一条数据"的那段时间会一直转下去 —— 直接收掉。
     * 已经有数字在显示时这个调用什么也不做（保留最后一帧读数，和以前一致）。 */
    dismissStatsLoading();
  }
  applyFrameCap();
  if (changed) {
    console.log('[pet] quiet', JSON.stringify({ quiet, fps: quiet ? quietFps : IDLE_FPS }));
  }
});

/* 窗口被藏起来 / 又露出来了（主进程在窗口的 show/hide 事件里推）。
 * 藏起来 ≠ 不渲染：这个窗口开着 backgroundThrottling:false，Chromium 不会
 * 自作主张降频，不显式压帧她就会一直满速画一个谁也看不到的模型。 */
window.pet?.on?.('pet:visible', (d) => {
  const hidden = d ? !d.visible : false;
  if (hidden === hiddenByUser) return;
  hiddenByUser = hidden;
  applyFrameCap();
});

// 系统状态悬浮显示
window.pet?.on?.('monitor:stats', (s) => renderStats(s));

/* 底座上每个指标的显示规格：CPU / 内存 / GPU / 温度。
 *
 * ⚠️ 不放图标：12px 的描边图标在这个尺寸下认不出是什么，反而把一行撑宽撑高。
 *    纯文字 + 分级配色信息密度更高，底座也更矮 ——
 *    半身取景下每一像素的底座高度都是从人物身上让出来的。 */
const STAT_ITEMS = [
  { key: 'cpu',  label: 'CPU',  get: (s) => (typeof s.cpu === 'number' ? `${s.cpu}%` : null),           pct: (s) => s.cpu },
  { key: 'mem',  label: '内存', get: (s) => (s.mem ? `${s.mem.percent}%` : null),                        pct: (s) => s.mem?.percent },
  { key: 'gpu',  label: 'GPU',  get: (s) => (typeof s.gpu === 'number' ? `${s.gpu}%` : null),           pct: (s) => s.gpu,
    /* 口径是**独立显卡**（NVIDIA），不是核显 —— 双 GPU 笔记本上这两块差得很远
     * （2026-10-12 用户就在这上面问过："取的好像不是独立显卡的"）。
     * 标签放不下"NVIDIA"四个字母，靠 title 说清楚。 */
    hint: '独立显卡（NVIDIA）利用率' },
  /* 温度：**标签写「温度」**，不能写「GPU」—— 它紧跟在「GPU 45%」后面，
   * 写成 "GPU 48°C" 读起来是"GPU 又 48"，纯属重复。
   * ⚠️ 也不能不消歧：系统监视语境里「温度」默认指 CPU，用户第一反应是
   *    "不对，应该有七八十度" —— 实际这是**独显核心温度**，待机就 ~48℃
   *    （满载才 75~85℃，目标上限 87℃）。数值对、歧义在含义上。
   * → 靠橙色（区别于三条负载%）+ title 全文说明消歧。 */
  { key: 'temp', label: '温度', get: (s) => (typeof s.tempC === 'number' ? `${s.tempC}°C` : null),
    cls: 'temp', hint: '独显（GPU）核心温度' }
];

/* 把 0–100 的负载映射成 CSS 的 data-level（样式见 style.css）。
 * 中性不给值 —— 平时不抢眼，偏高才变琥珀/红。 */
function levelOf(pct) {
  if (typeof pct !== 'number') return '';
  if (pct >= 90) return 'hot';
  if (pct >= 75) return 'warn';
  return '';
}

/* 造一格：标签 + 数值。
 * value 给空串就是加载态的"骨架格" —— 文字由 CSS（.plate.loading）藏起来，
 * 它只负责贡献尺寸，所以骨架格和真格的宽度、行高完全一样。 */
function buildStatsItem(spec, value, level = '') {
  const item = document.createElement('span');
  item.className = spec.cls ? `item ${spec.cls}` : 'item';
  if (level) item.dataset.level = level;
  if (spec.hint) item.title = spec.hint;

  const lbl = document.createElement('span');
  lbl.className = 'lbl';
  lbl.textContent = spec.label;

  const val = document.createElement('span');
  val.className = 'val';
  val.textContent = value;

  item.append(lbl, val);
  return item;
}

/* 把一串东西每两个一组排成行，整块包进 .plate（那块看得见的"牌"）。
 *
 * ⚠️ 显式切块，不让 flex-wrap 自己折：自动折行位置由文案宽度决定
 *    （"温度 50°C" 比 "CPU 12%" 宽），排出来是 3+1 这种不均衡的样子；
 *    显式切块才是稳定的 2+2。行内每格宽度由 CSS 的 --stats-col 定死，两行左右对齐。
 * ⚠️ 这个 "2" 是全项目唯一的一份定义 —— **加载态必须走同一个函数**：
 *    两边一分叉，转圈时和出数时的牌就不是一样大（见 style.css 的 .plate.loading）。
 * ⚠️ 某一项在个别机器上取不到（比如没独显 → 没有温度项）时不补空占位：
 *    少一项就是少一格，不留 "--"。 */
function buildPlate(list, buildItem) {
  const plate = document.createElement('div');
  plate.className = 'plate';
  for (let i = 0; i < list.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(buildItem(list[i]));
    if (list[i + 1]) row.append(buildItem(list[i + 1]));
    plate.append(row);
  }
  return plate;
}

/* 画底座：CPU / 内存 / GPU / 温度，**固定排成 2 行 × 2 列**（切块在 buildPlate）。
 *
 * ⚠️ 每一项单独判存在，拿不到就**整项不画**，不能画成 0 或 "--"：
 *    GPU 占用与温度**同生共死**（都只有装了 NVIDIA 独显才有来源，
 *    取自同一次 nvidia-smi 调用，见 sysinfo 的「GPU 占用」那段 ——
 *    用户 2026-10-13 定规矩："没有就不取"）。0% 和"取不到"看着是一回事，
 *    但前者是假数据。
 * ⚠️ 不摆转圈的这段时间是**加载态**在顶（见 renderStatsLoading）——
 *    本函数一旦真的画过一次，statsSeen 就为真，转圈不会再回来。 */
function renderStats(s) {
  if (!statsEl) return;
  if (cfg?.monitor?.floating !== true || !s) {
    /* 关掉（或本来就没开）悬浮显示：把"出过数"的标记清掉，
     * 下次再打开时才又会先转圈（见 scheduleStatsLoading）。 */
    statsSeen = false;
    cancelStatsLoading();
    statsEl.classList.add('hidden');
    setStatsReserve(0);
    return;
  }

  statsSeen = true;          // 有真数据了，转圈让位
  cancelStatsLoading();

  const items = STAT_ITEMS
    .map((spec) => ({
      spec,
      value: spec.get(s),
      /* ⚠️ pct 是可选的（温度项没有"负载百分比"这个概念，也就没有分级）。
       *    早期版本写成 spec.pct(s) 直接调 —— 温度那一项没有这个方法，
       *    每次都抛 "spec.pct is not a function"，整条底座因此永远画不出来，
       *    表现是「底座一直是空的」，而不是报错浮上来。
       *    ⚠️ 这里特意放在 map 里算（取不到的项也会算一次），
       *    因为 levelOf 对 undefined 是安全的、而 renderStats 是热路径上的小函数，
       *    不值得为省这一次调用把顺序编得更绕。 */
      level: spec.pct ? levelOf(spec.pct(s)) : ''
    }))
    .filter((it) => it.value !== null);

  const plate = buildPlate(items, (it) => buildStatsItem(it.spec, it.value, it.level));

  statsEl.replaceChildren(plate);
  statsEl.classList.toggle('hidden', items.length === 0);
  setStatsReserve(items.length === 0 ? 0 : measureStatsReserve());
}

/* ============================================================
 *  底座的加载态（转圈）
 *
 *  为什么需要：第一条 monitor:stats 要等主进程那边采到数才来 ——
 *  常驻采样器得先把 powershell 拉起来、跑一次 nvidia-smi（≈1.5s），
 *  所以冷启动必然不是"立刻"。
 *  这段时间窗口底部本来是空的 —— 看着像"今天没开悬浮显示"。
 * ========================================================== */

/* 先等一小会儿再出转圈：正常机器上第一条数据只晚那么一拍，
 * 立刻出转圈反而变成"闪一下"。过了这个宽限期还没数据，才说明确实要等。 */
const STATS_LOADING_DELAY_MS = 300;

/* 转圈的最长存活时间 —— 兜底，不是常态：正常 1~2s 必到
 * （cpu/内存 来自 node 的 os 模块，无论其它字段成不成，推送一定会发生）。
 * 真能走到 10s 的只有两种情况：静默期间主进程不推（见 refreshStatsTimer 开头）、
 * 或者窗口一直不可见。到点就收掉 —— 一个永远转下去的圈比"什么都没有"更让人干等。 */
const STATS_LOADING_MAX_MS = 10000;

let statsLoadingTimer = null;   // 宽限期（还没真的摆出转圈）
let statsLoadingCap = null;     // 转圈的最长存活计时
let statsSeen = false;          // 是否已经出过至少一帧真数据

function cancelStatsLoading() {
  clearTimeout(statsLoadingTimer); statsLoadingTimer = null;
  clearTimeout(statsLoadingCap);   statsLoadingCap = null;
}

/* 摆出加载态。牌里的行与格跟出数时**同构同数量**，只是文字不可见 ——
 * 高度因此和真牌完全一样，--stats-h 不会跳，人物不会缩一下。
 * （尺寸的来龙去脉见 style.css 的 .plate.loading 那一节。）
 *
 * ⚠️ 这里是**原始 builder**，不管"该不该摆" —— 运行期唯一入口是
 *    scheduleStatsLoading，它在摆之前查过 statsSeen，所以数字已经在显示时
 *    走不到这里。（?snap=load 探针会从外部直接调它，正是要靠这一点
 *    在"已经出数"的状态下强制摆一次来量尺寸。） */
function renderStatsLoading() {
  if (!statsEl) return;
  if (cfg?.monitor?.floating !== true) return;   // 悬浮显示没开：整条底座都不该出现

  const plate = buildPlate(STAT_ITEMS, (spec) => buildStatsItem(spec, ''));
  plate.classList.add('loading');
  const sp = document.createElement('span');
  sp.className = 'spinner';
  plate.append(sp);

  statsEl.replaceChildren(plate);
  statsEl.classList.remove('hidden');
  setStatsReserve(measureStatsReserve());
  console.log('[pet] stats loading');
}

/* 排一次加载态（宽限期后才真的摆出来）。
 * ⚠️ 宽限期用 setTimeout 而不是"直接摆"：期间真数据到了会被
 *    renderStats → cancelStatsLoading 撤掉，转圈一下都不闪。 */
function scheduleStatsLoading() {
  cancelStatsLoading();
  if (!statsEl || statsSeen) return;
  statsLoadingTimer = setTimeout(() => {
    statsLoadingTimer = null;
    /* statsSeen 是权威状态、定时器只是手段：宽限期内数据到了的话
     * renderStats 已经把定时器撤了，这里再查一次，免得日后有人改了那边的撤法。 */
    if (statsSeen) return;
    renderStatsLoading();
    statsLoadingCap = setTimeout(() => {
      dismissStatsLoading();
      console.log('[pet] stats loading timeout');
    }, STATS_LOADING_MAX_MS);
  }, STATS_LOADING_DELAY_MS);
}

/* 收掉加载态。只在"确实还摆着转圈"时才动 DOM ——
 * 已经有真数据时它早让位了，这个方法就该什么都不做。 */
function dismissStatsLoading() {
  cancelStatsLoading();
  if (!statsEl || statsSeen) return;
  if (!statsEl.querySelector('.plate.loading')) return;
  statsEl.replaceChildren();
  statsEl.classList.add('hidden');
  setStatsReserve(0);
}

/* 底座实际占掉的高度（含它自己距下沿的 4px 留白），写进 --stats-h。
 *
 * ⚠️ 量的是内层 **.plate**（可见的那块牌），不是外层 #stats ——
 *    外层是撑满宽度的定位容器，它的高度虽然此刻恰好等于 .plate，
 *    但那是"因为外层是单行 flex + align-items:flex-end"才成立的巧合。
 *    直接量 .plate 才是量的"底座真正占了多少地方"，不依赖那层巧合。
 * ⚠️ 必须**先显示、再量** —— 量一个 opacity:0 的元素拿到的 rect 是对的
 *    （opacity 不参与布局），所以这里能直接量。但量完要立刻把舞台让出来，
 *    否则 canvas 矮下去后底座可能折行（更宽/更高）→ 下一帧再调一次收敛，
 *    所以用量完的同一值回写、不递归。 */
function measureStatsReserve() {
  const el = statsEl.querySelector('.plate') || statsEl;
  const h = Math.ceil(el.getBoundingClientRect().height);
  return Math.max(0, h) + 4;   // +4 是底座与窗口下沿的间距（style.css 里 bottom: 4px）
}

let statsReserve = 0;
function setStatsReserve(px) {
  const v = Math.max(0, Math.round(px));
  if (v === statsReserve) return;
  statsReserve = v;
  document.body.style.setProperty('--stats-h', `${v}px`);
  // 舞台变矮 → canvas 尺寸变 → 必须让 layout() 重算取景（否则人物还按旧窗口排）
  layout();
}

/* ============================================================
 *  启动
 * ========================================================== */

boot().catch((err) => {
  console.error('[pet] boot failed', err);
  showStatus('模型加载失败：' + (err?.message || err));
});
