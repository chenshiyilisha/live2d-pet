'use strict';
/*
 * 通过 GitHub Releases 检查并安装新版本（electron-updater）。
 *
 * 为什么是「自包含 + 注入」：
 *   本模块不 require main.js，也不碰 mainWindow / tray —— 要显示什么、要读哪份
 *   配置，全部由 main.js 通过 configureUpdater() 注入。与 tts.js / recorder.js
 *   同一套路（见主文件顶部的拆分约定）。
 *   ⚠️ 注入进来的必须是 **getter 或闭包，不能是值快照**：设置里随时可能改开关，
 *      传快照的话下一次读到的还是旧值。
 *
 * 三条硬约束，每条都是踩过坑才写下的：
 *
 * 1) **绝不能让更新拖慢或搞崩启动。**
 *    electron-updater 懒加载（loadLib），加载失败 / 网络不通一律静默降级。
 *    自动检查要延迟若干秒再跑，且不阻塞 whenReady 之后的任何初始化。
 *
 * 2) **未签名应用必须让 electron-updater 跳过签名校验。**
 *    NsisUpdater.verifySignature 只在 app-update.yml 里存在 publisherName 时
 *    才真去验签（源码 out/NsisUpdater.js:84-99 —— publisherName == null 直接
 *    return null；文件不存在 ENOENT 也 return null）。
 *    我们没有代码签名证书，所以 tools/build-installer.js 刻意**不配**
 *    publisherName。配了反而会在"下载完 114MB 之后"才抛
 *    ERR_UPDATER_INVALID_SIGNATURE —— 那种失败点极其靠后，用户白等一场。
 *
 * 3) **检查 / 下载都是有 await 的长过程，状态一律用状态机，别用 bool。**
 *    反面教材见项目记忆里录音那件事：bool 标志在 await 之后才置真，用户在
 *    窗口期内再点一次就并发跑了两份。在这里的表现会是"弹两次更新窗"、
 *    "把同一个包下载两遍"。
 */

const path = require('path');
const Module = require('module');
const { app, dialog } = require('electron');

/* 状态机。用字符串而不是数字，日志里一眼能看懂。 */
const S = {
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',     // 查到新版本，等用户决定下不下
  DOWNLOADING: 'downloading',
  READY: 'ready',             // 包已下好，等重启安装
  ERROR: 'error'
};

/* 检查更新的超时。GitHub 在国内网络时不时抽风，不设上限的话
 * "自动检查"会挂着一个永不 resolve 的请求，用户以为功能坏了。 */
const CHECK_TIMEOUT_MS = 25000;

let state = S.IDLE;
let lastError = '';
let available = null;        // { version, notes }
let progress = 0;            // 0..100
let lib = null;              // 懒加载的 electron-updater 模块；null = 不可用
let libTried = false;
let wired = false;
let checkManual = false;     // 本次检查是不是用户手点的（决定要不要出声）
let checkWaiter = null;      // 让 checkForUpdates() 能 await 到一个结论
let lastToastStep = -1;      // 下载进度 toast 的节流刻度

/* 注入面。默认值全部是"什么都不做"，这样即使 main.js 忘了注入也不会崩。 */
let hooks = {
  getCfg: () => ({}),
  toast: () => {},
  log: () => {}
};

function configureUpdater(next) {
  hooks = { ...hooks, ...next };
}

/* 懒加载 electron-updater。
 *
 * 两个候选根：
 *   打包版 → resources/app/vendor/updater/node_modules
 *   开发版 → <项目根>/node_modules
 *
 * 为什么打包版不在标准位置：prepare-stage.js 把依赖树物化到 vendor/ 下，
 * 专门绕开 electron-builder 对 **node_modules 这个目录名**的特殊处理
 * （它会去啃 pnpm 的符号链接结构，见该脚本里的长注释）。所以这里也不能
 * 靠默认的模块解析，得自己指路。
 *
 * createRequire 需要一个"锚点文件路径"，文件本身不必存在 —— 它只用来
 * 决定向上查找 node_modules 的起点。 */
function loadLib() {
  if (libTried) return lib;
  libTried = true;

  const roots = [
    path.join(__dirname, '..', '..', 'vendor', 'updater'),
    path.join(__dirname, '..', '..')
  ];
  for (const root of roots) {
    try {
      const req = Module.createRequire(path.join(root, '__updater_anchor__.js'));
      const mod = req('electron-updater');
      if (mod && mod.autoUpdater) {
        lib = mod;
        /* 打真实解析到的文件路径，不是候选目录 —— 候选根只是解析起点，
         * 打印它会出现"日志说 vendor/updater、实际加载的是根 node_modules"
         * 这种对不上的情况（开发模式下就是这样）。 */
        hooks.log('[updater] electron-updater 已加载：', req.resolve('electron-updater'));
        return lib;
      }
    } catch (err) {
      // 换下一个候选根再试；两个都失败才算不可用
      hooks.log('[updater] 从', root, '加载失败：', err.message);
    }
  }
  lib = null;
  return lib;
}

/* 把事件接上。只做一次 —— 重复 on() 会让同一个事件触发多次回调。 */
function wire(au) {
  if (wired) return;
  wired = true;

  au.autoDownload = false;          // 下载时机由我们决定（默认先问用户）
  au.autoInstallOnAppQuit = true;   // 用户选"稍后"时，退出应用再装
  au.disableWebInstaller = true;    // 不用 web 安装器；不设的话 6.x 会打个 warn
  au.allowPrerelease = false;       // 只认正式版
  au.allowDowngrade = false;

  /* 开发模式（electron.exe .）下 electron-updater 默认拒绝检查，会抛
   * "Skip checkForUpdates because application is not packed"。
   * 打开这个开关后它会去读项目根的 dev-app-update.yml，于是**开发时也能
   * 真实地查一遍 GitHub** —— 否则这套东西在打包前根本没法验证。
   * 下载在开发模式下也有意义（能验证下载链路），只是最后不能真装。 */
  if (!app.isPackaged) au.forceDevUpdateConfig = true;

  au.logger = {
    info: (m) => hooks.log('[updater]', m),
    warn: (m) => hooks.log('[updater][warn]', m),
    error: (m) => hooks.log('[updater][error]', m),
    debug: () => {}   // 调试输出太吵，丢掉
  };

  au.on('checking-for-update', () => {
    hooks.log('[updater] 正在查询 GitHub Releases…');
  });

  au.on('update-not-available', (info) => {
    state = S.IDLE;
    progress = 0;
    hooks.log('[updater] 已是最新版本', app.getVersion());
    if (checkManual) hooks.toast(`已是最新版本（${app.getVersion()}）`);
    finishCheck();
  });

  au.on('update-available', (info) => {
    const cfg = hooks.getCfg();
    const skipped = String(cfg?.update?.skippedVersion || '').trim();

    /* "跳过这个版本"：只压制**自动**检查。用户手点检查更新时照常提示 ——
     * 他既然主动点了，就是想看到结果。 */
    if (!checkManual && skipped && skipped === String(info.version)) {
      hooks.log('[updater] 该版本已被跳过：', info.version);
      state = S.IDLE;
      finishCheck();
      return;
    }

    available = { version: String(info.version), notes: notesText(info.releaseNotes) };
    state = S.AVAILABLE;
    hooks.log('[updater] 发现新版本', info.version, '（当前', app.getVersion(), '）');
    finishCheck();

    const auto = cfg?.update?.autoDownload === true;
    if (auto) startDownload();
    else promptAvailable();
  });

  au.on('download-progress', (p) => {
    progress = Math.max(0, Math.min(100, Math.round(p.percent || 0)));
    /* 进度只在跨过 25% 的整数关口时报一次 —— 每个 chunk 都 toast 会把
     * 气泡刷成跑马灯，反而看不清。 */
    const step = Math.floor(progress / 25);
    if (step > lastToastStep) {
      lastToastStep = step;
      if (progress < 100) hooks.toast(`正在下载更新… ${progress}%`);
    }
  });

  au.on('update-downloaded', (info) => {
    state = S.READY;
    progress = 100;
    hooks.log('[updater] 更新包已下载完成：', info.version);
    promptInstall();
  });

  au.on('error', (err) => {
    state = S.ERROR;
    lastError = String(err?.message || err);
    hooks.log('[updater][error]', err?.stack || lastError);
    /* 自动检查失败要**彻底安静** —— 用户没问，弹一个"检查更新失败"只会烦人。
     * 手动检查才告诉他，而且给的是人话，不是 electron-updater 的堆栈。 */
    if (checkManual) hooks.toast('检查更新失败：' + friendly(lastError));
    finishCheck();
  });
}

/* 让 checkForUpdates() 能等到"结论已定"。一次性 —— 取走就置空，
 * 免得超时/事件两条路径都来 resolve。 */
function finishCheck() {
  const w = checkWaiter;
  checkWaiter = null;
  if (w) w(status());
}

/* electron-updater 的报错文案对普通用户没有意义，挑最常见的几种翻译一下。
 * 认不出来就原样给，总比编一个错的原因好。 */
function friendly(msg) {
  const m = String(msg || '');
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|network|timeout/i.test(m)) {
    return '网络不通（github.com 可能被墙或超时）';
  }
  if (/Cannot find latest\.yml|ERR_UPDATER_CHANNEL_FILE_NOT_FOUND/i.test(m)) {
    return '发布页上缺少 latest.yml（发版时漏传了）';
  }
  if (/No published versions|ERR_UPDATER_NO_PUBLISHED_VERSIONS|404/i.test(m)) {
    return '还没有发布过任何版本';
  }
  return m.split('\n')[0].slice(0, 120);
}

/* releaseNotes 有两种来源，形状不同，都得吃得下：
 *   - latest.yml 里的 releaseNotes 字段 → 字符串（我们没写，通常是 undefined）
 *   - Atom feed 的 <content>（GitHubProvider 会用它补上）→ [{version, note}, …] */
function notesText(rn) {
  if (!rn) return '';
  if (typeof rn === 'string') return rn.trim();
  if (Array.isArray(rn)) {
    return rn.map((x) => (x && x.note ? String(x.note) : '')).filter(Boolean).join('\n\n').trim();
  }
  return '';
}

function status() {
  return { state, version: available?.version || '', current: app.getVersion(), progress, lastError };
}

/* 「发现新版本」询问框。 */
async function promptAvailable() {
  const info = available;
  if (!info) return;
  const notes = info.notes.slice(0, 900);
  let r;
  try {
    r = await dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `阿岩 ${info.version} 可以更新了（当前 ${app.getVersion()}）`,
      detail: notes
        ? `更新内容：\n\n${notes}`
        : '这个版本没有写更新说明。',
      buttons: ['下载并安装', '稍后', '跳过这个版本'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
  } catch { return; }

  if (r.response === 0) startDownload();
  else if (r.response === 2) {
    // 记下来，以后自动检查不再提示这个版本（手动检查仍会提示）
    hooks.markSkipped(info.version);
    hooks.toast(`已跳过 ${info.version}`);
  }
}

/* 下载。重复点击由状态机挡住 —— 这是第 3 条硬约束要防的就是这个。 */
function startDownload() {
  if (state === S.DOWNLOADING || state === S.READY) return;
  const l = loadLib();
  if (!l) return;
  wire(l.autoUpdater);

  state = S.DOWNLOADING;
  progress = 0;
  lastToastStep = -1;
  hooks.toast('开始下载更新…');
  hooks.log('[updater] 开始下载');

  l.autoUpdater.downloadUpdate().catch((err) => {
    // download 失败会同时触发 'error' 事件，这里只需要防 unhandled rejection
    hooks.log('[updater][error] 下载失败：', err?.message || err);
  });
}

/* 下载完成后的询问框。 */
async function promptInstall() {
  const v = available?.version || '';
  const dev = !app.isPackaged;
  let r;
  try {
    r = await dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: dev ? `${v} 已下载完成（开发模式，不会真的安装）` : `阿岩 ${v} 已下载完成`,
      detail: dev
        ? '开发模式下只验证了下到本地这一步，安装流程需要打包版才有效。'
        : '点「立即重启」会关掉当前窗口、运行安装程序。选「退出时安装」则等你下次退出阿岩时自动装。',
      buttons: dev ? ['好'] : ['立即重启安装', '退出时安装'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
  } catch { return; }

  if (dev) return;
  if (r.response === 0) installUpdate();
  // response 1（退出时安装）什么都不用做：autoInstallOnAppQuit 会在 app.quit() 时装
}

/* 立刻退出并安装。
 * ⚠️ 必须 setImmediate 推迟一帧：在事件回调 / 对话框回调里直接调
 *    quitAndInstall()，它要关窗口时当前调用栈还压在 Electron 内部，
 *    安装器起不来（表现是应用退了但什么都没发生）。 */
function installUpdate() {
  const l = loadLib();
  if (!l) return;
  if (!app.isPackaged) {
    hooks.toast('开发模式：不执行安装');
    return;
  }
  hooks.log('[updater] quitAndInstall');
  setImmediate(() => {
    try {
      l.autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      hooks.log('[updater][error] 安装失败：', err?.message || err);
    }
  });
}

/* 检查更新。
 *
 * manual=false（自动检查）时：读配置开关、失败静默、跳过版本静默。
 * manual=true（用户点菜单）时：不论配置如何都查、失败和结果都明确告诉用户。 */
function checkForUpdates({ manual = false } = {}) {
  if (state === S.CHECKING || state === S.DOWNLOADING) {
    if (manual) hooks.toast('正在处理中，请稍候…');
    return Promise.resolve(status());
  }

  checkManual = manual;

  if (!manual) {
    const cfg = hooks.getCfg();
    if (cfg?.update?.enabled === false) {
      hooks.log('[updater] 自动检查已在设置里关闭');
      return Promise.resolve(status());
    }
  }

  const l = loadLib();
  if (!l) {
    if (manual) hooks.toast('更新组件不可用（详见日志）');
    return Promise.resolve(status());
  }
  wire(l.autoUpdater);

  state = S.CHECKING;
  lastError = '';
  progress = 0;
  if (manual) hooks.toast('正在检查更新…');

  const done = new Promise((resolve) => { checkWaiter = resolve; });

  l.autoUpdater.checkForUpdates().catch((err) => {
    // 同 downloadUpdate：失败也会走 'error' 事件，这里只为吞掉 unhandled rejection
    hooks.log('[updater][error] 检查失败：', err?.message || err);
  });

  // 超时兜底。事件终究不来时必须自己收摊，否则 ui 永远停在"正在检查"。
  return Promise.race([
    done,
    new Promise((resolve) => setTimeout(() => {
      if (state === S.CHECKING) {
        state = S.IDLE;
        lastError = '检查超时';
        hooks.log('[updater] 检查超时（' + CHECK_TIMEOUT_MS + 'ms）');
        if (checkManual) hooks.toast('检查更新超时，稍后再试');
      }
      finishCheck();
      resolve(status());
    }, CHECK_TIMEOUT_MS))
  ]);
}

module.exports = {
  configureUpdater,
  checkForUpdates,
  startDownload,
  installUpdate,
  updaterStatus: status,
  UPDATER_STATES: S
};
