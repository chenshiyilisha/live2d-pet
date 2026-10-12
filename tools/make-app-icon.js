'use strict';
/*
 * 生成应用图标 build/icon.ico（安装包、exe、快捷方式都用它）。
 *
 * 形象与托盘图标同源，取自 icon-lib.js。
 *
 * 为什么手写 ICO 封装：ICO 的容器格式比它装的 PNG 还简单 ——
 * 一个 6 字节文件头 + 每张图 16 字节目录项 + 原始 PNG 数据。
 * Vista 之后的 Windows 原生认 PNG-in-ICO，所以不用转 BMP，
 * 也就省掉了 1bpp AND mask 那套东西。
 *
 * ⚠️ 尺寸字段是单字节：256 要写成 0（0 即代表 256），写 256 会溢出成 0
 *    之外的值，Windows 直接不认这个尺寸。
 *
 * 用法： node tools/make-app-icon.js
 * 产出： build/icon.ico
 */
const fs = require('fs');
const path = require('path');
const { encodePng, drawIcon } = require('./icon-lib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'build', 'icon.ico');

// Windows 资源管理器会按显示尺寸挑最接近的一档；六个尺寸覆盖所有常见场合
// （16 任务栏、32 桌面小图标、48 中图标、64/128 大图标、256 超大图标）。
const SIZES = [256, 128, 64, 48, 32, 16];

function encodeIco(images) {
  const n = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(n, 4); // image count

  const entries = [];
  let offset = 6 + n * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // width（0 = 256）
    e[1] = img.size >= 256 ? 0 : img.size; // height
    e[2] = 0; // 调色板颜色数（真彩填 0）
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);  // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(img.data.length, 8); // 图像数据字节数
    e.writeUInt32LE(offset, 12);         // 数据在文件中的偏移
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const images = SIZES.map((size) => {
  const c = drawIcon(size);
  return { size, data: encodePng(c.W, c.H, c.buf) };
});

const ico = encodeIco(images);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, ico);

console.log(`build/icon.ico  ${ico.length} bytes  (${SIZES.join('/')})`);
