'use strict';
/* 裁 pet-mood-sleepy.png 的顶部条带（问号贴纸嫌疑区，y=70..210）放大 2 倍。
 * 问号 d110 的锚点在头部右上方，zoom-heads.js 的头部框（y≥0.28H）框不到它。 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
app.whenReady().then(() => {
  const img = nativeImage.createFromPath(__dirname + '/pet-mood-sleepy.png');
  const { width, height } = img.getSize();
  const out = img.crop({ x: 60, y: 60, width: width - 60, height: 180 })
    .resize({ width: (width - 60) * 2, height: 360, quality: 'best' });
  fs.writeFileSync(__dirname + '/pet-head-mood-sleepy-top.png', out.toPNG());
  console.log('[croptop] saved', width, height);
  app.exit(0);
});
