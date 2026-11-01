/* whalegirl（自研鲸鱼娘）的模型档案 —— **只读数据，零逻辑**。
 *
 * 契约与 hiyori.js 完全相同，照那份文件的头注释读一遍再改这里。
 *
 * 🔴 这是 2026-10-31 用 psd2live + ImageGen 全流程自制的模型：
 *    ImageGen 生成源图 → 程序拆层（split-layers.js）→ MCP 导入 manifest
 *    → rig 生成 → 导出 moc3 + 全套 JSON + 纹理。
 *    路线详见 docs/custom-model-plan.md §12。
 *
 * ⚠️ 模型的参数集是 psd2live 自动绑骨产出的**标准 Cubism 5 参数**（20 个），
 *    比 hiyori/whale 都精简 —— 没有眉毛 X/角度/形状、没有微笑眼、没有脸红、
 *    没有手臂/肩膀、没有呆毛独立参数。emotion 表的 16 字段契约照写
 *    （引擎的 put() 对不存在的 ID 静默跳过），但 param 表只映射真实存在的。
 */

/* 自研模型，无第三方署名要求。 */
export const WHALEGIRL_CREDIT = '自研鲸鱼娘 · ImageGen 生成 + psd2live 绑骨导出';

export const WHALEGIRL = {
  name: 'whalegirl',
  credit: WHALEGIRL_CREDIT,

  /* 情绪齐全、口型全开（psd2live 标准绑骨，ParamMouthOpenY 默认范围 0~1）。 */
  emotionAlias: {},
  mouthOpenMax: 1,

  model: {
    label: '鲸鱼娘（自研）',
    url: '/src/assets/models/selfmade/export/whale-girl.model3.json',
    /* ---- 几何标定：待真机实测后回填 ----
     * psd2live 导出的画布尺寸未知，先用占位值。
     * 🔴 第一次挂载前必须用 alignByMeasure 实测对齐（规矩 2），
     *    因为这是新画布尺寸，线性假设大概率不成立。 */
    anchorY: 'top',
    /* alignByMeasure 实测对齐（新模型画布尺寸未知，线性假设大概率失效） */
    alignByMeasure: true,
    petScale: 0.3,          // 初始估计值，待实测后调整
    headPadRatio: 0.0431,   // 初始估计值，待实测后调整
    /* 以下常数在 alignByMeasure 生效后不会被使用，保留契约完整 */
    inkTopCRatio: 0.2,
    inkTopK: 0,
    inkH: 1473,             // 源图人物高度（像素）
    inkW: 673,              // 源图人物宽度（像素）
    inkCxK: 0,              // 待标定
    keepLoopGroups: [],
    /* psd2live 导出的动作组：只有 idle（待机呼吸），无其它动作。 */
    motionSlots: {
      thinking: '',
      working: '',
      success: '',
      error: '',
      drag: '',
      walk: ''
    }
  },

  /* 参数 ID 全部来自 whale-girl.cdi3.json（psd2live 标准绑骨，20 个参数）。
   * 可用参数：
   *   ParamAngleX/Y/Z       头三轴旋转
   *   ParamEyeLOpen/ROpen   左右眼开合
   *   ParamEyeBallX/Y       眼球位置
   *   ParamEyeBallForm      果冻眼（眼球形变）
   *   ParamBrowLY/RY        左右眉 Y
   *   ParamMouthForm        嘴型
   *   ParamMouthOpenY       嘴巴开合
   *   ParamBodyAngleX/Y/Z   身体三轴旋转
   *   ParamBodyLean         身体前后倾
   *   ParamProportion       头身比
   *   ParamBreath           呼吸
   *   ParamHairFront        前发摆动
   *   ParamHairBack         后发摆动
   *
   * 🔴 缺失（引擎 put() 自动跳过，emotion 表仍写字段保契约）：
   *   EYE_L_SMILE / EYE_R_SMILE  —— 无微笑眼参数
   *   BROW_L_X / BROW_R_X        —— 无眉毛水平位移
   *   BROW_L_ANGLE / BROW_R_ANGLE —— 无眉毛角度
   *   BROW_L_FORM / BROW_R_FORM   —— 无眉毛形状
   *   CHEEK                       —— 无脸红参数
   *   SHOULDER                    —— 无肩膀参数
   *   ARM_LA / ARM_RA             —— 无手臂参数
   *   AHOGE                       —— 无呆毛独立参数（前发整体摆动）
   *   BODY_Y / BODY_Z             —— 无身体 Y/Z 平移（有 ParamBodyLean 前后倾）
   */
  param: {
    MOUTH_OPEN: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    EYE_L: 'ParamEyeLOpen',
    EYE_R: 'ParamEyeROpen',
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    /* BROW_L_X / BROW_R_X / BROW_L_ANGLE / BROW_R_ANGLE / BROW_L_FORM / BROW_R_FORM
     * 缺失 —— 自动跳过。 */
    ANGLE_X: 'ParamAngleX',
    ANGLE_Y: 'ParamAngleY',
    ANGLE_Z: 'ParamAngleZ',
    BODY_Y: 'ParamBodyLean',   /* 前后倾代替身体 Y（无 ParamBodyY） */
    /* BODY_X / BODY_Z 缺失 —— 无对应参数。 */
    BREATH: 'ParamBreath',
    HAIR_FRONT: 'ParamHairFront',
    HAIR_BACK: 'ParamHairBack',
    /* EYE_SMILE / CHEEK / SHOULDER / ARM_LA / ARM_RA / AHOGE 缺失 —— 自动跳过。 */
    /* 眼球参数（psd2live 标准绑骨独有，hiyori/whale 没有）：
     * 用于视线追踪（看鼠标方向），但当前情绪引擎未使用，留作扩展。 */
  },

  /* ============================================================
   *  8 情绪 × 16 字段
   *
   *  这个模型参数精简：没有微笑眼、眉毛只能上下动、没有脸红、没有呆毛。
   *  情绪表达靠：眉 Y + 眼开合 + 嘴型 + 头姿 + 身体前倾 + 呼吸。
   *  bodyY 字段映射到 ParamBodyLean（前后倾），bodyZ 留空（无对应参数）。
   * ========================================================== */
  emotion: {
    calm:      { browLY: 0,     browRY: 0,     browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0,     eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: 0,   shoulder: 0,    ahoge: 0,    bodyY: 0,    bodyZ: 0 },
    happy:     { browLY: 0.4,   browRY: 0.4,   browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.8,   eyeSmile: 0,    eyeOpen: 0.85, cheek: 0,    headZ: -5,  headY: -2,  shoulder: 0,    ahoge: 0,    bodyY: 1.5,  bodyZ: 0 },
    smile:     { browLY: 0.2,   browRY: 0.2,   browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.6,   eyeSmile: 0,    eyeOpen: 0.9,  cheek: 0,    headZ: -3,  headY: 0,   shoulder: 0,    ahoge: 0,    bodyY: 1,    bodyZ: 0 },
    think:     { browLY: -0.4,  browRY: -0.15, browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: -0.3,  eyeSmile: 0,    eyeOpen: 0.7,  cheek: 0,    headZ: 6,   headY: 3,   shoulder: 0,    ahoge: 0,    bodyY: 0.5,  bodyZ: 0 },
    shy:       { browLY: -0.2,  browRY: -0.2,  browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.3,   eyeSmile: 0,    eyeOpen: 0.75, cheek: 0,    headZ: 2,   headY: 6,   shoulder: 0,    ahoge: 0,    bodyY: -1.5, bodyZ: 0 },
    serious:   { browLY: -0.6,  browRY: -0.6,  browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: -0.5,  eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: -2,  shoulder: 0,    ahoge: 0,    bodyY: 0.5,  bodyZ: 0 },
    surprised: { browLY: 0.8,   browRY: 0.8,   browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.3,   eyeSmile: 0,    eyeOpen: 1.08, cheek: 0,    headZ: 0,   headY: -3,  shoulder: 0,    ahoge: 0,    bodyY: -2,   bodyZ: 0 },
    sleepy:    { browLY: -0.2,  browRY: -0.2,  browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0.1,   eyeSmile: 0,    eyeOpen: 0.3,  cheek: 0,    headZ: 5,   headY: 4,   shoulder: 0,    ahoge: 0,    bodyY: 1,    bodyZ: 0 },
    sad:       { browLY: -0.5,  browRY: -0.3,  browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: -0.4,  eyeSmile: 0,    eyeOpen: 0.6,  cheek: 0,    headZ: 4,   headY: 2,   shoulder: 0,    ahoge: 0,    bodyY: -1,   bodyZ: 0 }
  },

  /* psd2live 标准绑骨的参数范围（Cubism 5 默认值）：
   * 眉 Y: [-1, 1] · 眼开合: [0, 1] · 嘴型: [-1, 1] · 头角度: [-30, 30]
   * 身体角度: [-30, 30] · 身体前倾: [-10, 10] · 呼吸: [0, 1] */
  emoRange: {
    browLY: [-1, 1], browRY: [-1, 1], browLX: [-1, 1], browRX: [-1, 1],
    browAngle: [-1, 1], browForm: [-1, 1], mouthForm: [-1, 1],
    eyeSmile: [0, 1], eyeOpen: [0, 1.1], cheek: [0, 1], shoulder: [-1, 1],
    ahoge: [-1, 1], headZ: [-30, 30], headY: [-30, 30],
    bodyY: [-10, 10], bodyZ: [-10, 10]
  },

  patDelta: {
    headY:     { a: -3,    w: 0,    s: 0 },
    headZ:     { a: -2,    w: 1.8,  s: 0 },
    eyeOpen:   { a: -0.2,  w: 0.05, s: 0.5 },
    mouthForm: { a: 0.12,  w: 0,    s: 0 },
    bodyY:     { a: 0.6,   w: 0,    s: 0 }
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
   *  expressions：psd2live 自动绑骨生成的 4 个标准表情（微笑/悲伤/生气/惊讶）。
   *  参数全是 16 字段体系内的（MouthForm / EyeOpen / BrowY），与 emotion 表
   *  共享参数 —— 加载器会自动分流（shared 走加性、专属走绝对写）。
   *  ⚠️ 一个情绪只挂一个 exp3（规矩 32）。
   * ========================================================== */
  expressions: {
    happy:     'smile',
    sad:       'sad',
    serious:   'angry',
    surprised: 'surprised'
    /* smile / think / shy / sleepy 不配 —— 素脸或靠 16 字段插值。 */
  },
  emotes: {},
  props: []
};
