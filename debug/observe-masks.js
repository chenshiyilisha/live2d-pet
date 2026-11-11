'use strict';

/* W60 真机观测脚本：deepfish 表情切换时有没有破面
 *
 * 用法（deepfish 必须已上线，即 retired: false）：
 *   node_modules/electron/dist/electron.exe . --user-data-dir=<tmp> \\
 *     --observe-masks
 *
 * 脚本做的事：
 *   1. 加载 deepfish 模型
 *   2. 遍历 expressions/ 目录下所有 exp3 表情
 *   3. 每个表情切换后等待 1 秒
 *   4. 通过 SDK 日志检查有没有 `not supported mask count` 警告
 *   5. 输出观测报告：每个表情是否触发遮罩溢出警告
 *
 * ⚠️ 这个脚本需要在 Electron 环境跑（需要 Cubism SDK + WebGL）。
 *    它不是 node 直接能跑的 verify，而是 main.js 的一个模式。
 *
 * 实现方式：在 main.js 里加一个 --observe-masks 参数检测，
 * 如果带此参数，启动后自动遍历表情并记录 SDK 日志。
 */

// 这个文件是文档性质——实际观测逻辑写在 main.js 里。
// 真机观测步骤：
//   1. 确保 deepfish 上线（retired: false + APPEARANCE_MODELS 加回）
//   2. 跑 electron.exe . --user-data-dir=<tmp> --observe-masks
//   3. 观察控制台输出，看哪些表情触发遮罩溢出
//   4. 如果有破面，截图对比
//   5. 决策：要不要 patch SDK（4×4 网格 = 64 容量 > 49）

console.log('W60 真机观测脚本');
console.log('用法：');
console.log('  1. 确保 deepfish 上线（retired: false + APPEARANCE_MODELS 加回）');
console.log('  2. 跑 electron.exe . --user-data-dir=<tmp> --observe-masks');
console.log('  3. 观察控制台输出，看哪些表情触发遮罩溢出');
console.log('  4. 如果有破面，截图对比');
console.log('  5. 决策：要不要 patch SDK（4×4 网格 = 64 容量 > 49）');
console.log('');
console.log('当前 deepfish 状态：retired: true → 无法观测');
console.log('观测前提：deepfish 上线后才能跑');
