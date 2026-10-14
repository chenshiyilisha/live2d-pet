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
   * ⚠️ 这是**技术字段**，界面上不暴露；「打开配置文件」里能手改。
   *
   * 两个超时（2026-10-13 补）。在这之前请求是**完全没有超时**的：服务端连上
   * 之后不再吐数据，请求就永远不返回，气泡停在"打字中"那一帧，只能杀进程。
   *   stallMs —— 连上了但不再有新数据。**每收到一段就重新计时**，
   *              所以正常的长回答不会被它掐掉，拦的是"卡住"不是"慢"。
   *   totalMs —— 整轮上限，拦那种一直慢慢吐、永远吐不完的。
   * ⚠️ 上下限与这里的默认值同在 llm.js 的 LLM_TIMEOUT —— 改一处必须改两处
   *    （verify-llm 有断言拦这条）。 */
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    extraBody: {},
    stallMs: 20000,
    totalMs: 120000
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
    floatBubble: true
  },
  // 语音朗读：走 Chromium 内置的 speechSynthesis（Windows 上即系统 SAPI），
  // 零依赖、纯离线。音色取决于系统装了哪些语音包。
  // 默认关（会出声，见上面的默认值取舍）：想听再在托盘「功能开关」里开。
  tts: {
    enabled: false,
    rate: 1.05,
    pitch: 1.0
  },
  // 主动搭话：闲置这么久之后主动说一句。默认关（会打断思路，见上）。
  proactive: {
    enabled: false,
    idleMinutes: 8
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
    /* 纹理 LOD —— 屏幕用不完的纹理分辨率就降一档（2048→1024，省 24MB 显存，
     * 见渲染层 pet.js 的 TEX_LOD）。默认开：换的是"屏幕显示不出来的细节"，
     * 观感无差。关掉 = 纹理完全不动（排查画质问题时用）。 */
    textureLod: true
    /* 这里原本有 model: 一个可选的模型名。春移除后模型固定成日和，
     * 不再是可配置项 —— 名字只在 params.js 的 MODEL_NAME 写一次。 */
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
    returnOnActivity: true  // 有人操作时，把溜达跑远的她收回原位
  },
  /* 角色交互反馈 */
  interaction: {
    rightMenu: true,      // 在角色身上右键弹出快捷菜单
    headPat: true,        // 在头顶按住 = 一直蹭（A-B-C 三段，松手才收尾）
    dragReact: true,      // 拖着走的时候挣扎 / 不满
    pokeReact: true       // 连戳给出递进反应
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
    fps: 12               // 静默时的渲染帧率上限（12 够看出她还活着，又几乎不耗 GPU）
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
  persona: ''
};

// 情绪标签协议：让模型在回复末尾自带一个 [emo:xxx]，
// 渲染层解析出来驱动 Live2D 表情，解析后会把标签从气泡文本里剥掉。
const EMOTION_TAGS = ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'];

/* 默认角色名 —— 就是**模型自己的名称**（`MODELS[MODEL_NAME].label`）。
 * 三处落点（托盘提示 / 窗口标题 / 人设自称）都读它。
 *
 * 为什么这里是**副本**而不是 import：主进程是 CJS、params.js 是浏览器 ESM
 * （由 index.html 以 <script type="module"> 加载），require 不进来。
 * 与 llm.js 的 `LLM_TIMEOUT` 是同一个困境，走同一条路 —— 留字面量副本 +
 * 断言互验（verify-rename.js 的 [G] 段把 params.js 的 label、这里的
 * DEFAULT_NAME、index.html 的 <title> 三份一起比，不一致就报红）。
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
  personaPartDefaults,
  buildPersonaFromParts,
  hasCustomParts,
  resolveName,
  resolvePersona,
  loadConfig,
  saveConfig,
  cfgReadBlocked
};
