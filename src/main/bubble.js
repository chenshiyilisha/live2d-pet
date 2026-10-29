'use strict';

/* ============================================================
 *  悬浮气泡窗（白底圆角 + 一层柔和投影，尾巴尖指着她）
 * ==========================================================
 *
 * 为什么独立开一个窗口：半身取景下人物的**头顶离主窗顶还有一大截**
 * （实测窗口 342 DIP 高时头顶在 y≈137 —— 取景给头顶留了呼吸空间，
 * 别按「头顶贴窗顶」想当然）。主窗里没有头顶以上的空间，气泡放窗口里
 * 就必然压在人身上（老布局压胸口到腰那一段）。所以对话气泡搬进一个透明
 * 小窗，底边锚在**人物头顶**上方的屏幕上 —— 人物一根毛都不挡。
 *
 * 头顶 y 哪来：主进程实量（measureHead：capturePage 逐行扫 alpha，第一行
 * 有足够不透明像素的 y）。渲染层在模型挂载 / 布局变化时发 pet:head-measure
 * 来触发。量不出（软件合成下 canvas 糊成白块、alpha 全 1 → 量出 0；或还没
 * 量过）时退回贴窗顶的旧行为 —— 位置远一点，但绝不会飘到别处去。
 *
 * 垂直定位的真相（别被"窗口底边"这个词骗了）：
 *   气泡窗底边**不是**视觉上的气泡底 —— 尾巴尖（旋转方块的顶点）在窗口
 *   底边之上 TAIL_TIP_INSET px，再往下是给柔影留的空白。所以决定"离人远近"
 *   的是 tipGap(curH)（尾巴尖 ↔ 头顶，随气泡高度插值），窗口底边得再往下
 *   让 TAIL_TIP_INSET。这两个数与 bubble.html 的 CSS 是死联动（规矩 9 / 22），
 *   改一处必须对另一处（verify-bubble [H] 在校验）。
 *
 * 生命周期（由 main.js 驱动，本模块不解析聊天内容）：
 *   beginStream()  清空 + 定位 + 显示"…"等待态
 *   appendChunk()  流式逐字追加（高度自适应，底边锚定、往上长）
 *   appendThink()  一整段"心里想的"，显示在正文上方的小字行
 *   endStream()    摘掉等待态，AUTO_HIDE_MS 后自动淡出
 *   abortStream()  这轮失败，立刻藏
 *   showFull()     整段显示（say() 类临时播报：提醒 / 番茄钟播报）
 *
 * 跟随：主窗 move 时 syncPosition()（内部 33ms 节流，拖着她走气泡跟着飘）。
 * 贴顶兜底：头顶上方放不下（她被拖到屏幕顶部）时，气泡退回主窗内
 * 顶部 —— 会盖到一点脸，但比"凭空消失"强，这是极端位置下的取舍。
 *
 * 注入约定同 tts.js / recorder.js：configureBubble({ getWindow })，
 * 主窗引用用 getter 传，本模块不 require main.js。
 * ========================================================== */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { createArbiter } = require('./bubble-priority');

/* 气泡优先级：stream / alert / status，低级不抢高级（见 bubble-priority.js）。 */
const arbiter = createArbiter();
let streamToken = null;

/* 气泡窗宽**分档**（2026-10-28，方案 A3）：固定 272 时，长回复会长到 292 高，
 * 宽高比 0.93 —— 一根竖长条。改成高度涨上来时宽度跟着上一档，把宽高比拉回
 * 1.2 以上（tiny-roommate「prefer a landscape shape, avoid narrow tall boxes」；
 * dsh-pet 实测把主体比例从 1.65 调到 1.20 对齐参考图）。
 * ⚠️ 档位是唯一定义处（规矩 9）：MIN / MAX / 步长全从这里派生，别再写字面量。 */
/* 档位怎么定的：need = 页高 × 1.2，而页高的硬上限是 MAX_H(292)
 * （渲染层实际受 shell 的 max-height 236 限制，报上来最多约 265 —— 也就是
 * **真正会用到的是前两档**，第三档是给 MAX_H 附近留的余量：哪天把 shell 上限
 * 放开，不用回头改这里）。⚠️ 别凭手感加档：加一个永远够不到的档 = 死配置，
 * verify-bubble [J] 有「每一档都可达」这条断言在守。 */
const WIDTH_STEPS = [272, 320, 368];   // 272 = 现状（主窗 308，左右各收一点）
const WIDTH_MIN = WIDTH_STEPS[0];
const WIDTH_MAX = WIDTH_STEPS[WIDTH_STEPS.length - 1];
/* 宽高比下限：低于它就判定为"窄高盒"，该加宽了。上限**不卡**（见 wantWidth 注释）。 */
const ASPECT_MIN = 1.2;
/* 尾巴尖 ↔ 头顶的间隙**随气泡高度变**（2026-10-28，方案 B3）：矮气泡贴更近、
 * 高气泡多留呼吸 —— 出处 tiny-roommate 交互规范原文
 * "short bubbles closer, taller bubbles more breathing room"。
 * 插值端点就是 MIN_H / MAX_H（规矩 9：同一个数只在一处定义）。
 * ⚠️ 决定"离人远近"的是**尾巴尖**不是窗口底边，见下面 TAIL_TIP_INSET 那条注释。 */
const TIP_GAP_MIN = 8;
const TIP_GAP_MAX = 14;
/* 尾巴尖在气泡窗底边上方的距离 —— 由 bubble.html 的 CSS 几何决定：
 *   wrap 的 padding-bottom(21) − 尾巴旋转后最低点(15px 方块 bottom:15px 转 45°，
 *   中心在外壳底上方 1.5px，包围盒半高 10.6 → 最低点在外壳底下方 9.1px) ≈ 12。
 * ⚠️ 改 #tail 的尺寸/位置、或改 #wrap 的 padding-bottom / report() 里的数字，
 *    都要重算这里（verify-bubble [H] 在校验联动）。 */
const TAIL_TIP_INSET = 12;
const MEASURE_MIN_GAP_MS = 400;  // 头顶实量的节流
const MIN_H = 56;         // 窗口最小高（兜底下限；实际一句短话算出来约 79，用不到）
/* 窗口最大高。⚠️ 必须 ≥ 顶部留白 8 + 泡体上限(shell max-height 236 + padding
 * 上下 26) + 底部 21 = 291，否则长回复时窗口被夹矮、**尾巴和末行被裁**，
 * 而 shell 的内部滚动（overflow-y:auto）根本轮不到生效。
 * debug/verify-bubble.js 的 [H] 段从两个文件里切常量做这个校验。 */
const MAX_H = 292;
const AUTO_HIDE_MS = 9000; // 说完保留多久的**固定值**（与渲染层 say() 的 9000 对齐）
/* 停留时长随字数（D1，2026-10-28）：一句"好"和一段 150 字的解释都固定 9s，
 * 前者久得像卡住、后者不够读完。开 floatBubbleReadTime 时按字数在两端点间插值。
 * ⚠️ 这两个端点是**估的**（中文默读约 5~7 字/秒 + 起手反应时间），没有资料支撑，
 *    方案里标为可选 —— 所以留了开关，不喜欢就关掉回到固定 AUTO_HIDE_MS。
 * ⚠️ 只管悬浮气泡窗；主窗回退布局（#bubble）仍是固定 9000（回退路径不跟进美化）。 */
const READ_MS_MIN = 6000;
const READ_MS_MAX = 14000;
const READ_CHARS_MIN = 20;    // ≤ 这个字数 = 最短（一句话就能读完）
const READ_CHARS_MAX = 160;   // ≥ 这个字数 = 最长（再长也按最长算，别无限涨）
const FOLLOW_MS = 33;     // 主窗移动时的跟随节流
/* 出场淡出时长。**与 bubble.html 里 pop / fade 两个动画的时长是同一个数**
 * （那里写 0.16s）—— 主进程等它播完才真 hide，写短了动画被截断、写长了
 * 气泡已经透明了还占着窗口（verify-bubble [H] 在校验这条联动）。 */
const FADE_MS = 160;
/* 水平轻微随机化的幅度（2026-10-28，方案 B2）：气泡恒在正中上方，反复出现
 * 时机械感很重。±8px 是"看得出不一样、又看不出是随机"的量。
 * ⚠️ 只在**每句话开头**算一次（newUtterance），绝不能在 place() 里算 ——
 *    place() 被高度变化 / 拖拽高频调用，每次重算就会在流式打字时左右抖。 */
const JITTER_X = 8;
/* 候选位（2026-10-28，方案 B1/B4/B5）：泡体中线相对**人物中线**的水平偏移，
 * 单位 = 气泡宽的比例。出处 tiny-roommate：allowed family is top-left, top and
 * top-right —— **side 不参与**（侧边会挡住身体，且与"气泡在人物上方"冲突）。
 * ⚠️ 0.30 与下面 tailOffsetMax() 是**死联动**：偏移越大尾巴就得往回挪越多，
 *    挪出泡体就露馅（0.30×272=81.6 ≤ 272/2−26=110，verify-bubble [J] 在校验）。 */
const CAND_OFF = { top: 0, 'top-right': 0.30, 'top-left': -0.30 };
const CAND_ORDER = ['top', 'top-right', 'top-left'];
/* 退回窗内（头顶上方放不下）时的顺序：**先偏一侧**——气泡压在主窗顶部会盖脸，
 * 挪到左上/右上是"盖肩膀"而不是"盖脸"（dsh-pet 安全布局器：优先零相交）。 */
const CAND_ORDER_INSIDE = ['top-right', 'top-left', 'top'];

/* 尾巴横向回正的上限（原固定 40，改成随宽度算 —— 候选位偏移会超过 40）。
 * 尾巴是 15px 方块转 45°，旋转后包围盒半宽 ≈10.6；泡体底边还有 18px 圆角，
 * 所以中心最多挪到「半宽 − 26」处，再远尾巴就跑到圆角外、像后贴上去的方块。 */
function tailOffsetMax(w) {
  return Math.max(40, Math.round(Number(w) / 2 - 26));
}

let getWindow = () => null;   // () => mainWindow | null（注入）
let win = null;
let hideTimer = null;
let followTimer = null;
let lastFollow = 0;
let curH = MIN_H;        // 当前窗口高度（底边锚定，随内容长高）
/* 当前窗口宽（A3：随高度上浮一档，**一次发言内单调不减**，见 wantWidth）。
 * 每句话开头重置回 WIDTH_MIN，见 newUtterance()。 */
let curW = WIDTH_MIN;
let candName = 'top';    // 这一句选中的候选位（诊断用，place() 里更新）
let insideMode = false;  // true = 贴顶兜底，气泡退回主窗内部
let headTop = null;      // 人物头顶在主窗内容区里的 y（DIP，实量）。null = 还没量到
let measureTimer = null;
let shotSeq = 0;
let fadeTimer = null;     // 出场淡出中（播完才真 hide）
let utterSeq = 0;         // 第几句话（位置随机化的种子，递增 → 可复现）
/* 这一句已经吐出去多少字（D1：决定说完之后停留多久）。⚠️ 只统计**正文**
 * （appendChunk），想法那一行不算 —— 那是她没打算说出口的，不算"要读的字"。 */
let utterChars = 0;
/* 这句话的情绪标签（情绪角标的信号源）。来自 [emo:xxx]，流式末尾整段到达；
 * **跟标签走、不跟脸上的衰减走**（规矩 33：情绪标签本来就不随衰减改 ——
 * 角标要是跟着衰减变淡消失，看起来像坏了）。null = 没挂牌（calm / 整段播报）。 */
let curEmotion = null;
let jitterX = 0;          // 本句话的水平偏移（place() 里只读，不重算）
let tailOffset = null;    // 已下发给渲染层的尾巴回正量（null = 还没发过）

function enabled() {
  try {
    const { loadConfig } = require('./config');
    return loadConfig().chat?.floatBubble !== false;
  } catch {
    return false;
  }
}

/* 气泡的两个外观开关（规矩 4：新能力一律走配置）。
 * 都是**现读**：改完 config.json 下一句话就生效，不用重启（与 enabled() 同款）。
 * 不进托盘 —— 规矩 5：菜单要短；这两个都只是"改观感"的参数，手改配置文件即可。
 *   floatBubbleOutline 默认**关**：用户在 2026-10-13 连着两轮把描边减掉
 *   （3px → 1.5px → "只留一层很柔的投影"），描边是改观感的东西，交回给他决定；
 *   浅色壁纸上白气泡糊掉时再开。见 bubble.html 里 body.outline 那条注释。
 *   floatBubbleJitter 默认开：纯去机械感，不占资源、不打扰。 */
function chatOpt(key, def) {
  try {
    const v = require('./config').loadConfig().chat?.[key];
    return typeof v === 'boolean' ? v : def;
  } catch {
    return def;
  }
}
const outlineOn = () => chatOpt('floatBubbleOutline', false);
const jitterOn = () => chatOpt('floatBubbleJitter', true);
const widenOn = () => chatOpt('floatBubbleWiden', true);
const asideOn = () => chatOpt('floatBubbleAside', true);
const caretOn = () => chatOpt('floatBubbleCaret', true);
const readTimeOn = () => chatOpt('floatBubbleReadTime', true);
const moodBadgeOn = () => chatOpt('floatBubbleMoodBadge', true);

/* 字数 → 停留多久（纯函数，回归直接断言，见 verify-bubble [K]）。
 * 短话取 READ_MS_MIN、长话取 READ_MS_MAX，中间线性插值。 */
function readTimeMs(chars) {
  const c = Number(chars) || 0;
  const t = (c - READ_CHARS_MIN) / (READ_CHARS_MAX - READ_CHARS_MIN);
  const k = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return Math.round(READ_MS_MIN + (READ_MS_MAX - READ_MS_MIN) * k);
}

/* 尾巴尖 ↔ 头顶的间隙（纯函数，便于断言）。 */
function tipGap(h) {
  const t = (Number(h) - MIN_H) / (MAX_H - MIN_H);
  const c = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  return Math.round(TIP_GAP_MIN + (TIP_GAP_MAX - TIP_GAP_MIN) * c);
}

/* 确定性小散列：序号 → [-span, span] 的整数。
 * 不用 Math.random —— 同一序号每次跑出来一样，回归里才能断言"有界但不固定"。 */
function hashJitter(n, span) {
  let x = Math.imul(n | 0, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  /* 🔴 `^` 的结果在 JS 里是**有符号** int32 —— 前面那两个 `>>> 0` 白做了，
   * 走到这里 x 又变回负数，于是 `x % 17` 也跟着是负的，减 span 之后能到 -25
   * （真机实测 jitter 出现过 −18 / −21 / −23，而 JITTER_X 写的是 8）。
   *    这个 bug 是"静默"的：输出看起来就是个合理的偏移量，只是比承诺的
   *    大三倍 —— 气泡肉眼可见地左右晃得更多，但谁也不会怀疑是随机函数越界了。
   * 取模前必须再拉回无符号（verify-bubble [J] 有一条范围断言在守这个）。 */
  x = x >>> 0;
  return (x % (2 * span + 1)) - span;
}

/* 内容高度 → 该多宽（纯函数，A3 的全部规则都在这里，便于回归直接断言）。
 *
 * 🔴 **单调不减**（need 至少不小于当前宽）—— 这是防回路的关键：
 *   加宽 → 行数变少 → 高度回落 → 若照"变矮就该变窄"把宽度收回去 → 行数又变多
 *   → 高度涨回来 → 又加宽…… 流式打字期间气泡会来回抖。用 cur 兜底就把这条
 *   回路一刀切断：**变矮只是让宽高比更宽裕，宽度不再回头**。
 *   每句话开头（newUtterance）重置回 WIDTH_MIN，下一句重新长。
 *
 * ⚠️ 只卡**下限** ASPECT_MIN，不卡上限：方案里那句 1.2~2.2 的上限是从 dsh-pet
 *   对**自己那张参考图**量出来的（它是整段渲染、没有流式），我们一句短话
 *   h≈79 时 w=272 已经是 3.4 —— 硬收到 2.2 要把气泡缩到 174 宽、比主窗窄一半，
 *   看着像贴纸。横条是自然的（微信短气泡就是横条），被禁的只有"窄高"。
 */
function wantWidth(h, cur, avail) {
  const cap = Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.floor(Number(avail) || WIDTH_MAX)));
  const need = Math.max(Number(cur) || WIDTH_MIN, Math.ceil((Number(h) || 0) * ASPECT_MIN));
  for (const w of WIDTH_STEPS) {
    if (w >= need && w <= cap) return w;
  }
  /* 没有合用的档（屏幕比档还窄，或 need 已超过最大档）→ 夹到 [WIDTH_MIN, cap]。 */
  return Math.max(WIDTH_MIN, Math.min(cap, Math.round(need)));
}

/* 挑候选位（纯函数，摆位的全部决策都在这里）。
 *
 * 常规恒 **top**：正上方指着她最自然。左右候选只在两种场合启用 ——
 *   ① top 想要的 x 被屏幕边 clamp（她被拖到屏幕边上）：换到另一侧，泡体不贴边，
 *      **尾巴也不用大幅回正**（这才是它真正的价值，不只是"去机械感"）；
 *   ② inside（头顶上方放不下、气泡退回主窗内）：优先偏到一侧，盖肩膀而不是盖脸。
 *
 * 可用判据 = 「它想要的 x 不需要被 clamp」 —— 简单、且**不需要知道人物有多宽**
 * （规矩 2 / 22：不写死取景常数），跨屏也天然成立（wa 已由 getDisplayMatching 选好）。
 */
function pickAnchor({ cx, w, jitter, wa, inside, aside }) {
  const lo = wa.x + 4;
  const hi = wa.x + wa.width - w - 4;
  const clamp = (x) => Math.max(lo, Math.min(hi, x));
  const raw = (name) => Math.round(cx + CAND_OFF[name] * w - w / 2 + jitter);
  const order = !aside ? ['top'] : (inside ? CAND_ORDER_INSIDE : CAND_ORDER);
  for (const name of order) {
    const x = raw(name);
    if (clamp(x) === x) return { name, x };
  }
  return { name: 'top', x: clamp(raw('top')) };   // 全被夹（屏幕比气泡还窄）→ 居中
}

/* 每句话开头算一次"这一句的气质"。⚠️ 只在这里算偏移，place() 不许重算。
 * 宽度也在这里**重置**：上一句话的长回复把气泡撑到最宽档，不能留给下一句短话。 */
function newUtterance() {
  utterSeq += 1;
  jitterX = jitterOn() ? hashJitter(utterSeq, JITTER_X) : 0;
  curW = WIDTH_MIN;
  utterChars = 0;
  curEmotion = null;
}

/* 情绪角标的信号（主进程唯一出口 emitChatEmotion 调到这里，规矩 27）。
 * ⚠️ 不在这里校验"合法情绪集"—— 集合是**模型档案**的属性（鲸鱼娘跟 hiyori
 *   不必相同），主进程不该写死。原样透传，渲染层的映射表把 8 个写全、
 *   认不出的**藏掉**（回退），谁来都能工作。
 * ⚠️ 开关关掉 → 直接发 null 清牌（现读，下一句话生效，不用重启）。 */
function setEmotion(e) {
  curEmotion = moodBadgeOn() && typeof e === 'string' && e ? e : null;
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:emotion', curEmotion);
  } catch { /* 气泡窗刚关：下一句 reveal 时会补发 */ }
}

/* 内容高度 → 窗口高度（渲染层报的是它量出的整页高度）。 */
function onContentHeight(h) {
  if (!win) return;
  const n = Math.max(MIN_H, Math.min(MAX_H, Math.round(Number(h) || MIN_H)));
  if (Math.abs(n - curH) < 4) return;   // 抖动过滤：差一点就别折腾 setBounds
  curH = n;
  place();
}

/* 摆位置：水平对齐人物中线（人物恒居中于主窗，规矩 20），再叠加本句话的
 * 轻微随机偏移（jitterX）；**尾巴尖**锚在人物头顶上方 tipGap(curH) 处
 * （headTop 实量；没量到就退回窗顶 —— 远，但方向不会错）。
 * 高度变化只往上长、人视角下气泡扎根在头顶。 */
function place() {
  if (!win || win.isDestroyed()) return;
  const main = getWindow();
  if (!main || main.isDestroyed()) return;

  const b = main.getContentBounds();   // ⚠️ 规矩 20：锚 contentBounds，别用 getBounds
  const d = screen.getDisplayMatching(b);
  const wa = d.workArea;

  /* 宽度：随内容高度上一档（A3）。放在 place() 里而不是另起流程 —— 它本来就是
   * "布局"的一部分，这样也只 setBounds 一次（改宽→渲染层重排→再改高会闪）。 */
  curW = widenOn() ? wantWidth(curH, curW, wa.width - 8) : WIDTH_MIN;

  const cx = b.x + b.width / 2;                       // 人物中线（人物恒居中，规矩 20）

  const anchorY = b.y + (headTop ?? 0);              // 头顶的屏幕 y（没量到 = 窗顶）
  const bottomY = anchorY - tipGap(curH) - TAIL_TIP_INSET; // 气泡窗底边的屏幕 y
  insideMode = bottomY - curH < wa.y + 4;             // 头顶上方放不下 → 退回窗内
  let y;
  if (insideMode) {
    y = b.y + 6;
  } else {
    y = bottomY - curH;
  }

  /* 候选位：常规恒 top；被屏幕边夹住 / 退回窗内时才挪到左上或右上（见 pickAnchor）。 */
  const pick = pickAnchor({
    cx, w: curW, jitter: jitterX, wa, inside: insideMode, aside: asideOn()
  });
  candName = pick.name;
  win.setBounds({ x: pick.x, y, width: curW, height: curH });

  /* 尾巴回正：泡体被随机偏移、挪到侧候选、或被屏幕边 clamp 之后，它的中线不再
   * 压在人物中线上，尾巴就得往回挪同样的距离 —— 否则尾巴尖不再指着她
   * （尾巴恒在泡体正中）。
   * ⚠️ 这条是 dsh-pet 记录过的"尾巴方向错/像后贴上去"那类问题的预防：
   *    位置一变，尾巴必须跟着变。上限随宽度算，见 tailOffsetMax()。 */
  const want = Math.round(cx - (pick.x + curW / 2));
  const maxOff = tailOffsetMax(curW);
  applyTailOffset(Math.max(-maxOff, Math.min(maxOff, want)));
  diagPlace(y);
}

/* 尾巴回正量下发给渲染层（只在变化时发：拖拽时 place() 是 33ms 一拍的高频调用）。 */
function applyTailOffset(v) {
  if (v === tailOffset) return;
  tailOffset = v;
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:tail', v);
  } catch { /* 窗正在销毁：下一句话会重发 */ }
}

/* 诊断口子：PET_SNAPSHOT 含 "bubble" 时打一行摆位日志（跟 snapshotSelf 同门）。 */
function diagPlace(y) {
  const tag = String(process.env.PET_SNAPSHOT || '');
  if (!tag.includes('bubble')) return;
  const main = getWindow();
  console.log('[bubble] place', JSON.stringify({
    headTop, y, w: curW, h: curH, cand: candName, gap: tipGap(curH), jitter: jitterX,
    tailOffset, tipInset: TAIL_TIP_INSET, mainTop: main?.getContentBounds().y ?? null
  }));
}

/* ---------- 人物头顶实量 ----------
 * capturePage 拿主窗一帧，从上往下找第一行"有足够不透明像素"的 y。
 * 只量顶部所以底座牌不干扰（它在底部，规矩 23 只坑"整窗包围盒"）。
 * 软件合成下 canvas 糊成不透明白块 → 量出 0 → 退回贴窗顶，无害。
 * 渲染层在模型挂载 / 布局变化时触发，这里节流。 */
async function measureHead() {
  const main = getWindow();
  if (!main || main.isDestroyed()) return;
  try {
    const img = await main.webContents.capturePage();
    if (img.isEmpty()) return;
    const { width, height } = img.getSize();
    if (!width || !height) return;
    const dipW = main.getContentBounds().width;
    if (dipW <= 0) return;
    const dpr = width / dipW;
    const bmp = img.getBitmap();          // BGRA，alpha 在每像素第 4 字节
    let top = -1;
    for (let y = 0; y < height && top < 0; y++) {
      let cnt = 0;
      for (let x = 6; x < width - 6; x += 2) {
        if (bmp[(y * width + x) * 4 + 3] > 40) {
          if (++cnt >= 4) { top = y; break; }
        }
      }
    }
    if (top < 0) return;                  // 全透明帧（模型还没画出来），丢弃
    const dip = Math.round(top / dpr);
    if (dip !== headTop) {
      headTop = dip;
      if (win && !win.isDestroyed() && win.isVisible()) place();
    }
  } catch { /* 窗口正在销毁 / capturePage 失败：下次布局再量 */ }
}

/* 头顶锚点（**屏幕坐标**）：给别的"头顶浮层"用（泡泡菜单）。
 * 🔴 headTop 是**窗内**坐标，必须配 contentBounds 换算 —— 规矩 20：锚
 *    getContentBounds()，绝不用 getBounds() 反推。x 取人物中线（人物恒居中）。
 * ⚠️ 还没量到（headTop 为 null，模型没画出来 / 软件合成糊成白块）时退回窗顶：
 *    位置会高一点，但**绝不会飘到别处去** —— 与 place() 的 fail-open 同源。
 *    规矩 9：这条换算只有这一处，别在别处再拼一次 b.y + headTop。 */
function headAnchor() {
  const main = getWindow();
  if (!main || main.isDestroyed()) return null;
  const b = main.getContentBounds();
  return {
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + (headTop != null && headTop > 0 ? headTop : 0))
  };
}

function requestMeasure() {
  if (measureTimer) return;               // 已有排队中的量，节流
  measureTimer = setTimeout(() => {
    measureTimer = null;
    measureHead();
  }, MEASURE_MIN_GAP_MS);
}

function ensureWin() {
  if (win && !win.isDestroyed()) return win;
  curH = MIN_H;
  curW = WIDTH_MIN;    // 新窗从最窄档重新长（上一句的宽度不能带过来）
  tailOffset = null;   // 新窗 = 新页面，尾巴偏移得重新下发一次
  win = new BrowserWindow({
    width: WIDTH_MIN,
    height: MIN_H,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,          // 透明窗必须关系统阴影，否则整块灰框
    resizable: false,
    movable: false,
    focusable: false,          // 不抢聊天输入框的焦点
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'bubble-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 盖过主窗的置顶层（主窗是普通 alwaysOnTop；气泡悬浮其上，位置不重叠但保险）
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'bubble.html'));
  win.on('closed', () => { win = null; });
  return win;
}

function clearHideTimer() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function clearFadeTimer() {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
}

/* 显示 + 起入场动画。
 * ⚠️ 顺序不能反：动画必须在 **showInactive 之后** 才发。气泡窗是复用的
 *    （懒创建一次、之后靠 show/hide 反复出现），动画挂在 body 上只会在页面
 *    加载时播一次；而现在由主进程每次下发，所以第二句话起也一定有入场。
 *    ⚠️ 反过来的话：0.16s 里有一部分在窗口还藏着的时候就消耗掉了，用户看到
 *    的就是"淡到一半突然全亮"。 */
function reveal(w) {
  clearFadeTimer();          // 正在淡出又被叫回来说话：取消那次 hide
  w.showInactive();          // 不抢焦点
  try {
    w.webContents.send('bubble:show', {
      outline: outlineOn(), caret: caretOn(), badge: moodBadgeOn()
    });
    /* 情绪跟上（showFull / begin 都把 curEmotion 清了，正常是 null；
     * 万一情绪先到、窗口后建，这里补发一次，角标不丢）。 */
    if (curEmotion) w.webContents.send('bubble:emotion', curEmotion);
  } catch { /* 页面还没好：这一句没有入场动画，气泡照常显示（fail-open） */ }
}

/* 说完之后停留多久（D1）。字数在 endStream 时已经累计完，这里只读。
 * ⚠️ 关掉 floatBubbleReadTime 就回到固定 AUTO_HIDE_MS —— 那条"估出来的"区间
 *    必须能一键退出，否则不喜欢的人只能改代码。 */
function scheduleAutoHide() {
  clearHideTimer();
  const ms = readTimeOn() ? readTimeMs(utterChars) : AUTO_HIDE_MS;
  hideTimer = setTimeout(() => { hideNow(); }, ms);
}

/* 诊断口子：PET_SNAPSHOT 含 "bubble" 时，气泡落定后给自己拍个照。 */
function snapshotSelf() {
  const tag = String(process.env.PET_SNAPSHOT || '');
  if (!tag.includes('bubble') || !win || win.isDestroyed()) return;
  const seq = ++shotSeq;
  setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const img = await win.webContents.capturePage();
      const dir = path.join(process.cwd(), 'debug');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `pet-bubble-${seq}.png`), img.toPNG());
      console.log(`[bubble] shot #${seq} saved`);
    } catch (err) {
      console.log('[bubble] shot failed:', String(err?.message || err));
    }
  }, 1200);
}

/* ---------- 对外 API ---------- */

function beginStream() {
  clearHideTimer();
  const gate = arbiter.acquire('stream');
  if (!gate.ok) return;           // 被更高优先级占着（极少见）
  streamToken = gate.token;
  if (!enabled()) return;
  try {
    const w = ensureWin();
    newUtterance();                       // 这一句的位置随机化（只算一次）
    w.webContents.send('bubble:begin');
    curH = MIN_H;
    place();
    reveal(w);
  } catch (err) {
    console.warn('[bubble] begin failed:', String(err?.message || err));
  }
}

function appendChunk(text) {
  if (!enabled()) return;
  if (streamToken != null && !arbiter.allowsAppend(streamToken)) return;
  try {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { newUtterance(); curH = MIN_H; place(); reveal(win); }
    utterChars += String(text).length;   // 停留时长的输入（D1）
    win.webContents.send('bubble:chunk', String(text));
  } catch { /* 气泡窗刚关：主窗照常收 chunk，气泡这一轮缺席 */ }
}

/* 「心里想的」那一行（[think:…] 的内容）。
 * 整段到达、不进正文 —— 但**不能进 appendChunk**：那段文本会进 TTS 和聊天历史，
 * 想法是没打算说出口的，混进去就等于当众念出心声了。
 * 与前缀无关的另一个通道，故单独一个函数。 */
function appendThink(text) {
  if (!enabled()) return;
  if (streamToken != null && !arbiter.allowsAppend(streamToken)) return;
  try {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) { newUtterance(); curH = MIN_H; place(); reveal(win); }
    win.webContents.send('bubble:think', String(text));
  } catch { /* ignore */ }
}

function endStream() {
  arbiter.release(streamToken);
  streamToken = null;
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:end');
  } catch { /* ignore */ }
  snapshotSelf();
  scheduleAutoHide();
}

function abortStream() {
  arbiter.release(streamToken);
  streamToken = null;
  clearHideTimer();
  try {
    if (win && !win.isDestroyed()) win.webContents.send('bubble:abort');
  } catch { /* ignore */ }
}

/* say() 类整段播报（提醒 / 番茄钟 / 主动搭话的离线分支）—— alert 级，可盖住 status。 */
function showFull(text, autoHideMs = AUTO_HIDE_MS) {
  clearHideTimer();
  const gate = arbiter.acquire('alert');
  if (!gate.ok) return;
  /* alert 占位后 stream 被挤掉 —— 清掉旧 token，避免迟到的 endStream 误清 alert */
  streamToken = null;
  if (!enabled()) {
    arbiter.release(gate.token);
    return;
  }
  try {
    const w = ensureWin();
    newUtterance();
    w.webContents.send('bubble:full', String(text));
    curH = MIN_H;
    place();
    reveal(w);
    snapshotSelf();
    hideTimer = setTimeout(() => {
      arbiter.release(gate.token);
      hideNow();
    }, Math.max(2000, autoHideMs));
  } catch (err) {
    arbiter.release(gate.token);
    console.warn('[bubble] showFull failed:', String(err?.message || err));
  }
}

/* 工作状态短句（status 级）—— 对话流进行中时不抢气泡。 */
function showStatus(text, autoHideMs = 2800) {
  clearHideTimer();
  const gate = arbiter.acquire('status');
  if (!gate.ok) return false;
  if (!enabled()) {
    arbiter.release(gate.token);
    return false;
  }
  try {
    const w = ensureWin();
    newUtterance();
    w.webContents.send('bubble:full', String(text));
    curH = MIN_H;
    place();
    reveal(w);
    hideTimer = setTimeout(() => {
      arbiter.release(gate.token);
      hideNow();
    }, Math.max(1200, autoHideMs));
    return true;
  } catch (err) {
    arbiter.release(gate.token);
    console.warn('[bubble] showStatus failed:', String(err?.message || err));
    return false;
  }
}

/* 收起气泡。默认走 FADE_MS 淡出再真 hide —— 入场有 pop、出场却是"啪"一下
 * 消失，这个不对称是最容易被感知的（2026-10-28 补，方案 C1）。
 *
 * immediate = true 用于**必须立刻消失**的场合：
 *   全屏静默（气泡盖在全屏应用上，多 160ms 也是盖）、dispose 前。
 * ⚠️ 淡出期间若又开始说话，reveal() 会取消这次 hide（见 clearFadeTimer）。 */
function hideNow(immediate) {
  clearHideTimer();
  arbiter.reset();
  streamToken = null;
  if (!win || win.isDestroyed() || !win.isVisible()) { clearFadeTimer(); return; }
  if (immediate) {
    clearFadeTimer();
    try { win.hide(); } catch { /* ignore */ }
    return;
  }
  if (fadeTimer) return;                  // 已经在淡出了，别再排一次
  try { win.webContents.send('bubble:fade'); } catch { /* ignore */ }
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    try {
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    } catch { /* ignore */ }
  }, FADE_MS);
}

/* 主窗 move/resize 时跟随（拖着她走，气泡跟着飘）。 */
function syncPosition() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  const now = Date.now();
  if (now - lastFollow < FOLLOW_MS) {
    if (!followTimer) {
      followTimer = setTimeout(() => {
        followTimer = null;
        lastFollow = Date.now();
        place();
      }, FOLLOW_MS);
    }
    return;
  }
  lastFollow = now;
  place();
}

/* 托盘开关切到关：立刻藏 + 销毁窗（下次开再懒创建）。 */
function refreshConfig() {
  if (!enabled()) hideNow();
}

/* 全屏静默：气泡浮在 alwaysOnTop 顶层会盖住全屏应用，进静默必须收掉。
 * 退出静默不恢复 —— 对话早就结束了，没有"恢复"可言。 */
function setQuiet(on) {
  if (on) hideNow(true);   // 静默要立刻收：淡出的 160ms 里它仍盖在全屏应用上
}

function dispose() {
  clearHideTimer();
  clearFadeTimer();
  arbiter.reset();
  streamToken = null;
  if (followTimer) { clearTimeout(followTimer); followTimer = null; }
  if (measureTimer) { clearTimeout(measureTimer); measureTimer = null; }
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
  win = null;
}

function configureBubble({ getWindow: get }) {
  if (typeof get === 'function') getWindow = get;
}

function registerBubbleIpc() {
  ipcMain.on('bubble:height', (_e, h) => onContentHeight(h));
}

module.exports = {
  configureBubble,
  registerBubbleIpc,
  requestMeasure,
  headAnchor,
  beginStream,
  appendChunk,
  appendThink,
  endStream,
  abortStream,
  showFull,
  showStatus,
  hideNow,
  syncPosition,
  refreshConfig,
  setQuiet,
  dispose,
  /* 测试与诊断用 */
  _state: () => ({
    alive: !!(win && !win.isDestroyed()),
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    w: curW,
    h: curH,
    cand: candName,
    inside: insideMode,
    headTop,
    fading: !!fadeTimer,
    jitter: jitterX,
    tailOffset,
    gap: tipGap(curH),
    /* 诊断：这一句已累计的正文字数、以及说完之后会停多久（D1）。
     * 只读，产品逻辑不依赖它 —— 停留时长是 scheduleAutoHide() 里算的。 */
    chars: utterChars,
    hideMs: readTimeOn() ? readTimeMs(utterChars) : AUTO_HIDE_MS,
    emotion: curEmotion,
    priority: arbiter.peek()
  }),
  _arbiter: arbiter,
  /* 窗口引用：只给 debug 脚本截图用（真实气泡窗的观感只有看图才知道对不对，
   * 而它又是懒创建的、外部拿不到）。**产品代码不许用它**。 */
  _win: () => win,
  /* 纯函数出口（摆位 / 选宽的全部规则，回归**直接调用**这几个，见 verify-bubble [J]） */
  _tipGap: tipGap,
  _hashJitter: hashJitter,
  _wantWidth: wantWidth,
  _pickAnchor: pickAnchor,
  _tailOffsetMax: tailOffsetMax,
  /* 情绪角标的信号入口（main.js 的 emitChatEmotion 调，规矩 27 唯一出口） */
  setEmotion,
  /* 停留时长的纯函数（D1，回归直接调，见 verify-bubble [K]） */
  _readTimeMs: readTimeMs,
  _const: {
    WIDTH_STEPS, WIDTH_MIN, WIDTH_MAX, ASPECT_MIN, MIN_H, MAX_H,
    CAND_OFF, CAND_ORDER, CAND_ORDER_INSIDE,
    AUTO_HIDE_MS, READ_MS_MIN, READ_MS_MAX, READ_CHARS_MIN, READ_CHARS_MAX
  }
};
