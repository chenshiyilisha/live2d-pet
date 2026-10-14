'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu,
  screen, nativeImage, shell
} = require('electron');
const path = require('path');
const fs = require('fs');

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
  PERSONA_PARTS, personaPartDefaults,
  resolveName, resolvePersona, loadConfig, saveConfig, cfgReadBlocked
} = require('./config');
const { startLocalServer } = require('./server');
const { collectStats, formatStats, startSensorWatch, stopSensorWatch, waitForFirstGpu, HUD_FIELDS, FULL_FIELDS } = require('./sysinfo');
const { recognizeWav } = require('./speech');
const { streamLLM, createStreamFilter } = require('./llm');
const {
  setReminderSink, addReminder, clearReminders, reminderCount,
  listReminders, startPomodoro, stopPomodoro, pomodoroStatus, disposeReminders
} = require('./reminder');
const {
  configureMotion, cancelMoveAnim, cancelAutoMotion, isMoveAnimRunning, setMotionPaused,
  edgeSnap, setHome, startIdleWatcher, refreshWanderConfig, startWander, wanderState,
  setIdleOverride,
  onUserDragMove, onUserDragEnd, notifyUserActivity,
  disposeMotion, currentDisplay
} = require('./motion');
const {
  startFullscreenWatch, stopFullscreenWatch
} = require('./fullscreen');
const { configureUpdater, checkForUpdates, updaterStatus } = require('./updater');
const bubble = require('./bubble');

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

let mainWindow = null;
let tray = null;
let httpServer = null;
let serverPort = 0;

/* ---- 跨模块注入 ----
 * motion 要能拿到「当前」窗口（窗口会被销毁重建，所以给 getter 而不是快照）；
 * reminder 到点了要弹气泡、必要时还得把窗口唤出来 —— 那部分是窗口的活，
 * 留在这一层做，并通过 setReminderSink 注进去。 */
configureMotion(() => mainWindow);

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('config:changed'); } catch { /* 窗口在销毁 */ }
  }
  bubble.refreshConfig();           // 气泡开关切到关：立刻把浮窗收掉
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
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.setAlwaysOnTop(isOn('appearance', 'alwaysOnTop'), 'floating');
    // 页面就绪后把外观配置（缩放 / 透明度 / 模型）同步过去
    syncAppearance();
  });
  // 兜底：万一 ready-to-show 没触发，也不能让窗口永远不出现
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
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

/* 把 appearance 配置同步到窗口与渲染层。
 * 托盘、渲染层右键菜单、手改 config.json 后的重载 —— 全部收敛到这里，
 * 保证「配置 / 窗口实际状态 / 渲染层看到的」三处永远一致。 */
function syncAppearance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const a = loadConfig().appearance || {};

  const opacity = clampOpacity(a.opacity);
  /* ⚠️ 全屏静默期间**强制取消置顶**（用户配置只在这一条上被临时覆盖）：
   *    独占全屏的游戏会盖住她，置不置顶看不出来；但**无边框窗口化的游戏**
   *    （现在绝大多数）里，一个 alwaysOnTop 的窗口会一直浮在游戏画面上，
   *    既挡视线又让 DWM 多做一层合成。退出静默时 syncAppearance 会按配置
   *    把置顶恢复回来 —— 恢复路径只有这一条，不会漏。 */
  const onTop = !quiet && a.alwaysOnTop !== false;
  const scale = clampScale(a.scale);

  try { mainWindow.setOpacity(opacity); } catch { /* 某些合成模式下不支持 */ }
  try { mainWindow.setAlwaysOnTop(onTop, 'floating'); } catch { /* ignore */ }
  try {
    mainWindow.webContents.send('appearance:changed', { scale, opacity, onTop });
  } catch { /* 窗口正在销毁 */ }
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

function toast(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send('pet:toast', { text }); } catch { /* ignore */ }
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
 * 原来的第三项「人物模型」随春一起移除 —— 只剩日和，再摆一个永远只有
 * 一条的单选菜单纯属噪音（托盘顶层还等着省行数）。 */
function appearanceSubmenu(cfg) {
  const scale = Math.round(clampScale(cfg.appearance?.scale) * 100);
  const opacity = clampOpacity(cfg.appearance?.opacity);

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
    }
  ];
}

function buildMenuTemplate() {
  const cfg = loadConfig();
  const login = app.getLoginItemSettings();
  const pomo = pomodoroStatus();

  // 配置开关的统一构造：勾选 → 落盘 + 广播 + 重画菜单（patchConfig 全包了）
  const flag = (section, key, label, def = true) => ({
    label,
    type: 'checkbox',
    checked: isOn(section, key, def),
    click: (item) => {
      patchConfig(section, { [key]: item.checked });
      if (section === 'monitor') refreshStatsTimer();
      if (section === 'motion') refreshWanderConfig();
      if (section === 'appearance') syncAppearance();
      // 关掉"全屏静默"要立刻退出静默状态，不能等她再切一次窗口
      if (section === 'quiet') refreshQuietWatcher();
    }
  });

  /* ---------- 外观与形象 ---------- */
  const appearanceMenu = [
    ...appearanceSubmenu(cfg),
    { type: 'separator' },
    flag('appearance', 'alwaysOnTop', '窗口置顶')
  ];

  /* ---------- 互动与行为 ---------- */
  const interactMenu = [
    flag('motion', 'enabled', '互动总开关'),
    { type: 'separator' },
    flag('motion', 'edgeSnap', '拖动后贴屏幕边缘'),
    flag('motion', 'wander', '闲置时自己溜达'),
    flag('motion', 'returnOnActivity', '有人操作时回到原位'),
    flag('chat', 'floatBubble', '对话气泡悬浮在头顶'),
    flag('interaction', 'rightMenu', '在角色身上右键出菜单'),
    flag('interaction', 'headPat', '按住头顶会一直蹭'),
    flag('interaction', 'dragReact', '拖着走会挣扎'),
    flag('interaction', 'pokeReact', '连戳有递进反应')
  ];

  /* ---------- 功能开关 ---------- */
  /* 静默那项把**当前状态**写进标签：这个功能生效时界面上什么都看不到
   * （她本来就是安静的），"到底有没有在静默"只能从菜单里读出来。 */
  const quietItem = flag('quiet', 'enabled', '全屏时自动静默');
  if (quiet) quietItem.label += '（静默中）';

  const featureMenu = [
    flag('tts', 'enabled', '语音朗读'),
    flag('proactive', 'enabled', '主动搭话'),
    quietItem,
    flag('monitor', 'floating', '系统状态悬浮显示', false),
    flag('reminder', 'enabled', '定时提醒'),
    flag('asr', 'enabled', '语音输入（离线识别）', false)
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
    reminderItem
  ];

  /* ---------- 设置 ---------- */
  /* 更新做成一个子菜单而不是平铺两项：设置组本来就长，再往上加会挤到
   * 「清空聊天记录」。把状态写进组标题，不展开也能看到"有新版 / 正在下载"。 */
  const upd = updaterStatus();
  const updateLabel =
    upd.state === 'downloading' ? `更新（下载中 ${upd.progress}%）` :
    upd.state === 'ready' ? `更新（${upd.version} 待安装）` :
    upd.version ? `更新（有新版 ${upd.version}）` : '更新';

  const settingsMenu = [
    // 当前名字写进标签里，不用点进去就知道现在叫什么
    { label: `重命名（当前：${resolveName(cfg)}）`, click: () => { promptRename(); } },
    { label: `角色设定${personaStateLabel(cfg)}`, click: () => { promptPersona(); } },
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
    {
      label: '清空聊天记录',
      click: () => {
        try {
          fs.rmSync(path.join(app.getPath('userData'), 'chat-history.json'), { force: true });
        } catch { /* ignore */ }
        mainWindow?.webContents.send('history:cleared');
      }
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

/* 聊天分片 / 情绪 / 想法的**唯一出口**：主窗渲染层拿它累积 replyBuffer
 * （驱动 TTS 朗读与历史保存），悬浮气泡窗拿它做流式显示。
 * 别绕开这几个函数直接 webContents.send —— 气泡窗会漏字。
 *
 * ⚠️ 想法（think）走**独立一条**：它不进 replyBuffer、不进历史、不被 TTS 念。
 *    所以这个函数只发给气泡窗和主窗的显示元素，不碰任何"说出口"的累积。 */
function emitChatChunk(t) {
  try { mainWindow?.webContents.send('chat:chunk', t); } catch { /* 窗口在销毁 */ }
  bubble.appendChunk(t);
}

function emitChatEmotion(e) {
  try { mainWindow?.webContents.send('chat:emotion', e); } catch { /* ignore */ }
}

function emitChatThink(t) {
  try { mainWindow?.webContents.send('chat:think', t); } catch { /* ignore */ }
  bubble.appendThink(t);
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

/* 把 llm.js 的 streamLLM 接到窗口上。
 * 依赖注入的代价就是这里多一层胶水 —— 但换来 llm.js 完全不碰窗口，
 * 可以脱离 Electron 单独 require 与测试。 */
function chatStream(messages) {
  const cfg = loadConfig();
  return streamLLM(messages, {
    ...cfg.llm,
    send: emitChatChunk,
    sendEmotion: emitChatEmotion,
    sendThink: emitChatThink
  }).then((res) => {
    /* 助手腔短语**拦不住** —— 流式的字已经进气泡了，事后删不掉。
     * 这里只统计，用来判断提示词（config.js 的 style / format）到底管不管得住：
     * 日志里频繁出现就说明该把禁用语写得更狠，或者升级成"边收边扣"的硬拦。 */
    if (res && Array.isArray(res.tone) && res.tone.length) {
      console.warn('[chat] 助手腔命中（提示词没管住）:', res.tone.join(' / '));
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
    if (ignore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
    else mainWindow.setIgnoreMouseEvents(false);
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
    const b = mainWindow.getBounds();
    mainWindow.setBounds({
      x: Math.round(b.x + dx),
      y: Math.round(b.y + dy),
      width: SIZE.w,
      height: SIZE.h
    });
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
    onUserDragEnd();
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

  /* ---- 在角色身上右键弹出的快捷菜单 ---- */
  ipcMain.on('pet:context-menu', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const cfg = loadConfig();
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
          { label: `角色设定${personaStateLabel(cfg)}`, click: () => { promptPersona(); } },
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

  ipcMain.handle('chat:send', async (_e, messages) => {
    // 悬浮气泡：这一轮对话从现在开始显示（浮窗关着时是 no-op）
    bubble.beginStream();
    try {
      // 本地能答的先答（系统状态 / 定时提醒 / 番茄钟），答不了的才交给对话后端
      const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
      try {
        const local = await tryLocalIntent(last?.content);
        if (local) { bubble.endStream(); return local; }
      } catch (err) {
        console.warn('[intent] 本地意图处理失败:', String(err?.message || err));
      }
      const cfg = loadConfig();
      const res = await chatStream([{ role: 'system', content: resolvePersona(cfg) }, ...messages]);
      if (res?.ok) bubble.endStream(); else bubble.abortStream();
      return res;
    } catch (err) {
      bubble.abortStream();
      throw err;
    }
  });

  ipcMain.handle('config:get', () => {
    const cfg = loadConfig();
    return { ...cfg, llm: { ...cfg.llm, apiKey: cfg.llm.apiKey ? '***' : '' } };
  });

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
   * 主人闲置久了由主进程挑话头，走同一条流式通道，渲染层不用区分。 */
  ipcMain.handle('chat:proactive', async () => {
    const cfg = loadConfig();
    if (cfg.proactive?.enabled === false) return { ok: false, error: 'disabled' };
    bubble.beginStream();
    try {
      const res = await chatStream([
        { role: 'system', content: resolvePersona(cfg) },
        {
          role: 'user',
          content: '（主人已经有一阵子没搭理你了。主动开个话头，一句话就够，' +
                   '别问"在忙吗"这种客套，按你的性子随口说点什么。）'
        }
      ]);
      if (res?.ok) bubble.endStream(); else bubble.abortStream();
      return res;
    } catch (err) {
      bubble.abortStream();
      throw err;
    }
  });

  /* say() 类整段播报进浮窗：渲染层的提醒 / 番茄钟 / 离线搭话走这两条 */
  ipcMain.on('pet:float-say', (_e, p) => {
    const o = typeof p === 'string' ? { text: p } : (p && typeof p === 'object' ? p : {});
    const ms = Number(o.ms);
    bubble.showFull(String(o.text || ''), Number.isFinite(ms) && ms > 0 ? ms : undefined);
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

    createWindow();
    createTray();
    startCursorPolling();

    /* 换显示器 / 改系统缩放后自动适配。
     *
     * 三个事件都要听：拔插屏是 added/removed，改缩放或分辨率是 metrics-changed。
     * 处理逻辑：
     *   - 尺寸变了 → 直接落回右下角（窗口变大后原位置很可能已经越界）；
     *   - 尺寸没变（只是换了块屏）→ 走 getInitialBounds 的可见性检查，
     *     位置还在屏幕内就原地不动，跑到屏幕外才拉回右下角。
     * ⚠️ 一律用 setBounds 带死宽高 —— 透明无边框窗口上 setPosition 会
     *    触发 DWM 边框重算、把窗口撑大（见 pet:drag-move 的注释）。 */
    const onDisplayChanged = () => {
      const resized = refreshWinSize();
      if (!mainWindow) return;
      // 重定位也按窗口当前所在的那块屏算
      const { workArea } = currentDisplay();
      let x;
      let y;
      if (resized) {
        ({ x, y } = cornerPos(workArea, SIZE.w, SIZE.h, MARGIN));
      } else {
        ({ x, y } = getInitialBounds());
      }
      mainWindow.setBounds({ x, y, width: SIZE.w, height: SIZE.h });
      /* 窗口被重新落位了 → 「家」跟着走。
       * 不跟的话，家里那个坐标已经不属于任何屏幕，她一回位就会被拉到
       * 看不见的地方去（拔掉外接屏之后尤其明显）。 */
      setHome(x, y);
    };
    screen.on('display-added', onDisplayChanged);
    screen.on('display-removed', onDisplayChanged);
    screen.on('display-metrics-changed', onDisplayChanged);

    refreshStatsTimer();
    startIdleWatcher();
    refreshQuietWatcher();
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
    disposeMotion();
    disposeReminders();
    /* 常驻的采样进程必须显式杀掉：Windows 上父进程退出**不会**带走子进程，
     * 留着它就是一个永远在跑的 powershell.exe。 */
    stopFullscreenWatch();
    stopSensorWatch();
    try { httpServer?.close(); } catch { /* ignore */ }
  });
}
