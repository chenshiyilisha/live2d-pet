'use strict';
/*
 * 生成托盘图标（PNG）。
 *
 * 绘制逻辑在 icon-lib.js 里 —— 和安装包/exe 用的 .ico 共用同一个形象，
 * 这里只负责落盘。
 *
 * 用法： node tools/make-tray-icon.js
 * 产出： src/assets/tray-16.png、tray-32.png、tray-48.png
 *        debug/tray-preview-32.png、tray-preview-16.png（放大给人看效果）
 */
const fs = require('fs');
const path = require('path');
const { encodePng, drawIcon, upscale } = require('./icon-lib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'src', 'assets');
const DEBUG = path.join(ROOT, 'debug');

fs.mkdirSync(ASSETS, { recursive: true });
fs.mkdirSync(DEBUG, { recursive: true });

const targets = [
  [16, 'tray-16.png'],
  [32, 'tray-32.png'],
  [48, 'tray-48.png']
];

for (const [size, name] of targets) {
  const canvas = drawIcon(size);
  const file = path.join(ASSETS, name);
  fs.writeFileSync(file, encodePng(canvas.W, canvas.H, canvas.buf));
  console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
}

for (const [size, factor, name] of [[32, 8, 'tray-preview-32.png'], [16, 12, 'tray-preview-16.png']]) {
  const big = upscale(drawIcon(size), factor);
  fs.writeFileSync(path.join(DEBUG, name), encodePng(big.W, big.H, big.buf));
  console.log(`debug/${name}  (${size} -> ${size * factor})`);
}
