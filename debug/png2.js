/* 读一张 PNG，按"与背景色的差异"找出角色实体的包围盒 + 逐行左右边界。
 * 背景色取四角像素。用 nativeImage 解码，不需要额外的图像库。 */
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const file = process.argv[2];
  const img = nativeImage.createFromPath(file);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();               // BGRA
  const at = (x, y) => {
    const i = (y * width + x) * 4;
    return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2], a: bmp[i + 3] };
  };

  const corners = [[2, 2], [width - 3, 2], [2, height - 3], [width - 3, height - 3]]
    .map(([x, y]) => at(x, y));
  const bg = corners[0];

  const isInk = (p) => Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) +
                       Math.abs(p.b - bg.b) + Math.abs(p.a - bg.a) > 40;

  const rows = [];
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    let l = -1;
    let r = -1;
    for (let x = 0; x < width; x++) {
      if (!isInk(at(x, y))) continue;
      if (l < 0) l = x;
      r = x;
      count++;
    }
    rows.push([y, l, r]);
    if (l >= 0) {
      if (l < minX) minX = l;
      if (r > maxX) maxX = r;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  console.log('SIZE ' + width + 'x' + height);
  console.log('BG ' + JSON.stringify(bg));
  console.log('CORNER2 ' + JSON.stringify(corners[1]) + ' 3=' + JSON.stringify(corners[2]) +
              ' 4=' + JSON.stringify(corners[3]));
  console.log('BBOX ' + JSON.stringify([minX, minY, maxX, maxY]) +
              ' count=' + count + ' pct=' + (Math.round(count / (width * height) * 1000) / 10));
  const step = Math.max(1, Math.round(height / 26));
  console.log('  y   left  right  width');
  for (let i = 0; i < rows.length; i += step) {
    const [y, l, r] = rows[i];
    console.log(`${String(y).padStart(5)} ${String(l).padStart(6)} ${String(r).padStart(6)} ${String(l < 0 ? 0 : r - l + 1).padStart(6)}`);
  }
  app.quit();
});
