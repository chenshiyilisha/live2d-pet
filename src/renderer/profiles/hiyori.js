/* hiyori 的模型档案 —— **只读数据，零逻辑**。
 *
 * 一份档案 = 一个角色能上舞台的全部模型侧真相：
 *   name    档案键（params.js 用它注册进 MODELS；MODEL_NAME 只写一次）
 *   model   几何与动作组（取景标定、循环白名单、淡化覆盖）—— pet.js 挂载用
 *   param   语义通道 → Cubism 参数 ID（缺的键 = 该模型没有这器官，put() 自动跳过）
 *   emotion 8 情绪 × N 字段的脸部姿态数值（N 不必是 16 —— 引擎按字段集遍历）
 *   emoRange 情绪字段的合法范围（口径随模型：有的模型 body 参数是归一值不是度）
 *   patDelta 摸头时叠加的增量（键集 ⊆ emotion 字段集）
 *   emoSpeed 错峰插值的节奏手感（眉快身慢的层次每模型各调各的）
 *
 * ⚠️ 档案契约（verify-expressive / verify-emotion-decay 逐条断言）：
 *   · emotion 的 8 个情绪字段集必须完全一致（缺字段 = 静默停在旧值）
 *   · emoSpeed 键集 = emotion 字段集（漏一个静默走 EMO_SPEED_DEFAULT）
 *   · patDelta 的键必须都在 emotion 字段集里（写错名字静默无效）
 *   · emotion 里出现的字段，param 里必须有对应 ID（否则 applyEmotion
 *     会往参数里写 undefined —— pet.js 的 put() 只挡"id 缺失"，不挡值缺失）
 *
 * 引擎（插值 / 衰减 / 摸头状态机 / PAT 时序 / EMO_DECAY 心理学常数）
 * 全在 params.js —— 那是跨模型共享的，别往这里抄。
 * 加新模型：照这份文件的结构新建 profiles/<name>.js，再去 params.js
 * 注册一行。改数值只动本文件，动引擎才碰 params.js。
 */

export const HIYORI = {
  name: 'hiyori',

  /* W33：本档 8 情绪齐全 → 空表即可。降档模型可写 { think: 'calm', … }。 */
  emotionAlias: {},
  /* W34：口型写参上限。1 = 全开；降档口腔一张张嘴图可夹到 0.55 之类。 */
  mouthOpenMax: 1,

  /* ============================================================
   *  几何与动作组（pet.js 挂载 / 取景 / 动作调度用）
   *
   *  ⚠️ 这一整组几何数是**实测拟合**出来的，不是推出来的，不能乱调。
   *     画布 2976×4175（Cubism 画布，不是窗口尺寸）。
   *
   *  几何量法：?snap=ink&pet=<小值>&pad=<大值> 把模型压到完整可见
   *  （被窗口裁掉的部分 capturePage 截不到），逐帧量像素包围盒，
   *  取多个缩放点拟合出「顶部 = C + K·s」（s 见 layout）。
   *
   *  🔴 坑（2026-10-11 才彻底搞清，别再走弯路）：
   *     C 不是常数 —— 它正比于**画布高 vh**：
   *     C = vh × inkTopCRatio（比例系数**在本档案里**，params.js 的
   *     INK_TOP_C_RATIO 只是缺省回退值）。
   *     ⚠️ 这个系数**逐模型不同**，别拿 hiyori 的 0.2 去套别的模型 ——
   *     鲸鱼娘实测是 0.328（差 64%），详见 profiles/whale.js 的注释。
   *     两个模型当初各测出一模一样的 242，是因为**标定时用的是同一个窗口**，
   *     不是「画布尺寸相同」（它俩画布根本不同）。按常数写死的结果是：
   *     当前窗口下严丝合缝，一旦换显示器/改 WIN_H_RATIO，头顶立刻跑偏 ——
   *     实测 H=560 时头顶低了 85px，H=280 时被切掉。这正是用户最初报的那个症状。
   *     所以 C 放在 layout() 里按 vh 现算，表里只留与窗口无关的 K。
   * ========================================================== */
  model: {
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
    keepLoopGroups: ['Drag', 'Walk'],
    /* 组级淡化覆盖（秒）。Drag 是"被拎起来"的反应，0.5s 的淡入太钝 ——
     * 抓上来半秒她才肯挣扎。pet.js 的 retime() 以这里为准。
     * （只在定义了非默认值时才需要列进来，没列的组用 pet.js 的 0.5s。） */
    fadeOverride: { Drag: { in: 0.12, out: 0.3 } },
    /* 工作状态 → 动作组（DSH live2d-pets 槽位思路）。
     * 空串 / 缺键 = 只切表情不播动作。hiyori 有 Drag/Walk，成功用 Walk 示意。 */
    motionSlots: {
      thinking: '',
      working: '',
      success: 'Walk',
      error: 'Drag',
      drag: 'Drag',
      walk: 'Walk'
    }
  },

  /* 桃濑日和（Hiyori Momose）的参数表。它没有 exp3 表情文件，
   * 所以表情全部靠直控参数做 —— 反而比表情文件灵活（可连续插值）。
   * ⚠️ 参数 ID 全部来自 hiyori 的 Hiyori.cdi3.json（70 个参数），
   *    verify-expressive.js 会拿这份清单逐个回查 —— 拼错一个字母就会红。 */
  param: {
    MOUTH_OPEN: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    EYE_L: 'ParamEyeLOpen',
    EYE_R: 'ParamEyeROpen',
    EYE_L_SMILE: 'ParamEyeLSmile',
    EYE_R_SMILE: 'ParamEyeRSmile',
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    /* 眉毛的**水平**分量（-1~1），和 BROW_*_Y 是两条独立的轴。
     * 官方模型里它做「眉毛内侧向中间聚拢」的形状 —— 单边给值就是
     * 「一边挑一边压」，困惑/怀疑/得意全靠它（2026-10-13 新增）。 */
    BROW_L_X: 'ParamBrowLX',
    BROW_R_X: 'ParamBrowRX',
    BROW_L_ANGLE: 'ParamBrowLAngle',
    BROW_R_ANGLE: 'ParamBrowRAngle',
    BROW_L_FORM: 'ParamBrowLForm',
    BROW_R_FORM: 'ParamBrowRForm',
    CHEEK: 'ParamCheek',        // 脸红
    ANGLE_X: 'ParamAngleX',     // 头左右
    ANGLE_Y: 'ParamAngleY',     // 头上下
    ANGLE_Z: 'ParamAngleZ',     // 头倾斜
    BODY_X: 'ParamBodyAngleX',
    /* 身体的前后 / 侧倾（-10~10，单位是度 —— 和头部的 ANGLE_* 一样是角度，
     * 别当成 -1~1 的归一值，写 0.5 是看不见的，要 2~5 才有感）。
     * 🔴 它们是 **Cubism 物理的输入**（Hiyori.physics3.json 的 Input 里有，
     *    ParamBodyAngleY 权重 100、Z 有 100/60/40 三档）—— 往这里喂一个值，
     *    头发前后摆、侧发饰、两层裙摆、胸口、缎带会**一起**跟着动，而且因为
     *    经过物理演算，自带滞后和回弹。这是全项目性价比最高的一组参数：
     *    一个值带动七个输出。⚠️ 正因为过物理，别喂跳变值（见 emoSpeed 里
     *    给它的低速）。 */
    BODY_Y: 'ParamBodyAngleY',
    BODY_Z: 'ParamBodyAngleZ',
    BREATH: 'ParamBreath',
    SHOULDER: 'ParamShoulder',
    /* 呆毛 —— 日系角色的「第三条眉毛」。核实过：11 条物理链的 35 个输出里
     * **没有它**，是纯自由参数，往里写不会跟物理打架。 */
    AHOGE: 'ParamHairAhoge',
    ARM_LA: 'ParamArmLA',
    ARM_RA: 'ParamArmRA'
  },

  /* ============================================================
   *  情绪 → 参数姿态
   *
   *  Hiyori 没有 exp3 表情文件，表情全靠直控参数做。这样反而更好：
   *  参数能连续插值，表情是「长出来」的而不是硬切。
   *
   *  ⚠️ 两条约定，照做能省很多事：
   *
   *  1) **每个情绪必须写全 16 个字段，一个都不能省。**
   *     插值循环是 `for (const key in emoTarget)` —— 目标表里缺哪个键，
   *     哪个字段就永远停在切换前的旧值上（切到 A 再切到缺字段的 B，
   *     眉毛就卡在 A 的姿态不动）。所以 verify-expressive.js 第一件事
   *     就是断言 8 个情绪的键集合完全相同。
   *
   *  2) **别在这里写左右对称的值。** browLY/browRY、browLX/browRX 是
   *     分开的两条 —— 真实人脸的表情几乎从不完全对称。全对称的眉毛
   *     一眼就是「图在变形」，「一边挑一边压」才是「人在演」。
   *
   *  数值口径：眉 -1~1（正=上扬）、眉水平 -1~1、嘴形 -1~1（正=笑）、
   *  脸红 0~1、微笑眼 0~1、睁眼 0~1；
   *  headZ/headY 是歪头/点头（**度**，±30）；
   *  bodyY/bodyZ 是身体前后/侧倾（**度**，±10）—— 过物理，
   *  头发和裙摆会跟着甩（见 param 里 BODY_Y 那段）。
   * ========================================================== */
  emotion: {
    /*                  眉高低      眉水平    眉角  眉形   嘴形  微笑眼 睁眼   脸红  歪头 点头  肩  呆毛  身前 身侧 */
    calm:      { browLY: 0,     browRY: 0,     browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0,     eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: 0,   shoulder: 0,    ahoge: 0,    bodyY: 0,    bodyZ: 0 },
    happy:     { browLY: 0.45,  browRY: 0.45,  browLX: 0,     browRX: 0,     browAngle: 0.15,  browForm: 0,    mouthForm: 0.85,  eyeSmile: 1,    eyeOpen: 0.95, cheek: 0.2,  headZ: -4,  headY: -3,  shoulder: 0.1,  ahoge: 0.5,  bodyY: 2.5,  bodyZ: 0 },
    smile:     { browLY: 0.2,   browRY: 0.2,   browLX: 0,     browRX: 0,     browAngle: 0.1,   browForm: 0,    mouthForm: 0.55,  eyeSmile: 0.7,  eyeOpen: 1,    cheek: 0.1,  headZ: -2,  headY: 0,   shoulder: 0,    ahoge: 0.25, bodyY: 1.5,  bodyZ: 0 },
    /* think 是唯一一个「有意不对称」的日常情绪：右眉压得比左眉低、两边眉尾
     * 一内收一外展（browLX + / browRX −）→ 读出来是"困惑/在心里盘算"，
     * 而全对称的皱眉只会读成"生气"。 */
    think:     { browLY: -0.45, browRY: -0.2,  browLX: 0.35,  browRX: -0.3,  browAngle: -0.45, browForm: 0.6,  mouthForm: -0.25, eyeSmile: 0,    eyeOpen: 0.7,  cheek: 0,    headZ: 7,   headY: 2,   shoulder: 0,    ahoge: -0.35, bodyY: 0,   bodyZ: 2.5 },
    shy:       { browLY: -0.25, browRY: -0.25, browLX: 0,     browRX: 0,     browAngle: 0.35,  browForm: 0,    mouthForm: 0.35,  eyeSmile: 0.55, eyeOpen: 0.8,  cheek: 1,    headZ: 0,   headY: 6,   shoulder: 0.25, ahoge: -0.2, bodyY: -3,   bodyZ: 0 },
    serious:   { browLY: -0.6,  browRY: -0.6,  browLX: -0.4,  browRX: -0.4,  browAngle: -0.25, browForm: 0,    mouthForm: -0.45, eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: -1,  shoulder: 0,    ahoge: -0.1, bodyY: 1.5,  bodyZ: 0 },
    surprised: { browLY: 0.8,   browRY: 0.8,   browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.15,  eyeSmile: 0,    eyeOpen: 1.05, cheek: 0.15, headZ: 0,   headY: -2,  shoulder: 0.35, ahoge: 0.85, bodyY: -5,   bodyZ: 0 },
    sleepy:    { browLY: -0.15, browRY: -0.15, browLX: 0,     browRX: 0,     browAngle: 0.1,   browForm: 0,    mouthForm: 0.05,  eyeSmile: 0.25, eyeOpen: 0.35, cheek: 0.12, headZ: 4,   headY: 4,   shoulder: -0.1, ahoge: -0.5, bodyY: 2.5,  bodyZ: 2.5 }
  },

  /* ============================================================
   *  情绪字段的合法范围
   *
   *  这张表是**口径的唯一出处**（规矩 9），两处共用：
   *    ① buildEmoTarget() —— 叠加摸头调制后夹回范围内
   *    ② verify-expressive.js —— 断言 8 个情绪表里没有一个值越界
   *  （那张表原本是 verify 里私有的 LIM，2026-10-14 收上来 —— 不然
   *   "能写到多大"这件事就有了两份会各自漂移的说法。）
   *
   *  🔴 为什么运行时也必须夹：Cubism 对越界参数是**静默钳位**（不报错、
   *     停在边界上）。而"基础值 + 增量"很容易顶出去（shy 的 cheek 本来
   *     就是 1），不夹的表现是"摸了半天脸红一点没变，也完全不报错"。
   *
   *  数值依据是上面那段口径注释。睁眼上限写 1.1 而不是口径里的 1，是
   *  迁就 surprised 的 1.05 —— 不顺手收紧，免得引出一个看不见的变化。
   * ========================================================== */
  emoRange: {
    browLY: [-1, 1], browRY: [-1, 1], browLX: [-1, 1], browRX: [-1, 1],
    browAngle: [-1, 1], browForm: [-1, 1], mouthForm: [-1, 1],
    eyeSmile: [0, 1], eyeOpen: [0, 1.1], cheek: [0, 1], shoulder: [-1, 1],
    ahoge: [-1, 1], headZ: [-30, 30], headY: [-30, 30],
    bodyY: [-10, 10], bodyZ: [-10, 10]
  },

  /* 摸头时叠加在基础情绪上的增量。
   *   a = 常驻偏移量，w = 摆动幅度，s = 该通道的**相位偏移（弧度）**
   *
   *  s 是错峰用的：头先动 → 呆毛慢半拍 → 脸红最慢。全通道同相位等于
   *  "整张脸一起晃" = 木偶，和 emoSpeed 那段是同一个道理。
   *
   *  摆动本身用两条**不成整数倍**的正弦叠加（1 : 1.63）—— 单条正弦的
   *  周期感很重，一眼就看出是程序在动。这个手法 updateGaze 的 SPEAKING
   *  分支里已经用过（那里有断言数 Math.sin 的个数）。
   *
   *  🔴 键必须都在 emotion 的字段集里 —— 写错一个名字不会有任何效果，
   *     而且是静默的（verify-expressive.js [H] 段拿字段集逐个回查）。 */
  patDelta: {
    headY:     { a: -4,    w: 0,    s: 0 },      // 负 = 抬头：往上顶，像在蹭手
    headZ:     { a: -2.5,  w: 2.2,  s: 0 },      // 歪头 + 左右轻晃（B 段主体）
    ahoge:     { a: 0.3,   w: 0.15, s: 0.55 },   // 呆毛立起来，跟着弹
    eyeOpen:   { a: -0.25, w: 0.06, s: 0.55 },   // 舒服地眯起眼
    eyeSmile:  { a: 0.35,  w: 0,    s: 0 },      // 弯眼
    cheek:     { a: 0.35,  w: 0.08, s: 1.1 },    // 脸红加深（最慢）
    mouthForm: { a: 0.15,  w: 0,    s: 0 },
    shoulder:  { a: 0.12,  w: 0,    s: 0 },      // 微微放松下沉
    bodyY:     { a: 0.8,   w: 0,    s: 0 },      // 过物理 → 头发/裙摆跟着动
    bodyZ:     { a: 1.6,   w: 0.8,  s: 0.3 }
  },

  /* ============================================================
   *  每个情绪字段的「逼近速度」（1/秒，指数逼近的时间常数倒数）
   *
   *  这一张表解决的是一件比"多加几个参数"更要紧的事：
   *  **所有参数共用一个速度 = 整张脸同时到位 = 木偶。**
   *  真实的脸是错峰动起来的（动画术语 overlapping action）：
   *  眉毛最先反应（约 0.08s）、眼睛跟着、嘴中等、头更慢、身体最慢，
   *  脸红则是血涌上来、本来就该是几秒的渐变。
   *  同时到位时观感是"整张图在缩放"，错峰到位才像"表情从脸上长出来"。
   *
   *  ⚠️ 键集合必须和 emotion 的字段集**完全一致** —— 漏一个字段，
   *     那一个就退化成 EMO_SPEED_DEFAULT，而且是静默的（verify 会拦）。
   *  数值口径：越大越快。眉毛 ≈ 2× 头部，身体最小。
   * ========================================================== */
  emoSpeed: {
    // 眉毛 —— 最快，人的注意力先写在眉上
    browLY: 9, browRY: 9, browLX: 9, browRX: 9, browAngle: 8, browForm: 8,
    // 眼睛 —— 次之（睁眼/眯眼）
    eyeSmile: 7, eyeOpen: 7,
    // 呆毛 —— 头发有惯性，比脸慢半拍，翘起来才有"弹"的感觉
    ahoge: 5,
    // 嘴 —— 中等
    mouthForm: 4.5,
    // 脸红 —— 最慢的那一类，是渐变不是开关
    cheek: 2.8,
    // 头部 —— 慢（转个头是要花时间的）
    headZ: 3.2, headY: 3.2,
    // 肩 + 身体 —— 最慢：重心转移本来就慢，而且身体过物理，
    //              喂快了物理会抖（见 param 的 BODY_Y）
    shoulder: 2.6, bodyY: 2.2, bodyZ: 2.2
  }
};
