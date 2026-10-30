'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, dialog,
  screen, nativeImage, shell, powerMonitor, globalShortcut, desktopCapturer
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* 这一层只做「编排」：起服务、建窗口、装托盘、挂 IPC、开机自启。
 * 具体能力全在 src/main/ 下的独立模块里：
 *   win-size   窗口尺寸（按屏幕现算，换显示器自动适配）
 *   util       clamp / 右下角坐标
 *   config     配置默认值 + 读写
 *   server     本地静态服务
 *   sysinfo    系统状态采集（os + PowerShell 双路）
 *   speech     离线语音识别（Windows 自带 SAPI）
 *   llm        流式对话 + 离线回复池 + 情绪标签过滤器
 *   reminder   定时提醒 / 番茄钟
 *   motion     平滑移动 / 边缘吸附 / 自主漫步
 *   fullscreen 前台全屏检测（游戏 / 全屏时自动静默的输入）
 *   updater    通过 GitHub Releases 检查并安装新版本
 *
 * ⚠️ 拆分后必须守住的两条：
 *   1) 子模块**不许 require main.js**。CJS 的循环依赖不会报错，只会让
 *      某一侧的导出变成 undefined，然后在很远的地方炸开，极难定位。
 *      要碰窗口的模块一律走注入：motion.configureMotion(() => mainWindow)。
 *   2) 模块间共享**可变**状态时导出对象、不导出值 —— CJS 的
 *      module.exports 是快照，导出之后再赋值传不出去（详见 win-size.js）。 */

const { SIZE, MARGIN, refreshWinSize, applyStageWidth } = require('./win-size');
const { clamp, cornerPos } = require('./util');

/* 外观两项读数 + 钳位。所有入口共用，区间见 config.js 的 LIMITS。
 * `Number(v) || 1` 同时挡住 undefined / NaN / 0 / 空串 —— 配置被手改坏时不至于崩。 */
const clampScale = (v) => clamp(Number(v) || 1, LIMITS.scale.min, LIMITS.scale.max);
const clampOpacity = (v) => clamp(Number(v) || 1, LIMITS.opacity.min, LIMITS.opacity.max);
const {
  LIMITS, NAME_LIMITS, getConfigPath, DEFAULT_CONFIG,
  PERSONA_PARTS, PERSONA_PRESETS, personaPresetById, renderPersonaPreset,
  personaPartDefaults,
  resolveName, resolvePersona, loadConfig, saveConfig, cfgReadBlocked
} = require('./config');
const { startLocalServer } = require('./server');
const { collectStats, formatStats, startSensorWatch, stopSensorWatch, waitForFirstGpu, HUD_FIELDS, FULL_FIELDS } = require('./sysinfo');
const { recognizeWav } = require('./speech');
const { streamLLM, createStreamFilter } = require('./llm');
/* 模型目录（预设 + 端点判定 + WorkBuddy models.json 解析）。
 * 纯数据/纯函数，断言见 debug/verify-llm-providers.js。 */
const {
  PROVIDERS, providerById, currentProviderId, isLocalUrl, isUsable, isLlmReady, toPatch, fromWorkBuddyModels,
  featuredProviders, moreProviders, isTestGreen, TIMEOUT_LOCAL
} = require('./llm-providers');
const oneshot = require('./oneshot');
const { toJson: historyToJson, toMarkdown: historyToMarkdown } = require('./chat-export');
const { edgeCueFrom } = require('./edge-cues');
const {
  listProfiles, getProfile, applySnapToLlm, saveCurrentAs, overwriteProfile
} = require('./llm-profiles');
const { DIMS: OCEAN_DIMS, LEVELS: OCEAN_LEVELS, normalize: normalizeOcean, nearestLevel, derive: deriveOcean } = require('./ocean');
const { analyzeRepetition, REPEAT_WINDOW } = require('./repetition-guard');
const { workLine, signatureEmo } = require('./line-pools');
const { probeLocalEndpoints, summarizeProbes } = require('./local-guide');
const {
  setReminderSink, addReminder, clearReminders, reminderCount,
  listReminders, startPomodoro, stopPomodoro, pomodoroStatus, disposeReminders,
  onScreenLock: onReminderScreenLock, onScreenUnlock: onReminderScreenUnlock
} = require('./reminder');
const {
  configureMotion, configureThrowHooks, cancelMoveAnim, cancelAutoMotion,
  isMoveAnimRunning, setMotionPaused,
  edgeSnap, setHome, startIdleWatcher, refreshWanderConfig, startWander, wanderState,
  setIdleOverride,
  onUserDragMove, onUserDragEnd, notifyUserActivity,
  recordDragSample, tryStartThrow,
  disposeMotion, currentDisplay
} = require('./motion');
const {
  startFullscreenWatch, stopFullscreenWatch, getForeground
} = require('./fullscreen');
const {
  MODES: PRESENCE_MODES, normalizeMode,
  ignoreQuietHours, presenceIdleMul
} = require('./presence');
const {
  startMediaWatch, stopMediaWatch, getMedia, mediaKey, describeMedia
} = require('./media');
const { startSynth, stopSynth, synthWav } = require('./tts');
const {
  PROVIDERS: TTS_PROVIDERS,
  ttsProviderById, ttsIsUsable, ttsCurrentProviderId, ttsToPatch, ttsTest
} = require('./tts-providers');
const {
  isGlancePhrase, buildGlanceUserMessage, captureGlanceScreen
} = require('./glance');
const {
  GRANT_PRESETS_MS, configureGlanceGrant, isGlanceAllowed, grantFor, revoke: revokeGlanceGrant,
  grantSnapshot
} = require('./glance-grant');
const { workStatusIndex } = require('./work-cues');
const petEvents = require('./pet-events');
const {
  stateToWorkPhase, readAgentTail, listAgentFiles
} = require('./agent-link');
const { configureUpdater, checkForUpdates, updaterStatus } = require('./updater');
const bubble = require('./bubble');
const wheel = require('./wheel');
const bubbleMenu = require('./bubble-menu');
const cardMenu = require('./card-menu');
const { createMoodEngine, setPrideSoftMul, setRateMul } = require('./mood');
const { createTemperament } = require('./temperament');
const { shouldProactiveSpeak } = require('./info-gain');
const {
  configureLedger, bookDelivery, settleDelivery, previewProactive
} = require('./proactive-ledger');
const { cardToPersonaDraft } = require('./character-card');
const { checkPersonaOutput, normalizeLevel: guardLevel } = require('./persona-guard');
const { distillPersonaParts, PROMPT_FIELDS: DISTILL_FIELDS } = require('./persona-distill');
const rhythm = require('./rhythm');
const memory = require('./memory');
const mcp = require('./mcp');

// 项目根目录，本地服务与托盘图标、诊断截图都以它为基准
const PROJECT_ROOT = path.join(__dirname, '..', '..');

/* ============================================================
 *  GPU / GL 后端选择
 *
 *  Windows 的「透明窗口」靠 DWM 的**硬件合成**做 alpha 混合。
 *  Chromium 一旦把 compositing 降级到软件路径
 *  （app.getGPUFeatureStatus().gpu_compositing === 'disabled_software'），
 *  transparent 就会**静默失效** —— 窗口配置全对、capturePage 截出来的图
 *  alpha 也是 0，但屏幕上就是一块白底。极具迷惑性。
 *
 *  有两条路会触发这个降级，都要避开：
 *    1) app.disableHardwareAcceleration()  → 合成整体搬到 browser 进程
 *    2) --use-angle=swiftshader            → Chromium 判定 GL 后端是软件
 *       渲染器，顺手把 compositing 也降级（实测 compositing 会变成
 *       "disabled_software"，哪怕没调 disableHardwareAcceleration）
 *
 *  所以默认**什么都不加**，交给系统挑真实 GPU。显卡驱动正常的桌面上，
 *  透明、WebGL 加速、60fps 全都在。
 *
 *  只有在拿不到真实显卡驱动的环境（远程会话 / 沙箱 —— 那里 ANGLE 只能
 *  解析到 "Microsoft Basic Render Driver"，硬走会 0xC0000005 崩 GPU 进程）
 *  才降级到 SwiftShader。降级是自动的（见下面的 child-process-gone），
 *  代价就是失去透明 —— 但至少能跑起来。
 * ========================================================== */

const SOFTWARE_FLAG = '--pet-software';

const softwareMode =
  process.argv.includes(SOFTWARE_FLAG) || process.env.PET_FORCE_SOFTWARE === '1';

if (softwareMode) {
  // 硬件路径走不通时的兜底。⚠️ 这个模式下面板背景一定是不透明的
  // （软件合成不支持 transparent），这是已知取舍，不是 bug。
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  // Chromium 自 M112 起默认**禁止**把 SwiftShader 用于 WebGL。不显式放行的话，
  // WebGL 上下文能建出来（glVersion 报 2）、模型数据也全部就绪
  // （134 网格 / 70 参数），但**一个像素都画不出来** —— 整片空白。
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  console.warn('[gpu] 已进入软件渲染模式：窗口背景会是不透明的（已知代价）');
} else {
  /* 沙箱必须整体关掉 —— 装了深信服 aTrust 零信任的机器上，这是唯一能跑起来的方案。
   *
   * 症状：窗口一闪都不出现（或白屏）。日志里分两种，会**先后**出现：
   *   1) [gpu] GPU 进程启动阶段崩溃，exit_code = -1073741819（0xC0000005 访问冲突）
   *   2) [renderer] process gone: {"reason":"crashed","exitCode":-2147483645}
   *      （-2147483645 = 0x80000003 STATUS_BREAKPOINT）
   *  只关 GPU 沙箱的话，1) 会消失但 2) 立刻接上 —— 因为 renderer 也是沙箱进程。
   *
   * 排查陷阱：日志里会刷一屏 DawnGraphiteCache 的
   *   "另一个程序正在使用此文件 (0x20)" —— **那是伴生噪音，不是原因**。
   *   把整个 GPUPersistentCache 移走照样崩，别去清缓存。
   *
   * 定位过程：默认参数崩、显式 --use-angle=d3d11 崩、独立 --user-data-dir 崩，
   *   加上关沙箱的参数后崩溃数归零 → 和 GL 后端、缓存、用户数据都无关，
   *   就是**沙箱进程被外部注入打崩**。aTrustAgent / aTrustXtunnel 会向进程注入
   *   DLL 做管控，而沙箱进程权限最低、最容易被打成访问冲突。
   *   → 这个故障是**环境相关、且时好时坏**：aTrust 没连内网时一切正常，
   *     连上之后必崩。表现为「早上还能跑，下午突然起不来」，极具迷惑性。
   *
   * 代价：进程不再沙箱化。本项目只加载自己写的页面 + 官方 Live2D 素材，
   *   不加载任何外部网页，安全面可接受；**将来若要加载远程内容，必须重新评估**。
   */
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

/* 朗读用的是 WebAudio（见 src/renderer/tts.js）—— 音频要能在**没有任何
 * 用户手势**的情况下播放（她主动搭话时你根本没碰过这个窗口）。
 * Chromium 的默认策略是 document-user-activation-required，Electron 通常
 * 会放行，但这是**自动播放能不能出声**的开关，写在明处比赌默认值好。 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let tray = null;
let httpServer = null;
let serverPort = 0;

/* ---- 跨模块注入 ----
 * motion 要能拿到「当前」窗口（窗口会被销毁重建，所以给 getter 而不是快照）；
 * reminder 到点了要弹气泡、必要时还得把窗口唤出来 —— 那部分是窗口的活，
 * 留在这一层做，并通过 setReminderSink 注进去。 */
configureMotion(() => mainWindow);
configureThrowHooks({
  onSquash: (intensity) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pet:squash', { intensity });
      }
    } catch { /* ignore */ }
  },
  onTilt: (rad) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pet:tilt', { rad });
      }
    } catch { /* ignore */ }
  },
  onFace: (dir) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pet:facing', { dir });
      }
    } catch { /* ignore */ }
  },
  onSettled: () => {
    /* 甩抛停稳 = 用户明确甩到的位置 → 可落盘（规矩 25 只管自动移动）。
     * 可选再贴边（配置开了才）。 */
    edgeSnap();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const { x, y } = mainWindow.getBounds();
      saveConfig({ ...loadConfig(), window: { x, y } });
    }, 500);
  }
});
memory.configureMemory({
  getPath: () => path.join(app.getPath('userData'), 'memory-facts.json'),
  getForgetEnabled: () => !!(loadConfig().memory?.forget?.enabled),
  /* W2：安静时段来源复用 proactive.quietHours（口径唯一：解析失败当不设）。 */
  getQuietSpec: () => String(loadConfig().proactive?.quietHours || ''),
  getQuietPenalty: () => loadConfig().memory?.quietPenalty !== false
});
mcp.configureMcp({
  getCfg: () => loadConfig().mcp || { enabled: false, servers: [], grants: {} }
});

setReminderSink((payload) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('pet:remind', payload); } catch { /* ignore */ }
  /* ⚠️ 全屏静默期间**不把窗口唤出来**。
   *    在独占全屏的游戏上 show()/focus() 会把游戏顶到后台（很多游戏因此
   *    直接最小化甚至掉驱动），为了一个"该喝水了"的提醒害玩家丢一局，
   *    代价完全不对等。气泡照发，退出全屏后她脸上就挂着那句话。 */
  if (quiet) return;
  if (mainWindow.isVisible && !mainWindow.isVisible()) mainWindow.show();
});

/* 单点改配置并广播。托盘菜单、渲染层都用它，
 * 保证「配置落盘 + 通知渲染层 + 重画菜单」三件事永远一起发生。
 * 读写本身在 config.js，这里只做编排 —— 它要碰窗口和托盘，
 * 放到 config.js 里会让那个模块反过来 require 主文件。 */
function patchConfig(section, patch) {
  const cur = loadConfig();
  const next = { ...cur };
  if (section) next[section] = { ...(cur[section] || {}), ...patch };
  else Object.assign(next, patch);
  /* ⚠️ 落盘结果必须看一眼，再决定要不要说"改好了"。
   *    saveConfig 有两种失败：磁盘写不进去，以及"本次运行读不到配置"
   *    （那种情况下它**故意拒绝写**，见 config.js 的 cfgUnreadable）。
   *    以前这里把返回值丢掉、菜单照样弹「大小 106%」—— 用户以为成功了，
   *    重启一看没变，属于"提示与实际不符"。 */
  if (!saveConfig(next)) {
    const blocked = cfgReadBlocked();
    toast(blocked
      ? `配置读不了（${blocked}），这次改动没能保存`
      : '设置没能写入磁盘，重启后可能不生效');
  }
  syncOceanFromConfig(next);        // personality 改了立刻喂 mood / 供下次读
  try { refreshAgentLinkWatch(); } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('config:changed'); } catch { /* 窗口在销毁 */ }
  }
  bubble.refreshConfig();           // 气泡开关切到关：立刻把浮窗收掉
  if (!section || section === 'hotkeys') refreshHotkeys();
  refreshTrayMenu();
  return next;
}

/* ============================================================
 *  窗口
 * ========================================================== */

// 右下角是默认落点，但记住上次拖到哪儿了更有用
function getInitialBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const fallback = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN);

  const saved = loadConfig().window;
  if (!saved || typeof saved.x !== 'number' || typeof saved.y !== 'number') return fallback;

  // 显示器布局可能变过（拔了外接屏等），位置跑到屏幕外就退回右下角，
  // 否则窗口会出现在看不见的地方，用户以为程序没启动。
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x + SIZE.w > a.x && saved.x < a.x + a.width &&
           saved.y + SIZE.h > a.y && saved.y < a.y + a.height;
  });

  return visible ? { x: Math.round(saved.x), y: Math.round(saved.y) } : fallback;
}

function createWindow() {
  refreshWinSize();                 // 先按当前屏幕定尺寸，后面 getInitialBounds 要用
  const { x, y } = getInitialBounds();

  /* 「家」= 本次启动时她在的位置（用户 2026-10-13 明确了这个定义：
   * 「初始位置」就是启动时的位置）。她溜达跑远之后，你一操作（动鼠标 /
   * 敲键盘，系统级判定）她就会走回这里。详见 motion.js 的 setHome。 */
  setHome(x, y);

  mainWindow = new BrowserWindow({
    width: SIZE.w,
    height: SIZE.h,
    x,
    y,
    transparent: true,        // 透明背景（必须配 frame:false，否则透明区渲染成黑色）
    frame: false,
    show: false,              // 先隐藏创建，首帧就绪再显示（见下面的 ready-to-show）
    alwaysOnTop: isOn('appearance', 'alwaysOnTop'),
    skipTaskbar: true,
    hasShadow: false,         // 关掉阴影，否则边缘有灰圈
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(isOn('appearance', 'alwaysOnTop'), 'floating');

  /* 窗口标题走配置。窗口是无边框的（frame:false），标题看不见 ——
   * 但任务管理器、以及某些窗口管理工具读的就是它，改了名字这里也该跟着变，
   * 否则「阿岩」会从这些地方漏出来。index.html 里的 <title> 是静态兜底，
   * 真正生效的是这一行。 */
  mainWindow.setTitle(resolveName(loadConfig()));

  /* 🔴 页面里的 <title> 会把上面这行**覆盖掉** —— Electron 默认行为是
   * 「文档标题一变就同步窗口标题」，而 loadURL 发生在 setTitle 之后。
   * 血案（2026-10-14 实测）：index.html 写死 <title>阿岩</title>，于是不管配置里
   * 叫什么，任务管理器 / Alt+Tab / 窗口管理工具里永远显示「阿岩」——
   * 主进程日志打的是 `[name] 当前角色名: "小绿"`，tasklist 读出来的窗口标题却是
   * "阿岩"，两者对不上。这正是硬规矩 10「名字三处一起刷」漏掉的第三处。
   * 拦掉默认动作后，窗口标题只由 setTitle 决定，改名的三处才真的同步。 */
  mainWindow.on('page-title-updated', (e) => e.preventDefault());

  /* 可见性一变就通知渲染层。挂在窗口事件上、而不是在每个 hide/show 的调用点
   * 各写一次：显示/隐藏分散在托盘、渲染层「隐藏」、第二实例、静默等好几处，
   * 漏一处就有一处偷偷跑到满帧（用户还以为藏起来就省了）。 */
  mainWindow.on('show', notifyVisibility);
  mainWindow.on('hide', notifyVisibility);
  if (process.env.PET_WINSIZE_LOG) {
    /* 诊断开关：PET_WINSIZE_LOG=1 时把「谁在动窗口尺寸」全打出来。
     * 存在的理由：第三次「两个她」的来路是**窗口被缩**（旧帧比新视口大 →
     * 合成面残留），而缩窗口的调用点分散在 setStageWidth / 屏幕事件 /
     * 拖拽三条路径上，渲染层只能看到结果（canvasResize 出现第二行）。
     * 用这个开关跑一次就能把「渲染层看到的第二行」对上「主进程哪一行」。
     * ⚠️ 默认关闭，别改成常驻日志（每帧 setStageWidth 都会打一行）。 */
    mainWindow.on('resize', () => console.log('[winsize] win-resize', JSON.stringify({
      bounds: mainWindow.getBounds(), content: mainWindow.getContentBounds(), SIZE: { ...SIZE }, t: Date.now()
    })));
  }

  /* 启动时把生效的名字打出来。
   * 名字有三处落点（托盘 / 标题 / 人设自称），用户改名后如果哪一处没跟着变，
   * 从界面上很难判断到底是"没写进配置"还是"写了但某一处没读"。
   * 这行日志给出的是"主进程认定的名字"，是排查时的第一手依据。 */
  console.log('[name] 当前角色名:', JSON.stringify(resolveName(loadConfig())));

  /* 人设同理，而且它更隐蔽：改了设定但对话没变化，可能是因为
   * toggleConfig 没生效、也可能是被整段 persona 顶掉了。
   * 打出"来源"(整段/分项 N 项/默认)与字符数，一眼能分辨是哪种。 */
  {
    const c = loadConfig();
    const whole = String(c.persona || '').trim();
    const nParts = PERSONA_PARTS.filter((p) => String((c.personaParts || {})[p.key] ?? '').trim()).length;
    const src = whole ? '整段覆盖' : (nParts ? `分项 ${nParts} 项` : '全默认');
    const body = resolvePersona(c);
    console.log('[persona] 来源:', src, '| 字符数:', body.length);
    if (whole) console.warn('[persona] 注意：persona 字段非空，分项设置被它覆盖');
  }

  // 默认整窗穿透，但把鼠标移动事件转发给渲染进程，
  // 渲染进程靠 mousemove 判断光标是否落在角色本体上，再决定关闭穿透。
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Windows 上 transparent 窗口用「隐藏创建 → 首帧就绪再显示」更稳：
  // 一创建就显示的话，DWM 可能把首帧那个还没上 alpha 的底缓存住，
  // 结果就是窗口一直是一块白底，怎么改配置都不生效。
  //
  // 📌 PET_HIDDEN=1（2026-10-15 加，血的教训）：纯采样类实跑（量内存之类，
  //    不截图）让窗口**完全不显示**。起因：dev 实例可见、置顶、默认位置与
  //    用户自己的桌宠完全一致，用户启动自己的实例时屏幕上出现"两个重叠的
  //    人"——而 requestSingleInstanceLock 按 userData 目录互斥，--user-data-dir
  //    隔离的 dev 实例根本拦不住。⚠️ 两处 show（这里 + 4s 兜底）都要拦，
  //    漏一处照样弹出来；⚠️ 别和 PET_SNAPSHOT 同用（隐藏窗口 capturePage
  //    截不到内容，截图类探针必须可见）。
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    if (process.env.PET_HIDDEN !== '1') mainWindow.show();
    else console.log('[pet] PET_HIDDEN=1 —— 窗口不显示（采样模式）');
    mainWindow.setAlwaysOnTop(isOn('appearance', 'alwaysOnTop'), 'floating');
    // 页面就绪后把外观配置（缩放 / 透明度 / 模型）同步过去
    syncAppearance();
  });
  // 兜底：万一 ready-to-show 没触发，也不能让窗口永远不出现
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible() && process.env.PET_HIDDEN !== '1') mainWindow.show();
  }, 4000);

  // PET_ENTRY 用于排查：可临时指向最小页面
  const entry = process.env.PET_ENTRY || 'src/renderer/index.html';
  // PET_SNAPSHOT=1 时让渲染进程触发一次窗口截图，用于无截屏权限时验证
  // PET_SNAPSHOT=ui 会额外把气泡和输入条露出来再截一张
  const query = process.env.PET_SNAPSHOT ? `?snap=${process.env.PET_SNAPSHOT}` : '';
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/${entry}${query}`);

  // 把渲染进程的日志和加载失败转发到终端，否则错误会被静默吞掉
  mainWindow.webContents.on('console-message', (...args) => {
    const parts = args.map((a) => (a && typeof a === 'object' ? JSON.stringify(a) : a));
    console.log('[renderer]', ...parts);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', JSON.stringify(details));
  });

  /* 拖动停止后记住位置（moved 触发很密集，debounce 一下再落盘）。
   *
   * ⚠️ **自动移动期间不保存**：溜达 / 回位也是 setBounds 写位置，照存不误的话
   *    下次启动的「家」就是她上一轮溜达到的随机点 —— 越跑越偏，而且用户会
   *    发现"她自己换地方住了"。所以自动动画跑着的时候直接跳过，
   *    等用户真拖完松手（pet:drag-end 那条路）再落盘。 */
  let savePosTimer = null;
  mainWindow.on('moved', () => {
    clearTimeout(savePosTimer);
    if (isMoveAnimRunning()) return;
    savePosTimer = setTimeout(() => {
      if (!mainWindow || isMoveAnimRunning()) return;
      const [x, y] = mainWindow.getPosition();
      saveConfig({ ...loadConfig(), window: { x, y } });
    }, 600);
  });

  mainWindow.on('closed', () => {
    bubble.dispose();     // 气泡窗比主窗命短：主人没了它也没必要留
    mainWindow = null;
  });

  /* 气泡悬浮在主窗头顶上方（独立小窗），主窗动它就得跟着动。
   * 'move' 在拖拽与程序化移动（溜达 / 回位 / 贴边）中连续触发，
   * syncPosition 内部自带节流。 */
  mainWindow.on('move', () => bubble.syncPosition());
  mainWindow.on('resize', () => bubble.syncPosition());
}

/* ============================================================
 *  全局光标跟随
 * ==========================================================
 *
 * 渲染进程只能靠 mousemove 知道光标在哪，而 mousemove 只在**窗口内**触发。
 * 窗口才三百来像素宽、三百多高，鼠标一移出去就再也没有事件了，pointer 冻在最后那个点，
 * 表现就是「鼠标离开她附近，目光就不动了」。
 *
 * 修法：由主进程按固定节奏读系统光标位置，换算成「相对窗口左上角」的坐标
 * 发给渲染进程 —— 和 mousemove 的 e.clientX/clientY 同一坐标系，
 * 渲染层拿到直接当 pointer 用，窗口内外无缝衔接。
 *
 * 几个刻意的选择：
 *   - getCursorScreenPoint() 返回 DIP，和 getBounds() 是同一套单位，
 *     直接相减就行（HiDPI 不用换算，算错反而会偏）。
 *   - 坐标变化小于 1px 就不发，鼠标静止时零 IPC 流量。
 *   - 窗口不可见时跳过，托盘里关掉显示就完全不轮询。
 *   - 33ms ≈ 30fps：视线的 focus() 本身是插值逼近的，再快也看不出区别，
 *     但比 60fps 省一半的跨进程调用。
 */
const CURSOR_POLL_MS = 33;
let cursorTimer = null;
let lastCursor = { x: NaN, y: NaN };

function startCursorPolling() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    // 全屏静默时不发（30fps 的跨进程 IPC 白烧 —— 她反正被盖着看不见）
    if (quiet) return;

    let pt;
    try {
      pt = screen.getCursorScreenPoint();
    } catch {
      return;
    }

    const b = mainWindow.getBounds();
    const x = pt.x - b.x;
    const y = pt.y - b.y;
    // 亚像素抖动不值得发；1px 的粒度已经比 focus 的插值精度细得多
    if (Math.abs(x - lastCursor.x) < 1 && Math.abs(y - lastCursor.y) < 1) return;
    lastCursor = { x, y };

    try {
      mainWindow.webContents.send('pet:cursor', { x, y });
    } catch { /* 窗口正在销毁，忽略 */ }
  }, CURSOR_POLL_MS);
}

/* ============================================================
 *  外观 / 窗口控制
 * ========================================================== */

/* W6：悬停渐隐进行中 —— syncAppearance 要把透明度压低，别被配置值顶回去。 */
let hoverFadeActive = false;

/* 把 appearance 配置同步到窗口与渲染层。
 * 托盘、渲染层右键菜单、手改 config.json 后的重载 —— 全部收敛到这里，
 * 保证「配置 / 窗口实际状态 / 渲染层看到的」三处永远一致。 */
function syncAppearance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const a = loadConfig().appearance || {};

  /* 关了悬停渐隐就立刻熄掉进行中状态，别让旧透明度粘着。 */
  if (!a.hoverFade) hoverFadeActive = false;
  const baseOp = clampOpacity(a.opacity);
  /* W6：悬停渐隐时压到 ≤0.32，松手/离开后恢复 baseOp。 */
  const opacity = hoverFadeActive ? Math.min(baseOp, 0.32) : baseOp;
  /* ⚠️ 全屏静默期间**强制取消置顶**（用户配置只在这一条上被临时覆盖）：
   *    独占全屏的游戏会盖住她，置不置顶看不出来；但**无边框窗口化的游戏**
   *    （现在绝大多数）里，一个 alwaysOnTop 的窗口会一直浮在游戏画面上，
   *    既挡视线又让 DWM 多做一层合成。退出静默时 syncAppearance 会按配置
   *    把置顶恢复回来 —— 恢复路径只有这一条，不会漏。 */
  const onTop = !quiet && a.alwaysOnTop !== false;
  const scale = clampScale(a.scale);

  try { mainWindow.setOpacity(opacity); } catch { /* 某些合成模式下不支持 */ }
  try { mainWindow.setAlwaysOnTop(onTop, 'floating'); } catch { /* ignore */ }
  /* W30：explorer 重启后 skipTaskbar 可能丢 —— 跟置顶一起重申。 */
  try { mainWindow.setSkipTaskbar(true); } catch { /* ignore */ }
  const model = APPEARANCE_MODELS.some((m) => m.id === a.model) ? a.model : 'hiyori';
  try {
    mainWindow.webContents.send('appearance:changed', { scale, opacity: baseOp, onTop, model });
  } catch { /* 窗口正在销毁 */ }
}

/* W30：置顶看门狗。explorer / DPI / 休眠后 WS_EX_TOPMOST 偶发丢失。 */
let topWatchTimer = null;
function refreshTopWatchdog() {
  if (topWatchTimer) { clearInterval(topWatchTimer); topWatchTimer = null; }
  topWatchTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (quiet) return;
    const a = loadConfig().appearance || {};
    if (a.alwaysOnTop === false) return;
    try {
      if (!mainWindow.isAlwaysOnTop()) {
        mainWindow.setAlwaysOnTop(true, 'floating');
        console.log('[top-watch] 置顶已丢失，已重申');
      }
      mainWindow.setSkipTaskbar(true);
    } catch { /* ignore */ }
  }, 30000);
}

/* ---- 悬浮显示：按配置定期把状态推给渲染层 ---- */
let statsTimer = null;
let statsGen = 0;   // 每次重排自增；旧的一轮循环靠它对不上号就自动退出

function refreshStatsTimer() {
  if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
  const gen = ++statsGen;
  const cfg = loadConfig();

  /* 常驻传感器采样器**跟着悬浮显示一起开关**。
   * 开：它每秒采一枪，于是每次推送都直接命中新鲜读数 —— 一次进程都不用起，
   *     而且 GPU 那个数描述的是**眼前这一秒**而不是过去 4 秒（见 sysinfo.js）。
   * 关：立刻停掉。它再便宜也不该在没人看的时候白跑。 */
  const hudOn = !!cfg.monitor?.floating && !quiet;
  if (!hudOn) { stopSensorWatch(); return; }

  const ms = clamp(Number(cfg.monitor?.intervalMs) || 3000, 1000, 30000);

  /* 采样节奏**跟着显示节奏走**：显示每 ms 推一次，采样比它更密就是白烧 ——
   * 多采的那几枪没有任何人看得到。上限压在 sysinfo 的 LIVE_TTL 以内，
   * 否则读数会"过期"，查询反而退回更贵的"现起一个进程打一枪"。 */
  startSensorWatch(clamp(ms, 1000, 5000));

  /* 本轮的第一次推送要不要先等 GPU（见 tick 里那段）。每轮 timer 重建都重置。 */
  let firstTick = true;

  /* ⚠️ 用「跑完再排下一次」的自调度，**不要用 setInterval(push, ms)**。
   *    踩过的坑：`push` 是异步的，一次要 ~1s。setInterval 到点就发、
   *    不管上一枪跑没跑完，于是冷启动时第一枪还没结束第二枪就叠上来了 ——
   *    两次采样挨得太近，第二枪的判别失效、那一帧就少东西。
   *    自调度保证两枪之间必然隔着完整的间隔。
   *    （现在 GPU 走常驻采样器、push 本身已经接近 0 开销，这条护栏依然要留：
   *      悬浮显示刚打开的那一两秒仍会走"现打一枪"的冷启动路径。）
   * ⚠️ 用 generation 号而不是 `statsTimer === null` 判断"我是否被取消"：
   *    重排会把 statsTimer 立刻赋成新值，旧循环等 push 回来后看到它非 null，
   *    会以为自己还该活着 → 两个循环并存。gen 对不上就直接退出，干净。 */
  const tick = async () => {
    if (gen !== statsGen) return;
    /* 🔴 第一枪之前先等采样器吐出第一条读数。
     *    常驻采样器得先把 powershell 拉起来、跑一次 nvidia-smi（≈1.5s）。
     *    不等它的话第一帧就是「半张牌」—— CPU / 内存先出现，
     *    牌上留一个空位，GPU 下一拍才补进来，用户看到的就是
     *    「首次加载时 GPU 比别的项慢一拍」。
     * ⚠️ 只等第一次：采样器没跑 / 这台机器没有 N 卡（GPU 与温度整项不画）时
     *    它立刻返回 false，不会把后面的推送节奏也拖长。 */
    if (firstTick) {
      firstTick = false;
      await waitForFirstGpu();
      if (gen !== statsGen) return;
    }
    await push();
    if (gen !== statsGen) return;          // push 期间被重排/关掉了 → 不再续
    statsTimer = setTimeout(tick, ms);
  };

  const push = async () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
    /* 只要悬浮小字真正画的那几项 —— 电量与网速不在这里显示，
     * 取了就是每 3 秒白烧 2.5 秒的 PowerShell（网卡统计在本机很慢）。 */
    const s = await collectStats(HUD_FIELDS);
    try { mainWindow.webContents.send('monitor:stats', s); } catch { /* ignore */ }
  };

  statsTimer = setTimeout(tick, 0);
}

/* ============================================================
 *  全屏 / 游戏自动静默
 * ==========================================================
 *
 *  检测在 fullscreen.js（常驻 PowerShell 采样前台窗口 + 纯函数判定），
 *  这里只负责「静默时到底关掉什么、醒来时怎么恢复」。
 *
 *  静默期间一共做四件事，每一件都对应一个真实的浪费：
 *    1) 冻结自动移动     —— 她在游戏旁边溜达没有任何意义
 *    2) 停系统状态轮询   —— 每 3 秒一次的 PowerShell 采样是最实打实的抢资源
 *    3) 取消窗口置顶     —— 窗口化游戏下她会一直浮在画面之上
 *    4) 通知渲染层降帧   —— 60fps 画一个你没在看的角色
 *  另外两条在别处：光标轮询（startCursorPolling）与提醒不抢焦点（setReminderSink）。
 *
 *  ⚠️ 这是一个**状态**，不是一次性动作 —— 所以恢复路径必须和进入路径一样
 *    完整。漏一条的表现是"打完工回来她变傻了"（不动了 / 底座没了 / 窗口
 *    沉在最底下），而且从界面上完全看不出原因。
 * ========================================================== */

let quiet = false;

/* 锁屏状态（powerMonitor 事件维护，渲染层闸门吃）。
 * 与 quiet 的分界：quiet 是全屏静默那套七处收手的**状态机**；
 * screenLocked 只拦主动搭话 —— 锁屏时她照常待机，只是不主动出声。 */
let screenLocked = false;

/* 在途的主动搭话请求（第 9 轮第一档的"在途作废"）。
 * 她正生成主动话时用户开口 → chat:send 一进来就 abort()：
 * 在 llm.js 的源头断流，chunk 不再往外走，晚到的主动话不会
 * 从新对话的气泡里冒出来。 */
let proactiveAbort = null;
/* 在途的普通对话（G3）：新一轮 chat:send 要掐掉上一轮流，
 * 否则 busy 期间打断只会在渲染层换气泡，主进程还在往外吐旧回复。 */
let chatAbort = null;

function quietPayload() {
  const q = loadConfig().quiet || {};
  return { quiet, fps: clamp(Number(q.fps) || 12, 1, 60) };
}

function setQuiet(on, why) {
  const next = !!on;
  if (next === quiet) return;
  quiet = next;

  /* 打日志是刻意的：这个功能**从界面上几乎看不出来**（她本来就是安静的
   * 状态之一），出问题时唯一的线索就是这条日志。 */
  console.log('[quiet]', JSON.stringify({ quiet, why: why || '' }));

  setMotionPaused(quiet);
  refreshStatsTimer();
  syncAppearance();                 // 内部按 quiet 决定置顶
  bubble.setQuiet(quiet);           // 悬浮气泡会盖住全屏应用，静默必须收掉
  try { mainWindow?.webContents.send('pet:quiet', quietPayload()); } catch { /* ignore */ }
  refreshTrayMenu();                // 菜单标题要能显示"静默中"
}

/* 按配置启停监视。用户在托盘里关掉这个开关时要能**立刻**退出静默，
 * 而不是等她再切一次窗口。 */
function refreshQuietWatcher() {
  if (isOn('quiet', 'enabled')) {
    startFullscreenWatch((full, why) => setQuiet(full, why));
  } else {
    stopFullscreenWatch();
    setQuiet(false, 'disabled');
  }
}

/* 语音朗读的合成进程，按配置起停。
 *
 * `tts.engine='winrt'` 时才需要它 —— 渲染层要一段 wav 才能做真口型
 * （见 src/main/tts.js 的文件头）。提前起好，第一句才不用白等 700ms
 * 的进程启动 + WinRT 绑定。
 *
 * ⚠️ 幂等：startSynth 里"已在跑就直接返回"，所以 config:set 那种
 *    每次改配置都会走到这里的路径不会把进程反复重启。 */
function refreshTTS() {
  const t = loadConfig().tts || {};
  const want = t.enabled === true && (t.engine ?? 'winrt') === 'winrt';
  if (want) startSynth();
  else stopSynth();
}

/* G26：全局热键（默认关）。accelerator 冲突时静默跳过，不挡启动。 */
function refreshHotkeys() {
  try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
  const hk = loadConfig().hotkeys || {};
  if (hk.enabled !== true) return;
  const reg = (acc, fn, label) => {
    const a = String(acc || '').trim();
    if (!a) return;
    try {
      if (!globalShortcut.register(a, fn)) {
        console.warn('[hotkeys] 注册失败（可能冲突）:', label, a);
      }
    } catch (err) {
      console.warn('[hotkeys]', label, err?.message || err);
    }
  };
  reg(hk.toggleVisible, () => toggleVisible(), 'toggleVisible');
  reg(hk.stopSpeak, () => {
    try { mainWindow?.webContents.send('pet:stop-speak'); } catch { /* ignore */ }
  }, 'stopSpeak');
}

/* 媒体采样进程，按配置起停（同 refreshTTS 的形态）。
 * ⚠️ 幂等：startMediaWatch 里"已在跑就直接返回"。
 *
 * `PET_MEDIA=1` 时把每次采样打进日志 —— 这是唯一能回答"真实播放器到底
 * 会不会上报歌名"的办法（自造的媒体会话不上报，未打包进程没有应用标识）。
 * 想验证就：开开关、放一首歌、看日志里 title 有没有值。 */
function refreshMediaWatcher() {
  if (!isOn('media', 'enabled')) { stopMediaWatch(); return; }
  /* ⚠️ onSample 这个键要**每次都显式给**（哪怕是 null）—— 它是"要不要换钩子"
   * 的开关，不给就保持原样（见 media.js 里的说明）。 */
  startMediaWatch({
    onSample: process.env.PET_MEDIA
      ? (m) => console.log('[media] 采样', JSON.stringify(m))
      : null
  });
}

/* ============================================================
 *  托盘
 * ========================================================== */

/* 菜单随时可能重建 —— 勾选状态不会自己刷新，而配置改动来自很多入口
 * （托盘、渲染层右键菜单、手改 config.json）。所以把模板函数存起来，
 * patchConfig() 改完配置后统一调 refreshTrayMenu()。 */
let buildTrayMenu = null;

function refreshTrayMenu() {
  if (!tray || (tray.isDestroyed && tray.isDestroyed()) || !buildTrayMenu) return;
  try { tray.setContextMenu(buildTrayMenu()); } catch { /* 菜单正在显示时可能失败，忽略 */ }
}

// 托盘图标：Q 版日和头像（16/32/48 三张，改设计请跑 tools/make-tray-icon.js）
// 用 addRepresentation 提供 1x/2x/3x，Windows 会按任务栏 DPI 自己挑最合适的那张。
function makeTrayIcon() {
  const dir = path.join(PROJECT_ROOT, 'src', 'assets');
  const img = nativeImage.createEmpty();
  for (const [scale, file] of [[1, 'tray-16.png'], [2, 'tray-32.png'], [3, 'tray-48.png']]) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    try {
      img.addRepresentation({ scaleFactor: scale, buffer: fs.readFileSync(p) });
    } catch (err) {
      console.warn('[tray] 图标表示加载失败', file, String(err?.message || err));
    }
  }
  if (!img.isEmpty()) {
    console.log('[tray] 图标就绪', JSON.stringify(img.getSize()));
    return img;
  }

  // 兜底：图标文件缺失时给个纯色块，至少托盘里还有个能点的东西
  console.warn('[tray] 图标文件缺失，回退到纯色块');
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const p = i * 4;
    buf[p] = 0x56;      // B
    buf[p + 1] = 0x6e;  // G
    buf[p + 2] = 0x0f;  // R
    buf[p + 3] = 0xff;  // A
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  // 名字走配置：改完名字由 renameDialog 直接调 tray.setToolTip 刷新，
  // 不必重建整个托盘（重建会让图标闪一下）。
  tray.setToolTip(resolveName(loadConfig()));
  buildTrayMenu = buildMenuTemplate;
  refreshTrayMenu();

  tray.on('double-click', () => toggleVisible());
}

/* 读某个开关的当前值。def 是「配置里没写时」的默认 ——
 * 有些功能默认开（互动类），有些默认关（悬浮显示、语音输入）。 */
function isOn(section, key, def = true) {
  const v = loadConfig()[section]?.[key];
  return v === undefined || v === null ? def : !!v;
}

/* 操作反馈：优先进悬浮气泡（status 级），不再用主窗琥珀色 #status 条。
 * 浮窗总开关关着时才回退 #status；对话流占用气泡时静默丢掉，别再冒那条提示。 */
function toast(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const ms = Math.max(2800, Math.min(6000, 2000 + t.length * 40));
  try {
    if (bubble.showStatus(t, ms)) return;
  } catch { /* ignore */ }
  try {
    if (loadConfig().chat?.floatBubble === false) {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('pet:toast', { text: t });
    }
  } catch { /* ignore */ }
}

/* 模型素材不随仓库分发（版权归 Live2D Inc.，放在 Release 的 models.zip 里），
 * 所以从源码跑的人有可能压根没有 src/assets/models/。那种情况下应用能起、托盘
 * 也在，但舞台上空无一物 —— 报错发生在渲染层，日志里只剩一句 404，很难定位。
 * 这里在启动时主动查一次并给出可操作的提示。只提示，不影响启动。 */
function warnIfModelsMissing() {
  const modelsDir = path.join(PROJECT_ROOT, 'src', 'assets', 'models');
  let names = [];
  try {
    names = fs.readdirSync(modelsDir);
  } catch { /* 目录都不存在，下面统一处理 */ }

  const hasModel = names.some((n) => {
    const dir = path.join(modelsDir, n);
    try {
      return fs.statSync(dir).isDirectory() &&
        fs.readdirSync(dir).some((f) => f.endsWith('.model3.json'));
    } catch { return false; }
  });

  if (hasModel) return;

  console.warn('[models] 找不到任何 Live2D 模型：' + modelsDir);
  console.warn('[models] 模型不随仓库分发。请从 Releases 下载 models.zip，');
  console.warn('[models] 解压到 src/assets/ 后重启（应得到 src/assets/models/hiyori/）。');
}

/* 自动更新：注入依赖 + 启动后延迟检查一次。
 *
 * 为什么延迟而不是立刻查：检查更新要打 github.com，国内网络有时要好几秒
 * 才超时。放在启动瞬间会和"起服务 / 建窗口 / 装托盘"抢资源，最坏情况让窗口
 * 晚出来。而这功能本身是锦上添花 —— 用户第一次看到桌宠的体验不该被它拖累。
 *
 * ⚠️ getCfg 传的是**函数**而不是 loadConfig() 的结果：设置里随时可能改开关，
 *    快照下一分钟就过期（这条是模块间的通用约定，见 tts.js / recorder.js）。 */
function initUpdater() {
  configureUpdater({
    getCfg: loadConfig,
    toast,
    log: (...a) => console.log(...a),
    // 「跳过这个版本」要落盘。走 patchConfig 是为了让「落盘 + 重画托盘」一起发生
    markSkipped: (v) => patchConfig('update', { skippedVersion: v })
  });

  const cfg = loadConfig();
  if (cfg?.update?.enabled === false) {
    console.log('[updater] 自动检查已在设置里关闭');
    return;
  }
  // 下限 3 秒：配置被手改成 0 或负数时不至于在启动瞬间就发请求
  const delay = Math.max(3, Number(cfg?.update?.delaySec) || 12);
  console.log(`[updater] ${delay} 秒后自动检查更新（当前 ${app.getVersion()}）`);
  setTimeout(() => { checkForUpdates({ manual: false }); }, delay * 1000);
}

/* 改名对话框。
 *
 * 为什么不用 dialog.showMessageBox：Electron 的 dialog 模块**没有文本输入**
 * 能力（只有 message / detail / buttons），拿不到用户敲的字。
 * 所以只能自己开一个小 BrowserWindow 当输入框。
 *
 * 用 data: URL 而不是额外建一个 html 文件，是为了不让这个一次性界面
 * 出现在 src/renderer/ 里被误当成正式页面（它不走预加载、不碰 IPC，
 * 只靠 executeJavaScript 取值）。
 *
 * 几个 must：
 *   - modal: true 且 parent 指向主窗口 —— 否则用户能连点两次菜单开出两个框；
 *   - 必须自己拦 Esc：无边框窗口没有系统关闭按钮；
 *   - 返回值区分「取消」和「确定」，取消时要**保持原名不变**，
 *     不能被 trim 成空串写进配置。
 */
function renameDialog() {
  const cfg = loadConfig();
  const current = resolveName(cfg);

  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 360,
      height: 170,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    /* 页面本身不认识 Electron。用 executeJavaScript 读输入框的值，
     * 通过 'done' / 'cancel' 两个约定消息回传 —— 比跑一遍 IPC 简单，
     * 也不会污染主窗口的 IPC 面。 */
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;
           padding:18px 20px;user-select:none}
      h2{font-size:13px;font-weight:500;margin-bottom:10px;color:#e8e8ea}
      input{width:100%;height:32px;padding:0 10px;border-radius:6px;border:1px solid #3a3a40;
            background:#2a2a30;color:#fff;font:14px/1 inherit;outline:none}
      input:focus{border-color:#5a5a66}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;
             background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
      button:hover{filter:brightness(1.15)}
      .row .left{margin-right:auto}
      .err{color:#ff7b7b;font-size:12px;height:15px;margin-top:6px}
    </style>
    <h2>给角色起个名字</h2>
    <input id="n" maxlength="${NAME_LIMITS.max}" value="" autofocus>
    <div class="err" id="e"></div>
    <div class="row">
      <button id="d" class="left">用默认名</button>
      <button id="c">取消</button><button class="primary" id="k">确定</button>
    </div>
    <script>
      const inp = document.getElementById('n'), err = document.getElementById('e');
      inp.value = ${JSON.stringify(current)};
      inp.focus(); inp.select();
      const send = (v) => { window.__renameResult = v; };
      const commit = () => {
        const v = inp.value.trim();
        if (v.length < ${NAME_LIMITS.min}) { err.textContent = '名字不能为空，要用默认名请点左边'; return; }
        if (v.length > ${NAME_LIMITS.max}) { err.textContent = '最多 ${NAME_LIMITS.max} 个字'; return; }
        send(v);
      };
      document.getElementById('k').onclick = commit;
      /* 空串 = 「清掉自定义名，回到默认名」——与配置里 name:'' 的语义一致，
       * 不是"取消"（取消回的是 null）。 */
      document.getElementById('d').onclick = () => send('');
      document.getElementById('c').onclick = () => send(null);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        if (ev.key === 'Escape') send(null);
      });
      window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') send(null); });
    <\/script>`;

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());

    /* 轮询取值。没走 IPC，所以只能问页面要 —— 间隔 120ms 对输入框这种
     * 交互完全无感（人的反应是几百毫秒级），换来的是零 IPC 面扩张。 */
    let finished = false;
    const finish = async (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__renameResult ?? undefined');
        if (v !== undefined) finish(v === null ? undefined : v);
      } catch { /* 页面还在加载，下一轮再试 */ }
    }, 120);

    // 窗口被外部关掉（比如系统强制）也要能收尾，否则 Promise 永久挂起
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

/* 菜单标签里给「角色设定」加个状态后缀 —— 一眼看出是默认还是改过。
 * 「整段覆盖」和「分项自定义」是两回事，标签上要能区分，
 * 否则用户会困惑"我明明设了，为什么标签说默认"。 */
function personaStateLabel(cfg) {
  if (String(cfg?.persona ?? '').trim()) return '（整段自定义）';
  const parts = cfg?.personaParts || {};
  const n = PERSONA_PARTS.filter((p) => String(parts[p.key] ?? '').trim()).length;
  return n ? `（已改 ${n} 项）` : '（默认）';
}

/* 套用人设预设（P1）。空 parts = 恢复分项默认；并清掉整段 persona，
 * 否则整段优先级更高，套了像没套。emotion/thought 协议槽由 render 端跳过。 */
function applyPersonaPreset(id) {
  const preset = personaPresetById(id);
  if (!preset) return false;
  const cfg = loadConfig();
  const rendered = renderPersonaPreset(preset, cfg) || {};
  /* 默认档：清空全部分项。其它档：只写预设给出的键，其余槽恢复默认
   * （避免「先傲娇再元气」残留傲娇的 extra）。 */
  const nextParts = {};
  if (preset.id !== 'default') {
    for (const p of PERSONA_PARTS) {
      if (p.key === 'emotion' || p.key === 'thought') continue;
      if (rendered[p.key]) nextParts[p.key] = rendered[p.key];
    }
  }
  patchConfig(null, { personaParts: nextParts, persona: '', personaId: preset.id });
  toast(preset.id === 'default'
    ? '角色设定已恢复默认'
    : `已套用「${preset.label}」人设`);
  return true;
}

/* G6 药盒：托盘子菜单。挂着的药显示在标签上；选一颗 / 手写 / 清空。 */
function oneshotSubmenu() {
  const pending = oneshot.getPending();
  return {
    label: pending ? `下一句指令（已挂）` : '下一句指令…',
    submenu: [
      ...oneshot.listPills().map((p) => ({
        label: p.label,
        click: () => {
          oneshot.setPending(p.text);
          toast(`已挂「${p.label}」：只影响下一句`);
          refreshTrayMenu();
        }
      })),
      { type: 'separator' },
      {
        label: '手写一句…',
        click: async () => {
          const t = await promptOneshot();
          if (t === undefined) return;
          if (!t) {
            oneshot.clearPending();
            toast('已清空下一句指令');
          } else {
            oneshot.setPending(t);
            toast('已挂自定义指令：只影响下一句');
          }
          refreshTrayMenu();
        }
      },
      {
        label: '清空',
        enabled: !!pending,
        click: () => {
          oneshot.clearPending();
          toast('已清空下一句指令');
          refreshTrayMenu();
        }
      }
    ]
  };
}

/* 手写药盒文案：与改名同一套路，取消 = undefined，空串 = 清空。 */
function promptOneshot() {
  const current = oneshot.getPending();
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 400,
      height: 190,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;padding:18px 20px;user-select:none}
      h2{font-size:13px;font-weight:500;margin-bottom:6px}
      p{font-size:12px;color:#9a9aa0;margin-bottom:10px}
      input{width:100%;height:32px;padding:0 10px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#fff;font:14px/1 inherit;outline:none}
      input:focus{border-color:#5a5a66}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
    </style>
    <h2>对下一句下指令</h2>
    <p>只用一次，说完就丢。留空确定 = 清空。</p>
    <input id="n" maxlength="200" autofocus>
    <div class="row">
      <button id="c">取消</button><button class="primary" id="k">确定</button>
    </div>
    <script>
      const inp = document.getElementById('n');
      inp.value = ${JSON.stringify(current)};
      inp.focus(); inp.select();
      const send = (v) => { window.__oneshotResult = v; };
      document.getElementById('k').onclick = () => send(inp.value.trim());
      document.getElementById('c').onclick = () => send(null);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') send(inp.value.trim());
        if (ev.key === 'Escape') send(null);
      });
      window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') send(null); });
    <\/script>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());
    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__oneshotResult ?? undefined');
        if (v !== undefined) finish(v === null ? undefined : v);
      } catch { /* loading */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

/* 改名入口：菜单里点「重命名」走这里。返回是否真的改成功了。 */
async function promptRename() {
  const next = await renameDialog();
  if (next === undefined) return false;         // 取消：保持原名
  const cur = resolveName(loadConfig());
  /* 空串是「用默认名」，不是"名字叫空" —— 最终生效的那个名字一律走
   * resolveName 算，不在这里另判一次（判两遍就会有一天两边不一致）。
   * 「填了默认名本身」和「留空」效果相同，所以用生效名比较就够，不必比原始值。 */
  const shown = resolveName({ name: next });
  if (shown === cur) return false;              // 生效名没变：不写盘

  patchConfig(null, { name: next });
  // 名字同时出现在三处，都要立刻刷 —— 少刷一处就是「改了一半」
  try { tray?.setToolTip(shown); } catch { /* ignore */ }
  try { mainWindow?.setTitle(shown); } catch { /* ignore */ }
  toast(next ? `已重命名为「${shown}」` : `已恢复默认名「${shown}」`);
  return true;
}

/* ============================================================
 *  模型接入（连接预设 / WorkBuddy 导入 / 真测一句）
 * ==========================================================
 *
 *  背景：`llm.js` 一直是 OpenAI 兼容的，换一家只改 baseUrl / model / key，
 *  但**入口只有「打开配置文件手改 JSON」** —— 填错的表现是等 20 秒超时，
 *  用户根本分不清是"地址错"还是"key 错"还是"模型名错"。
 *
 *  这一层的职责就是把这三件事变成菜单里能点、能看见状态的：
 *    · 预设一键填（改 provider + baseUrl + model，**不动已填的 key**）
 *    · 从 WorkBuddy 的自定义模型文件导入（它就是 OpenAI 兼容的一堆端点）
 *    · 真发一句，按状态码区分"key 无效 / 地址或模型名不对 / 连不上 / 超时"
 *
 *  🔴 边界：WorkBuddy **内置模型**（快速/均衡/极致）走的是它自己的云端额度，
 *     凭据在桌面 App 内部，外部进程拿不到，**这里导入的只是它的「自定义模型」**。
 *     官方 schema 见 workbuddy.cn/docs/cli/models（models[].url 是完整接口路径）。
 * ========================================================== */

/* WorkBuddy / CodeBuddy 的自定义模型文件位置（官方文档写的就是这个路径）。 */
const workBuddyModelsFile = () => path.join(os.homedir(), '.workbuddy', 'models.json');

/* 菜单标题里显示"现在用的是哪家"。
 * 顺序：已知预设 → WorkBuddy 导入的 → 手填地址的 host → 兜底文案。
 * ⚠️ 不要用 provider 字段直接当标签：旧配置里可能压根没有这个键。 */
function llmLabelText(cfg = loadConfig()) {
  const llm = cfg?.llm || {};
  const id = currentProviderId(llm);
  const p = providerById(id);
  if (p && !p.custom) return p.label;
  if (id === 'workbuddy') return `WorkBuddy · ${llm.model || '模型'}`;
  try {
    return new URL(String(llm.baseUrl || '')).host || '自定义';
  } catch {
    return '自定义';
  }
}

/* 读 WorkBuddy 的 models.json。读不到/坏档都返回空列表 ——
 * 读别人的配置文件失败不是本程序的错，不该冒泡到 UI。 */
function readWorkBuddyModels() {
  const file = workBuddyModelsFile();
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, list: [] };
  }
  return { file, list: fromWorkBuddyModels(raw) };
}

/* 切到某条预设。custom 不覆盖地址（见 llm-providers 的 toPatch）。
 * 手切预设 ≠ 配置档：清掉 activeProfile，避免菜单还勾着「家里」实际已是云端。 */
function applyLlmProvider(id) {
  const p = providerById(id);
  if (!p) return;
  patchConfig('llm', { ...toPatch(p), activeProfile: '' });
  const llm = loadConfig().llm || {};
  if (p.custom) {
    toast('已切到自定义：填地址与模型名');
    llmDialog();
    return;
  }
  if (p.local) {
    toast(`已切到「${p.label}」：本机端点，不用填 key`);
    return;
  }
  if (!isUsable(llm)) {
    toast(`已切到「${p.label}」，填个 key 就能聊`);
    llmDialog();
    return;
  }
  toast(`已切到「${p.label}」`);
}

/* 把 WorkBuddy 里配好的某条自定义模型搬过来。
 * 地址/模型/key 一起搬 —— 那条模型在 WorkBuddy 里能跑，搬过来就该能跑。 */
function importWorkBuddyModel(entry) {
  if (!entry) return;
  const patch = { provider: 'workbuddy', baseUrl: entry.baseUrl, model: entry.model, activeProfile: '' };
  if (entry.apiKey) patch.apiKey = entry.apiKey;
  patchConfig('llm', patch);
  toast(entry.keyIsRef
    ? `已导入「${entry.label}」：它的 key 是环境变量引用，需在系统里设好那个变量`
    : `已导入「${entry.label}」`);
}

/* 真发一句。**只判"能不能聊"，不判回答质量** —— 所以 max_tokens 给小、
 * 不加任何提示词，能返回 200 且有正文就算通。
 *
 * 为什么要真发而不是打 /models：/models 通了但模型名写错的情况极常见
 * （各家模型 id 命名完全不同），只有真发 chat 才能同时验证地址+key+模型名。
 * 超时给 15 秒：本地模型首次加载权重要十几秒，云端一般 2 秒内。
 *
 * @param {object} [override] 设置页里「先测再存」：用表单当前值，不强制已落盘。 */
async function testLlm(override) {
  const llm = { ...(loadConfig().llm || {}), ...(override && typeof override === 'object' ? override : {}) };
  if (!isUsable(llm)) {
    toast(isLocalUrl(llm.baseUrl)
      ? '本机地址看起来不对：检查接口地址是否到 /v1'
      : '还没填 key：本机端点可以留空，云端必须填');
    return false;
  }
  const url = `${String(llm.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  toast(`正在试一句（${llm.model || '模型'}）…`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: 'user', content: '用一句话打个招呼' }],
        max_tokens: 32,
        stream: false
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      /* 状态码直接翻译成用户能动手的结论 —— 这三类占了实测失败的绝大多数。 */
      const hint =
        res.status === 401 || res.status === 403 ? '：key 无效或没权限' :
        res.status === 404 ? '：地址或模型名不对' :
        res.status === 429 ? '：限流 / 额度用完' : '';
      toast(`模型连不通（HTTP ${res.status}）${hint}`);
      console.log('[llm-test] fail', res.status, body.slice(0, 300));
      return false;
    }
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content ?? '';
    toast(text ? `模型已就绪：「${String(text).trim().slice(0, 20)}」` : '模型已连通（没解析到正文）');
    console.log('[llm-test] ok', JSON.stringify({ url, model: llm.model, chars: String(text).length }));
    /* M8：自测通过才绿 —— 只记 baseUrl+model 指纹（不动 apiKey）。
     * override 测通也落盘：用户常「先测再存」，绿标应对准刚测过的那对。 */
    try {
      patchConfig('llm', {
        tested: {
          baseUrl: String(llm.baseUrl || '').trim().replace(/\/+$/, ''),
          model: String(llm.model || '').trim(),
          at: Date.now()
        }
      });
    } catch (err) {
      console.warn('[llm-test] 绿标落盘失败', err?.message || err);
    }
    return true;
  } catch (err) {
    toast(err?.name === 'AbortError' ? '模型超时：15 秒没回' : `模型连不上：${err?.message || err}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* 拉模型列表（M3）。GET `${baseUrl}/models`，OpenAI / Ollama / LM Studio 都兼容。
 * 失败可手填 —— 列表只是省抄写，不是硬门槛。返回 string[]（id），失败 []。 */
async function listLlmModels(override) {
  const llm = { ...(loadConfig().llm || {}), ...(override && typeof override === 'object' ? override : {}) };
  const base = String(llm.baseUrl || '').replace(/\/+$/, '');
  if (!base) { toast('先填接口地址'); return []; }
  if (!isUsable(llm)) {
    toast(isLocalUrl(base) ? '地址不像本机端点' : '拉列表也要 key（本机可留空）');
    return [];
  }
  const url = `${base}/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  toast('正在拉取模型列表…');
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: ac.signal,
      headers: {
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {})
      }
    });
    if (!res.ok) {
      toast(`拉列表失败（HTTP ${res.status}）：可继续手填模型名`);
      return [];
    }
    const data = await res.json().catch(() => null);
    const raw = Array.isArray(data?.data) ? data.data
      : (Array.isArray(data?.models) ? data.models : []);
    const ids = [];
    const seen = new Set();
    for (const it of raw) {
      const id = typeof it === 'string' ? it
        : (it && (it.id || it.name || it.model));
      const s = String(id || '').trim();
      if (!s || seen.has(s)) continue;
      seen.add(s);
      ids.push(s);
      if (ids.length >= 80) break;   // datalist 太长反而难找
    }
    if (!ids.length) {
      toast('列表是空的：这个端点可能不支持 /models，请手填');
      return [];
    }
    toast(`拉到 ${ids.length} 个模型，点模型名框选`);
    return ids;
  } catch (err) {
    toast(err?.name === 'AbortError' ? '拉列表超时，请手填模型名' : `拉列表失败：${err?.message || err}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* 模型设置页（M5）。与改名 / 人设同一套路（BrowserWindow + data: URL + 轮询），
 * 不扩 IPC 面。比旧「只填 Key」小窗多：超时两档 + extraBody 高级折叠 + 页内测试。
 * M3：页内「拉取列表」填入模型名 datalist，失败仍可手填。
 *
 * 界面秒数 ↔ 配置毫秒；保存时再 ×1000，并钳到 llm.js 的 LLM_TIMEOUT 上下限。 */
function llmDialog() {
  const { LLM_TIMEOUT } = require('./llm');
  const cfg = loadConfig();
  const llm = cfg.llm || {};
  const p = providerById(currentProviderId(llm));
  const stallSec = Math.round((Number(llm.stallMs) || LLM_TIMEOUT.stallMs) / 1000);
  const totalSec = Math.round((Number(llm.totalMs) || LLM_TIMEOUT.totalMs) / 1000);
  let extraText = '{}';
  try {
    extraText = JSON.stringify(llm.extraBody && typeof llm.extraBody === 'object' ? llm.extraBody : {}, null, 2);
  } catch { extraText = '{}'; }

  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 520,
      height: 580,
      minWidth: 440,
      minHeight: 480,
      resizable: true,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{height:100%}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;
           padding:16px 20px 12px;user-select:none;display:flex;flex-direction:column}
      h2{font-size:14px;font-weight:500;margin-bottom:2px}
      .sub{font-size:12px;color:#9a9aa4;margin-bottom:10px}
      label{display:block;font-size:12px;color:#9a9aa4;margin:8px 0 3px}
      input,textarea{width:100%;padding:0 10px;border-radius:6px;border:1px solid #3a3a40;
            background:#2a2a30;color:#fff;font:13px/1.4 "Cascadia Mono",Consolas,monospace;outline:none}
      input{height:30px}
      textarea{height:72px;padding:8px 10px;resize:vertical}
      input:focus,textarea:focus{border-color:#5a5a66}
      .pair{display:flex;gap:10px}
      .pair>div{flex:1}
      details{margin-top:10px;border:1px solid #2f2f36;border-radius:8px;padding:6px 10px 10px;background:#232328}
      summary{cursor:pointer;font-size:12px;color:#b0b0ba;user-select:none;outline:none}
      summary:hover{color:#e8e8ea}
      .hint{font-size:11px;color:#7d7d88;margin-top:4px;line-height:1.5}
      .tipline{font-size:11px;color:#7d7d88;margin-top:8px;line-height:1.6}
      .grow{flex:1}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;flex-wrap:wrap}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;
             background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
      button:hover{filter:brightness(1.15)}
      .row .left{margin-right:auto}
    </style>
    <h2>模型设置</h2>
    <div class="sub" id="cur"></div>
    <label>接口地址（到 /v1 这一级，不要带 /chat/completions）</label>
    <input id="u" spellcheck="false">
    <label>模型名 <button type="button" id="list" style="height:22px;padding:0 8px;margin-left:6px;vertical-align:middle">拉取列表</button></label>
    <input id="m" spellcheck="false" list="models">
    <datalist id="models"></datalist>
    <label>API Key<span id="kHint"></span></label>
    <input id="k" type="password" spellcheck="false" autocomplete="off">
    <div class="pair">
      <div>
        <label>卡住超时（秒）</label>
        <input id="stall" type="number" min="1" max="120" step="1">
        <div class="hint">多久没新数据就中断；正常长回答不会被掐</div>
      </div>
      <div>
        <label>整轮上限（秒）</label>
        <input id="total" type="number" min="5" max="600" step="1">
        <div class="hint">整轮最久等多久；本地可调高</div>
      </div>
    </div>
    <details id="adv">
      <summary>高级 · extraBody（JSON，透传给服务方）</summary>
      <label style="margin-top:8px">例如 {"enable_thinking": false}</label>
      <textarea id="extra" spellcheck="false"></textarea>
      <div class="hint">空对象 {} = 不传额外字段。model / messages / stream 不会被这里顶掉。</div>
    </details>
    <div class="tipline" id="tip"></div>
    <div class="grow"></div>
    <div class="row">
      <button class="left" id="open">去申请 Key</button>
      <button id="test">测试连接</button>
      <button id="c">取消</button><button class="primary" id="s">保存</button>
    </div>
    <script>
      const U = ${JSON.stringify(String(llm.baseUrl || ''))};
      const M = ${JSON.stringify(String(llm.model || ''))};
      const K = ${JSON.stringify(String(llm.apiKey || ''))};
      const STALL = ${JSON.stringify(stallSec)};
      const TOTAL = ${JSON.stringify(totalSec)};
      const EXTRA = ${JSON.stringify(extraText)};
      const KEY_URL = ${JSON.stringify((p && p.keyUrl) || '')};
      const LOCAL = ${JSON.stringify(!!(p && p.local))};
      const LABEL = ${JSON.stringify(p ? p.label : '自定义')};
      document.getElementById('u').value = U;
      document.getElementById('m').value = M;
      document.getElementById('k').value = K;
      document.getElementById('stall').value = String(STALL);
      document.getElementById('total').value = String(TOTAL);
      document.getElementById('extra').value = EXTRA;
      document.getElementById('cur').textContent = LABEL + (LOCAL ? ' · 本机端点，Key 可留空' : '');
      document.getElementById('kHint').textContent = LOCAL ? '（可留空）' : '';
      document.getElementById('tip').textContent = LOCAL
        ? '本机端点不需要 API Key。改完可先「测试连接」，再保存。'
        : (KEY_URL ? '还没有 Key？左下角打开申请页，复制后粘贴。建议先测再存。' : '改完建议先「测试连接」再保存。');
      const openBtn = document.getElementById('open');
      if (!KEY_URL) openBtn.style.visibility = 'hidden';
      function fields() {
        return {
          baseUrl: document.getElementById('u').value.trim(),
          model: document.getElementById('m').value.trim(),
          apiKey: document.getElementById('k').value.trim(),
          stallSec: Number(document.getElementById('stall').value),
          totalSec: Number(document.getElementById('total').value),
          extraText: document.getElementById('extra').value
        };
      }
      document.getElementById('open').onclick = () => { window.__llmResult = { open: KEY_URL }; };
      document.getElementById('list').onclick = () => { window.__llmResult = { list: true, ...fields() }; };
      document.getElementById('test').onclick = () => { window.__llmResult = { test: true, ...fields() }; };
      document.getElementById('s').onclick = () => { window.__llmResult = { save: true, ...fields() }; };
      document.getElementById('c').onclick = () => { window.__llmResult = { cancel: true }; };
      window.__fillModels = (ids) => {
        const dl = document.getElementById('models');
        dl.innerHTML = '';
        for (const id of ids || []) {
          const o = document.createElement('option');
          o.value = id;
          dl.appendChild(o);
        }
      };
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') window.__llmResult = { cancel: true };
      });
      document.getElementById('u').focus();
    <\/script>`;

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());

    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__llmResult ?? undefined');
        if (v === undefined) return;
        if (v.open) {
          /* 只开申请页，**不关窗** —— 用户复制完 key 还要回来粘贴。 */
          await w.webContents.executeJavaScript('window.__llmResult = undefined');
          try { shell.openExternal(v.open); } catch { /* ignore */ }
          return;
        }
        if (v.list) {
          await w.webContents.executeJavaScript('window.__llmResult = undefined');
          const ids = await listLlmModels({ baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey });
          if (ids.length && !w.isDestroyed()) {
            await w.webContents.executeJavaScript(
              `window.__fillModels(${JSON.stringify(ids)})`
            );
          }
          return;
        }
        if (v.test) {
          await w.webContents.executeJavaScript('window.__llmResult = undefined');
          await testLlm({ baseUrl: v.baseUrl, model: v.model, apiKey: v.apiKey });
          return;
        }
        if (v.cancel) { finish(undefined); return; }
        if (v.save) {
          /* JSON 不合法就留在页里改 —— 关了再 toast 等于白填一遍。 */
          if (typeof v.extraText === 'string' && v.extraText.trim()) {
            try {
              const parsed = JSON.parse(v.extraText);
              if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                await w.webContents.executeJavaScript('window.__llmResult = undefined');
                toast('extraBody 必须是 JSON 对象，例如 {"enable_thinking": false}');
                return;
              }
            } catch (err) {
              await w.webContents.executeJavaScript('window.__llmResult = undefined');
              toast('extraBody JSON 解析失败：' + (err?.message || err));
              return;
            }
          }
          finish(v);
          return;
        }
        finish(v);
      } catch { /* 页面还在加载 */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

/* W47: 当前 TTS provider 的显示名 */
function ttsProviderLabel(tts) {
  const id = ttsCurrentProviderId(tts);
  const p = ttsProviderById(id);
  return p ? p.label : '自定义';
}

/* W47: 切到某条 TTS provider 预设 */
function applyTtsProvider(id) {
  const p = ttsProviderById(id);
  if (!p) return;
  if (p.custom) {
    patchConfig('tts', { provider: 'custom' });
    toast('已切到自定义：填地址与音色');
    promptTts();
    return;
  }
  const patch = ttsToPatch(p);
  /* ⚠️ openai/gsv 返回的是 wav 字节，只有 winrt 引擎走 deps.synth 拿它 ——
   *    所以切到这两个 provider 时必须同时把 engine 拉回 winrt。 */
  patch.engine = 'winrt';
  patchConfig('tts', patch);
  if (!ttsIsUsable(loadConfig().tts || {})) {
    toast(`已切到「${p.label}」，填个 key 就能出声`);
    promptTts();
    return;
  }
  toast(`已切到「${p.label}」`);
}

/* W47: 一键测试 —— 真发一句「你好」，能拿到音频字节就算通 */
async function ttsTestMenu() {
  const tts = loadConfig().tts || {};
  if (!ttsIsUsable(tts)) {
    toast('还没填 key：本地端点可以留空，云端必须填');
    return;
  }
  toast('正在试一句…');
  const r = await ttsTest(tts);
  if (r.ok) {
    toast(`语音已就绪（${r.bytes} 字节）`);
  } else {
    toast(`语音连不通：${String(r.error).slice(0, 80)}`);
  }
}

/* W47: TTS 语音接入设置对话框 */
function promptTts() {
  const cfg = loadConfig();
  const tts = cfg.tts || {};
  const pid = ttsCurrentProviderId(tts);
  const p = ttsProviderById(pid);
  const local = !!(p && p.local);

  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 480,
      height: 480,
      minWidth: 420,
      minHeight: 420,
      resizable: true,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{height:100%}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;
           padding:16px 20px 12px;user-select:none;display:flex;flex-direction:column}
      h2{font-size:14px;font-weight:500;margin-bottom:2px}
      .sub{font-size:12px;color:#9a9aa4;margin-bottom:10px}
      label{display:block;font-size:12px;color:#9a9aa4;margin:8px 0 3px}
      input{width:100%;padding:0 10px;border-radius:6px;border:1px solid #3a3a40;
            background:#2a2a30;color:#fff;font:13px/1.4 "Cascadia Mono",Consolas,monospace;
            outline:none;height:30px}
      input:focus{border-color:#5a5a66}
      .hint{font-size:11px;color:#7d7d88;margin-top:4px;line-height:1.5}
      .tipline{font-size:11px;color:#7d7d88;margin-top:8px;line-height:1.6}
      .grow{flex:1}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;
             background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
      button:hover{filter:brightness(1.15)}
    </style>
    <h2>语音接入</h2>
    <div class="sub" id="cur"></div>
    <label>接口地址（到 /v1 这一级，不要带 /audio/speech）</label>
    <input id="u" spellcheck="false">
    <label>模型名</label>
    <input id="m" spellcheck="false">
    <label>音色 <span id="vHint"></span></label>
    <input id="v" spellcheck="false">
    <label>API Key<span id="kHint"></span></label>
    <input id="k" type="password" spellcheck="false" autocomplete="off">
    <div class="hint">本地端点（127.0.0.1）不需要 Key。留空时使用 Windows 系统音色。</div>
    <div class="tipline" id="tip"></div>
    <div class="grow"></div>
    <div class="row">
      <button id="test">测试一句</button>
      <button id="c">取消</button><button class="primary" id="s">保存</button>
    </div>
    <script>
      const U = ${JSON.stringify(String(tts.baseUrl || ''))};
      const M = ${JSON.stringify(String(tts.model || ''))};
      const V = ${JSON.stringify(String(tts.voice || ''))};
      const K = ${JSON.stringify(String(tts.apiKey || ''))};
      const LABEL = ${JSON.stringify(p ? p.label : '自定义')};
      const LOCAL = ${JSON.stringify(local)};
      document.getElementById('u').value = U;
      document.getElementById('m').value = M;
      document.getElementById('v').value = V;
      document.getElementById('k').value = K;
      document.getElementById('cur').textContent = LABEL;
      document.getElementById('kHint').textContent = LOCAL ? '（可留空）' : '';
      document.getElementById('vHint').textContent = LOCAL ? '（网关侧映射）' : '';
      document.getElementById('tip').textContent = LOCAL
        ? '本机端点不需要 API Key。改完可先「测试一句」，再保存。'
        : '云端 TTS 需要 API Key。建议先「测试一句」再保存。';
      function fields() {
        return {
          baseUrl: document.getElementById('u').value.trim(),
          model: document.getElementById('m').value.trim(),
          voice: document.getElementById('v').value.trim(),
          apiKey: document.getElementById('k').value.trim()
        };
      }
      document.getElementById('test').onclick = () => { window.__ttsResult = { test: true, ...fields() }; };
      document.getElementById('s').onclick = () => { window.__ttsResult = { save: true, ...fields() }; };
      document.getElementById('c').onclick = () => { window.__ttsResult = { cancel: true }; };
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') window.__ttsResult = { cancel: true };
      });
      document.getElementById('u').focus();
    <\/script>`;

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());

    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__ttsResult ?? undefined');
        if (v === undefined) return;
        if (v.test) {
          await w.webContents.executeJavaScript('window.__ttsResult = undefined');
          await ttsTest({ baseUrl: v.baseUrl, model: v.model, voice: v.voice, apiKey: v.apiKey });
          return;
        }
        if (v.cancel) { finish(undefined); return; }
        if (v.save) {
          /* 保存：只改 provider 相关四键，不动其它 tts 设置。 */
          patchConfig('tts', {
            provider: 'openai',
            baseUrl: v.baseUrl,
            model: v.model,
            voice: v.voice,
            apiKey: v.apiKey,
            engine: 'winrt'
          });
          finish(undefined);
          toast('语音接入已保存');
          return;
        }
        finish(v);
      } catch { /* 页面还在加载 */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

async function promptLlm() {
  const next = await llmDialog();
  if (!next) return false;
  const before = loadConfig().llm || {};
  const { LLM_TIMEOUT } = require('./llm');
  let extraBody = before.extraBody && typeof before.extraBody === 'object' ? before.extraBody : {};
  if (typeof next.extraText === 'string' && next.extraText.trim()) {
    try {
      const parsed = JSON.parse(next.extraText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        toast('extraBody 必须是 JSON 对象，例如 {"enable_thinking": false}');
        return false;
      }
      extraBody = parsed;
    } catch (err) {
      toast('extraBody JSON 解析失败：' + (err?.message || err));
      return false;
    }
  } else {
    extraBody = {};
  }
  const stallMs = Math.min(LLM_TIMEOUT.stallMax, Math.max(LLM_TIMEOUT.stallMin,
    Math.round((Number(next.stallSec) || LLM_TIMEOUT.stallMs / 1000) * 1000)));
  const totalMs = Math.min(LLM_TIMEOUT.totalMax, Math.max(LLM_TIMEOUT.totalMin,
    Math.round((Number(next.totalSec) || LLM_TIMEOUT.totalMs / 1000) * 1000)));
  patchConfig('llm', {
    baseUrl: next.baseUrl || before.baseUrl,
    model: next.model || before.model,
    apiKey: next.apiKey,
    stallMs,
    totalMs,
    extraBody,
    activeProfile: ''   // 手改顶层 ≠ 仍挂在某一档上
  });
  toast('模型配置已保存');
  return true;
}

/* W2：记忆日记本 —— 浏览 / 删除（设置菜单入口）。
 * 列表在渲染层，删除时回调主进程 memory.deleteFact(id)（墓碑，不可逆）。
 * 对话框内联 HTML（同 promptTts 模式）。 */
function promptMemoryJournal() {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 460,
      height: 520,
      minWidth: 420,
      minHeight: 380,
      resizable: true,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{height:100%}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;
           padding:16px 20px 12px;user-select:none;display:flex;flex-direction:column}
      h2{font-size:14px;font-weight:500;margin-bottom:2px}
      .sub{font-size:12px;color:#9a9aa4;margin-bottom:10px}
      #list{flex:1;overflow-y:auto;border:1px solid #3a3a40;border-radius:6px;background:#26262b}
      .item{padding:10px 12px;border-bottom:1px solid #33333a;display:flex;align-items:flex-start;gap:10px}
      .item:last-child{border-bottom:none}
      .text{flex:1;min-width:0;word-break:break-all}
      .meta{font-size:11px;color:#7d7d88;margin-top:3px}
      button.del{height:26px;padding:0 10px;border-radius:6px;border:1px solid #5a3a3a;
                 background:#3a2222;color:#e8a8a8;font-size:12px;cursor:pointer;white-space:nowrap}
      button.del:hover{filter:brightness(1.2)}
      .empty{padding:24px 12px;text-align:center;color:#7d7d88;font-size:12px}
      .grow{flex:1}
      .row{display:flex;justify-content:flex-end;margin-top:12px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;
             background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button:hover{filter:brightness(1.15)}
    </style>
    <h2>记忆日记本</h2>
    <div class="sub" id="sub">-</div>
    <div id="list"></div>
    <div class="grow"></div>
    <div class="row">
      <button id="c">关闭</button>
    </div>
    <script>
      window.__memList = [];
      function clarityLabel(c) {
        if (c === 'fuzzy') return '记得不太清';
        if (c === 'trace') return '好像有过';
        return '清楚';
      }
      function kindLabel(k) {
        return { name: '称呼', pref: '偏好', boundary: '边界', relation: '约定', other: '其它' }[k] || '其它';
      }
      function fmtDate(ts) {
        if (!ts) return '-';
        const d = new Date(ts);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      }
      function render() {
        const list = document.getElementById('list');
        const sub = document.getElementById('sub');
        sub.textContent = window.__memList.length + ' 条记忆';
        if (!window.__memList.length) {
          list.innerHTML = '<div class="empty">还没有记住什么。</div>';
          return;
        }
        list.innerHTML = '';
        for (const f of window.__memList) {
          const row = document.createElement('div');
          row.className = 'item';
          const text = document.createElement('div');
          text.className = 'text';
          const prefix = (f.clarity === 'fuzzy' || f.clarity === 'trace')
            ? '【' + clarityLabel(f.clarity) + '】' : '';
          text.textContent = prefix + f.text;
          const meta = document.createElement('div');
          meta.className = 'meta';
          meta.textContent = kindLabel(f.kind) + ' · ' + fmtDate(f.updated || f.at)
            + (f.firstEncounter ? ' · 最初的日子' : '');
          text.appendChild(meta);
          const del = document.createElement('button');
          del.className = 'del';
          del.textContent = '删除';
          del.onclick = () => { window.__memDelete = f.id; };
          row.appendChild(text);
          row.appendChild(del);
          list.appendChild(row);
        }
      }
      document.getElementById('c').onclick = () => { window.__memResult = 'close'; };
      window.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') window.__memResult = 'close';
      });
      render();
    <\/script>`;

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());

    /* 首屏列表 */
    const injectList = () => w.webContents.executeJavaScript(
      'window.__memList = ' + JSON.stringify(memory.listFacts().map((f) => ({
        id: f.id, text: f.text, kind: f.kind,
        clarity: f.clarity || 'clear',
        updated: f.updated || f.at || 0,
        at: f.at || 0,
        firstEncounter: !!f.firstEncounter
      }))) + '; render();'
    ).catch(() => {});
    injectList();

    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript(
          'window.__memDelete ?? window.__memResult ?? undefined');
        if (v === undefined) return;
        if (v === 'close') { finish('close'); return; }
        /* v 是待删除的 fact id */
        if (typeof v === 'string') {
          const ok = memory.deleteFact(v);
          if (ok) {
            toast('已删除');
            await w.webContents.executeJavaScript('window.__memDelete = null;');
            injectList();
          } else {
            toast('这条已经不在了');
            await w.webContents.executeJavaScript('window.__memDelete = null;');
          }
        }
      } catch { /* 页面还在加载 */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

/* ============================================================
 *  多配置档（M6）—— 家里 Ollama / 公司云 一键切
 * ========================================================== */

function profileNameDialog(title, initial) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 360, height: 170, resizable: false, minimizable: false, maximizable: false,
      frame: false, alwaysOnTop: true, skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false, backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;padding:18px 20px;user-select:none}
      h2{font-size:13px;font-weight:500;margin-bottom:10px}
      input{width:100%;height:32px;padding:0 10px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#fff;font:14px/1 inherit;outline:none}
      input:focus{border-color:#5a5a66}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
      button:hover{filter:brightness(1.15)}
      .err{color:#ff7b7b;font-size:12px;height:15px;margin-top:6px}
    </style>
    <h2>${String(title || '配置档名称').replace(/</g, '')}</h2>
    <input id="n" maxlength="16" autofocus>
    <div class="err" id="e"></div>
    <div class="row"><button id="c">取消</button><button class="primary" id="k">确定</button></div>
    <script>
      const inp = document.getElementById('n'), err = document.getElementById('e');
      inp.value = ${JSON.stringify(String(initial || ''))};
      inp.focus(); inp.select();
      const send = (v) => { window.__pfResult = v; };
      const commit = () => {
        const v = inp.value.trim();
        if (!v) { err.textContent = '名字不能空'; return; }
        if (v.length > 16) { err.textContent = '最多 16 个字'; return; }
        send(v);
      };
      document.getElementById('k').onclick = commit;
      document.getElementById('c').onclick = () => send(null);
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') commit();
        if (ev.key === 'Escape') send(null);
      });
    <\/script>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());
    let finished = false;
    const finish = (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__pfResult ?? undefined');
        if (v !== undefined) finish(v === null ? undefined : v);
      } catch { /* loading */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

function switchLlmProfile(id) {
  const llm = loadConfig().llm || {};
  const snap = getProfile(llm, id);
  if (!snap) { toast('这档已经没了'); return false; }
  const next = applySnapToLlm(llm, snap);
  patchConfig('llm', next);
  toast(`已切到配置档「${snap.label}」`);
  return true;
}

async function saveLlmProfileAs() {
  const label = await profileNameDialog('给当前连接起个档名', '家里');
  if (label === undefined) return false;
  const llm = loadConfig().llm || {};
  const snap = saveCurrentAs(llm, label);
  const profiles = { ...(llm.profiles && typeof llm.profiles === 'object' ? llm.profiles : {}), [snap.id]: snap };
  patchConfig('llm', { profiles, activeProfile: snap.id });
  toast(`已存成配置档「${snap.label}」`);
  return true;
}

function overwriteActiveLlmProfile() {
  const llm = loadConfig().llm || {};
  const id = llm.activeProfile;
  if (!id || !getProfile(llm, id)) {
    toast('还没有选中的配置档，先「存成新档」');
    return false;
  }
  const snap = overwriteProfile(llm, id);
  const profiles = { ...(llm.profiles || {}), [snap.id]: snap };
  patchConfig('llm', { profiles, activeProfile: snap.id });
  toast(`已覆盖配置档「${snap.label}」`);
  return true;
}

function deleteActiveLlmProfile() {
  const llm = loadConfig().llm || {};
  const id = llm.activeProfile;
  const prev = getProfile(llm, id);
  if (!prev) { toast('没有可删的配置档'); return false; }
  const profiles = { ...(llm.profiles || {}) };
  delete profiles[id];
  patchConfig('llm', { profiles, activeProfile: '' });
  toast(`已删除配置档「${prev.label}」（顶层连接还在）`);
  return true;
}

function llmProfilesSubmenu(cfg) {
  const llm = cfg?.llm || {};
  const profiles = listProfiles(llm);
  const active = llm.activeProfile || '';
  const items = profiles.map((p) => ({
    label: p.label,
    type: 'radio',
    checked: active === p.id,
    click: () => { switchLlmProfile(p.id); }
  }));
  if (items.length) items.push({ type: 'separator' });
  items.push(
    { label: '把当前存成新档…', click: () => { saveLlmProfileAs(); } },
    { label: '用当前覆盖本档', enabled: !!getProfile(llm, active), click: () => { overwriteActiveLlmProfile(); } },
    { label: '删除本档', enabled: !!getProfile(llm, active), click: () => { deleteActiveLlmProfile(); } }
  );
  return items;
}

/* ============================================================
 *  OCEAN 性格微调（P3）
 * ========================================================== */

function syncOceanFromConfig(cfg = loadConfig()) {
  const d = deriveOcean(cfg?.personality);
  setPrideSoftMul(d.prideSoftMul);
}

function setOceanDim(key, value) {
  const cur = normalizeOcean(loadConfig().personality);
  if (!Object.prototype.hasOwnProperty.call(cur, key)) return;
  cur[key] = value;
  patchConfig('personality', cur);
  syncOceanFromConfig();
  const dim = OCEAN_DIMS.find((d) => d.key === key);
  const lv = nearestLevel(value);
  toast(`${dim ? dim.label : key} → ${lv.label}`);
}

function personalitySubmenu(cfg) {
  const p = normalizeOcean(cfg?.personality);
  return OCEAN_DIMS.map((dim) => {
    const cur = nearestLevel(p[dim.key]);
    return {
      label: `${dim.label}（${cur.label}）`,
      submenu: OCEAN_LEVELS.map((lv) => ({
        label: `${lv.label} · ${lv.id === 'low' ? dim.low : lv.id === 'high' ? dim.high : '适中'}`,
        type: 'radio',
        checked: cur.id === lv.id,
        click: () => { setOceanDim(dim.key, lv.value); }
      }))
    };
  });
}

/* ============================================================
 *  运行时切模型（X1）
 * ========================================================== */

const APPEARANCE_MODELS = [
  { id: 'hiyori', label: '日和' },
  { id: 'whale', label: '鲸鱼娘' },
  /* deepfish（大肥鱼）是第三方免费公开模型：禁二次分发 + 署名要求
   * （神宫凉子 / 霓虹猫）。不上架默认、仅作本地可选。 */
  { id: 'deepfish', label: '大肥鱼' }
];

function applyAppearanceModel(id) {
  const want = APPEARANCE_MODELS.some((m) => m.id === id) ? id : 'hiyori';
  const cur = loadConfig().appearance?.model || 'hiyori';
  if (cur === want) return;
  patchConfig('appearance', { model: want });
  syncAppearance();
  const row = APPEARANCE_MODELS.find((m) => m.id === want);
  if (want === 'whale') {
    toast('已切到鲸鱼娘 · 素材源自 VTube Studio 模型包（Andersen216 补 model3）');
  } else if (want === 'deepfish') {
    toast('已切到大肥鱼 · 素材源自神宫凉子 / 霓虹猫 免费公开模型，禁止二次分发');
  } else {
    toast(`已切到「${row ? row.label : want}」`);
  }
}

/* ============================================================
 *  角色设定（人设）对话框
 * ==========================================================
 *
 * 与改名对话框同一套路（BrowserWindow + data: URL + 轮询取值），
 * 区别是它要编辑 6 个槽位、能滚动、每项都有 placeholder 显示默认值。
 *
 * 设计要点：
 *   - **留空 = 用默认**。所以 placeholder 必须是"按当前名字渲染出来的
 *     默认文案"，用户一眼能看出留空之后会是什么。
 *   - 每项右上角给一个「恢复默认」的小按钮 —— 用户改了想退回去时，
 *     不必自己回忆原文，也不必清空后猜 placeholder。
 *   - 底部实时预览**最终拼出来的 system prompt**。人设是拼起来的，
 *     只看单格不知道整体长什么样；有了预览，"我把这句删了会不会影响
 *     表情"这类问题当场就能看出来。
 */
function personaDialog() {
  const cfg = loadConfig();
  const defaults = personaPartDefaults(cfg);   // 按当前名字渲染的默认文案
  const saved = cfg.personaParts || {};
  const customWhole = String(cfg.persona || '').trim();

  return new Promise((resolve) => {
    const W = 560, H = 620;
    const w = new BrowserWindow({
      width: W, height: H,
      minWidth: 460, minHeight: 420,
      resizable: true,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });

    /* 槽位数据以 JSON 注入页面。**在这里序列化而不是让页面去 require** ——
     * 页面没有 node 集成，拿不到 config.js，注入是唯一路径。 */
    const slots = PERSONA_PARTS.map((p) => ({
      key: p.key,
      label: p.label,
      hint: p.hint || '',
      tech: !!p.tech,
      def: defaults[p.key] || '',
      val: String(saved[p.key] ?? '')
    }));

    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.6 "Microsoft YaHei",system-ui,sans-serif;
           height:100vh;display:flex;flex-direction:column;user-select:none}
      header{padding:14px 20px 10px;flex:none}
      h2{font-size:14px;font-weight:500}
      .sub{font-size:12px;color:#9a9aa4;margin-top:4px;line-height:1.5}
      main{flex:1;overflow-y:auto;padding:0 20px 8px}
      .slot{margin-bottom:14px}
      .hd{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
      .lb{font-size:13px;font-weight:500}
      .ht{font-size:11px;color:#8a8a94}
      .tech{font-size:11px;color:#efb25a}
      .rst{margin-left:auto;font-size:11px;color:#8a8a94;cursor:pointer;flex:none}
      .rst:hover{color:#c8c8d0}
      textarea{width:100%;min-height:52px;padding:8px 10px;border-radius:6px;
               border:1px solid #3a3a40;background:#2a2a30;color:#fff;
               font:12px/1.6 "Microsoft YaHei",system-ui,sans-serif;resize:vertical;
               outline:none;user-select:text}
      textarea:focus{border-color:#5a5a66}
      textarea::placeholder{color:#5f5f68}
      .warn{padding:8px 10px;border-radius:6px;background:#3a2f1c;border:1px solid #5c4a22;
            font-size:12px;color:#efb25a;margin-bottom:14px;line-height:1.5}
      footer{flex:none;border-top:1px solid #303036;padding:12px 20px;
             display:flex;align-items:center;gap:10px}
      .pv{margin-left:auto;font-size:11px;color:#8a8a94;cursor:pointer}
      .pv:hover{color:#c8c8d0}
      button{height:30px;padding:0 16px;border-radius:6px;border:1px solid #3a3a40;
             background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
      button:hover{filter:brightness(1.15)}
      .err{color:#ff7b7b;font-size:12px}
      .pvbox{display:none;position:absolute;left:20px;right:20px;bottom:56px;max-height:60%;
             overflow-y:auto;background:#15151a;border:1px solid #3a3a40;border-radius:8px;
             padding:12px 14px;white-space:pre-wrap;font:12px/1.7 Consolas,monospace;
             color:#c8c8d0;user-select:text}
    </style>
    <header>
      <h2>角色设定</h2>
      <div class="sub">留空即用默认（灰字是默认内容）。改完下次对话生效。</div>
    </header>
    <main id="main"></main>
    <div class="pvbox" id="pvbox"></div>
    <footer>
      <span class="err" id="err"></span>
      <span class="pv" id="pv">预览最终设定</span>
      <button id="reset">全部恢复默认</button>
      <button id="c">取消</button>
      <button class="primary" id="k">保存</button>
    </footer>
    <script>
      const SLOTS = ${JSON.stringify(slots)};
      const customWhole = ${JSON.stringify(customWhole)};
      const main = document.getElementById('main');
      const err = document.getElementById('err');
      const pvbox = document.getElementById('pvbox');

      if (customWhole) {
        const d = document.createElement('div');
        d.className = 'warn';
        d.textContent = '当前生效的是一份「整段自定义人设」（配置文件里的 persona 字段），'
          + '它的优先级高于这里的各项，所以下面的修改暂时不会生效。'
          + '要改用分项设置，请先把配置文件里的 persona 清空。';
        main.appendChild(d);
      }

      const areas = {};
      for (const s of SLOTS) {
        const box = document.createElement('div');
        box.className = 'slot';
        const hd = document.createElement('div');
        hd.className = 'hd';
        const lb = document.createElement('span');
        lb.className = 'lb'; lb.textContent = s.label;
        hd.appendChild(lb);
        if (s.hint) {
          const ht = document.createElement('span');
          ht.className = 'ht'; ht.textContent = s.hint;
          hd.appendChild(ht);
        }
        if (s.tech) {
          const t = document.createElement('span');
          t.className = 'tech'; t.textContent = '⚠ 影响表情';
          hd.appendChild(t);
        }
        const rst = document.createElement('span');
        rst.className = 'rst'; rst.textContent = '恢复默认';
        rst.onclick = () => { ta.value = ''; sync(); };
        hd.appendChild(rst);
        box.appendChild(hd);

        const ta = document.createElement('textarea');
        ta.value = s.val;
        ta.placeholder = s.def;
        ta.dataset.key = s.key;
        ta.addEventListener('input', sync);
        areas[s.key] = ta;
        box.appendChild(ta);
        main.appendChild(box);
      }

      const readAll = () => {
        const out = {};
        for (const s of SLOTS) out[s.key] = areas[s.key].value.trim();
        return out;
      };

      const compose = () => {
        const v = readAll();
        return SLOTS.map(s => v[s.key] || s.def).filter(Boolean).join('\\n');
      };

      const sync = () => {
        if (pvbox.style.display === 'block') pvbox.textContent = compose();
        err.textContent = '';
      };

      document.getElementById('reset').onclick = () => {
        for (const s of SLOTS) areas[s.key].value = '';
        sync();
      };
      document.getElementById('pv').onclick = () => {
        const on = pvbox.style.display === 'block';
        pvbox.style.display = on ? 'none' : 'block';
        if (!on) pvbox.textContent = compose();
      };
      document.getElementById('c').onclick = () => { window.__personaResult = null; };
      document.getElementById('k').onclick = () => {
        window.__personaResult = readAll();
      };
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') window.__personaResult = null;
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) window.__personaResult = readAll();
      });
    <\/script>`;

    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());

    let finished = false;
    const finish = async (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      resolve(val);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__personaResult ?? undefined');
        if (v !== undefined) finish(v === null ? undefined : v);
      } catch { /* 页面还在加载 */ }
    }, 120);

    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(undefined); } });
  });
}

/* 设定入口。返回是否写盘了。
 *
 * 与改名不同：这里**允许"全部清空"**（= 回到全默认），所以不能用
 * "和旧值相同就不写"那套短路 —— 空对象也是一次有意义的编辑。 */
async function promptPersona() {
  const next = await personaDialog();
  if (next === undefined) return false;         // 取消

  /* 只保留非空的项。存空串和不存是等价的（都是"用默认"），
   * 但存了一堆空串会让 config.json 变脏、也让人误以为设过什么。 */
  const clean = {};
  for (const p of PERSONA_PARTS) {
    const v = String(next[p.key] ?? '').trim();
    if (v) clean[p.key] = v;
  }

  patchConfig(null, { personaParts: clean });

  const n = Object.keys(clean).length;
  toast(n ? `角色设定已更新（自定义 ${n} 项）` : '角色设定已恢复默认');
  return true;
}

/* 显示 / 隐藏。
 * ⚠️ 窗口的 show/hide 事件里会通知渲染层（见 createWindow），
 *    不需要在这里手动喊 —— 那正是"漏一处就有一处白烧 CPU"的来源。 */
function toggleVisible() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.setAlwaysOnTop(isOn('appearance', 'alwaysOnTop'), 'floating'); }
}

/* 窗口可见性变了，告诉渲染层。
 * 她在隐藏期间没必要满速渲染一个谁也看不见的模型 —— 这个窗口开了
 * backgroundThrottling:false，Chromium 不会因为"看不见"就降频。 */
function notifyVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('pet:visible', { visible: mainWindow.isVisible() }); } catch { /* ignore */ }
}

/* 把窗口钉到某块屏的右下角。
 * ⚠️ setBounds 必须显式带上宽高 —— 透明无边框窗口上用 setPosition 会触发
 *    DWM 边框重算、把窗口一点点撑大（详见 pet:drag-move 的长注释）。
 * 这个「右下角」公式原先在 4 个入口各写了一遍，统一到这里 + util.cornerPos。 */
function snapToCorner(win, workArea) {
  const p = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN);
  win.setBounds({ x: p.x, y: p.y, width: SIZE.w, height: SIZE.h });
}

function moveToCorner() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 「回到右下角」= 她自己那块屏的右下角，不是主屏的
  cancelAutoMotion();
  const p = cornerPos(currentDisplay().workArea, SIZE.w, SIZE.h, MARGIN);
  mainWindow.setBounds({ x: p.x, y: p.y, width: SIZE.w, height: SIZE.h });
  /* 这是他**明确指定**"你就待这儿" → 家跟着搬过去。
   * 不搬的话，她（或者用户）之后一动，回位又把她拉回启动位置，等于这个菜单项白点。 */
  setHome(p.x, p.y);
}

/* 渲染层算好的「窗口该多宽」（DIP）在这里落地。
 *
 * 只改宽度、**右边缘钉死不动**。人物恒居中（pet.js 的 layout），窗口在左边
 * 伸缩时她随窗口中心走 —— 而宽度如今只在换模型 / 改缩放 / 开关底座时变
 * （对话开关不动宽度），所以这条路径日常几乎不触发。
 * 用户看不见的只是窗口左边多出来 / 收回去的那块透明区域。
 *
 * ⚠️ 钉右边缘**不能**用「getBounds() 的右边缘 − 新宽度」反推。这个窗口在
 *    150% 缩放下外框比内容区宽 1px，而且非整数设备像素会向上取整（要 309
 *    实际给 310）；用外框反推会把上一次多出来的 1px 带进下一次 ——
 *    **每切一次漂 1px**，几十次之后窗口就飘出屏幕右边（实测 1687→1688→…→1692）。
 *    改成「拿内容区右边缘当固定目标 + 差多少补多少」后误差精确为 0、最多两轮。
 *    完整量测见 `debug/probe-setbounds.js`（改这块之前先跑它）。
 * ⚠️ 先 cancelMoveAnim：溜达 / 贴边是 24ms 一条 setInterval 在写 setBounds，
 *    它的目标 x 是按**旧宽度**算的，不收手就有两条 setBounds 打架，窗口右边
 *    会跟着动画抽一下（同「用户操作优先于自动动作」那条老规矩）。 */
function setStageWidth(want) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const prev = SIZE.w;
  const width = applyStageWidth(want);
  if (process.env.PET_WINSIZE_LOG) console.log('[winsize] setStageWidth', JSON.stringify({ want, prev, width, SIZE: { ...SIZE }, t: Date.now() }));
  if (!width || width === prev) return;
  cancelMoveAnim();

  const c0 = mainWindow.getContentBounds();
  const { workArea } = screen.getDisplayMatching(c0);
  // 目标右边缘 = 现在的内容区右边缘（不越出工作区）
  const targetRight = Math.min(c0.x + c0.width, workArea.x + workArea.width);

  let x = Math.round(targetRight - width);
  for (let i = 0; i < 3; i++) {
    mainWindow.setBounds({ x, y: c0.y, width, height: SIZE.h });
    const c = mainWindow.getContentBounds();
    const err = (c.x + c.width) - targetRight;
    if (err === 0) break;
    x -= err;                     // 用实测误差回补，下一轮就到位
  }

  /* 兜底：窗口本来贴着屏幕左边时，往左撑会顶出屏外 —— 宁可让右边多长一截，
   * 也不让窗口跑到屏幕外（跑出去就找不回来了）。 */
  const c = mainWindow.getContentBounds();
  if (c.x < workArea.x) {
    mainWindow.setBounds({ x: workArea.x, y: c.y, width, height: SIZE.h });
  }
}

const SCALE_STEP = LIMITS.scale.step;

function bumpScale(delta) {
  const cur = clampScale(loadConfig().appearance?.scale);
  const { min, max } = LIMITS.scale;
  const next = Math.round(clamp(cur + delta, min, max) * 100) / 100;
  patchConfig('appearance', { scale: next });
  syncAppearance();
  toast(`大小 ${Math.round(next * 100)}%`);
}

function resetScale() {
  patchConfig('appearance', { scale: 1 });
  syncAppearance();
  toast('大小已重置');
}

function setOpacity(v) {
  const o = clampOpacity(v);            // 落盘前就钳住，别把越界值写进配置
  patchConfig('appearance', { opacity: o });
  syncAppearance();
  toast(`不透明度 ${Math.round(o * 100)}%`);
}

/* 不透明度循环档：100 → 90 → 80 → 70 → 回到 100。
 * 泡泡菜单里只给一个「更透明」而不是列出四个档位 —— 省两个泡泡（Material 的
 * FAB menu 上限 6 项），而且"再点一次继续变淡"比挑数字更像在跟她玩。
 * ⚠️ 档位数组只有这一处（规矩 9），托盘里那个子菜单也读它。 */
const OPACITY_STEPS = [1, 0.9, 0.8, 0.7];
function cycleOpacity() {
  const cur = clampOpacity(loadConfig().appearance?.opacity);
  /* 浮点不能直接 === 比（0.9 落盘再读回来可能是 0.9000000001），找**最近**的档
   * 再往下走一格；认不出来（用户手改过配置）就从 100 重新开始。 */
  let idx = -1;
  let bd = Infinity;
  for (let i = 0; i < OPACITY_STEPS.length; i++) {
    const d = Math.abs(OPACITY_STEPS[i] - cur);
    if (d < bd) { bd = d; idx = i; }
  }
  const next = bd > 0.02 ? OPACITY_STEPS[1]
    : OPACITY_STEPS[(idx + 1) % OPACITY_STEPS.length];
  setOpacity(next);
}

function toggleTTS() {
  const on = isOn('tts', 'enabled');
  patchConfig('tts', { enabled: !on });
  toast(on ? '语音朗读已关' : '语音朗读已开');
}

/* 托盘菜单模板。每次打开都会重新构建（勾选状态不会自己刷新）。
 *
 * ⚠️ 顶层**最多四组**，别再往上平铺条目了 —— 之前是 20 个顶层项
 * （大小 / 不透明度 / 人物模型 / 6 个功能开关 / 番茄钟 / 定时提醒…全摆在外面），
 * 菜单长得要拉过半个屏幕，想找「退出」得先翻到底。
 *
 * 现在的结构：
 *   显示/隐藏 · 回到右下角
 *   ├─ 外观与形象（大小 / 不透明度 / 置顶）
 *   ├─ 互动与行为（总开关 + 8 项）
 *   ├─ 功能开关  （朗读 / 搭话 / 悬浮 / 提醒 / 语音）
 *   └─ 小工具    （番茄钟 / 定时提醒）
 *   设置 · 退出
 * 各组把**当前值写在组标题里**（缩放%、模型名），不展开也能一眼看到状态。
 */
/* 外观两项（大小 / 不透明度）。
 *
 * 托盘和「点角色」的右键菜单各要一份，之前是**复制粘贴**出来的两份 ——
 * 改了一处忘另一处就会出现「托盘里能调、右键里调不了」这种不一致，
 * 而且两边的标题写法都漂了（`大小（100%）` vs `大小 100%`）。
 * 现在共用一份，托盘与右键菜单的内容完全一致。
 *
 * 人物模型（X1）重新回来：日和 / 鲸鱼娘 radio；鲸鱼娘本地可切、不默认上架。 */
function appearanceSubmenu(cfg) {
  const scale = Math.round(clampScale(cfg.appearance?.scale) * 100);
  const opacity = clampOpacity(cfg.appearance?.opacity);
  const modelId = APPEARANCE_MODELS.some((m) => m.id === cfg.appearance?.model)
    ? cfg.appearance.model : 'hiyori';

  return [
    {
      label: `大小（${scale}%）`,
      submenu: [
        { label: '放大', click: () => bumpScale(SCALE_STEP) },
        { label: '缩小', click: () => bumpScale(-SCALE_STEP) },
        { type: 'separator' },
        { label: '重置 100%', click: resetScale }
      ]
    },
    {
      label: `不透明度（${Math.round(opacity * 100)}%）`,
      submenu: [1, 0.9, 0.8, 0.7].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(opacity - v) < 0.02,
        click: () => setOpacity(v)
      }))
    },
    {
      label: '人物模型',
      submenu: APPEARANCE_MODELS.map((m) => ({
        label: m.label,
        type: 'radio',
        checked: modelId === m.id,
        click: () => { applyAppearanceModel(m.id); }
      }))
    },
    {
      /* W8 = G14：OS 级 setContentProtection（截屏/录屏排除）。 */
      label: '截屏/录屏排除自己',
      type: 'checkbox',
      checked: !!cfg.appearance?.hideFromCapture,
      click: (item) => {
        patchConfig('appearance', { hideFromCapture: !!item.checked });
        applyHideFromCapture(!!item.checked);
        toast(item.checked ? '已对截屏/录屏隐藏（OS 排除）' : '已取消截屏隐藏');
      }
    },
    {
      label: '藏 3 秒方便截屏',
      click: () => { hidePetBriefly(3000); }
    },
    /* G18：鲸鱼娘表情槽预览（本地包体验）。仅当前模型是 whale 时出现。 */
    ...(modelId === 'whale' ? [{
      label: '表情槽预览',
      submenu: [
        '星星眼', '吐舌', '爱心眼', '心跳', '哭', '晕晕', '问号', '脸红', '花花', '呆眼'
      ].map((name) => ({
        label: name,
        click: () => {
          try {
            mainWindow?.webContents.send('pet:emote', { name, ms: 2800 });
          } catch { /* ignore */ }
        }
      }))
    }] : [])
  ];
}

function buildMenuTemplate() {
  const cfg = loadConfig();
  const login = app.getLoginItemSettings();
  const pomo = pomodoroStatus();

  /* W31：不可用入口置灰 + 行内写明原因（规矩 24：不许点了没反应）。 */
  const unavailable = (label, reason) => ({
    label: `${label}（${reason}）`,
    enabled: false
  });

  // 配置开关的统一构造：勾选 → 落盘 + 广播 + 重画菜单（patchConfig 全包了）
  const flag = (section, key, label, def = true) => ({
    label,
    type: 'checkbox',
    checked: isOn(section, key, def),
    click: (item) => {
      patchConfig(section, { [key]: item.checked });
      if (section === 'monitor') refreshStatsTimer();
      if (section === 'motion') refreshWanderConfig();
      if (section === 'appearance') { syncAppearance(); pushMoodSnapshot(); }
      // 关掉"全屏静默"要立刻退出静默状态，不能等她再切一次窗口
      if (section === 'quiet') refreshQuietWatcher();
      // 语音朗读：winrt 引擎要按需起停合成进程
      if (section === 'tts') refreshTTS();
      // 媒体感知：常驻采样进程同样要按需起停
      if (section === 'media') refreshMediaWatcher();
    }
  });

  /* ---------- 外观与形象 ---------- */
  const appearanceMenu = [
    ...appearanceSubmenu(cfg),
    { type: 'separator' },
    flag('appearance', 'jitter', '表情节奏抖动'),
    flag('appearance', 'emotionDecay', '情绪自然回落'),
    flag('appearance', 'mood', '心境会慢慢变'),
    /* 自带 exp3 表情。⚠️ 旧键 stickers 已并入 expressions，这里一次点把
     * **两个键写成同一个值** —— 否则老配置里 stickers:false 会在背后
     * 把表情关着，而勾选框显示"开"（看着像功能坏了）。 */
    {
      label: '情绪表情（自带 exp3）',
      type: 'checkbox',
      checked: isOn('appearance', 'expressions', true) && isOn('appearance', 'stickers', true),
      click: (item) => {
        patchConfig('appearance', { expressions: item.checked, stickers: item.checked });
        syncAppearance();
      }
    },
    flag('appearance', 'props', '闲置时摆弄道具'),
    flag('appearance', 'textureLod', '纹理降档（省显存）'),
    flag('appearance', 'alwaysOnTop', '窗口置顶'),
    flag('appearance', 'hoverFade', '悬停渐隐穿透（挡点击时）', false)
  ];

  /* ---------- 互动与行为 ---------- */
  const touchModeRaw = String(cfg?.interaction?.touchMode || 'normal').toLowerCase();
  const touchMode = touchModeRaw === 'quiet' || touchModeRaw === 'eager' ? touchModeRaw : 'normal';
  const touchModeLabel = touchMode === 'quiet' ? '安静' : touchMode === 'eager' ? '热情' : '平常';
  const touchModeItem = {
    label: `触摸响应（${touchModeLabel}）`,
    submenu: [
      {
        label: '安静 · 少反应',
        type: 'radio',
        checked: touchMode === 'quiet',
        click: () => {
          patchConfig('interaction', { touchMode: 'quiet' });
          toast('触摸：安静（连戳门槛更高、摸头更快挣脱）');
        }
      },
      {
        label: '平常 · Custom 基线',
        type: 'radio',
        checked: touchMode === 'normal',
        click: () => {
          patchConfig('interaction', { touchMode: 'normal' });
          toast('触摸：平常（单项开关仍可细调）');
        }
      },
      {
        label: '热情 · 多反应',
        type: 'radio',
        checked: touchMode === 'eager',
        click: () => {
          patchConfig('interaction', { touchMode: 'eager' });
          toast('触摸：热情（连戳更敏感、摸头更耐蹭）');
        }
      }
    ]
  };
  const interactMenu = [
    flag('motion', 'enabled', '互动总开关'),
    { type: 'separator' },
    flag('motion', 'edgeSnap', '拖动后贴屏幕边缘'),
    flag('motion', 'wander', '闲置时自己溜达'),
    flag('motion', 'positionPin', '位置钉（稀有换位）', false),
    flag('motion', 'returnOnActivity', '有人操作时回到原位'),
    flag('appearance', 'timeOfDayIdle', '时段闲置表情'),
    flag('chat', 'floatBubble', '对话气泡悬浮在头顶'),
    flag('interaction', 'rightMenu', '在角色身上右键出菜单'),
    touchModeItem,
    flag('interaction', 'headPat', '按住头顶会一直蹭'),
    flag('interaction', 'dragReact', '拖着走会挣扎'),
    flag('interaction', 'pokeReact', '连戳/过摸有递进反应'),
    flag('interaction', 'throw', '甩出去会抛物线飞行', false),
    flag('interaction', 'bounce', '落地会弹一下'),
    flag('interaction', 'swing', '拖着走会单摆摇晃', false),
    flag('interaction', 'flip', '往左飞时左右翻转', false),
    flag('interaction', 'squash', '点击/落地会 Q 弹'),
    flag('interaction', 'workState', '对话时脸上跟着干活')
  ];

  /* ---------- 功能开关 ---------- */
  /* 静默那项把**当前状态**写进标签：这个功能生效时界面上什么都看不到
   * （她本来就是安静的），"到底有没有在静默"只能从菜单里读出来。 */
  const quietItem = flag('quiet', 'enabled', '全屏时自动静默');
  if (quiet) quietItem.label += '（静默中）';
  const lowPowerItem = flag('quiet', 'lowPower', '低配降帧（省电）', false);

  /* 语音朗读：开关和引擎两件事收进一个子菜单，当前值写进标题 ——
   * 引擎切换只影响"说话时嘴怎么动"，单独平铺一行会让功能组变长
   * （规矩：两个菜单都要短），但埋在设置里又找不到。 */
  const ttsEngine = (cfg?.tts?.engine ?? 'winrt') === 'system' ? 'system' : 'winrt';
  const ttsOn = isOn('tts', 'enabled', false);
  const ttsItem = {
    label: `语音朗读${ttsOn ? `（${ttsEngine === 'winrt' ? '真口型' : '系统音色'}）` : '（已关闭）'}`,
    submenu: [
      flag('tts', 'enabled', '启用语音朗读'),
      flag('tts', 'emotionVoice', '情绪分轨语速/音调', true),
      { type: 'separator' },
      /* W47: 语音接入（provider 预设 + 一键测试） */
      {
        label: `语音接入（${ttsProviderLabel(cfg.tts || {})}）`,
        submenu: [
          ...TTS_PROVIDERS.filter((p) => p.featured).map((p) => ({
            label: p.label + (ttsCurrentProviderId(cfg.tts) === p.id ? ' ✓' : ''),
            type: 'radio',
            checked: ttsCurrentProviderId(cfg.tts) === p.id,
            click: () => applyTtsProvider(p.id)
          })),
          { type: 'separator' },
          { label: '设置…', click: () => { promptTts(); } },
          ttsIsUsable(cfg.tts || {})
            ? { label: '测试一句', click: () => { ttsTestMenu(); } }
            : unavailable('测试一句', '没 key / 未配端点')
        ]
      },
      { type: 'separator' },
      process.platform === 'win32'
        ? {
            label: 'Windows 合成（嘴跟着声音动）',
            type: 'radio',
            checked: ttsEngine === 'winrt',
            click: () => {
              patchConfig('tts', { engine: 'winrt' });
              refreshTTS();
              toast('已切到 Windows 合成：说话时嘴跟着声音动');
            }
          }
        : unavailable('Windows 合成', '仅 Windows'),
      {
        label: '系统内置音色（开口最快）',
        type: 'radio',
        checked: ttsEngine === 'system' || process.platform !== 'win32',
        click: () => {
          patchConfig('tts', { engine: 'system' });
          refreshTTS();
          toast('已切到系统内置音色');
        }
      }
    ]
  };

  const presenceMode = normalizeMode(cfg?.presence?.mode);
  const presenceItem = {
    label: `状态（${PRESENCE_MODES.find((m) => m.id === presenceMode)?.label || '日常'}）`,
    submenu: PRESENCE_MODES.map((m) => ({
      label: m.id === 'companion' ? '陪伴（忽略安静时段）'
        : m.id === 'focus' ? '勿扰（不主动搭话）'
        : '日常（走安静时段）',
      type: 'radio',
      checked: presenceMode === m.id,
      click: () => {
        patchConfig('presence', { mode: m.id });
        toast(m.id === 'focus' ? '已切到勿扰：她不会主动开口'
          : m.id === 'companion' ? '已切到陪伴：安静时段先放一边'
          : '已切到日常');
      }
    }))
  };

  const chatMode = cfg.chat?.mode === 'work' ? 'work' : 'companion';
  const modeItem = {
    label: `对话模态（${chatMode === 'work' ? '专业' : '陪伴'}）`,
    submenu: [
      {
        label: '陪伴',
        type: 'radio',
        checked: chatMode === 'companion',
        click: () => { patchConfig('chat', { mode: 'companion' }); toast('已切到陪伴语气'); }
      },
      {
        label: '专业',
        type: 'radio',
        checked: chatMode === 'work',
        click: () => { patchConfig('chat', { mode: 'work' }); toast('已切到专业语气'); }
      }
    ]
  };

  const featureMenu = [
    ttsItem,
    flag('proactive', 'enabled', '主动搭话'),
    flag('proactive', 'edgeCues', '边缘线索（电量/CPU/切应用）', false),
    flag('chat', 'showThink', '内心 OS（[think:]）', true),
    {
      label: `人设护栏（${guardLevel(cfg.chat?.personaGuard)}）`,
      submenu: ['off', 'med', 'strict'].map((lv) => ({
        label: lv === 'off' ? '关' : lv === 'med' ? '中（禁客服腔）' : '严（+伪造角色标记）',
        type: 'radio',
        checked: guardLevel(cfg.chat?.personaGuard) === lv,
        click: () => { patchConfig('chat', { personaGuard: lv }); toast(`人设护栏：${lv}`); }
      }))
    },
    modeItem,
    flag('rhythm', 'enabled', '作息学习', true),
    flag('rhythm', 'gateProactive', '作息门控主动搭话', false),
    presenceItem,
    quietItem,
    lowPowerItem,
    flag('memory', 'enabled', '长期记忆（记住关于你的事）'),
    {
      label: '记忆会慢慢变淡',
      type: 'checkbox',
      checked: cfg.memory?.decay !== false,
      click: (item) => {
        patchConfig('memory', { decay: !!item.checked });
        toast(item.checked ? '记忆会慢慢变淡' : '记忆不再变淡');
      }
    },
    {
      /* W2：夜间矛盾降权 —— 安静时段写入的事实降一档清晰度（带前缀标注，不删）。 */
      label: '安静时段写入降一档',
      type: 'checkbox',
      checked: cfg.memory?.quietPenalty !== false,
      click: (item) => {
        patchConfig('memory', { quietPenalty: !!item.checked });
        toast(item.checked ? '安静时段写入会先降一档' : '安静时段写入不再降档');
      }
    },
    {
      label: '到期遗忘正文（默认关）',
      type: 'checkbox',
      checked: !!cfg.memory?.forget?.enabled,
      click: (item) => {
        const forget = { ...(cfg.memory?.forget || {}), enabled: !!item.checked };
        patchConfig('memory', { forget });
        toast(item.checked ? '已开启到期遗忘（不可逆）' : '已关闭到期遗忘');
      }
    },
    {
      label: 'MCP 工具（默认关）',
      submenu: [
        {
          label: '启用 MCP 骨架',
          type: 'checkbox',
          checked: !!cfg.mcp?.enabled,
          click: (item) => {
            patchConfig('mcp', { enabled: !!item.checked });
            toast(item.checked ? 'MCP 骨架已开（尚无 server）' : 'MCP 已关');
          }
        },
        { type: 'separator' },
        ...(mcp.listServers().length
          ? mcp.listServers().map((s) => ({ label: s.name || s.id, enabled: false }))
          : [{ label: '（未配置 server）', enabled: false }])
      ]
    },
    flag('monitor', 'floating', '系统状态悬浮显示', false),
    flag('reminder', 'enabled', '定时提醒'),
    process.platform === 'win32'
      ? flag('asr', 'enabled', '语音输入（离线识别）', false)
      : unavailable('语音输入', '仅 Windows'),
    process.platform === 'win32'
      ? flag('media', 'enabled', '媒体感知（知道你在听什么）', false)
      : unavailable('媒体感知', '仅 Windows'),
    {
      label: '全局热键（默认关）',
      type: 'checkbox',
      checked: !!cfg.hotkeys?.enabled,
      click: (item) => {
        patchConfig('hotkeys', { enabled: !!item.checked });
        toast(item.checked
          ? '热键已开：显隐 / 停朗读（见配置 hotkeys）'
          : '热键已关');
      }
    },
    {
      label: '新屏接入时跳过去',
      type: 'checkbox',
      checked: !!cfg.motion?.multiScreenHop,
      click: (item) => {
        patchConfig('motion', { multiScreenHop: !!item.checked });
        toast(item.checked ? '新屏接入会 hop 过去' : '新屏接入不再 hop');
      }
    }
  ];

  /* ---------- 小工具 ---------- */
  /* 定时提醒默认关（见 config.js 的默认值取舍），所以这一组必须按开关分两种样子：
   * ⚠️ 关着的时候原来那几条「N 分钟后提醒我」点了**什么都不会发生** ——
   *    addReminder() 读到开关关着就直接 return null，而旧写法照样弹一句
   *    "5 分钟后提醒你"，连提示都在骗人。现在关掉时整组收成一条
   *    「启用定时提醒」，开启后才是正常的几条。
   * ⚠️ 番茄钟不受这个开关影响：它由用户点「开始」才计时，本身就是明确意图。 */
  const reminderOn = isOn('reminder', 'enabled', false);
  const reminderItem = reminderOn
    ? {
        label: '定时提醒',
        submenu: [
          { label: '5 分钟后提醒我', click: () => { if (addReminder(5, '5 分钟到了。')) toast('5 分钟后提醒你'); } },
          { label: '15 分钟后提醒我', click: () => { if (addReminder(15, '15 分钟到了。')) toast('15 分钟后提醒你'); } },
          { label: '25 分钟后提醒我', click: () => { if (addReminder(25, '25 分钟到了。')) toast('25 分钟后提醒你'); } },
          { type: 'separator' },
          { label: '清除全部提醒', click: () => { clearReminders(); toast('提醒已清空'); } }
        ]
      }
    : {
        label: '定时提醒（已关闭）',
        submenu: [
          {
            label: '启用定时提醒',
            click: () => { patchConfig('reminder', { enabled: true }); toast('定时提醒已开启'); }
          }
        ]
      };

  /* G23 / W1：看一眼。永久开关 OR 限时授权；关着时托盘给启用 + 限时档。 */
  const glanceOn = isOn('interaction', 'glance', false);
  const grantSnap = grantSnapshot();
  const glanceAllowed = isGlanceAllowed(glanceOn);
  const grantLeftMin = Math.max(1, Math.ceil(grantSnap.remainingMs / 60000));
  const runGlanceClick = () => {
    (async () => {
      try {
        bubble.beginStream();
        const r = await runGlance({});
        if (r?.ok) bubble.endStream(); else bubble.abortStream();
      } catch (err) {
        bubble.abortStream();
        toast('看屏失败：' + (err?.message || err));
      }
    })();
  };
  const glanceGrantSub = [
    ...GRANT_PRESETS_MS.map((p) => ({
      label: `限时授权 ${p.label}`,
      click: () => {
        grantFor(p.ms);
        toast(`看屏授权 ${p.label}，到期自动收回`);
        refreshTrayMenu();
      }
    })),
    {
      label: grantSnap.active ? `收回授权（剩约 ${grantLeftMin} 分）` : '收回授权',
      enabled: grantSnap.active,
      click: () => {
        revokeGlanceGrant('manual');
        toast('看屏授权已收回');
        refreshTrayMenu();
      }
    }
  ];
  const glanceItem = glanceAllowed
    ? {
        label: grantSnap.active && !glanceOn
          ? `看一眼屏幕（限时 · 剩 ${grantLeftMin} 分）`
          : '看一眼屏幕',
        click: runGlanceClick
      }
    : {
        label: '看一眼屏幕（已关闭）',
        submenu: [
          {
            label: '永久启用（隐私：会截屏给模型）',
            click: () => {
              patchConfig('interaction', { glance: true });
              toast('已开启「看一眼」· 也可说「看看」');
            }
          },
          { type: 'separator' },
          ...glanceGrantSub
        ]
      };

  const toolsMenu = [
    {
      label: pomo ? `番茄钟（${pomo.phase === 'work' ? '专注' : '休息'}中 · 剩 ${Math.ceil(pomo.leftSec / 60)} 分）` : '番茄钟',
      submenu: [
        { label: '开始 25 + 5', click: () => { startPomodoro(25, 5); toast('番茄钟开始'); } },
        { label: '开始 45 + 10', click: () => { startPomodoro(45, 10); toast('番茄钟开始'); } },
        { type: 'separator' },
        { label: '停止', enabled: !!pomo, click: () => { stopPomodoro(); toast('番茄钟已停'); } }
      ]
    },
    reminderItem,
    glanceItem,
    glanceOn || grantSnap.active
      ? {
          label: '看屏授权',
          submenu: [
            flag('interaction', 'glance', '永久允许看一眼屏幕', false),
            { type: 'separator' },
            ...glanceGrantSub
          ]
        }
      : null,
    flag('agentLink', 'enabled', 'Agent 事件联动（只读 JSONL）', false)
  ].filter(Boolean);

  /* ---------- 设置 ---------- */
  /* 更新做成一个子菜单而不是平铺两项：设置组本来就长，再往上加会挤到
   * 「清空聊天记录」。把状态写进组标题，不展开也能看到"有新版 / 正在下载"。 */
  const upd = updaterStatus();
  const updateLabel =
    upd.state === 'downloading' ? `更新（下载中 ${upd.progress}%）` :
    upd.state === 'ready' ? `更新（${upd.version} 待安装）` :
    upd.version ? `更新（有新版 ${upd.version}）` : '更新';

  /* 模型接入收进「设置」子菜单 —— 顶层四组的限制（规矩 5）不能为了它破。
   * 组标题直接写出「现在哪家 + 有没有 key」，不展开也能判断她为什么只会背稿。 */
  const wbModels = readWorkBuddyModels();
  const llmReady = isUsable(cfg.llm);
  /* 打勾的那一条要按 currentProviderId 算（旧配置没有 provider 字段，
   * 按 baseUrl 反查）—— 否则老用户打开菜单会一条都不勾。 */
  const activeProvider = currentProviderId(cfg.llm);
  /* M8：顶层只露 featured；其余收「更多…」。当前选中若在更多里，
   * 顶层 radio 不会勾中 —— 靠「更多」子项的 checked 表达。 */
  const green = isTestGreen(cfg.llm);
  const requireTested = !!cfg.llm?.requireTested;
  const providerItem = (p) => ({
    label: p.label + (activeProvider === p.id && green ? ' ✓' : ''),
    type: 'radio',
    checked: activeProvider === p.id,
    click: () => applyLlmProvider(p.id)
  });
  const more = moreProviders();
  const llmMenu = {
    label: `模型接入（${llmLabelText(cfg)}${green ? ' ✓' : llmReady ? (requireTested ? ' · 未测' : '') : ' · 没 key'}）`,
    submenu: [
      ...featuredProviders().map(providerItem),
      ...(more.length
        ? [{
            label: '更多…',
            submenu: more.map(providerItem)
          }]
        : []),
      { type: 'separator' },
      /* WorkBuddy 里配好的自定义模型：为什么值得接 —— 同一套 key 复用到桌宠，
       * 不用为"再填一遍"回去翻控制台。文件不存在/为空时给出可操作提示。 */
      wbModels.list.length
        ? {
            label: `从 WorkBuddy 导入（${wbModels.list.length}）`,
            submenu: wbModels.list.slice(0, 12).map((entry) => ({
              label: entry.label,
              click: () => importWorkBuddyModel(entry)
            }))
          }
        : {
            label: '从 WorkBuddy 导入（models.json 里没有模型）',
            enabled: false
          },
      { type: 'separator' },
      {
        label: `配置档${listProfiles(cfg.llm).length ? `（${listProfiles(cfg.llm).length}）` : ''}`,
        submenu: llmProfilesSubmenu(cfg)
      },
      { label: '模型设置…', click: () => { promptLlm(); } },
      llmReady
        ? { label: green ? '测试连接 ✓' : '测试连接', click: () => { testLlm(); } }
        : unavailable('测试连接', '没 key / 未配端点'),
      {
        label: '真测一句才算就绪',
        type: 'checkbox',
        checked: requireTested,
        click: (item) => {
          patchConfig('llm', { requireTested: !!item.checked });
          toast(item.checked ? '未测通时走离线话术' : '有 key/本机即可聊（不必先测）');
        }
      },
      {
        label: '检测本机端点…',
        click: async () => {
          toast('正在侦测 Ollama / LM Studio…');
          try {
            const results = await probeLocalEndpoints();
            const sum = summarizeProbes(results);
            toast(sum.toast);
            for (const line of sum.lines.slice(0, 2)) {
              console.log('[local-guide]', line);
            }
            const hit = results.find((r) => r.ok);
            if (hit) {
              /* 探测到了就一键填预设（不动已有 apiKey）；本地超时用 M9 默认。 */
              patchConfig('llm', {
                provider: hit.id === 'ollama' ? 'ollama' : 'lmstudio',
                baseUrl: hit.baseUrl,
                model: hit.model,
                activeProfile: '',
                stallMs: TIMEOUT_LOCAL.stallMs,
                totalMs: TIMEOUT_LOCAL.totalMs
              });
            }
          } catch (err) {
            toast('检测失败：' + (err?.message || err));
          }
        }
      }
    ]
  };

  const settingsMenu = [
    // 当前名字写进标签里，不用点进去就知道现在叫什么
    { label: `重命名（当前：${resolveName(cfg)}）`, click: () => { promptRename(); } },
    {
      label: `角色设定${personaStateLabel(cfg)}`,
      submenu: [
        { label: '自定义编辑…', click: () => { promptPersona(); } },
        { label: '导入角色卡…', click: () => { importCharacterCard(); } },
        { label: '视角蒸馏…', click: () => { promptPersonaDistill(); } },
        { type: 'separator' },
        ...PERSONA_PRESETS.map((p) => ({
          label: p.label,
          click: () => { applyPersonaPreset(p.id); }
        })),
        { type: 'separator' },
        {
          label: '性格微调',
          submenu: personalitySubmenu(cfg)
        },
        { type: 'separator' },
        oneshotSubmenu()
      ]
    },
    llmMenu,
    { type: 'separator' },
    {
      label: updateLabel,
      submenu: [
        { label: '检查更新', click: () => { checkForUpdates({ manual: true }); } },
        { type: 'separator' },
        flag('update', 'enabled', '自动检查更新')
      ]
    },
    { type: 'separator' },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: !!login.openAtLogin,
      click: (item) => {
        // 开发环境下 execPath 是 electron.exe，得把项目目录当参数带上，
        // 否则开机只会启动一个空白 Electron
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          /* 这个参数只有开发时才需要：那时 execPath 是 electron.exe，
           * 得显式告诉它待启动的是哪个项目。打包后 execPath 就是应用自己的
           * exe，再塞一个目录进去会被 Electron 当成"要打开的文件路径"，
           * 结果是开机自启静默失效（或弹一个找不到文件的错误）。 */
          args: app.isPackaged ? [] : [PROJECT_ROOT]
        });
        refreshTrayMenu();
      }
    },
    { type: 'separator' },
    {
      label: '打开配置文件',
      click: () => {
        const p = getConfigPath();
        if (!fs.existsSync(p)) saveConfig(loadConfig());
        shell.openPath(p);
      }
    },
    { label: '打开配置目录', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    (() => {
      const histPath = path.join(app.getPath('userData'), 'chat-history.json');
      let hasHist = false;
      try {
        hasHist = fs.existsSync(histPath) && fs.statSync(histPath).size > 2;
      } catch { /* ignore */ }
      return hasHist
        ? {
            label: '导出对话',
            submenu: [
              { label: 'Markdown…', click: () => { exportChatHistory('md'); } },
              { label: 'JSON…', click: () => { exportChatHistory('json'); } }
            ]
          }
        : unavailable('导出对话', '暂无记录');
    })(),
    {
      label: '清空聊天记录',
      click: () => {
        try {
          fs.rmSync(path.join(app.getPath('userData'), 'chat-history.json'), { force: true });
        } catch { /* ignore */ }
        mainWindow?.webContents.send('history:cleared');
      }
    },
    {
      label: '清空长期记忆',
      click: () => {
        try { memory.clearFacts(); } catch { /* ignore */ }
        toast('长期记忆已清空');
      }
    },
    {
      /* W2：记忆日记本（浏览/删）。只读渲染层用 listFacts()。 */
      label: '记忆日记本…',
      click: () => { promptMemoryJournal(); }
    }
  ];

  // 顶层只保留这些 —— 平铺项一律进上面的组
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleVisible },
    { label: '回到右下角', click: moveToCorner },

    { type: 'separator' },
    { label: '外观与形象', submenu: appearanceMenu },
    { label: '互动与行为', submenu: interactMenu },
    { label: '功能开关', submenu: featureMenu },
    { label: '小工具', submenu: toolsMenu },

    { type: 'separator' },
    { label: '设置', submenu: settingsMenu },

    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]);
}


/* ============================================================
 *  本地意图：系统状态 / 定时提醒 / 番茄钟
 * ==========================================================
 *
 * 这几类请求**根本不需要大模型** —— 答案本地就有，而且没配 API Key 时
 * 也必须能用（离线模式本来是"只会背稿子"，加上这些立刻就能干实事了）。
 * 所以在这里先拦一道，命中就地回答；没命中才交给 streamLLM。
 */

/* ⚠️ 温度这一类必须和主体绑在一起写（"电脑热不热"、"显卡温度多少"），
 * 【不能】光留一个「温度」—— 否则"明天温度多少"这种问天气的会被拦下来
 * 用显卡温度回答，答非所问。加 i 是为了 CPU / GPU 大写写法也能命中。 */
const RE_STATS = /(\bcpu\b|\bgpu\b|处理器|显卡|内存|占用率|磁盘|硬盘|c\s*盘|网速|带宽|电量|电池|系统状态|电脑.{0,4}(怎么样|状态|还好)|(cpu|gpu|显卡|电脑|机器|机子).{0,4}(温度|发热|烫|热))/i;
const RE_POMO_STOP = /(停|关掉|关|结束|取消).{0,4}(番茄|专注)/;
const RE_POMO_START = /(开始|来个|开个|启动|进入).{0,4}(番茄|专注)/;
const RE_REMIND_CLEAR = /(取消|清除|清空).{0,6}(提醒|闹钟)/;

/* 时间解析：中英文数字都认，「25分钟后提醒我喝水」和
 * 「提醒我 25 分钟后喝水」两种语序都支持。 */
function parseReminder(text) {
  /* 一条正则就够，两种语序它都吃 —— `(\d+)` 前面没有 ^ 锚定，
   * 「提醒我 」「提醒一下我 」这类前缀是被允许跳过的（实测：
   * 「提醒一下我 1 小时后取快递」→ ["1","小时","取快递"]）。
   * 这里原本还挂过一条专门处理「提醒我 N 分钟后」的 m2 正则，
   * 实测永远轮不到它命中，是死代码，已删。 */
  const m = text.match(/(\d+(?:\.\d+)?)\s*(个?小时|分钟|分|钟头)\s*(?:之后|后)?\s*(?:提醒我|提醒一下|叫我|提醒)?\s*(.*)$/);
  if (!m) return null;

  let mins = parseFloat(m[1]);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  if (/小时|钟头/.test(m[2])) mins *= 60;
  if (mins < 0.05) mins = 0.05;

  const what = String(m[3] || '')
    .replace(/^[，,。.!！?？\s]+/, '')
    .replace(/[。.\s]+$/, '')
    .trim();
  return { minutes: Math.round(mins * 100) / 100, what: what.slice(0, 60) };
}

function fmtMinutes(mins) {
  if (mins >= 60) {
    const h = mins / 60;
    return `${Number.isInteger(h) ? h : h.toFixed(1)} 小时`;
  }
  if (mins >= 1) return `${Number.isInteger(mins) ? mins : mins.toFixed(1)} 分钟`;
  return `${Math.round(mins * 60)} 秒`;
}

/* ============================================================
 *  心境层（mood.js）的编排：什么时候走一步、什么时候落盘、什么时候推快照。
 *
 *  · tick 自调度（setTimeout 链，规矩 16）：10 秒一步漂移；每满 60 秒落一次盘。
 *    没有异步等待，但同样不用 setInterval —— 停表只清一个句柄。
 *  · 快照推给渲染层（表情偏置的权重在里面）；事件后即时推一次，
 *    轴走得慢，10 秒粒度对表情完全够。
 *  · 开关（appearance.mood）关掉时：不漂移、不推、prompt 不注入 ——
 *    渲染层判据 `cfg?.appearance?.mood !== false` 兜底，行为与从前逐位一致。
 * ========================================================== */
const moodEngine = createMoodEngine();
const temperament = createTemperament();
const moodFile = () => path.join(app.getPath('userData'), 'mood.json');
const temperamentFile = () => path.join(app.getPath('userData'), 'temperament.json');
let moodTimer = null;
let moodSaveAt = 0;
let moodDragging = false;   // drag-move 的边沿判定用（帧级事件 → 一次性事件）

function loadTemperament() {
  try {
    const raw = JSON.parse(fs.readFileSync(temperamentFile(), 'utf8'));
    temperament.hydrate(raw);
    setRateMul(temperament.rateMul());
  } catch { /* first run */ }
}

function saveTemperament() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(temperamentFile(), JSON.stringify(temperament.snapshot()), 'utf8');
  } catch (err) {
    console.warn('[temperament] save failed', err?.message || err);
  }
}

/* X6 作息直方图 */
const rhythmFile = () => path.join(app.getPath('userData'), 'rhythm.json');
let rhythmState = rhythm.empty();

function loadRhythm() {
  try {
    rhythmState = rhythm.hydrate(JSON.parse(fs.readFileSync(rhythmFile(), 'utf8')));
  } catch {
    rhythmState = rhythm.empty();
  }
}

function saveRhythm() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(rhythmFile(), JSON.stringify(rhythm.snapshot(rhythmState)), 'utf8');
  } catch (err) {
    console.warn('[rhythm] save failed', err?.message || err);
  }
}

function recordRhythmHit() {
  if (!isOn('rhythm', 'enabled', true)) return;
  rhythmState = rhythm.record(rhythmState);
  saveRhythm();
}

/* X8：PET_SNAPSHOT=memory 时把召回解释打到日志（零副作用）。 */
function dumpMemorySnapshot(query = '') {
  const cfg = loadConfig();
  const facts = memory.recall(query || '记得', {
    injectMax: cfg.memory?.injectMax,
    forceExpand: true
  });
  const line = memory.formatMemoryLine(facts, cfg.memory?.injectChars);
  const rows = facts.map((f) => ({
    kind: f.kind,
    clarity: f.clarity || 'clear',
    importance: f.importance,
    hits: f.hits,
    recallCount: f.recallCount,
    text: String(f.text || '').slice(0, 40)
  }));
  console.log('[memory-snapshot]', JSON.stringify({
    query: query || '(expand)',
    count: rows.length,
    line: line.slice(0, 200),
    facts: rows
  }, null, 2));
  return { facts: rows, line };
}

function pushMoodSnapshot() {
  if (!isOn('appearance', 'mood')) return;
  try { mainWindow?.webContents?.send?.('mood:snapshot', moodEngine.snapshot()); } catch { /* ignore */ }
}

function moodTick() {
  moodTimer = null;
  if (isOn('appearance', 'mood')) {
    moodEngine.step(10, -1);
    /* P5：日均采样 → 气质乘子 */
    temperament.observe(moodEngine.axes);
    setRateMul(temperament.rateMul());
    pushMoodSnapshot();
    const now = Date.now();
    if (now - moodSaveAt >= 60 * 1000) {
      moodSaveAt = now;
      moodEngine.save(moodFile());
      saveTemperament();
    }
  }
  moodTimer = setTimeout(moodTick, 10 * 1000);
}

function stopMoodTimer() {
  if (moodTimer) { clearTimeout(moodTimer); moodTimer = null; }
}

/* 心境人话（进 prompt 用）。开关关 = 空串 = 调用方不注入（零侵入）。
 * P5：气质慢层提示拼在后面（仍不进 persona 正文）。 */
function moodLine() {
  if (!isOn('appearance', 'mood')) return '';
  const line = moodEngine.promptLine();
  const temper = temperament.promptHint();
  const bits = [line, temper].filter(Boolean);
  return bits.length
    ? `（她此刻的心境，用来把握语气，别复述给用户：${bits.join('；')}。）`
    : '';
}

/* 长期记忆注入行。从本轮 messages 里取最后一条 user 做召回 query。 */
function memoryLine(messages) {
  if (!isOn('memory', 'enabled', true)) return '';
  const cfg = loadConfig();
  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => m && m.role === 'user' && typeof m.content === 'string');
  const q = lastUser?.content || '';
  const facts = memory.recall(q, {
    injectMax: cfg.memory?.injectMax,
    forceExpand: false
  });
  return memory.formatMemoryLine(facts, cfg.memory?.injectChars);
}

/* 回合结束后异步记一笔（不挡回复）。启发式必跑；有 key 且开着才 LLM 补抽。 */
function rememberAfterTurn(messages, assistantText) {
  if (!isOn('memory', 'enabled', true)) return;
  const cfg = loadConfig();
  const lastUser = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .find((m) => m && m.role === 'user' && typeof m.content === 'string');
  const userText = lastUser?.content || '';
  if (!userText) return;

  const opts = { maxFacts: cfg.memory?.maxFacts };
  const heur = memory.extractHeuristic(userText);
  if (heur.length) {
    const r = memory.upsertFacts(heur, opts);
    if (r.added || r.updated) {
      console.log('[memory] heuristic', JSON.stringify({ added: r.added, updated: r.updated }));
    }
  }

  if (cfg.memory?.llmExtract === false) return;
  /* 和聊天同一条判定：本机端点（Ollama/LM Studio）没有 key 也能抽。 */
  if (!isUsable(cfg.llm)) return;

  /* 已经有启发式命中时仍可补抽，但跳过明显无信息的短句 */
  if (userText.trim().length < 4) return;

  setImmediate(() => {
    memory.extractViaLlm(userText, assistantText || '', cfg.llm)
      .then((drafts) => {
        if (!drafts.length) return;
        const r = memory.upsertFacts(drafts, opts);
        console.log('[memory] llm-extract', JSON.stringify({
          n: drafts.length, added: r.added, updated: r.updated
        }));
      })
      .catch(() => { /* 记忆失败绝不能影响聊天 */ });
  });
}

/* 工作状态镜像（DSH 桌宠长处）：thinking / working / success / error / idle / attention。
 * W44：档位表见 work-cues.WORK_STATUS（索引即档位，只可追加）。
 * 渲染层按 profiles.motionSlots 播动作 + 切表情；status 气泡低优先级不抢对话。 */
let workPhase = 'idle';
let workChunkSeen = false;

/* W29：Agent JSONL 尾读。默认关；失败静默。 */
let agentLinkTimer = null;
/** @type {Map<string, { path: string, offset: number, pending: string }>} */
const agentCursors = new Map();
let agentLastPhase = '';

function agentLinkDir() {
  const d = String(loadConfig().agentLink?.dir || '').trim();
  if (d) return d;
  try { return path.join(app.getPath('userData'), 'agent-events'); } catch { return ''; }
}

function stopAgentLinkWatch() {
  if (agentLinkTimer) { clearTimeout(agentLinkTimer); agentLinkTimer = null; }
}

function tickAgentLink() {
  agentLinkTimer = null;
  const cfg = loadConfig();
  if (!cfg.agentLink?.enabled) return;
  const dir = agentLinkDir();
  if (!dir) return;
  let files = [];
  try { files = listAgentFiles(dir); } catch { files = []; }
  for (const file of files) {
    let prev = agentCursors.get(file);
    if (!prev) prev = { path: file, offset: 0, pending: '' };
    let out;
    try { out = readAgentTail(prev); } catch { continue; }
    agentCursors.set(file, out.cursor);
    for (const ev of out.events) {
      const phase = stateToWorkPhase(ev.state);
      if (phase === agentLastPhase && phase !== 'working') continue;
      agentLastPhase = phase;
      emitWorkState(phase, { source: 'agent-link', agent: ev.agent, tool: ev.tool });
    }
  }
  const ms = Math.max(500, Math.min(30000, Number(cfg.agentLink?.pollMs) || 2000));
  agentLinkTimer = setTimeout(tickAgentLink, ms);
  if (typeof agentLinkTimer.unref === 'function') agentLinkTimer.unref();
}

function refreshAgentLinkWatch() {
  stopAgentLinkWatch();
  if (!isOn('agentLink', 'enabled', false)) return;
  tickAgentLink();
}

function emitWorkState(phase, extra = {}) {
  if (!isOn('interaction', 'workState', true)) return;
  /* W44：未知 phase 仍放行 idle；已知档用索引表（attention 等新档只追加）。 */
  const idx = workStatusIndex(phase);
  if (phase !== 'idle' && idx < 0 && phase !== 'sleeping') return;
  if (phase === workPhase && phase !== 'working') return;
  workPhase = phase;
  if (phase === 'thinking') workChunkSeen = false;
  const personaId = loadConfig().personaId || 'default';
  const emo = signatureEmo(personaId, phase) || extra.emotion || '';
  /* W12：内侧总线先发；IPC 仍是对外唯一通道。 */
  petEvents.emit('work-state', { phase, emotion: emo, index: idx, ...extra });
  /* X7：工作事件轻推 mood（不抢 setEmotion，只动轴；working 不灌，避免每轮对话都困）。 */
  try {
    if (phase === 'success') {
      moodEngine.onAssistantEmotion('happy');
      pushMoodSnapshot();
    } else if (phase === 'error') {
      moodEngine.onAssistantEmotion('serious');
      pushMoodSnapshot();
    } else if (phase === 'attention') {
      moodEngine.onAssistantEmotion('surprised');
      pushMoodSnapshot();
    }
  } catch { /* ignore */ }
  try {
    mainWindow?.webContents.send('pet:work-state', { ...extra, phase, emotion: emo, index: idx });
  } catch { /* ignore */ }
  /* status 气泡：只在**没吐过正文**时露短句。
   * ⚠️ 以前在 endStream 之后无条件 showStatus —— stream 已释放，arbiter 放行，
   *    「搞定啦 ✓」会 bubble:full 盖掉刚流完的整段回复（用户报：发什么都只回搞定啦）。
   *    有 chunk 就留给 endStream 的对话气泡；没吐字（静默/空回）才露短句。
   *    报错仍必达，且要带上真实原因（响应中断 / 连接失败…），别只写「出了点问题」。
   * P4：台词按当前人格招牌池抽。 */
  if (phase === 'success') {
    if (!workChunkSeen) bubble.showStatus(workLine('success', Math.random, personaId), 2200);
  } else if (phase === 'error') {
    const raw = typeof extra.message === 'string' ? extra.message.trim() : '';
    /* 气泡一行装不下长 HTTP 正文；截短后仍能认出「响应中断」「连接失败」。
     * 没有具体原因时从台词池抽一句，避免万年「出了点问题」。 */
    const msg = (raw ? raw.replace(/\s+/g, ' ').slice(0, 72) : '') || workLine('error', Math.random, personaId);
    bubble.showStatus(msg, Math.max(2800, Math.min(6000, 2000 + msg.length * 40)));
  }
}

/* 聊天分片 / 情绪 / 想法的**唯一出口**：主窗渲染层拿它累积 replyBuffer
 * （驱动 TTS 朗读与历史保存），悬浮气泡窗拿它做流式显示。
 * 别绕开这几个函数直接 webContents.send —— 气泡窗会漏字。
 *
 * ⚠️ 想法（think）走**独立一条**：它不进 replyBuffer、不进历史、不被 TTS 念。
 *    所以这个函数只发给气泡窗和主窗的显示元素，不碰任何"说出口"的累积。 */
function emitChatChunk(t) {
  if (!workChunkSeen) {
    workChunkSeen = true;
    emitWorkState('working');
  }
  try { mainWindow?.webContents.send('chat:chunk', t); } catch { /* 窗口在销毁 */ }
  bubble.appendChunk(t);
}

function emitChatEmotion(e) {
  try { mainWindow?.webContents.send('chat:emotion', e); } catch { /* ignore */ }
  /* 悬浮气泡的情绪角标也走这条唯一出口（规矩 27）—— 绕开它气泡会挂着上一句的情绪。 */
  bubble.setEmotion(e);
  /* 心境层回灌：她自己聊出的情绪让轴也动一点（正向情绪→心情好）。
   * 挂在唯一出口上（规矩 27）—— 本地回复池 emitLocal 也走这里，天然全覆盖。 */
  moodEngine.onAssistantEmotion(e);
  pushMoodSnapshot();
}

function emitChatThink(t) {
  /* G8：关 showThink 时仍剥标签，只是不画内心 OS。 */
  if (!isOn('chat', 'showThink', true)) return;
  const shown = String(t || '').trim();
  if (!shown) return;
  try { mainWindow?.webContents.send('chat:think', shown); } catch { /* ignore */ }
  bubble.appendThink(shown);
}

/* 逐字发出去，和真实的流式回复走同一条通道，渲染层不用区分。 */
async function emitLocal(text, emotion = 'calm') {
  const filter = createStreamFilter(emitChatChunk, emitChatEmotion, emitChatThink);
  const full = `${text}\n[emo:${emotion}]`;
  for (const ch of full) {
    filter.push(ch);
    await new Promise((r) => setTimeout(r, 14));
  }
  filter.end();
  return { ok: true, local: true };
}

/* G23：藏窗截主屏 → 多模态一句。W15 口令与托盘「看一眼」共用。
 * W1：永久开关 OR 未过期限时授权。 */
async function runGlance(opts = {}) {
  const permanent = isOn('interaction', 'glance', false);
  if (!isGlanceAllowed(permanent)) {
    return emitLocal('「看一眼」还没授权，托盘里开永久开关或限时授权后再叫我。', 'think');
  }
  const cfg = loadConfig();
  if (!isLlmReady(cfg.llm)) {
    return emitLocal('模型还没测通，托盘「测试连接」过了再叫我看屏。', 'think');
  }
  toast('我看一下…');
  const shot = await captureGlanceScreen({
    hidePet: () => {
      try { bubble.hideNow?.(); } catch { /* ignore */ }
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); } catch { /* ignore */ }
    },
    showPet: () => {
      if (process.env.PET_HIDDEN === '1') return;
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
      } catch { /* ignore */ }
    },
    getDisplay: () => {
      try { return screen.getPrimaryDisplay(); } catch { return null; }
    },
    getSources: (o) => desktopCapturer.getSources(o)
  });
  if (!shot.ok || !shot.dataUrl) {
    console.warn('[glance] capture fail:', shot.error || 'unknown');
    return emitLocal('这回没截到屏，等会儿再叫我看。', 'shy');
  }
  const system = resolvePersona(cfg) +
    '\n\n【本轮·看屏】只描述可见的公开界面概况；不念密码、聊天全文、证件号；一两句口语即可。';
  return chatStream([
    { role: 'system', content: system },
    buildGlanceUserMessage(shot.dataUrl)
  ], opts);
}

async function tryLocalIntent(text) {
  const q = String(text || '').trim();
  if (!q) return null;

  // 1) 定时提醒 —— 先试"X 分钟后提醒我"，命中就登记
  const rem = parseReminder(q);
  if (rem && /提醒|叫我/.test(q)) {
    const r = addReminder(rem.minutes, rem.what ? `该${rem.what}了。` : '时间到了。');
    if (!r) return emitLocal('定时提醒在设置里关着呢，先去托盘打开。', 'think');
    return emitLocal(
      rem.what
        ? `好，${fmtMinutes(rem.minutes)}后提醒你${rem.what}。`
        : `好，${fmtMinutes(rem.minutes)}后叫你。`,
      'smile'
    );
  }

  // 2) 取消提醒
  if (RE_REMIND_CLEAR.test(q)) {
    const n = reminderCount();
    clearReminders();
    return emitLocal(n ? `清掉了，${n} 条提醒都取消了。` : '本来就没有待办的提醒。', 'calm');
  }

  // 3) 番茄钟
  if (RE_POMO_START.test(q)) {
    const m = q.match(/(\d+)\s*(?:分钟|分)/);
    const work = m ? clamp(parseInt(m[1], 10), 1, 180) : 25;
    startPomodoro(work, work >= 40 ? 10 : 5);
    return emitLocal(`番茄钟开始，先专注 ${work} 分钟。中途想停就说"停掉番茄钟"。`, 'happy');
  }
  if (RE_POMO_STOP.test(q)) {
    const st = pomodoroStatus();
    stopPomodoro(true);
    return emitLocal(st ? '行，番茄钟停了，歇会儿吧。' : '现在没在跑番茄钟。', 'calm');
  }

  // 4) 系统状态（放最后 —— 它最宽泛，前面几个更具体）
  if (RE_STATS.test(q)) {
    const s = await collectStats(FULL_FIELDS);
    return emitLocal(formatStats(s), 'calm');
  }

  return null;
}

/* ============================================================
 *  媒体感知 → 对话语境
 *
 *  知道歌名本身不算"陪伴"，**能顺口接一句**才算 —— 所以这里只做一件事：
 *  把"主人此刻在听什么"拼成一条背景信息塞进 prompt。
 *
 *  ⚠️ 特别强调"别提建议"：模型看到歌名最容易的输出是"这首歌不错，你可以
 *    试试 XX 的"——那是音乐推荐机器人，不是桌宠。信息只给她当谈资。
 * ========================================================== */

/* 同一首歌只提一次的记忆（key + 时间）。
 * 去重的意义：她连着跟你聊五轮，五个 prompt 里都有同一首歌，
 * 很可能每轮都来一句"你也在听这首啊" —— 那比不知道还烦人。 */
let mediaSaid = { key: '', at: 0 };
const MEDIA_REPEAT_MS = 30 * 60 * 1000;

/* 组装那条背景信息。返回 null = 不该塞（开关关着 / 没在放 / 状态不值得说）。 */
function mediaContextLine() {
  if (!isOn('media', 'enabled')) return null;
  const m = getMedia();
  const said = describeMedia(m);
  if (!said) return null;

  const key = mediaKey(m);
  const repeat = key && key === mediaSaid.key && (Date.now() - mediaSaid.at) < MEDIA_REPEAT_MS;
  mediaSaid = { key, at: Date.now() };
  if (repeat) {
    return '【背景（你已知）：主人这会儿还在听刚才那首，你已经提过了 —— 别再提它。】';
  }
  return `【背景：主人此刻${said}。知道就好，想提可以顺口带一句，别推荐别的歌、别说教。】`;
}

/**
 * 把媒体背景插进 messages 的**第二位**（紧跟人设那条 system）。
 * 纯函数（line 从外面给），verify-media.js 直接测。
 *
 * ⚠️ 不能往末尾追加：末尾是用户刚说的话，在它后面再插一条 system
 *    有的后端会报错、有的会把指令权重搞乱。
 */
function injectMediaContext(messages, line) {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  if (!line) return arr;
  arr.splice(Math.min(1, arr.length), 0, { role: 'system', content: line });
  return arr;
}

/**
 * 复读护栏的提示（见 repetition-guard.js）。
 *
 * 🔴 数据不用另存一处 —— 历史本来就在这一轮要发的 `messages` 里，
 *    从这里把最近的 assistant 回复挑出来就行（零状态、零额外 IO）。
 *
 * @param {Array} messages 这一轮要发的消息（persona system 在前、历史在后）
 * @param {boolean} on 配置 chat.varietyGuard；显式传 false 才关
 * @returns {string} 空串 = 没什么好说的（**不要**插空 system）
 */
function varietyHint(messages, on) {
  if (on === false) return '';
  const replies = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string')
    .map((m) => m.content)
    .slice(-REPEAT_WINDOW);
  const { findings, hint } = analyzeRepetition(replies);
  /* 只记命中的类别（不是整段文本）：出问题时要一眼看出是哪一项在误报，
   * 以后调阈值也就有据可依。 */
  if (hint) console.log('[chat] 复读护栏:', findings.map((f) => f.kind).join('+'));
  return hint;
}

/**
 * 心境人话也插进**第二位**（与媒体/复读同一个约定：紧跟人设、在用户那句话之前）。
 * 与另外两条同款纯函数（不原地改数组、空行不塞空 system）。
 * chatStream 里它在**最外层**（最后套）→ 排最贴人设的位置：
 * [人设, 心境, 媒体, 复读提示, ...历史]。
 */
function injectMoodContext(messages, line) {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  if (!line) return arr;
  arr.splice(Math.min(1, arr.length), 0, { role: 'system', content: line });
  return arr;
}

/**
 * 把复读提示也插进**第二位**（和 injectMediaContext 同一个约定：紧跟人设，
 * 末尾是用户刚说的话，后面不能再追加 system，有的后端会 400）。
 * 纯函数（hint 从外面给），verify-repetition.js 直接测。
 */
function injectVarietyHint(messages, hint) {
  const arr = Array.isArray(messages) ? messages.slice() : [];
  if (!hint) return arr;
  arr.splice(Math.min(1, arr.length), 0, { role: 'system', content: hint });
  return arr;
}

/* 主动搭话的"话头"按她此刻的表情给一点方向。
 *
 * 出处是竞品调研里 soullink 的 `messageByEmotion`（主动话术按当前情绪分 14 类，
 * 而不是一句通用 prompt）。我们只有 8 个情绪，所以是 8 条。
 * 🔴 键集必须和渲染层 params.js 的 EMOTION **完全一致**（verify-proactive 互验）；
 *    缺的那个会静默退回 default，那就又变回"一句通用 prompt"了。
 * ⚠️ 只是**方向**，不是台词 —— 具体说什么仍由人设 + 模型决定，
 *    这里写死台词就成了模板朗读。 */
const PROACTIVE_MOOD_HINT = {
  calm: '你现在心里挺静的。',
  happy: '你现在心情不错，语气可以轻快一点。',
  smile: '你现在带着点笑意，说话软和些。',
  think: '你心里正惦记着件事，可以顺口提一句。',
  shy: '你还有点不好意思，别太直接。',
  serious: '你有点认真，可以说句正经的（作息 / 歇会儿这类）。',
  surprised: '你刚被什么动静弄得一愣，语气里带点意外。',
  sleepy: '你有点困了，懒散一点，别太有精神。'
};

function proactiveMoodHint(emotion) {
  return PROACTIVE_MOOD_HINT[emotion] || PROACTIVE_MOOD_HINT.calm;
}

/* G2：前台进程名进主动搭话语境（全屏监视开着才有样本；过期 90s 丢弃）。
 * 只给一句短提示，不抄窗口标题（隐私）。 */
function foregroundHint() {
  if (!isOn('quiet', 'enabled')) return '';
  const fg = getForeground();
  if (!fg?.name) return '';
  if (Date.now() - (fg.at || 0) > 90 * 1000) return '';
  return `主人电脑前台在跑「${fg.name}」，别装作不知道，也别念进程名。`;
}

/* X5：切应用侦测（对比上次主动搭话时记下的前台名）。 */
let lastProactiveFg = '';

async function edgeCueHint() {
  if (!isOn('proactive', 'edgeCues', false)) return { hint: '', preferSilent: false };
  let cpu = null;
  let battery = null;
  try {
    const s = await collectStats(['battery']);
    cpu = typeof s?.cpu === 'number' ? s.cpu : null;
    battery = s?.battery || null;
  } catch { /* 取不到就不硬塞线索 */ }
  const fg = getForeground();
  const name = fg?.name && Date.now() - (fg.at || 0) <= 90 * 1000 ? fg.name : '';
  const fgSwitched = !!(name && lastProactiveFg && name !== lastProactiveFg);
  if (name) lastProactiveFg = name;
  return edgeCueFrom({ cpu, battery, fgSwitched });
}

/* G14：截屏隐藏（setContentProtection）+ 短暂藏窗。 */
function applyHideFromCapture(on) {
  try { mainWindow?.setContentProtection?.(!!on); } catch { /* ignore */ }
  try { bubble.setContentProtection?.(!!on); } catch { /* ignore */ }
}

function hidePetBriefly(ms = 3000) {
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  const wasVisible = w.isVisible();
  try { bubble.hideNow?.(); } catch { /* ignore */ }
  try { w.hide(); } catch { /* ignore */ }
  toast('已藏起，截完会自己回来');
  setTimeout(() => {
    if (!w || w.isDestroyed()) return;
    if (wasVisible && process.env.PET_HIDDEN !== '1') {
      try { w.show(); } catch { /* ignore */ }
    }
  }, Math.max(500, Number(ms) || 3000));
}

/* P7：视角蒸馏小窗 → personaParts。多字段同一套路。 */
function promptPersonaDistill() {
  return new Promise((resolve) => {
    const fields = DISTILL_FIELDS;
    const w = new BrowserWindow({
      width: 420,
      height: 420,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
      modal: !!mainWindow && !mainWindow.isDestroyed(),
      show: false,
      backgroundColor: '#1e1e22',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    const inputs = fields.map((f) =>
      `<label>${f.label}<input name="${f.key}" placeholder="${f.placeholder || ''}" maxlength="200"></label>`
    ).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{background:#1e1e22;color:#e8e8ea;font:13px/1.45 "Microsoft YaHei",system-ui,sans-serif;padding:16px 18px;user-select:none}
      h2{font-size:13px;font-weight:500;margin-bottom:6px}
      p{font-size:12px;color:#9a9aa0;margin-bottom:10px}
      label{display:block;font-size:12px;color:#b8b8bc;margin:8px 0 4px}
      input{width:100%;height:30px;padding:0 8px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#fff;font:13px/1 inherit;outline:none}
      .row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
      button{height:28px;padding:0 14px;border-radius:6px;border:1px solid #3a3a40;background:#2a2a30;color:#e8e8ea;font-size:13px;cursor:pointer}
      button.primary{background:#4a6cf7;border-color:#4a6cf7;color:#fff}
    </style>
    <h2>视角蒸馏</h2>
    <p>几句短答，生成人设分项草稿（不碰表情协议槽）。</p>
    ${inputs}
    <div class="row"><button id="c">取消</button><button class="primary" id="k">生成</button></div>
    <script>
      const send = (v) => { window.__distill = v; };
      document.getElementById('c').onclick = () => send(null);
      document.getElementById('k').onclick = () => {
        const o = {};
        for (const el of document.querySelectorAll('input[name]')) o[el.name] = el.value.trim();
        send(o);
      };
      window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') send(null); });
    <\/script>`;
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    w.once('ready-to-show', () => w.show());
    let finished = false;
    const finish = async (val) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!w.isDestroyed()) w.destroy();
      if (!val) { resolve(false); return; }
      const draft = distillPersonaParts(val);
      if (!draft.ok) { toast('写点什么再生成'); resolve(false); return; }
      const patch = { persona: '', personaParts: draft.parts };
      if (draft.name) patch.name = draft.name;
      patchConfig(null, patch);
      toast(draft.name ? `已生成「${draft.name}」人设草稿` : '已生成人设草稿');
      resolve(true);
    };
    const timer = setInterval(async () => {
      if (w.isDestroyed()) { finish(undefined); return; }
      try {
        const v = await w.webContents.executeJavaScript('window.__distill ?? undefined');
        if (v !== undefined) finish(v === null ? undefined : v);
      } catch { /* loading */ }
    }, 120);
    w.on('closed', () => { if (!finished) { finished = true; clearInterval(timer); resolve(false); } });
  });
}

/* P8：导入 Character Card JSON → personaParts 草稿。 */
async function importCharacterCard() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入 Character Card（V2/V3 JSON）',
    filters: [{ name: 'Character Card', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || !filePaths?.[0]) return false;
  let raw;
  try { raw = fs.readFileSync(filePaths[0], 'utf8'); }
  catch (err) {
    toast('读不了文件：' + (err?.message || err));
    return false;
  }
  const draft = cardToPersonaDraft(raw);
  if (!draft.ok) {
    toast('不像角色卡：' + (draft.error || '无法解析'));
    return false;
  }
  const patch = { persona: '', personaParts: draft.parts || {} };
  if (draft.name) patch.name = draft.name;
  patchConfig(null, patch);
  toast(draft.name ? `已导入「${draft.name}」人设草稿` : '已导入人设草稿');
  return true;
}

/* G13：导出聊天记录。读 history 文件 → 弹保存框。 */
async function exportChatHistory(format) {
  const file = path.join(app.getPath('userData'), 'chat-history.json');
  let arr = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    arr = Array.isArray(raw) ? raw : [];
  } catch {
    arr = [];
  }
  if (!arr.length) {
    toast('还没有可导出的对话');
    return false;
  }
  const name = resolveName(loadConfig());
  const stamp = new Date().toISOString().slice(0, 10);
  const isMd = format === 'md';
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: isMd ? '导出为 Markdown' : '导出为 JSON',
    defaultPath: path.join(app.getPath('documents'), `阿岩对话-${stamp}.${isMd ? 'md' : 'json'}`),
    filters: isMd
      ? [{ name: 'Markdown', extensions: ['md'] }]
      : [{ name: 'JSON', extensions: ['json'] }]
  });
  if (canceled || !filePath) return false;
  const meta = { name, exportedAt: new Date().toISOString() };
  const body = isMd ? historyToMarkdown(arr, meta) : historyToJson(arr, meta);
  try {
    fs.writeFileSync(filePath, body, 'utf8');
    toast(`已导出 ${arr.length} 条`);
    return true;
  } catch (err) {
    toast('导出失败：' + (err?.message || err));
    return false;
  }
}

/* 把 llm.js 的 streamLLM 接到窗口上。
 * 依赖注入的代价就是这里多一层胶水 —— 但换来 llm.js 完全不碰窗口，
 * 可以脱离 Electron 单独 require 与测试。 */
function chatStream(messages, opts = {}) {
  const cfg = loadConfig();
  /* W16：requireTested 打开时，没绿标就走离线话术（不当真连上）。 */
  const llmOpts = { ...cfg.llm };
  if (cfg.llm?.requireTested && !isLlmReady(cfg.llm)) {
    llmOpts.apiKey = '';
    llmOpts.baseUrl = '';
  }
  /* 上下文都插进第二位（紧跟人设那条 system）。
   * ⚠️ 都是 splice(1, 0)，**后套的在前**。最外层是记忆 → 最贴人设：
   *    [人设, 记忆, 心境, 媒体, 复读提示, ...历史]。
   *    共同点是**都必须在用户那句话之前**。 */
  const withContext = memory.injectMemoryContext(
    injectMoodContext(
      injectMediaContext(
        injectVarietyHint(messages, varietyHint(messages, cfg.chat?.varietyGuard !== false)),
        mediaContextLine()
      ),
      moodLine()
    ),
    memoryLine(messages)
  );
  /* 累积说出口的正文，给回合后记忆抽取用（streamLLM 返回值不含全文）。 */
  let spoken = '';
  return streamLLM(withContext, {
    ...llmOpts,
    send: (t) => { spoken += t; emitChatChunk(t); },
    sendEmotion: emitChatEmotion,
    sendThink: emitChatThink,
    /* 外部中止信号（在途作废）：不传时 streamLLM 的行为与从前逐位一致 */
    signal: opts.signal
  }).then((res) => {
    /* 助手腔短语**拦不住** —— 流式的字已经进气泡了，事后删不掉。
     * 这里只统计，用来判断提示词（config.js 的 style / format）到底管不管得住：
     * 日志里频繁出现就说明该把禁用语写得更狠，或者升级成"边收边扣"的硬拦。 */
    if (res && Array.isArray(res.tone) && res.tone.length) {
      console.warn('[chat] 助手腔命中（提示词没管住）:', res.tone.join(' / '));
    }
    /* G9：输出侧人设护栏（纯判定；流式已出口，失败只记日志 + 轻 toast）。 */
    if (res?.ok) {
      const g = checkPersonaOutput(spoken, {
        level: cfg.chat?.personaGuard,
        silent: !!res.silent
      });
      res.guard = g;
      if (!g.pass) {
        console.warn('[chat] persona-guard fail:', g.reason);
        try { toast('这句有点不像她（人设护栏）'); } catch { /* ignore */ }
      }
    }
    if (res?.ok && !res.silent) {
      rememberAfterTurn(messages, spoken);
    }
    return res;
  });
}

/* ============================================================
 *  IPC
 * ========================================================== */

function registerIpc() {
  ipcMain.on('pet:set-ignore-mouse', (_e, ignore) => {
    if (!mainWindow) return;
    /* W6 渐隐进行中：整窗强制穿透，渲染层再发 false 也别顶回去。 */
    if (hoverFadeActive) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    if (ignore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
    else mainWindow.setIgnoreMouseEvents(false);
  });

  /* W6：指针在她身上停一会儿 → 淡 + 穿透；离开 / 关开关 → 恢复。 */
  ipcMain.on('pet:hover-fade', (_e, on) => {
    if (!loadConfig().appearance?.hoverFade) on = false;
    hoverFadeActive = !!on;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const a = loadConfig().appearance || {};
    const baseOp = clampOpacity(a.opacity);
    const opacity = hoverFadeActive ? Math.min(baseOp, 0.32) : baseOp;
    try { mainWindow.setOpacity(opacity); } catch { /* ignore */ }
    if (hoverFadeActive) {
      try { mainWindow.setIgnoreMouseEvents(true, { forward: true }); } catch { /* ignore */ }
    }
    /* 熄掉时不强制 setIgnoreMouse(false) —— 下一帧命中测试会按实际重申。 */
  });

  ipcMain.on('pet:drag-move', (_e, { dx, dy }) => {
    if (!mainWindow) return;

    /* ⚠️ 第一件事：把正在跑的自动移动（当前这一趟 + 溜达循环 + 回位）停掉，
     * 并记下"他正抓着窗口"，拖拽期间一切自动移动让位。
     *
     * animateTo（溜达 / 回位 / 贴边）是个 24ms 的 setInterval，一直在
     * setBounds 写窗口位置。如果不先停它，拖拽期间就有**两条循环同时写位置**：
     * 一条把你拖到的坐标写进去，另一条把动画的插值坐标写进去，
     * 表现是「溜达途中一把抓住她，窗口一边跟着走一边自己抽搐」，
     * 松手后（drag-end → edgeSnap）还要再抖一次。
     * 用户操作一律优先于自动动作，进来就把它掐掉。 */
    onUserDragMove();

    /* ⚠️ 拖窗口必须用 setBounds 并把 width/height 一起带上，**不能用 setPosition**。
     *
     * 症状：每拖动一次，人物就变大一点，拖几次之后人明显胀大。
     *
     * 根因（在窗口层，不在渲染层）：这是透明 + 无边框（transparent/frame:false）的
     *   Windows 窗口。Windows 为了给这类窗口做 DWM 合成，会额外附加一圈不可见的
     *   边框，而**每次做窗口位置变更（SetWindowPos）时这圈边框都会被重新计算**，
     *   结果是窗口的尺寸被一点点撑大。
     *   实测（诊断通道 ?snap=movesize，模拟拖动 dx=dy=6）：
     *       静置   width=324 高度=360（稳定）
     *       拖 1 次 width=326，拖 2 次 328，拖 5 次 336，十几次后 370+ …
     *   而且位置**多走一倍**：dx 传 6，窗口实际移动 12。
     *
     * 为什么会传导到人物大小：窗口尺寸 → 渲染进程 #stage 的 clientWidth/Height
     *   → layout() 里 canvas = stage × ZOOM → holder.scale = canvas高 / 画布高，
     *   一路等比放大。所以这不是取景参数的问题，改 PET_SCALE 也治不好。
     *
     * 修法：setBounds 显式带上尺寸，把宽高钉死；顺带把已经漂移的尺寸纠回设计值。
     *   位置用 getBounds 的坐标系（和 setBounds 同一套），不再多走一倍。
     *   代价：桌宠窗口本来就是固定尺寸（resizable:false），钉死没有任何副作用。 */

    /* 心境层：drag-move 每帧都发，这里做**边沿判定**——第一帧算「被拎起来」
     *（结账在 onDragBegin，引擎那边只认显式入口）。 */
    if (!moodDragging) {
      moodDragging = true;
      moodEngine.onDragBegin();
      pushMoodSnapshot();
    }

    const b = mainWindow.getBounds();
    mainWindow.setBounds({
      x: Math.round(b.x + dx),
      y: Math.round(b.y + dy),
      width: SIZE.w,
      height: SIZE.h
    });
    recordDragSample();
  });

  /* 诊断：把窗口的真实尺寸打出来。
   *
   * 排查「跑一会儿人物自己变大」时加的：渲染进程报 stage 尺寸在持续增长，
   * 而 CSS 里 html/body 是 100% + overflow:hidden、#canvas 是 absolute，
   * 理论上 stage 只可能等于窗口内容区 —— 所以必须确认到底是窗口在变大，
   * 还是渲染进程的 DOM 度量在抽风。getBounds 是 DIP，getContentSize 是内容区。
   *
   * anim 是给自动化测试用的：判断「拖拽有没有把溜达的平滑移动掐掉」，
   * 光看坐标变化会被 edgeSnap 之类的后续动作干扰，直接看动画在不在跑最准。 */
  if (process.env.PET_SNAPSHOT) {
    setInterval(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      console.log('[bounds]', JSON.stringify({
        bounds: mainWindow.getBounds(),
        content: mainWindow.getContentSize(),
        anim: isMoveAnimRunning() ? 'running' : null
      }));
    }, 500);
  }

  ipcMain.on('pet:quit', () => app.quit());
  ipcMain.on('pet:hide', () => mainWindow?.hide());

  /* 气泡 / 输入条显隐 → 窗口宽度在「常驻窄」与「对话宽」之间切。
   * 宽度**数值**由渲染层算（人物几何在那边），这里只负责落成 setBounds。 */
  ipcMain.on('pet:stage-width', (_e, w) => setStageWidth(w));

  /* ---- 拖动结束 / 用户活动 ----
   *
   * 松手要按顺序做三件事：
   *   1. 通知 motion：用户手动拖放 = 对位置的明确指定 → 清掉"待回位"，
   *      别把他刚放好的人拽回启动位置（她之后再溜达跑远了照样会被收回）；
   *   2. 贴边（配置开了才生效）；
   *   3. 等贴边那 240ms 跑完，再把最终位置落盘 —— moved 处理器里
   *      "动画期间不保存"那条会跳过贴边写进去的位置（见那边的注释），
   *      所以这里补一次，否则存下来的是松手瞬间、而不是贴边后的坐标。 */
  ipcMain.on('pet:drag-end', () => {
    moodDragging = false;
    moodEngine.onDragEnd();
    pushMoodSnapshot();
    onUserDragEnd();
    /* 甩得够快 → 抛物线；否则走原来的贴边。起飞后由 onThrowSettled 落盘。 */
    if (tryStartThrow()) return;
    edgeSnap();
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const { x, y } = mainWindow.getBounds();
      saveConfig({ ...loadConfig(), window: { x, y } });
    }, 500);
  });

  /* 渲染层节流后发来的"人还在"信号。
   * 系统级闲置检测 1 秒才巡检一次，这条路让她**立刻**反应，不用等下一拍。 */
  ipcMain.on('pet:activity', () => notifyUserActivity());

  /* ---- 心境层的事件上报（渲染层侧才有的信号：点击 / 摸头）----
   * 拖拽和聊天的事件主进程自己就有一手（drag-move/-end、chat:send），
   * 不用渲染层转一手 —— 这条通道只收渲染层独有的那两个。 */
  ipcMain.on('mood:event', (_e, ev) => {
    const type = ev && ev.type;
    if (type === 'click') moodEngine.onClick();
    else if (type === 'patStart') moodEngine.onPatStart();
    else if (type === 'patEnd') moodEngine.onPatEnd();
    else return;
    pushMoodSnapshot();
  });

  /* ---- 在角色身上右键弹出的快捷菜单 ----
   * 默认**自绘轮盘**（右键按住 → 划向扇区 → 松手），配置 interaction.radialMenu
   * 关掉时退回系统原生菜单 —— 原生样式改不了（Electron 官方 issue #4990 的原话：
   * 样式由 OS 决定），但它是兜底，得留着。 */
  ipcMain.on('pet:context-menu', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cfg = loadConfig();
    if (cfg.interaction?.radialMenu !== false) return;   // 默认走轮盘，这里只管回退
    const send = (ch, payload) => {
      try { mainWindow.webContents.send(ch, payload); } catch { /* ignore */ }
    };
    const openCfg = () => {
      const p = getConfigPath();
      if (!fs.existsSync(p)) saveConfig(loadConfig());
      shell.openPath(p);
    };

    /* 外观两项收进一个子菜单，免得「点一下角色」弹出来的面板跟托盘一样长。
     * 内容与托盘**共用** appearanceSubmenu()，两边完全一致。 */
    const appearanceSub = appearanceSubmenu(cfg);

    // 顶层控制在 7 行内 —— 这是「点角色」的快捷面板，别照抄托盘那份长菜单
    const menu = Menu.buildFromTemplate([
      {
        label: '表情',
        submenu: [
          ['calm', '平静'], ['happy', '开心'], ['smile', '微笑'], ['think', '思考'],
          ['shy', '害羞'], ['serious', '认真'], ['surprised', '惊讶'], ['sleepy', '困倦']
        ].map(([k, label]) => ({ label, click: () => send('pet:set-emotion', { name: k }) }))
      },
      {
        label: '动作',
        submenu: [
          { label: '打个招呼', click: () => send('pet:play-motion', { group: 'TapBody' }) },
          { label: '随便动动', click: () => send('pet:play-motion', { group: 'Idle' }) }
        ]
      },
      { type: 'separator' },
      { label: '外观', submenu: appearanceSub },
      { label: '语音朗读', type: 'checkbox', checked: isOn('tts', 'enabled'), click: toggleTTS },
      { type: 'separator' },
      /* 「重命名」+「打开配置文件」合并成一个设置子菜单。
       * 顶层行数是硬约束（用户嫌长，2026-10-11 收过一次），直接平铺加一行
       * 会顶到 9 行；合并进来是净增 0 行，而且这两项本来都属"设置"性质。 */
      {
        label: '设置',
        submenu: [
          { label: `重命名（当前：${resolveName(cfg)}）`, click: () => { promptRename(); } },
          {
            label: `角色设定${personaStateLabel(cfg)}`,
            submenu: [
              { label: '自定义编辑…', click: () => { promptPersona(); } },
              { type: 'separator' },
              ...PERSONA_PRESETS.map((p) => ({
                label: p.label,
                click: () => { applyPersonaPreset(p.id); }
              })),
              { type: 'separator' },
              { label: '性格微调', submenu: personalitySubmenu(cfg) },
              { type: 'separator' },
              oneshotSubmenu()
            ]
          },
          { type: 'separator' },
          { label: '检查更新', click: () => { checkForUpdates({ manual: true }); } },
          { label: '打开配置文件', click: openCfg }
        ]
      },
      { label: '隐藏', click: () => mainWindow?.hide() },
      { label: '退出', click: () => app.quit() }
    ]);
    menu.popup({ window: mainWindow });
  });

  /* ---- 轮盘菜单的数据（主进程生成，渲染层只回传 id） ----
   * ⚠️ 命令全部留在主进程：页面拿不到 Node，也拿不到这些能力，它只负责"用户
   *    选了哪个 id"。这样加命令不用动 wheel.html。
   *
   * 分层依据 Kurtenbach & Buxton 的实测：4 项 × 4 层错误率约 5%、8 项 × 2 层
   * 也在 10% 以内，但每层 8 项且深度 > 1 会迅速飙过 10%。所以**外环压到 6 项**、
   * 只有叶子多的那一组（表情 8 个）才放到内环，深度最多 2 层。
   * 「退出」特意放在内环（第二级）—— 破坏性命令不该一次手势就够得着。 */
  function buildPetWheel() {
    const cfg = loadConfig();
    const send = (ch, payload) => {
      try { mainWindow.webContents.send(ch, payload); } catch { /* ignore */ }
    };
    const actions = new Map();
    const put = (id, fn) => { actions.set(id, fn); return id; };
    const scale = Math.round(clampScale(cfg.appearance?.scale) * 100);
    const opacity = clampOpacity(cfg.appearance?.opacity);

    const emos = [
      ['calm', '平静'], ['happy', '开心'], ['smile', '微笑'], ['think', '思考'],
      ['shy', '害羞'], ['serious', '认真'], ['surprised', '惊讶'], ['sleepy', '困倦']
    ];

    const items = [
      {
        id: 'emo', label: '表情', icon: 'smile',
        kids: emos.map(([k, label]) => ({
          id: put(`emo.${k}`, () => send('pet:set-emotion', { name: k })), label
        }))
      },
      {
        id: 'motion', label: '动作', icon: 'hand',
        kids: [
          { id: put('motion.greet', () => send('pet:play-motion', { group: 'TapBody' })), label: '打个招呼' },
          { id: put('motion.idle', () => send('pet:play-motion', { group: 'Idle' })), label: '随便动动' }
        ]
      },
      {
        id: 'scale', label: '大小', sub: `${scale}%`, icon: 'zoomIn',
        kids: [
          { id: put('scale.up', () => bumpScale(SCALE_STEP)), label: '放大' },
          { id: put('scale.down', () => bumpScale(-SCALE_STEP)), label: '缩小' },
          { id: put('scale.reset', resetScale), label: '重置 100%' }
        ]
      },
      {
        id: 'opacity', label: '透明', sub: `${Math.round(opacity * 100)}%`, icon: 'sun',
        kids: [1, 0.9, 0.8, 0.7].map((v) => ({
          id: put(`opacity.${v}`, () => setOpacity(v)), label: `${Math.round(v * 100)}%`
        }))
      },
      /* 朗读是叶子（一次手势切开关）。
       * ⚠️ 轮盘**只留"玩"的那部分**：重命名 / 角色设定 / 检查更新 / 打开配置
       *    文件 / 退出一律不进轮盘 —— 它们在托盘菜单里都有（第二入口本来就是
       *    硬要求），而且退出这种破坏性命令不该一次手势就够得着（muriel 规范：
       *    "Do not hide a destructive… inside a gesture-only path"）。 */
      {
        id: put('tts', toggleTTS),
        label: '朗读', sub: isOn('tts', 'enabled', false) ? '开' : '关',
        icon: 'volume2'
      },
      { id: put('hide', () => mainWindow?.hide()), label: '隐藏', icon: 'eyeOff' }
    ];
    return { items, actions };
  }

  /* ---- 快捷菜单的数据（主进程生成，渲染层只回传 id）----
   * 顶层 5 项：表情 / 动作 / 外观 / 朗读 / 隐藏，分三组（两条分隔线）。
   * 「大小」和「透明」合成一个「外观」：菜单要短（规矩 5），而且这两项都属于
   * "外观"这一类，分开列只会把卡片撑高。
   * 深度最多 2 层（Apple HIG：最多一级子菜单）。
   * ⚠️ 命令全部留在主进程：页面拿不到 Node，只负责"用户选了哪个 id"。
   *    这样加命令不用动 card-menu.html / bubble-menu.html。
   * ⚠️ 泡泡（技术储备）和卡片（默认）**共用这一份** —— 两份数据长得一样却各写
   *    一遍，迟早一个改了另一个没改。 */
  function buildPetMenu() {
    const send = (ch, payload) => {
      try { mainWindow.webContents.send(ch, payload); } catch { /* ignore */ }
    };
    const actions = new Map();
    const put = (id, fn) => { actions.set(id, fn); return id; };

    const emos = [
      ['calm', '平静'], ['happy', '开心'], ['smile', '微笑'], ['think', '思考'],
      ['shy', '害羞'], ['serious', '认真'], ['surprised', '惊讶'], ['sleepy', '困倦']
    ];

    const items = [
      {
        id: 'emo', label: '表情', icon: 'smile',
        kids: emos.map(([k, label]) => ({
          id: put(`emo.${k}`, () => send('pet:set-emotion', { name: k })), label
        }))
      },
      {
        id: 'motion', label: '动作', icon: 'hand',
        kids: [
          { id: put('motion.greet', () => send('pet:play-motion', { group: 'TapBody' })), label: '打个招呼' },
          { id: put('motion.idle', () => send('pet:play-motion', { group: 'Idle' })), label: '随便动动' }
        ]
      },
      { sep: true },
      {
        id: 'look', label: '外观', icon: 'zoomIn',
        kids: [
          { id: put('scale.up', () => bumpScale(SCALE_STEP)), label: '放大' },
          { id: put('scale.down', () => bumpScale(-SCALE_STEP)), label: '缩小' },
          { id: put('scale.reset', resetScale), label: '重置 100%' },
          /* 「更透明」是循环档（100→90→80→70→100）：比一次列出 4 个档位省三行，
           * 而且"再点一次继续变淡"比挑数字更符合桌宠的调性。 */
          { id: put('opacity.cycle', cycleOpacity), label: '更透明' }
        ]
      },
      {
        id: put('tts', toggleTTS),
        label: '朗读', sub: isOn('tts', 'enabled', false) ? '开' : '关',
        icon: 'volume2'
      },
      { sep: true },
      /* 🔴 「重命名 / 角色设定 / 检查更新 / 打开配置文件 / 退出」一律不进这张
       *    菜单：托盘里都有（第二入口本来就是硬要求），而且退出这种破坏性命令
       *    不该一次手势就够得着（muriel 规范原话："Do not hide a destructive,
       *    legal, financial, or permission consequence inside an unlabeled glyph
       *    or a gesture-only path."）。 */
      { id: put('hide', () => mainWindow?.hide()), label: '隐藏', icon: 'eyeOff' }
    ];
    return { items, actions };
  }

  /* 泡泡的锚点 = 她头顶（屏幕坐标）。
   * 🔴 头顶 y 只有一处来源（bubble.js 实量的 headTop + contentBounds 换算，
   *    规矩 20/27）。量不到时退回窗顶 —— 位置高一点，但绝不会飘到别处。 */
  function petHeadAnchor() {
    const a = bubble.headAnchor();
    if (a) return a;
    const b = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentBounds() : null;
    if (!b) return { x: 0, y: 0 };
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y) };
  }

  /* ⚠️ 频道名还是 `pet:wheel-open`（历史名，从轮盘那版沿用）。改名要同步动
   *    preload.js 和 renderer/pet.js 两处，收益只是好看，先留着。 */
  ipcMain.on('pet:wheel-open', (_e, pos) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cfg = loadConfig();
    if (cfg.interaction?.rightMenu === false) return;
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    /* 形态分流（规矩 4：新形态是开关）：
     *   'card'（默认）光标处卡片 | 'bubble' 头顶泡泡 | 'wheel' 自绘轮盘
     * 后两个都是**技术储备**：代码完整保留，改一个字符串就能切回去。 */
    const form = cfg.interaction?.petMenu;
    if (form === 'wheel') {
      const { items, actions } = buildPetWheel();
      /* 底色开关（interaction.radialTint）。色值不在主进程，只传布尔。 */
      wheel.show(items, actions, x, y, { tint: cfg.interaction?.radialTint !== false });
      return;
    }

    const { items, actions } = buildPetMenu();
    if (form === 'bubble') {
      /* 泡泡是**离散圆点**，没有"分隔线"这个概念 —— 把 {sep:true} 滤掉再给。 */
      bubbleMenu.show(items.filter((it) => !it.sep), actions, petHeadAnchor(),
        { tint: cfg.interaction?.petMenuTint !== false });
      return;
    }

    cardMenu.show(items, actions, { x, y },
      { tint: cfg.interaction?.petMenuTint !== false });
  });

  /* 主窗这边收到的右键松手（菜单窗自己还有一条，两条都幂等）。 */
  ipcMain.on('pet:wheel-release', () => {
    const form = loadConfig().interaction?.petMenu;
    if (form === 'wheel') wheel.release();
    else if (form === 'bubble') bubbleMenu.release();
    else cardMenu.release();
  });

  /* 渲染层要求「整窗重绘」。
   *
   * 🔴 2026-10-29「两个她」的第二次修（第一次只清画布，**不够** —— 用户实测仍复现）。
   *    官方一手资料：Electron 博客《Tech Talk: Improving Window Resize Behavior》
   *    （2025-12-19），原文两条：
   *      · 「只有视口会在新帧到来时被重绘，其余部分保持原样」
   *      · 「缩小窗口的某些情况下…裁剪矩形的一部分仍然显示以前的帧，因为新帧
   *        更小，而超出新视口的区域我们从来没有重绘」
   *    官方修法 = **把视口之外曾经画过的区域涂成透明**，补丁随 Electron 39.2.6
   *    落地；我们是 44.7.0，那条补丁**已经在里面了**。
   *
   *    但它修的是「**窗口** resize」。我们这个场景窗口尺寸不变、只有**画布层**
   *    缩小（--stats-h 只让 #stage 变矮），不在它的覆盖范围内，所以症状还在。
   *    原理可以照搬：旧帧占着"新内容不再覆盖"的那块区域，得主动要求整窗重绘，
   *    让合成器把那块丢掉。`webContents.invalidate()` 就是官方口子
   *    （"Schedules a full repaint of the window this web contents is in"）。 */
  ipcMain.on('pet:repaint', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try { mainWindow.webContents.invalidate(); } catch { /* 正在销毁 */ }
  });

  /* ---- 系统状态 ---- */
  ipcMain.handle('monitor:query', async () => {
    const s = await collectStats(FULL_FIELDS);
    return { ok: true, stats: s, text: formatStats(s) };
  });

  /* ---- 定时提醒 / 番茄钟 ---- */
  ipcMain.handle('reminder:add', (_e, { minutes, text, kind } = {}) => {
    const r = addReminder(minutes, text, kind === 'pomodoro' ? 'pomodoro' : 'reminder');
    if (!r) return { ok: false, error: 'reminder-disabled' };
    return { ok: true, at: r.at, minutes: Number(minutes) };
  });

  ipcMain.handle('reminder:list', () => ({
    reminders: listReminders(),
    pomodoro: pomodoroStatus()
  }));

  ipcMain.handle('reminder:clear', () => { clearReminders(); return { ok: true }; });

  ipcMain.handle('pomodoro:start', (_e, { workMin, breakMin } = {}) => {
    startPomodoro(Number(workMin) || 25, Number(breakMin) || 5);
    return { ok: true, status: pomodoroStatus() };
  });

  ipcMain.handle('pomodoro:stop', () => { stopPomodoro(); return { ok: true }; });

  /* ---- 语音输入 ---- */
  ipcMain.handle('asr:recognize', async (_e, data) => {
    if (!isOn('asr', 'enabled', false)) return { ok: false, error: 'disabled' };
    let buf;
    try {
      buf = Buffer.from(data);
    } catch {
      return { ok: false, error: 'bad-payload' };
    }
    if (!buf.length) return { ok: false, error: 'empty' };
    // 太短基本是误触（16kHz 16bit 下 0.3 秒才 9600 字节）
    if (buf.length < 4000) return { ok: false, error: 'too-short' };
    return recognizeWav(buf);
  });

  /* ---- 语音朗读：合成一段 wav 交给渲染层播（声音走 WebAudio 才有真口型） ----
   * ⚠️ 返回 **ArrayBuffer** 而不是 Buffer：渲染层的 decodeAudioData 只吃
   *    ArrayBuffer，而 Buffer 经结构化克隆过去是 Uint8Array（且可能是
   *    共享池里的一个视图），直接拿去解码会抛。
   * ⚠️ 合成不出来一律 resolve null —— 调用方据此退回系统内置音色，
   *    绝不能让它变成一次 rejected 的 invoke（那会把朗读队列卡住）。 */
  ipcMain.handle('tts:synth', async (_e, payload) => {
    if (!isOn('tts', 'enabled', false)) return null;
    const p = payload && typeof payload === 'object' ? payload : {};
    /* W47：把 tts 配置段整体传给 synthWav —— 它按 provider 分流。
     * winrt（默认）时这四个字段被忽略，行为不变。 */
    const cfg = loadConfig();
    const providerCfg = {
      provider: cfg.tts?.provider,
      baseUrl: cfg.tts?.baseUrl,
      apiKey: cfg.tts?.apiKey,
      model: cfg.tts?.model
    };
    const r = await synthWav(p.text, p.opts || {}, providerCfg);
    if (!r.ok) return null;
    return r.wav.buffer.slice(r.wav.byteOffset, r.wav.byteOffset + r.wav.byteLength);
  });

  ipcMain.handle('chat:send', async (_e, messages) => {
    /* 用户开口 = 在途的主动搭话全部作废（第 9 轮第一档）。在源头断流，
     * 晚到的主动话不会从这一轮的气泡里冒出来。渲染层还有一道 epoch
     * 双保险（见 pet.js proactiveSpeak）—— 万一流恰好在断流前收完了，
     * 那边也不会把它落进历史。 */
    if (proactiveAbort) {
      proactiveAbort.abort();
      proactiveAbort = null;
    }
    /* G3：新一轮也要掐掉上一轮普通对话流，否则打断后旧回复还在往气泡里灌。 */
    if (chatAbort) {
      chatAbort.abort();
      chatAbort = null;
    }
    const ac = new AbortController();
    chatAbort = ac;
    /* 用户开口 = 最强意义上的「被搭理」：想念轴归零（mood.js）。 */
    moodEngine.onUserChat();
    pushMoodSnapshot();
    recordRhythmHit();
    emitWorkState('thinking');
    // 悬浮气泡：这一轮对话从现在开始显示（浮窗关着时是 no-op）
    bubble.beginStream();
    try {
      // 本地能答的先答（系统状态 / 定时提醒 / 番茄钟 / 看屏口令），答不了的才交给对话后端
      const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
      try {
        /* W15：短口令「看看 / 看一眼」→ G23 看屏通路（不进普通 LLM 文本轮）。 */
        if (isGlancePhrase(typeof last?.content === 'string' ? last.content : '')) {
          const g = await runGlance({ signal: ac.signal });
          bubble.endStream();
          if (g?.ok === false) emitWorkState('error', { message: g.error || '看屏失败' });
          else emitWorkState('success');
          return g;
        }
        const local = await tryLocalIntent(last?.content);
        if (local) {
          bubble.endStream();
          if (local?.ok === false) {
            emitWorkState('error', { message: local.error || '出了点问题…' });
          } else {
            emitWorkState('success');
          }
          return local;
        }
      } catch (err) {
        console.warn('[intent] 本地意图处理失败:', String(err?.message || err));
      }
      const cfg = loadConfig();
      /* G6：药盒指令拼进本轮 system，consume 后即焚。 */
      let system = resolvePersona(cfg);
      const pill = oneshot.consume();
      if (pill) {
        system = `${system}\n\n【仅本轮】${pill}`;
        try { refreshTrayMenu(); } catch { /* ignore */ }
      }
      /* P6：专业模态 —— 只追加语气约束，不改人设正文。 */
      if (cfg.chat?.mode === 'work') {
        system += '\n\n【本轮模态·专业】先结论后细节，语气克制，少情绪词与客套。';
      }
      const res = await chatStream(
        [{ role: 'system', content: system }, ...messages],
        { signal: ac.signal }
      );
      if (res?.ok) {
        bubble.endStream();
        emitWorkState('success');
      } else {
        bubble.abortStream();
        emitWorkState('error', { message: res?.error });
      }
      return res;
    } catch (err) {
      bubble.abortStream();
      emitWorkState('error', { message: String(err?.message || err) });
      throw err;
    } finally {
      if (chatAbort === ac) chatAbort = null;
    }
  });

  /* X3：拖文件「吃下」→ 长期记忆。只收短文本；二进制 / 过大直接拒。 */
  ipcMain.handle('memory:eat-file', (_e, payload) => {
    if (!isOn('memory', 'enabled', true)) {
      toast('长期记忆关着，吃不下（托盘「功能开关」里开）');
      return { ok: false, error: 'memory-off' };
    }
    const name = String(payload?.name || '文件').slice(0, 64);
    const text = String(payload?.text || '').trim();
    if (!text || text.length < 2) {
      toast(`「${name}」嚼不动（只要短文本）`);
      return { ok: false, error: 'empty' };
    }
    const body = text.slice(0, 400);
    const factText = `主人给过文件「${name}」：${body}`;
    try {
      const r = memory.upsertFacts([{ kind: 'other', text: factText }], {
        maxFacts: loadConfig().memory?.maxFacts
      });
      toast(r.added || r.updated ? `吃掉了「${name}」` : `「${name}」好像记过了`);
      emitWorkState('success');
      return { ok: true, added: r.added, updated: r.updated };
    } catch (err) {
      toast('没吃下去：' + (err?.message || err));
      return { ok: false, error: String(err?.message || err) };
    }
  });

  ipcMain.handle('config:get', () => {
    const cfg = loadConfig();
    /* usable 是**派生**字段，别写进配置：判定规则只有一处（llm-providers.isUsable），
     * 渲染层拿到布尔值直接用 —— 让渲染层自己判就会多出第二份"什么算能聊"的定义，
     * 一旦本地免 key 那条规则改动，两边必然不同步。 */
    const mode = normalizeMode(cfg.presence?.mode);
    return {
      ...cfg,
      llm: {
        ...cfg.llm,
        apiKey: cfg.llm.apiKey ? '***' : '',
        usable: isUsable(cfg.llm),
        ready: isLlmReady(cfg.llm)
      },
      /* ocean 派生乘子（P3）：渲染层只读乘子，公式唯一真相在 ocean.js。 */
      ocean: deriveOcean(cfg.personality),
      /* X2 派生：陪伴档忽略安静时段 + idle 乘子。 */
      presence: { ...(cfg.presence || {}), mode },
      presenceIgnoreQuiet: ignoreQuietHours(mode),
      presenceMul: presenceIdleMul(mode)
    };
  });

  /* 主人此刻在听什么。开关关着时恒为 null —— 渲染层不用自己判开关。
   * 目前只有诊断探针（?snap=media）在读它。 */
  ipcMain.handle('media:get', () => (isOn('media', 'enabled') ? getMedia() : null));

  /* ---- 聊天记录持久化 ----
   * 存成 userData/chat-history.json，退出重开还能接着上次聊。 */
  const historyFile = () => path.join(app.getPath('userData'), 'chat-history.json');

  ipcMain.handle('history:load', () => {
    try {
      const arr = JSON.parse(fs.readFileSync(historyFile(), 'utf8'));
      return Array.isArray(arr) ? arr.slice(-40) : [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('history:save', (_e, arr) => {
    try {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
      fs.writeFileSync(historyFile(), JSON.stringify((arr || []).slice(-80), null, 1), 'utf8');
      return true;
    } catch (err) {
      console.error('[history] save failed:', err);
      return false;
    }
  });

  /* ---- 主动搭话 ----
   * 主人闲置久了由主进程挑话头，走同一条流式通道，渲染层不用区分。
   *
   * 渲染层会带两个东西过来（见 pet.js 的 proactiveSpeak）：
   *   · emotion —— 她此刻的表情。话头要顺着神态走（下表）；
   *   · history —— 最近几轮对话。老代码这里**一句历史都不带**，等于失忆：
   *     刚聊过的事会被重新问一遍。
   */
  ipcMain.handle('chat:proactive', async (_e, ctx) => {
    const cfg = loadConfig();
    if (cfg.proactive?.enabled === false) return { ok: false, error: 'disabled' };

    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    /* 只收形状对的历史条目，并且截断 —— 这段是渲染层传来的，
     * 不校验的话一条畸形消息就能让后端 400。（条数渲染层已经截到 6。） */
    const past = (Array.isArray(c.history) ? c.history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));

    /* send-silent（第 9 轮第一档）：给她留"不说"的出口 —— 没什么自然
     * 可说的就回一个 [silent]，标签由 llm.js 的清洗层剥掉，不进气泡
     * 不进历史。关掉 allowSilent 时提示词不提，模型自然不会输出标签。 */
    const allowSilent = cfg.proactive?.allowSilent !== false;
    const silentHint = allowSilent
      ? '如果实在没什么自然可说的，就只回一个 [silent]，不用硬找话说。'
      : '';
    const fgHint = foregroundHint();
    const edge = await edgeCueHint();
    const edgeSilent = edge.preferSilent && allowSilent
      ? '（边缘线索偏打扰，优先 [silent]，有把握再开口。）'
      : '';
    /* G7 / W27：信息增益 —— 具名 reason；没话找话直接当沉默返回（不烧模型）。 */
    const gainCtx = {
      history: past,
      edgeHint: edge.hint,
      moodLine: moodEngine.promptLine(),
      fgHint,
      idleMinutes: Number(c.idleMinutes)
    };
    const gain = shouldProactiveSpeak(gainCtx);
    if (!gain.speak) {
      console.log('[chat] proactive skip（info-gain:', gain.reason + ', head=' + gain.head + '）');
      return { ok: true, silent: true, skipped: gain.reason, reason: gain.reason, head: gain.head };
    }
    /* X6：作息门 —— 仅当用户显式打开 gateProactive 时拦非活跃窗。 */
    if (isOn('rhythm', 'enabled', true) && isOn('rhythm', 'gateProactive', false)
        && !rhythm.isActiveWindow(rhythmState)) {
      console.log('[chat] proactive skip（rhythm: off-hours）');
      return { ok: true, silent: true, skipped: 'rhythm-off-hours', reason: 'rhythm-off-hours', head: 'none' };
    }

    /* W26：先记账再生成（pending → delivered / interrupted / silent）。 */
    let book = null;
    if (cfg.proactive?.bookFirst !== false) {
      book = bookDelivery({ reason: gain.reason, head: gain.head, preferSilent: gain.preferSilent });
    }

    const ac = new AbortController();
    proactiveAbort = ac;
    bubble.beginStream();
    try {
      const gainSilent = gain.preferSilent && allowSilent
        ? '（信息不多，优先 [silent]。）' : '';
      const res = await chatStream([
        { role: 'system', content: resolvePersona(cfg) },
        ...past,
        {
          role: 'user',
          content: '（主人已经有一阵子没搭理你了。主动开个话头，一句话就够，' +
                   '别问"在忙吗"这种客套，按你的性子随口说点什么。' +
                   (silentHint ? silentHint : '') +
                   proactiveMoodHint(c.emotion) +
                   (fgHint || '') +
                   (edge.hint || '') +
                   edgeSilent +
                   gainSilent +
                   '）'
        }
      ], { signal: ac.signal });
      if (res?.ok && res.silent) {
        /* 她选择沉默：等待态照常收掉，但渲染层不 push 历史、不念、
         * 也不记"没被搭理"（她根本没开口）。 */
        bubble.endStream();
        if (book) settleDelivery(book.id, 'silent', { reason: gain.reason });
        console.log('[chat] proactive silent（她选择这会儿不说）', gain.reason);
        return { ok: true, silent: true, reason: gain.reason, head: gain.head };
      }
      if (res?.ok) {
        bubble.endStream();
        if (book) settleDelivery(book.id, 'delivered', { reason: gain.reason });
      } else {
        bubble.abortStream();
        if (book) settleDelivery(book.id, 'error', { reason: gain.reason, error: res?.error });
      }
      return { ...res, reason: gain.reason, head: gain.head };
    } catch (err) {
      bubble.abortStream();
      if (book) {
        const interrupted = ac.signal.aborted || String(err?.message || '').includes('abort');
        settleDelivery(book.id, interrupted ? 'interrupted' : 'error', {
          reason: gain.reason,
          error: String(err?.message || err).slice(0, 160)
        });
      }
      throw err;
    } finally {
      /* 只有还是自己那把锁才清 —— 期间 chat:send 可能已经 abort 并置
       * 过 null，别把别人的账抹了。 */
      if (proactiveAbort === ac) proactiveAbort = null;
    }
  });

  /* W27：零副作用 preview —— 只返回具名 reason，不记账不调模型。 */
  ipcMain.handle('chat:proactive-preview', (_e, ctx) => {
    const c = (ctx && typeof ctx === 'object') ? ctx : {};
    const past = (Array.isArray(c.history) ? c.history : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 500) }));
    return previewProactive({
      history: past,
      edgeHint: String(c.edgeHint || ''),
      moodLine: String(c.moodLine || ''),
      fgHint: String(c.fgHint || ''),
      idleMinutes: Number(c.idleMinutes)
    });
  });

  /* say() 类整段播报进浮窗：渲染层的提醒 / 番茄钟 / 离线搭话走这两条 */
  ipcMain.on('pet:float-say', (_e, p) => {
    const o = typeof p === 'string' ? { text: p } : (p && typeof p === 'object' ? p : {});
    const ms = Number(o.ms);
    bubble.showFull(String(o.text || ''), Number.isFinite(ms) && ms > 0 ? ms : undefined);
  });
  /* 渲染层短提示（录音状态 / 拖文件闸门…）→ 气泡 status，与主进程 toast 同路。 */
  ipcMain.on('pet:float-status', (_e, p) => {
    const o = typeof p === 'string' ? { text: p } : (p && typeof p === 'object' ? p : {});
    const ms = Number(o.ms);
    bubble.showStatus(
      String(o.text || ''),
      Number.isFinite(ms) && ms > 0 ? ms : undefined
    );
  });
  ipcMain.on('pet:float-hide', () => bubble.hideNow());
  /* 渲染层请求实量人物头顶 y（模型挂载 / 布局变化时），气泡底边锚头顶用 */
  ipcMain.on('pet:head-measure', () => bubble.requestMeasure());

  /* 渲染层改配置的统一入口。对象段逐段合并（不能整段替换，否则丢默认键），
   * 落盘后把受影响的运行时状态一起同步：外观、悬浮统计、托盘勾选。 */
  ipcMain.handle('config:set', (_e, patch = {}) => {
    const cur = loadConfig();
    const next = { ...cur, ...patch };
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      const pv = patch[k];
      if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
        next[k] = { ...(cur[k] || {}), ...pv };
      }
    }
    /* 外观两项必须落在合法区间里才算数。这条通道是渲染层直接写配置用的
     * （诊断页也在走），不钳的话一个越界的 scale 会被写进盘并在下次启动生效。 */
    if (next.appearance) {
      next.appearance.scale = clampScale(next.appearance.scale);
      next.appearance.opacity = clampOpacity(next.appearance.opacity);
    }
    const ok = saveConfig(next);
    syncAppearance();
    refreshStatsTimer();
    refreshWanderConfig();
    refreshQuietWatcher();
    refreshTTS();
    refreshHotkeys();
    refreshMediaWatcher();
    refreshTrayMenu();
    try { mainWindow?.webContents.send('config:changed'); } catch { /* ignore */ }
    return ok;
  });

  // 自检：把窗口当前画面截图落盘，并统计非背景像素的包围盒。
  // 用像素统计而不是目测，才能客观量出模型在窗口里的真实落位。
  ipcMain.handle('pet:save-shot', async (_e, name) => {
    try {
      /* name 只是内部诊断用的标签。必须白名单过滤：它会被拼进 path.join，
       * 传 '../../../../某处' 就能把 PNG 写到项目目录之外去（写文件 + 覆盖）。 */
      const tag = (typeof name === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(name)) ? name : null;
      const outDir = path.join(PROJECT_ROOT, 'debug');
      fs.mkdirSync(outDir, { recursive: true });
      const img = await mainWindow.webContents.capturePage();
      const out = path.join(outDir, tag ? `pet-${tag}.png` : 'pet-window.png');
      fs.writeFileSync(out, img.toPNG());

      const { width, height } = img.getSize();
      const bmp = img.toBitmap();   // BGRA

      // 背景基准色取左上角内侧一点。
      // ⚠️ 不能用「非纯白」当判据 —— 软件合成下 transparent 会静默失效，
      //    背景不是纯白（实测 r/g/b 不在 >240 那一档），结果整窗都被算成角色
      //    （ink 直接 0..height）。改成「与角落基准色的曼哈顿差」，
      //    透明背景（真实 GPU，基准是 a=0）和实心背景（软件合成）两种都认。
      const ci = (8 * width + 8) * 4;
      const bg = { b: bmp[ci], g: bmp[ci + 1], r: bmp[ci + 2], a: bmp[ci + 3] };
      const BG_TOL = 30;

      let opaque = [1e9, 1e9, -1, -1];   // alpha > 8 的范围
      let ink = [1e9, 1e9, -1, -1];      // 明显偏离背景色的范围（角色实体）
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2], a = bmp[i + 3];
          if (a > 8) {
            if (x < opaque[0]) opaque[0] = x;
            if (y < opaque[1]) opaque[1] = y;
            if (x > opaque[2]) opaque[2] = x;
            if (y > opaque[3]) opaque[3] = y;
          }
          const diff = Math.abs(r - bg.r) + Math.abs(g - bg.g) +
                       Math.abs(b - bg.b) + Math.abs(a - bg.a);
          if (diff > BG_TOL) {
            if (x < ink[0]) ink[0] = x;
            if (y < ink[1]) ink[1] = y;
            if (x > ink[2]) ink[2] = x;
            if (y > ink[3]) ink[3] = y;
          }
        }
      }

      return {
        ok: true,
        bytes: fs.statSync(out).size,
        size: [width, height],
        opaque,
        ink,
        bg
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}

/* ============================================================
 *  启动
 * ========================================================== */

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  /* 「屏幕上出现两个她」的取证口子（2026-10-28，未解 bug 的排查起点）。
   *
   * 单实例锁 requestSingleInstanceLock 是**按 userData 目录**互斥的：dev 实例
   * （--user-data-dir 隔离）、打包版、以及那些不起锁的调试脚本，全都能绕过去 ——
   * 于是会有两个进程各开一个透明窗、各画一份模型。它们还常常**一大一小**：
   * 窗口尺寸是启动时按当时那块屏算出来的（win-size.js），两个进程算的 SIZE
   * 未必一样。
   * 这一行把「我是谁」钉进日志：下次复现只要数 [boot] 有几行、userData 是不是
   * 同一个目录，就能立刻分清「两个进程」还是「一个进程画了两份」（后者去看
   * 渲染层那条 [pet] stage 日志）。 */
  console.log('[boot]', JSON.stringify({
    pid: process.pid,
    userData: app.getPath('userData'),
    software: softwareMode,
    argv: process.argv.slice(1)
  }));

  const bootedAt = Date.now();

  // GPU 进程崩溃会在同一秒内被连续上报多次（Chromium 自己重启 GPU 子进程又立刻失败，
  // 每次都触发一次 child-process-gone）。实测一次启动能收到 4 次，不去重的话
  // app.relaunch() 会被调用 4 次，拉起多个实例互相抢 GPU 缓存。
  let gpuRelaunchDone = false;

  // GPU 进程崩了就自动降级重启 —— 否则在没显卡驱动的环境里会直接白屏挂掉。
  // 只降一次（softwareMode 里不再注册这个分支），避免崩溃-重启死循环。
  app.on('child-process-gone', (_e, details) => {
    if (details?.type !== 'GPU' || details.reason === 'clean-exit') return;

    // 跑了很久之后偶尔崩一次，Chromium 自己会用软件合成顶上去，不必重启
    if (Date.now() - bootedAt > 45000) {
      console.warn('[gpu] GPU 进程运行中退出，交给 Chromium 自行恢复:', details.reason);
      return;
    }
    if (softwareMode) {
      console.error('[gpu] 软件渲染模式下 GPU 进程仍异常退出:', details.reason);
      return;
    }
    if (gpuRelaunchDone) return;
    gpuRelaunchDone = true;

    console.warn(`[gpu] GPU 进程启动阶段崩溃（${details.reason}），改用软件渲染重启`);
    app.relaunch({ args: process.argv.slice(1).concat(SOFTWARE_FLAG) });
    app.exit(0);
  });

  /* 单实例：用户再次双击 start-pet.cmd 时（第二个进程会被 requestSingleInstanceLock
   * 挡掉并立刻退出，同时把这件事通知到这里）把已有窗口唤到眼前。
   *
   * ⚠️ 一定要有可感知的反馈：桌宠窗口小、还是 alwaysOnTop 的无边框窗口，
   *    如果它恰好被拖到屏幕边缘看不见的地方，用户会以为「没启动成功」，
   *    于是反复双击 —— 那才是「看起来有好几个实例」的真正来源。
   *    所以这里除了 show/focus，还要把跑到屏幕外的窗口拉回右下角。 */
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const b = mainWindow.getBounds();
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + b.width > a.x && b.x < a.x + a.width &&
             b.y + b.height > a.y && b.y < a.y + a.height;
    });
    if (!onScreen) {
      // 这里**故意**用主屏：窗口已经跑到所有显示器之外了，
      // 「离她最近的屏」没有意义，回主屏右下角才是用户能立刻找到的位置。
      snapToCorner(mainWindow, screen.getPrimaryDisplay().workArea);
      // 落位变了，「家」也要跟着，否则之后一次回位又把她送回屏幕外
      const r = mainWindow.getBounds();
      setHome(r.x, r.y);
    }
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      // Cubism Core 是 Live2D 的专有软件、不随仓库分发（详见 server.js 里那段
      // 说明）。本地没有该文件时由 server 从官方 CDN 取回，缓存丢在 userData
      // 下，这样 clone 到的仓库第一次启动联网一次，之后就跟本地文件一样快了。
      httpServer = await startLocalServer(PROJECT_ROOT, {
        coreCacheFile: path.join(app.getPath('userData'), 'cache', 'live2dcubismcore.min.js')
      });
      serverPort = httpServer.address().port;
    } catch (err) {
      console.error('[server] failed to start:', err);
      app.quit();
      return;
    }

    registerIpc();

    // 悬浮气泡窗：主窗引用用 getter 注入（创建时机比 bubble 晚，不能直接传）
    bubble.configureBubble({ getWindow: () => mainWindow });
    bubble.registerBubbleIpc();

    // 透明窗口能不能生效，取决于合成走的是硬件路径还是软件路径。
    // 软件合成（gpu_compositing: disabled_software）下 Windows 的 transparent
    // 会静默失效，表现就是「窗口一块白底」。这里把真实状态打出来，别靠猜。
    try {
      const g = app.getGPUFeatureStatus();
      console.log('[gpu]', JSON.stringify({
        compositing: g.gpu_compositing,
        rasterization: g.rasterization,
        webgl: g.webgl,
        webgl2: g.webgl2
      }));
    } catch { /* 取不到就算了 */ }

    configureLedger(app.getPath('userData'));  // W26 主动账本
    configureGlanceGrant({
      onChange: ({ reason, remainingMs }) => {
        if (reason === 'expired') toast('看屏限时授权已到期，已自动收回');
        else if (reason === 'grant') {
          const m = Math.max(1, Math.ceil(remainingMs / 60000));
          try { bubble.showStatus?.(`看屏授权 ${m} 分钟`, 2200); } catch { /* ignore */ }
        }
        try { refreshTrayMenu(); } catch { /* ignore */ }
        try {
          mainWindow?.webContents.send('pet:glance-grant', grantSnapshot());
        } catch { /* ignore */ }
      }
    });
    createWindow();
    createTray();
    startCursorPolling();
    refreshTopWatchdog();   // W30：explorer / DPI / 休眠后重申置顶 + skipTaskbar
    refreshAgentLinkWatch();  // W29：默认关

    /* 锁屏 / 解锁 → 推给渲染层当主动搭话的闸门（第 9 轮第一档）。
     * 对着锁屏说话没有任何场景；解锁 = 主人回来了，渲染层会自己重排闲置。
     * ⚠️ 这只拦**主动搭话**，不进全屏静默那套状态机 —— 锁屏时她照样
     *    眨眼呼吸（反正谁也看不见），只是不主动出声。 */
    try {
      powerMonitor.on('lock-screen', () => {
        screenLocked = true;
        try { onReminderScreenLock(); } catch { /* ignore */ }
        console.log('[lock] screen locked');
        try { mainWindow?.webContents.send('pet:screen-locked', { locked: true }); } catch { /* ignore */ }
      });
      powerMonitor.on('unlock-screen', () => {
        screenLocked = false;
        try { onReminderScreenUnlock(); } catch { /* ignore */ }
        console.log('[lock] screen unlocked');
        try { mainWindow?.webContents.send('pet:screen-locked', { locked: false }); } catch { /* ignore */ }
      });
    } catch (err) {
      console.warn('[lock] powerMonitor 不可用:', String(err?.message || err));
    }

    /* 换显示器 / 改系统缩放后自动适配。
     *
     * 三个事件都要听：拔插屏是 added/removed，改缩放或分辨率是 metrics-changed。
     * 处理逻辑：
     *   - 尺寸变了 → 直接落回右下角（窗口变大后原位置很可能已经越界）；
     *   - 尺寸没变（只是换了块屏）→ 走 getInitialBounds 的可见性检查，
     *     位置还在屏幕内就原地不动，跑到屏幕外才拉回右下角。
     * ⚠️ 一律用 setBounds 带死宽高 —— 透明无边框窗口上 setPosition 会
     *    触发 DWM 边框重算、把窗口撑大（见 pet:drag-move 的注释）。 */
    const onDisplayChanged = (e, d) => {
      const resized = refreshWinSize();
      if (process.env.PET_WINSIZE_LOG) console.log('[winsize] displayChanged', JSON.stringify({ e, id: d?.id, area: d?.workArea, resized, SIZE: { ...SIZE }, t: Date.now() }));
      if (!mainWindow) return;
      /* G27：display-added + multiScreenHop → 跳到**新屏**右下角；其余事件仍按原屏校正。 */
      const hop = e === 'display-added' && !!loadConfig().motion?.multiScreenHop && d?.workArea;
      const { workArea } = hop ? { workArea: d.workArea } : currentDisplay();
      let x;
      let y;
      if (hop || resized) {
        ({ x, y } = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN));
      } else {
        ({ x, y } = getInitialBounds());
      }
      mainWindow.setBounds({ x, y, width: SIZE.w, height: SIZE.h });
      /* 窗口被重新落位了 → 「家」跟着走。
       * 不跟的话，家里那个坐标已经不属于任何屏幕，她一回位就会被拉到
       * 看不见的地方去（拔掉外接屏之后尤其明显）。 */
      setHome(x, y);
      if (hop) toast('跳到新屏幕啦');
    };
    /* ⚠️ Electron 的 display-added 回调签名是 (event, display) ——
     *    这里包一层把事件名传进去，方便 hop 只在「接入」时触发。 */
    screen.on('display-added', (_ev, d) => onDisplayChanged('display-added', d));
    screen.on('display-removed', (_ev, d) => onDisplayChanged('display-removed', d));
    screen.on('display-metrics-changed', (_ev, d) => onDisplayChanged('display-metrics-changed', d));

    refreshStatsTimer();
    startIdleWatcher();
    refreshQuietWatcher();
    refreshTTS();
    refreshHotkeys();
    refreshMediaWatcher();

    /* 心境层：读档（含离线补漂 + 久别重逢），然后 10 秒一步自调度。
     * 读档结果进日志 —— 坏档/首启这两种"不是错误但值得知道"的情况
     * loadAndDrift 自己会说，不在这里再猜一遍。 */
    console.log('[mood]', moodEngine.loadAndDrift(moodFile()));
    loadTemperament();
    loadRhythm();
    applyHideFromCapture(!!loadConfig().appearance?.hideFromCapture);
    try { memory.settleAndSave(); } catch (err) {
      console.warn('[memory] settle failed', err?.message || err);
    }
    if (String(process.env.PET_SNAPSHOT || '') === 'memory') {
      try { dumpMemorySnapshot(process.env.PET_MEMORY_Q || ''); } catch (err) {
        console.warn('[memory-snapshot]', err?.message || err);
      }
    }
    syncOceanFromConfig();
    moodTick();
    warnIfModelsMissing();
    initUpdater();

    /* 诊断口子：`PET_QUIET=1` 时不需要真有全屏应用，8 秒后强制进入静默、
     * 18 秒后退出 —— 用来验证"静默期间到底停没停、醒来有没有恢复"。
     * 没有这个口子就只能靠真的去开一局游戏来测，不现实。 */
    if (process.env.PET_QUIET === '1') {
      setTimeout(() => setQuiet(true, 'PET_QUIET'), 8000);
      setTimeout(() => setQuiet(false, 'PET_QUIET-end'), 18000);
    }

    /* 诊断口子：`PET_WANDER=1` 时强制走一轮「溜达 → 有人操作 → 回位」。
     *
     * 为什么非要有这个口子：溜达的触发与保持都以**系统级闲置**
     * （powerMonitor.getSystemIdleTime）为准 —— 你只要坐在电脑前、哪怕只是动
     * 一下鼠标，闲置就永远是 0，她一辈子不会开始溜达；就算强行让她起步，
     * 下一秒的巡检也会把你判成"有人"、把这一趟收掉。也就是说这个功能在
     * "正在测它的人"眼皮底下**不可能自然触发**，只能像 PET_QUIET 那样给口子。
     *   t=15s  伪造「系统已经闲置很久」+ 强制开始溜达（跳过闲置门槛）
     *   t=40s  伪造「你刚动过鼠标」——**不直接调 notifyUserActivity**，
     *          让真实的 idleTick 自己把她收回去，这样验的就是真路径
     *   每秒   打一条状态（mode / 待回位标志 / 家 / 当前坐标），用来核对
     *          "她真的走了多趟"和"最后停在离家 0px 的地方"。
     * 用法：PET_WANDER=1 PET_SNAPSHOT=motion <electron> . */
    if (process.env.PET_WANDER === '1') {
      setTimeout(() => {
        console.log('[wander] 伪造闲置 + 强制开始溜达');
        setIdleOverride(9999);
        startWander();
      }, 15000);
      setTimeout(() => {
        console.log('[wander] 伪造"你刚动过鼠标"，交给真实的 idleTick 收她回来');
        setIdleOverride(0);
      }, 40000);
      setInterval(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const s = wanderState();
        console.log('[wander]', JSON.stringify({
          mode: s.mode, moved: s.wanderMoved, home: s.homePos, idleOv: s.idleOverrideSec,
          at: mainWindow.getBounds()
        }));
      }, 1000);
    }

    /* 诊断口子：`PET_GPUINFO=1` 时打一条「Chromium 实际在用哪块 GPU」。
     *
     * 为什么需要：本机是核显 + 独显的双 GPU 笔记本，而 WMI 的 GPUEngine
     * 计数器**同时**暴露两块卡的实例（按 luid 分）。那句「跨实例求和」到底
     * 求的是谁，光看计数器分不出来 —— 得问 Chromium 自己。
     * `auxAttributes.glRenderer` 里直接写着 ANGLE 解析到的适配器名
     * （如 "ANGLE (Intel, Intel(R) UHD Graphics ...)"），这是硬证据。
     *
     * ⚠️ 12 秒才打：本机 GPU 进程启动阶段必崩一次、要等 main.js 的自动降级
     *    重启跑完（见上面 GPU/GL 后端那段），太早问拿到的是半截状态。 */
    if (process.env.PET_GPUINFO === '1') {
      setTimeout(async () => {
        try {
          const b = await app.getGPUInfo('basic');
          const aux = b.auxAttributes || {};
          console.log('[gpuinfo] glRenderer=' + aux.glRenderer);
          console.log('[gpuinfo] glVendor=' + aux.glVendor);
          console.log('[gpuinfo] gpuDevice=' + JSON.stringify(b.gpuDevice));
          console.log('[gpuinfo] featureStatus=' + JSON.stringify(app.getGPUFeatureStatus()));
        } catch (e) {
          console.warn('[gpuinfo] 取 GPU 信息失败:', e && e.message);
        }
      }, 12000);
    }

    /* 诊断口子：`PET_MEM=1` 时每 8 秒把各进程内存打一条日志（打 6 条就停）。
     *
     * 为什么用 app.getAppMetrics() 而不是外部的 tasklist：后者只知道 PID 和
     * 一个总量，**分不清哪个进程是 GPU 进程** —— 而"内存到底占在哪"这个问题的
     * 答案几乎全在进程类型上（实测 GPU 进程比 renderer 还大，用 tasklist 看
     * 就是四个匿名数字，根本判断不了）。这个 API 是官方的，直接给进程类型。 */
    if (process.env.PET_MEM === '1') {
      let n = 0;
      const memTimer = setInterval(() => {
        const parts = app.getAppMetrics().map((m) => {
          const mb = (kb) => Math.round(kb / 1024);
          const mm = m.memory || {};
          return `${m.type}:${m.pid} ws=${mb(mm.workingSetSize || 0)} ` +
                 `peak=${mb(mm.peakWorkingSetSize || 0)} cpu=${(m.cpu?.percentCPUUsage ?? 0).toFixed(1)}%`;
        });
        console.log('[mem]', JSON.stringify({ n: ++n, parts }));
        if (n >= 6) clearInterval(memTimer);
      }, 8000);
    }
  });

  // 桌宠：关掉窗口不等于退出，托盘还活着
  app.on('window-all-closed', () => {});

  app.on('will-quit', () => {
    if (cursorTimer) clearInterval(cursorTimer);
    if (statsTimer) clearTimeout(statsTimer);
    stopMoodTimer();
    moodEngine.save(moodFile());      // 时间戳落盘 → 下次启动按它离线补漂
    disposeMotion();
    disposeReminders();
    wheel.dispose();        // 轮盘窗有轮询定时器，退出前必须停掉
    bubbleMenu.dispose();   // 泡泡菜单同理（技术储备不豁免：切过去也要能退干净）
    cardMenu.dispose();     // 卡片菜单（默认形态）—— 轮询 + 悬停定时器都得停
    try { globalShortcut.unregisterAll(); } catch { /* ignore */ }
    /* 常驻的采样进程必须显式杀掉：Windows 上父进程退出**不会**带走子进程，
     * 留着它就是一个永远在跑的 powershell.exe。 */
    stopFullscreenWatch();
    stopSensorWatch();
    stopMediaWatch();
    stopSynth();
    try { httpServer?.close(); } catch { /* ignore */ }
  });
}
