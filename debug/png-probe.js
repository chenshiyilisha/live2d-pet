// 临时探针 v2：逐行 ink 范围扫描 + 顶部条带裁剪放大图。
// 用法：electron debug/png-probe.js debug/pet-window.png
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const target = process.argv[process.argv.length - 1];
  const img = nativeImage.createFromPath(target);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();   // BGRA

  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]];
  };

  // 每行统计：不透明范围（a>8）和「明显非白」范围
  const rows = [];
  for (let y = 0; y < Math.min(height, 120); y++) {
    let oFirst = -1, oLast = -1, nwFirst = -1, nwLast = -1, oCount = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      if (a > 8) {
        if (oFirst < 0) oFirst = x;
        oLast = x;
        oCount++;
      }
      if (a > 8 && !(r > 240 && g > 240 && b > 240)) {
        if (nwFirst < 0) nwFirst = x;
        nwLast = x;
      }
    }
    rows.push({ y, oFirst, oLast, oCount, nwFirst, nwLast });
  }

  const out = {
    file: target,
    size: [width, height],
    rows
  };

  // 顶部条带放大 4 倍，肉眼确认那是什么
  const band = img.crop({ x: 0, y: 0, width, height: Math.min(60, height) });
  const big = band.resize({ width: width * 3, height: Math.min(60, height) * 3, quality: 'nearest' });
  const outPath = path.join(__dirname, 'top-band.png');
  fs.writeFileSync(outPath, big.toPNG());
  out.savedBand = outPath;

  console.log(JSON.stringify(out, null, 1));
  app.quit();
});
