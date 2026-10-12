'use strict';
/* 验证 electron-updater 在**物化产物**（build/stage/vendor/updater）里能被加载。
 *
 * 为什么必须用 Electron 起，不能纯 node：
 *   electron-updater 的入口顶层就 `require('electron')`。在纯 node 下这个
 *   require 会解析到 node_modules/electron/index.js —— 它导出的是 exe 路径
 *   （一个字符串），于是后面 `electron.app.getVersion()` 直接炸。
 *   所以这个检查只能在 Electron 运行时里做。
 *
 * 为什么值得单独写一个脚本：
 *   "依赖树少复制了一个包"这类错，光看文件在不在查不出来 —— 它会一直潜伏到
 *   用户点了「检查更新」的那一刻。真加载一次是唯一可靠的判据。
 *
 * 用法（⚠️ 必须先 unset ELECTRON_RUN_AS_NODE，否则 electron 退化成纯 node）：
 *   unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe debug/verify-updater-load.js
 */
const path = require('path');
const Module = require('module');
const fs = require('fs');
const { app } = require('electron');

let failures = 0;
const ok = (s) => console.log('  ✅ ' + s);
const no = (s) => { failures++; console.log('  ❌ ' + s); };

function check(label, fn) {
  try {
    const r = fn();
    if (r === false) no(label);
    else ok(label + (typeof r === 'string' ? '  ' + r : ''));
  } catch (err) {
    no(label + '  → ' + err.message);
  }
}

app.whenReady().then(() => {
  const STAGE_UPDATER = path.join(__dirname, '..', 'build', 'stage', 'vendor', 'updater');
  console.log('物化目录:', STAGE_UPDATER);
  console.log('运行环境: Electron ' + process.versions.electron + ' / packaged=' + app.isPackaged);
  console.log('');

  console.log('1. 从物化产物加载 electron-updater');
  let mod = null;
  check('能 require 到模块', () => {
    const req = Module.createRequire(path.join(STAGE_UPDATER, '__anchor__.js'));
    mod = req('electron-updater');
    return typeof mod === 'object';
  });
  if (!mod) { app.exit(1); return; }

  check('导出了 autoUpdater', () => (!!mod.autoUpdater ? '✓' : false));
  check('autoUpdater 是 EventEmitter（有 .on）', () => typeof mod.autoUpdater.on === 'function');

  let ver = '';
  check('能读到 electron-updater 版本', () => {
    ver = JSON.parse(fs.readFileSync(path.join(STAGE_UPDATER, 'node_modules', 'electron-updater', 'package.json'), 'utf8')).version;
    return ver;
  });

  console.log('');
  console.log('2. 关键 API 可用');
  check('checkForUpdates', () => typeof mod.autoUpdater.checkForUpdates === 'function');
  check('downloadUpdate', () => typeof mod.autoUpdater.downloadUpdate === 'function');
  check('quitAndInstall', () => typeof mod.autoUpdater.quitAndInstall === 'function');
  check('currentVersion 拿得到（走 app.getVersion）', () => mod.autoUpdater.currentVersion?.raw || false || '-> ' + mod.autoUpdater.currentVersion);

  console.log('');
  console.log('3. 依赖闭包完整（逐个包实际 require 一遍）');
  const nm = path.join(STAGE_UPDATER, 'node_modules');
  const pkgs = fs.readdirSync(nm).filter((n) => fs.existsSync(path.join(nm, n, 'package.json')));
  let loaded = 0;
  for (const p of pkgs) {
    if (p === 'electron-updater') continue;
    try {
      const req = Module.createRequire(path.join(nm, '__anchor__.js'));
      req(p);
      loaded++;
    } catch (err) {
      no('加载 ' + p + ' 失败 → ' + err.message);
    }
  }
  if (loaded === pkgs.length - 1) ok(`${loaded} 个依赖全部可加载`);

  console.log('');
  console.log('4. 生产源码模块可加载');
  check('src/main/updater.js 导出齐全', () => {
    const u = require(path.join(__dirname, '..', 'src', 'main', 'updater.js'));
    const need = ['configureUpdater', 'checkForUpdates', 'startDownload', 'installUpdate', 'updaterStatus'];
    const miss = need.filter((k) => typeof u[k] !== 'function');
    if (miss.length) throw new Error('缺少导出: ' + miss.join(', '));
    return need.length + ' 个导出';
  });

  console.log('');
  console.log('5. dev-app-update.yml（开发模式更新源）');
  check('文件存在且指向正确仓库', () => {
    const p = path.join(__dirname, '..', 'dev-app-update.yml');
    if (!fs.existsSync(p)) return false;
    const t = fs.readFileSync(p, 'utf8');
    if (!/owner:\s*chenshiyilisha/.test(t) || !/repo:\s*live2d-pet/.test(t)) throw new Error('owner/repo 不对');
    return '✓';
  });

  console.log('');
  console.log(failures ? `❌ ${failures} 项失败` : '✅ 全部通过');
  app.exit(failures ? 1 : 0);
});
