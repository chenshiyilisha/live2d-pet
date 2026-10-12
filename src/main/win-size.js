'use strict';

const { screen } = require('electron');

/* 半身桌宠窗口：只保留头顶到腰部，比例接近 8:9。
 *
 * ⚠️ 尺寸不再写死。原先是硬编码 320×360，换显示器就出事：
 *    笔记本内屏 2560×1440 @150% → 逻辑桌面 1707×960，桌宠占屏宽 18.7%；
 *    换成外接屏 2560×1440 @125% → 逻辑桌面 2048×1152，同样 320 逻辑像素
 *    只占 15.6%，肉眼明显小了一圈（窗口尺寸不跟显示器走）。
 *
 *    现在改成「按主屏可用高度的固定比例」现算，任何分辨率 / 任何系统缩放
 *    下观感占比都一样，换屏不用再手调。显示器增删、缩放变化时自动重算
 *    （见 app.whenReady 里的 screen 事件）。
 *
 * 🔧 想整体调整桌宠大小，只改 WIN_H_RATIO 这一个数。 */
const WIN_ASPECT = 320 / 360;   // 宽/高，锁死；改高度时宽度等比跟随
const WIN_H_RATIO = 0.375;      // 窗口高 ÷ 主屏可用高（DIP）。0.375 恰好 = 旧屏 150% 下的原 360px
const WIN_H_MIN = 240;          // 小屏兜底：再小人物细节就看不清了
const WIN_H_MAX = 760;          // 大屏兜底：别在 4K/8K 上变成巨无霸
const MARGIN = 24;              // 贴边 / 落角时与屏幕边缘的留白

/* 当前窗口尺寸（DIP）。
 *
 * ⚠️ 导出的是**对象**而不是两个数字：CJS 的 module.exports 是快照，
 *    写成 `exports.WIN_W = 320` 之后 refreshWinSize() 改了内部变量，
 *    别的模块拿到的还是 320 —— 换显示器时窗口会按新尺寸画、却按旧尺寸
 *    定位，边角对不上。用对象持有、各处 `SIZE.w` 读属性才有 live 语义。 */
const SIZE = { w: 320, h: 360 };

/* 诊断口子：PET_WIN_H=NNN 直接钉死窗口高（DIP），宽度仍按 WIN_ASPECT 跟随。
 * 存在的理由：渲染层那组取景常量（INK_TOP_* 等）是在**某个具体窗口尺寸**下
 * 标出来的，换显示器最该复验的就是「换个窗口高它还成不成立」。
 * 有了这个口子就能在**不动显示器**的前提下跑两组尺寸直接验。
 * 用法：PET_WIN_H=280 PET_SNAPSHOT="ink" <electron> . */
const WIN_H_OVERRIDE = (() => {
  const q = Number(process.env.PET_WIN_H);
  return Number.isFinite(q) && q >= 120 ? Math.round(q) : null;
})();

/* 按主屏可用高度算出本机该用的窗口尺寸（DIP）。
 * ⚠️ screen 模块只在 app ready 之后可用，这个函数必须在那之后调。 */
function computeWinSize() {
  const { workArea } = screen.getPrimaryDisplay();
  let h = WIN_H_OVERRIDE ?? Math.round(workArea.height * WIN_H_RATIO);
  h = Math.min(WIN_H_MAX, Math.max(WIN_H_MIN, h));
  return { w: Math.round(h * WIN_ASPECT), h };
}

/* 刷新 SIZE；返回尺寸是否真的变了。
 * 放在 createWindow 最前面调，屏幕一变（换屏 / 改缩放）也会再调一次。 */
function refreshWinSize() {
  const { w, h } = computeWinSize();
  if (w === SIZE.w && h === SIZE.h) return false;
  SIZE.w = w;
  SIZE.h = h;
  return true;
}

module.exports = { SIZE, MARGIN, refreshWinSize };
