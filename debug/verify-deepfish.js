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
 *   [F] 接线层：params.js 四个注册表都还有 deepfish（**代码保留**），
 *       但 main.js 的 APPEARANCE_MODELS **不再列它**（菜单入口已撤）。
 *   [H] 退役守卫：档案 `model.retired: true` 会让 pet.js 的 resolveModelName()
 *       一律回落默认模型 —— 存量配置里残留的 'deepfish' 也挂不上。
 *       这一节**真跑** resolveModelName（从源码抠出来执行），并带负对照
 *       （摘掉标志后必须立刻放行）。
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
  /* 2026-10-31 退役：deepfish 从**菜单**移除，但档案 / 注册表 / 署名文案都留着
   * （代码保留）。所以这里断言的是「不在 APPEARANCE_MODELS 里」而**不是**
   * 「main.js 里没有 deepfish 三个字」—— 后者会把注释里的退役说明也算红。 */
  const appearanceBlock = (MAIN.match(/const APPEARANCE_MODELS = \[[\s\S]*?\];/) || [''])[0];
  ok(appearanceBlock.length > 0, 'main.js 里能找到 APPEARANCE_MODELS 表');
  ok(!/deepfish/.test(appearanceBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'APPEARANCE_MODELS **不含** deepfish（已退役，菜单不可选）');
  ok(/normalizeAppearanceModel/.test(MAIN),
    'main.js 有 normalizeAppearanceModel()（存量配置回落默认，托盘单选不空转）');
  ok(/normalizeAppearanceModel\(\);\s*\/\/[^\n]*\n\s*createWindow\(\)|normalizeAppearanceModel\(\);\s*\n\s*createWindow\(\)/.test(MAIN),
    '启动时先 normalizeAppearanceModel() 再 createWindow（顺序不能反）');
  ok(/DEEPFISH_CREDIT|神宫凉子|霓虹猫/.test(MAIN) || /DEEPFISH_CREDIT/.test(readSrc('renderer/profiles/deepfish.js')),
    '署名文案仍在档案里（素材自带署名要求）');

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

  /* ================= [G] 实测取景（alignByMeasure） =================
   *
   * 背景：档案里那组几何常数是「模型落点 = 常数 × s」的**线性假设**。
   * hiyori / whale 上成立，这个模型不成立 —— 实测模型落在画布左下，
   * 推算说在左上，差半个画布；画布又是窗口的 2.898 倍 → 人物整体在窗口外，
   * 屏幕上只剩呆毛尖（用户原话：「只能看到头顶的一撮毛」）。
   * 修法是不再推、改从画布像素里量（measureCanvasInk）。这一节守四条：
   *   ① 档案必须声明 alignByMeasure: true；
   *   ② pet.js 里三件套齐全，且 layout() **确实**走了实测分支；
   *   ③ 实测读的是**设备像素网格**（drawingBufferWidth）——
   *      按 renderer.width（逻辑宽）解析会整体错位（踩过，白折腾两轮）；
   *   ④ 换模型 / 改缩放必须把旧框作废（否则拿上个模型的框去对齐）。
   * 负对照（人工）：把档案改成 alignByMeasure: false 再跑 `?snap=ink`，
   * 墨水框立刻缩回窗口底部那一小块 —— 已实测确认。 */
  console.log('\n[G] 实测取景：不再推算落点，改从画布像素量');

  ok(D.model?.alignByMeasure === true,
    '档案声明 alignByMeasure: true（走实测对齐）');
  ok(D.model?.anchorY !== 'bottom',
    '实测对齐只支持顶部锚定（趴姿模型的底部锚定仍走实测标定常数）');

  ok(/function\s+measureCanvasInk\s*\(/.test(PET),
    'pet.js 有 measureCanvasInk()');
  ok(/function\s+applyCanvasOff\s*\(/.test(PET),
    'pet.js 有 applyCanvasOff()（canvas 位置的唯一出口）');
  ok(/function\s+scheduleInkMeasure\s*\(/.test(PET),
    'pet.js 有 scheduleInkMeasure()（layout 后异步量、量不到重试）');

  /* 核心断言：对齐用的是量出来的框，不是那两条推算式子。 */
  ok(/alignByMeasure\s*&&\s*!anchorBottom\s*&&\s*inkBoxMeasured/.test(
    PET.replace(/\/\*[\s\S]*?\*\//g, '')),
  'layout() 里有「档案 alignByMeasure && inkBoxMeasured」的实测分支');

  /* 🔴 设备像素网格（负对照历史：按逻辑宽解析 → 框偏到画布右边）。 */
  ok(/gl\.drawingBufferWidth/.test(PET),
    'measureCanvasInk 用 gl.drawingBufferWidth（设备像素网格）');
  ok(!/renderer\.width\s*\*\s*[^;]*4\]/.test(PET),
    '没有按 renderer.width 分配 readPixels 缓冲（那样会整体错位）');

  /* 换模型 / 改缩放要作废旧框 */
  ok(/inkBoxMeasured\s*=\s*null[\s\S]{0,120}inkMeasureGen\+\+/.test(PET),
    'applyModelGeometry 会清空旧框并推进代际（不拿上个模型的框对齐）');

  /* ================= [H] 退役：不上菜单、不许被挂上，代码留着 =================
   *
   * 2026-10-31 用户拍板：这个模型不出现在产品里（素材禁二次分发 + 观感），
   * 但档案 / 注册表 / 接线 / 实测取景那套实现**全部保留**，将来接别的
   * 第三方模型直接照抄。
   *
   * 这里盯的是「**两处必须一起改**」这条纪律：
   *   · 渲染侧：档案 `model.retired: true` → resolveModelName() 回落默认
   *   · 主进程侧：main.js 的 APPEARANCE_MODELS 里不列它（菜单入口）
   * 只改一处 = 菜单能点但挂不上，或能挂但没有入口。
   *
   * 🔴 拦 deepfish 的是**真跑一遍 pet.js 里那个函数**（从源码抠出来执行），
   *    不是在这里抄一份等价逻辑 —— 抄的那份永远不会红。 */
  console.log('\n[H] 退役：不上菜单、不许被挂上（代码保留）');

  ok(D.model?.retired === true, '档案声明 model.retired: true');
  ok(/\[DEEPFISH\.name\]\s*:\s*DEEPFISH\.model/.test(PARAMS),
    'params.js 仍注册 deepfish（代码保留，不是删干净）');

  const fnSrc = (PET.match(/function\s+resolveModelName\s*\(name\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  ok(fnSrc.length > 0, 'pet.js 里能抠出 resolveModelName 函数体');
  let resolveModel = null;
  try {
    /* eslint-disable-next-line no-new-func */
    resolveModel = new Function('MODELS', 'MODEL_NAME', `${fnSrc}\nreturn resolveModelName;`)(
      { hiyori: {}, whale: {}, deepfish: D.model }, 'hiyori');
  } catch { /* 下面那条断言会红 */ }
  ok(typeof resolveModel === 'function', 'resolveModelName 可执行（源码级真跑）');
  ok(resolveModel?.('hiyori') === 'hiyori', '已知模型原样返回');
  ok(resolveModel?.('deepfish') === 'hiyori',
    '配置里残留 deepfish → 回落默认模型（不会被挂上）');
  ok(resolveModel?.('nope') === 'hiyori', '不存在的键 → 回落默认模型');

  /* 负对照：摘掉 retired 标志，**同一个函数**必须立刻放行 deepfish。
   * 证明拦住它的是这个字段，而不是"注册表里恰好没有"之类的别的原因。 */
  let negResolve = null;
  try {
    negResolve = new Function('MODELS', 'MODEL_NAME', `${fnSrc}\nreturn resolveModelName;`)(
      { hiyori: {}, whale: {}, deepfish: {} }, 'hiyori');
  } catch { /* 上面已红 */ }
  ok(negResolve?.('deepfish') === 'deepfish',
    '负对照：去掉 retired 标志后 deepfish 立刻可挂（证明是标志在拦）');

  /* 换模型的正确流程写进文档，别让下一个人重新踩一遍 */
  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
