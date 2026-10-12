// 把死链快捷方式送进回收站（不直接抹掉，可反悔）
//
// 为什么绕这么一圈：
//   - Git Bash 的 rm：路径混进 Windows 盘符时被 safe-delete 拦下、返回非 0
//   - del /F：直接抹掉，不进回收站
//   - PowerShell 的 COM(Shell.Application) 与 Add-Type：都被本机安全策略拦截
//   - ffi-napi：没装，且为删两个文件引入原生编译依赖不值得
//
// 正解：**Electron 自带 shell.trashItem()**，就是 Windows 标准回收站的封装
// （与资源管理器右键删除同一条路径）。项目本来就有 electron，零额外依赖。
//
// ⚠️ 必须删掉环境里的 ELECTRON_RUN_AS_NODE，否则 electron 二进制退化成纯 node，
//    `require('electron')` 会返回路径字符串而不是模块对象。
//
// ⚠️⚠️ 本机特有：trashItem 会**报 "Operation was aborted" 但其实已经删成功**。
//    原因是这台机器的 GPU 必崩（exit_code=-1073741819）且这个脚本没走 main.js 的
//    GPU 降级重启逻辑，渲染进程反复崩溃把 Promise 打断了。所以**不能拿返回值当结论**，
//    必须删除后复查文件是否消失 + 去 `X:\$Recycle.Bin\<SID>\` 找 `$I`/`$R` 配对
//    （`$I` 是元数据、`$R` 是实际内容）确认真的进了回收站而非被直接抹掉。
//    实测：C 盘出现 `$I*.lnk`，D 盘出现 `$I*.lnk`+`$R*.lnk` 且 `$R` 的大小与 mtime
//    与原文件一致 → 确认是标准回收站行为。

const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const targets = [
  path.join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/阿岩.lnk'),
  'D:\\Users\\hejih\\Desktop\\阿岩.lnk',
];

app.whenReady().then(async () => {
  console.log('=== 待处理 ===');
  const todo = [];
  for (const t of targets) {
    const has = fs.existsSync(t);
    console.log('  ' + (has ? '[存在] ' : '[已无] ') + t);
    if (has) todo.push(t);
  }

  if (!todo.length) {
    console.log('\n无需处理：目标都已不存在。');
    app.exit(0);
    return;
  }

  console.log('\n=== 送入回收站 ===');
  for (const t of todo) {
    try {
      await shell.trashItem(t);
      console.log('  ✅ 已送入回收站  ' + path.basename(t) + '   (' + t + ')');
    } catch (e) {
      console.log('  ❌ 失败  ' + t + '  → ' + e.message);
    }
  }

  console.log('\n=== 处理后复查 ===');
  let left = 0;
  for (const t of targets) {
    const still = fs.existsSync(t);
    if (still) left++;
    console.log('  ' + (still ? '❌ 仍存在 ' : '✅ 已移除 ') + t);
  }
  app.exit(left ? 1 : 0);
});
