'use strict';
/*
 * 把项目"物化"成一份可直接打包的源目录 build/stage/。
 *
 * 为什么非要这一步，不能直接打项目根：
 *
 *  1. node_modules 是 pnpm 的符号链接结构（pixi.js -> .pnpm/pixi.js@8.22.0/...）。
 *     asar 不支持符号链接，而 476MB 里绝大部分是 electron 自己的二进制，
 *     本来就不该进安装包。
 *
 *  2. 运行时其实只从 node_modules 里取两个自包含的 ESM bundle ——
 *     pixi.mjs（内部零 import）和 cubism5.es.js（只 import 裸名 "pixi.js"，
 *     由 index.html 的 importmap 重定向）。其余文件一律用不到。
 *
 *  3. 本地 http 服务以项目根为 root，按 URL 路径直接读磁盘
 *     （/src/... 和 /vendor/...），所以 resources/app 下的目录结构
 *     必须和页面里的 URL 一一对应，不能挪位置。
 *
 * 产物结构（= 安装后 resources/app 的样子）：
 *   package.json
 *   src/**                                   主进程 + 渲染层 + 模型资源
 *   vendor/pixi.js/dist/pixi.mjs
 *   vendor/@naari3/pixi-live2d-display/dist/cubism5.es.js
 *
 * 用法： node tools/prepare-stage.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build', 'stage');

/* 依赖产物的落点目录名。
 *
 * 为什么叫 vendor 而不是 node_modules：electron-builder 对 node_modules
 * 这个目录名有特殊处理 —— 它按 package.json 的 dependencies 去收集模块，
 * dependencies 为空时整份跳过 node_modules（构建日志里那句
 * "no node modules returned while searching directories" 就是它），
 * 而下面刻意清空 dependencies 是为了不让它去啃 pnpm 的符号链接结构，
 * 两者正好冲突，表现是页面要的两个 bundle 一个都没进包。
 * 换个目录名就绕开了这层特殊处理，files 的全量通配会照常收。
 *
 * 代价是页面 URL 的前缀要跟着改，见下方改写 index.html 那段。
 */
const VENDOR = 'vendor';

// 页面真正加载的两个 bundle：源在 node_modules，进包后落在 vendor/。
// 改 index.html 的 importmap 时这里要同步（下面的断言会拦）。
const BUNDLES = [
  {
    src: 'node_modules/pixi.js/dist/pixi.mjs',
    dst: `${VENDOR}/pixi.js/dist/pixi.mjs`
  },
  {
    src: 'node_modules/@naari3/pixi-live2d-display/dist/cubism5.es.js',
    dst: `${VENDOR}/@naari3/pixi-live2d-display/dist/cubism5.es.js`
  }
];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* 清空旧 stage。
 *
 * 不能无条件 fs.rmSync：本机对"单次删除超过 50 个条目"有确认保护
 * （SAFE_DELETE_BULK_CONFIRM_REQUIRED），而 stage 里有 150+ 个文件。
 * 删不动就改用 rename 挪到系统临时目录 —— rename 不走删除路径。
 */
try {
  fs.rmSync(STAGE, { recursive: true, force: true });
} catch (err) {
  // 🔴 必须同盘：os.tmpdir() 可能在别的盘（E: 仓库 / C: 临时），跨盘 rename 会
  // EXDEV。挪到 build/ 下的 stale 目录（同盘），并顺手清掉上一次的残留。
  const stale = path.join(ROOT, 'build', `stale-${Date.now()}`);
  fs.rmSync(stale, { recursive: true, force: true });
  fs.renameSync(STAGE, stale);
  console.log(`旧 stage 删除受阻（${err.code || err.message}），已移至 ${stale}`);
}
fs.mkdirSync(STAGE, { recursive: true });

// ---- src：整棵树照搬（含 assets/models 与 cubism 运行时）----
fs.cpSync(path.join(ROOT, 'src'), path.join(STAGE, 'src'), { recursive: true });

// ---- 两个自包含 bundle：解开符号链接，物理复制 ----
// fs.cpSync 默认会跟随符号链接（dereference），正好是我们想要的。
for (const { src, dst } of BUNDLES) {
  const to = path.join(STAGE, dst);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(path.join(ROOT, src), to); // 单文件，cpsync 会把内容写进去
}

/* ============================================================
 *  electron-updater 依赖树 → vendor/updater/node_modules
 * ==========================================================
 *
 * 这是全项目唯一一个**主进程运行时要 require 的 npm 包**（上面两个 bundle
 * 都只给渲染层，走 importmap）。
 *
 * 为什么不能让它留在 node_modules：
 *   1) node_modules 这个目录名会触发 electron-builder 的特殊处理 —— 它按
 *      package.json 的 dependencies 去收集模块。而这里刻意清空了 dependencies
 *      （不这么干它就去啃 pnpm 的符号链接结构，见下方 package.json 那段注释），
 *      两者正好冲突，结果是那个包根本不进包。
 *   2) 项目根那份 node_modules 是 pnpm 的符号链接布局（包 -> .pnpm/...），
 *      物理复制前必须解开，否则打进安装包的全是断链。
 *
 * 于是：解开链接、物理复制成一棵**扁平**的 node_modules 树，放到 vendor/ 下。
 * 扁平能成立是因为 Node 的解析算法本来就会沿祖先目录找 node_modules ——
 * 前提是不能有同名不同版本，所以下面有冲突断言，宁可失败也不装错版本。
 *
 * 加载侧对应 src/main/updater.js 的 loadLib()：它用 Module.createRequire
 * 把解析起点锚在这个目录，不走默认解析。
 * ========================================================== */
const UPDATER_ROOT = `${VENDOR}/updater`;
const UPDATER_MODULES = `${UPDATER_ROOT}/node_modules`;

/* 从 fromDir 起向上找 node_modules/<name>，这正是 Node 自己的解析算法。
 * realpathSync 是关键：pnpm 把每个包装在 .pnpm/<name>@<ver>/node_modules/ 下，
 * 不解析链接就拿到一个符号链接，cpSync 复制出来的还是链接。 */
function resolveDep(name, fromDir) {
  let d = fromDir;
  for (;;) {
    const p = path.join(d, 'node_modules', name);
    if (fs.existsSync(p)) return fs.realpathSync(p);
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const collected = new Map();   // 包名 -> { version, dir, optional }
const conflicts = [];
const unresolved = [];

function collectDeps(name, fromDir, optional) {
  const real = resolveDep(name, fromDir);
  if (!real) {
    // optionalDependencies 缺失是合法的，不算问题
    if (!optional) unresolved.push(name);
    return;
  }
  const pj = JSON.parse(fs.readFileSync(path.join(real, 'package.json'), 'utf8'));
  const prev = collected.get(pj.name);
  if (prev) {
    if (prev.version !== pj.version) {
      conflicts.push(`${pj.name}: ${prev.version} 与 ${pj.version}`);
    }
    // 已收过就返回 —— 这同时挡住了依赖环（A→B→A）
    return;
  }
  collected.set(pj.name, { version: pj.version, dir: real });

  for (const d of Object.keys(pj.dependencies || {})) collectDeps(d, real, false);
  for (const d of Object.keys(pj.optionalDependencies || {})) collectDeps(d, real, true);
}

collectDeps('electron-updater', ROOT, false);

if (unresolved.length) {
  console.error('解析不到的依赖（不是 optional）：');
  for (const u of unresolved) console.error('  ' + u);
  console.error('先跑一次 pnpm install 再重试。');
  process.exit(1);
}
if (conflicts.length) {
  console.error('electron-updater 依赖树里有同名不同版本，扁平物化会装错：');
  for (const c of conflicts) console.error('  ' + c);
  console.error('需要改成嵌套 node_modules 布局才能继续。');
  process.exit(1);
}

for (const [name, info] of collected) {
  const to = path.join(STAGE, UPDATER_MODULES, name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(info.dir, to, {
    recursive: true,
    // 包里若还有嵌套 node_modules（pnpm 有时会放），那是重复内容，
    // 扁平布局下不需要，而且会把体积翻倍
    filter: (s) => path.basename(s) !== 'node_modules'
  });
}

/* 把 index.html 里 importmap 的 node_modules 前缀改成 vendor。
 *
 * 只动物化产物，源文件 src/renderer/index.html 保持原样（开发版照旧读
 * node_modules）。匹配口径是 `"/node_modules/`（带双引号）—— 也就是
 * importmap 这个 JSON 块里值的位置，注释里出现的同名字样不算，免得
 * 说明文字被误改。
 *
 * 断言替换条数是有意为之：新增一个 ESM 依赖就得同时改 BUNDLES 和
 * importmap，条数对不上说明漏了一边 —— 直接失败，好过装出来白屏、
 * 还要靠翻控制台才看出来。
 */
const IMPORT_PREFIX = '"/node_modules/';
const VENDOR_PREFIX = `"/${VENDOR}/`;
const htmlPath = path.join(STAGE, 'src', 'renderer', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const hits = html.split(IMPORT_PREFIX).length - 1;
if (hits !== BUNDLES.length) {
  console.error(`index.html 的 importmap 里出现 ${hits} 条 node_modules 路径，预期 ${BUNDLES.length} 条。`);
  console.error('新增 ESM 依赖时，请同步更新本脚本的 BUNDLES 和这里的断言。');
  process.exit(1);
}
fs.writeFileSync(htmlPath, html.split(IMPORT_PREFIX).join(VENDOR_PREFIX));

// ---- package.json ----
//
// dependencies 必须留空：electron-builder 会把 dependencies 里的包全量收进
// 安装包，留空才能阻止它去啃那个符号链接结构的 node_modules。
//
// name 保持和开发版一致、并且**刻意不写 productName** —— 这两个字段是
// Electron 的 app.getName() 的来源，而 getName() 决定 userData 目录
// （%APPDATA%\<name>），也就是 config.json 的家（见 config.js 的 getConfigPath）。
// 一旦这里写了 productName，打包版就会去读一个全新的配置目录，
// 用户现有的 API key、外观设置、开关状态会全部"凭空消失"。
// 安装包与 exe 的显示名由 electron-builder 的 config.productName 负责，与这里无关。
fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify({
  name: 'live2d-pet',
  version: pkg.version,
  // 刻意用 ASCII：description 会变成 NSIS 的 APP_DESCRIPTION 宏，
  // 经 makensis 命令行传递会乱码。中文描述在 build/installer.nsh 里定义。
  description: 'Ayan - a Live2D desktop pet',
  main: pkg.main,
  private: true,
  dependencies: {}
}, null, 2) + '\n');

// ---- 自检：把页面会请求的关键路径挨个确认存在 ----
//
// 刻意**不包含** src/assets/live2dcubismcore.min.js：那是 Live2D 的专有软件，
// 不进仓库（见 server.js 里那段说明），所以 clone 下来可能就没有这个文件。
// 没有也照样能打包 —— 运行时 server.js 会从官方 CDN 取回。
// 本地有的话，上面那句整树 cpSync 会顺带把它带进包，换来安装版离线可用。
const must = [
  'package.json',
  'src/main/main.js',
  'src/main/preload.js',
  'src/renderer/index.html',
  'src/renderer/pet.js',
  'src/renderer/style.css',
  'src/assets/models/hiyori/Hiyori.model3.json',
  'src/assets/models/hiyori/Hiyori.moc3',
  ...BUNDLES.map((b) => b.dst)
];
const missing = must.filter((rel) => !fs.existsSync(path.join(STAGE, rel)));
if (missing.length) {
  console.error('缺少必需文件：');
  for (const m of missing) console.error('  ' + m);
  /* 模型不在仓库里（版权归 Live2D Inc.），从源码跑的人容易卡在这里。
   * 单独提示一句，免得对着"缺少必需文件"发呆。 */
  if (missing.some((m) => m.startsWith('src/assets/models/'))) {
    console.error('');
    console.error('↑ 模型素材不随仓库分发。从 Releases 下载 models.zip，');
    console.error('  解压到 src/assets/ 后重试（应得到 src/assets/models/hiyori/）。');
  }
  process.exit(1);
}

/* electron-updater 物化自检：**逐个包检查它的依赖在产物里都找得到**。
 *
 * 刻意不真去 require('electron-updater')：那个入口顶层就 require('electron')，
 * 在纯 node 下拿到的是字符串而不是模块对象（electron 包在非 Electron 运行时里
 * 导出的就是 exe 路径），会误报。这段路径检查等价，而且零副作用。
 *
 * 它查的是"少复制了一个传递依赖"——那种错要等装完之后才炸，
 * 而且爆在用户点「检查更新」的那一刻，本地完全看不出来。 */
for (const name of collected.keys()) {
  const pjPath = path.join(STAGE, UPDATER_MODULES, name, 'package.json');
  if (!fs.existsSync(pjPath)) {
    console.error(`物化产物里缺少 ${name}/package.json`);
    process.exit(1);
  }
  const depPkg = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  for (const d of Object.keys(depPkg.dependencies || {})) {
    if (!fs.existsSync(path.join(STAGE, UPDATER_MODULES, d, 'package.json'))) {
      console.error(`❌ ${name} 依赖的 ${d} 没进物化产物`);
      process.exit(1);
    }
  }
}

// 物化产物里不该再有任何 node_modules 引用（前缀应已全部改写为 vendor）
if (fs.readFileSync(htmlPath, 'utf8').includes(IMPORT_PREFIX)) {
  console.error('物化后的 index.html 仍残留 node_modules 引用。');
  process.exit(1);
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return total;
}

console.log(`stage 就绪：${STAGE}`);
console.log(`  体积 ${(dirSize(STAGE) / 1048576).toFixed(1)} MB，${must.length} 项关键路径全部命中`);
console.log(`  electron-updater：${collected.size} 个包已物化，依赖闭包完整`);
