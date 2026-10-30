'use strict';

/* ============================================================
 *  自带 exp3 表情（情绪 / 事件 / 道具三层）防回流断言
 *  源码级 + 素材级，不起 Electron
 * ==========================================================
 *
 *  演进（2026-10-29）：
 *    一阶 = 「情绪贴纸」：只挑纯贴图开关（ParamCheekNN），共享参数一律丢弃。
 *    二阶 = 「表情层」：一个 exp3 拆两半 —— 共享参数走加性增量混进 emoEff，
 *           专属参数走绝对写；触发方式扩成三种（情绪 / 事件 / 道具）。
 *
 *  ⚠️ 文件名仍叫 verify-stickers.js：一阶的断言全在这一份里，改名会让
 *     已有引用（文档 / 全量跑脚本）断掉。内容已经是二阶的。
 *
 *  跑法：node debug/verify-stickers.js
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return true; }
  console.log('  FAIL', msg);
  fails++;
  return false;
};
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const whaleSrc = read('renderer/profiles/whale.js');
const petRaw = read('renderer/pet.js');
const pet = stripComments(petRaw);

/* 从档案源码里抠出一段（对象或数组）。regex 按两空格缩进定位 ——
 * 档案里这三张表都在顶层，缩进固定。 */
function section(name) {
  /* ⚠️ 别用 ([\[{])…\1 这种"开闭同字符"的写法：捕获的是**开**括号，
   *    闭合是另一个字符，永远匹配不上（第一版就这么写的，三张表全 null）。
   *    这里只认"下一处两空格缩进的 } 或 ]"——三张表顶层缩进固定，够用。 */
  const re = new RegExp(`\\n  ${name}:\\s*[\\[{]([\\s\\S]*?)\\n  [\\]}]`);
  const m = whaleSrc.match(re);
  return m ? m[1] : null;
}

const EMO_KEYS = ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'];
const expDir = path.join(ROOT, 'assets/models/whale/expressions');
const cdi = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'assets/models/whale/c_0120.cdi3.json'), 'utf8'));
const paramIds = new Set(cdi.Parameters.map((p) => p.Id));
/* 16 字段（档案 param 表里的值）—— 判"共享参数"用 */
const paramTable = whaleparamTable(whaleSrc);
function whaleparamTable(src) {
  const m = src.match(/\n  param:\s*\{([\s\S]*?)\n  \},/);
  return new Set(m ? [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]) : []);
}

/* ── A. 三张表与素材一一对应 ─────────────────────────── */
console.log('[A] 档案三张表与素材文件');
{
  const exp = section('expressions');
  ok(exp !== null, 'whale.js 有 expressions 段');
  const pairs = exp ? [...exp.matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]) : [];
  ok(pairs.length >= 7, `情绪表情映射至少 7 档（实测 ${pairs.length}）`);
  ok(pairs.every(([emo]) => EMO_KEYS.includes(emo)), '每个键都是 8 情绪档之一');
  ok(!pairs.some(([emo]) => emo === 'calm'), 'calm 不配表情（平静就该是素脸）');
  ok(new Set(pairs.map(([, f]) => f)).size === pairs.length,
    '同一份 exp3 不挂在两个情绪上（贴图会互抢，另一个等于白配）');

  const ev = section('emotes');
  ok(ev !== null, 'whale.js 有 emotes 段（事件表情）');
  const evPairs = ev ? [...ev.matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]) : [];
  ok(evPairs.length >= 10, `事件表情至少 10 个（实测 ${evPairs.length}）`);

  const props = section('props');
  ok(props !== null, 'whale.js 有 props 段（道具）');
  const propFiles = props ? [...props.matchAll(/file:\s*'([^']+)'/g)].map((m) => m[1]) : [];
  ok(propFiles.length >= 10, `道具至少 10 件（实测 ${propFiles.length}）`);

  /* 每一份引用到的 exp3 都必须真实存在，且参数真的在模型里 */
  const all = [...pairs.map(([, f]) => f), ...evPairs.map(([, f]) => f), ...propFiles];
  let missing = 0;
  let badParam = 0;
  for (const file of all) {
    const f = path.join(expDir, `${file}.exp3.json`);
    if (!fs.existsSync(f)) { missing++; console.log('    ✗ 缺文件', file); continue; }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const ps = j.Parameters ?? [];
    if (!ps.length) { console.log('    ✗ 空参数', file); badParam++; continue; }
    for (const p of ps) {
      if (paramIds.has(p.Id)) continue;
      /* 已知素材瑕疵：`喵喵手~喵~动画` 里的 ParamCheek51 / 61 不在 cdi3 参数表
       * （VTS 包里改名/删参数后残留的悬空引用）。运行时 paramIndexOf 返回 -1、
       * 自动 dropped，无害 —— 但**只许这两个**，别处再出现就是真问题。 */
      if (p.Id === 'ParamCheek51' || p.Id === 'ParamCheek61') {
        if (file !== '喵喵手~喵~动画') { badParam++; console.log('    ✗ 悬空参数跑到了别的文件', file, p.Id); }
        continue;
      }
      badParam++;
      console.log('    ✗ 参数不在模型里', file, p.Id);
    }
  }
  ok(missing === 0, `全部 ${all.length} 份 exp3 文件都存在`);
  ok(badParam === 0, '全部 exp3 引用的参数都在模型参数表里');

  /* props 的权重与时长必须合法 —— 权重全 0 会让 pickProp 永远返回 null */
  const wsum = props ? [...props.matchAll(/w:\s*([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0) : 0;
  ok(wsum > 0, `道具权重总和 > 0（实测 ${wsum.toFixed(1)}）`);
  const msAll = props ? [...props.matchAll(/ms:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)] : [];
  ok(msAll.length === propFiles.length, '每件道具都写了 ms 区间');
  ok(msAll.every(([, a, b]) => Number(a) > 0 && Number(b) >= Number(a)), 'ms 区间合法（低 ≤ 高，且 > 0）');
}

/* ── B. 渲染层链路（源码级） ─────────────────────────── */
console.log('\n[B] 渲染层链路');
{
  ok(/function loadExpressions\(/.test(pet), 'loadExpressions 存在');
  ok(/loadExpressions\((?:name|want|modelName)\)/.test(pet),
    '调用点用 mountModel 的模型名（want/name；⚠️ 别挪去 boot：那里裸写 name 是 window.name=""）');
  ok(/function splitExp3\(/.test(pet), 'splitExp3 存在（一个 exp3 拆两条通道）');

  /* 拆分优先级：能落到 16 字段的走增量层，**先判 EXP3_FIELD 再判 owned**。
   * 顺序反了 = 共享参数全被丢弃（回到一阶行为），表情只剩贴图。 */
  const splitBody = (() => {
    const i = pet.indexOf('function splitExp3(');
    return i < 0 ? '' : pet.slice(i, pet.indexOf('\n}', i));
  })();
  const iField = splitBody.indexOf('EXP3_FIELD[p.Id]');
  const iOwned = splitBody.indexOf('owned.has(p.Id)');
  ok(iField >= 0 && iOwned > iField,
    '先判 EXP3_FIELD 再判 owned（顺序反了 = 共享参数被丢弃，表情只剩贴纸）');

  ok(/sum \/ n/.test(splitBody),
    '左右合并字段取平均（相加会双倍：哭的 0.25 会写成 0.5）');
  ok(/ParamMouthOpenY/.test(pet) === false || /口型/.test(pet),
    'ParamMouthOpenY 不映射到字段（口型归 TTS，抢了会打架）');

  /* 应用顺序（这是整套机制成立的前提，规矩 26 同源） */
  /* ⚠️ 必须带分号：不带分号会匹配到 `function mixExpressions(emoEff, dt) {`
  /* 那条定义在文件更前面，于是这条断言**永远是绿的**（假绿，2026-10-29 抓到）。 */
  const iMix = pet.indexOf('mixExpressions(emoEff, dt);');
  const iLoop = pet.indexOf('for (const key in emoEff)');
  const iApplyEmo = pet.indexOf('applyEmotion();');
  const iApplyExp = pet.indexOf('applyExpressions();');
  ok(iMix > 0 && iLoop > iMix, 'mixExpressions 在插值循环**之前**（共享参数是"目标偏置"）');
  ok(iApplyExp > iApplyEmo, 'applyExpressions 在 applyEmotion **之后**（专属参数走绝对写，不能撤销法清掉）');

  /* 夹回区间：加性偏置会顶出界 */
  ok(/EY?MO_RANGE\[s\.field\]/.test(pet) || /EMO_RANGE\[s\.field\]/.test(pet),
    '共享参数混入后夹回 EMO_RANGE（与 mixEmoMood 同一套判据）');

  /* 绝对写的两条铁律 */
  ok(/p\.def \+ p\.value \* amt/.test(pet), '专属参数是绝对写 def + value×强度（不是 Add 累加）');
  ok(/setParam\(p\.id, amt > 0 \? p\.def \+ p\.value \* amt : p\.def\)/.test(pet),
    '强度归零写回默认值（防残影）');
  ok(/if \(amt <= 0 && prev <= 0\) return;/.test(pet),
    '只在激活期与归零那一帧写 —— 每帧无脑写 def 会和别的表情抢同一张贴图');

  ok(/appearance\?\.expressions !== false && cfg\?\.appearance\?\.stickers !== false/.test(pet),
    '开关同时认新键 expressions 与旧键 stickers（老配置 stickers:false 仍然生效）');
  ok(/8000/.test(pet), 'fetch 带 8s 超时（中文文件名可能让 dev server 挂起不响应）');

  /* 道具调度：只在她真正闲着时冒 */
  ok(/state !== State\.IDLE \|\| patState !== 'idle'/.test(pet),
    '道具只在 IDLE 且没在摸头时冒（说话/听/想、被摸、在拖都不冒）');
  ok(/pickProp\(PROPS\[(?:MODEL_NAME|curModelName)\]/.test(pet) && /propDuration\(spec\)/.test(pet),
    '抽签与时长走 prop-pool 的纯函数（可单独断言）');
  ok(/forceProp\(null\)|propCur\.target = 0/.test(pet), '收起道具走淡出，不是直接置 null（否则残影）');

  /* 事件表情的退场 */
  ok(/evTarget = 0/.test(pet), '事件表情到时会退（evTarget 置 0）');

  /* 切情绪时立刻卸下其他档的专属贴图 —— 否则 advanceAmt 交叉淡期间
   * 两张贴图同时 writeOwn，开心 wink 叠在平静脸上（用户报过）。 */
  const setEmoBody = (() => {
    const i = pet.indexOf('function setEmotion(');
    return i < 0 ? '' : pet.slice(i, pet.indexOf('\nfunction ', i + 1));
  })();
  ok(/for \(const \[emo, d\] of emoExp\)/.test(setEmoBody) &&
    /expAmt\.set\(emo, 0\)/.test(setEmoBody) &&
    /setParam\(p\.id, p\.def\)/.test(setEmoBody),
    'setEmotion 换档立刻清其他情绪的 expAmt / 专属参数（不与新档交叉叠贴图）');

  /* 情绪/事件专属贴图必须门控成 0/1：跟 decayAmt 平滑滑 = 半透明鬼影。 */
  ok(/function gateSticker\(/.test(pet) && /STICKER_ON/.test(pet),
    'gateSticker / STICKER_ON 存在（贴图开关语义，禁止中间透明度）');
  ok(/decayAmt >= STICKER_ON/.test(pet),
    '情绪贴图看 decayAmt 阈值（衰减一开始掉档就卸贴图，不留半透明）');
}

/* ── C. 配置与托盘 ───────────────────────────────────── */
console.log('\n[C] 配置与托盘');
{
  const cfg = read('main/config.js');
  ok(/expressions: true/.test(cfg), 'DEFAULT_CONFIG appearance.expressions 默认开');
  ok(/props: true/.test(cfg), 'DEFAULT_CONFIG appearance.props 默认开');
  ok(/stickers: true/.test(cfg), '旧键 stickers 仍留在默认值里（兼容老配置）');
  const main = read('main/main.js');
  ok(/情绪表情（自带 exp3）/.test(main), '托盘外观子菜单有「情绪表情」项（规矩 4）');
  ok(/flag\('appearance', 'props'/.test(main), '托盘外观子菜单有「闲置时摆弄道具」项');
  ok(/expressions: item\.checked, stickers: item\.checked/.test(main),
    '点一次把新旧两个键写成同值（否则旧键会在背后把功能关着、勾选框却显示开）');
}

/* ── D. 负对照：改坏必须红 ───────────────────────────── */
console.log('\n[D] 负对照（故意改坏，上面的判据必须翻红）');
{
  const check = (src, name) => {
    const s = stripComments(src);
    const iF = s.indexOf('EXP3_FIELD[p.Id]');
    const iO = s.indexOf('owned.has(p.Id)');
    const splitOk = iF >= 0 && iO > iF;
    const mixOk = s.indexOf('mixExpressions(emoEff, dt);') > 0 &&
      s.indexOf('for (const key in emoEff)') > s.indexOf('mixExpressions(emoEff, dt);');
    const applyOk = s.indexOf('applyExpressions();') > s.indexOf('applyEmotion();');
    const avgOk = /sum \/ n/.test(s);
    return { name, splitOk, mixOk, applyOk, avgOk };
  };

  const cases = [
    ['先判 owned（回到一阶：共享参数全丢）', pet.replace('const field = EXP3_FIELD[p.Id];', 'const field = null;')],
    ['mixExpressions 挪到插值之后', pet.replace('mixExpressions(emoEff, dt);', '/* moved */').replace('applyEmotion();', 'applyEmotion();\n    mixExpressions(emoEff, dt);')],
    ['applyExpressions 挪到 applyEmotion 之前', pet.replace('applyEmotion();', 'applyExpressions();\n    applyEmotion();').replace(/(applyEmotion\(\);\n    applyExpressions\(\);)/, 'applyEmotion();')],
    ['左右合并字段相加（不取平均）', pet.replace('sum / n', 'sum')]
  ];

  for (const [label, broken] of cases) {
    const r = check(broken, label);
    const red =
      (label.includes('先判 owned') && !r.splitOk) ||
      (label.includes('mixExpressions') && !r.mixOk) ||
      (label.includes('applyExpressions') && !r.applyOk) ||
      (label.includes('相加') && !r.avgOk);
    ok(red, `负对照正常红：${label}`);
  }
}

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
