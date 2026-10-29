'use strict';
/* 把 debug/pet-whaleexp-*.png 的**头部区域**裁出来放大 3 倍（2026-10-29）。
 *
 * 为什么需要：整张截图 400 多像素宽，人物只占中间一块，眉毛/眼睛的变化
 * 在缩略图里根本分辨不出 —— 前几轮"看着没变"很可能就是这么看漏的。
 * 裁头 + 放大，才有资格说"变了/没变"。
 *
 * 跑法：node debug/zoom-whaleexp-heads.js
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const NAMES = ['00-base', 'ctrl-brow', 'star', 'ques', 'excl', 'happy'];
const DIR = __dirname;
const CROP = { x: 0.26, y: 0.28, w: 0.42, h: 0.34 };   // 相对比例，头部大致位置
const SCALE = 3;

app.whenReady().then(() => {
  for (const n of NAMES) {
    const img = nativeImage.createFromPath(path.join(DIR, `pet-whaleexp-${n}.png`));
    if (img.isEmpty()) { console.log('[zoom] 读不到', n); continue; }
    const { width: W, height: H } = img.getSize();
    const rect = {
      x: Math.round(W * CROP.x),
      y: Math.round(H * CROP.y),
      width: Math.round(W * CROP.w),
      height: Math.round(H * CROP.h)
    };
    const out = img.crop(rect).resize({ width: rect.width * SCALE, height: rect.height * SCALE, quality: 'best' });
    const file = path.join(DIR, `pet-head-${n}.png`);
    fs.writeFileSync(file, out.toPNG());
    console.log('[zoom]', n, '→', path.basename(file), JSON.stringify(rect));
  }
  app.exit(0);
});
