'use strict';
/*
 * 安装包冒烟测试：静默安装 → 检查文件落地 → 启动应用 → 卸载。
 *
 * 用 Node 的 spawnSync 而不是 shell：安装包路径含中文，且 NSIS 的 /D 参数
 * （/D=C:\...）在 Git Bash 下会被 MSYS 当成路径改写掉，交给 Node 最省事。
 *
 * 静默模式（/S）不会显示自定义页面，所以 $WantDesktop 等变量为空 ——
 * 按 installer.nsh 的逻辑，等于「没勾任何快捷方式」。这里正好顺带验证
 * 「不勾就不建」这条路径；勾选生效的路径需要人工点界面。
 *
 * 用法： node debug/install-smoke.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// 同 acceptance.js：跟着版本走，且必须是 ASCII 名（见 build-installer.js 的注释）
const SETUP = path.join(ROOT, 'dist', `Ayan-Setup-${require(path.join(ROOT, 'package.json')).version}.exe`);
const DEST = path.join(process.env.LOCALAPPDATA, 'Temp', 'ayan-smoke');

function run(exe, args, label) {
  console.log(`\n$ ${label}`);
  const r = spawnSync(exe, args, { stdio: 'inherit', windowsHide: false });
  console.log(`  exit=${r.status} ${r.error ? r.error.message : ''}`);
  return r.status;
}

if (!fs.existsSync(SETUP)) {
  console.error('找不到安装包：' + SETUP);
  process.exit(1);
}

// 上一轮残留先清掉（NSIS 会在已有安装上走"升级"分支，干扰判断）
if (fs.existsSync(DEST)) {
  console.log(`清理旧目录 ${DEST}`);
  fs.rmSync(DEST, { recursive: true, force: true });
}

// ---- 1. 静默安装 ----
// /D 必须是最后一个参数，且不能加引号（NSIS 的规矩）
const st = run(SETUP, ['/S', `/D=${DEST}`], `"${path.basename(SETUP)}" /S /D=${DEST}`);
if (st !== 0) {
  console.error('安装返回非 0，后续检查跳过。');
  process.exit(st);
}

// ---- 2. 检查落地文件 ----
const checks = [
  'Ayan.exe',
  'resources/app/package.json',
  'resources/app/src/main/main.js',
  'resources/app/src/renderer/index.html',
  'resources/app/vendor/pixi.js/dist/pixi.mjs',
  'resources/app/vendor/@naari3/pixi-live2d-display/dist/cubism5.es.js',
  'resources/app/src/assets/models/hiyori/Hiyori.moc3',
  'Uninstall Ayan.exe'
];
console.log('\n落地文件：');
let bad = 0;
for (const rel of checks) {
  const p = path.join(DEST, rel);
  const ok = fs.existsSync(p);
  if (!ok) bad++;
  console.log(`  ${ok ? 'OK  ' : 'MISS'} ${rel}`);
}

// ---- 3. 快捷方式：静默安装不应创建 ----
const desk = path.join(process.env.USERPROFILE, 'Desktop', '阿岩.lnk');
const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', '阿岩.lnk');
console.log('\n快捷方式（静默安装应都不存在）：');
console.log(`  ${fs.existsSync(desk) ? '存在' : '不存在'} 桌面`);
console.log(`  ${fs.existsSync(startMenu) ? '存在' : '不存在'} 开始菜单`);

// ---- 4. 启动应用 ----
// 两个观测点：
//   a) stdout/stderr 重定向到文件 —— 主进程会把渲染层的 console 转发成
//      [renderer] 前缀，所以 pixi 加载失败、资源 404 这类问题在这里能看见。
//   b) PET_SNAPSHOT=1 让渲染层截一张图，落到 <PROJECT_ROOT>/debug/。
//      打包后 PROJECT_ROOT = resources/app，有截图就等于渲染层真的跑起来
//      并把模型画出来了 —— 比"进程还活着"强得多。
const exe = path.join(DEST, 'Ayan.exe');
const appLog = path.join(__dirname, 'smoke-app.log');
const fd = fs.openSync(appLog, 'w');
console.log(`\n启动： ${exe}`);
console.log(`  日志： ${appLog}`);
const child = spawn(exe, [], {
  detached: true,
  stdio: ['ignore', fd, fd],
  env: { ...process.env, PET_SNAPSHOT: '1' }
});
child.unref();
console.log(`  pid=${child.pid}`);
console.log(`\n等 25 秒后看 ${appLog} 与 ${path.join(DEST, 'resources', 'app', 'debug')}`);
