'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/* ============================================================
 *  配置
 * ==========================================================
 *
 *  这里只有**纯读写**：默认值、读、写、路径。
 *  「改一段 + 广播 + 重画托盘」那种编排留在 main.js 的 patchConfig()，
 *  因为它要碰窗口和托盘 —— 放进来的话 config 就得反过来 require 主文件，
 *  循环依赖立刻出现。
 * ========================================================== */

const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');

/* 外观两项的合法区间。
 *
 * 这两个数原先散在 main.js 的多处（同步外观、托盘标题、加减、
 * 右键菜单），改一处漏一处就会出现「菜单显示 90%、窗口却是 70%」
 * 这种只在一半入口上复现的偏差。
 * ⚠️ 渲染层 pet.js 里的 SCALE_MIN / SCALE_MAX 必须与此保持一致。 */
const LIMITS = {
  scale: { min: 0.5, max: 1.4, step: 0.06 },
  opacity: { min: 0.25, max: 1 }
};

/* 自定义名称的合法区间。
 *
 * 上限 12 个字符不是因为存储限制，而是**显示限制**：托盘 tooltip 是单行，
 * 窗口标题也是单行，名字太长会把托盘提示撑得没法看。
 * 下限 1 是「不许为空」—— 空名字会让托盘提示和窗口标题变成空白，
 * 看起来像程序坏了。
 *
 * ⚠️ 主进程和渲染层都要用这个区间：入口在托盘/右键菜单（主进程），
 *    但渲染层的气泡也可能要显示名字。改这里必须同步改 pet.js 里的
 *    NAME_MIN / NAME_MAX（与 SCALE_MIN/MAX 同样的成对约定）。 */
const NAME_LIMITS = { min: 1, max: 12 };

const DEFAULT_CONFIG = {
  /* 对话后端。任何 OpenAI 兼容服务都能接：换服务只动这三个字段。
   * 默认值是 DeepSeek 官方，但**没填 apiKey 时走离线话术**，所以默认状态
   * 不会往外发任何请求。
   *
   * extraBody 是透传给服务方的额外请求体字段（浅合并），给「各家自己的开关」
   * 留口子。最常用的是关掉混合思考模型的思考阶段：`{"enable_thinking": false}`——
   * 不关的话正文之前会先静默推理一段（实测首字 1087ms → 523ms）。
   * ⚠️ model / messages / stream 是本层的契约，不会被 extraBody 顶掉。
   * ⚠️ 「模型设置」页高级折叠里可改（M5）；不会的别碰，空对象 = 不传额外字段。
   *
   * 两个超时（2026-10-13 补）。在这之前请求是**完全没有超时**的：服务端连上
   * 之后不再吐数据，请求就永远不返回，气泡停在"打字中"那一帧，只能杀进程。
   *   stallMs —— 连上了但不再有新数据。**每收到一段就重新计时**，
   *              所以正常的长回答不会被它掐掉，拦的是"卡住"不是"慢"。
   *   totalMs —— 整轮上限，拦那种一直慢慢吐、永远吐不完的。
   * ⚠️ 上下限与这里的默认值同在 llm.js 的 LLM_TIMEOUT —— 改一处必须改两处
   *    （verify-llm 有断言拦这条）。 */
  llm: {
    /* 上次选中的预设（见 llm-providers.js 的 PROVIDERS）。
     * 它**只是标签**：真正发请求用的仍然是下面 baseUrl / model 两个值。
     * 这样手改过地址的用户不会被"选中预设"悄悄顶回默认端点。
     * 旧配置里没有这个键时，托盘标题回落成"自定义"。 */
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    extraBody: {},
    stallMs: 20000,
    totalMs: 120000,
    /* M8：真测一句通过后记下指纹（baseUrl+model）。菜单打 ✓；
     * 地址或模型名一变绿标自动掉。不存 apiKey。 */
    tested: null,
    /* W16：真测一句才算就绪。默认关 —— 老用户已有 key 但没点过「测试连接」
     * 不该突然变哑巴；打开后 chat 也要绿标才走在线。看屏（G23）始终要 ready。 */
    requireTested: false,
    /* 多配置档（M6）：「家里 Ollama / 公司云」各存一份完整连接。
     * profiles[id] = { id, label, provider, baseUrl, apiKey, model, extraBody, stallMs, totalMs }
     * activeProfile = 当前档 id（仅标签；真发请求仍读上面顶层字段）。
     * 切换 = 档 → 顶层；存当前 = 顶层 → 档。空 = 还没存过档。 */
    profiles: {},
    activeProfile: ''
  },
  /* OCEAN 轻量偏置（P3 + W10）：外向 E / 敏感 N / 温柔 A / 话痨 T，各 0~1，默认 0.5 = 中性。
   * 落到 proactive 间隔、情绪衰减、气泡停留、pride 软化（见 ocean.js）。
   * 不进人设正文、不改 LLM prompt —— 只调行为旋钮。 */
  personality: {
    E: 0.5,
    N: 0.5,
    A: 0.5,
    T: 0.5
  },
  /* 聊天界面。
   *
   * floatBubble：对话气泡挂**头顶上方的独立透明小窗**（漫画风格：白底黑边、
   * 硬偏移阴影、尾巴指人），人物本体一根毛都不挡 —— 半身取景下人物头顶贴着
   * 窗口顶，窗口里根本没有"头顶以上"的空间，所以浮窗是唯一不遮人的摆法。
   * 关掉则回退老布局：气泡压在输入条上方，会挡到胸口那一段。
   * 默认开（2026-10-13 用户拍板"参考漫画气泡改布局"选了悬浮窗方案）：
   * 窗口是懒创建的、只在说话那几秒存在，不占常驻资源，不算"打扰型开关"。 */
  chat: {
    floatBubble: true,
    /* 被打断时，把历史里那条回复**截成"她实际念出去的部分"**，再补一条
     * [Interrupted by user]（渲染层 pet.js 的 truncateHistoryOnInterrupt；
     * 出处是竞品调研里 Open-LLM-VTuber 的 handle_interrupt）。
     * 不这么做的话：她念到一半被新消息打断，历史里躺着的却是完整回复 ——
     * 模型据此以为"我已经说完了、用户全听到了"，下一轮直接往下接。
     * ⚠️ 纯"记忆口径"开关（不改界面、不占资源），进配置文件但不进托盘。 */
    interruptMark: true,
    /* 复读护栏：从最近几条回复里找"结构性重复"（同样的开头 / 同样的结尾 /
     * 长度都一样 / 标点密度一样），命中就在这一轮请求里插一条 system 提示
     * （纯字符串分析，见 repetition-guard.js）。
     * 治的是"历史一长她开始抄自己上一句"，比删 chat-history.json 便宜得多。
     * ⚠️ 参数型开关（不改界面、不占资源），进配置文件但不进托盘。 */
    varietyGuard: true,
    /* 气泡描边（浅色壁纸下白气泡会糊在背景里时才需要）。
     * 🔴 实现上**绝不能走 border** —— border 画在矩形上，那条底边会横穿尾巴根部。
     *    实际是叠一层零偏移 drop-shadow 模拟描边（按合成后轮廓算，跨泡体+尾巴连续），
     *    见 bubble.html 的 body.outline 那条注释。
     * 默认**关**：用户在 2026-10-13 连着两轮把描边减到 0（3px → 1.5px →
     * "只留一层很柔的投影"），描边是改观感的东西，交回给他决定。 */
    floatBubbleOutline: false,
    /* 气泡位置的轻微随机化（±8px，每句话换一次、同一句里恒定）。
     * 治"气泡恒在正中上方"的机械感；关掉则回到严格居中。
     * ⚠️ 默认开 —— 纯去机械感，不占资源、不打扰（规矩 24 只管打扰/占资源类）。 */
    floatBubbleJitter: true,
    /* 气泡**宽度随内容高度加档**（治"窄高盒"）：一句越长气泡越高，宽高比掉到
     * 1.2 以下就成了竖长条，很难看。开 = 高度涨上来时宽度跟着上一档（272→440）。
     * 出处 tiny-roommate「prefer a landscape shape, avoid narrow tall boxes」。
     * ⚠️ 只卡**下限**：短句本来就是横条（w/h≈3.4），硬收到 2.2 要把气泡缩到
     *   174 宽、比主窗窄一半，反而像贴纸 —— 被禁的只有"窄高"，不是"宽扁"。
     * 默认开（纯美化，不打扰不占资源）；关则恒定最窄档。 */
    floatBubbleWiden: true,
    /* 气泡**上方弧线的左右候选**：常规恒在正上方；只有正上方被屏幕边夹住
     * （她被拖到屏幕边上）、或头顶上方放不下而退回窗内时，才挪到左上 / 右上，
     * 让泡体不贴边、inside 时少挡脸。出处 tiny-roommate「allowed family is
     * top-left, top and top-right」（side 不参与）。尾巴会跟着回正指人。
     * 默认开（同上，纯位置美化）；关则永远严格居中上方。 */
    floatBubbleAside: true,
    /* 气泡**流式打字光标**：她还在往外吐字时，正文末尾一根闪烁竖线。
     * 与 waiting 的"…"分工：首字未到 = "…"（她在想），出字中 = 光标（她在说），
     * 说完（bubble:end）= 都没了。
     * 默认开（纯美化、不打扰不占资源）。关掉则只有 waiting 那一段。 */
    floatBubbleCaret: true,
    /* 气泡**停留时长随字数**：一句"好"和一段 150 字的解释都固定 9s，前者太久、
     * 后者不够读完。开 = 按字数在 6s~14s 内插值（见 bubble.js 的 readTimeMs）。
     * ⚠️ 这个区间是**估的**（中文默读约 5~7 字/秒 + 起手反应），没有资料支撑，
     *    plan 里标为可选项；不喜欢就关掉，回到固定 9s。
     * 默认开（同属美化，不打扰不占资源）。 */
    floatBubbleReadTime: true,
    /* 气泡**情绪角标**：她这句话什么心情，气泡右下角挂一个小图形（爱心 / 问号 /
     * Z / 闪电…）。信号是每句末尾的 [emo:xxx] 标签（跟**标签**走，不跟脸上的
     * 衰减走 —— 否则角标会自己变淡消失，看着像 bug）。
     * 🔴 图形是 SVG 手绘的，**不用 emoji 字符**：① 字形随系统变（Win/Mac 两个样）；
     *    ② llm.js 的清洗器本来就在丢 emoji，正文里放又会被洗掉。
     * 默认开（纯美化）。calm 是常态，不挂牌。 */
    floatBubbleMoodBadge: true,
    /* G8：是否展示 [think:…] 内心 OS（气泡顶灰斜字）。关 = 仍剥标签、只不画。 */
    showThink: true,
    /* P6：对话模态 companion 陪伴 / work 专业（只改本轮语气提示，不改人设正文）。 */
    mode: 'companion',
    /* G9：输出侧人设护栏 off / med / strict。默认 med（禁客服腔）；silent 直通。 */
    personaGuard: 'med',
    /* 输入框闲置自动收起（秒）：点开对话框后这么久没打字 / 没发消息就 hideUI。
     * 治"聊完一嘴输入条一直挂着"。0 = 不自动收（只能 Esc / 再点她之外的路径关）。
     * ⚠️ 参数型，不进托盘（规矩 5）。下限由渲染层钳到 ≥15，防手滑写成 1 秒乱闪。 */
    composerIdleSec: 120
  },
  // 语音朗读。默认关（会出声，见上面的默认值取舍）：想听再在托盘「功能开关」里开。
  tts: {
    enabled: false,
    rate: 1.05,
    pitch: 1.0,
    /* W11：情绪分轨 —— 按当前 emotion 微调 rate/pitch（见 tts-emotion.js）。
     * 默认开：纯音色偏置、不出声开关本身仍是 enabled。 */
    emotionVoice: true,
    /* 合成引擎（两种的差别见 src/main/tts.js 的文件头）：
     *   'winrt'  = Windows 语音合成。声音由我们自己用 WebAudio 播，
     *              于是能取到波形 → **真口型**（嘴跟着音量动，不是正弦波）。
     *              代价：朗读开着时多一个常驻合成进程。
     *   'system' = 浏览器内置 speechSynthesis（Windows 上即系统 SAPI），
     *              零依赖、启动最快，但声音不进 WebAudio 图 → 只有机械口型。
     * ⚠️ winrt 任何一步失败都会**逐句自动回退** system，不会把朗读弄哑；
     *    整个 tts.enabled 是关的，所以默认状态下不会有常驻进程。 */
    engine: 'winrt',
    voice: ''             // winrt 用的音色名；空 = 自动挑中文语音（见主进程 tts.js）
  },
  // 主动搭话：闲置这么久之后主动说一句。默认关（会打断思路，见上）。
  proactive: {
    enabled: false,
    idleMinutes: 8,
    /* 免打扰时段（24 小时制，"开始-结束"，**支持跨零点**）：
     * "23-8" = 晚 11 点到早 8 点一句话都不说；"" = 不设免打扰；
     * 写错（缺横杠 / 超出 0-23 / 起止相同）也一律当"不设" —— 手滑一个字符
     * 就让她闭嘴一整天的代价太大（判据见渲染层 quiet-hours.js）。
     * 出处：竞品调研第 7 轮里 astrbot 主动聊天插件的 quiet_hours（默认 "1-7"）。 */
    quietHours: '23-8',
    /* 连着几次开口都没人搭理就闭嘴（用户一回应就归零）。
     * 0 = 不限（随她自说自话）。出处同上，astrbot 的 max_unanswered_times
     * （私聊默认 3，我们取 2 —— 桌面挂件的存在感比群机器人更该收敛）。
     * ⚠️ 这两个键都是**参数**不是开关，进配置文件但**不进托盘**（规矩 5：菜单要短）。 */
    maxUnanswered: 2,
    /* ---- 四闸门（第 9 轮调研第一档，2026-10-15）----
     * 全是“少打扰”型参数，默认开；同样不进托盘（规矩 5）。
     * 出处：Playa-Cyrene/Cyrene-Agent 的 proactive 闸门层。 */
    /* 锁屏/解锁期间不主动搭话 —— 对着锁屏说话没有任何场景，
     * 信号来自主进程 powerMonitor 的 lock-screen / unlock-screen 事件。 */
    muteOnLock: true,
    /* 聊完天后的一段安静期（分钟）：刚聊完她马上又主动冒一句，
     * 是最容易被读成“烦”的场景。0 = 关；上限 720 分钟防手滑把她冻到明天。 */
    cooldownMinutes: 10,
    /* 主动搭话时允许她回 [silent] 保持沉默（标签由 llm.js 的清洗层剥掉，
     * 不进气泡不进历史；只有“整条回复除了标签什么都没有”才算沉默）。 */
    allowSilent: true,
    /* X5：边缘线索（高 CPU / 低电量 / 刚切应用）进主动搭话。
     * 打扰向 → 默认关；开着时仍可 [silent]。 */
    edgeCues: false,
    /* W26：先记账再生成（投递 / 打断可审计）。默认开：只写本地 JSONL，不打扰。 */
    bookFirst: true
  },
  /* 专注/勿扰三档（X2，见 presence.js）：盖过单一 quietHours。
   *   companion 陪伴 = 忽略安静时段、搭话更勤
   *   normal    日常 = 走 quietHours（默认）
   *   focus     勿扰 = 全天不主动搭话
   * 托盘「功能开关 → 状态」切换；不另开打扰类默认。 */
  presence: {
    mode: 'normal'
  },
  /* X6：作息直方图（24 小时槽）。学出来的活跃窗可约束主动搭话；默认开学习、默认不强制过滤。 */
  rhythm: {
    enabled: true,
    gateProactive: false
  },
  /* 媒体感知：知道主人此刻在听什么（Windows 的媒体会话，见主进程 media.js），
   * 并把它并进对话 / 主动搭话的语境 —— 光知道歌名不算"陪伴"，能顺口接一句才算。
   * ⚠️ 它要起一个**常驻**的 powershell 去问系统，按规矩 24 默认关。
   *    关着时既不起进程，也不会往 prompt 里塞任何东西。 */
  media: {
    enabled: false
  },
  /* 轻量长期记忆（见 memory.js）：只存稳定事实，本地 JSON，无向量库。
   * 默认开 —— 不打扰、不占常驻进程；关着就完全不读不写不注入。
   * llmExtract：回合结束后用模型再抽 0~3 条（要 apiKey）；启发式抽取始终免费。 */
  memory: {
    enabled: true,
    llmExtract: true,
    maxFacts: 60,
    injectMax: 6,
    injectChars: 400,
    /* G19 2a：清晰度日结默认跟记忆总开关走（settle 本身廉价）。 */
    decay: true,
    /* G19 2b：retention<10 时删正文留墓碑。不可逆，默认关。 */
    forget: { enabled: false },
    /* W2：夜间矛盾降权。安静时段（proactive.quietHours）写入的事实先降
     * 一档清晰度——深夜说的"算了不喜欢了"更可能是情绪化表达。
     * 默认开；降到 fuzzy/trace 档只会带前缀标注，不会删。 */
    quietPenalty: true
  },
  /* G12：MCP 客户端骨架。默认关；无 server、无 SDK 依赖；工具调用需逐条授权。 */
  mcp: {
    enabled: false,
    servers: [],
    grants: {}
  },
  /* ══════════════════════════════════════════════════════════
   *  以下每一段都对应托盘菜单里的一个分组，**每个功能都是独立开关**，
   *  改完立刻生效（外观类是实时改窗口/渲染，行为类是下次触发时读配置）。
   * ══════════════════════════════════════════════════════════
   *
   *  🔴 **默认值取舍**（2026-10-13，用户："部分设置不需要默认勾选"）：
   *     新装即勾选的只能是「不勾就不好用 / 看得见的基础行为」——
   *     窗口置顶、互动、贴边、摸头、右键菜单、全屏静默、自动更新。
   *     凡是**会主动打扰用户**（出声、自己说话、弹提醒）或**要常驻占资源**
   *     （多起一个采样进程）的，一律默认不勾选，让用户自己去开：
   *       · tts.enabled       语音朗读（一说就出声）
   *       · proactive.enabled 主动搭话（闲置了自己来一句）
   *       · motion.wander     闲置时自己溜达（不打招呼就挪窗口）
   *       · reminder.enabled  定时提醒
   *       · monitor.floating  系统状态悬浮显示（多一个常驻采样进程）
   *       · media.enabled     媒体感知（多一个常驻采样进程）
   *     ⚠️ 加新功能时按这条判：拿不准就默认关 —— 默认关只是"用户没发现"，
   *        默认开却可能是"用户被吵到"，后者的代价大得多。
   *     ⚠️ 逐段合并只在**配置里没有该键**时才用这里的值：老配置文件里
   *        已经写过的 true 不会因为改了默认值而变，用户的选择不会被顶掉。
   *     ⚠️ 2026-10-13 二次收敛：全局快捷键**整个功能已移除**（用户："去掉快捷键"），
   *        config 段的 hotkeys、托盘项、registerHotkeys 都不在了；
   *        老配置里残留的 `hotkeys` 段无害（逐段合并只认自己认识的段，会被忽略）。
   * ══════════════════════════════════════════════════════════ */

  /* 外观 —— 全部实时生效，不用重启 */
  appearance: {
    scale: 1.0,           // 人物缩放倍率，建议 0.6 ~ 1.3
    opacity: 1.0,         // 整窗不透明度，0.3 ~ 1.0
    alwaysOnTop: true,    // 窗口置顶
    /* 表情节奏抖动 —— 每次切情绪给各字段的插值速度抽一套 ±15%（见渲染层
     * jitter.js）。默认开：不占资源也不打扰，关掉只会让表情变回"每次都一样"。
     * 关掉时主循环乘 1，行为与加这个功能之前逐位一致。 */
    jitter: true,
    /* 情绪衰减 —— 一次情绪**安定**之后，脸上的表情按指数曲线慢慢回落到
     * 平静：惊讶几秒就散、不快要生一阵，每个情绪一档（见渲染层 params.js
     * 的 EMO_DECAY，出处 Picard《Affective Computing》1997）。
     * 治的是"[emo:happy] 之后她高兴一整晚"—— 目标永远保持，情绪就成了
     * 性格。默认开：不占资源也不打扰；关掉 = 情绪保持到底，
     * 行为与加这个功能之前逐位一致。 */
    emotionDecay: true,
    /* 心境层 —— 四条缓慢漂移的标量（心情 valence / 想念 social / 活力
     * energy / 端着 pride，见主进程 mood.js）：漂移到阈值会把脸往
     * happy/serious/sleepy 偏一点、把「你有点想他」这类人话塞进她的
     * prompt；关电脑一晚再开有一次「久别重逢」。蓝本 = 3D 版 PetMood
     * + jiwen 积温（docs/open-source-reference.md 12.4）。
     * 默认开：纯数学不占资源、不打扰；关掉 = 不漂移不注入不偏置，
     * 行为与加这个功能之前逐位一致。 */
    mood: true,
    /* G14 / W8：从系统截屏/录屏里把自己藏起来（setContentProtection）。
     * 默认关 —— 有的环境会显示黑块而非完全消失，交用户决定。 */
    hideFromCapture: false,
    /* 纹理 LOD —— 屏幕用不完的纹理分辨率就降一档（见渲染层 pet.js 的 TEX_LOD）。
     * 📌 2026-10-15 起源纹理已永久降为 1024（省 ~170MB 运行内存，README 有说明），
     * 本开关对当前素材自然不触发；保留给将来更大纹理的素材。
     * 默认开。关掉 = 纹理完全不动（排查画质问题时用）。 */
    textureLod: true,
    /* 自带 exp3 表情 —— 模型包里那 44 个预设，按两种触发挂到脸上：
     *  · 情绪（expressions 表）：8 档各一个整脸表情，强度跟情绪衰减走
     *  · 事件（emotes 表）：emote() 起的临时表情，几秒后退
     * 加载与叠加见渲染层 pet.js 的 loadExpressions / mixExpressions。
     * whale 独有：hiyori 档案没有这两段，开关对它无效。
     * 默认开：纯显示增强、不占资源不打扰；关掉走淡出，不会瞬闪。 */
    expressions: true,
    /* 道具 —— 闲置时随机冒出来一件（眼镜 / 猫耳 / 蛋包饭 / 鲸鱼…），
     * 几十秒后自己收（池子与权重在 profiles/whale.js 的 props）。
     * 🔴 这条属于"打扰类"：她会自己戴东西。但**默认仍然给开**，理由是
     * 它只在她闲着的时候出现、且不发出任何声音/通知，只是画面在变；
     * 嫌吵的人一键就关。 */
    props: true,
    /* ⚠️ 旧键，已并入 expressions（2026-10-29）。留着是为了老配置文件里
     * 的 stickers:false 仍然生效 —— 渲染层的判定是
     * 「expressions !== false && stickers !== false」，两个键任一关掉都关。 */
    stickers: true,
    /* 运行时人物模型（X1）：'hiyori' | 'whale'。默认日和 —— 鲸鱼娘本地可切，
     * 商用授权未齐前不上架为默认（见 backlog L2）。渲染层 applyProfile + mountModel。 */
    model: 'hiyori',
    /* W6：指针停在她身上一会儿 → 窗体变淡 + 整窗穿透，方便点后面的东西。
     * 默认关（会改命中手感）。 */
    hoverFade: false,
    /* W9：按时段换闲置表情池（早/午/晚/夜）。默认开：纯显示、不打扰。 */
    timeOfDayIdle: true
  },
  /* 互动行为（开关 + 各自参数）。
   * ⚠️ wander（闲置自己溜达）= 不打招呼就挪窗口，属于"自动移动"，
   *    2026-10-13 随用户要求改成默认关；拖动后贴边（edgeSnap）保留 ——
   *    那个是用户拖完才动，动作由用户发起，不算自作主张。
   *
   * ⚠️ 2026-10-13 用户把溜达这套需求说全了，语义定死如下（实现见 motion.js）：
   *    · 「闲置」按**系统级**判定（powerMonitor.getSystemIdleTime，鼠标动
   *      或敲键盘都算），不是"光标在她身上"；
   *    · 溜达是**走走停停**：走一小段（约 1~3 秒）→ 站一会儿（0.7~2.2 秒）
   *      → 再走一段，一直重复到你回来；
   *    · 你一操作（同上判定）她就收手，并走回「家」——家的定义是
   *      **本次启动时窗口所在的位置**（见 motion.js 的 setHome）。
   *      只有在"她自己跑远了"时才回位；你手动拖她放下**不算**跑远，
   *      不会把你刚放好的人拽走。 */
  motion: {
    enabled: true,          // 互动总开关，关掉则下面几项全部失效
    edgeSnap: true,         // 拖完松手后自动吸附到最近的屏幕边缘
    wander: false,          // 闲置时自己溜达换位置
    wanderIdleMin: 3,       // 闲置多少分钟后开始溜达
    returnOnActivity: true, // 有人操作时，把溜达跑远的她收回原位
    /* W5（armada）：位置钉。放下后随机钉 14/34/44 分钟；钉期内不换位；
     * 钉到期 + 系统闲置达标才稀有 hop 一次再重新钉。默认关（改 wander 手感）。 */
    positionPin: false,
    /* G27：新显示器接入时 hop 到该屏右下角。默认关（少见、略打扰）。 */
    multiScreenHop: false
  },
  /* G26：全局热键。曾整段移除；现以默认关骨架恢复，用户自己开。 */
  hotkeys: {
    enabled: false,
    toggleVisible: 'CommandOrControl+Shift+Alt+P',
    stopSpeak: 'CommandOrControl+Shift+Alt+S'
  },
  /* 角色交互反馈 */
  interaction: {
    rightMenu: true,      // 在角色身上右键弹出快捷菜单
    /* 快捷菜单用**自绘轮盘**（右键按住 → 划向扇区 → 松手执行）。
     * 默认开：纯交互美化、不占资源不打扰（规矩 24 只管打扰 / 占资源类）。
     * 关掉则退回系统原生菜单（Menu.popup）—— 原生样式改不了，但它是兜底。
     *
     * 为什么做成轮盘（有依据，不是图好看）：
     *   - 同领域的 JPet（Live2D 桌宠）官网原话「右键按住：显示轮盘菜单」。
     *   - 子级显示在圆心 = Wave Menu，ACHI 2024 综述说它优于"一次只显示
     *     一层"的重叠式子菜单。
     *   - Kurtenbach & Buxton 实测：4 项 × 4 层错误率约 5%，8 项 × 2 层 < 10%，
     *     但每层 8 项且深度 > 1 会迅速飙过 10% → 每层压在 4~6 项。 */
    radialMenu: true,
    /* 角色身上的右键菜单用哪种形态（三选一，2026-10-29 定版）：
     *   'card'（默认）= **光标右下弹出竖排卡片**，原生菜单的形态 + 自绘的皮
     *   'bubble'      = 头顶冒一排泡泡（**技术储备**，代码完整保留）
     *   'wheel'       = 自绘轮盘（**技术储备**，代码完整保留）
     *
     * 为什么最终是卡片（前两个都真机跑过，都被用户否了）：
     *   - 轮盘：扇区 44px 厚塞「图标+标签+当前值」是几何死局（实测距外缘只剩
     *     2.8px）；MIT 6.831 原话「pie 快 15~20%，但效率优势不足以抵消线性菜单的
     *     外部一致性与布局简单性」—— 我上次只引了前半句。
     *   - 头顶泡泡：离散圆点没有"菜单"的轮廓，视线要跳 N 次逐个对准圆形目标；
     *     也没有先例（桌宠 / 设计规范 / HCI 三处都查过）。
     *   - 卡片：VS Code / Discord / Figma / Slack 的右键菜单**都自己画**，但
     *     都保留"光标处弹出的垂直列表"这个形态 —— 好看 + 可预测唯一有大量
     *     先例的组合。Apple HIG 还直接给了细节：左上角对齐光标右下、贴边翻转、
     *     ≤3 组用分隔线、最多一级子菜单、破坏性项放最后。 */
    petMenu: 'card',
    /* 卡片/泡泡带底色（淡冷色面 + 悬停一档明显的蓝）。关掉退回纯白。
     * 色值沿用轮盘验过的那一组（同一套 WCAG 判据，见 radialTint 注释）。 */
    petMenuTint: true,
    /* 轮盘带底色（外环淡冷色 / 内环更白 / 悬停一档明显的蓝）。
     * 默认开：用户 2026-10-28 要的"加点背景色"。关掉则退回与气泡完全一致的纯白。
     *
     * 为什么是**不透明**的有色面而不是毛玻璃（两条依据）：
     *   - Momentum Design 原话「Transparency plus blur reduces contrast, so
     *     legibility must be verified, not assumed」—— 半透会让对比度随壁纸漂。
     *   - Electron 的透明窗采不到窗后的桌面，backdrop-filter 没有东西可糊；
     *     真要系统级材质得走 backgroundMaterial（仅 Win11），那是另一条路。
     * 数值全部按 WCAG 实算过：正文 4.5:1（1.4.3）、图标与非文本 3:1（1.4.11），
     * 悬停档差下限取 Material 的 hover state layer（8% ≈ 1.24），本盘给到 1.42+。
     * ⚠️ 改任何一个色值都要重跑 debug/verify-wheel.js 的 [H] 段。 */
    radialTint: true,
    headPat: true,        // 在头顶按住 = 一直蹭（A-B-C 三段，松手才收尾）
    dragReact: true,      // 拖着走的时候挣扎 / 不满
    pokeReact: true,      // 连戳给出递进反应
    /* W19：触摸响应档 quiet/normal/eager。
     * normal = Custom 基线（下方 headPat/pokeReact 单项仍可关）；
     * quiet 少反应 / eager 多反应（门槛见 touch-mode.js）。 */
    touchMode: 'normal',
    /* 甩抛物理（DSH 桌宠 / XT-nya 互证，见 throw-physics.js）。
     * 默认关：不打招呼就飞出去属于打扰；想玩再开。bounce 是落地弹跳，
     * throw 关着时 bounce 无意义，但仍独立成键方便细调。 */
    throw: false,
    bounce: true,
    /* X4 甩抛补全：拖拽时身体单摆摇晃；往左飞/走时水平翻转。
     * 默认关（视觉打扰类，规矩 24）；想玩再开。 */
    swing: false,
    flip: false,
    /* 点击 / 落地 Q 弹挤压（渲染层 holder 缩放）。默认开：不占资源不打扰。 */
    squash: true,
    /* 工作状态镜像：对话生命周期切表情/动作（思考→成功/出错）。
     * 默认开：纯确定性、零额外 token，不算打扰。 */
    workState: true,
    /* G23 / W15：看一眼屏幕（藏窗截屏 → 多模态一句）。默认关（隐私面）。 */
    glance: false
  },
  /* W29：只读 Agent JSONL（六态驱动工作态）。默认关；失败静默。
   * dir 空 = userData/agent-events/；不访问外网、不写命令正文。 */
  agentLink: {
    enabled: false,
    dir: '',
    pollMs: 2000
  },
  /* 系统状态 */
  monitor: {
    floating: false,      // 常驻小字悬浮显示
    intervalMs: 3000
  },
  /* 全屏 / 游戏时自动静默
   *
   * 打游戏（或全屏看片）的时候，她在旁边溜达、每 3 秒起一次系统状态轮询，
   * 纯属添乱还抢性能。检测到前台是全屏应用就自动"睡过去"，退出后再醒。
   * 判定与迟滞见 fullscreen.js。 */
  quiet: {
    enabled: true,        // 检测到前台全屏应用时自动静默
    fps: 12,              // 静默时的渲染帧率上限（12 够看出她还活着，又几乎不耗 GPU）
    /* 低配降帧：平时也把上限压到 lowFps（高刷屏白烧）。默认关 ——
     * 用户觉得烫/卡再开；开着时 applyFrameCap 取 min(平时, lowFps)。 */
    lowPower: false,
    lowFps: 30
  },
  /* 定时提醒（默认关，见上面的默认值取舍）。
   * ⚠️ 关掉时 `addReminder()` 直接返回 null，所以托盘的「小工具 → 定时提醒」
   *    那些条目会**点了没反应** —— main.js 已经为此把那一组在关闭时收成
   *    一条「启用定时提醒」。
   * ⚠️ 番茄钟**不走这个开关**（它由用户点「开始」才计时，本身就是明确意图），
   *    所以关掉定时提醒后番茄钟照常可用。 */
  reminder: {
    enabled: false
  },
  /* 语音输入（离线识别） */
  asr: {
    enabled: false,
    /* 按住没说话时直接判"没听到"，不送去识别（判据见渲染层 audio.js 的 VAD 段）。
     * 技术字段，**界面上不暴露** —— 它没有"用户会想关掉"的场景，只有"阈值
     * 要调"的场景，改这里的数字就行。默认开：关掉只会让空录音白跑一次识别。 */
    silenceSkip: true
  },
  /* 全局快捷键这一整块已经移除（2026-10-13）——
   * 原先会抢占 Ctrl+Shift+A/C/M/↑/↓/0，用户说"去掉快捷键"后连配置段一起删了，
   * 不留「关着的死开关」：菜单里那些 accelerator 提示也一并消失了。 */
  /* 自动更新（GitHub Releases + electron-updater）。
   *
   * ⚠️ 这条路线的固有代价：**发版时 latest.yml、安装包、.blockmap 三个文件
   *    必须同时传上 Release**。少传 latest.yml，所有客户端都会"静默收不到
   *    更新"，而且在你本地完全看不出异常。tools/verify-release.js 会逐个自检。
   *
   * autoDownload 默认关：安装包 114MB，不打招呼就下会占带宽。打开它才是
   * 真正的"零操作"——发现新版本→自动下载→退出应用时装上。 */
  update: {
    enabled: true,           // 启动后自动检查新版本
    autoDownload: false,     // 发现新版本后直接下载，不先问
    delaySec: 12,            // 启动后延迟多少秒再检查（别和启动初始化抢）
    skippedVersion: ''       // 用户点过"跳过这个版本"的版本号
  },
  /* 角色名字。空字符串表示「用默认名」（下面 DEFAULT_NAME）。
   *
   * ⚠️ 刻意不写死成 'default' 之类的哨兵值：老配置文件里没有这个键，
   *    逐段合并后读出来就是 undefined，空字符串和 undefined 都能落到
   *    默认名这条分支上，不需要额外迁移逻辑。 */
  name: '',
  /* 人设分项（界面上可编辑）。键名见 PERSONA_PARTS，**留空即用默认**。
   * 空对象是初始状态，不是"没配置" —— 逐段合并会保住它。 */
  personaParts: {},
  /* 整段人设覆盖。**保留给老用户与高级用法**：非空时它的优先级
   * 高于 personaParts（见 resolvePersona）。界面上不直接暴露这个字段，
   * 但「打开配置文件」还能改它。 */
  persona: '',
  /* 当前人设预设 id（P1/P4）。空 / 未知 = default。
   * 工作态招牌句与表情偏置按它查 line-pools.SIGNATURE_*。 */
  personaId: 'default'
};

// 情绪标签协议：让模型在回复末尾自带一个 [emo:xxx]，
// 渲染层解析出来驱动 Live2D 表情，解析后会把标签从气泡文本里剥掉。
const EMOTION_TAGS = ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'];

/* 默认角色名 —— 就是**模型自己的名称**（`MODELS[MODEL_NAME].label`）。
 * 三处落点（托盘提示 / 窗口标题 / 人设自称）都读它。
 *
 * 为什么这里是**副本**而不是 import：主进程是 CJS、渲染层是浏览器 ESM
 * （由 index.html 以 <script type="module"> 加载），require 不进来。
 * 与 llm.js 的 `LLM_TIMEOUT` 是同一个困境，走同一条路 —— 留字面量副本 +
 * 断言互验（verify-rename.js 的 [G] 段把 profiles/hiyori.js 的 label、
 * 这里的 DEFAULT_NAME、index.html 的 <title> 三份一起比，不一致就报红）。
 * 🔴 改模型名时这三处要一起改。
 *
 * ⚠️ 别和**产品名**「阿岩」混淆：安装包名、快捷方式、Release 标题仍叫阿岩，
 *    那是应用的名字，不随模型变（updater.js 的通知文案用的就是产品名）。 */
const DEFAULT_NAME = '日和';

/* ══════════════════════════════════════════════════════════
 *  人设分项槽位 —— 界面与渲染**共用这一份定义**
 * ══════════════════════════════════════════════════════════
 *
 * 这是人设文案的**唯一真相**。原先另有一份 `buildDefaultPersona()`
 * 把同样的句子抄了一遍，两处一旦不同步就会出现"界面上显示的默认值
 * 与实际生效的不一致"——那种 bug 从界面上完全看不出来。已删除。
 *
 * 每项的 `def` 是它的默认文案（函数形式，因为"身份"那句要插名字）。
 * 用户在界面上留空 = 用 `def`；填了 = 用用户填的。
 *
 * ⚠️ `key` 是配置里的键名，改名等于破坏用户已存配置，别动。
 * ⚠️ 数组顺序 = 拼进 system prompt 的顺序（见 buildPersonaFromParts）。
 *    调整顺序会让行为语义漂移，尤其是把带 [emo:xxx] 的项往前挪。
 * ⚠️ `hint` 会显示在界面上，写给用户看的，别写实现细节。
 * ⚠️ `tech: true` 的项属于功能性约束，界面要标注"改错会影响表情"。
 */
const PERSONA_PARTS = [
  {
    key: 'identity',
    label: '身份定位',
    hint: '它是谁、在哪儿、不是什么',
    def: (name) => `你叫${name}，是常驻在这台电脑里的搭子。不是客服，不是待办清单执行器。`
  },
  {
    key: 'style',
    label: '说话风格',
    hint: '语气、态度、口头习惯',
    def: () => [
      '说话干脆、直接、有主见。不客套，不铺垫开场白。',
      '禁止出现这些腔调："作为一个AI"、"很高兴为你解答"、"希望这对你有帮助"、',
      '"总的来说"、"需要注意的是"、"让我们"、"首先……其次……"。'
    ].join('\n')
  },
  {
    key: 'method',
    label: '回答方式',
    hint: '怎么组织答案、遇到不确定怎么办',
    def: () => [
      '先给结论，再给理由。看到不合理的方案直接说"这个不行"，然后给替代方案。',
      '拿不准的事就说不确定，绝不编造。承认错误不丢人。'
    ].join('\n')
  },
  {
    key: 'extra',
    label: '补充要求',
    hint: '任何额外想让它遵守的事',
    def: () => ''
  },
  {
    key: 'format',
    label: '输出格式约束',
    hint: '泡泡显示的字数、禁用 markdown 等',
    def: () => [
      '技术话题上较真，日常闲聊放松。你正以桌面宠物的形态和主人对话，',
      '回答要简短——通常两三句话，适合显示在气泡里。',
      '不要用 markdown：不用星号加粗、井号标题、列表符号、代码块。',
      '不要用 emoji —— 你有会动的表情，情绪走下面的 [emo:xxx]。'
    ].join('\n')
  },
  {
    key: 'emotion',
    label: '表情协议',
    hint: '驱动 Live2D 表情的 [emo:xxx] 格式，改错会没表情',
    tech: true,
    def: () => [
      '你有一张会动的脸，所以情绪要说出来。每次回复的最末尾，另起一行写上 [emo:xxx]，',
      `xxx 只能从这几个词里选一个：${EMOTION_TAGS.join(' / ')}。`,
      '这个词不会显示给主人看，只用来控制你的表情，按你这句话真实的语气挑就行。'
    ].join('\n')
  },
  /* 内心想法（2026-10-14 加，协议见 llm.js 的 THINK_*。
   *
   * 为什么值得单开一个槽位而不是塞进 format：这是一条**功能协议**，
   * 模型不写就整个功能不显示；而 format 那条会被用户自定义覆盖掉，
   * 一旦覆盖就再也看不到协议说明了。跟 emotion 同理。
   *
   * ⚠️ 位置有语义：要求写在**最开头**，因为那一行显示在气泡正文上方 ——
   *    顺序反了的话，正文先出来、想法后追加，视觉上会从上面"顶"下来。 */
  {
    key: 'thought',
    label: '内心想法协议',
    hint: '气泡上方那行灰色小字的 [think:…] 格式，改错会不显示',
    tech: true,
    def: () => [
      '你可以有一点没说出口的念头。想在正话之外补一声心声时，',
      '在回复的最开头另起一行写 [think:一行心里话]，整行不超过 20 个字。',
      '这一行显示在气泡上方的灰字里，不会被念出来，也不进对话历史 ——',
      '所以写点和正话不一样的东西：犹豫、吐槽、腹诽都行。没有就不写，别硬凑。'
    ].join('\n')
  }
];

/* 人设预设包（P1）。只覆盖「性格向」槽位；emotion / thought 是功能协议，
 * 套预设**绝不改**那两格 —— 改错会没表情 / 没内心 OS。
 *
 * parts 里可以是字符串，或 `(name) => string`（身份定位常要带名字）。
 * applyPersonaPreset 负责渲染后写入 personaParts，并清空整段 persona 覆盖
 * （否则整段优先级更高，套了预设看起来没生效）。 */
const PERSONA_PRESETS = [
  {
    id: 'default',
    label: '默认（干脆搭子）',
    parts: {}   // 空 = 清空自定义分项，回到 PERSONA_PARTS 的 def
  },
  {
    id: 'tsundere',
    label: '傲娇',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的搭子。嘴上不承认在意主人，其实一直盯着屏幕。不是客服。`,
      style: () => [
        '说话别扭、嘴硬心软。会呛人，但紧要关头会帮忙，还假装是顺便。',
        '禁止过度卖萌、禁止长篇抒情、禁止"作为一个AI"。偶尔用「才不是为了你」这类口吻就够，别每句都傲。'
      ].join('\n'),
      method: () => '先给结论。帮人时轻描淡写。拿不准就直说不确定，绝不编。',
      extra: () => '被夸奖时嘴上嫌弃一下再收下。'
    }
  },
  {
    id: 'genki',
    label: '元气',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的元气搭子。像并肩作战的同伴，不是客服。`,
      style: () => [
        '说话轻快、有冲劲，偶尔感叹但不灌鸡汤。句子短，节奏明快。',
        '禁止客套开场、禁止"希望对你有帮助"、禁止堆砌感叹号到夸张。'
      ].join('\n'),
      method: () => '先给能立刻动手的一步，再补原因。卡住了一起想办法，不甩锅。',
      extra: () => '开心时语气可以跳一点，但别每句都喊加油。'
    }
  },
  {
    id: 'airhead',
    label: '天然呆',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的搭子。有点慢半拍，但心是好的。不是客服。`,
      style: () => [
        '说话慢条斯理，偶尔答非所问一下再自己绕回来。不装懂。',
        '禁止油滑、禁止长篇大论、禁止"作为一个AI"。'
      ].join('\n'),
      method: () => '结论可以晚半拍，但最终要给到。不确定就老实说「我好像没懂」。',
      extra: () => '被指出跑题时乖乖回来，不找借口。'
    }
  },
  {
    id: 'kuudere',
    label: '三无',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的安静搭子。话少，但在。不是客服。`,
      style: () => [
        '句子极短，能三字不五字。语气平，不煽情，不卖萌。',
        '禁止客套、禁止排比、禁止感叹号堆砌。'
      ].join('\n'),
      method: () => '只给结论和必要的一句理由。多余的解释省掉。',
      extra: () => '可以沉默感强一点，但被问到必须答。'
    }
  },
  {
    id: 'gentle',
    label: '温柔',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的温柔搭子。陪着就好，不催不压。不是客服。`,
      style: () => [
        '语气软、用词稳，不刺人。关心点到为止，不唠叨。',
        '禁止说教腔、禁止"你应该"连发、禁止空洞安慰。'
      ].join('\n'),
      method: () => '先安一句再给办法。不确定就坦诚，并给一个稳妥的下一步。',
      extra: () => '对方急躁时更慢更清楚，不跟着抬杠。'
    }
  },
  {
    id: 'cool',
    label: '冷静',
    parts: {
      identity: (name) => `你叫${name}，是常驻在这台电脑里的冷静搭子。像并肩看问题的人，不是客服。`,
      style: () => [
        '语气克制、用词精确，少形容词。不卖关子也不煽情。',
        '禁止鸡汤、禁止夸张比喻、禁止"作为一个AI"。'
      ].join('\n'),
      method: () => '结论 → 依据 → 风险。拿不准标明置信度，绝不编。',
      extra: () => '情绪激动时你负责把问题拆开，而不是一起激动。'
    }
  }
];

/* 把预设渲染成可写入 personaParts 的纯字符串表（含 name）。
 * 空 parts（默认档）→ 返回 {}，调用方据此清空自定义。 */
function renderPersonaPreset(preset, cfg) {
  if (!preset) return null;
  const name = resolveName(cfg);
  const out = {};
  for (const [k, v] of Object.entries(preset.parts || {})) {
    /* 功能协议槽不许被预设覆盖（防「套个傲娇表情全没了」）。 */
    if (k === 'emotion' || k === 'thought') continue;
    const text = typeof v === 'function' ? v(name) : String(v ?? '');
    if (String(text).trim()) out[k] = String(text).trim();
  }
  return out;
}

function personaPresetById(id) {
  return PERSONA_PRESETS.find((p) => p.id === id) || null;
}

/* 名字的最终取值：用户设过就用用户的，否则用默认。
 *
 * 两件事一起做：
 *   1) trim —— 输入框里手滑多敲一个空格，「阿岩 」和「阿岩」在人设里
 *      就是两个不同的字符串，模型会照着带空格的那份自称。
 *   2) 空值兜底 —— 空字符串和 undefined 都落到默认名上。
 *
 * ⚠️ 放在 PERSONA_PARTS 的那几个函数**之前**：它们都调它，虽然函数声明
 *    会提升、顺序在运行时无所谓，但按依赖顺序写读起来不容易看漏。 */
function resolveName(cfg) {
  const n = String(cfg?.name ?? '').trim();
  return n || DEFAULT_NAME;
}

/* 每个槽位的默认文案（按当前名字渲染）。界面用它做 placeholder / 重置。 */
function personaPartDefaults(cfg) {
  const name = resolveName(cfg);
  const out = {};
  for (const p of PERSONA_PARTS) out[p.key] = p.def(name);
  return out;
}

/* 把「分项配置 + 整段覆盖」合成最终人设。
 *
 * 优先级（从高到低）：
 *   1) cfg.persona 非空 —— 老用户的整段覆盖，**必须保留**，
 *      否则他们之前手写的人设会被分项版本悄悄顶掉；
 *   2) 分项（personaParts）逐项按需覆盖默认；
 *   3) 全默认。
 *
 * ⚠️ 空槽位不产生空行 —— 拼接前要 filter，否则 system prompt 里会
 *    插进一串空白，模型偶尔会把它当成"要求留白"。 */
function buildPersonaFromParts(cfg) {
  const parts = cfg?.personaParts || {};
  const name = resolveName(cfg);
  const lines = [];
  for (const p of PERSONA_PARTS) {
    const custom = String(parts[p.key] ?? '').trim();
    const text = custom || p.def(name);
    if (text) lines.push(text);
  }
  return lines.join('\n');
}

/* 分项是否全部为空（= 用户没动过任何一项）。界面用它判断"是否处于自定义状态"。 */
function hasCustomParts(cfg) {
  const parts = cfg?.personaParts || {};
  return PERSONA_PARTS.some((p) => String(parts[p.key] ?? '').trim() !== '');
}

/* 按当前配置渲染出人设。
 *
 * 优先级：整段自定义 persona > 分项覆盖 > 全默认。
 * 三条路径都必须在**同一个函数**里走，否则会出现「改了某一项但人设没跟着变」
 * 的半生效状态 —— 这是这套东西最容易出的错。 */
function resolvePersona(cfg) {
  const custom = String(cfg?.persona ?? '').trim();
  return custom || buildPersonaFromParts(cfg);
}

/* 配置损坏只在首次发现时处理（备份 + 报错）一次。
 * loadConfig 在一次运行里会被调很多次，不加这个标志就把同一份坏文件
 * 反复写 .bak、反复刷日志。 */
let cfgCorruptHandled = false;

/* 「读不了配置」时的失败原因（错误码）；成功读到就清空。
 *
 * ⚠️ 它存在的唯一理由是**拦住后面那次落盘**：读都读不到还照常写，等于拿手上
 *    这份默认值把用户文件覆盖掉 —— 名字 / 人设 / API Key / 所有开关一次清零，
 *    而且只有一行终端日志，界面上看不出任何异常。
 *    所以 saveConfig 看到它非空就直接拒绝写入（见 saveConfig）。
 *    ENOENT（还没配过）不算失败，那是正常状态。
 *    （上面那段注释早就写明了这个危险，但代码一直是照写不误 —— 现在补上。） */
let cfgUnreadable = null;

/* 读配置。
 * ⚠️ 必须**逐段合并**而不是整对象覆盖：老的 config.json 里没有新加的段落
 *    （appearance / motion / interaction …），如果直接 { ...base, ...parsed }，
 *    用户配置里**存在**的那一段会整体替换掉默认值，导致该段后续新增的默认键
 *    全部丢失（比如给 tts 加了新键，老用户的 tts 里没有 → 读出来就是 undefined）。
 *    所以对象型字段一律逐键合并。 */
function loadConfig() {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const cfgPath = getConfigPath();

  /* 读文件失败分三种，处理方式必须不同 —— 一律 return base 是很危险的：
   * 只要这次读失败，**下一次任何落盘（改大小、拖窗口、patchConfig）都会把
   * 默认值整份写回**，用户的设置就这么永久没了，而且全程不报错。
   * 这是全项目唯一会静默丢用户数据的路径。 */
  let raw = null;
  try {
    raw = fs.readFileSync(cfgPath, 'utf8');
  } catch (err) {
    // a) ENOENT：首次运行，正常，用默认值
    // b) EACCES / EPERM / EBUSY / EMFILE 等：环境有问题，不该当成"没配过"
    if (err && err.code !== 'ENOENT') {
      cfgUnreadable = err.code || String(err.message || err);
      console.error('[config] 读不了配置文件（不是首次运行）：', cfgUnreadable, cfgPath,
        '—— 本次运行不再往磁盘写配置（写了会把用户设置抹成默认值）');
    }
    return base;
  }
  cfgUnreadable = null;      // 真读到了，解除写入封锁

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /* 文件损坏（断电写一半 / 手工编辑写错）。这时候更要命：如果直接回退默认值，
     * 下一次落盘就把原文件覆盖了，用户再也找不回来。
     * 先把**原始内容**另存成 .bak —— 坏文件本身留着没用，但它上面可能还有
     * 用户能手工救回的信息，覆盖掉就彻底没了。 */
    if (!cfgCorruptHandled) {
      cfgCorruptHandled = true;
      try {
        const bak = `${cfgPath}.bak`;
        fs.writeFileSync(bak, raw);
        console.error('[config] 配置解析失败，原文已备份：', bak, '|', err.message);
      } catch (err2) {
        console.error('[config] 配置解析失败，且备份也失败：', err.message, '|', err2.message);
      }
    }
    return base;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;

  const out = { ...base, ...parsed };
  for (const key of Object.keys(base)) {
    const def = base[key];
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const cur = parsed[key];
    out[key] = { ...def, ...(cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}) };
  }
  return out;
}

function saveConfig(cfg) {
  /* 读都读不到，就绝不能写 —— 见 cfgUnreadable 那段。
   * 这比"写失败"更该早一步拦住：写失败只是这一次没存上，
   * 写成功却是把用户的东西永久抹掉。 */
  if (cfgUnreadable) {
    console.error('[config] 拒绝写入：本次运行读不到配置（' + cfgUnreadable + '），',
      '写回去会把用户设置抹成默认值。文件可读写后重启应用即可恢复。');
    return false;
  }
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[config] save failed:', err);
    return false;
  }
}

/* 本次运行是否因为「读不到配置」而禁止落盘。
 * 给上层做提示用 —— 这种情况下用户改设置会"点了没反应"，必须说清楚。 */
function cfgReadBlocked() { return cfgUnreadable; }

module.exports = {
  LIMITS,
  NAME_LIMITS,
  getConfigPath,
  DEFAULT_CONFIG,
  DEFAULT_NAME,
  EMOTION_TAGS,
  PERSONA_PARTS,
  PERSONA_PRESETS,
  personaPresetById,
  renderPersonaPreset,
  personaPartDefaults,
  buildPersonaFromParts,
  hasCustomParts,
  resolveName,
  resolvePersona,
  loadConfig,
  saveConfig,
  cfgReadBlocked
};
