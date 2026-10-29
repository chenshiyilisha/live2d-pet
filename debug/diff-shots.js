'use strict';
/* 差分任意两组截图（2026-10-29）。
 * 跑法：node debug/diff-shots.js <基准名> <对比名...>  （不带扩展名，自动找 debug/pet-<名>.png）
 * 专门用来回答「这两张图脸上到底有没有差别」—— 肉眼看缩略图不可靠。
 */
const { app, nativeImage } = require('electron');
const path = require('path');

const ARGS = process.argv.slice(2);
const load = (n) => {
  const f = path.join(__dirname, `pet-${n}.png`);
  const img = nativeImage.createFromPath(f);
  if (img.isEmpty()) { console.log('[diff] 读不到', f); process.exit(1); }
  return img.toBitmap();
};

app.whenReady().then(() => {
  const base = ARGS[0];
  const bmp0 = load(base);
  for (const n of ARGS.slice(1)) {
    const bmp1 = load(n);
    let cnt = 0, minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
    // 尺寸一致性由截图通道保证（同一窗口）；不同就直接报出来
    const w = nativeImage.createFromPath(path.join(__dirname, `pet-${base}.png`)).getSize().width;
    for (let y = 0; y < 2000; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (bmp0[i + 3] === undefined || bmp1[i + 3] === undefined) { y = 2000; break; }
        const d = Math.abs(bmp0[i] - bmp1[i]) + Math.abs(bmp0[i + 1] - bmp1[i + 1]) +
                  Math.abs(bmp0[i + 2] - bmp1[i + 2]) + Math.abs(bmp0[i + 3] - bmp1[i + 3]);
        if (d > 30) {
          cnt++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
    console.log('[diff]', n.padEnd(12), 'diffpx=' + cnt, cnt ? `bbox=(${minx},${miny})-(${maxx},${maxy})` : '');
  }
  app.exit(0);
});
