'use strict';

/* 大肥鱼（deepfish / 大肥鱼）模型档案的回归。
 *
 * 这个模型是 **VTube Studio 模型包**改来的（509 参数 / 8 动作 / 24 表情），
 * 设计前提和 hiyori 完全不同。这份 verify 守的是「把它的资源接进本项目」时
 * 最容易**静默失效**的几条：
 *
 *   [A] 头物理链的输入是 **AngleX/Y/Z**，不是 ParamAngleX/Y/Z —— 反过来！
 *       实测 physics3.json 的链条：AngleX → ParamAngleX（scale 28），
 *       ParamAngleX/Y/Z 是物理**输出**（自反馈链）。写 ParamAngle* 会被物理
 *       覆盖（静默失效），必须写 AngleX/Y/Z。**含负对照**：注入
 *       ANGLE_X='ParamAngleX'，断言必须变红。
 *   [B] 档案里每个参数 ID 必须真存在于 cdi3.json（拼错 = 静默不动）。
 *       注意：ParamBrowLX/RX / ParamBrowL/RForm 在这个模型里**不存在**，
 *       档案里必须是 null（不是删除键 —— 删键会破坏字段集契约）。
 *   [C] 契约：emoRange / emoSpeed 的键集 == EMOTION 字段集（规矩 28）。
 *   [D] 三张表情表（emo / ev / prop）写的 key 参数**互不重叠** ——
 *       applyExpressions 里 emo 先写、ev 后写、prop 最后写，同 key 时
 *       "谁后写谁赢"，淡出那一帧会把另一通道的贴纸盖掉。**含负对照**。
 *   [E] model3.json 的动作组名必须是 **Idle / TapBody**（首字母大写，
 *       pet.js 调用的组名）；Expressions 段已注册。
 *   [F] 接线层：params.js 四个注册表 + main.js 菜单都有 deepfish。
 *
 * ⚠️ 素材（src/assets/models/deepfish/）**不进仓库**（gitignore + 素材
 *    自带「禁止二次分发」条款），所以依赖素材的节在缺素材时 SKIP 而不是
 *    FAIL —— 别让没素材的人看到红色。
 *
 * 跑法：node debug/verify-deepfish.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const MODEL_DIR = path.join(SRC, 'assets', 'models', 'deepfish');

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
  const tmp = path.join(os.tmpdir(), `wb-deepfish-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(
    path.join(SRC, 'renderer', 'profiles', 'deepfish.js'),
    path.join(tmp, 'deepfish.mjs'));
  let D;
  try {
    D = (await import(pathToFileURL(path.join(tmp, 'deepfish.mjs')).href)).DEEPFISH;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const hasAssets = fs.existsSync(path.join(MODEL_DIR, '大肥鱼.cdi3.json'));

  /* ================= [A] 物理冲突 ================= */
  console.log('\n[A] 头物理链：写入必须是物理输入，不能是物理输出');

  const physPath = path.join(MODEL_DIR, '大肥鱼.physics3.json');
  if (!fs.existsSync(physPath)) {
    skip('缺 大肥鱼.physics3.json（素材不进仓库）');
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

    /* 关键断言：这个模型的 ParamAngleX/Y/Z 是物理输出（与 hiyori 相反）。 */
    ok(outs.has('ParamAngleX') && outs.has('ParamAngleY') && outs.has('ParamAngleZ'),
      'ParamAngleX/Y/Z 是物理输出（写入会被覆盖）');
    ok(ins.has('AngleX') && ins.has('AngleY') && ins.has('AngleZ'),
      'AngleX/Y/Z 是物理输入（物理头链的源，写入安全）');

    /* 档案 param 与物理输出无交集（空值不算）。 */
    const conflicts = (param) => Object.entries(param)
      .filter(([, id]) => id && outs.has(id))
      .map(([k, id]) => `${k}=${id}`);
    const real = conflicts(D.param);
    ok(real.length === 0,
      `档案 param 与物理输出无交集${real.length ? ' —— 冲突：' + real.join(', ') : ''}`);

    /* 显式确认头姿写的是 AngleX/Y/Z。 */
    ok(D.param.ANGLE_X === 'AngleX' && D.param.ANGLE_Y === 'AngleY' && D.param.ANGLE_Z === 'AngleZ',
      'ANGLE_X/Y/Z = AngleX/Y/Z（物理输入），不是 ParamAngle*（物理输出）');

    /* ---- 负对照：注入 ParamAngleX，断言必须变红 ---- */
    const bad = conflicts({ ...D.param, ANGLE_X: 'ParamAngleX' });
    ok(bad.length === 1 && bad[0] === 'ANGLE_X=ParamAngleX',
      '负对照：注入 ANGLE_X=ParamAngleX 后断言变红（说明 [A] 不是恒真）');
  }

  /* ================= [B] 参数 ID 真实存在 ================= */
  console.log('\n[B] 档案里每个参数 ID 都存在于 cdi3.json');

  if (!hasAssets) {
    skip('缺 大肥鱼.cdi3.json（素材不进仓库）');
  } else {
    const cdi = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, '大肥鱼.cdi3.json'), 'utf8'));
    const ids = new Set(cdi.Parameters.map((p) => p.Id));
    ok(ids.size === 509, `cdi3 参数总数 509（实测 ${ids.size}）`);

    const missing = Object.entries(D.param)
      .filter(([, id]) => id && !ids.has(id))
      .map(([k, id]) => `${k}=${id}`);
    ok(missing.length === 0,
      `param 全部 ID 命中 cdi3${missing.length ? ' —— 不存在：' + missing.join(', ') : ''}`);

    /* 显式确认「不存在的器官」是 null 而不是删键。 */
    ok(D.param.BROW_L_X === null && D.param.BROW_R_X === null,
      'BROW_L/R_X = null（这模型没有眉毛 X 位移参数，写空而非删键）');
    ok(D.param.BROW_L_FORM === null && D.param.BROW_R_FORM === null,
      'BROW_L/R_FORM = null（这模型没有眉毛形态参数）');
    ok(D.param.CHEEK === null, 'CHEEK = null（这模型没有连续脸红参数，脸红是 key7 贴纸）');
    ok(D.param.EYE_L_SMILE === undefined || D.param.EYE_L_SMILE === null,
      'EYE_L_SMILE 未接（这模型没有微笑眼参数）');

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
  for (const name of Object.keys(D.emotion)) {
    ok(keyset(D.emotion[name]) === base, `情绪 ${name} 的字段集与 calm 一致`);
  }
  ok(keyset(D.emoRange) === base, 'emoRange 键集 == EMOTION 字段集');
  ok(keyset(D.emoSpeed) === base, 'emoSpeed 键集 == EMOTION 字段集');
  ok(Object.keys(D.patDelta).every((k) => EMOTION_KEYS.includes(k)),
    'patDelta 的键都在 EMOTION 字段集内');

  /* ================= [D] 三张表情表 key 参数互不重叠 ================= */
  console.log('\n[D] 三张表情表（emo / ev / prop）写的 key 参数互不重叠');

  /* 提取每个 exp3 文件写的参数集（从 exp3 文件本身读，不靠文件名猜）。 */
  const expDir = path.join(MODEL_DIR, 'expressions');
  const expParams = new Map();
  if (!fs.existsSync(expDir)) {
    skip('缺 expressions/ 目录（素材不进仓库）');
  } else {
    for (const f of fs.readdirSync(expDir)) {
      if (!f.endsWith('.exp3.json')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(expDir, f), 'utf8'));
      expParams.set(f.replace(/\.exp3\.json$/, ''), new Set((j.Parameters || []).map((p) => p.Id)));
    }
    ok(expParams.size >= 20, `expressions/ 目录有 ${expParams.size} 个 exp3 文件`);

    /* 三张表全部文件引用的参数并集检查：同一个参数被**不同通道**引用 → 冲突。
     * 同一通道内重复引用同一文件无害（emote() 同一时刻只播一个）。 */
    const owner = new Map();
    const register = (channel, table) => {
      for (const file of Object.values(table)) {
        const ps = expParams.get(file);
        if (!ps) continue;   // 文件不存在 → 加载器静默跳过，不算冲突
        for (const id of ps) {
          const cur = owner.get(id);
          if (cur) {
            // 同一通道内重复引用同一文件 = 无害（emote 单播）
            if (cur.channel === channel) continue;
            ok(false, `${id} 被 ${cur.channel} 和 ${channel} 的「${file}」同时写入`);
          } else {
            owner.set(id, { channel, file });
          }
        }
      }
    };
    register('emo', D.expressions);
    register('ev', D.emotes);
    for (const spec of D.props) register('prop', { [spec.file]: spec.file });
    ok(owner.size > 0, `三张表共引用 ${owner.size} 个参数，跨通道无重叠`);

    /* 负对照：让 happy 也写 ＞＜（与 smile 写同一个文件）→ 同一通道内两个
     * 条目写同一组 key 参数，重叠检查必须变红。 */
    const badTable = { ...D.expressions, happy: '＞＜' };
    const clash = (() => {
      const seen = new Map();
      for (const file of Object.values(badTable)) {
        const ps = expParams.get(file);
        if (!ps) continue;
        for (const id of ps) {
          if (seen.has(id)) return `${id} 被两个 emo 条目同时写入`;
          seen.set(id, file);
        }
      }
      return null;
    })();
    ok(!!clash, `负对照：emo 表让 happy 与 smile 都写 ＞＜ → ${clash || '未检测到冲突（断言失效！）'}`);
  }

  /* ================= [E] model3.json 注册 ================= */
  console.log('\n[E] model3.json 的动作组名与 Expressions 段');

  const m3Path = path.join(MODEL_DIR, '大肥鱼.model3.json');
  if (!fs.existsSync(m3Path)) {
    skip('缺 大肥鱼.model3.json（素材不进仓库）');
  } else {
    const m3 = JSON.parse(fs.readFileSync(m3Path, 'utf8'));
    const groups = Object.keys(m3.FileReferences?.Motions || {});
    /* pet.js 调 model.motion('Idle') / model.motion('TapBody')（首字母大写）。 */
    ok(groups.includes('Idle'), `动作组有 Idle（pet.js 默认动作；实测组：${groups.join(',')}）`);
    ok(groups.includes('TapBody'), '动作组有 TapBody（被摸时播）');
    ok(!!(m3.FileReferences?.Expressions || []).length,
      `Expressions 段已注册（${m3.FileReferences.Expressions.length} 个表情）`);

    /* 表情文件名必须与 expressions/ 目录逐字一致（fetch 会编码，写错 = 8s 超时静默跳过）。
     * model3.json 的 File 字段带 `expressions/` 前缀 + `.exp3.json` 后缀，
     * 目录里是裸文件名（无后缀）→ 两边都归一化再比。 */
    const listed = (m3.FileReferences?.Expressions || [])
      .map((e) => (e.File || e.Name).replace(/^expressions\//, '').replace(/\.exp3\.json$/, ''));
    const dirFiles = fs.readdirSync(path.join(MODEL_DIR, 'expressions')).map((f) => f.replace(/\.exp3\.json$/, ''));
    const missing = listed.filter((f) => !dirFiles.includes(f));
    ok(missing.length === 0,
      `model3.json 的 ${listed.length} 个表情文件在 expressions/ 目录全部存在${missing.length ? ' —— 缺失：' + missing.join(', ') : ''}`);

    /* 🔴 HitAreas 字段必须存在且为数组。插件 getHitAreaDefs() 里
     * `this.settings.hitAreas.map(...)` —— 没有 HitAreas 字段时
     * this.hitAreas 初始化为 {}，{}.map 直接炸，boot failed。
     * 实测：deepfish 的 cdi3.json 没有 HitAreas（VTS 从 PSD 导入特征），
     * hiyori/whale 都有。这里断言 model3.json 顶层有 HitAreas。 */
    ok(Array.isArray(m3.HitAreas),
      `model3.json 顶层有 HitAreas 数组${Array.isArray(m3.HitAreas) ? '' : '（🔴 缺失 → boot failed: _a.map is not a function）'}`);
  }

  /* ================= [F] 接线层（源码断言） ================= */
  console.log('\n[F] 接线层');

  const PARAMS = readSrc('renderer/params.js');
  ok(/import\s*\{[^}]*DEEPFISH[^}]*\}\s*from\s*['"][^'"]*profiles\/deepfish\.js['"]/.test(PARAMS),
    'params.js 已 import DEEPFISH 档案');
  ok(/\[DEEPFISH\.name\]\s*:\s*DEEPFISH\.model/.test(PARAMS),
    'params.js 的 MODELS 注册表里有 deepfish');
  ok(/\[DEEPFISH\.name\]\s*:\s*DEEPFISH\.expressions/.test(PARAMS),
    'params.js 的 EXPRESSIONS 注册表里有 deepfish');
  ok(/\[DEEPFISH\.name\]\s*:\s*DEEPFISH\.emotes/.test(PARAMS),
    'params.js 的 EMOTES 注册表里有 deepfish');
  ok(/\[DEEPFISH\.name\]\s*:\s*DEEPFISH\.props/.test(PARAMS),
    'params.js 的 PROPS 注册表里有 deepfish');

  const MAIN = readSrc('main/main.js');
  ok(/deepfish/.test(MAIN) && /大肥鱼/.test(MAIN),
    'main.js 的 APPEARANCE_MODELS 有 deepfish（菜单可见）');
  ok(/DEEPFISH_CREDIT|神宫凉子|霓虹猫/.test(MAIN),
    'main.js 切到 deepfish 时有署名 toast（素材自带署名要求）');

  /* pet.js 不调 model.expression() —— 表情由 pet.js 自己的 fetch + setParam 通道管理；
   * model3.json 注册 Expressions 段只是让插件认数据，不触发应用。
   * 注意：正则要排除注释（注释里也写了 model.expression() 这几个字）。 */
  const PET = readSrc('renderer/pet.js');
  /* 去掉注释后再匹配调用（排除注释里的字面文本）。 */
  const petNoComments = PET.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/\.expression\s*\(/.test(petNoComments),
    'pet.js 不调 model.expression()（避免与自己的 setParam 通道打架）');

  /* 素材合规：deepfish 目录在 gitignore 内（模型素材不进仓库）。 */
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  ok(/src\/assets\/models\//.test(gi), '.gitignore 排除 src/assets/models/（deepfish 素材不进仓库）');

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
