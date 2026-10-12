'use strict';
/* 诊断探针：透明无边框窗口上「保持右边缘不变地改宽度」怎么写才不漂。
 *
 * 背景：桌宠窗口的宽度现在要随对话 UI 来回切（常驻只包住人物与底座，
 * 气泡 / 输入条一出现就撑宽）。切换时必须**钉住内容区的右边缘** ——
 * 人物的锚点是「离窗口右边固定 96px」，右边缘一动她就跟着横移。
 *
 * 主进程里最初写成 `x = getBounds() 的右边缘 − 新宽度`，实跑发现
 * **每切一次右边缘 +1px**（1687→1688→1689→1690→1691…），几十次之后
 * 窗口就飘出屏幕右边。原因有两条，都不是"代码写错了"：
 *
 *   1) 这个窗口在 150% 缩放下有一圈**不可见的 DWM 边框**：
 *      getBounds() 的外框比内容区宽 1px（要 194 给 195、要 309 给 310）。
 *   2) **非整数设备像素向上取整**：逻辑宽 309 × 1.5 = 463.5 设备像素，
 *      取整成 464 → 折回来就是 310。所以"我要 309"和"实际能拿到 309"
 *      在 150% 下不是一回事。
 *
 *    两条叠加：用外框右边缘反推 x → 每次都把上次多出来的 1px 带进下一次
 *    → 误差**累积**。
 *
 * 结论（本脚本量出来的）：
 *   A) 「用上次外框右边缘 − 新宽度」→ 误差每步 +1，**必须弃用**；
 *   B) 「用一个固定目标右边缘 − 新宽度」→ 误差恒为 0~1px，**不再累积**；
 *   C) 「在 B 基础上用内容区实测误差回补一次」→ 内容区右边缘**精确等于目标**，
 *      两种宽度都成立。
 *   D) 换 setContentBounds 与 B 一样，不会更好。
 *
 * 所以主进程采用 B+C：先用内容区右边缘算一个目标，写完再量一次、差多少补多少。
 * 想改这块的话先跑这个脚本，别凭感觉调。
 *
 * 用法：unset ELECTRON_RUN_AS_NODE && ./node_modules/electron/dist/electron.exe debug/probe-setbounds.js
 */

const { app, BrowserWindow, screen } = require('electron');

/* 本机 GPU 进程必崩（深信服 aTrust 的钩子），走软件路径 —— 这个探针只量窗口
 * 几何，不需要渲染，关掉硬件加速最省事（主程序是靠 relaunch 兜的）。 */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

const Y = 120;
let failures = 0;
const check = (cond, m) => { if (!cond) failures++; console.log(`  ${cond ? '✅' : '❌'} ${m}`); };

/* 主进程要采用的那套写法：右边缘钉在 targetRight 上地把宽度改成 width。
 * 返回值 = 实际达成的内容区右边缘。 */
function resizeKeepRight(win, width, targetRight) {
  let x = Math.round(targetRight - width);
  for (let i = 0; i < 3; i++) {
    win.setBounds({ x, y: Y, width, height: win.getBounds().height });
    const c = win.getContentBounds();
    const err = (c.x + c.width) - targetRight;
    if (err === 0) return { right: c.x + c.width, rounds: i + 1 };
    x -= err;
  }
  const c = win.getContentBounds();
  return { right: c.x + c.width, rounds: 3 };
}

app.whenReady().then(() => {
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 320, H = 200;
  const win = new BrowserWindow({
    width: W, height: H,
    x: wa.x + wa.width - W - 24,
    y: Y,
    transparent: true, frame: false, show: false, hasShadow: false,
    resizable: false, skipTaskbar: true, backgroundColor: '#00000000'
  });

  setTimeout(() => {
    console.log('[probe] workArea', JSON.stringify(wa));
    const b0 = win.getBounds();
    const c0 = win.getContentBounds();
    console.log(`[probe] 创建后 bounds ${b0.width}×${b0.height}  内容区 ${c0.width}×${c0.height}` +
      `  → 外框比内容区宽 ${b0.width - c0.width}px\n`);

    const targetRight = c0.x + c0.width;

    console.log('--- A) x = 上次"外框"右边缘 − 新宽度（最初的写法）---');
    let last = b0.x + b0.width;
    const aErr = [];
    for (const width of [194, 309, 194, 309, 194]) {
      const x = Math.round(last - width);
      win.setBounds({ x, y: Y, width, height: H });
      const b = win.getBounds();
      last = b.x + b.width;
      aErr.push(last - targetRight);
      console.log(`    宽度 ${String(width).padStart(3)} → 外框右边缘 ${last}（距目标 ${last - targetRight}）`);
    }
    check(aErr[aErr.length - 1] - aErr[0] >= 3, 'A) 误差会**累积**（每次 +1）—— 所以不能用');

    console.log('\n--- B) x = 固定目标右边缘 − 新宽度 ---');
    const bErr = [];
    for (const width of [194, 309, 194, 309, 194, 309]) {
      const x = Math.round(targetRight - width);
      win.setBounds({ x, y: Y, width, height: H });
      const c = win.getContentBounds();
      bErr.push((c.x + c.width) - targetRight);
      console.log(`    宽度 ${String(width).padStart(3)} → 内容区右边缘 ${c.x + c.width}` +
        `（宽 ${c.width}，距目标 ${c.x + c.width - targetRight}）`);
    }
    const bSpread = Math.max(...bErr) - Math.min(...bErr);
    check(bSpread <= 1, `B) 误差不再累积（最大最小只差 ${bSpread}px，是一直在 0~1 之间跳）`);

    console.log('\n--- C) 在 B 基础上用实测误差回补一次（主进程采用的写法）---');
    const cErr = [];
    let maxRounds = 0;
    for (const width of [194, 309, 194, 309, 194, 309, 194, 309]) {
      const r = resizeKeepRight(win, width, targetRight);
      cErr.push(r.right - targetRight);
      maxRounds = Math.max(maxRounds, r.rounds);
      console.log(`    宽度 ${String(width).padStart(3)} → 内容区右边缘 ${r.right}` +
        `（距目标 ${r.right - targetRight}，${r.rounds} 轮收敛）`);
    }
    check(cErr.every((e) => e === 0), 'C) ⚠️ 关键：内容区右边缘**精确等于**目标，两种宽度都成立');
    check(maxRounds <= 2, `C) 最多 ${maxRounds} 轮收敛（不会反复抖动）`);

    /* 换宽度不能让窗口高度 / y 跟着变 —— 人物是「贴窗口底」取的景 */
    const c = win.getContentBounds();
    check(c.height === c0.height && c.y === c0.y, `高度与 y 全程没动（${c.width}×${c.height} @y=${c.y}）`);

    console.log('\n════════════════════════════════════════');
    console.log(failures ? `❌ ${failures} 项未通过` : '✅ 全部通过');
    setTimeout(() => app.exit(failures ? 1 : 0), 200);
  }, 900);
});
