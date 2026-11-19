'use strict';

/* whalegirl（自研鲸鱼娘）模型档案的回归。
 *
 * 这个模型是 **psd2live 全流程自制**的（ImageGen 源图 → 程序拆层 →
 * MCP 导入 manifest → rig 生成 → 导出），设计前提和 hiyori/whale 都不同。
 * 这份 verify 守的是「把它的资源接进本项目」时最容易**静默失效**的几条：
 *
 *   [A] 物理链：physics3 的输入是 ParamEyeL/ROpen（眨眼），输出是
 *       ParamEyeBallForm —— 档案 param 表**不能**写 ParamEyeBallForm
 *       （每帧被物理覆盖，写了等于没写）。**含负对照**。
 *   [B] 档案里每个参数 ID 必须真存在于 cdi3.json（拼错 = 静默不动）。
 *   [C] 契约：emoRange / emoSpeed 的键集 == EMOTION 字段集（规矩 28）。
 *   [D] expressions 表引用的 exp3 文件必须存在（fetchExp3 拼的是
 *       裸文件名，目录里是 smile.exp3.json 而不是 whale-girl.smile.exp3.json
 *       —— model3.json 的 File 字段是给 SDK 的，pet.js 不走那条路）。
 *   [E] model3.json：HitAreas 数组（缺失 → boot failed）、Groups 有
 *       EyeBlink/LipSync（SDK 自动眨眼/口型的依据）、Motions 四组齐全。
 *   [F] 接线层：params.js 四个注册表**仍保留** whalegirl（代码归档不删）；
 *       main.js 的 APPEARANCE_MODELS **没有它**（2026-11-19 退役，菜单无入口）。
 *   [I] 退役守卫：档案有 retired: true、挂载口真跑拦截、负对照摘标志即放行、
 *       存量配置由 normalizeAppearanceModel() 回落默认（两处必须一致）。
 *   [G] 实测取景：档案声明 alignByMeasure: true（新画布尺寸，线性假设
 *       大概率不成立 —— 规矩 2）。
 *   [H] motionSlots 契约：psd2live 只生成 idle，六个槽全是空字符串；
 *       pet.js 必须对空槽跳过而不是崩（空动作槽的调用点）。
 *
 * ⚠️ 素材（src/assets/models/selfmade/）**不进仓库**（gitignore），
 *    所以依赖素材的节在缺素材时 SKIP 而不是 FAIL。
 *
 * 跑法：node debug/verify-whalegirl.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const EXPORT_DIR = path.join(SRC, 'assets', 'models', 'selfmade', 'export');

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const skip = (msg) => console.log('  SKIP', msg);

const readSrc = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

/* ---- 加载档案（ESM → 临时 .mjs） ---- */
(async () => {
  const tmp = path.join(os.tmpdir(), `wb-whalegirl-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'renderer', 'profiles', 'whalegirl.js'),
    path.join(tmp, 'whalegirl.mjs'));
  let D;
  try {
    D = (await import(pathToFileURL(path.join(tmp, 'whalegirl.mjs')).href)).WHALEGIRL;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const hasAssets = fs.existsSync(path.join(EXPORT_DIR, 'whale-girl.cdi3.json'));

  /* ================= [A] 物理冲突 ================= */
  console.log('\n[A] 物理链：档案 param 不能写物理输出参数');

  const physPath = path.join(EXPORT_DIR, 'whale-girl.physics3.json');
  if (!fs.existsSync(physPath)) {
    skip('缺 whale-girl.physics3.json（素材不进仓库）');
  } else {
    /* Cubism 5 格式：PhysicsSettings 是链条数组，
     * 每条链 Input[].Source.Id → Output[].Destination.Id。 */
    const phys = JSON.parse(fs.readFileSync(physPath, 'utf8'));
    const ins = new Set();
    const outs = new Set();
    for (const ch of phys.PhysicsSettings || []) {
      for (const i of ch.Input || []) ins.add(i.Source?.Id);
      for (const o of ch.Output || []) outs.add(o.Destination?.Id);
    }
    ok(outs.size > 0, `physics3 输出表非空（${outs.size} 个参数被物理每帧覆盖）`);

    /* 关键断言：ParamEyeBallForm 是物理输出（果冻眼形变，眨眼驱动）。 */
    ok(outs.has('ParamEyeBallForm'),
      'ParamEyeBallForm 是物理输出（果冻眼，眨眼驱动）');
    ok(ins.has('ParamEyeLOpen') && ins.has('ParamEyeROpen'),
      'ParamEyeL/ROpen 是物理输入（眨眼链的源）');

    /* 档案 param 与物理输出无交集（空值不算）。 */
    const conflicts = (param) => Object.entries(param)
      .filter(([, id]) => id && outs.has(id))
      .map(([k, id]) => `${k}=${id}`);
    const real = conflicts(D.param);
    ok(real.length === 0,
      `档案 param 与物理输出无交集${real.length ? ' —— 冲突：' + real.join(', ') : ''}`);

    /* ---- 负对照：注入 ParamEyeBallForm，断言必须变红 ---- */
    const bad = conflicts({ ...D.param, EYE_BALL_FORM: 'ParamEyeBallForm' });
    ok(bad.length === 1 && bad[0] === 'EYE_BALL_FORM=ParamEyeBallForm',
      '负对照：注入 EYE_BALL_FORM=ParamEyeBallForm 后断言变红（说明 [A] 不是恒真）');
  }

  /* ================= [B] 参数 ID 真实存在 ================= */
  console.log('\n[B] 档案里每个参数 ID 都存在于 cdi3.json');

  if (!hasAssets) {
    skip('缺 whale-girl.cdi3.json（素材不进仓库）');
  } else {
    const cdi = JSON.parse(fs.readFileSync(path.join(EXPORT_DIR, 'whale-girl.cdi3.json'), 'utf8'));
    const ids = new Set(cdi.Parameters.map((p) => p.Id));
    ok(ids.size === 20, `cdi3 参数总数 20（psd2live 标准绑骨；实测 ${ids.size}）`);

    const missing = Object.entries(D.param)
      .filter(([, id]) => id && !ids.has(id))
      .map(([k, id]) => `${k}=${id}`);
    ok(missing.length === 0,
      `param 全部 ID 命中 cdi3${missing.length ? ' —— 不存在：' + missing.join(', ') : ''}`);

    /* 显式确认缺失的器官参数没有硬编进 param 表（写空而非删键）。 */
    ok(!D.param.EYE_SMILE, 'EYE_SMILE 缺失（无微笑眼参数，param 表不映射）');
    ok(!D.param.CHEEK, 'CHEEK 缺失（无脸红参数）');
    ok(!D.param.AHOGE, 'AHOGE 缺失（无呆毛独立参数，前发整体摆动）');
    ok(!D.param.BODY_Z, 'BODY_Z 缺失（无身体 Z 平移参数）');

    /* 顺带把「接上了什么」打出来。 */
    const wired = Object.entries(D.param).filter(([, id]) => id);
    console.log(`       已接 ${wired.length} 个：${wired.map(([k, id]) => `${k}→${id}`).join(' · ')}`);
  }

  /* ================= [C] 契约：键集一致 ================= */
  console.log('\n[C] emoRange / emoSpeed 的键集 == EMOTION 字段集（规矩 28）');

  const EMOTION_KEYS = Object.keys(D.emotion.calm).sort();
  ok(EMOTION_KEYS.length === 16, `每个情绪 16 个字段（实测 ${EMOTION_KEYS.length}）`);

  const keyset = (o) => Object.keys(o).sort().join(',');
  const base = keyset(D.emotion.calm);
  const emoNames = Object.keys(D.emotion);
  ok(emoNames.length === 9, `情绪数 9（8 协议 + sad 自研扩展；实测 ${emoNames.length}：${emoNames.join(',')}）`);
  for (const name of emoNames) {
    ok(keyset(D.emotion[name]) === base, `情绪 ${name} 的字段集与 calm 一致`);
  }
  ok(keyset(D.emoRange) === base, 'emoRange 键集 == EMOTION 字段集');
  ok(keyset(D.emoSpeed) === base, 'emoSpeed 键集 == EMOTION 字段集');
  ok(Object.keys(D.patDelta).every((k) => EMOTION_KEYS.includes(k)),
    'patDelta 的键都在 EMOTION 字段集内');

  /* 8 个协议标签必须能解析（params.js 的 EMOTION_ALIAS 协议，W33）。 */
  const PROTO_TAGS = ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'];
  for (const tag of PROTO_TAGS) {
    ok(emoNames.includes(tag), `协议标签 ${tag} 有实档`);
  }

  /* ================= [D] expressions 表引用的 exp3 存在 ================= */
  console.log('\n[D] expressions 表引用的 exp3 文件存在（fetchExp3 拼裸文件名）');

  const expDir = path.join(EXPORT_DIR, 'expressions');
  if (!fs.existsSync(expDir)) {
    skip('缺 expressions/ 目录（素材不进仓库）');
  } else {
    const dirFiles = fs.readdirSync(expDir).map((f) => f.replace(/\.exp3\.json$/, ''));
    const used = Object.values(D.expressions || {});
    const missing = used.filter((f) => !dirFiles.includes(f));
    ok(missing.length === 0,
      `expressions 表引用的 ${used.length} 个 exp3 文件在 expressions/ 目录全部存在${missing.length ? ' —— 缺失：' + missing.join(', ') : ''}`);
    ok(used.length === 4, `expressions 表 4 个条目（psd2live 自动生成的微笑/悲伤/生气/惊讶；实测 ${used.length}）`);

    /* 一个情绪只挂一个 exp3（规矩 32）——表达式表的值不能重复。 */
    const vals = Object.values(D.expressions || {});
    ok(new Set(vals).size === vals.length,
      '一个情绪只挂一个 exp3（无重复条目）');
  }

  /* ================= [E] model3.json 注册 ================= */
  console.log('\n[E] model3.json：HitAreas / Groups / Motions / Expressions');

  const m3Path = path.join(EXPORT_DIR, 'whale-girl.model3.json');
  if (!fs.existsSync(m3Path)) {
    skip('缺 whale-girl.model3.json（素材不进仓库）');
  } else {
    const m3 = JSON.parse(fs.readFileSync(m3Path, 'utf8'));

    /* 🔴 HitAreas 缺失 → 插件 getHitAreaDefs() 里 this.settings.hitAreas.map() 炸。 */
    ok(Array.isArray(m3.HitAreas),
      `model3.json 顶层有 HitAreas 数组${Array.isArray(m3.HitAreas) ? '' : '（🔴 缺失 → boot failed）'}`);

    /* Groups：SDK 自动眨眼/口型的依据（EyeBlink / LipSync）。 */
    const groups = (m3.Groups || []).map((g) => g.Name);
    ok(groups.includes('EyeBlink'),
      `Groups 有 EyeBlink（SDK 自动眨眼；实测组：${groups.join(',')}）`);
    ok(groups.includes('LipSync'), 'Groups 有 LipSync（SDK 自动口型）');

    /* Motions：pet.js 调用的组名（Idle 必填，Blink/Nod/Shake 是 psd2live 标准件）。 */
    const motionGroups = Object.keys(m3.FileReferences?.Motions || {});
    ok(motionGroups.includes('Idle'), `动作组有 Idle（pet.js 默认动作；实测组：${motionGroups.join(',')}）`);
    ok(motionGroups.includes('Blink'), '动作组有 Blink');
    ok(motionGroups.includes('Nod'), '动作组有 Nod');
    ok(motionGroups.includes('Shake'), '动作组有 Shake');

    ok(!!(m3.FileReferences?.Expressions || []).length,
      `Expressions 段已注册（${m3.FileReferences.Expressions.length} 个表情）`);

    /* 🔴 一个情绪只挂一个 exp3：expressions 表的键（情绪名）不能重复。
     *   值重复已经在 [D] 守过；这里守的是键侧（两个情绪挂同一个 exp3 文件
     *   时 pet.js 的淡出会把另一通道盖掉 —— 与 verify-deepfish [D] 同源）。 */
    ok(Object.keys(D.expressions || {}).length === new Set(Object.keys(D.expressions || {})).size,
      'expressions 表的键（情绪名）不重复');
  }

  /* ================= [F] 接线层（源码断言） ================= */
  console.log('\n[F] 接线层');

  const PARAMS = readSrc('renderer/params.js');
  ok(/import\s*\{[^}]*WHALEGIRL[^}]*\}\s*from\s*['"][^'"]*profiles\/whalegirl\.js['"]/.test(PARAMS),
    'params.js 已 import WHALEGIRL 档案');
  ok(/\[WHALEGIRL\.name\]\s*:\s*WHALEGIRL\.model/.test(PARAMS),
    'params.js 的 MODELS 注册表里有 whalegirl');
  ok(/\[WHALEGIRL\.name\]\s*:\s*WHALEGIRL\.expressions/.test(PARAMS),
    'params.js 的 EXPRESSIONS 注册表里有 whalegirl');
  ok(/\[WHALEGIRL\.name\]\s*:\s*WHALEGIRL\.emotes/.test(PARAMS),
    'params.js 的 EMOTES 注册表里有 whalegirl');
  ok(/\[WHALEGIRL\.name\]\s*:\s*WHALEGIRL\.props/.test(PARAMS),
    'params.js 的 PROPS 注册表里有 whalegirl');

  const MAIN = readSrc('main/main.js');
  /* 2026-11-19 退役：APPEARANCE_MODELS 里**不能**有 whalegirl。
   * 排除注释文本后匹配（退役说明注释里提到它，不能误判）。 */
  const appearanceBlock = (MAIN.match(/const APPEARANCE_MODELS = \[[\s\S]*?\];/) || [''])[0];
  ok(appearanceBlock.length > 0, 'main.js 里能找到 APPEARANCE_MODELS 表');
  const appearanceNoComments = appearanceBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\{\s*id:\s*'whalegirl'/.test(appearanceNoComments),
    'APPEARANCE_MODELS 里没有 whalegirl（退役，菜单无入口）');

  /* pet.js 不调 model.expression() —— 表情由 pet.js 自己的 fetch + setParam 通道管理。 */
  const PET = readSrc('renderer/pet.js');
  const petNoComments = PET.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\.expression\s*\(/.test(petNoComments),
    'pet.js 不调 model.expression()（表情走自己的 fetchExp3 + setParam 通道）');

  /* 素材合规：selfmade 目录在 gitignore 内（模型素材不进仓库）。 */
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ok(/src\/assets\/models\//.test(gi), '.gitignore 排除 src/assets/models/（selfmade 素材不进仓库）');

  /* ================= [G] 实测取景（alignByMeasure） ================= */
  console.log('\n[G] 实测取景：新画布尺寸走实测对齐（规矩 2）');

  ok(D.model?.alignByMeasure === true,
    '档案声明 alignByMeasure: true（走实测对齐）');
  ok(D.model?.anchorY !== 'bottom',
    '实测对齐只支持顶部锚定');

  ok(/function\s+measureCanvasInk\s*\(/.test(PET),
    'pet.js 有 measureCanvasInk()');
  ok(/function\s+scheduleInkMeasure\s*\(/.test(PET),
    'pet.js 有 scheduleInkMeasure()（layout 后异步量、量不到重试）');
  ok(/gl\.drawingBufferWidth/.test(PET),
    'measureCanvasInk 用 gl.drawingBufferWidth（设备像素网格）');

  /* ================= [H] motionSlots 契约 ================= */
  console.log('\n[H] motionSlots 契约：psd2live 只生成 idle，空槽必须跳过');

  const slots = D.model?.motionSlots || {};
  const slotKeys = ['thinking', 'working', 'success', 'error', 'drag', 'walk'];
  ok(slotKeys.every((k) => slots[k] === ''),
    `六个动作槽全空（psd2live 只生成 idle；实测：${slotKeys.map((k) => `${k}='${slots[k]}'`).join(' ')}）`);

  /* pet.js 必须对空槽跳过而不是播空动作名：resolveMotionSlot 把空串归一成
   * ''，playEventMotion 里 `if (!g) return;` 提前返回。 */
  ok(/function\s+resolveMotionSlot\s*\(/.test(petNoComments)
    && /if\s*\(\s*!g\s*\)\s*return/.test(petNoComments),
    'pet.js 对空动作槽有跳过逻辑（resolveMotionSlot 归一 + playEventMotion 早退）');

  /* 渲染层 profile 导出契约：name / credit / emotion 齐全。 */
  ok(D.name === 'whalegirl', '档案 name = whalegirl');
  ok(typeof D.credit === 'string' && D.credit.length > 0, '档案有署名文案');
  ok(D.emotionAlias && typeof D.emotionAlias === 'object', '档案有 emotionAlias（W33 协议回退）');
  ok(typeof D.mouthOpenMax === 'number', '档案有 mouthOpenMax（§11.6 第 3 条）');

  /* ================= [I] 退役守卫（2026-11-19） ================= */
  console.log('\n[I] 退役守卫：档案标记、挂载口真跑、存量配置回落');

  ok(D.model?.retired === true, '档案里有 retired: true（挂载口拦截）');

  const fnSrc = (PET.match(/function\s+resolveModelName\s*\(name\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  ok(fnSrc.length > 0, 'pet.js 里能抠出 resolveModelName 函数体');
  let resolveModel = null;
  try {
    /* eslint-disable-next-line no-new-func */
    resolveModel = new Function('MODELS', 'MODEL_NAME', `${fnSrc}\nreturn resolveModelName;`)(
      { hiyori: {}, whale: {}, whalegirl: D.model }, 'hiyori');
  } catch { /* 下面那条断言会红 */ }
  ok(typeof resolveModel === 'function', 'resolveModelName 可执行（源码级真跑）');
  ok(resolveModel?.('hiyori') === 'hiyori', '已知模型原样返回');
  ok(resolveModel?.('whalegirl') === 'hiyori',
    'whalegirl 被拦截回落默认（退役中，挂不上）');
  ok(resolveModel?.('nope') === 'hiyori', '不存在的键 → 回落默认模型');

  /* 负对照：给档案**摘掉** retired，同一个函数必须立刻放行 whalegirl。
   * 证明拦住它的是这个字段，而不是"注册表里恰好没有"之类的别的原因。 */
  let negResolve = null;
  try {
    negResolve = new Function('MODELS', 'MODEL_NAME', `${fnSrc}\nreturn resolveModelName;`)(
      { hiyori: {}, whale: {}, whalegirl: { retired: false } }, 'hiyori');
  } catch { /* 上面已红 */ }
  ok(negResolve?.('whalegirl') === 'whalegirl',
    '负对照：档案摘掉 retired 后 whalegirl 立刻放行（证明拦住它的是这个字段）');

  /* 存量配置：老机器 config.json 里还写着 whalegirl，启动时必须能回落 hiyori。
   * main.js 的 normalizeAppearanceModel() 按 APPEARANCE_MODELS 过滤并 patchConfig。 */
  const mainNoComments = MAIN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(/function\s+normalizeAppearanceModel\s*\(/.test(mainNoComments),
    'main.js 有 normalizeAppearanceModel()（存量配置回落）');
  ok(/normalizeAppearanceModel\s*\(\s*\)\s*;/.test(mainNoComments),
    'normalizeAppearanceModel() 在启动时被调用（createWindow 前）');

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
