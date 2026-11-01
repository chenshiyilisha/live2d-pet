/* 从单张源图拆分 Live2D 分层 PNG。
 * 策略：基于颜色分类 + 空间区域，把人物切成 psd2live 认识的语义层。
 * 输出：每层一个透明 PNG + 一个 manifest JSON。
 *
 * 用法: node split-layers.js <源图路径> <输出目录>
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const src = process.argv[2];
const outDir = process.argv[3];
if (!src || !outDir) {
  console.error('用法: node split-layers.js <源图路径> <输出目录>');
  process.exit(1);
}

const png = PNG.sync.read(fs.readFileSync(src));
const W = png.width, H = png.height;
const d = png.data;

// ---- 像素分类 ----
// 0=背景 1=描边/深色 2=皮肤 3=头发 4=衣服 5=眼睛白 6=瞳孔 7=嘴/舌 8=尾巴 9=其他
function classify(r, g, b) {
  // 背景（浅色）
  if (r > 230 && g > 230 && b > 230 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20) return 0;
  // 描边（深色）
  if (r < 80 && g < 80 && b < 100) return 1;
  // 皮肤（暖色，中等亮度）
  if (r > 180 && r < 250 && g > 150 && g < 220 && b > 100 && b < 200 && r > g && g > b) return 2;
  // 头发（深蓝/蓝黑）
  if (b > r && b > g && b > 60 && r < 200) return 3;
  // 衣服（白色/浅色但非背景）
  if (r > 200 && g > 200 && b > 200) return 5; // 衣服白
  // 瞳孔（深色但非描边）
  if (r < 100 && g < 100 && b < 120) return 6;
  // 嘴/舌（红/粉）
  if (r > 150 && g < 150 && b < 150) return 7;
  // 尾巴（蓝色调）
  if (b > r && b > 80) return 8;
  // 其他
  return 9;
}

const cls = new Uint8Array(W * H);
for (let i = 0, p = 0; i < W * H; i++, p += 4) {
  cls[i] = classify(d[p], d[p + 1], d[p + 2]);
}

// ---- 定义层区域 ----
// 每层：name, role, bbox (x1,y1,x2,y2), classFilter (保留哪些分类)
const layers = [
  {
    name: 'back_hair',
    role: 'back_hair',
    bbox: [300, 20, 720, 350],
    keep: [3, 1], // 头发 + 描边
  },
  {
    name: 'body',
    role: 'body',
    bbox: [300, 300, 720, 1500],
    keep: [1, 2, 9], // 描边 + 皮肤 + 其他(身体)
  },
  {
    name: 'face',
    role: 'face',
    bbox: [360, 150, 660, 420],
    keep: [2, 1], // 皮肤 + 描边
  },
  {
    name: 'eyewhite_l',
    role: 'eyewhite',
    bbox: [400, 250, 480, 340],
    keep: [5, 1],
  },
  {
    name: 'eyewhite_r',
    role: 'eyewhite',
    bbox: [540, 250, 620, 340],
    keep: [5, 1],
  },
  {
    name: 'irides_l',
    role: 'irides',
    bbox: [420, 260, 470, 330],
    keep: [6, 1],
  },
  {
    name: 'irides_r',
    role: 'irides',
    bbox: [550, 260, 600, 330],
    keep: [6, 1],
  },
  {
    name: 'eyelash_l',
    role: 'eyelash',
    bbox: [400, 240, 490, 280],
    keep: [1],
  },
  {
    name: 'eyelash_r',
    role: 'eyelash',
    bbox: [530, 240, 620, 280],
    keep: [1],
  },
  {
    name: 'eyebrow_l',
    role: 'eyebrow',
    bbox: [410, 220, 490, 250],
    keep: [1, 3],
  },
  {
    name: 'eyebrow_r',
    role: 'eyebrow',
    bbox: [530, 220, 610, 250],
    keep: [1, 3],
  },
  {
    name: 'mouth',
    role: 'mouth',
    bbox: [460, 360, 560, 400],
    keep: [7, 1, 2],
  },
  {
    name: 'front_hair',
    role: 'front_hair',
    bbox: [340, 20, 680, 250],
    keep: [3, 1],
  },
  {
    name: 'tail',
    role: 'tail',
    bbox: [500, 300, 910, 750],
    keep: [8, 3, 1],
  },
  {
    name: 'topwear',
    role: 'topwear',
    bbox: [380, 380, 640, 550],
    keep: [4, 1],
  },
  {
    name: 'bottomwear',
    role: 'bottomwear',
    bbox: [380, 500, 640, 700],
    keep: [4, 1, 3],
  },
];

// ---- 生成每层 PNG ----
fs.mkdirSync(outDir, { recursive: true });
const manifestLayers = [];

for (const layer of layers) {
  const [x1, y1, x2, y2] = layer.bbox;
  const lw = x2 - x1 + 1;
  const lh = y2 - y1 + 1;
  const img = Buffer.alloc(lw * lh * 4);

  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const sx = x1 + x;
      const sy = y1 + y;
      const si = sy * W + sx;
      const ci = cls[si];
      const li = (y * lw + x) * 4;

      if (layer.keep.includes(ci)) {
        const p = si * 4;
        img[li] = d[p];
        img[li + 1] = d[p + 1];
        img[li + 2] = d[p + 2];
        img[li + 3] = 255;
      } else {
        img[li] = 0;
        img[li + 1] = 0;
        img[li + 2] = 0;
        img[li + 3] = 0;
      }
    }
  }

  const layerPng = PNG.sync.write(
    Object.assign(new PNG({ width: lw, height: lh }), { data: img })
  );
  const layerFile = path.join(outDir, `${layer.name}.png`);
  fs.writeFileSync(layerFile, layerPng);

  manifestLayers.push({
    name: layer.name,
    image: { path: `${layer.name}.png`, width: lw, height: lh },
    rect: { left: x1, top: y1, width: lw, height: lh },
    tags: [layer.role],
  });

  // 统计像素数
  let px = 0;
  for (let i = 3; i < img.length; i += 4) if (img[i] > 0) px++;
  console.log(`${layer.name}: ${lw}x${lh} px=${px} (${(px / (lw * lh) * 100).toFixed(1)}%)`);
}

// ---- 写 manifest ----
const manifest = {
  format: 'psd2live-layout',
  version: 1,
  name: 'whale-girl',
  canvas: { width: W, height: H },
  layers: manifestLayers,
};

const manifestPath = path.join(outDir, 'manifest.json');
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`\nManifest: ${manifestPath}`);
console.log(`Canvas: ${W}x${H}, Layers: ${manifestLayers.length}`);
