/* 验证「自定义名称」+「角色设定（人设分项）」的核心逻辑，不起 Electron。
 *
 * 为什么单独测而不是靠起应用目测：
 *   这些都是纯函数，边界（空串 / 空格 / undefined / 槽位留空 / 整段覆盖优先）
 *   在界面上很难手工试全 —— 而它们恰好是最容易出错的地方
 *   （空名字会让托盘标题变空白；空槽位会在 system prompt 里插空行；
 *    整段 persona 的优先级搞反会让用户手写的人设被悄悄顶掉）。
 *
 *   node debug/verify-rename.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* 剖源码前必须把行尾统一成 \n。
 *
 * ⚠️ 本仓库 .gitattributes 是 `* text=auto` 且 core.autocrlf=true：任何一次
 *    git checkout / 全新 clone 都会把工作区写成 **CRLF**，而下面的
 *    `indexOf('\n}\n')` 是按 LF 写的 —— CRLF 下一条都切不到，报的却是
 *    "找不到 XXX 的结尾"，看着像被剖的代码写错了（2026-10-13 实际踩过）。 */
const cfgSrc = fs
  .readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/* 从源码切出要测的部分 —— 不手抄（手抄副本一脱节，测的就是假代码）。
 * config.js 顶部 require('electron')，这里不能真 load，只能剖源码。 */
const sliceFn = (name) => {
  const head = cfgSrc.indexOf(`function ${name}(`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = cfgSrc.indexOf('\n}\n', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return cfgSrc.slice(head, tail + 3);
};
const sliceLine = (name) => {
  const m = cfgSrc.match(new RegExp(`^const ${name} = .*;$`, 'm'));
  if (!m) throw new Error(`找不到 ${name}`);
  return m[0];
};
const sliceArr = (name) => {
  const head = cfgSrc.indexOf(`const ${name} = [`);
  if (head < 0) throw new Error(`找不到 ${name}`);
  const tail = cfgSrc.indexOf('\n];', head);
  if (tail < 0) throw new Error(`找不到 ${name} 的结尾`);
  return cfgSrc.slice(head, tail + 3);
};

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([
  sliceLine('DEFAULT_NAME'),
  sliceLine('NAME_LIMITS'),
  sliceLine('EMOTION_TAGS'),
  sliceArr('PERSONA_PARTS'),
  sliceFn('resolveName'),
  sliceFn('personaPartDefaults'),
  sliceFn('buildPersonaFromParts'),
  sliceFn('hasCustomParts'),
  sliceFn('resolvePersona'),
  /* ⚠️ vm 里 `const` / `let` 是**词法声明**，不会挂到 sandbox 对象上
   *    （只有 `var` 和函数声明会）。所以要从外面拿这几个值，得让沙箱
   *    自己把它们挂到 globalThis 上 —— 否则 sandbox.DEFAULT_NAME 恒为
   *    undefined，断言会全部"失败"，而实际是被测代码没问题、测法错了。 */
  `globalThis.__exports = { DEFAULT_NAME, NAME_LIMITS, PERSONA_PARTS,
     resolveName, personaPartDefaults, buildPersonaFromParts, hasCustomParts, resolvePersona };`
].join('\n'), sandbox);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) console.log(`      期望: ${JSON.stringify(want)}\n      实际: ${JSON.stringify(got)}`);
  ok ? pass++ : fail++;
};
const ok = (label, cond) => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}`);
  cond ? pass++ : fail++;
};
const includes = (label, hay, needle) => ok(label, hay.includes(needle));

const {
  resolveName, resolvePersona, DEFAULT_NAME, NAME_LIMITS, PERSONA_PARTS,
  personaPartDefaults, buildPersonaFromParts, hasCustomParts
} = sandbox.__exports;

console.log('\n=== resolveName：兜底与 trim ===');
eq('空串 → 默认名', resolveName({ name: '' }), DEFAULT_NAME);
eq('undefined → 默认名', resolveName({}), DEFAULT_NAME);
eq('null → 默认名', resolveName({ name: null }), DEFAULT_NAME);
eq('cfg 整体为 undefined → 默认名', resolveName(undefined), DEFAULT_NAME);
eq('纯空格 → 默认名（trim 后为空）', resolveName({ name: '   ' }), DEFAULT_NAME);
eq('正常名字 → 原样', resolveName({ name: '小绿' }), '小绿');
eq('两侧空格 → 去掉', resolveName({ name: '  小绿  ' }), '小绿');

console.log('\n=== 人设：默认全文 ===');
const p1 = resolvePersona({ name: '', persona: '' });
includes('第一句用默认名自称', p1, `你叫${DEFAULT_NAME}，`);
includes('含身份定位', p1, '是常驻在这台电脑里的搭子');
includes('含说话风格', p1, '说话干脆、直接、有主见');
includes('含回答方式', p1, '先给结论，再给理由');
includes('含输出格式约束', p1, '不要用 markdown 列表和代码块');
includes('含表情协议', p1, '[emo:xxx]');

console.log('\n=== 人设：名字跟着走 ===');
const p2 = resolvePersona({ name: '小绿', persona: '' });
includes('自定义名进入自称', p2, '你叫小绿，');
ok('自定义名时不再出现默认名自称', !p2.includes(`你叫${DEFAULT_NAME}`));

console.log('\n=== 人设：分项覆盖（留空用默认）===');
const p3 = resolvePersona({ name: '', persona: '', personaParts: { style: '说话要温柔，多用语气词。' } });
includes('改过的项用新内容', p3, '说话要温柔，多用语气词。');
ok('改过的项不再出现旧默认', !p3.includes('说话干脆、直接、有主见'));
includes('没改的项仍用默认（身份）', p3, '是常驻在这台电脑里的搭子');
includes('没改的项仍用默认（回答方式）', p3, '先给结论，再给理由');
includes('没改的项仍用默认（表情）', p3, '[emo:xxx]');

console.log('\n=== 人设：空槽位不产生空行 ===');
const p4 = buildPersonaFromParts({ name: '', personaParts: { extra: '   ' } });
ok('尾部/中间没有连续空行', !/\n\s*\n/.test(p4));
ok('没有以空白行开头', !/^\s/.test(p4));

console.log('\n=== 人设：整段覆盖优先级最高 ===');
const custom = '你是猫。只说喵。';
const p5 = resolvePersona({ name: '小绿', persona: custom, personaParts: { style: '被忽略' } });
eq('整段 persona 原样返回', p5, custom);
ok('分项不掺进整段覆盖', !p5.includes('被忽略'));
ok('默认人设不掺进整段覆盖', !p5.includes('搭子'));

console.log('\n=== 人设：拼装顺序与 PERSONA_PARTS 一致 ===');
const p6 = buildPersonaFromParts({ name: '', personaParts: {} });
const partsOrder = PERSONA_PARTS.map((p) => p.def(resolveName({}))).filter(Boolean);
eq('全默认时等于各槽位默认按序拼接', p6, partsOrder.join('\n'));
const idxIdentity = p6.indexOf('常驻在这台电脑');
const idxEmotion = p6.indexOf('[emo:xxx]');
ok('身份段在表情段之前（顺序未被打乱）', idxIdentity >= 0 && idxIdentity < idxEmotion);

console.log('\n=== hasCustomParts：判断是否动过 ===');
eq('全空 → false', hasCustomParts({ personaParts: {} }), false);
eq('未提供 personaParts → false', hasCustomParts({}), false);
eq('有空白串 → false', hasCustomParts({ personaParts: { style: '  ' } }), false);
eq('有一项非空 → true', hasCustomParts({ personaParts: { style: 'x' } }), true);

console.log('\n=== personaPartDefaults：按名字渲染 ===');
const d1 = personaPartDefaults({ name: '小绿' });
includes('identity 默认含当前名字', d1.identity, '你叫小绿，');
const keysOk = PERSONA_PARTS.every((p) => typeof d1[p.key] === 'string');
ok('每个槽位都有默认值', keysOk);

console.log('\n=== 长度边界 ===');
eq(`NAME_LIMITS.min = ${NAME_LIMITS.min}`, NAME_LIMITS.min, 1);
eq(`NAME_LIMITS.max = ${NAME_LIMITS.max}`, NAME_LIMITS.max, 12);
ok('槽位数量 ≥ 4（够细分）', PERSONA_PARTS.length >= 4);
ok('表情槽位被标为 tech（界面会警告）', PERSONA_PARTS.some((p) => p.key === 'emotion' && p.tech));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
