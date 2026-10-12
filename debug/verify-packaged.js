'use strict';
/*
 * 打包版最终验收。
 *
 * 为什么不用 shell 里的 tasklist / timeout：本机这两条路都出过假信号 ——
 *   · 从 Node spawnSync 调 tasklist 会 EBUSY（安全软件拦进程创建）；
 *   · Git Bash 里 `( exe & )` 让父 shell 挂住，timeout 数的是 shell 的命，
 *     返回 124 会让人误以为"应用活着"。
 * 所以这里全程用 Node 的 spawn + 直接读文件系统（userData 的 mtime、
 * 应用自己写的截图），这些信号与进程枚举无关，扯不了谎。
 *
 * 判定"起来了"的三层证据（任一成立即可，三条都成立最稳）：
 *   A. 应用把自己接管的本地服务端口打到了 stdout（说明走到 whenReady）
 *   B. userData 目录的 mtime 被刷新（说明 Chromium 真的初始化了）
 *   C. resources/app/debug/ 下出现截图（说明渲染层把模型画出来了）
 *
 * 用法：
 *   node debug/verify-packaged.js              # 验 dist/win-unpacked
 *   node debug/verify-packaged.js <exe路径>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const exe = process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'Ayan.exe');
const appDir = path.join(path.dirname(exe), 'resources', 'app');
const shotDir = path.join(appDir, 'debug');
const userData = path.join(process.env.APPDATA, 'live2d-pet');

if (!fs.existsSync(exe)) {
  console.error('找不到可执行文件：' + exe);
  process.exit(1);
}

const mtime = (p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
};

// 清掉上次的截图，免得把旧文件当成这次的成果
if (fs.existsSync(shotDir)) {
  for (const f of fs.readdirSync(shotDir)) {
    if (/^pet-.*\.png$/.test(f)) fs.rmSync(path.join(shotDir, f), { force: true });
  }
}

const before = mtime(userData);

console.log(`可执行文件 ${exe}`);
console.log(`应用目录   ${appDir}`);
console.log(`截图目录   ${shotDir}`);
console.log(`userData   ${userData}`);
console.log(`启动前 userData mtime = ${before ? new Date(before).toISOString() : '(不存在)'}\n`);

// PET_SNAPSHOT=1 让渲染层截图。
// ⚠️ 必须删掉环境里的 ELECTRON_RUN_AS_NODE —— 本会话它恒为 1，会让 Ayan.exe
// 退化成纯 Node 运行 main.js（于是 require('electron') 报 MODULE_NOT_FOUND、
// 进程秒退、什么日志都没有）。这不是打包问题，是我们这边的观测陷阱。
const env = { ...process.env, PET_SNAPSHOT: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(exe, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));

let exited = null;
child.on('exit', (code, sig) => {
  exited = { code, sig };
});

const WAIT = 25000;
console.log(`pid=${child.pid}，观察 ${WAIT / 1000} 秒…\n`);

setTimeout(() => {
  const after = mtime(userData);
  const shots = fs.existsSync(shotDir) ? fs.readdirSync(shotDir).filter((f) => /^pet-.*\.png$/.test(f)) : [];
  const serverLine = (out.match(/\[server\]\s*\S+/) || [])[0] || null;
  const modelReady = /model ready/.test(out);

  console.log('=== A. 主进程输出 ===');
  console.log(serverLine ? '  [server] ' + serverLine.replace('[server] ', '') : '  (没等到 [server] 行)');
  console.log(`  model ready: ${modelReady ? '是' : '否'}`);

  console.log('\n=== B. userData 是否被写入 ===');
  console.log(`  ${before ? new Date(before).toISOString() : '(无)'}  →  ${after ? new Date(after).toISOString() : '(无)'}`);
  console.log(`  ${after > before ? '有刷新 → Chromium 已初始化' : '未变化 → 应用没走到初始化'}`);

  console.log('\n=== C. 渲染层截图 ===');
  console.log(shots.length ? '  ' + shots.join('\n  ') : '  (无)');

  console.log('\n=== 进程状态 ===');
  console.log(exited ? `  已退出 code=${exited.code} sig=${exited.sig}` : '  仍在运行（预期如此，下面会杀掉）');

  console.log('\n=== 原始输出（前 40 行）===');
  console.log(out.split('\n').slice(0, 40).map((l) => '  ' + l).join('\n') || '  (无输出)');

  const ok = Boolean(serverLine) || after > before || shots.length > 0;
  console.log(`\n>>> 结论：${ok ? '打包版可以正常运行 ✅' : '打包版未能启动 ❌'}`);

  try {
    child.kill();
  } catch { /* 已退出 */ }
  process.exit(ok ? 0 : 1);
}, WAIT);
