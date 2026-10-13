'use strict';
/*
 * 安装包最终验收（一次性跑完，输出结论）。
 *
 * ⚠️ 全程必须在启动子进程前删掉 ELECTRON_RUN_AS_NODE。
 * 会话环境里这个变量恒为 1，而它会让**任何 Electron 二进制退化成纯 Node**：
 * 现象是应用"秒退 / 退出码 0 / 不写任何日志"，看着像打包坏了，
 * 实际是我们在用 Node 跑 main.js（于是 require('electron') 直接 MODULE_NOT_FOUND）。
 * 真实用户双击 exe 时没有这个变量，所以它只是我们这边的观测陷阱。
 *
 * 覆盖三件事：
 *   1. 静默安装（验证"不勾选就不建快捷方式"）
 *   2. 安装后的应用能否在干净环境下跑起来（用 venv 无关的三重证据）
 *   3. 卸载能否清干净
 *
 * 用法： node debug/acceptance.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
/* 产物名跟着 package.json 的版本走，别硬编码 —— 改版本时漏改脚本的话，
 * 这里会静默去找一个不存在的文件。格式是 ASCII 的 Ayan-Setup-<版本>.exe，
 * 原因见 tools/build-installer.js 里 nsis.artifactName 的注释。 */
const SETUP = path.join(ROOT, 'dist', `Ayan-Setup-${require(path.join(ROOT, 'package.json')).version}.exe`);
const DEST = path.join(process.env.LOCALAPPDATA, 'Temp', 'ayan-accept');

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE; // ← 关键

const step = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ⚠️ 这两个必须**同时计数**，不能只打印。
 * 之前 ok/no 只负责输出、失败数只统计"文件缺失"，于是第 3/4/5 步的 ❌
 * 完全不参与最终判定 —— 出现过「明明打印了 ❌ 却仍然输出『验收通过』」，
 * 是这套脚本最危险的一处失真（看着全绿，实际有红）。 */
let failures = 0;
const ok = (s) => console.log(`  ✅ ${s}`);
const no = (s) => { failures++; console.log(`  ❌ ${s}`); };
const info = (s) => console.log(`     ${s}`);

step('0. 准备');
if (!fs.existsSync(SETUP)) {
  no(`找不到安装包 ${SETUP}`);
  process.exit(1);
}
info(`安装包 ${(fs.statSync(SETUP).size / 1048576).toFixed(1)} MB`);
if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
  info('已清掉上一轮测试安装');
}

step('1. 静默安装（/S，指定安装目录）');

/* 快捷方式的**基线**必须在安装前取。
 *
 * 为什么不能装完直接看"文件在不在"：机器上可能本来就有旧的快捷方式
 * （人工装过一次、或者上次验收没清干净），那样会把"残留"误判成
 * "静默安装偷偷建了快捷方式"。2026-10-11 就是这么误报了一次 ——
 * 那个 阿岩.lnk 是 18:50 人工装到 D:\Ayan 留下的，与本次安装无关。
 * 比对 mtime 也不可靠（拷贝会保留时间戳），所以直接比对"存在性变化"。 */
const SM_DIR = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const DESK_DIR = path.join(process.env.USERPROFILE, 'Desktop');
const smPath = path.join(SM_DIR, '阿岩.lnk');
const deskPath = path.join(DESK_DIR, '阿岩.lnk');
const smBefore = fs.existsSync(smPath);
const deskBefore = fs.existsSync(deskPath);
if (smBefore) info('注意：开始菜单里已有一份旧的 阿岩.lnk（安装前就存在，将按"未新增"判定）');
if (deskBefore) info('注意：桌面上已有一份旧的 阿岩.lnk（安装前就存在，将按"未新增"判定）');

const r = spawnSync(SETUP, ['/S', `/D=${DEST}`], { stdio: 'inherit', env: cleanEnv });
if (r.status !== 0) {
  no(`安装失败，退出码 ${r.status}`);
  process.exit(1);
}
ok(`安装完成（自选路径生效 → ${DEST}）`);

step('2. 安装后文件');
const must = [
  'Ayan.exe',
  'Uninstall Ayan.exe',
  'resources/app/package.json',
  'resources/app/src/main/main.js',
  'resources/app/src/renderer/index.html',
  'resources/app/vendor/pixi.js/dist/pixi.mjs',
  'resources/app/vendor/@naari3/pixi-live2d-display/dist/cubism5.es.js',
  'resources/app/src/assets/models/hiyori/Hiyori.moc3',
  'resources/app/src/assets/live2dcubismcore.min.js'
];
for (const rel of must) {
  const p = path.join(DEST, rel);
  if (fs.existsSync(p)) ok(rel);
  else no(rel);
}

step('3. 静默安装不该创建快捷方式（勾选项负责创建，没勾就不建）');
// 判定口径：**只在"安装前没有、安装后有了"时才算失败**
const smAfter = fs.existsSync(smPath);
const deskAfter = fs.existsSync(deskPath);
if (!deskBefore && deskAfter) no('本次安装新建了桌面快捷方式（不该有）');
else if (deskAfter) ok('桌面快捷方式未新增（安装前就存在的那份保持原样）');
else ok('桌面无快捷方式');

if (!smBefore && smAfter) no('本次安装新建了开始菜单快捷方式（不该有）');
else if (smAfter) ok('开始菜单快捷方式未新增（安装前就存在的那份保持原样）');
else ok('开始菜单无快捷方式');

step('4. 启动应用（干净环境）');
const exe = path.join(DEST, 'Ayan.exe');
const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
let exited = null;
child.on('exit', (code, sig) => (exited = { code, sig }));

setTimeout(() => {
  if (exited) {
    no(`应用退出了：${JSON.stringify(exited)}`);
    console.log('--- 输出 ---\n' + out);
  } else {
    ok('应用仍在运行（桌宠窗口已起来）');
    /* ⚠️ 这几项**缺失要算失败**，不能只"有就打印"。
     * 它们各自代表一条真的初始化链路：本地服务（渲染层靠它加载模块）、
     * 模型渲染（Live2D 真的画出来了）、托盘。
     * 之前是"有则打勾、无则静默跳过"，等于这几条链路全断了也照样报绿。 */
    const server = (out.match(/\[server\]\s*(\S+)/) || [])[1];
    if (server) ok(`本地服务：${server}`);
    else no('没看到 [server] 输出（本地静态服务可能没起来）');

    if (/model ready/.test(out)) {
      const m = out.match(/model ready (\{[^\n]*?\})/);
      ok(`模型渲染就绪${m ? '：' + m[1].slice(0, 90) : ''}`);
    } else {
      no('没看到 model ready（渲染层没把模型画出来）');
    }

    if (/\[tray\]/.test(out)) ok('托盘图标已就绪');
    else no('没看到 [tray] 输出（托盘没建起来）');

    if (/Error|error:|MODULE_NOT_FOUND|failed/.test(out)) {
      no('输出里出现错误：');
      console.log(out.split('\n').filter((l) => /Error|failed/.test(l)).slice(0, 5).map((l) => '       ' + l).join('\n'));
    }
  }
  try { child.kill(); } catch { /* 已退出 */ }

  step('5. 卸载');
  const un = path.join(DEST, 'Uninstall Ayan.exe');
  if (fs.existsSync(un)) {
    const rr = spawnSync(un, ['/S'], { stdio: 'inherit', env: cleanEnv });
    setTimeout(() => {
      const left = fs.existsSync(path.join(DEST, 'Ayan.exe'));
      left ? no('卸载后 Ayan.exe 仍在') : ok('卸载已清掉主程序');

      /* 结论必须由 failures 驱动，且**退出码要跟着走** ——
       * 否则 CI / 脚本里没法用它做门禁。 */
      if (failures === 0) {
        console.log('\n\x1b[32m验收通过\x1b[0m');
        process.exit(0);
      } else {
        console.log(`\n\x1b[31m验收失败：${failures} 项不达标\x1b[0m`);
        process.exit(1);
      }
    }, 6000);
  } else {
    no('找不到 Uninstall Ayan.exe');
    console.log(`\n\x1b[31m验收失败：${failures} 项不达标\x1b[0m`);
    process.exit(1);
  }
}, 18000);
