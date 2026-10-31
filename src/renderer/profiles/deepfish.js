/* deepfish（大肥鱼 / DeepSeek-chan）的模型档案 —— **只读数据，零逻辑**。
 *
 * 契约与 hiyori.js / whale.js 相同，照那份文件的头注释读一遍再改这里。
 *
 * ⚠️ 这个模型是 **VTube Studio 模型包**改来的（神宫凉子原画 / 霓虹猫建模，
 *    由用户以「DeepSeek免费公皮」名义放入），和 whale 同源 —— 设计前提与
 *    hiyori 那套**完全不同**，四条必须先记住：
 *
 *  1) **它的"表情"是贴图切换，不是参数插值。**
 *     509 个参数里，匿名 key1~key13 写着真相（实测自 expressions/*.exp3.json）：
 *       key1=黑脸  key2=流泪  key3=圈圈眼  key4=爱心眼  key5=＞＜
 *       key7=脸红  key8=加载  key9=兔牙  key10=钢盆  key11=黑框眼镜
 *       key12=单片眼镜  key13=流冷汗
 *     这些是**贴图开关**（开=换一张眼/嘴的图），不是连续量。
 *     → 本项目规矩 28 的情绪引擎是连续插值，所以**这些一个都不接**；
 *       只接能连续插值的那批（眉/眼开闭/嘴形/头姿/呼吸）。
 *
 *  2) **它的 physics3.json 是 Cubism 5 格式**（PhysicsSettings 是链条数组，
 *     每条链 Input[].Source.Id → Output[].Destination.Id），跟 whale 的
 *     Cubism 4（PhysicsSettings 是单个对象）不同 —— 但引擎走 cubism5.es.js，
 *     加载无碍（实测 moc3 头 = MOC3 Version 5）。
 *
 *  3) **头物理链的输入是 AngleX/Y/Z，不是 ParamAngleX/Y/Z。**
 *     实测 physics3.json 的链条：AngleX → ParamAngleX（scale 28），
 *     而 ParamAngleX/Y/Z 是**物理输出**（自反馈链）—— 和 hiyori 正好相反。
 *     写 ParamAngle* 会被物理覆盖（静默失效），必须写 **AngleX/Y/Z**。
 *     注意 AngleX/Y/Z 在 cdi3.json 里确实存在（见 verify 断言）。
 *
 *  4) **它缺一批器官**：ParamEyeLSmile/RSmile（微笑眼）、ParamBodyAngle*
 *     （身体摇摆）、ParamShoulder*（肩）、ParamArmLA/RA（手臂）、ParamHairFront*
 *     （呆毛）、ParamMouthOpenY 之外的嘴形参数（ParamMouthForm 存在但过物理）
 *     —— 情绪引擎里这些字段照写（保证 8 情绪字段集一致），param 里不填 ID，
 *     put() 会自动跳过（静默、无害）。
 *
 *  🔴 **授权红线（素材自带使用须知明示）**：
 *     · 禁止二次销售 / 禁止重新分发（禁止分发行为，但「本地自用接入本项目」
 *       不在其列）→ 本项目**不将其作为默认模型、不随包分发**；用户本地自用，
 *       菜单上可切。
 *     · 署名要求：素材内嵌署名（神宫凉子 / 霓虹猫），本项目切换到该模型时
 *       toast 一次署名提示（见 DEEPFISH_CREDIT）。
 *     · 商用授权未齐前，仅本地可切、不上架默认。
 */

/* 切到本模型时 toast 一次的署名（X1）。素材源自免费公开配布的第三方模型，
 * 原画：神宫凉子，建模：霓虹猫_NeonNeko；有署名要求、禁二次分发。 */
export const DEEPFISH_CREDIT = '大肥鱼素材源自神宫凉子 / 霓虹猫 免费公开模型，禁止二次分发';

export const DEEPFISH = {
  name: 'deepfish',
  credit: DEEPFISH_CREDIT,

  /* 本档情绪齐全、口型全开（ParamMouthOpenY 存在且过物理自反馈链，
   * 口型引擎每帧直接写它 —— 物理下一帧会覆盖，但口型引擎是每帧写，
   * 所以视觉上有效；若将来实测发现口型被冲掉，再考虑走 AngleX 系）。 */
  emotionAlias: {},
  mouthOpenMax: 1,

  model: {
    label: '大肥鱼',
    url: '/src/assets/models/deepfish/大肥鱼.model3.json',
    /* 🔴 2026-10-31 深夜 **撤销退役**（用户改主意：要 DeepSeek 鲸鱼娘上线）。
     * 素材是 DeepSeek 平台免费角色皮，用户本地自用；素材 187M、20+ 表情、
     * 8 动作、5 纹理全在 src/assets/models/deepfish/。
     * 上一轮取景（alignByMeasure + 几何常数）已实测修好、未删。 */
    anchorY: 'top',          // 站姿模型：顶部锚定（whale 那种趴姿才用 'bottom'）
    /* ---- 几何标定：2026-10-31 用 debug/calib-inkbox.js 从 moc3 顶点实测 ----
     * 为什么不用截图量（calib-whale.js 那条路）：本机 GPU 是软件合成
     * （[gpu] compositing/rasterization = disabled_software），8K 纹理下
     * 大窗口渲染极慢、小窗口经常在贴图传完前就截图，量出一片空白；
     * 而且 ?pet= 压小时窗口会裁掉下半身。顶点是**离线**读的，不依赖窗口。
     *
     * 量出来的画布真值：3749×7697（hiyori 2976×4175 / whale 4068×4068），
     * 墨水包围盒 x 159..3748、y 542..7334（canvas px，原点左上）。
     *
     * 🔴 inkTopCRatio 记 **0**：本模型的画布就贴在 holder 原点（实测
     *   rawBounds 恒为 [0,0,...]，且 pet=0.63 时实测墨水顶 = off.y +
     *   542×s 与推算逐像素吻合），所以「墨水顶 = vh×C + K×s」里 C 项
     *   不存在，K 直接就是包围盒上沿的 canvas 坐标。 */
    inkTopCRatio: 0,
    /* 🔴 本模型必须**实测对齐**：档案常数是"落点 = 常数 × s"的线性假设，
     * 而它的画布 3749×7697 下这条不成立 —— 实测（?snap=fit 读画布像素）
     * 模型落在画布左下 (4,305)，推算却是 (70,13)，差出半个画布；画布又是
     * 窗口的 2.898 倍，于是人物整体落在窗口外，屏幕上只剩呆毛尖。
     * 置 true 后 layout() 用 measureCanvasInk() 量到的包围盒对齐
     * （墨水中心 → 窗口中线、墨水顶 → HEAD_PAD），下面那组常数只作兜底。 */
    alignByMeasure: true,
    petScale: 0.57,          // 全身可见：脚底 ≈ 窗口底，头顶留 HEAD_PAD（@H296 标定）
    headPadRatio: 0.0431,    // 顶部留白比例（沿用全项目口径，光学微调）
    inkTopK: 542,            // 墨水顶（canvas px，实测）
    inkH: 6793,              // 墨水总高 542 → 7334
    inkW: 3589,              // 轮廓最大宽（含张开的衣袖；穿透判定用）
    inkCxK: 1875,            // **头顶带中心线**（canvas 中心，实测）
    /* 自带 8 个动作全部 Loop:true 但首尾不闭合（VTS 模型包通病，
     * 与 whale 官方动作同判据）→ 一个都不留，交给插件 idle 调度接管。 */
    keepLoopGroups: [],
    /* 工作状态槽位：暂无自制 Drag/Walk，全部空。 */
    motionSlots: {
      thinking: '',
      working: '',
      success: '',
      error: '',
      drag: '',
      walk: ''
    }
  },

  /* 参数 ID 全部来自 大肥鱼.cdi3.json 的 509 个参数（verify 会逐个回查）。 */
  param: {
    MOUTH_OPEN: 'ParamMouthOpenY',
    MOUTH_FORM: 'ParamMouthForm',
    EYE_L: 'ParamEyeLOpen',
    EYE_R: 'ParamEyeROpen',
    /* 🔴 W59（2026-10-31 纠正）：这模型**有**微笑眼参数 —— `EyeSmile`。
     * 之前按 hiyori 口径找 `ParamEyeLSmile` 找不到就判「没有微笑眼」，
     * 白砍了一半表情表现力。真相：cdi3.json 里是 `EyeSmile`（**无 Param
     * 前缀**、且无 L/R 之分，单个参数管两眼）。
     * physics3.json 实测它是物理**输入**（Source）→ 写入安全、每帧不被覆盖。
     * EYE_L_SMILE 与 EYE_R_SMILE 指向同一个 ID：pet.js 连写两次，put() 幂等。 */
    EYE_L_SMILE: 'EyeSmile',
    EYE_R_SMILE: 'EyeSmile',
    BROW_L_Y: 'ParamBrowLY',
    BROW_R_Y: 'ParamBrowRY',
    /* 🔴 这模型没有眉毛 X 位移和形态参数（只有 Angle 系，见 cdi3.json
     * 实测：ParamBrowLX/RX/Form/RForm 均不存在）→ 置 null，
     * put() 自动跳过（情绪表里对应字段照写，守字段集契约）。 */
    BROW_L_X: null,
    BROW_R_X: null,
    /* 🔴 BROW_L/R_ANGLE 是**物理输出**（与 whale 不同！whale 的眉毛 Angle
     * 不是物理输出，所以 whale 填了 ID；本模型实测 physics3.json 的
     * Output 表包含 ParamBrowLAngle/RAngle）→ 写入会被物理覆盖（静默失效）。
     * 更糟的是物理可能自反馈（拿它当输入），叠加的 delta 会被放大。 */
    BROW_L_ANGLE: null,
    BROW_R_ANGLE: null,
    BROW_L_FORM: null,
    BROW_R_FORM: null,
    /* 脸红：key7（贴图开关）不接；这模型没有连续脸红参数
     * （Paramhh2 是 whale 的，本模型不存在）。 */
    CHEEK: null,             // 无连续脸红参数 → put() 自动跳过
    /* 🔴 头物理链输入是 **AngleX/Y/Z**（physics3.json 的 Source），
     *    ParamAngleX/Y/Z 是物理输出（自反馈链）→ 必须写 AngleX/Y/Z。
     *    注意：cdi3.json 里 AngleX/Y/Z 确实存在（verify 断言回查）。 */
    ANGLE_X: 'AngleX',
    ANGLE_Y: 'AngleY',
    ANGLE_Z: 'AngleZ',
    /* 🔴 BODY_X / BODY_Y / BODY_Z 一个都不填 —— 这模型没有身体摇摆参数
     * （ParamBodyAngle* 是物理输出，且它的输入链是 ParamAngle* 系，
     * 与 hiyori 的"身体摇摆 = 物理输入"完全不同）。 */
    BREATH: 'ParamBreath',
    /* 🔴 AHOGE 不填 —— 这模型没有呆毛参数（ParamHairFront* 不存在）。
     * 表情贴图层（expressions 表）会用 key 参数补"呆毛感"。 */
    /* SHOULDER / ARM_LA / ARM_RA / EYE_SMILE / CHEEK 缺失 —— 自动跳过。 */
  },

  /* ============================================================
   *  8 情绪 × 16 字段（参考 whale 的 G18 重调口径，待真机微调）
   *
   *  这模型没有微笑眼参数 → eyeSmile 列写了 put() 也跳过（契约保留）。
   *  补偿：用 **眉 / 眼开闭 / 嘴形 / 头姿** 把情绪读出来；
   *  贴纸层（expressions 表）再叠一层贴图开关，连续脸 + 贴纸互补。
   *
   *  headY/headZ 走 AngleX/Y/Z（物理输入，可直控）；
   *  bodyY/bodyZ/ahoge/shoulder 写了不生效（缺参数，物理输出），
   *  数值留着守字段集契约，别当死代码删。
   * ========================================================== */
  emotion: {
    calm:      { browLY: 0,     browRY: 0,     browLX: 0,     browRX: 0,     browAngle: 0,     browForm: 0,    mouthForm: 0,     eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: 0,   shoulder: 0,    ahoge: 0,    bodyY: 0,    bodyZ: 0 },
    happy:     { browLY: 0.35,  browRY: 0.35,  browLX: 0,     browRX: 0,     browAngle: 0.2,   browForm: 0,    mouthForm: 0.95,  eyeSmile: 1,    eyeOpen: 0.88, cheek: 0.45, headZ: -6,  headY: -2,  shoulder: 0.1,  ahoge: 0.5,  bodyY: 2.5,  bodyZ: 0 },
    smile:     { browLY: 0.18,  browRY: 0.18,  browLX: 0,     browRX: 0,     browAngle: 0.12,  browForm: 0,    mouthForm: 0.7,   eyeSmile: 0.7,  eyeOpen: 0.92, cheek: 0.28, headZ: -3,  headY: 0,   shoulder: 0,    ahoge: 0.25, bodyY: 1.5,  bodyZ: 0 },
    think:     { browLY: -0.5,  browRY: -0.18, browLX: 0.4,   browRX: -0.35, browAngle: -0.5,  browForm: 0.7,  mouthForm: -0.35, eyeSmile: 0,    eyeOpen: 0.65, cheek: 0,    headZ: 8,   headY: 3,   shoulder: 0,    ahoge: -0.35, bodyY: 0,   bodyZ: 2.5 },
    shy:       { browLY: -0.3,  browRY: -0.3,  browLX: 0,     browRX: 0,     browAngle: 0.4,   browForm: 0,    mouthForm: 0.42,  eyeSmile: 0.55, eyeOpen: 0.72, cheek: 1,    headZ: 2,   headY: 8,   shoulder: 0.25, ahoge: -0.2, bodyY: -3,   bodyZ: 0 },
    serious:   { browLY: -0.75, browRY: -0.75, browLX: -0.5,  browRX: -0.5,  browAngle: -0.3,  browForm: 0.15, mouthForm: -0.55, eyeSmile: 0,    eyeOpen: 1,    cheek: 0,    headZ: 0,   headY: -2,  shoulder: 0,    ahoge: -0.1, bodyY: 1.5,  bodyZ: 0 },
    surprised: { browLY: 0.9,   browRY: 0.9,   browLX: 0,     browRX: 0,     browAngle: 0.05,  browForm: 0,    mouthForm: 0.4,   eyeSmile: 0,    eyeOpen: 1.08, cheek: 0.28, headZ: 0,   headY: -4,  shoulder: 0.35, ahoge: 0.85, bodyY: -5,   bodyZ: 0 },
    sleepy:    { browLY: -0.22, browRY: -0.22, browLX: 0,     browRX: 0,     browAngle: 0.12,  browForm: 0,    mouthForm: 0.1,   eyeSmile: 0.25, eyeOpen: 0.28, cheek: 0.2,  headZ: 6,   headY: 5,   shoulder: -0.1, ahoge: -0.5, bodyY: 2.5,  bodyZ: 2.5 }
  },

  /* 口径照 whale，但这个模型的实际取值范围还没实测 —— 中文名只给了
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
   *  24 个表情预设；model3.json 已注册 Expressions 段 → 引擎认识，
   *  但我们仍走 pet.js 的 fetch 解析通道，与 whale 同口径）。
   *
   *  为什么选这几个：**只挑"贴纸/道具类专属参数"**（key/Clothes/Movement 系），
   *  剩下那批（key3/key4/key5/key6 的圈圈眼组合、Clothes2 体型切换…）
   *  与 16 字段共享同一批参数或语义不明确，混写会和 applyEmotion 的
   *  撤销法打架 —— 那部分由 pet.js 的加载器**自动过滤**（以 param 表的
   *  值集合为准），这里映射错了也只是不显示，不会脏脸。
   *
   *  ⚠️ 一个情绪**只能挂一个 exp3**：贴图开关是"开哪一张眼/嘴图"，
   *     两个同时置 1 时谁盖谁由引擎内部顺序决定，不可控。
   *
   *  文件名必须与 expressions/ 目录逐字一致（中文名，fetch 会编码）。
   *  hiyori 没有这素材，档案不写 stickers → 功能整体自动禁用。
   * ========================================================== */
  expressions: {
    /* 🔴 每个 key 参数只能被**一个通道**（emo/ev/prop）触碰 ——
     * applyExpressions 里 emo 先写、ev 后写、prop 最后写，
     * 多通道同 key 时"谁后写谁赢"，淡出那一帧会把另一通道的贴纸盖掉。
     * emo 表内部同理：两个文件写同一个 key 会在切情绪时打架。
     *
     * 分配（全部互不重叠）：
     *   ＞＜ → key5（emo.smile 独占 key3/4/5/6 家族）
     *   兔牙 → key9   加载 → key8   脸红 → key7
     *   黑脸 → key1   流冷汗 → key13  单片眼镜 → key12
     *   圈圈眼/爱心眼/屑屑眼 全部**不可用**（与 ＞＜ 抢 key3/4/5/6）
     *   流泪 → key2（留给 ev.哭）  钢盆 → key10（留给 ev）
     *   黑框眼镜 → key11（留给 ev）  竖食指/Clothes 系 → prop 专用
     * ========================================================== */
    happy:     '兔牙',       /* key9=兔牙（开心露兔牙） */
    smile:     '＞＜',        /* key5=＞＜（俏皮眯眼） */
    think:     '加载',        /* key8=加载（思考中…） */
    shy:       '脸红',        /* key7=脸红 */
    serious:   '黑脸',        /* key1=黑脸（生气） */
    surprised: '流冷汗',      /* key13=流冷汗（惊讶冒汗） */
    sleepy:    '单片眼镜',    /* key12=单片眼镜（睡眼惺忪戴单片） */
    /* calm 不配 —— 平静就该是素脸。 */
  },

  /* ============================================================
   *  事件表情：不绑情绪，由具体情境临时播 N 毫秒，与当前情绪**叠加**。
   *
   *  与 expressions 的区别只有触发方式：那张表跟 emotion 标签走、
   *  强度跟 decayAmt 衰减；这张表由 emote() 起一次性曲线。
   *
   *  🔴 🔴 key 参数一共只有 13 个，emo 表已经占掉 9 个家族
   *     （key1/5/7/8/9/12/13 + key3/4/5/6 家族整体），
   *     剩下的 key2/key10/key11 全部分给 ev 通道 —— 不重叠是硬约束
   *     （applyExpressions 里 ev 后写，同 key 会把 emo 的贴纸盖掉）。
   *     '圈圈眼/爱心眼/兔牙/流冷汗/脸红/黑脸/＞＜' 全部**不可用**：
   *     它们与 emo 表抢 key 参数。
   *
   *  ⚠️ 只挂纯贴图类（key 参数），不挂共享参数的表情。
   * ========================================================== */
  emotes: {
    '哭': '流泪',            /* key2=流泪（连点欺负 → 哭） */
    '悲伤': '流泪',          /* key2=流泪（比"哭"轻，同文件无害：
                                   evName 同一时刻只有一个） */
    '钢盆': '钢盆',          /* key10=钢盆（头顶钢盆） */
    '黑框眼镜': '黑框眼镜',  /* key11=黑框眼镜（戴上） */
    /* '星星眼'→圈圈眼(key3/4/5/6 家族) ✗ 与 emo.smile 抢
     * '爱心'→爱心眼(key4) ✗ 与 emo.smile 抢家族
     * '呆眼'/'花花'→兔牙(key9) ✗ 与 emo.happy 抢
     * '吐魂'→流冷汗(key13) ✗ 与 emo.surprised 抢
     * '脸红'→脸红(key7) ✗ 与 emo.shy 抢
     * '挤'→黑脸(key1) ✗ 与 emo.serious 抢
     * '晕晕'→＞＜(key5) ✗ 与 emo.smile 抢家族 */
  },

  /* ============================================================
   *  道具：不跟情绪、不跟对话，闲置时随机冒出来，几秒到几十秒后自己收掉。
   *
   *  ⚠️ 只挂纯贴图类（key/Clothes/Movement 系），且语义明确的。
   *  ⚠️ 同时只挂一个：眼镜叠猫耳再叠鲸鱼，脸上会糊成一团。
   * ========================================================== */
  /* 🔴 key1~key13 已全部被 emo/ev 两通道瓜分（见上两张表的注释），
   *    prop 通道只能用 **Clothes 系**（Clothes1~5）—— 这些是衣物/身体
   *    开关，与 16 字段情绪和 key 贴纸都不冲突。
   *   竖食指开/关（Movement3）✗ 手势动作参数，可能和动作抢
   *   前倾（LeanInput=-30）✗ 疑似物理输入，写了会被物理覆盖
   *   体型1/体型2/默认体型（Clothes2）✗ 三件都写 Clothes2，切换时
   *     旧道具归零写 def、新道具写 val，但三件同池会导致体型来回跳。 */
  props: [
    { file: '尾巴开关',   w: 2.0, ms: [25000, 60000] },
    { file: '胸口衣服',   w: 1.5, ms: [25000, 55000] },
    { file: '脱鞋',       w: 1.5, ms: [20000, 50000] },
    { file: '裙子切换',   w: 1.5, ms: [25000, 55000] }
  ]
};
