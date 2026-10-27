'use strict';

/* 鲸鱼娘（whale / c_0120）模型档案的回归。
 *
 * 这个模型是 **VTube Studio 模型包**改来的（247 参数 / 8 动作组 / 43 表情
 * 文件），设计前提和 hiyori 完全不同。这份 verify 守的是「把它的资源接进
 * 本项目」时最容易**静默失效**的几条：
 *
 *   [A] 情绪引擎写的参数 **不能是 physics3.json 的输出**。
 *       这是本次最大的坑：hiyori 那边 ParamBodyAngle* 是物理输入（规矩 28
 *       那句「BODY_Y/Z 是物理输入」只对 hiyori 成立），换到鲸鱼娘就反了 ——
 *       它是物理**输出**，而且物理还拿它当自反馈输入，我们叠加的情绪 delta
 *       会被物理吃进去、带积分的摆会一轮轮放大。呆毛同理（11/13/24 全是
 *       物理输出，只有 12 不是 —— 只写 12 会让四根呆毛不同步）。
 *       **含负对照**：故意把 AHOGE 填回 ParamHairFront11，断言必须变红。
 *   [B] 档案里每个参数 ID 必须真存在于 cdi3.json（拼错 = 静默不动）。
 *   [C] 眼珠 ID 必须与插件 focus() 用的标准 ID 完全一致（大小写敏感），
 *       否则视线跟随整条链路静默失效。
 *   [D] 契约：emoRange / emoSpeed 的键集 == EMOTION 的字段集（规矩 28）。
 *   [E] 官方 idle 动作**不许进** keepLoopGroups —— 它 89 条曲线会把爱心
 *       (j1~j57) / 猫爪 / 兔耳 / 泡泡 / 锤子全翻出来。
 *
 * ⚠️ 素材（src/assets/models/whale/）**不进仓库**（规矩 13），所以依赖素材
 *    的节在缺素材时 SKIP 而不是 FAIL —— 别让没素材的人看到红色。
 *
 * 跑法：node debug/verify-whale.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const MODEL_DIR = path.join(SRC, 'assets', 'models', 'whale');

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
  const tmp = path.join(os.tmpdir(), `wb-whale-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'renderer', 'profiles', 'whale.js'),
    path.join(tmp, 'whale.mjs'));
  let W;
  try {
    W = (await import(pathToFileURL(path.join(tmp, 'whale.mjs')).href)).WHALE;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const hasAssets = fs.existsSync(path.join(MODEL_DIR, 'c_0120.cdi3.json'));

  /* ================= [A] 物理冲突 ================= */
  console.log('\n[A] 情绪引擎写的参数不能是 physics3.json 的输出');

  const physPath = path.join(MODEL_DIR, 'c_0120.physics3.json');
  if (!fs.existsSync(physPath)) {
    skip('缺 c_0120.physics3.json（素材不进仓库，规矩 13）');
  } else {
    const phys = JSON.parse(fs.readFileSync(physPath, 'utf8'));
    const outs = new Set();
    for (const g of phys.PhysicsSettings || []) {
      for (const o of g.Output || []) outs.add(o.Destination.Id);
    }
    ok(outs.size > 0, `physics3 输出表非空（${outs.size} 个参数被物理每帧覆盖）`);

    /* 冲突检测抽成函数 —— 负对照要用同一段逻辑（见 [A3]）。 */
    const conflicts = (param) => Object.entries(param)
      .filter(([, id]) => id && outs.has(id))
      .map(([k, id]) => `${k}=${id}`);

    const real = conflicts(W.param);
    ok(real.length === 0,
      `档案 param 与物理输出无交集${real.length ? ' —— 冲突：' + real.join(', ') : ''}`);

    /* 三个被清空的参数要真的是「清空」而不是删行 —— 删行会让契约字段集
     * 少一个键（规矩 28 的 verify 会红），这里再确认一次它们是显式留空的。 */
    ok(!W.param.BODY_Y && !W.param.BODY_Z,
      'BODY_Y / BODY_Z 已置空（它们是物理输出 + 自反馈输入）');
    ok(!W.param.AHOGE, 'AHOGE 已置空（呆毛 11/13/24 全是物理输出）');

    /* ---- [A3] 负对照：故意把呆毛填回物理输出，断言必须变红 ---- */
    const bad = conflicts({ ...W.param, AHOGE: 'ParamHairFront11' });
    ok(bad.length === 1 && bad[0] === 'AHOGE=ParamHairFront11',
      '负对照：注入 AHOGE=ParamHairFront11 后断言变红（说明 [A] 不是恒真）');
    const bad2 = conflicts({ ...W.param, BODY_Y: 'ParamBodyAngleY' });
    ok(bad2.includes('BODY_Y=ParamBodyAngleY'),
      '负对照：注入 BODY_Y=ParamBodyAngleY 后断言变红');
  }

  /* ================= [B] 参数 ID 真实存在 ================= */
  console.log('\n[B] 档案里每个参数 ID 都存在于 cdi3.json');

  if (!hasAssets) {
    skip('缺 c_0120.cdi3.json（素材不进仓库）');
  } else {
    const cdi = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'c_0120.cdi3.json'), 'utf8'));
    const ids = new Set(cdi.Parameters.map((p) => p.Id));
    const nameOf = Object.fromEntries(cdi.Parameters.map((p) => [p.Id, p.Name]));
    ok(ids.size === 247, `cdi3 参数总数 247（实测 ${ids.size}）`);

    const missing = Object.entries(W.param)
      .filter(([, id]) => id && !ids.has(id))
      .map(([k, id]) => `${k}=${id}`);
    ok(missing.length === 0,
      `param 全部 ID 命中 cdi3${missing.length ? ' —— 不存在：' + missing.join(', ') : ''}`);

    /* 顺带把「接上了什么」打出来 —— 换模型时这张表是调试第一手资料。 */
    const wired = Object.entries(W.param).filter(([, id]) => id);
    console.log(`       已接 ${wired.length} 个：${
      wired.map(([k, id]) => `${k}→${id}(${nameOf[id] || '?'})`).join(' · ')}`);

    /* 眼珠：插件 focus() 按标准 ID 找，大小写敏感（hiyori 是 ParamEyeballX
     * 小写 b → focus 其实找不到；鲸鱼娘大写 B → 命中）。 */
    ok(W.param.EYE_L === 'ParamEyeLOpen' && W.param.EYE_R === 'ParamEyeROpen',
      '眼开闭 ID 与 model3.json 的 EyeBlink 组一致（自动眨眼能生效）');
  }

  /* ================= [C] 眼珠 ID 与插件标准 ID 匹配 ================= */
  console.log('\n[C] 视线跟随（focus）依赖的眼珠 ID 与插件标准 ID 一致');

  const plug = path.join(ROOT, 'node_modules', '@naari3', 'pixi-live2d-display',
    'dist', 'cubism5.es.js');
  if (!hasAssets || !fs.existsSync(plug)) {
    skip('缺素材或插件 dist');
  } else {
    const plugSrc = fs.readFileSync(plug, 'utf8');
    const stdId = /ParamEyeBallX:\s*"([^"]+)"/.exec(plugSrc);
    ok(!!stdId && stdId[1] === 'ParamEyeBallX',
      `插件标准眼珠 ID = ${stdId ? stdId[1] : '?'}（硬编码在 dist/cubism5.es.js）`);

    const cdi = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'c_0120.cdi3.json'), 'utf8'));
    const ids = new Set(cdi.Parameters.map((p) => p.Id));
    ok(ids.has('ParamEyeBallX') && ids.has('ParamEyeBallY'),
      '鲸鱼娘有 ParamEyeBallX/Y（大写 B）→ focus() 能找到，视线跟随生效');
  }

  /* ================= [D] 契约：键集一致 ================= */
  console.log('\n[D] emoRange / emoSpeed 的键集 == EMOTION 字段集（规矩 28）');

  const EMOTION_KEYS = Object.keys(W.emotion.calm).sort();
  ok(EMOTION_KEYS.length === 16, `每个情绪 16 个字段（实测 ${EMOTION_KEYS.length}）`);

  const keyset = (o) => Object.keys(o).sort().join(',');
  const base = keyset(W.emotion.calm);
  for (const name of Object.keys(W.emotion)) {
    ok(keyset(W.emotion[name]) === base, `情绪 ${name} 的字段集与 calm 一致`);
  }
  ok(keyset(W.emoRange) === base, 'emoRange 键集 == EMOTION 字段集');
  ok(keyset(W.emoSpeed) === base, 'emoSpeed 键集 == EMOTION 字段集');
  ok(Object.keys(W.patDelta).every((k) => EMOTION_KEYS.includes(k)),
    'patDelta 的键都在 EMOTION 字段集内');

  /* ================= [E] 官方 idle 不许进 keepLoopGroups ================= */
  console.log('\n[E] 官方动作组的取舍');

  const keep = W.model.keepLoopGroups || [];
  ok(!keep.includes('idle'), '官方 idle 不在 keepLoopGroups（89 条曲线会翻出道具）');

  const idlePath = path.join(MODEL_DIR, 'motions', 'idle.motion3.json');
  if (!fs.existsSync(idlePath)) {
    skip('缺 motions/idle.motion3.json（素材不进仓库）');
  } else {
    const idle = JSON.parse(fs.readFileSync(idlePath, 'utf8'));
    const driven = new Set((idle.Curves || []).map((c) => c.Id));
    /* 道具参数 = 爱心 j*、猫手 maoshou*、泡泡 paopao*、锤子 Param7* 等。 */
    const props = [...driven].filter((id) =>
      /^j\d+/.test(id) || /^maoshou/.test(id) || /^paopao/.test(id) || /^Param7\d$/.test(id));
    ok(props.length >= 20,
      `idle 会驱动 ${props.length} 个道具参数（j*/maoshou*/paopao*/Param7*）→ 播了就乱入`);

    /* 反过来确认：官方 idle 驱动的确实**不是**我们情绪引擎在写的那些。 */
    const emotionIds = new Set(Object.values(W.param).filter(Boolean));
    const clash = [...driven].filter((id) => emotionIds.has(id));
    ok(clash.length === 0,
      `idle 不碰情绪引擎的参数${clash.length ? ' —— 冲突：' + clash.join(', ') : ''}`);
  }

  /* ---- 接线层（源码断言）---- */
  console.log('\n[F] 接线层');
  const PET = readSrc('renderer/pet.js');
  const PARAMS = readSrc('renderer/params.js');

  ok(/MODELS\[curModelName\]\.inkTopCRatio\s*\?\?\s*INK_TOP_C_RATIO/.test(PET),
    '取景 C 项以**档案**为准（inkTopCRatio ?? 引擎回退）—— 否则 0.328 白标定');
  /* ⚠️ 别用 `!/与模型无关/.test(PARAMS)` 这种粗正则 —— 证伪说明里也会引用
   * 这句话，会把「已改正」误判成「没改正」。要看的是**常量上方的注释块**。 */
  const inkIdx = PARAMS.indexOf('export const INK_TOP_C_RATIO');
  const inkBlock = inkIdx < 0 ? '' : PARAMS.slice(0, inkIdx).split('\n').slice(-16).join('\n');
  ok(/证伪/.test(inkBlock) && /档案/.test(inkBlock),
    'INK_TOP_C_RATIO 上方注释已改为「档案优先 + 旧断言已证伪」');
  const HIYORI = readSrc('renderer/profiles/hiyori.js');
  ok(!/与模型无关/.test(HIYORI),
    'hiyori 档案不再声称该系数「与模型无关」（鲸鱼娘 0.328 已证伪）');
  ok(/anchorY\s*===\s*'bottom'|anchorBottom/.test(PET),
    'pet.js 有底部锚定分支（鲸鱼娘趴姿构图需要）');
  ok(/\[WHALE\.name\]\s*:\s*WHALE\.model/.test(PARAMS),
    'params.js 的 MODELS 注册表里有 whale');

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
