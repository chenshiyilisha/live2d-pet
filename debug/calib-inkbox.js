'use strict';

/* 离线量「模型墨水包围盒」—— 给 profiles/<model>.js 的五组几何常数取数。
 *
 * 为什么要有它（与 calib-whale.js 的分工）：
 *   · calib-whale.js 量的是**截图**里的墨水位（整窗、含底座牌），要人眼判读
 *     「哪几行是桌布/哪几行是人」；
 *   · 它依赖窗口、依赖截图时机，模型贴图大时（本机 deepfish 是 5 张 8K 图集）
 *     经常在贴图还没传完时就截，量出一片空白；
 *   · 而且**窗口小的时候人物被裁**，量不到完整包围盒。
 * 本脚本反过来：直接读 moc3 的 drawable 顶点，**不渲染、不依赖窗口**，
 * 因此是小窗口桌宠里唯一稳的量法。
 *
 * 🔴 为什么不在渲染层遍历 drawable 顶点：pet.js 头注释坑 4 明写 ——
 *    Cubism Core 每调一次 getDrawableVertexPositions 都在 WASM 堆上分配数组，
 *    几十个 drawable 连读会把内部缓冲搞坏，模型彻底不渲染。
 *    在**进程外**（Node，无 GL）读是安全的，但别搬进渲染层。
 *
 * 用法：
 *   node debug/calib-inkbox.js src/assets/models/deepfish/大肥鱼.moc3
 *
 * 输出（canvas px = pet.js 的 INK_* 量纲，原点在画布左上、y 向下）：
 *   inkTop / inkLeft / inkW / inkH / inkCx（包围盒中心，仅参考）
 *   headCx      —— 头顶那一带的中心线（居中用，规矩 23：别用包围盒中心）
 *   aabbModel   —— 原始模型单位（原点画布中心、y 向上），排查用
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CORE = path.join(__dirname, '..', 'src', 'assets', 'live2dcubismcore.min.js');

function loadCore() {
  const code = fs.readFileSync(CORE, 'utf8');
  const ctx = {
    console,
    WebAssembly,
    TextDecoder,
    TextEncoder,
    performance,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    module: { exports: {} },
    exports: {},
    require,
    setTimeout,
    clearTimeout
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx.Live2DCubismCore;
}

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node debug/calib-inkbox.js <model.moc3>');
    process.exit(2);
  }

  const Core = loadCore();
  /* WASM 是异步实例化的：等一帧再取 Moc（core 内部 then 之后才可用）。 */
  await new Promise((r) => setTimeout(r, 300));

  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  let moc;
  try {
    moc = Core.Moc.fromArrayBuffer(ab);
  } catch (e) {
    console.error('Moc.fromArrayBuffer 失败：', e && e.message);
    process.exit(1);
  }

  const model = Core.Model.fromMoc(moc);
  model.update();

  const ci = model.canvasinfo;
  const ppu = ci.PixelsPerUnit || 1;
  const CW = ci.CanvasWidth;
  const CH = ci.CanvasHeight;

  const d = model.drawables;
  const n = d.count;
  const opac = d.opacities;
  const vcount = d.vertexCounts;
  const vpos = d.vertexPositions;

  const maskCounts = d.maskCounts;
  const maxMasks = Math.max(...Array.from(maskCounts || [0]));
  const totalClip = new Set();
  for (let i = 0; i < n; i++) {
    const mc = (maskCounts && maskCounts[i]) || 0;
    for (let j = 0; j < mc; j++) totalClip.add(i + '#' + j);
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let used = 0, skipped = 0;
  /* 分桶：没挂遮罩的 drawable（unmasked）与挂了遮罩的（masked）分别量。
   * 用途：Cubism 渲染器的遮罩上限是 36（单 render texture），超了会有一批
   * drawable 被裁成空 —— 若「实拍到的墨水」正好等于 unmasked 的包围盒，
   * 就能确诊"不是取景问题，是遮罩溢出"。 */
  const bucket = {
    unmasked: [Infinity, -Infinity, Infinity, -Infinity],
    masked: [Infinity, -Infinity, Infinity, -Infinity]
  };

  for (let i = 0; i < n; i++) {
    if (!(opac[i] > 0.01)) { skipped++; continue; }
    const arr = vpos[i];
    if (!arr || !arr.length) { skipped++; continue; }
    used++;
    const b = (maskCounts && maskCounts[i] > 0) ? bucket.masked : bucket.unmasked;
    for (let k = 0; k < arr.length; k += 2) {
      const x = arr[k], y = arr[k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < b[0]) b[0] = x;
      if (x > b[1]) b[1] = x;
      if (y < b[2]) b[2] = y;
      if (y > b[3]) b[3] = y;
    }
  }

  const toCanvasX = (mx) => mx * ppu + CW / 2;
  const toCanvasY = (my) => CH / 2 - my * ppu;
  boxOf.mk = { x: toCanvasX, y: toCanvasY };

  const inkLeft = toCanvasX(minX);
  const inkRight = toCanvasX(maxX);
  const inkTop = toCanvasY(maxY);      // 模型 y 向上 → 上沿是 maxY
  const inkBottom = toCanvasY(minY);

  /* 头顶那一带的中心线：取墨水上方 22% 的行带（避开张开的手臂 / 长发下摆），
   * 规矩 23 的老坑 —— 包围盒中心会被单侧的长发/道具拉偏。 */
  const bandTop = inkTop;
  const bandBot = inkTop + (inkBottom - inkTop) * 0.22;
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const arr = vpos[i];
    if (!arr || !arr.length) continue;
    if (!(opac[i] > 0.01)) continue;
    for (let k = 0; k < arr.length; k += 2) {
      const cy = toCanvasY(arr[k + 1]);
      if (cy < bandTop || cy > bandBot) continue;
      const cx = toCanvasX(arr[k]);
      if (cx < hMin) hMin = cx;
      if (cx > hMax) hMax = cx;
    }
  }
  const headCx = Number.isFinite(hMin) ? (hMin + hMax) / 2 : (inkLeft + inkRight) / 2;

  console.log(JSON.stringify({
    file: path.basename(file),
    canvas: { w: CW, h: CH, ppu, originX: ci.CanvasOriginX, originY: ci.CanvasOriginY },
    drawables: { total: n, used, skipped },
    /* ⬇︎ 直接抄进 profiles/<model>.js 的五项（canvas px） */
    geometry: {
      inkTopK: Math.round(inkTop),
      inkH: Math.round(inkBottom - inkTop),
      inkW: Math.round(inkRight - inkLeft),
      inkCxK: Math.round(headCx),
      /* C 项：模型画布就贴在 holder 原点（实测 off.y 与 s 的线性关系印证），
       * 所以「墨水顶 = vh×C + K×s」里 C 取 0、K 就是这里的 inkTopK。 */
      inkTopCRatio: 0
    },
    aabb: {
      left: Math.round(inkLeft), right: Math.round(inkRight),
      top: Math.round(inkTop), bottom: Math.round(inkBottom),
      headBandCx: Math.round(headCx)
    },
    aabbModel: {
      minX: +minX.toFixed(1), maxX: +maxX.toFixed(1),
      minY: +minY.toFixed(1), maxY: +maxY.toFixed(1)
    },
    /* 遮罩体检：单 render texture 下 Cubism 只支持 36 个遮罩，超出部分
     * 会被裁成空（SDK 打 "not supported mask count"）。若实拍墨水 ==
     * unmaskedBox，则"人物不显示"是遮罩溢出而不是取景。 */
    clipping: {
      maxMasksPerDrawable: maxMasks,
      totalMaskRefs: Number.isFinite(maxMasks) ? totalClip.size : 0,
      unmaskedBox: boxOf(bucket.unmasked),
      maskedBox: boxOf(bucket.masked)
    }
  }, null, 2));
})();

/* 模型单位 → canvas px 的桶包围盒（原点左上、y 向下，与 INK_* 同量纲）。 */
function boxOf(b) {
  if (!Number.isFinite(b[0])) return null;
  const mk = boxOf.mk;
  return {
    left: Math.round(mk.x(b[0])), right: Math.round(mk.x(b[1])),
    top: Math.round(mk.y(b[3])), bottom: Math.round(mk.y(b[2])),
    w: Math.round(mk.x(b[1]) - mk.x(b[0])),
    h: Math.round(mk.y(b[2]) - mk.y(b[3]))
  };
}
