/* 脱离 Electron 校验托盘菜单结构。
 *
 * 直接起 app 看不到菜单树（原生菜单抓不出来），所以改成：
 * 从 main.js 里把 buildMenuTemplate() 的源码**切出来**，塞进 vm 沙箱，
 * 用一堆桩函数替掉 Electron 依赖，然后截获传给 Menu.buildFromTemplate 的模板，
 * 打印成缩进树。改菜单后跑一下就知道层级对不对、有没有丢条目。
 *
 *   node debug/tray-dump.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* 剖源码前必须把行尾统一成 \n。
 *
 * ⚠️ 本仓库 .gitattributes 是 `* text=auto` 且 core.autocrlf=true：任何一次
 *    git checkout / 全新 clone 都会把工作区文件写成 **CRLF**，而下面那些
 *    `indexOf('\n}\n')` 式的切片是按 LF 写的 —— 文件是 CRLF 时一处都切不到，
 *    报出来的却是"找不到 XXX 的结尾"，看着像被剖的代码写错了
 *    （2026-10-13 实际踩过：一次 git checkout 之后 tray-dump 就挂了）。 */
const readSrc = (rel) =>
  fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const src = readSrc('src/main/main.js');
/* 版本号从 package.json 读，不手抄 —— 这里原先写死 '0.1.0'，
 * 而包已经发到 0.1.3 了它还照报旧值（手抄副本脱节的活证据）。 */
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// 切出函数源码：从 `function NAME(` 到下一个行首的 `}`
const sliceFn = (name) => {
  const head = src.indexOf(`function ${name}(`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = src.indexOf('\n}\n', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return src.slice(head, tail + 3);
};

/* appearanceSubmenu 是 buildMenuTemplate 的依赖（外观三项与右键菜单共用），
 * 必须一起切进沙箱 —— 否则跑到它就是一个 ReferenceError，
 * 报错信息会指向「沙箱里没这个符号」，很容易误判成菜单代码写错了。 */
const fnSrc = [
  sliceFn('appearanceSubmenu'),
  sliceFn('personaStateLabel'),
  /* 「模型接入」的组标题靠它算（2026-10-29 加）。它只依赖 providerById，
   * 后者从 llm-providers 真实 require 进来 —— 别在桩里手写一份标签逻辑，
   * 那样测出来的标题跟真跑的不一样。 */
  sliceFn('llmLabelText'),
  /* 语音接入那一行显示「语音接入（OpenAI 兼容）」这种标题，靠它算。
   * 2026-10-31 补：这张 dump 之前一直红在这里（ttsProviderLabel is not
   * defined），菜单改没改都看不出来 —— 缺的就是这一句。 */
  sliceFn('ttsProviderLabel'),
  /* 「配置档」子菜单（2026-10-30 加）是 main.js 自己的函数，一起切进来。 */
  sliceFn('llmProfilesSubmenu'),
  sliceFn('personalitySubmenu'),
  sliceFn('oneshotSubmenu'),
  sliceFn('buildMenuTemplate')
].join('\n');

/* 菜单里显示的「大小（100%）」「不透明度（100%）」是算出来的，所以沙箱里
 * 还得有 LIMITS 与两个钳位函数。
 *
 * ⚠️ 这两个不要手抄：手抄的副本跟源码一脱节，测出来的百分比就是假的。
 *    直接按名从源码里切 —— LIMITS 住在 config.js（它 require electron，
 *    在这里不能真的 load，只能剖源码）。 */
const sliceLineConst = (source, name) => {
  const m = source.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`找不到 ${name}`);
  return m[0];
};
const sliceObjConst = (source, name) => {
  const head = source.indexOf(`const ${name} = {`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = source.indexOf('\n};', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return source.slice(head, tail + 3);
};
/* 数组常量（`const X = [ ... ];`）。PERSONA_PARTS 用它 ——
 * personaStateLabel 要按它数"改了几项"，切进来才知道有几项。 */
const sliceArrConst = (source, name) => {
  const head = source.indexOf(`const ${name} = [`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = source.indexOf('\n];', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return source.slice(head, tail + 3);
};

/* config.js 里的函数切法（main.js 那个 sliceFn 绑死了 main.js 的源码，
 * 这里需要能对任意源码切片，所以单独一个）。 */
function sliceFn2(source, name) {
  const head = source.indexOf(`function ${name}(`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = source.indexOf('\n}\n', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return source.slice(head, tail + 3);
}

const cfgSrc = readSrc('src/main/config.js');
const constSrc = [
  sliceObjConst(cfgSrc, 'LIMITS'),
  /* 🔴 DEFAULT_CONFIG 必须**从源码切**，不能手抄：菜单里每个复选框的勾选态
   * 都来自它（isOn 读的就是这份默认值），手抄副本一脱节，dump 出来的
   * "默认勾了哪些"就是假的 —— 而"哪些该默认关"恰恰是这里最想验的东西
   * （2026-10-13 之前这里是一份手写的桩，勾选态完全不可信）。 */
  sliceObjConst(cfgSrc, 'DEFAULT_CONFIG'),
  sliceLineConst(src, 'clampScale'),
  sliceLineConst(src, 'clampOpacity'),
  /* 菜单标签里要显示「重命名（当前：XX）」，XX 由 resolveName 算出来。
   * 这个函数住在 config.js，同样**从源码切、不手抄** —— 手抄的话
   * 一旦改了名字兜底逻辑，dump 出来的标签就是假的。 */
  sliceLineConst(cfgSrc, 'DEFAULT_NAME'),
  sliceFn2(cfgSrc, 'resolveName'),
  /* 「角色设定」标签的后缀由 personaStateLabel 数 personaParts 里改了几项，
   * 它要遍历 PERSONA_PARTS。PERSONA_PARTS 的 def 又用了 EMOTION_TAGS，
   * 两个都从源码切。 */
  sliceLineConst(cfgSrc, 'EMOTION_TAGS'),
  sliceArrConst(cfgSrc, 'PERSONA_PARTS'),
  /* 「人设」子菜单列的就是这张表（P1 六套预设，2026-10-30 加）。同样从源码切。 */
  sliceArrConst(cfgSrc, 'PERSONA_PRESETS'),
  /* ⚠️ SCALE_STEP 也要**从源码切**。它是 `const SCALE_STEP = LIMITS.scale.step`
   *    这种派生写法，以前这里是手抄的 0.06 —— 一旦调了 LIMITS.scale.step，
   *    dump 出来的"放大 / 缩小"步长就是假的，而且不会有任何报错。
   *    必须排在 LIMITS 之后（它要拿 LIMITS 算）。 */
  sliceLineConst(src, 'SCALE_STEP')
].join('\n');

let captured = null;
const calls = [];
const rec = (name) => (...a) => { calls.push(name + '(' + a.map((x) => JSON.stringify(x)).join(',') + ')'); };

const sandbox = {
  console,
  /* ⚠️ loadConfig / isOn **不在这里手写**，见下面 vm.runInContext 那段：
   *    它们是 Node 侧的闭包，看不见 vm 里的词法常量 DEFAULT_CONFIG，
   *    必须放进 vm 里定义才能真的读到默认值。 */
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  pomodoroStatus: () => null,
  app: { getLoginItemSettings: () => ({ openAtLogin: false }), getPath: () => 'X', quit: rec('quit') },
  Menu: { buildFromTemplate: (t) => { captured = t; return { __menu: true }; } },
  patchConfig: rec('patchConfig'),
  refreshTrayMenu: rec('refreshTrayMenu'),
  refreshStatsTimer: rec('refreshStatsTimer'),
  /* motion.js 的对外面（2026-10-13 改过一轮：原来的 resetWanderTimer 换成了
   * refreshWanderConfig + 一堆用户上手钩子）。桩里照抄当前导出面 ——
   * 少一个 main.js 就会在 require 出 undefined、调用时抛 "not a function"，
   * 报错信息完全指不到这里。 */
  refreshWanderConfig: rec('refreshWanderConfig'),
  cancelMoveAnim: rec('cancelMoveAnim'),
  cancelAutoMotion: rec('cancelAutoMotion'),
  isMoveAnimRunning: () => false,
  setMotionPaused: rec('setMotionPaused'),
  animateTo: rec('animateTo'),
  edgeSnap: rec('edgeSnap'),
  setHome: rec('setHome'),
  startIdleWatcher: rec('startIdleWatcher'),
  onUserDragMove: rec('onUserDragMove'),
  onUserDragEnd: rec('onUserDragEnd'),
  notifyUserActivity: rec('notifyUserActivity'),
  setIdleOverride: rec('setIdleOverride'),
  startWander: rec('startWander'),
  stopWander: rec('stopWander'),
  wanderState: () => ({ mode: 'idle', wanderMoved: false, homePos: null, gen: 0, armed: 0 }),
  currentDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  disposeMotion: rec('disposeMotion'),
  syncAppearance: rec('syncAppearance'),
  /* buildMenuTemplate 里「全屏时自动静默」那一项会读模块级的 quiet 变量
   * 往标签后面加「（静默中）」。这个变量在沙箱里不存在 → ReferenceError，
   * 而报错信息只会说"quiet is not defined"，很容易被误判成菜单代码写错了。
   * 想验「静默中」的标签长什么样，把这个改成 true 再跑。 */
  quiet: false,
  refreshQuietWatcher: rec('refreshQuietWatcher'),
  bumpScale: rec('bumpScale'),
  resetScale: rec('resetScale'),
  setOpacity: rec('setOpacity'),
  toggleVisible: rec('toggleVisible'),
  moveToCorner: rec('moveToCorner'),
  startPomodoro: rec('startPomodoro'),
  stopPomodoro: rec('stopPomodoro'),
  addReminder: rec('addReminder'),
  clearReminders: rec('clearReminders'),
  toast: rec('toast'),
  promptRename: rec('promptRename'),
  promptPersona: rec('promptPersona'),
  /* ---- 模型接入（2026-10-29）----
   * 目录与判定**真实 require**：llm-providers.js 是纯数据/纯函数、不碰 electron，
   * 手抄一份到桩里只会让 dump 出来的菜单与真菜单悄悄脱节。 */
  ...require('../src/main/llm-providers'),
  /* ---- 语音接入（2026-10-31 补）----
   * 2026-10-30 加「语音接入」子菜单时 dump 没跟上，之后这张 dump 一直是红的
   * （ttsProviderLabel / ttsCurrentProviderId not defined）—— 菜单改没改都
   * 看不出来。tts-providers.js 是纯数据/纯函数（零 require），直接真 require；
   * `PROVIDERS` 在 main.js 里以 TTS_PROVIDERS 的名字用，这里照样补一个别名。 */
  ...require('../src/main/tts-providers'),
  TTS_PROVIDERS: require('../src/main/tts-providers').PROVIDERS,
  /* ---- 状态三档（2026-10-31 补）---- 同上：presence.js 零 require，直接真 require；
   * `MODES` 在 main.js 里叫 PRESENCE_MODES。 */
  ...require('../src/main/presence'),
  PRESENCE_MODES: require('../src/main/presence').MODES,
  /* ---- 人设护栏（2026-10-31 补）---- main.js 里 `normalizeLevel` 别名成 guardLevel。 */
  ...require('../src/main/persona-guard'),
  guardLevel: require('../src/main/persona-guard').normalizeLevel,
  /* ---- MCP 工具（2026-10-31 补）---- 菜单要列已配置的 MCP server 数量。
   * 这里给「一个都没配」的静止状态，标题就是不带后缀的那一档。 */
  mcp: { listServers: () => [], isToolEnabled: () => true, mcpReady: () => false },
  /* ---- 限时看屏授权（2026-10-31 补）---- 菜单要显示剩余分钟数；这里给
   * 「没有授权」的静止状态（active:false）。 */
  ...require('../src/main/glance-grant'),
  /* ---- LLM 配置档（2026-10-31 补）---- 标题里的「配置档（N）」靠它算。 */
  ...require('../src/main/llm-profiles'),
  /* ---- 性格 OCEAN（2026-10-31 补）---- P3 三档滑杆，菜单标签要显示当前档。 */
  ...require('../src/main/ocean'),
  OCEAN_DIMS: require('../src/main/ocean').DIMS,
  OCEAN_LEVELS: require('../src/main/ocean').LEVELS,
  normalizeOcean: require('../src/main/ocean').normalize,
  /* ---- 药盒「下一句」（2026-10-31 补）---- 纯函数模块，直接真 require。 */
  oneshot: require('../src/main/oneshot'),
  /* 读 WorkBuddy 的 models.json 是唯一带 IO 的环节，这里给桩。
   * 想验「导入有 N 条」那种标题，把 list 换成 fromWorkBuddyModels 的样例即可。 */
  readWorkBuddyModels: () => ({ file: 'X/models.json', list: [] }),
  applyLlmProvider: rec('applyLlmProvider'),
  importWorkBuddyModel: rec('importWorkBuddyModel'),
  promptLlm: rec('promptLlm'),
  testLlm: rec('testLlm'),
  URL,
  // 更新模块（src/main/updater.js）。这里返回"没有新版"的静止状态，
  // 菜单标题里就不带状态后缀；要验"有新版时标题怎么变"就改这个返回值。
  updaterStatus: () => ({ state: 'idle', version: '', current: PKG.version, progress: 0, lastError: '' }),
  checkForUpdates: rec('checkForUpdates'),
  getConfigPath: () => 'X/config.json',
  saveConfig: rec('saveConfig'),
  PROJECT_ROOT: ROOT,
  process: { execPath: 'electron.exe' },
  fs: { existsSync: () => true, rmSync: rec('rmSync') },
  shell: { openPath: rec('openPath') },
  path: { join: (...a) => a.join('/') },
  mainWindow: { webContents: { send: rec('send') } }
};

vm.createContext(sandbox);
vm.runInContext(constSrc, sandbox);   // LIMITS / DEFAULT_CONFIG / clamp* / resolveName …

/* 「人物模型」子菜单的长度由 APPEARANCE_MODELS 决定（appearanceSubmenu 里
 * `modelId` 那一行按它过滤）。这张表也**从真源码切**，别在桩里手写 ——
 * 手写就测不出"菜单里到底还剩几个模型"（2026-10-31 deepfish 退役时正是靠
 * 这里发现表一改、菜单跟着变，而不是另外维护一份）。 */
const modelsSrc = src.match(/^const APPEARANCE_MODELS = \[[\s\S]*?\n\];/m);
if (!modelsSrc) throw new Error('找不到 APPEARANCE_MODELS');
vm.runInContext(modelsSrc[0], sandbox);

/* loadConfig / isOn 必须在 **vm 内部**定义：Node 侧写的闭包看不见 vm 的
 * 词法常量（DEFAULT_CONFIG 是 `const`，不会挂到 global 上），在 Node 里
 * 引用它只会得到一个 ReferenceError。而函数声明在 vm 顶层会挂到该 context
 * 的 global 上，所以下面这两句既让 loadConfig 能被菜单代码调到，
 * 又保证 isOn 读到的就是**源码里的那份默认值**。
 *
 * loadConfig 返回深拷贝：菜单代码里到处是 `cfg.xxx` 读取，但万一有谁手滑
 * 改了一下，也不该污染后续调用（真实实现每次都是重新读文件）。 */
vm.runInContext(
  'function loadConfig() { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); }\n' +
  'function isOn(section, key, def) {\n' +
  '  const v = DEFAULT_CONFIG[section] ? DEFAULT_CONFIG[section][key] : undefined;\n' +
  '  return v === undefined || v === null ? def : !!v;\n' +
  '}', sandbox);
vm.runInContext(fnSrc, sandbox);

sandbox.buildMenuTemplate();
const top = captured;   // Menu.buildFromTemplate 的桩把模板截在这儿了
if (!top) throw new Error('没截获到模板');

let rows = 0;
let flags = 0;
const checkedFlags = [];    // 默认就勾上的功能项（给下面那行汇总用）
const dump = (items, depth) => {
  for (const it of items) {
    if (it.type === 'separator') { console.log('  '.repeat(depth) + '──────────'); continue; }
    const kind = it.type === 'checkbox' ? (it.checked ? ' [x]' : ' [ ]') : (it.type === 'radio' ? (it.checked ? ' (o)' : ' ( )') : '');
    const acc = it.accelerator ? '   { ' + it.accelerator + ' }' : '';
    const en = it.enabled === false ? '   (disabled)' : '';
    console.log('  '.repeat(depth) + '- ' + it.label + kind + acc + en);
    if (it.type === 'checkbox') { flags++; if (it.checked) checkedFlags.push(it.label); }
    if (depth === 0) rows++;
    if (it.submenu) dump(it.submenu, depth + 1);
  }
};

console.log('===== 托盘菜单结构 =====');
dump(top, 0);
console.log('\n顶层可点/可展开条目: ' + rows + '（不含分隔线），复选框 ' + flags + ' 个');
/* 这一行是「默认值取舍」的检视口（见 config.js 顶部那段红灯规则）：
 * 打扰类 / 抢资源的项不该出现在这里。 */
console.log('默认勾选: ' + (checkedFlags.length ? checkedFlags.join(' · ') : '（无）'));
