'use strict';
/*
 * 验证「自定义名称」在真实启动下的行为，并把结果写成文件。
 *
 * 为什么不直接用 shell 重定向：
 *   本机 Git Bash 里 `( exe & )` 会把父 shell 挂住，`exe > file` 又常常
 *   一个字节都收不到（Electron 的 console 走的是它自己的管道）。
 *   照 debug/install-smoke.js 的办法：Node spawn + 直接把 fd 交给子进程。
 *
 * 用法： node debug/verify-name-e2e.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

/* 🔴 userData 目录必须和**应用真正在用的那一份**对上，否则整个测试是空跑。
 *
 * 这里踩过坑（2026-10-14）：原先写的是 `%APPDATA%/Ayan/config.json`，
 * 理由是"安装版的目录名是 productName"，但本脚本启动的是**开发版**
 * （`electron .`）—— 开发版跑的是仓库根目录的 package.json，那里只有
 * `name: "live2d-pet"`，`productName: "Ayan"` 是 electron-builder 打包时
 * 才注进产物 package.json 的（见 tools/prepare-stage.js）。
 * 结果：脚本往 Ayan 写、应用往 live2d-pet 读，断言"通过"纯属巧合
 * （两处名字当时恰好都是"小绿"），还在 %APPDATA% 里留下一个假目录
 * （那里面**一个 Cache/GPUCache 都没有**，正是"真应用从没跑过"的铁证）。
 *
 * 现在的做法：**不去碰任何真实 userData**，给一份专属临时目录。
 * 应用只读它，测完整个目录删掉即可。 */
const UD = path.join(__dirname, '.tmp-name-e2e');
const CFG = path.join(UD, 'config.json');
const OUT = path.join(__dirname, 'name-e2e.log');

const target = process.argv[2] || '小绿';

// 1) 预置一个自定义名字
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ name: target }, null, 2), 'utf8');
console.log(`已写入 ${CFG} → name=${JSON.stringify(target)}`);

// 2) 启动应用（清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成 node）
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true });
const fd = fs.openSync(OUT, 'w');

const child = spawn(EXE, ['.', `--user-data-dir=${UD}`], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', fd, fd],
  env
});
child.unref();
console.log(`已启动 pid=${child.pid}，日志 → ${OUT}`);

// 3) 收回调用的收尾交给外层（sleep + taskkill）
