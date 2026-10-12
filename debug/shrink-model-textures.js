'use strict';
/* 把模型的 2048 纹理降采样到 1024，用来量「纹理到底吃多少内存」。
 *
 * 背景：Hiyori 的两张纹理都是 2048×2048 RGBA = 每张 16.8MB 解码位图，
 * 而窗口只有 308px 宽、人物墨水宽约 150px —— 2048 的细节在这个显示尺寸上
 * 一个像素都看不出来。这份脚本只做「量收益」用，默认**不动**原文件以外的任何东西。
 *
 * 安全设计：
 *   · 第一次运行会把原图复制成 texture_00.png.orig（只复制一次，不覆盖已有备份）
 *   · SHRINK_RESTORE=1 时从 .orig 还原，然后自己停手 —— 测完务必还原
 *   · 已经把 model3.json 的路径考虑在内：文件名不变，所以不用改 json
 *
 * 用法：
 *   ./node_modules/electron/dist/electron.exe debug/shrink-model-textures.js
 *   SHRINK_TO=1024 ...（默认 1024）
 *   SHRINK_RESTORE=1 ./node_modules/electron/dist/electron.exe debug/shrink-model-textures.js
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const MODEL = path.join(__dirname, '..', 'src', 'assets', 'models', 'hiyori', 'Hiyori.2048');
const TARGET = Number(process.env.SHRINK_TO || 1024);
const RESTORE = process.env.SHRINK_RESTORE === '1';

app.whenReady().then(() => {
  if (!fs.existsSync(MODEL)) {
    console.error('[shrink] 找不到模型目录:', MODEL);
    app.exit(1);
    return;
  }
  for (const f of fs.readdirSync(MODEL).filter((n) => n.endsWith('.png'))) {
    const full = path.join(MODEL, f);
    const bak = full + '.orig';

    if (RESTORE) {
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, full);
        fs.unlinkSync(bak);
        console.log('[shrink] 已还原', f);
      }
      continue;
    }

    if (!fs.existsSync(bak)) fs.copyFileSync(full, bak);
    const img = nativeImage.createFromPath(bak);
    const { width, height } = img.getSize();
    if (width <= TARGET) { console.log('[shrink] 跳过（已经够小）', f, width); continue; }
    const h2 = Math.round((height * TARGET) / width);
    const out = img.resize({ width: TARGET, height: h2, quality: 'good' });
    fs.writeFileSync(full, out.toPNG());
    console.log('[shrink]', f, `${width}x${height}`, '→', `${TARGET}x${h2}`,
      '· 磁盘', Math.round(fs.statSync(full).size / 1024) + 'KB',
      '· 解码位图', Math.round((TARGET * h2 * 4) / 1048576 * 10) / 10 + 'MB');
  }
  console.log('[shrink] 完成');
  app.exit(0);
});
