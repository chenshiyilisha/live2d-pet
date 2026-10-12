'use strict';

/* 通用小工具。
 *
 * 放进这里的唯一标准：**纯函数、不碰 electron、不碰窗口**。
 * 这样一来谁都能 require 它而不会绕出循环依赖 —— 主进程的模块
 * （config / sysinfo / motion / menu）几乎都要用 clamp，让它们去
 * require 主文件是不行的（主文件又 require 它们）。
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* 右下角落点。
 *
 * 原先是同一行公式在 5 个地方各写了一遍：
 *   默认落点 / 回到右下角 / 溜达的边界 / second-instance 拉回 / 换显示器重定位。
 * 改一处忘一处就会「某个入口的留白和别处不一样」，而且纯靠肉眼比字符串。
 * 现在统一成「给一块屏的 workArea，算右下角该放哪」。
 *
 * margin 一般传 MARGIN（24），只有溜达与重定位用得到同一套语义。 */
function cornerPos(workArea, w, h, margin) {
  return {
    x: workArea.x + workArea.width - w - margin,
    y: workArea.y + workArea.height - h - margin
  };
}

module.exports = { clamp, cornerPos };
