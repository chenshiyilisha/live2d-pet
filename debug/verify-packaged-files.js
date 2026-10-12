'use strict';
/*
 * 静态核对**打包产物**里的文件清单（不启动应用，秒级出结果）。
 *
 * 为什么需要这一步：electron-builder 会静默剔除它认为"不该进包"的东西，
 * 其中最隐蔽的一条是对**任意层级**名为 node_modules 的目录走它自己的依赖
 * 收集逻辑。而 stage 里偏偏有一棵刻意放在 vendor/updater 下的 node_modules
 * —— 那是主进程运行时唯一要 require 的依赖树（见 tools/prepare-stage.js）。
 *
 * 后果极难发现：构建成功、启动成功，只有一句
 *   [updater] 从 .../vendor/updater 加载失败：Cannot find module 'electron-updater'
 * 躺在日志里，updater.js 静默降级 → **自动更新永久失效**，而界面上、
 * 构建日志里都看不出任何异常。v0.1.1 / v0.1.2 两个发布版都带着这个毛病，
 * 是打便携版时顺手跑了一次打包产物才暴露出来的。
 *
 * 所以这里做的是**清单对照**：stage 里有什么，产物里就必须有什么。
 * 判据是"两边包名列表完全一致 + 每个包的入口文件真的在"，而不是"目录存在"。
 *
 * 用法：
 *   node debug/verify-packaged-files.js                  # 验 dist/win-unpacked
 *   node debug/verify-packaged-files.js <解包目录>        # 验指定目录
 *
 * 退出码：0 全绿 / 1 有问题
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build', 'stage');
const APP = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app');

let failures = 0;
const ok = (s) => console.log('  ✅ ' + s);
const no = (s) => { failures++; console.log('  ❌ ' + s); };

console.log(`核对产物：${APP}`);
console.log('');

if (!fs.existsSync(APP)) {
  console.error('找不到产物目录。先跑： node tools/build-installer.js');
  process.exit(1);
}

/* ── 1. electron-updater 依赖树：stage 与产物逐包对照 ──
 * 这是本脚本存在的主要理由。 */
const REL_UPDATER_MODULES = path.join('vendor', 'updater', 'node_modules');
const stageMods = path.join(STAGE, REL_UPDATER_MODULES);
const appMods = path.join(APP, REL_UPDATER_MODULES);

console.log('1. electron-updater 依赖树');
if (!fs.existsSync(stageMods)) {
  no(`stage 里就没有这棵树（${stageMods}），先跑 node tools/prepare-stage.js`);
} else if (!fs.existsSync(appMods)) {
  no(`产物里整棵树都不见了：${appMods}`);
  console.log('   多半是 electron-builder 的 node_modules 特殊处理又把它剔了，');
  console.log('   见 tools/build-installer.js 里 files 那段注释。');
} else {
  const want = fs.readdirSync(stageMods).sort();
  const got = new Set(fs.readdirSync(appMods));
  const missing = want.filter((n) => !got.has(n));
  if (missing.length) {
    no(`产物里缺 ${missing.length} 个包：${missing.join(', ')}`);
  } else {
    ok(`stage 里的 ${want.length} 个包，产物里一个不少`);
  }
  if (got.size > want.length) {
    console.log(`   （产物比 stage 多 ${got.size - want.length} 个条目，不一定是错，仅提示）`);
  }

  /* 光有目录不算数 —— 入口文件也得在。少复制了 out/ 之类的错，
   * 表现与"整个包不在"一模一样。
   * ⚠️ 判据要照 Node 自己的解析算法来：main 字段常常写成不带扩展名的
   *    './index' 或 'lib/index'（ms / tiny-typed-emitter 就是这样），
   *    只查字面路径会误报成"入口缺失"。 */
  let entryBad = 0;
  for (const name of want) {
    const pj = path.join(appMods, name, 'package.json');
    if (!fs.existsSync(pj)) { entryBad++; console.log(`   ❌ ${name}：缺 package.json`); continue; }
    let main = null;
    try { main = JSON.parse(fs.readFileSync(pj, 'utf8')).main; } catch { /* 坏 JSON 下面单独报 */ }
    if (!main) continue;                        // 没声明 main，交给 Node 默认解析，不判
    const entry = path.join(appMods, name, main);
    const candidates = [
      entry, entry + '.js', entry + '.json',
      path.join(entry, 'index.js'), path.join(entry, 'index.json')
    ];
    if (!candidates.some((p) => fs.existsSync(p))) {
      entryBad++;
      console.log(`   ❌ ${name}：入口 ${main} 不存在（试过 .js/.json/index.*）`);
    }
  }
  if (entryBad) no(`有 ${entryBad} 个包的入口文件缺失`);
  else ok('每个包的入口文件都在');
}

/* ── 2. app-update.yml：自动更新的配置来源 ──
 * 它在 resources/ 下（不是 resources/app/），由构建时读 publish 段生成。
 * 缺了它 electron-updater 直接不工作，同样是静默的。 */
console.log('\n2. 自动更新配置');
const resources = path.dirname(APP);            // .../resources
const yml = path.join(resources, 'app-update.yml');
if (!fs.existsSync(yml)) {
  no(`没有 ${yml}（打包版不会检查更新）`);
} else {
  const body = fs.readFileSync(yml, 'utf8');
  const hasOwner = /owner:\s*chenshiyilisha/.test(body);
  const hasRepo = /repo:\s*live2d-pet/.test(body);
  if (hasOwner && hasRepo) ok('app-update.yml 的 owner / repo 正确');
  else no('app-update.yml 的 owner / repo 不对（改名后忘了同步？）');
  /* ⚠️ 配了 publisherName 会让 electron-updater 下载完 114MB 才抛签名错，
   * 见 build-installer.js 里那段注释。 */
  if (/publisherName/.test(body)) no('app-update.yml 里出现了 publisherName（应为空）');
  else ok('app-update.yml 里没有 publisherName');
}

/* ── 3. 运行时素材：索引页 / Cubism Core / 模型 ── */
console.log('\n3. 运行时素材');
const indexHtml = path.join(APP, 'src', 'renderer', 'index.html');
if (!fs.existsSync(indexHtml)) {
  no('缺 src/renderer/index.html');
} else {
  const html = fs.readFileSync(indexHtml, 'utf8');
  /* importmap 里的路径在 prepare-stage 时被改写成 /vendor/...，
   * 残留 "/node_modules/ 说明改写那步没跑到。 */
  const leftover = (html.match(/"\/node_modules\//g) || []).length;
  if (leftover) no(`index.html 里还有 ${leftover} 处 "/node_modules/ 引用（应已改写为 /vendor/）`);
  else ok('index.html 的 importmap 已全部指向 /vendor/');
}

/* Cubism Core 与模型：仓库里刻意不含（版权），本地可能有也可能没有，
 * 所以这里只在"本地有"时要求产物里也有。 */
const core = path.join(APP, 'src', 'assets', 'live2dcubismcore.min.js');
const localCore = path.join(ROOT, 'src', 'assets', 'live2dcubismcore.min.js');
if (fs.existsSync(localCore)) {
  if (fs.existsSync(core)) ok('Cubism Core 在产物里（离线可用）');
  else no('本地有 Cubism Core，产物里却没有（打包版会退回联网取）');
} else {
  console.log('   ℹ️  本地没有 Cubism Core，跳过（打包版运行时会走 server.js 三级兜底）');
}

const modelDir = path.join(APP, 'src', 'assets', 'models');
const localModels = path.join(ROOT, 'src', 'assets', 'models');
if (fs.existsSync(localModels)) {
  const count = (d) => {
    let n = 0;
    const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(p, e.name)); else n++; } };
    if (fs.existsSync(d)) walk(d);
    return n;
  };
  const w = count(localModels), g = count(modelDir);
  if (g === w && w > 0) ok(`模型齐（${g} 个文件，与源码一致）`);
  else no(`模型数量对不上：产物 ${g} 个 / 源码 ${w} 个`);
} else {
  console.log('   ℹ️  本地没有模型素材，跳过（打包产物本应带上它们）');
}

console.log('');
if (failures) {
  console.error(`❌ ${failures} 项未通过`);
  process.exit(1);
}
console.log('✅ 打包产物文件清单核对通过');
