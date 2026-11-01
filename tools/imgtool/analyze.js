/* 成分分析：以「深色描边 + 浅色背景」为屏障，把人物像素切成 4-连通成分。
 * 每个成分报告：包围盒、像素数、主色（用于人工判读是什么部件）。
 * 用法: node analyze.js <png>
 */
const fs = require('fs');
const { PNG } = require('pngjs');

const file = process.argv[2];
const png = PNG.sync.read(fs.readFileSync(file));
const W = png.width, H = png.height;
const d = png.data;

function isLine(r, g, b) { return r < 70 && g < 70 && b < 85; }
function isBg(r, g, b) { return r > 225 && g > 225 && b > 225 && Math.abs(r - g) < 18 && Math.abs(g - b) < 18; }

const kind = new Uint8Array(W * H); // 0=line 1=bg 2=part
for (let i = 0, p = 0; i < W * H; i++, p += 4) {
  if (isLine(d[p], d[p + 1], d[p + 2])) kind[i] = 0;
  else if (isBg(d[p], d[p + 1], d[p + 2])) kind[i] = 1;
  else kind[i] = 2;
}

const comp = new Int32Array(W * H).fill(-1);
const comps = [];
const stack = new Int32Array(W * H);
for (let s = 0; s < W * H; s++) {
  if (kind[s] !== 2 || comp[s] !== -1) continue;
  const id = comps.length;
  comps.push({ n: 0, minX: W, minY: H, maxX: 0, maxY: 0, colors: {} });
  let sp = 0; stack[sp++] = s; comp[s] = id;
  while (sp > 0) {
    const c = stack[--sp];
    const x = c % W, y = (c - x) / W;
    const c0 = comps[id];
    if (x < c0.minX) c0.minX = x; if (x > c0.maxX) c0.maxX = x;
    if (y < c0.minY) c0.minY = y; if (y > c0.maxY) c0.maxY = y;
    c0.n++;
    const p = (c) * 4;
    // 主色量化
    const key = ((d[p] >> 4) << 8) | ((d[p + 1] >> 4) << 4) | (d[p + 2] >> 4);
    c0.colors[key] = (c0.colors[key] || 0) + 1;
    if (x > 0) { const q = c - 1; if (kind[q] === 2 && comp[q] === -1) { comp[q] = id; stack[sp++] = q; } }
    if (x < W - 1) { const q = c + 1; if (kind[q] === 2 && comp[q] === -1) { comp[q] = id; stack[sp++] = q; } }
    if (y > 0) { const q = c - W; if (kind[q] === 2 && comp[q] === -1) { comp[q] = id; stack[sp++] = q; } }
    if (y < H - 1) { const q = c + W; if (kind[q] === 2 && comp[q] === -1) { comp[q] = id; stack[sp++] = q; } }
  }
}

// 主色名
function colorName(r, g, b) {
  if (r > 200 && g > 200 && b > 200) return 'white/light';
  if (b > r + 15 && b > g + 15) return 'blue';
  if (r > 180 && g > 130 && g < 225 && b > 100 && b < 210 && r >= g && g >= b) return 'skin';
  if (r > g && g > b) return 'warm(skin?)';
  if (g > r && g > b) return 'green';
  if (r > 150 && g < 120 && b < 120) return 'red';
  if (r < 100 && g < 100 && b < 100) return 'dark';
  return `rgb(${r},${g},${b})`;
}

comps.sort((a, b) => b.n - a.n);
console.log(`图像 ${W}x${H}，成分总数 ${comps.length}`);
comps.forEach((c, i) => {
  const [kr, kg, kb] = Object.entries(c.colors).sort((a, b) => b[1] - a[1])[0][0].match(/.{2}/g).map(x => parseInt(x, 16) * 17);
  console.log(`#${i} px=${String(c.n).padStart(6)} bbox=[${c.minX}..${c.maxX}, ${c.minY}..${c.maxY}] ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1} 主色=${colorName(kr, kg, kb)}`);
});
