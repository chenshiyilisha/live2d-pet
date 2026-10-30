'use strict';
/* X1 运行时切模型 + whale 署名 */

const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (c, m) => { if (c) console.log('  PASS', m); else { console.log('  FAIL', m); fails++; } };

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('[A] params.applyProfile');
{
  const params = read('src/renderer/params.js');
  ok(/export function applyProfile\(/.test(params), '有 applyProfile');
  ok(/export let PARAM/.test(params) && /export let EMOTION/.test(params),
    'PARAM/EMOTION 是 let（可热换）');
  ok(/export let EMO_RANGE/.test(params) && /export let EMO_SPEED/.test(params),
    'EMO_RANGE/EMO_SPEED 是 let');
  ok(/WHALE_CREDIT|credit/.test(read('src/renderer/profiles/whale.js')),
    'whale 档案带署名常量');
}

console.log('\n[B] 配置默认 + 托盘');
{
  const cfg = read('src/main/config.js');
  ok(/model:\s*'hiyori'/.test(cfg) || /model:\s*"hiyori"/.test(cfg),
    'appearance.model 默认 hiyori（whale 不上架默认）');
  const main = read('src/main/main.js');
  ok(/人物模型|外观.*model|appearance\.model/.test(main), '托盘可切模型');
  ok(/setAppearanceModel|switchModel|applyAppearanceModel/.test(main),
    '主进程有切模型入口');
  ok(/署名|credit|Andersen|VTube/.test(main), '切到 whale 有署名 toast');
}

console.log('\n[C] 渲染层热换');
{
  const pet = read('src/renderer/pet.js');
  ok(/applyProfile\(/.test(pet), 'pet 调 applyProfile');
  ok(/mountModel\(/.test(pet) && /appearance\?\.model/.test(pet),
    'boot/config 变化按 appearance.model 挂载');
  ok(/mountGen|switchGen/.test(pet), '切模型有世代守卫（防竞态）');
}

console.log(fails ? `\n❌ ${fails} 失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
