'use strict';

/* ============================================================
 *  「幻影参数」防回流断言（源码级，不起 Electron）
 * ==========================================================
 *
 *  背景（2026-10-29，六轮真机探针定位，?snap=whaleexp）：
 *    框架的 CubismModel.getParameterIndex(字符串) 拿字符串和
 *    _parameterIds 里的 **CubismId 对象**做 != 比较 → 永远 miss
 *    → 写进 _notExistParameterValues（幻影表）→ readParam 读幻影表
 *    自洽、画面永远不动、零报错。
 *    修法：全项目参数读写只走「按索引」两条路（setParameterValueByIndex /
 *    getParameterValueByIndex），索引表按 model 实例缓存。
 *
 *  断言若红，最可能是有人图省事把 byId 写了回去 —— 那条路"看着成功"
 *  实际全是幻影，回归代价是整个情绪系统静默失效。
 *
 *  跑法：node debug/verify-param-channel.js
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const pet = stripComments(read('renderer/pet.js'));

console.log('[A] 按名读写必须绝迹');
{
  // 函数调用形式（带左括号）才拦；注释里的提法已在 stripComments 时剥掉
  ok(!/setParameterValueById\(/.test(pet),
    'pet.js 不许再调用 setParameterValueById（幻影写入通道）');
  ok(!/getParameterValueById\(/.test(pet),
    'pet.js 不许再调用 getParameterValueById（读幻影表 = 自洽的假象）');
}

console.log('[B] 索引通道存在且正确');
{
  ok(/function paramIndexOf\(/.test(pet), 'paramIndexOf 存在（名字→索引的唯一入口）');
  ok(/paramIdxCache\.model !== model/.test(pet),
    '索引缓存按 model 实例失效（切模型不重建 = 拿旧索引写新模型）');
  ok(/setParameterValueByIndex\(idx, value, 1\)/.test(pet),
    '写走 setParameterValueByIndex(idx, value, 1)（1 = 完全覆盖）');
  ok(/getParameterValueByIndex\(idx\)/.test(pet), '读走 getParameterValueByIndex(idx)');
  ok(/idToStr\(/.test(pet) && /getString\?\.\(\)/.test(pet),
    'idToStr 解 csmString（getString() 返回 {s:"..."} 不是字符串）');
}

console.log('[C] 防御性细节');
{
  // setParam 对非有限数值直接 return —— NaN/undefined 写进参数表是静默灾难
  ok(/typeof value !== 'number' \|\| !Number\.isFinite\(value\)/.test(pet),
    'setParam 拒绝非有限数值');
  // 查不到索引必须 warn 一次且**不许**回退 byId
  ok(/param-miss/.test(pet), '索引 miss 有一次性 warn（param-miss）');
  ok(/paramMissWarned\.clear\(\)/.test(pet), '换模型清空 miss 记录（旧结论不适用新模型）');
}

console.log('[D] 负对照锚点（这些串若消失，本文件的断言等于没守）');
{
  ok(pet.includes('paramIndexOf'), '锚点 paramIndexOf');
  ok(pet.includes('paramIdxCache'), '锚点 paramIdxCache');
}

process.exit(fails ? 1 : 0);
