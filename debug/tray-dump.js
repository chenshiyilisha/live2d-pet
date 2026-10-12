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
const src = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');

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

const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8');
const constSrc = [
  sliceObjConst(cfgSrc, 'LIMITS'),
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
  sliceArrConst(cfgSrc, 'PERSONA_PARTS')
].join('\n');

let captured = null;
const calls = [];
const rec = (name) => (...a) => { calls.push(name + '(' + a.map((x) => JSON.stringify(x)).join(',') + ')'); };

const sandbox = {
  console,
  loadConfig: () => ({
    name: '',
    persona: '',
    personaParts: {},
    appearance: { scale: 1.0, opacity: 1.0, model: 'hiyori', alwaysOnTop: true },
    motion: { enabled: true, edgeSnap: true, wander: true },
    interaction: { rightMenu: true, headPat: true, dragReact: true, pokeReact: true },
    monitor: { floating: false },
    quiet: { enabled: true, fps: 12 },
    reminder: { enabled: true },
    asr: { enabled: false },
    tts: { enabled: true },
    proactive: { enabled: true },
    hotkeys: { enabled: true }
  }),
  isOn: (s, k, def) => def,
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
  pomodoroStatus: () => null,
  SCALE_STEP: 0.06,
  app: { getLoginItemSettings: () => ({ openAtLogin: false }), getPath: () => 'X', quit: rec('quit') },
  Menu: { buildFromTemplate: (t) => { captured = t; return { __menu: true }; } },
  patchConfig: rec('patchConfig'),
  refreshTrayMenu: rec('refreshTrayMenu'),
  refreshStatsTimer: rec('refreshStatsTimer'),
  resetWanderTimer: rec('resetWanderTimer'),
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
  setModel: rec('setModel'),
  toggleVisible: rec('toggleVisible'),
  moveToCorner: rec('moveToCorner'),
  startPomodoro: rec('startPomodoro'),
  stopPomodoro: rec('stopPomodoro'),
  addReminder: rec('addReminder'),
  clearReminders: rec('clearReminders'),
  toast: rec('toast'),
  promptRename: rec('promptRename'),
  promptPersona: rec('promptPersona'),
  // 更新模块（src/main/updater.js）。这里返回"没有新版"的静止状态，
  // 菜单标题里就不带状态后缀；要验"有新版时标题怎么变"就改这个返回值。
  updaterStatus: () => ({ state: 'idle', version: '', current: '0.1.0', progress: 0, lastError: '' }),
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
vm.runInContext(constSrc, sandbox);   // LIMITS / clampScale / clampOpacity
vm.runInContext(fnSrc, sandbox);

sandbox.buildMenuTemplate();
const top = captured;   // Menu.buildFromTemplate 的桩把模板截在这儿了
if (!top) throw new Error('没截获到模板');

let rows = 0;
let flags = 0;
const dump = (items, depth) => {
  for (const it of items) {
    if (it.type === 'separator') { console.log('  '.repeat(depth) + '──────────'); continue; }
    const kind = it.type === 'checkbox' ? (it.checked ? ' [x]' : ' [ ]') : (it.type === 'radio' ? (it.checked ? ' (o)' : ' ( )') : '');
    const acc = it.accelerator ? '   { ' + it.accelerator + ' }' : '';
    const en = it.enabled === false ? '   (disabled)' : '';
    console.log('  '.repeat(depth) + '- ' + it.label + kind + acc + en);
    if (it.type === 'checkbox') flags++;
    if (depth === 0) rows++;
    if (it.submenu) dump(it.submenu, depth + 1);
  }
};

console.log('===== 托盘菜单结构 =====');
dump(top, 0);
console.log('\n顶层可点/可展开条目: ' + rows + '（不含分隔线），复选框 ' + flags + ' 个');
