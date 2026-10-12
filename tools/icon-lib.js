'use strict';
/*
 * 图标绘制库 —— 纯函数，不碰文件系统。
 *
 * 为什么单独拆出来：托盘图标（16/32/48 png）和应用图标（安装包/exe 用的 .ico）
 * 必须是同一个形象。各画一份的话，"改了脸忘了改托盘"这种偏差肉眼很难发现，
 * 所以绘制逻辑只能有一处定义。
 *
 * 为什么手写 PNG 编码器而不用库：图形是纯几何的（一堆抗锯齿椭圆），
 * 手写 zlib + CRC32 + IHDR/IDAT/IEND 比引依赖更可控，也躲开了本机的代理问题。
 *
 * 导出：encodePng / makeCanvas / blend / ellipse / drawIcon / upscale
 */
const zlib = require('zlib');

/* ============================================================
 *  PNG 编码
 * ========================================================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(W, H, rgba) {
  const stride = W * 4;
  const raw = Buffer.alloc((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (stride + 1)] = 0; // filter = none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10/11/12 保持 0：deflate / 自适应滤波 / 无隔行
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============================================================
 *  光栅化
 * ========================================================== */

function makeCanvas(W, H) {
  return { W, H, buf: Buffer.alloc(W * H * 4) };
}

// source-over（非预乘，内部保持直通 alpha 便于反复叠加）
function blend(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.W || y >= c.H || a <= 0) return;
  const i = (y * c.W + x) * 4;
  const sa = a / 255;
  const da = c.buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) { c.buf[i + 3] = 0; return; }
  c.buf[i] = Math.round((r * sa + c.buf[i] * da * (1 - sa)) / oa);
  c.buf[i + 1] = Math.round((g * sa + c.buf[i + 1] * da * (1 - sa)) / oa);
  c.buf[i + 2] = Math.round((b * sa + c.buf[i + 2] * da * (1 - sa)) / oa);
  c.buf[i + 3] = Math.round(oa * 255);
}

// 抗锯齿椭圆：每像素 4x4 超采样算覆盖率，只调一次 blend，不会叠加变暗
function ellipse(c, cx, cy, rx, ry, rgb, alpha = 255) {
  const SS = 4;
  const x0 = Math.floor(cx - rx - 1);
  const x1 = Math.ceil(cx + rx + 1);
  const y0 = Math.floor(cy - ry - 1);
  const y1 = Math.ceil(cy + ry + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        const py = y + (sy + 0.5) / SS;
        const dy = (py - cy) / ry;
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const dx = (px - cx) / rx;
          if (dx * dx + dy * dy <= 1) hit++;
        }
      }
      if (!hit) continue;
      blend(c, x, y, rgb[0], rgb[1], rgb[2], (alpha * hit) / (SS * SS));
    }
  }
}

/* ============================================================
 *  图标设计
 *
 *  以 32x32 为基准网格，绘制时按目标尺寸等比缩放 —— 这样每个尺寸
 *  都是"原生分辨率"（在目标画布上现算），不是把某一张硬缩过去。
 *
 *  形象：桃濑日和的 Q 版头像 —— 棕发双马尾、红色发饰、藏青水手服领。
 *  托盘图标在任务栏里只有 16~20px，所以只保留对比度最高的几个特征。
 * ========================================================== */

const C = {
  hairDeep: [0x5c, 0x43, 0x31],
  hairDark: [0x7a, 0x5c, 0x45],
  hair: [0x9c, 0x7a, 0x5c],
  hairLit: [0xb8, 0x95, 0x74],
  skin: [0xfb, 0xe3, 0xcc],
  eye: [0x3f, 0x4f, 0x7d],
  mouth: [0xd0, 0x7a, 0x78],
  ribbon: [0xd9, 0x4a, 0x52],
  ribbonDark: [0xa8, 0x2f, 0x38],
  uniform: [0x33, 0x40, 0x5e],
  collar: [0xe8, 0xec, 0xf2]
};

function drawIcon(pxSize) {
  const c = makeCanvas(pxSize, pxSize);
  const k = pxSize / 32; // 从 32 网格到目标尺寸的缩放
  const e = (x, y, rx, ry, rgb, a) => ellipse(c, x * k, y * k, rx * k, ry * k, rgb, a);
  // 16px 是任务栏里最常见的实际尺寸，细节塞多了只会糊成一团，
  // 所以小尺寸走精简版：去掉高光/腮红/领口白线，只留对比度最高的特征。
  const fine = pxSize > 16;

  // ---- 身体 / 肩（先画，会被头盖住一部分）----
  e(16, 32.5, 11.5, 8.5, C.uniform);

  // ---- 双马尾（用更深的棕，和头部拉开层次）----
  e(4.6, 16.5, 4.3, 10.2, C.hairDeep);
  e(27.4, 16.5, 4.3, 10.2, C.hairDeep);
  e(4.6, 15, 3.5, 8.8, C.hairDark);
  e(27.4, 15, 3.5, 8.8, C.hairDark);

  // ---- 头（头发轮廓）----
  e(16, 15.5, 11.6, 12.2, C.hairDark);
  e(16, 15.2, 11.0, 11.6, C.hair);

  // ---- 脸 ----
  e(16, 18.6, 8.0, 8.4, C.skin);

  // ---- 刘海：盖住额头，做出"头发压下来"的分量 ----
  e(16, 12.4, 9.9, 5.6, C.hair);
  if (fine) e(16, 10.8, 6.6, 3.0, C.hairLit, 90);

  // ---- 眼睛 ----
  e(12.2, 18.9, 2.0, 2.6, C.eye);
  e(19.8, 18.9, 2.0, 2.6, C.eye);
  if (fine) {
    // 高光只在稍大的尺寸上画；16px 下它会变成一个突兀的白点
    e(11.4, 17.9, 0.75, 0.75, [255, 255, 255], 235);
    e(19.0, 17.9, 0.75, 0.75, [255, 255, 255], 235);
    // 腮红
    e(9.4, 21.6, 1.5, 0.9, [0xf0, 0xa0, 0x9a], 105);
    e(22.6, 21.6, 1.5, 0.9, [0xf0, 0xa0, 0x9a], 105);
  }

  // ---- 嘴 ----
  e(16, 23.2, 1.25, 0.85, C.mouth);

  // ---- 红色发饰（扎在双马尾根部）----
  e(4.9, 9.4, 2.5, 2.2, C.ribbonDark);
  e(4.9, 9.1, 2.1, 1.8, C.ribbon);
  e(27.1, 9.4, 2.5, 2.2, C.ribbonDark);
  e(27.1, 9.1, 2.1, 1.8, C.ribbon);

  // ---- 水手服领子 ----
  if (fine) {
    e(16, 27.6, 7.2, 3.0, C.collar, 235);
    e(16, 29.6, 8.4, 3.4, C.uniform);
  } else {
    e(16, 28.8, 7.4, 3.6, C.collar, 230);
  }

  return c;
}

// 最近邻放大，只用于人眼检查
function upscale(c, factor) {
  const out = makeCanvas(c.W * factor, c.H * factor);
  for (let y = 0; y < out.H; y++) {
    for (let x = 0; x < out.W; x++) {
      const si = ((y / factor | 0) * c.W + (x / factor | 0)) * 4;
      const di = (y * out.W + x) * 4;
      c.buf.copy(out.buf, di, si, si + 4);
    }
  }
  return out;
}

module.exports = { encodePng, makeCanvas, blend, ellipse, drawIcon, upscale };
