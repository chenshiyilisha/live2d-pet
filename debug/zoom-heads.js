'use strict';
/* 把 debug/pet-<prefix>-<name>.png 的**头部区域**裁出来放大 3 倍（2026-10-29）。
 *
 * 为什么需要：整张截图只有 400 多像素宽，人物占中间一块，眉毛/眼睛/脸红的
 * 变化在缩略图里根本分辨不出 —— 前几轮"看着没变"很可能就是这么看漏的。
 * 先裁头再放大，才有资格说"变了 / 没变"。
 *
 * 跑法：
 *   node debug/zoom-heads.js <前缀> <名字,名字,...>
 *   例：node debug/zoom-heads.js mood calm,happy,shy,serious
 *       node debug/zoom-heads.js whaleexp 00-base,star,ques
 * 输出：debug/pet-head-<name>.png（同名覆盖，注意别和后一轮混）
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const PREFIX = process.argv[2] || 'whaleexp';
const NAMES = (process.argv[3] || '00-base,star,ques,excl,happy').split(',').map((s) => s.trim()).filter(Boolean);
const DIR = __dirname;
/* 头部位置按**比例**给：窗口尺寸/人物大小一变，绝对像素就得跟着改。
 * 0.26/0.28/0.42/0.34 是 whale 在默认窗口下的实测取景。 */
const CROP = { x: 0.26, y: 0.28, w: 0.42, h: 0.34 };
const SCALE = 3;

app.whenReady().then(() => {
  let n = 0;
  for (const name of NAMES) {
    const src = path.join(DIR, `pet-${PREFIX}-${name}.png`);
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) { console.log('[zoom] 读不到', path.basename(src)); continue; }
    const { width: W, height: H } = img.getSize();
    const rect = {
      x: Math.round(W * CROP.x),
      y: Math.round(H * CROP.y),
      width: Math.round(W * CROP.w),
      height: Math.round(H * CROP.h)
    };
    const out = img.crop(rect).resize({ width: rect.width * SCALE, height: rect.height * SCALE, quality: 'best' });
    const file = path.join(DIR, `pet-head-${PREFIX}-${name}.png`);
    fs.writeFileSync(file, out.toPNG());
    console.log('[zoom]', name, '→', path.basename(file), JSON.stringify(rect));
    n++;
  }
  console.log('[zoom] done', n);
  app.exit(0);
});
