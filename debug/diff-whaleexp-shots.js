'use strict';
/* 对 debug/pet-whaleexp-*.png 做像素级差分（2026-10-29）。
 *
 * 用 Electron 的 nativeImage 解码（仓库没有 pngjs / PIL，PowerShell 的
 * System.Drawing 被安全策略挡了），只做「与基线比有多少像素变了、变在哪」。
 * 背景：探针的 drawable 顶点差分是 0（连呼吸都对不上），图和图之间的
 * 真实差异必须换一条独立通道来量 —— 这就是那条独立通道。
 *
 * 跑法：node debug/diff-whaleexp-shots.js（普通 node 即可，不用 electron）
 */
const { app, nativeImage } = require('electron');
const path = require('path');

const NAMES = ['00-base', 'ctrl-brow', 'star', 'ques', 'excl', 'happy', 'angry', 'cry'];
const DIR = __dirname;

app.whenReady().then(() => {
  const imgs = {};
  let w = 0, h = 0;
  for (const n of NAMES) {
    const img = nativeImage.createFromPath(path.join(DIR, `pet-whaleexp-${n}.png`));
    if (img.isEmpty()) { console.log('[diff] 读不到', n); app.exit(1); return; }
    const sz = img.getSize();
    w = sz.width; h = sz.height;
    imgs[n] = img.toBitmap();   // BGRA
  }
  const base = imgs['00-base'];
  for (const n of NAMES.slice(1)) {
    const cur = imgs[n];
    let cnt = 0, minx = w, miny = h, maxx = -1, maxy = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(base[i] - cur[i]) + Math.abs(base[i + 1] - cur[i + 1]) +
                  Math.abs(base[i + 2] - cur[i + 2]) + Math.abs(base[i + 3] - cur[i + 3]);
        if (d > 30) {
          cnt++;
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
    console.log('[diff]', n.padEnd(10), 'diffpx=' + cnt,
      cnt ? `bbox=(${minx},${miny})-(${maxx},${maxy})` : '');
  }
  app.exit(0);
});
