/* 模型表 + 参数表 + 情绪姿态表。
 *
 * 这一层的定位是「**只读的真相**」：模型怎么取景、Cubism 参数叫什么名字、
 * 每个情绪对应哪组参数值。全是常量，加一个刷新参数别名表的纯函数。
 * 没有 DOM、没有 pixi、没有任何运行时状态 —— 改这三张表不需要去看渲染循环。
 *
 * ⚠️ 唯一的可变导出是 P（当前生效的参数表）。ESM 的 import 绑定是**只读**的，
 *    所以只能在**本文件内**改它；别的模块 import { P } 之后只读
 *    P.MOUTH_OPEN —— 这是有意为之。
 */

/* ============================================================
 *  模型表
 *
 *  ⚠️ 下面这一整组几何数都是**实测拟合**出来的，不是推出来的，不能乱调。
 *     表格结构保留（而不是拍平成一组常量），是为了将来真加第二套素材时
 *     直接往里添一项、pet.js 侧不用改结构。画布 2976×4175（Cubism 画布，
 *     不是窗口尺寸）。
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
    /* ⚠️ inkW 与 inkCxK 是**两个用途**，别互相推（2026-10-12 修）：
     *   inkW  = 轮廓最大宽（含张开的手臂）→ 只给 petRect 穿透判定用，宁可偏大
     *   inkCxK = 身体中心线 → 只给 layout() 水平居中用
     * 曾经两者都当"墨水包围盒"用，而包围盒中心 ≠ 身体视觉中心（日和的长发
     * 偏向一侧），结果**人物整体偏左约 37px**，底座居中、人物不居中，很扎眼。
     * 现在 inkCxK 是**多帧实测的身体中心**（6 帧取中位数，映射回 canvas 单位，
     * 见 2026-10-12 记忆）：hiyori 971（旧 1191 偏右 220 ≈ 38 CSS px）。
     * ⚠️ 换模型/换素材必须重新多帧标定，单帧会因举手/甩发把中心带偏。 */
    inkW: 897,              // 轮廓最大宽（穿透判定用，取偏大值）
    inkCxK: 971,            // **身体中心线** x = inkCxK × s（居中用）
    /* 哪些动作组**保持循环播放**（白名单，见 pet.js 的 KEEP_LOOP 那段）。
     *   官方那 11 个动作：曲线首尾全不闭合（Meta 的 Loop:true 是标错的），
     *     一个都不能留 —— 全关，播完交给插件的 idle 调度接管。
     *   Drag / Walk：本项目手写的（tools/make-motions.js），专门做成首尾
     *     闭合的持续动作 —— 拖拽期间 / 溜达期间一直播，必须 loop。 */
    keepLoopGroups: ['Drag', 'Walk']
  }
};

/* 当前（也是唯一）模型的目录名 —— 全项目只在这里写一次这个字符串。
 * 主进程、渲染层、诊断脚本都引用它，免得再出现「配置里写一个名字、
 * 代码里比对另一个名字」这种两边不一致。 */
export const MODEL_NAME = 'hiyori';

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

/* 当前生效的参数表。
 *
 * 这里原本还有一张按模型改写参数名的别名表（给参数命名不同的那套素材兜底：
 * 比如有的素材脸红参数叫 ParamTere、且根本没有肩参数）以及配套的
 * refreshParamTable()。单一模型后别名无从谈起，两张表一起删了。
 * 真加第二套素材时再回来加，别提前留一个永远走不到的空壳。 */
export let P = { ...PARAM };

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
