/* 几何标定取数器 —— 给 profiles/<model>.js 那五个几何数（petScale / inkTopK /
 * inkH / inkW / inkCxK）提供**实测像素**。
 *
 * 为什么必须有这个脚本：规矩 2 禁止把另一个模型的取景常数搬过来（hiyori 那组
 * 数依赖它的画布尺寸与构图），所以换模型必须重新量。而「整窗 ink 包围盒」
 * 又不可信 —— 趴姿模型的桌布会横向铺满，包围盒量出来的是桌布不是人
 * （同规矩 23：牌比人宽时量出来的是牌）。
 *
 * 输出三块：
 *   1) 整窗墨水包围盒（设备像素 + CSS px）
 *   2) **逐行**左右边界（每 STEP 个设备像素采样一行）→ 用来判读
 *      「哪几行是桌布（宽）/ 哪几行是人物（窄）」，人眼看图配合
 *   3) 逐行宽度直方图 → 桌布与人物会分成明显两簇，取簇边界
 *
 * 用法：
 *   ./node_modules/electron/dist/electron.exe debug/calib-whale.js debug/pet-window.png [dpr] [step]
 *
 * 反推公式（一次测量即可，因为误差在常数项上是线性的）：
 *   窗口内墨水顶 = HEAD_PAD + (K_true − K_占位) × s   →  K_true = K_占位 + (cssTop − HEAD_PAD)/s
 *   身体中心窗口 x = W/2+2 + (Kc_true − Kc_占位) × s  →  Kc_true = Kc_占位 + (cssCx − (W/2+2))/s
 *   inkH_true = 墨水高CSS / s ；  inkW_true = 墨水宽CSS / s
 */
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const argv = process.argv.slice(2);
  const file = argv[0];
  const DPR = Number(argv[1]) || 1.5;
  const STEP = Number(argv[2]) || 6;      // 设备像素

  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();               // BGRA
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]];   // r,g,b,a
  };
  /* 基准色取自左上角内侧 —— 和 measure-gap.js 同一口径。
   * ⚠️ 桌宠窗口是透明的，截图里背景是合成出来的桌面色；判据用"偏离基准"
   * 而不是"不透明"，软件合成下 alpha 不可信（见 main.js 的 ink 实现）。 */
  const [br, bg, bb, ba] = at(4, 4);
  const diff = (p) => Math.abs(p[0] - br) + Math.abs(p[1] - bg) +
                      Math.abs(p[2] - bb) + Math.abs(p[3] - ba);
  const isInk = (p) => diff(p) > 40;

  // ---- 1) 整窗包围盒 ----
  let gL = 1e9, gT = 1e9, gR = -1, gB = -1;
  // ---- 2) 逐行 ----
  const rows = [];
  for (let y = 0; y < height; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < width; x++) {
      if (isInk(at(x, y))) { if (l < 0) l = x; r = x; }
    }
    if (l >= 0) {
      if (l < gL) gL = l;
      if (r > gR) gR = r;
      if (y < gT) gT = y;
      if (y > gB) gB = y;
    }
    rows.push([l, r]);
  }

  const css = (v) => +(v / DPR).toFixed(1);
  const band = (y0, y1) => {
    let mn = 1e9, mx = -1, t = 1e9, b = -1;
    for (let y = Math.max(0, y0); y < Math.min(y1, height); y++) {
      const [l, r] = rows[y];
      if (l < 0) continue;
      if (l < mn) mn = l;
      if (r > mx) mx = r;
      if (y < t) t = y;
      if (y > b) b = y;
    }
    if (mn > 1e8) return null;
    return { y0: t, y1: b, x0: mn, x1: mx, wDev: mx - mn + 1, wCss: css(mx - mn + 1) };
  };

  console.log(JSON.stringify({
    png: `${width}x${height}`,
    dpr: DPR,
    winCss: { w: css(width), h: css(height) },
    global: {
      dev: [gL, gT, gR, gB],
      css: { left: css(gL), top: css(gT), right: css(gR), bottom: css(gB) },
      wCss: css(gR - gL + 1),
      hCss: css(gB - gT + 1),
      cxCss: css((gL + gR + 1) / 2)
    },
    scan: rows.map(([l, r], y) => (y % STEP === 0 && l >= 0
      ? { y, yCss: css(y), l, r, lCss: css(l), rCss: css(r), wCss: css(r - l + 1) }
      : null)).filter(Boolean),
    /* 上半（人物领地）与下半分开的量 —— 桌布集中在底部时这两者会明显不同。 */
    halves: { upper: band(0, Math.round(height * 0.6)), lower: band(Math.round(height * 0.6), height) }
  }, null, 2));

  app.quit();
});
