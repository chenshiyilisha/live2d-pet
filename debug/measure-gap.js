/* 量「人物」和「底座牌」各自的左右范围（CSS px），用来核对居中 / 对齐。
 *
 * 为什么不能直接用 ?snap=ink 的 ink 包围盒：那个是**整窗**的，而底座牌比人物宽
 * （牌 147、人物约 100），左右边就变成牌的边，测不出人物在哪 —— 测出来的
 * leftMin/rightMax 恰好等于牌的左右边（2026-10-12 实际踩过）。
 * 这里改成逐行扫描，并把最下面一条（牌的领地）单独切出去，两个范围分开报。
 *
 * 用法：
 *   1) 先生成一张窗口截图（PET_SNAPSHOT=bar 会在 14s 存 debug/pet-bar.png）
 *   2) ./node_modules/electron/dist/electron.exe debug/measure-gap.js debug/pet-bar.png
 *
 * 对当前布局的期望值（窗口 308×344，DPR 1.5；2026-10-12 晚起人物与牌都恒居中）：
 *   两者中心都应落在窗宽一半附近（±2px 光学修正），左右各留约 80px。
 */
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const file = process.argv[process.argv.length - 1];
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();                 // BGRA
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]];   // r,g,b,a
  };

  const [br, bg, bb, ba] = at(4, 4);          // 背景基准（左上角内侧）
  const diff = (p) => Math.abs(p[0] - br) + Math.abs(p[1] - bg) +
                      Math.abs(p[2] - bb) + Math.abs(p[3] - ba);
  const isInk = (p) => diff(p) > 40;

  // 逐行左右边界
  const rows = [];
  for (let y = 0; y < height; y++) {
    let l = -1, r = -1;
    for (let x = 0; x < width; x++) {
      if (isInk(at(x, y))) { if (l < 0) l = x; r = x; }
    }
    rows.push([l, r]);
  }

  const DPR = 1.5;
  const PLATE_BAND = Math.round(40 * DPR);    // 底部 40 CSS px 算作牌的领地
  const band = (y0, y1, tag) => {
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = y0; y < Math.min(y1, height); y++) {
      const [l, r] = rows[y];
      if (l < 0) continue;
      if (l < minX) minX = l;
      if (r > maxX) maxX = r;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { tag, x0: minX, x1: maxX, y0: minY, y1: maxY,
      w: maxX - minX + 1,
      cssX0: +(minX / DPR).toFixed(1), cssX1: +((maxX + 1) / DPR).toFixed(1),
      cssRightGap: +(width / DPR - (maxX + 1) / DPR).toFixed(1) };
  };

  console.log(JSON.stringify({
    png: `${width}x${height}`,
    win: width / DPR,
    chara: band(0, height - PLATE_BAND, '人物'),
    plate: band(height - PLATE_BAND, height, '底座牌')
  }, null, 2));

  app.quit();
});
