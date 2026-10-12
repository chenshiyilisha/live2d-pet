/* 模型表 + 参数表 + 情绪姿态表。
 *
 * 这一层的定位是「**只读的真相**」：模型怎么取景、Cubism 参数叫什么名字、
 * 每个情绪对应哪组参数值。全是常量，加一个刷新参数别名表的纯函数。
 * 没有 DOM、没有 pixi、没有任何运行时状态 —— 改这三张表不需要去看渲染循环。
 *
 * ⚠️ 唯一的可变导出是 P（当前生效的参数表）。ESM 的 import 绑定是**只读**的，
 *    所以只能在**本文件内**改它（refreshParamTable 就是干这个的）；
 *    别的模块 import { P } 之后只读 P.MOUTH_OPEN —— 这是有意为之。
 */

/* ============================================================
 *  模型表
 *
 *  ⚠️ 每套模型的取景几何都是各自实测的，不能通用 —— 换模型 = 换 url
 *     + 换下面这一整组数。画布尺寸也不同（Hiyori 2976×4175，Haru 2400×4500）。
 *
 *  几何量法：?snap=ink&pet=<小值>&pad=<大值> 把模型压到完整可见
 *  （被窗口裁掉的部分 capturePage 截不到），逐帧量像素包围盒，
 *  取多个缩放点拟合出「顶部 = C + K·s」（s 见 layout）。
 *
 *  🔴 坑（2026-10-11 才彻底搞清，别再走弯路）：
 *     C 不是常数，也不取决于模型 —— 它正比于**画布高 vh**：C = vh × INK_TOP_C_RATIO。
 *     两个模型当初各测出一模一样的 242，是因为**标定时用的是同一个窗口**，
 *     不是「画布尺寸相同」（它俩画布根本不同）。按常数写死的结果是：
 *     当前窗口下严丝合缝，一旦换显示器/改 WIN_H_RATIO，头顶立刻跑偏 ——
 *     实测 H=560 时头顶低了 85px，H=280 时被切掉。这正是用户最初报的那个症状。
 *     所以 C 放在 layout() 里按 vh 现算，表里只留与窗口无关的 K。
 * ========================================================== */

/* 墨水顶部相对画布高 vh 的比例项（C = vh × 这个值）。
 * 实测：vh=1211.2 → C=242.2（两点拟合 242）；vh=1623.2 → C≈326.8。
 * 1/5 与两档数据都吻合（残差 <3px，那是 hiyori 呆毛太细、像素判定吃掉的）。
 * 它来自插件把模型的局部原点放在画布高约 20% 处，与模型本身无关。 */
export const INK_TOP_C_RATIO = 0.2;

export const MODELS = {
  hiyori: {
    label: '日和',
    url: '/src/assets/models/hiyori/Hiyori.model3.json',
    petScale: 0.834,        // 基准缩放（乘在画布-窗口比例上）
    headPadRatio: 0.0431,   // 墨水顶部留白 ÷ 窗口高
    inkTopK: 236.8,         // 墨水顶部 = vh×INK_TOP_C_RATIO + inkTopK × s
    inkH: 3006.4,           // 墨水总高（canvas 单位，呆毛尖 → 脚）
    inkW: 897,              // 墨水总宽
    inkCxK: 1191,           // 墨水中心 x = inkCxK × s（水平方向是纯比例）
    /* 哪些动作组保持循环播放。
     * Hiyori 的动作曲线首尾全不闭合（Meta 的 Loop:true 是标错的），
     * 所以一个都不能留 —— 全关，播完交给插件的 idle 调度接管。 */
    keepLoopGroups: []
  },
  haru: {
    label: '春',
    url: '/src/assets/models/haru/Haru.model3.json',
    /* 画布 2400×4500。下面这组是**实测拟合**出来的（两组不同缩放的像素包围盒）：
     *   墨水顶部(canvas 内) = vh×0.2 + 193·s
     *   墨水中心 x          = 984·s          ← 水平方向是纯比例
     *   墨水总高 3173 / 总宽 640（画布单位，宽会随手臂摆动浮动，取的是偏大值，
     *                            宁可让命中矩形略大，也别把身体判成透明）
     *
     * 实测原始数据（s → 墨水顶部在窗口里的位置，CSS px；pad 是当次设定的留白）：
     *   s=0.21529 pad=300 → 228 ；s=0.10764 pad=100 → 35.2
     *   s=0.21529 中心 x=289.6 ；s=0.10764 中心 x=237.2
     * 换模型必须重标（量法见文件顶部说明）。 */
    /* 基准缩放：按 hiyori 的取景反解出来的，让两个模型切来切去观感一致。
     *
     * 判据一（头一样大）：haru 头 542 画布单位，hiyori 463 → s=112/542 → 0.767
     * 判据二（等高）：hiyori 有效墨水高 727 CSS，haru 3173 画布单位 → 0.790
     * 两条差 3%，取中间 0.78：haru 头 113.8 CSS（比 hiyori 大 1.6%）。
     *
     * ⚠️ 别拿 "SHOW_FRACTION × INK_H × s 相等" 去推 —— hiyori 的 55% 处是腰际，
     *    haru 的是 60%（她上身长），两个模型的墨水高里「看得见的那半身」占比不同。
     *    按头部尺寸对齐才是可靠的，因为脸才是观感的锚点。 */
    petScale: 0.78,
    headPadRatio: 0.0431,
    inkTopK: 193,
    inkH: 3173,
    inkW: 640,
    inkCxK: 984,
    /* Haru 的 Idle 组（haru_g_idle / m15）曲线首尾完全闭合，是真正的循环动作，
     * 必须保持 loop；其余组（TapBody 里 m06 首尾差 21 度）一律关。 */
    keepLoopGroups: ['Idle']
  }
};

/* 桃濑日和（Hiyori Momose）的参数表。它没有 exp3 表情文件，
 * 所以表情全部靠直控参数做 —— 反而比表情文件灵活（可连续插值）。 */
export const PARAM = {
  MOUTH_OPEN: 'ParamMouthOpenY',
  MOUTH_FORM: 'ParamMouthForm',
  EYE_L: 'ParamEyeLOpen',
  EYE_R: 'ParamEyeROpen',
  EYE_L_SMILE: 'ParamEyeLSmile',
  EYE_R_SMILE: 'ParamEyeRSmile',
  BROW_L_Y: 'ParamBrowLY',
  BROW_R_Y: 'ParamBrowRY',
  BROW_L_ANGLE: 'ParamBrowLAngle',
  BROW_R_ANGLE: 'ParamBrowRAngle',
  BROW_L_FORM: 'ParamBrowLForm',
  BROW_R_FORM: 'ParamBrowRForm',
  CHEEK: 'ParamCheek',        // 脸红
  ANGLE_X: 'ParamAngleX',     // 头左右
  ANGLE_Y: 'ParamAngleY',     // 头上下
  ANGLE_Z: 'ParamAngleZ',     // 头倾斜
  BODY_X: 'ParamBodyAngleX',
  BREATH: 'ParamBreath',
  SHOULDER: 'ParamShoulder',
  ARM_LA: 'ParamArmLA',
  ARM_RA: 'ParamArmRA'
};

/* 不同模型的参数命名有细微差异，用别名表覆盖。
 * null = 这个模型没有对应参数 → 直接跳过（Cubism 对不存在的参数会静默忽略，
 * 但显式置 null 更清楚，也省掉一次没意义的调用）。
 * 对照 Haru.cdi3.json 得到：Haru 没有 ParamCheek（只有 ParamTere「照れ」）、
 * 也没有 ParamShoulder。 */
export const PARAM_ALIAS = {
  haru: {
    CHEEK: 'ParamTere',
    SHOULDER: null
  }
};

/* 当前生效的参数表。mountModel 里按模型名刷新。 */
export let P = { ...PARAM };

export function refreshParamTable(name) {
  const over = PARAM_ALIAS[name] || {};
  const t = {};
  for (const k of Object.keys(PARAM)) {
    t[k] = Object.prototype.hasOwnProperty.call(over, k) ? over[k] : PARAM[k];
  }
  P = t;
}

export const State = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  SLEEP: 'sleep'
};

/* ============================================================
 *  情绪 → 参数姿态
 *
 *  Hiyori 没有 exp3 表情文件，表情全靠直控参数做。这样反而更好：
 *  参数能连续插值，表情是「长出来」的而不是硬切。
 *  数值按 Cubism 惯例——眉毛 -1~1、嘴形 -1~1（正=笑）、脸红 0~1、微笑眼 0~1。
 *  headZ 是歪头（度），headY 是点头（度）。
 * ========================================================== */

export const EMOTION = {
  calm:      { browY: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0,     eyeSmile: 0,    cheek: 0,    headZ: 0,   headY: 0,   eyeOpen: 1,    shoulder: 0 },
  happy:     { browY: 0.45,  browAngle: 0.15,  browForm: 0,    mouthForm: 0.85,  eyeSmile: 1,    cheek: 0.2,  headZ: -4,  headY: -3,  eyeOpen: 0.95, shoulder: 0.1 },
  smile:     { browY: 0.2,   browAngle: 0.1,   browForm: 0,    mouthForm: 0.55,  eyeSmile: 0.7,  cheek: 0.1,  headZ: -2,  headY: 0,   eyeOpen: 1,    shoulder: 0 },
  think:     { browY: -0.35, browAngle: -0.45, browForm: 0.6,  mouthForm: -0.25, eyeSmile: 0,    cheek: 0,    headZ: 7,   headY: 2,   eyeOpen: 0.7,  shoulder: 0 },
  shy:       { browY: -0.25, browAngle: 0.35,  browForm: 0,    mouthForm: 0.35,  eyeSmile: 0.55, cheek: 1,    headZ: 0,   headY: 6,   eyeOpen: 0.8,  shoulder: 0.25 },
  serious:   { browY: -0.6,  browAngle: -0.25, browForm: 0,    mouthForm: -0.45, eyeSmile: 0,    cheek: 0,    headZ: 0,   headY: -1,  eyeOpen: 1,    shoulder: 0 },
  surprised: { browY: 0.8,   browAngle: 0,     browForm: 0,    mouthForm: 0.15,  eyeSmile: 0,    cheek: 0.15, headZ: 0,   headY: -2,  eyeOpen: 1.05, shoulder: 0.35 },
  sleepy:    { browY: -0.15, browAngle: 0.1,   browForm: 0,    mouthForm: 0.05,  eyeSmile: 0.25, cheek: 0.12, headZ: 4,   headY: 4,   eyeOpen: 0.35, shoulder: -0.1 }
};
