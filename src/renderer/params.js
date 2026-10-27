/* 情绪引擎 + 模型注册表。
 *
 * 这一层的定位是「**跨模型共享的机制**」：错峰插值的引擎函数、摸头
 * A-B-C 的时序常数、情绪衰减的心理学曲线、安定判据。全是常量与纯函数，
 * 没有 DOM、没有 pixi、没有任何运行时状态。
 *
 * **模型专属的数据**（几何标定 / 参数 ID 表 / 情绪姿态数值 / 错峰节奏）
 * 在 profiles/<name>.js —— 加角色是加档案，不是改引擎。注册表只负责
 * 把当前档案的数据以旧名字 re-export（pet.js / diag.js / verify 都从
 * 这里拿，不直接碰 profiles —— 换模型时消费方一行都不用改）。
 *
 * ⚠️ 唯一的可变导出是 P（当前生效的参数表）。ESM 的 import 绑定是**只读**的，
 *    所以只能在**本文件内**改它；别的模块 import { P } 之后只读
 *    P.MOUTH_OPEN —— 这是有意为之。
 */

import { HIYORI } from './profiles/hiyori.js';
import { WHALE } from './profiles/whale.js';

/* ============================================================
 *  模型注册表 + 当前模型
 *
 *  加新模型的全部手续：profiles/ 新建一份档案 + 下面 import 进来 +
 *  注册进 MODELS。MODEL_NAME 只在这里写一次当前用的档案键。
 * ========================================================== */

export const MODELS = { [HIYORI.name]: HIYORI.model, [WHALE.name]: WHALE.model };

/* 当前模型的档案键 —— 全项目只在这里写一次这个字符串。
 * 主进程、渲染层、诊断脚本都引用它，免得再出现「配置里写一个名字、
 * 代码里比对另一个名字」这种两边不一致。
 * ⚠️ 切模型目前是**改这一行**（whale 接入验证中，还没做运行时切换）。 */
export const MODEL_NAME = WHALE.name;

/* 当前档案的数据表（以旧名字导出 —— pet.js / diag.js / verify 的进口）。 */
export const PARAM = WHALE.param;
export const EMOTION = WHALE.emotion;
export const EMO_RANGE = WHALE.emoRange;
export const PAT_DELTA = WHALE.patDelta;
export const EMO_SPEED = WHALE.emoSpeed;

/* 当前生效的参数表。
 *
 * 这里原本还有一张按模型改写参数名的别名表（给参数命名不同的那套素材兜底：
 * 比如有的素材脸红参数叫 ParamTere、且根本没有肩参数）以及配套的
 * refreshParamTable()。单一模型后别名无从谈起，两张表一起删了。
 * 多模型化后别名表回来了 —— 就是现在 profiles 里的 param 档案
 * （缺键 = 该模型没有这器官，pet.js 的 put() 自动跳过）。 */
export let P = { ...PARAM };

export const State = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  SLEEP: 'sleep'
};

/* 墨水顶部相对画布高 vh 的比例项（C = vh × 这个值）—— **只是回退默认值**。
 * 实际取值在 **模型档案的 inkTopCRatio**（pet.js: `?? INK_TOP_C_RATIO`），
 * 换模型时以档案为准；这个值只在档案没写该键时兜底。
 *
 * 0.2 的来历（hiyori）：vh=1211.2 → C=242.2、vh=1623.2 → C≈326.8，1/5 与
 * 两档都吻合（残差 <3px，那是 hiyori 呆毛太细、像素判定吃掉的）。
 *
 * 🔴 **旧注释写的「与模型本身无关」已被证伪（2026-10-25）—— 别再信。**
 * 鲸鱼娘实测是 **0.328**（写死在 profiles/whale.js 里，hiyori 的 0.2 差了
 * 64%）。当时是靠 hiyori 一档就下了"模型无关"的结论，之后拿 0.2 去标定
 * 第二个模型，拟合时被"三档窗口高全用同一个 petScale"的共线数据骗了，
 * 直到换一组 petScale 复验才暴露（残差 81css）。
 * → 取景常数一律**逐模型实测**，至少两组不同的 petScale（规矩 2）。 */
export const INK_TOP_C_RATIO = 0.2;

/* ============================================================
 *  摸头（按住）—— A-B-C 三段式
 *
 *  设计参考 VPet 的 AnimatType（A_Start 起手 / B_Loop 循环 / C_End 收尾），
 *  核心那一条是：**B 段持续多久由用户的手决定，不由动画文件长度决定**。
 *  原来我们只有"点一下播一个 TapBody（单次）"，按住不放什么都不发生。
 *
 *  ⚠️ 但**不能照搬 VPet 的实现**（它是播三段 PNG 序列帧）。原因是
 *     Hiyori 没有"主人的手"这个部件，摸头只能靠**她自己的反应**表达 ——
 *     而那组反应参数（眉 / 眼 / 嘴 / 脸红 / 肩 / 头角 / 呆毛 / 身体）
 *     恰好就是情绪表的字段，每帧由 applyEmotion() 独占写。
 *     拿 motion 去写同样的通道 → **每帧被覆盖**，等于没写
 *     （同 2026-10-13 那个 headY 被 focus 覆盖掉的坑，见 pet.js 主循环注释）。
 *
 *  所以 A-B-C 做在**情绪目标**上：
 *     A 起手 = patAmt 0→1（快），再叠上错峰插值本身的爬升
 *     B 循环 = patAmt 保持 1 + 低频摆动（按住多久就晃多久）
 *     C 收尾 = patAmt 1→0（慢 —— 手拿开她还留恋一下）
 *  白拿一样东西：错峰插值带来的"活人感"（眉先动、脸红后上来）。
 *
 *  这组是**交互节奏的心理学常数**（手感），不随模型变 —— 模型侧的
 *  摸头数据（往哪些通道叠多少）在档案的 patDelta 里。
 * ========================================================== */

export const PAT = {
  /* patAmt 的上升 / 回落速度（1/秒，线性斜坡）。
   * 一快一慢是**故意不对称**的：手放上去要立刻有反应（跟手），
   * 手拿开则要愣一下才回神。两个都设成一样就变成"开关"了。 */
  rise: 6,          // ≈0.17s 到 1
  fall: 1.4,        // ≈0.71s 回 0
  shyMs: 1400,      // 按住这么久 → 从 happy 转 shy（蹭久了会害羞）
  nagMs: 3000,      // 按住这么久 → 抗议一句（摸太久了）
  /* 按住这么久 → 她**自己去挣脱**：不等你松手，patAmt 自己回落。
   * 参考 VirtualCockroach 的抚摸分级（舒服 → 提醒 → 烦 → 强行挣脱），
   * 我们原来只做到"烦"（nagMs），手不松开她就会一直由着你摸。
   * ⚠️ 必须 > nagMs：先抗议、不听再挣脱，反过来就是"没提醒就翻脸"。 */
  escapeMs: 8000,
  /* B 段摆动频率（Hz）。0.55 ≈ 一个来回 1.8s —— 慢才有"被顺毛"的感觉，
   * 快了就成了抖。 */
  wiggleHz: 0.55
};

/* 有效情绪目标 = 基础情绪 + 摸头调制，逐字段夹回 EMO_RANGE。
 *
 *  纯函数（无 DOM、无状态、不分配）—— 所以 verify-expressive.js 能
 *  直接 import 真调，断言三件事：
 *    · amt === 0 时 out 与 base **逐字段全等** → 没摸头时零侵入
 *    · amt === 1 时对 8 个情绪都不越界 → 夹取真的生效
 *    · 摆动真的让通道错峰（相位偏移不是摆设）
 *
 *  ⚠️ out 由调用方**复用**（主循环里每帧一次，不能新建对象）。 */
export function buildEmoTarget(out, base, amt, phase) {
  if (!(amt > 0)) {
    for (const k in base) out[k] = base[k];
    return out;
  }
  for (const k in base) {
    let v = base[k];
    const d = PAT_DELTA[k];
    if (d) {
      const wig = d.w * (Math.sin(phase + d.s) * 0.7 + Math.sin(phase * 1.63 + d.s * 1.4) * 0.3);
      v += amt * (d.a + wig);
      const r = EMO_RANGE[k];
      if (r) { if (v < r[0]) v = r[0]; else if (v > r[1]) v = r[1]; }
    }
    out[k] = v;
  }
  return out;
}

/* EMOTION 里出现、但 EMO_SPEED 没列的字段兜底用什么速度。
 * ⚠️ 它存在的意义是**别让插值崩**，不是"可以少写好几项"——
 *    真走了这里说明档案的 emoSpeed 漏了字段，verify-expressive.js 会报红。 */
export const EMO_SPEED_DEFAULT = 5.5;

/* ============================================================
 *  「情绪安定」—— 主动搭话要等的那个条件
 *
 *  出处是竞品调研里 soullink 的 `isVADSettled()`：开话头的时机不该由
 *  「过了多久」单独决定，还要看**当前这股情绪有没有平息**。
 *  它那边量的是说话人的音量包络，我们这边量的是**她自己的表情参数**
 *  离目标还有多远 —— 同一件事在两种输入下的同一个抽象。
 *
 *  口径：取全部字段里**最大**的偏差（不是平均值）。
 *  用最大值是因为一个字段没到位，脸上就是有块地方在动；
 *  平均会被十几个已经到位的字段稀释掉，"眉毛还在挑着"也被算成安定。
 *
 *  阈值 0.06：相邻情绪每字段的落差多在 0.2~1.0，
 *  0.06 相当于"肉眼已看不出还在过渡"。指数逼近下从一次饱满的
 *  情绪切换（初始偏差 ≈0.5）收敛到 0.06 约 1 秒，而最慢的字段
 *  （身体 bodyY，速度 2.2）要 1.9 秒 —— 所以那一秒多是身体的收尾。
 *
 *  保持 5 秒（与 soullink 的 settledHoldSeconds 同值）：只判"此刻已到位"
 *  会被瞬间穿过阈值的那一帧骗过去，要连续安定一段才算数。
 * ========================================================== */
export const EMO_SETTLE_EPS = 0.06;
export const EMO_SETTLE_HOLD_MS = 5000;

/* 全部字段里最大的那个偏差。纯函数（verify-proactive.js 直接拿合成数据测）。 */
export function emotionDeviation(cur, eff) {
  let m = 0;
  for (const k in eff) {
    const d = Math.abs(eff[k] - cur[k]);
    if (d > m) m = d;
  }
  return m;
}

/* ============================================================
 *  情绪衰减 —— 安定之后按指数曲线回落到 calm
 *
 *  要解决的问题：`[emo:xxx]` 之后情绪目标**永远保持** —— 一句
 *  [emo:happy] 过后她能高兴一整晚，惊讶挂半小时。竞品（Open-LLM-VTuber
 *  那一族）靠"下一次回复自带新标签"盖掉旧的，没人再说话表情就冻在
 *  那儿 —— 第 8 轮定向调研确认这是全行业的通病。
 *
 *  学界口径（R. Picard, "Affective Computing", 1997）：情绪是强度随
 *  时间**指数衰减**的瞬态 —— I(t) = I(t₀)·e^(−t/τ)。衰减率按情绪效价
 *  （valence）取"正快负慢"：高兴来得快去得也快，气要生一阵 ——
 *  学界对快慢有分歧，但"惊讶转瞬即逝、不快消得慢"是日常直觉，照此给值。
 *
 *  落法（刻意不动插值层一根手指）：
 *    · 安定保持满（EMO_SETTLE_HOLD_MS）之后才启动 —— 表情还在
 *      "长出来"的路上就衰减，脸上永远长不满；
 *    · 衰减只把**本帧有效目标**向 calm 混合（mixEmoDecay），逼近目标
 *      的那套错峰插值（EMO_SPEED）原样复用 —— 回落自带"眉先回、
 *      身体后回"的层次，不用另写一套衰减动画；
 *    · 情绪**标签**不动：`emotion` 永远是最后一次的情绪名（台词池、
 *      [emo:xxx] 诊断都靠它），衰减只管脸上的姿态强度。
 *
 *  ⚠️ 键集合必须写全 8 个情绪（与 EMO_SPEED 同款约束）—— 漏一个就
 *     静默走 EMO_DECAY_DEFAULT，verify-emotion-decay.js 会拦。
 *  数值口径：**秒**。0 = 该情绪不衰减（calm 的目标本来就是 calm）。
 *  这是情绪本身的心理学常数（"惊讶转瞬即逝"说的是人，不是某个模型），
 *  所以留在引擎层 —— 所有档案共用。
 * ========================================================== */
export const EMO_DECAY = {
  calm: 0,        // 中性姿态，衰减没有对象
  happy: 30,      // 开心来得快去得也快
  smile: 50,      // 浅浅的笑挂得久一点
  shy: 40,        // 害羞要脸红一阵才退
  surprised: 12,  // 惊讶转瞬即逝 —— 全表最短
  think: 150,     // 在想事情，念头不会瞬间散
  serious: 200,   // 严肃 / 不快消得最慢（负效价，最慢的一档）
  sleepy: 90      // 困意是慢慢退的
};

/* 表里没写的情绪兜底（真走到这里 = EMO_DECAY 漏了键，verify 会报红）。 */
export const EMO_DECAY_DEFAULT = 60;

/* 强度跌到这以下直接归 0。不归 0 的话目标永远在慢慢挪，emoCur 追它
 * 的偏差就永远压不进 EMO_SETTLE_EPS，「情绪安定」这个主动搭话的
 * 前置条件就永远凑不满了 —— 衰减必须有一个干净的终点。 */
export const EMO_DECAY_EPS = 0.02;

/* 衰减启动后经过 decayMs 毫秒，该情绪**剩下的强度**（1 → 0）。
 * 纯函数、无状态 —— verify-emotion-decay.js 喂假时钟逐点对曲线。
 * decayMs ≤ 0 一律满强度（还没开始衰减）；τ = 0 的情绪（calm）只要
 * 启动就已到底 —— 它的目标就是中性，没有可衰减的东西。 */
export function emoDecayAmt(name, decayMs) {
  if (!(decayMs > 0)) return 1;
  const tau = (EMO_DECAY[name] ?? EMO_DECAY_DEFAULT) * 1000;
  if (!tau) return 0;
  const amt = Math.exp(-decayMs / tau);
  return amt <= EMO_DECAY_EPS ? 0 : amt;
}

/* 把本帧有效目标向 calm 混合（**原地改 eff**，复用调用方的对象不分配）。
 *   amt = 1（或更大） 满强度 —— 逐字段不动：与没这功能时逐位一致
 *   amt = 0           衰减到底 —— eff == calm
 * ⚠️ 必须在 buildEmoTarget() 之后、插值循环之前调：混合的是「基础 +
 *    摸头调制」算完的有效目标，夹取（EMO_RANGE）已经做过 —— calm 的
 *    每个值都在范围内，凸组合不会把夹好的值再顶出界。
 * 纯函数可测（verify 拿合成表逐字段对数）。 */
export function mixEmoDecay(eff, amt) {
  if (!(amt < 1)) return eff;
  const calm = EMOTION.calm;
  if (amt <= EMO_DECAY_EPS) {
    for (const k in eff) eff[k] = calm[k];
    return eff;
  }
  const w = 1 - amt;                       // calm 的权重
  for (const k in eff) eff[k] += (calm[k] - eff[k]) * w;
  return eff;
}

/* ============================================================
 *  心境偏置 —— 主进程 mood.js 的四条轴落到脸上的这一步
 *
 *  w = { happy, serious, sleepy }，各是 0~1 的权重（主进程按轴穿过
 *  阈值的程度算好推过来）。语义是**凸组合**：
 *      eff' = eff + w·(EMOTION[dir] − EMOTION.calm)
 *  在 calm 基线上它精确等于「w 成的 happy/serious/sleepy」（与
 *  mixEmoDecay 同构 —— 那是向 calm 混，这是向三张姿态表混）；
 *  在活跃情绪上是叠加，可能顶出界 —— 所以逐字段**再夹回 EMO_RANGE**
 *  （这是它与 mixEmoDecay 的关键差别：凸组合向 calm 不越界，加性会）。
 *
 *  ⚠️ 权重全 0 时**逐字段不动**（连夹都不做）——「与没这功能时逐位
 *     一致」是这层的验收线（verify-mood 断言）。
 *  ⚠️ 方向键必须都是当前档案 EMOTION 里**真实存在**的情绪 —— 缺键
 *     会静默少一半偏置，verify-mood 会拦。
 *  ⚠️ 调用位置在 mixEmoDecay **之后**、插值循环之前（衰减先把这一股
 *     情绪收干净，心境偏置再叠上去 —— 心境的时标是分钟级，不该被
 *     秒级的情绪衰减稀释）。
 * ========================================================== */
export const MOOD_BIAS_DIRS = ['happy', 'serious', 'sleepy'];

export function mixEmoMood(eff, w) {
  let any = false;
  for (const d of MOOD_BIAS_DIRS) if (w && w[d] > 0) { any = true; break; }
  if (!any) return eff;                    // 零侵入：没快照 / 开关关 = 原样
  const calm = EMOTION.calm;
  for (const d of MOOD_BIAS_DIRS) {
    const wd = w?.[d] ?? 0;
    if (!(wd > 0)) continue;
    const dir = EMOTION[d];
    if (!dir) continue;                    // 档案没有这个情绪（verify 会拦）
    for (const k in eff) {
      if (!(k in dir) || !(k in calm)) continue;
      eff[k] += (dir[k] - calm[k]) * wd;
    }
  }
  /* 加性偏置可能顶出界 —— 统一夹回该字段的合法区间。 */
  for (const k in eff) {
    const r = EMO_RANGE[k];
    if (r) { if (eff[k] < r[0]) eff[k] = r[0]; else if (eff[k] > r[1]) eff[k] = r[1]; }
  }
  return eff;
}
