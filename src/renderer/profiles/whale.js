/* whale（鲸鱼娘 / c_0120）的模型档案 —— **只读数据，零逻辑**。
 *
 * 契约与 hiyori.js 完全相同，照那份文件的头注释读一遍再改这里。
 *
 * ⚠️ 这个模型是 **VTube Studio 模型包**改来的（Andersen216 补了 model3.json），
 *    它的设计前提和我们 hiyori 那套**完全不同**，三条必须先记住：
 *
 *  1) **它的"表情"是贴图切换，不是参数插值。**
 *     247 个参数里，中文名（cdi3.json 的 Name 字段）写着真相：
 *       ParamCheek15 = 1眼泪  16 = 2星星眼  17 = 3爱心眼  20 = 4呆眼眨眼
 *       22 = 5呆2口水  77 = 16晕晕眼  21 = 9舔嘴  79 = 20舌头
 *       70/72/10 = 圆/方/椭眼镜  38 = 头箍开关
 *     这些是**贴图开关**（开=换一张眼/嘴的图），不是连续量。
 *     → 本项目规矩 28 的情绪引擎是连续插值，所以**这些一个都不接**；
 *       只接能连续插值的那批（眉/眼开闭/嘴形/脸红/头/身/呆毛/呼吸）。
 *
 *  2) **它有一堆道具参数**（shouji 手机 / maoshou 猫手 / jingyu 鲸鱼 /
 *     danbaofan 蛋包饭 / paopao 泡泡 / mozhua 魔爪 / baleite 巴菲 / j1~j57…）。
 *     这些我们不碰 —— 它们停在 moc3 的初始值上。**初始值必须逐个实测确认
 *     是"隐藏"**，否则她一上来就顶着手机+猫耳+各种装饰。见 verify-whale。
 *
 *  3) 缺的器官：微笑眼（ParamEyeLSmile/RSmile）、肩（ParamShoulder）、
 *     手臂（ParamArmLA/RA）**这个模型没有**。
 *     → 按契约，emotion 里那几个字段照写（保证 8 情绪字段集一致），
 *       param 里**不填** ID，引擎的 put() 会自动跳过（静默、无害）。
 */

export const WHALE = {
  name: 'whale',

  model: {
    label: '鲸鱼娘',
    url: '/src/assets/models/whale/c_0120.model3.json',
    /* ---- 几何标定（2026-10-25，debug/calib-whale.js 三档实测）----
     * 方法：PET_SNAPSHOT="ink&pet=0.3&pad=0.2"（pad=0.2 把 HEAD_PAD 清零，
     * 误差全部落到常数项上、反推是线性的）在窗口高 342/280/420 三档各跑
     * 32s×~112 帧采样，取整窗墨水包围盒。三档拟合残差 ±2.5 canvas 单位。
     *
     * 🔴 anchorY: 'bottom' —— **趴姿模型必须底部锚定**。
     *    hiyori 是站姿、设计成"显示到全身 55%（腰际）"= 顶部锚定 + 下半身
     *    裁掉；鲸鱼娘是趴在桌布上的场景构图（桌布+圣代+鲸鱼尾都是姿势的
     *    一部分），必须**桌布贴窗口底**才像"趴在你桌上"——顶部锚定会让
     *    她悬浮在窗口中间、底下空一截（实测 pet=0.3 时底部空白 66css）。
     *    layout() 见此键走底部锚定分支（HEAD_PAD 不参与，墨水底 = 舞台底，
     *    舞台已让出 STATS_GAP 呼吸位 —— "桌布摆在底座上沿"的语义不变）。
     *
     *  inkTopCRatio/inkTopK/inkH/inkW 的量纲与 hiyori 相同（canvas 单位 = s 的系数），
     *  但数值**完全不同**——这个模型画布 4068×4068（hiyori 更小），且趴姿
     *  构图横向铺开（宽 2499 > 高 2111，宽高比 1.18，hiyori 是竖长条）。
     *  inkW 取两档一致的 2499（h=420 档右缘被窗口截断，弃用）。
     *  inkCxK 是**头部行中心**的三档中位（头中心 = 躯干中心，趴姿下她
     *  的身体在头正下方）——墨水包围盒中心不可用：圣代（左）+鲸鱼尾（右）
     *  会把中心拉偏 40css（同 hiyori 长发偏侧的教训，规矩 23 同源）。
     *
     *  🔴 **inkTopCRatio = 0.328，不是引擎默认的 0.2 ——「C 项与模型无关」
     *  的旧断言被证伪（2026-10-25）。** 标定时踩了**三层共线**：三档窗口高
     *  全用 pet=0.3 跑（s = vh/13560 ∝ vh），a·vh + b·s 在这条线上数学上
     *  不可分离，于是把 hiyori 的 a=0.2 当"模型无关"继承、把残差全塞进 b
     *  得到假值 2052；换 petScale=0.5 复验立刻偏 81css（渲染位置被顶到窗口
     *  上沿）。用两组不同 petScale 的观测联立才解出真值 a=0.328、b=319
     *  （回代全部 5 个观测残差 <1px）。
     *  **教训（进规矩 2）：取景标定必须至少两组不同的 petScale（不同 s/vh
     *  比），单一比例下的多档窗口高是共线数据，拟合出的"真值"只在那条线上
     *  成立 —— 而用户缩放（userScale）恰是日常会改 s/vh 比的操作。** */
    anchorY: 'bottom',
    inkTopCRatio: 0.328,    // 墨水顶部 C 项 = vh × 此值（真实值，见上；hiyori 是 0.2）
    /* 0.5 → 0.253（2026-10-29，用户："让它小一点，至少让宽度看着跟底座一样宽"）。
     * 人物宽 = 584 × petScale（@H328 标定点），0.253 → 宽 ≈148css，正好压到
     * 底座牌那一档（PLATE_HALF×2 = 148，pet.js）；高 ≈125css（原先 292×247）。
     * ⚠️ 用户的日常微调走托盘/右键的放大缩小（appearance.scale，0.5~1.4 实时生效），
     *    这个基准值只定"100% 时她多大"。 */
    petScale: 0.253,        // 人物宽 ≈148css@H328（= 底座牌宽），高 ≈125css
    headPadRatio: 0.0431,   // 底部锚定不参与（顶部锚定模型专用），保留契约完整
    inkTopK: 319,           // 墨水顶部 = vh×inkTopCRatio + inkTopK × s（真实 b，见上）
    inkH: 2111,             // 墨水总高（canvas 单位，呆毛尖 → 桌布底）
    inkW: 2499,             // 轮廓最大宽（含桌布/圣代/鲸鱼尾；穿透判定用）
    inkCxK: 1410,           // **头部中心线** x = inkCxK × s（居中用）
    /* 官方这 8 组动作（idle / aidale / selfie / selfieQuick / ketchup /
     * openLid / bubble / splash）**首尾不闭合**（VTube Studio 模型包通病，
     * 和 hiyori 官方那 11 个一样，Meta 里的 Loop:true 是标错的）。
     * → 一个都不留，全部交给插件的 idle 调度接管。
     * 本项目手写的 Drag / Walk 动作是给 hiyori 骨骼绑的（tools/make-motions.js），
     * 换模型要重做，这里先空着。 */
    keepLoopGroups: [],
    /* 工作状态槽位：鲸鱼娘暂无自制 Drag/Walk，全部空 = 只切表情不播动作。 */
    motionSlots: {
      thinking: '',
      working: '',
      success: '',
      error: '',
      drag: '',
      walk: ''
    }
  },

  /* 参数 ID 全部来自 c_0120.cdi3.json 的 247 个参数（verify 会逐个回查）。 */
  param: {
    MOUTH_OPEN: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    EYE_L: 'ParamEyeLOpen',
    EYE_R: 'ParamEyeROpen',
    /* EYE_L_SMILE / EYE_R_SMILE 缺失 —— 这模型没有微笑眼参数
     * （它的"笑眼"是贴图切换 ParamCheek16 那一路，不接）。 */
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    BROW_L_X: 'ParamBrowLX',
    BROW_R_X: 'ParamBrowRX',
    BROW_L_ANGLE: 'ParamBrowLAngle',
    BROW_R_ANGLE: 'ParamBrowRAngle',
    BROW_L_FORM: 'ParamBrowLForm',
    BROW_R_FORM: 'ParamBrowRForm',
    /* 脸红：中文名「12脸红」。⚠️ 不是 ParamCheek —— 这个模型那串
     * ParamCheekNN 是道具/贴图开关（眼泪、星星眼、眼镜…），没有一个是脸红。 */
    CHEEK: 'Paramhh2',
    ANGLE_X: 'ParamAngleX',
    ANGLE_Y: 'ParamAngleY',
    ANGLE_Z: 'ParamAngleZ',
    /* 🔴 BODY_X / BODY_Y / BODY_Z **一个都不填 ID** —— 它们在这个模型里
     * 是 physics3.json 的**输出**，不是输入（hiyori 那边恰好相反，规矩 28
     * 「BODY_Y/Z 是物理输入」只对 hiyori 成立，别当成模型无关的常识）。
     *
     * 看 c_0120.physics3.json：22 组物理里，Output 含 ParamBodyAngleX/Y/Z
     * 和 Param13/Param14（体x/体y），Input 是 ParamAngleX/Y/Z + ParamBreath
     * + **ParamBodyAngleX/Y/Z 自身**（自反馈摆）。
     *
     * 后果分两层，第二层才是要命的：
     *   ① 我们 applyEmotion 用撤销法叠加 delta，物理下一帧直接覆盖输出
     *      → 情绪的"身体倾斜"看着像没生效（静默）；
     *   ② 更糟的是物理**自反馈**：它把 ParamBodyAngleY/Z 当输入读，于是
     *      我们叠加的 delta 会被物理当成"当前摆角"吃进去，带积分的摆会
     *      把这股外力**一轮轮放大** → 抖 / 漂 / 共振。
     *
     * 正解：只写 ANGLE_X/Y/Z（物理的安全输入），身体摇摆由物理自己算出
     * 来 —— 比手写还自然，而且顺带带动呆毛/后发/尾巴/耳朵（见下）。 */
    BREATH: 'ParamBreath',
    /* 🔴 AHOGE **同样不填 ID**。
     * 旧注释写「呆毛1 是自由参数不过物理」——**这条是错的**（2026-10-25
     * 核对 physics3.json 的 Output 表后纠正）。真相是：
     *   呆毛1(ParamHairFront11) / 呆毛R(13) / 呆毛L(24) 全是物理输出，
     *   只有 呆毛2(ParamHairFront12) 不在输出表里。
     * 只写 12 会怎样？另外三根被物理摆、12 被我们摆 → **四根呆毛不同步**，
     * 看着像撕裂；写 11 则每帧被物理冲掉 = 白写。
     * → 全部交给物理：我们动头（ANGLE_X/Z），四根一起跟着荡。 */
    /* SHOULDER / ARM_LA / ARM_RA / EYE_SMILE 缺失 —— 自动跳过。 */
  },

  /* ============================================================
   *  8 情绪 × 16 字段。
   *
   *  ⚠️ 这一整组是**从 hiyori 原样抄来的，还没按这个模型调过**。
   *  抄过来是为了先把链路跑通（字段集一致是档案契约的硬要求）；
   *  每个模型的脸长什么样、参数口径（有的模型 body 是归一值不是度）
   *  都不一样，这表必须在看着真人调过之后才算数。
   *
   *  弯眼（eyeSmile）那一路写了也白写 —— 这模型没有微笑眼参数，
   *  写了会被 put() 静默跳过（保留是为了字段集契约）。
   *
   *  同理 **bodyY / bodyZ / ahoge 三列现在也是"写了不生效"** —— param 里
   *  那三个 ID 已按上文的物理冲突结论清空，put() 会跳过它们。留着数值是
   *  为了①字段集契约（规矩 28，少一个键 verify 就红）；②将来要是这个
   *  模型的物理被关掉（appearance 开关 / 换 physics3.json），把 ID 填回去
   *  立刻就能用，不用重新调表情。
   *  ⚠️ 别因为"看着没变化"就把这三列的数值删了 —— 那是契约不是死代码。
   * ========================================================== */
  emotion: {
    calm:      { browLY: 0,     browRY: 0,     browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0,     eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: 0,   shoulder: 0,    ahoge: 0,    bodyY: 0,    bodyZ: 0 },
    happy:     { browLY: 0.45,  browRY: 0.45,  browLX: 0,     browRX: 0,     browAngle: 0.15,  browForm: 0,    mouthForm: 0.85,  eyeSmile: 1,    eyeOpen: 0.95, cheek: 0.2,  headZ: -4,  headY: -3,  shoulder: 0.1,  ahoge: 0.5,  bodyY: 2.5,  bodyZ: 0 },
    smile:     { browLY: 0.2,   browRY: 0.2,   browLX: 0,     browRX: 0,     browAngle: 0.1,   browForm: 0,    mouthForm: 0.55,  eyeSmile: 0.7,  eyeOpen: 1,    cheek: 0.1,  headZ: -2,  headY: 0,   shoulder: 0,    ahoge: 0.25, bodyY: 1.5,  bodyZ: 0 },
    think:     { browLY: -0.45, browRY: -0.2,  browLX: 0.35,  browRX: -0.3,  browAngle: -0.45, browForm: 0.6,  mouthForm: -0.25, eyeSmile: 0,    eyeOpen: 0.7,  cheek: 0,    headZ: 7,   headY: 2,   shoulder: 0,    ahoge: -0.35, bodyY: 0,   bodyZ: 2.5 },
    shy:       { browLY: -0.25, browRY: -0.25, browLX: 0,     browRX: 0,     browAngle: 0.35,  browForm: 0,    mouthForm: 0.35,  eyeSmile: 0.55, eyeOpen: 0.8,  cheek: 1,    headZ: 0,   headY: 6,   shoulder: 0.25, ahoge: -0.2, bodyY: -3,   bodyZ: 0 },
    serious:   { browLY: -0.6,  browRY: -0.6,  browLX: -0.4,  browRX: -0.4,  browAngle: -0.25, browForm: 0,    mouthForm: -0.45, eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: -1,  shoulder: 0,    ahoge: -0.1, bodyY: 1.5,  bodyZ: 0 },
    surprised: { browLY: 0.8,   browRY: 0.8,   browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.15,  eyeSmile: 0,    eyeOpen: 1.05, cheek: 0.15, headZ: 0,   headY: -2,  shoulder: 0.35, ahoge: 0.85, bodyY: -5,   bodyZ: 0 },
    sleepy:    { browLY: -0.15, browRY: -0.15, browLX: 0,     browRX: 0,     browAngle: 0.1,   browForm: 0,    mouthForm: 0.05,  eyeSmile: 0.25, eyeOpen: 0.35, cheek: 0.12, headZ: 4,   headY: 4,   shoulder: -0.1, ahoge: -0.5, bodyY: 2.5,  bodyZ: 2.5 }
  },

  /* 口径照 hiyori，但这个模型的实际取值范围还没实测 —— 中文名只给了
   * 「是什么」，没给「能到多少」。标定后回来改。 */
  emoRange: {
    browLY: [-1, 1], browRY: [-1, 1], browLX: [-1, 1], browRX: [-1, 1],
    browAngle: [-1, 1], browForm: [-1, 1], mouthForm: [-1, 1],
    eyeSmile: [0, 1], eyeOpen: [0, 1.1], cheek: [0, 1], shoulder: [-1, 1],
    ahoge: [-1, 1], headZ: [-30, 30], headY: [-30, 30],
    bodyY: [-10, 10], bodyZ: [-10, 10]
  },

  patDelta: {
    headY:     { a: -4,    w: 0,    s: 0 },
    headZ:     { a: -2.5,  w: 2.2,  s: 0 },
    ahoge:     { a: 0.3,   w: 0.15, s: 0.55 },
    eyeOpen:   { a: -0.25, w: 0.06, s: 0.55 },
    eyeSmile:  { a: 0.35,  w: 0,    s: 0 },
    cheek:     { a: 0.35,  w: 0.08, s: 1.1 },
    mouthForm: { a: 0.15,  w: 0,    s: 0 },
    shoulder:  { a: 0.12,  w: 0,    s: 0 },
    bodyY:     { a: 0.8,   w: 0,    s: 0 },
    bodyZ:     { a: 1.6,   w: 0.8,  s: 0.3 }
  },

  emoSpeed: {
    browLY: 9, browRY: 9, browLX: 9, browRX: 9, browAngle: 8, browForm: 8,
    eyeSmile: 7, eyeOpen: 7,
    ahoge: 5,
    mouthForm: 4.5,
    cheek: 2.8,
    headZ: 3.2, headY: 3.2,
    shoulder: 2.6, bodyY: 2.2, bodyZ: 2.2
  },

  /* ============================================================
   *  情绪 → 自带表情贴纸（expressions/*.exp3.json，VTS 模型包自带的
   *  44 个表情预设；model3.json 没注册它们 → 引擎不认识，我们自己解析）。
   *
   *  为什么选这几个：**只挑"贴纸/道具类专属参数"**（ParamCheekNN 开关），
   *  剩下那批写 BrowL 系、MouthForm、EyeLOpen 的表情预设与上面 16 字段
   *  **共享同一批参数**，混写会和 applyEmotion 的撤销法打架 —— 那部分
   *  由 pet.js 的加载器**自动过滤**（以 param 表的值集合为准），这里
   *  映射错了也只是不显示，不会脏脸。
   *
   *  上表没有 smile 专属锚点（eyeSmile 写了白写），用「吐舌」补"俏皮"；
   *  happy 的星星眼补"这模型没有微笑眼参数"的缺（param 注释同源）。
   *  文件名必须与 expressions/ 目录逐字一致（中文名，fetch 会编码）。
   *  hiyori 没有这素材，档案不写 stickers → 功能整体自动禁用。
   * ========================================================== */
  expressions: {
    /*  ⚠️ 一个情绪**只能挂一个 exp3**：贴图开关是"开哪一张眼/嘴图"，
     *     两个同时置 1 时谁盖谁由引擎内部顺序决定，不可控（实测过
     *     星星眼 + 兴奋 wink 同时开 = 只有一个生效，但不保证是哪个）。
     *     所以 happy 的「星星眼」让位给整脸表情「开心兴奋」——后者自带
     *     7兴奋wink2 贴图，还带眉压与嘴 1.5，是"整个人在开心"而不只是
     *     "眼睛变星星"。星星眼改由事件触发（见 emotes 表）。 */
    happy:     '开心兴奋',
    smile:     '调皮',      /* 9舔嘴 + 右眼闭 + 嘴 1.5（原「吐舌」转表情? 见 emotes） */
    think:     '问号',      /* 纯贴图，无共享参数 */
    shy:       '流汗',      /* 纯贴图 */
    serious:   '生气',      /* 8生气 + 波浪嘴 + 眉全套（原「阴暗」转心境层） */
    surprised: '感叹号',    /* 纯贴图 */
    sleepy:    '闭眼口水'   /* 纯贴图 */
    /* calm 不配 —— 平静就该是素脸。 */
  },

  /* ============================================================
   *  事件表情：不绑情绪，由具体情境临时播 N 毫秒，与当前情绪**叠加**
   *  （shared 部分走加性增量层、own 部分走绝对写层，两条都不抢情绪的值）。
   *
   *  与 expressions 的区别只有触发方式：那张表跟 emotion 标签走、
   *  强度跟 decayAmt 衰减；这张表由 emote() 起一次性曲线。
   *
   *  ⚠️ 列表里没有「墨镜」——它虽然也写 ParamCheek71，但带 EyeLOpen=-1
   *     （闭眼），戴墨镜这副脸不该在正常互动里出现，留给道具层。
   * ========================================================== */
  emotes: {
    '晕晕': '晕晕',        /* 被拖着快速甩动 → 转晕（16晕晕眼 + 眼半闭 + 眉） */
    '哭': '哭',            /* 连点欺负 → 6哭 + 呆眼 + 波浪嘴 + 眉全套 */
    '悲伤': '悲伤',        /* 1眼泪 + 眉 + 嘴 -1.5（比"哭"轻，不带波浪嘴） */
    '爱心眼': '爱心眼',    /* 3爱心眼 + 脸红 + 眉（"甜到发光"） */
    '星星眼': '星星眼',    /* 2星星眼（原来挂 happy，让位后留给"被夸"） */
    '吐舌': '吐舌',        /* 20舌头 + 歪嘴 + 嘴 0.97（原挂 smile） */
    '阴暗': '阴暗',        /* 11阴暗（原挂 serious，让位后留给"低落"） */
    '呆眼': '呆呆眼',      /* 4呆眼眨眼（长时间没互动 → 发呆） */
    '吐魂': '吐魂',        /* 10吐魂（发呆更久 → 魂飞出去） */
    '心跳': '心跳',        /* 5心跳（纯贴图，心跳符号） */
    '爱心': 'love',        /* 爱心（参数 id 就叫 love） */
    '花花': '情绪花花',    /* 1花_转 = 360（转一圈的花，纯装饰） */
    '脸红': '脸红',        /* 12脸红 —— 与 16 字段的 cheek 同参数，走增量层 */
    '挤': '挤',            /* 挤压 */
    '撤回': '撤回'         /* 撤回 */
  },

  /* ============================================================
   *  道具：不跟情绪、不跟对话，闲置时随机冒出来，几秒到几十秒后自己收掉。
   *
   *  为什么需要一层调度而不是"挂到情绪上"：这些是**穿戴与摆设**
   *  （眼镜 / 猫耳 / 蛋包饭 / 鲸鱼），跟"她现在高不高兴"没有因果关系。
   *  硬绑情绪只会出现"生气时戴上墨镜"这种荒谬组合。
   *
   *  w = 权重（越大越常出现；0 = 不参与随机，只能手动）
   *  ms = [最短, 最长] 持续时间（毫秒）
   *  ⚠️ 权重是**相对值**不是百分比，加一项不需要重算别的。
   *  ⚠️ 同时只挂一个：眼镜叠猫耳再叠鲸鱼，脸上会糊成一团。
   * ========================================================== */
  props: [
    /* —— 穿戴 —— */
    { file: '圆眼镜',   w: 2.0, ms: [25000, 60000] },
    { file: '方眼镜',   w: 1.5, ms: [25000, 60000] },
    { file: '椭圆眼镜', w: 1.5, ms: [25000, 60000] },
    { file: '头箍',     w: 2.0, ms: [20000, 50000] },
    { file: '兔兔贴纸', w: 2.0, ms: [20000, 50000] },
    { file: '猫猫贴纸', w: 2.0, ms: [20000, 50000] },
    { file: '蝴蝶结贴纸', w: 2.0, ms: [20000, 50000] },
    { file: '单边马尾', w: 1.5, ms: [30000, 80000] },
    { file: '魔爪',     w: 1.0, ms: [15000, 35000] },
    { file: '喵喵手~喵~动画', w: 1.0, ms: [15000, 35000] },
    { file: '双手比耶', w: 1.0, ms: [15000, 30000] },
    /* —— 摆件 —— */
    { file: '巴菲',     w: 1.5, ms: [25000, 55000] },
    { file: '蛋包饭',   w: 1.5, ms: [25000, 55000] },
    { file: '鲸鱼',     w: 1.0, ms: [25000, 60000] },
    { file: '鲸鱼放桌上', w: 1.0, ms: [25000, 60000] },
    { file: '画笔',     w: 1.0, ms: [20000, 45000] },
    { file: '橡皮',     w: 0.8, ms: [20000, 45000] },
    { file: '点菜按下', w: 0.8, ms: [15000, 30000] }
    /* 暂不参与随机（要单独真机确认语义，写错会一直挂在身上）：
     *   手机换色 / 魔爪换色 / 深色桌布 —— 看着是**状态切换**不是开关，
     *   置 1 之后是否还会自己回去没验证过；
     *   墨镜 —— 带 EyeOpen=-1，戴上就闭眼，不适合随机。 */
  ]
};
