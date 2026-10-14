'use strict';
/* 纹理 LOD 的验收。
 *
 * 两块内容：
 *   A. level 公式单测 —— 把 pet.js 里那条公式按原样复制（tray-dump.js 同款
 *      "从源码切的副本"），用正则确认源码里的表达式仍在、没被改坏。
 *   B. 源码级接线 —— 介入点必须在首次渲染之前（mountModel 里 layout() 之后），
 *      换法必须是「换 resource + update()」而不是另建 TextureSource
 *      （后者要手抄 scaleMode/addressMode/alphaMode，漏一个就是渲染异常）。
 *
 * 实测基线（2026-10-14）：窗口 308×342 / DPR 1.5 时人物墨迹约 120 CSS px 宽，
 * 纹理 2048 → level 1（1024），两张省 24MB 显存；截图像素包围盒对比无差异。
 *
 * 用法：node debug/verify-texture-lod.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

const pet = fs.readFileSync(path.join(ROOT, 'src/renderer/pet.js'), 'utf8');

console.log('══════ A. level 公式 ══════\n');

/* 与 pet.js applyTextureLod 里的表达式逐字一致 —— 改那边必须同步这边。 */
function levelOf(w, onScreenPx, maxLevel) {
  return Math.max(0, Math.min(maxLevel, Math.floor(Math.log2(w / Math.max(1, onScreenPx)))));
}

/* 源码里的公式还在（没有"改一半"） */
check(/Math\.floor\(Math\.log2\(w \/ Math\.max\(1, onScreenPx\)\)\)/.test(pet),
  'pet.js 的 level 公式仍在（log2(纹理宽/屏幕需求)）');

const TEX_LOD = { maxLevel: 1, margin: 2 };
const INK_W = 897;                    // params.js MODELS.hiyori.inkW（放宽值）
const s = 0.19097;                    // 实测 holder.scale（窗口 308×342）
const DPR = 1.5;

/* 基准场景：默认窗口 → 应降到 1024 */
{
  const onScreen = INK_W * s * DPR * TEX_LOD.margin;
  check(levelOf(2048, onScreen, TEX_LOD.maxLevel) === 1,
    `默认窗口（屏幕需求 ${onScreen.toFixed(0)}px）→ level 1（1024，两张省 24MB）`);
}
/* 用户放大到 1.4×：margin=2 覆盖得住，仍然 1024 不糊 */
{
  const onScreen = INK_W * s * 1.4 * DPR * TEX_LOD.margin;
  check(levelOf(2048, onScreen, TEX_LOD.maxLevel) === 1,
    '放大 1.4× → 仍 level 1（margin 覆盖住放大倍数）');
}
/* 屏幕需求大于纹理（超大窗口 / 未来换大模型）→ 不降 */
check(levelOf(2048, 4096, TEX_LOD.maxLevel) === 0, '屏幕需求超过纹理宽 → level 0（不降）');
check(levelOf(2048, 2048, TEX_LOD.maxLevel) === 0, '屏幕需求正好等于纹理 → level 0（1:1 不降）');
/* 极小需求也只降到 maxLevel，不会一路降到 1×1 */
check(levelOf(2048, 1, TEX_LOD.maxLevel) === 1, '需求趋近 0 → 被 maxLevel 封顶（不会狂降）');
/* maxLevel 是唯一闸门：改成 2 时 512 档可达（这条锁定"闸门真的接进公式了"） */
check(levelOf(2048, 100, 2) === 2, 'maxLevel=2 时小需求可到 level 2（闸门参数真的生效）');

console.log('\n══════ B. 接线（源码级） ══════\n');

check(/const TEX_LOD = \{ maxLevel: 1, margin: 2 \};/.test(pet),
  'TEX_LOD = { maxLevel: 1, margin: 2 }（1024 档：本机 DPR 下仍剩约 1.9 倍过采样）');

/* 介入点：必须在 layout() 之后（holder.scale 就绪 + 首次渲染之前） */
{
  const m = pet.match(/layout\(\);\s*\n\s*applyTextureLod\(next\);/);
  check(!!m, 'mountModel 里 layout() 之后立刻 applyTextureLod（首帧渲染前换 resource，一次带宽都不白烧）');
}
check(/function applyTextureLod\(m\)\s*\{/.test(pet), 'applyTextureLod 函数存在');
check(/cfg\?\.appearance\?\.textureLod\s*===\s*false/.test(pet),
  '开关语义 `=== false` —— 默认开（写成 !cfg… 会把 undefined 也当关）');
check(/src\.resource\s*=\s*cv;/.test(pet) && /src\.update\(\);/.test(pet),
  '换法是「resource = canvas + update()」—— 采样样式全留在原 source 上，不用手抄');
check(!/new PIXI\.TextureSource/.test(pet),
  '没有另建 TextureSource（手抄样式漏一个就是渲染异常）');
check(/drawImage\(src\.resource, 0, 0, nw, nh\)/.test(pet),
  '重采样走 canvas drawImage（ImageBitmap/Image 都吃）');

const cfg = fs.readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8');
check(/appearance:\s*\{[\s\S]*?textureLod:\s*true/.test(cfg), 'config.js 默认 textureLod: true');

const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
check(/flag\('appearance',\s*'textureLod'/.test(main), "main.js 托盘有「纹理降档（省显存）」勾选项");

console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（纹理 LOD）');
