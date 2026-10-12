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
const CFG = path.join(process.env.APPDATA, 'Ayan', 'config.json');
const OUT = path.join(__dirname, 'name-e2e.log');

const target = process.argv[2] || '小绿';

// 1) 预置一个自定义名字
fs.mkdirSync(path.dirname(CFG), { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({ name: target }, null, 2), 'utf8');
console.log(`已写入 ${CFG} → name=${JSON.stringify(target)}`);

// 2) 启动应用（清掉 ELECTRON_RUN_AS_NODE，否则 electron.exe 会退化成 node）
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

if (fs.existsSync(OUT)) fs.rmSync(OUT, { force: true });
const fd = fs.openSync(OUT, 'w');

const child = spawn(EXE, ['.'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', fd, fd],
  env
});
child.unref();
console.log(`已启动 pid=${child.pid}，日志 → ${OUT}`);

// 3) 收回调用的收尾交给外层（sleep + taskkill）
