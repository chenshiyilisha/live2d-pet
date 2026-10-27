'use strict';

/* 「把参数用好」那一版（呆毛 / 左右眉不对称 / 身体前后侧倾 / 错峰插值 /
 * 说话时视线游移）的源码级防回流断言。
 *
 * 这一版坏起来全是**静默**的，所以断言必须咬住三个地方：
 *   1) EMOTION 表某个情绪缺字段 → 那个字段永远停在切换前的旧值。不报错，
 *      只是"眉毛卡住了"。所以先断言 8 个情绪的键集合逐个相同。
 *   2) EMO_SPEED 漏字段 → 那个字段退回默认速度，错峰效果悄悄失效。
 *   3) applyEmotion 漏一行 put → 参数怎么调都不动。EMOTION 里加了字段
 *      却忘了接线，是最容易发生的一次性错误。
 *
 * ⚠️ 这里**真的 import 了 src/renderer/params.js**（复制成 .mjs 让 Node 按
 *    ESM 解析），不是拿正则从源码切文本 —— 表本身是纯常量模块，没有 DOM /
 *    pixi 依赖，能直接跑，跑出来的就是应用里那份真值。
 *    参数 ID 则拿模型自己的 Hiyori.cdi3.json 回查（拼错一个字母就红）。
 *
 * 跑法：node debug/verify-expressive.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

(async () => {
  /* ---- 复制 params.mjs + profiles/*.mjs 到临时目录再 import ----
   * params.js 从 profiles/<name>.js import 档案数据 —— 单文件复制会断
   * import，必须把 profiles/ **整个目录**搬上（加新模型不用改这里）。 */
  const tmp = path.join(os.tmpdir(), `wb-params-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'profiles'), { recursive: true });
  for (const f of fs.readdirSync(path.join(SRC, 'renderer', 'profiles'))) {
    if (f.endsWith('.js')) fs.copyFileSync(
      path.join(SRC, 'renderer', 'profiles', f),
      path.join(tmp, 'profiles', f.replace(/\.js$/, '.mjs')));
  }
  fs.writeFileSync(
    path.join(tmp, 'params.mjs'),
    fs.readFileSync(path.join(SRC, 'renderer', 'params.js'), 'utf8')
      .replace(/'\.\/profiles\/([A-Za-z0-9_-]+)\.js'/g, "'./profiles/$1.mjs'"));
  let M;
  try {
    M = await import(pathToFileURL(path.join(tmp, 'params.mjs')).href);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const { EMOTION, EMO_SPEED, EMO_SPEED_DEFAULT, PARAM } = M;

  console.log('[A] params.js —— EMOTION 八个情绪的字段集必须完全相同');
  {
    const names = Object.keys(EMOTION);
    ok(names.length === 8, `情绪数 = 8（${names.join(',')}）`);
    const expect = [
      'calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy'
    ];
    ok(expect.every((n) => names.includes(n)), '情绪名与 [emo:xxx] 协议（config.js 的 EMOTION_TAGS）一字不差');

    const base = Object.keys(EMOTION.calm).sort();
    ok(base.length === 16, `字段数 = 16（实际 ${base.length}：${base.join(',')}）`);
    for (const n of names) {
      const k = Object.keys(EMOTION[n]).sort();
      const missing = base.filter((f) => !k.includes(f));
      const extra = k.filter((f) => !base.includes(f));
      ok(missing.length === 0 && extra.length === 0,
        `${n} 字段集一致${missing.length ? ' 缺:' + missing : ''}${extra.length ? ' 多:' + extra : ''}`);
    }
  }

  console.log('[B] params.js —— EMO_SPEED 必须覆盖每一个情绪字段（两个表的键集相等）');
  {
    const fields = Object.keys(EMOTION.calm).sort();
    const speeds = Object.keys(EMO_SPEED).sort();
    const noSpeed = fields.filter((f) => !speeds.includes(f));
    const orphan = speeds.filter((f) => !fields.includes(f));
    ok(noSpeed.length === 0, `没有漏速度的字段${noSpeed.length ? '（漏:' + noSpeed + '）' : ''}`);
    ok(orphan.length === 0, `没有指向不存在字段的速度项${orphan.length ? '（多余:' + orphan + '）' : ''}`);
    ok(EMO_SPEED_DEFAULT > 0, '默认速度是正数（兜底别写成 0，否则字段永远不动）');
    for (const [, v] of Object.entries(EMO_SPEED)) {
      if (!(typeof v === 'number' && v > 0 && v < 60)) { ok(false, `速度值越界：${v}`); }
    }
    console.log('  ---- 速度梯度 ----');
    const g = (k) => EMO_SPEED[k];
    ok(g('browLY') > g('headY'), `眉(${g('browLY')}) > 头(${g('headY')}) —— 眉毛先动`);
    ok(g('headY') > g('bodyY'), `头(${g('headY')}) > 身体(${g('bodyY')}) —— 身体最慢（它过物理）`);
    ok(g('eyeOpen') > g('mouthForm'), `眼(${g('eyeOpen')}) > 嘴(${g('mouthForm')})`);
    ok(g('mouthForm') > g('cheek'), `嘴(${g('mouthForm')}) > 脸红(${g('cheek')}) —— 脸红是渐变不是开关`);
    console.log(`  (眉 ${g('browLY')} · 眼 ${g('eyeOpen')} · 呆毛 ${g('ahoge')} · 嘴 ${g('mouthForm')} · 脸红 ${g('cheek')} · 头 ${g('headY')} · 身 ${g('bodyY')})`);
  }

  console.log('[C] params.js —— 参数 ID 拿模型自己的 CDI 清单回查');
  {
    /* CDI 路径不写死：从当前生效档案的 url（model3.json）读它自报的
     * DisplayInfo —— 加新模型这里自动跟上，不用改。 */
    const cur = M.MODELS[M.MODEL_NAME];
    const rel = cur.url.replace(/^\/src\/assets\/models\//, '');
    const m3 = JSON.parse(fs.readFileSync(
      path.join(SRC, 'assets/models', rel), 'utf8'));
    const cdi = JSON.parse(fs.readFileSync(
      path.join(SRC, 'assets/models', path.dirname(rel), m3.FileReferences.DisplayInfo), 'utf8'));
    const ids = new Set((cdi.Parameters || []).map((p) => p.Id));
    ok(ids.size >= 50, `CDI 清单可读（${ids.size} 个参数）`);
    for (const [k, v] of Object.entries(PARAM)) {
      ok(ids.has(v), `PARAM.${k} = ${v}`);
    }
    /* 本版新增的五个（漏接一个就等于这个功能没做）。
     *
     * ⚠️ 但「没登记」有两种，不能一律判死：
     *   ① 真漏了 —— 必须报错；
     *   ② **有理由地不接** —— 某些模型上这些参数根本不能写。鲸鱼娘就是：
     *      ParamBodyAngleX/Y/Z 和呆毛是 physics3.json 的**输出**，我们叠加
     *      的情绪 delta 会被物理冲掉（身体参数还是物理的自反馈输入，会被
     *      吃进积分里放大）。见 profiles/whale.js 的注释与 verify-whale [A]。
     * 所以判据是：**要么登记了 ID，要么档案里写清楚了为什么不填**。 */
    const profileSrc = fs.readFileSync(
      path.join(SRC, 'renderer', 'profiles', `${M.MODEL_NAME}.js`), 'utf8');
    for (const k of ['BROW_L_X', 'BROW_R_X', 'AHOGE', 'BODY_Y', 'BODY_Z']) {
      if (typeof PARAM[k] === 'string') {
        ok(true, `本版新增参数 PARAM.${k} 已登记`);
        continue;
      }
      const reasoned = new RegExp(`${k}[\\s\\S]{0,600}?(?:不填|置空)[\\s\\S]{0,600}?物理`)
        .test(profileSrc);
      ok(reasoned,
        `PARAM.${k} 当前模型未登记 —— 档案里必须写明「不填 + 物理」的理由（防漏接）`);
    }
  }

  console.log('[D] params.js —— 数值范围（超范围会被 Cubism 静默 clamp，白写）');
  {
    /* 范围表已经从本脚本**收进 params.js**（EMO_RANGE）—— 因为运行时
     * 的 buildEmoTarget() 也要用它夹取，两处各写一份必然漂移。
     * 这里直接拿真表回查情绪表。 */
    const LIM = M.EMO_RANGE;
    {
      const fields = Object.keys(EMOTION.calm).sort();
      const ranges = Object.keys(LIM).sort();
      const miss = fields.filter((f) => !ranges.includes(f));
      const extra = ranges.filter((f) => !fields.includes(f));
      ok(miss.length === 0, `EMO_RANGE 覆盖每一个情绪字段${miss.length ? '（漏:' + miss + '）' : ''}`);
      ok(extra.length === 0, `EMO_RANGE 没有指向不存在字段的项${extra.length ? '（多余:' + extra + '）' : ''}`);
    }
    for (const [n, e] of Object.entries(EMOTION)) {
      const bad = Object.entries(e).filter(([f, v]) => {
        const r = LIM[f];
        return !r || !(v >= r[0] && v <= r[1]);
      });
      ok(bad.length === 0, `${n} 所有字段在范围内${bad.length ? '（越界:' + JSON.stringify(bad) + '）' : ''}`);
    }
    // 呆毛/身体的"有戏"幅度：全 0 就等于这个功能没做
    const spread = (f) => Math.max(...Object.values(EMOTION).map((e) => e[f]))
                       - Math.min(...Object.values(EMOTION).map((e) => e[f]));
    for (const f of ['ahoge', 'bodyY', 'bodyZ']) {
      ok(spread(f) > 0.5, `${f} 在八个情绪里有实际变化幅度（${spread(f).toFixed(2)}）`);
    }
    // 不对称：至少一个情绪左右眉真的不一样，否则 browLX/RX 白加
    const asym = Object.entries(EMOTION).filter(([, e]) => e.browLY !== e.browRY || e.browLX !== e.browRX);
    ok(asym.length >= 1, `至少一个情绪用了不对称眉（${asym.map(([n]) => n).join(',') || '无'}）`);
  }

  console.log('[E] pet.js —— EMOTION 的每个字段都在 applyEmotion 里接了线');
  {
    const r = stripComments(read('renderer/pet.js'));
    for (const f of Object.keys(EMOTION.calm)) {
      ok(new RegExp(`emoCur\\.${f}\\b`).test(r), `applyEmotion 写了 emoCur.${f}`);
    }
    // 旧的单值 browY 不该再残留（改成 browLY/browRY 了）
    ok(!/emoCur\.browY\b/.test(r), '没有残留的单边 browY（已拆成 browLY/browRY）');
    // 左右的 put 必须各写各的（写成同一个字段就又变回对称了）
    ok(/put\(P\.BROW_L_Y,\s*emoCur\.browLY\)/.test(r), 'put(BROW_L_Y) 取 browLY');
    ok(/put\(P\.BROW_R_Y,\s*emoCur\.browRY\)/.test(r), 'put(BROW_R_Y) 取 browRY');
    ok(/put\(P\.AHOGE,\s*emoCur\.ahoge\)/.test(r), 'put(AHOGE) 取 ahoge');
    ok(/put\(P\.BODY_Y,\s*emoCur\.bodyY\)/.test(r), 'put(BODY_Y) 取 bodyY');
    ok(/put\(P\.BODY_Z,\s*emoCur\.bodyZ\)/.test(r), 'put(BODY_Z) 取 bodyZ');
  }

  console.log('[F] pet.js —— 主循环里 focus 必须排在情绪之前');
  {
    const r = stripComments(read('renderer/pet.js'));
    // 只取主循环那段（ticker.add 之后到 LOW 优先级注册之间）
    const loop = (r.match(/app\.ticker\.add\(\(ticker\)\s*=>\s*\{([\s\S]*?)\},\s*null,\s*PIXI\.UPDATE_PRIORITY\.LOW\)/) || ['', ''])[1];
    ok(loop !== '', '主循环段落切得出来');
    const gi = loop.indexOf('updateGaze(');
    const ei = loop.indexOf('applyEmotion()');
    ok(gi >= 0 && ei >= 0, `两处调用都在主循环里（updateGaze@${gi}, applyEmotion@${ei}）`);
    ok(gi >= 0 && ei > gi, 'updateGaze() 在 applyEmotion() 之前 —— 反过来情绪的歪头点头会被 focus 覆盖掉');
    // 分档插值：每个字段现查速度
    ok(/EMO_SPEED\[key\] \?\? EMO_SPEED_DEFAULT/.test(loop),
      '逐字段查速度表（漏项退回默认）');
    // 再乘这一趟的抖动因子（jitter.js）—— 关掉开关时因子为 1，与旧版逐位一致
    ok(/emoJitter/.test(loop), '插值速度乘了本趟抖动因子（关掉时乘 1，见 verify-jitter）');
    ok(/1 - Math\.exp\(-dt \* sp\)/.test(loop), '仍是与帧率无关的指数逼近');
    ok(!/exp\(-dt \* 5\.5\)/.test(loop), '旧的单速插值已移除');
  }

  console.log('[G] pet.js —— 说话时视线游移（原来 SPEAKING 没有分支，眼珠冻结）');
  {
    const r = stripComments(read('renderer/pet.js'));
    const gaze = (r.match(/function updateGaze\(dt\)\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];
    ok(gaze !== '', 'updateGaze 函数切得出来');
    ok(/State\.SPEAKING/.test(gaze), 'SPEAKING 分支存在');
    ok(/State\.IDLE/.test(gaze) && /State\.LISTENING/.test(gaze) && /State\.THINKING/.test(gaze),
      'IDLE / LISTENING / THINKING 三支都还在（别为了加 SPEAKING 把老分支弄丢）');
    const sines = (gaze.match(/Math\.sin\(/g) || []).length;
    ok(sines >= 3, `游移用多条正弦叠加（${sines} 处 Math.sin）—— 单条正弦的周期感很重`);
    ok(/if \(!pointer\) return;/.test(gaze), '没有光标时整段跳过（让情绪的头部姿态独自生效）');
  }

  console.log('[H] params.js —— 摸头 A-B-C 的调制（真调 buildEmoTarget，不是正则）');
  {
    const { PAT, PAT_DELTA, buildEmoTarget } = M;
    const FIELDS = Object.keys(EMOTION.calm);
    const out = {};   // 调用方复用的对象，和主循环里一样

    /* ① PAT_DELTA 的键必须在情绪字段集里。
     *    写错一个名字 = 那个通道永远不动，而且**完全静默**。 */
    {
      const bad = Object.keys(PAT_DELTA).filter((k) => !FIELDS.includes(k));
      ok(bad.length === 0, `PAT_DELTA 的键都在 EMOTION 字段集里${bad.length ? '（多:' + bad + '）' : ''}`);
      ok(Object.keys(PAT_DELTA).length >= 8,
        `摸头调的通道够用（${Object.keys(PAT_DELTA).length} 个）—— 只动头不动脸，读出来是"点头"不是"被摸"`);
      const core = ['headY', 'headZ', 'ahoge', 'eyeOpen', 'cheek'];
      ok(core.every((k) => PAT_DELTA[k]), `该动的那几个都在（${core.join(' / ')}）`);
    }

    /* ② 摆动必须真的错峰 —— 全同相位 = 整张脸一起晃 = 木偶
     *    （同 [B] 段那条"共用一个速度等于木偶"的道理）。 */
    {
      const offs = Object.values(PAT_DELTA).map((d) => d.s);
      ok(new Set(offs).size >= 3, `相位偏移有 ${new Set(offs).size} 档（全同相会整张脸一起晃）`);
      const wig = Object.values(PAT_DELTA).filter((d) => d.w > 0);
      ok(wig.length >= 3, `${wig.length} 个通道带摆动（B 段才有戏，否则按住等于定住）`);
      ok(PAT.wiggleHz > 0.2 && PAT.wiggleHz < 2,
        `摆动 ${PAT.wiggleHz}Hz 在合理区间（太快是抖，不是顺毛）`);
      ok(PAT.rise > PAT.fall,
        `起手(${PAT.rise}) 比收尾(${PAT.fall}) 快 —— 手放上去要跟手，拿开要愣一下`);
      ok(PAT.shyMs < PAT.nagMs,
        `先害羞(${PAT.shyMs}ms) 再抗议(${PAT.nagMs}ms) —— 顺序反了她会先骂人再脸红`);
      /* 挣脱必须排在抗议**之后**：先提醒、不听再翻脸。反过来就是
       * "一句话不说就甩手"，用户不知道自己哪里惹到她了。 */
      ok(PAT.nagMs < PAT.escapeMs,
        `抗议(${PAT.nagMs}ms) 在挣脱(${PAT.escapeMs}ms) 之前 —— 先提醒再挣脱`);
    }

    /* ③ patAmt === 0 时**零侵入**：逐字段必须与基础情绪全等。
     *    这条是"没摸头时行为与改动前完全一致"的机器保证。 */
    {
      let bad = 0;
      for (const base of Object.values(EMOTION)) {
        buildEmoTarget(out, base, 0, 0);
        for (const f of FIELDS) if (out[f] !== base[f]) bad++;
        if (Object.keys(out).length !== FIELDS.length) bad++;
      }
      ok(bad === 0, `patAmt=0 与基础情绪逐字段全等（${bad} 处不符）`);
    }

    /* ④ amt === 1 走三个完整摆动周期，任何一帧都不许越界。
     *    越界不会报错，只会静默停在边界（表现是"摸了半天脸红没变"）。 */
    {
      let bad = 0, first = '';
      for (const [n, base] of Object.entries(EMOTION)) {
        for (let i = 0; i < 96; i++) {
          buildEmoTarget(out, base, 1, (i / 96) * Math.PI * 6);
          for (const f of FIELDS) {
            const r = M.EMO_RANGE[f];
            if (!(out[f] >= r[0] && out[f] <= r[1])) {
              bad++;
              if (!first) first = `${n}.${f}=${out[f].toFixed(2)} 越 [${r[0]},${r[1]}]`;
            }
          }
        }
      }
      ok(bad === 0, `8 个情绪 × 3 个摆动周期全程不越界${bad ? `（${bad} 处，首例 ${first}）` : ''}`);
    }

    /* ⑤ 调制真的改了目标（不然这一整套是死代码） */
    {
      buildEmoTarget(out, EMOTION.happy, 1, 0.3);
      const moved = FIELDS.filter((f) => Math.abs(out[f] - EMOTION.happy[f]) > 1e-6);
      ok(moved.length >= 8, `摸头改了 ${moved.length} 个通道（${moved.join(',')}）`);
    }

    /* ⑥ 摆动是真的在动：同一通道在不同相位值不同 */
    {
      buildEmoTarget(out, EMOTION.happy, 1, 0);
      const z0 = out.headZ;
      buildEmoTarget(out, EMOTION.happy, 1, 1.9);
      ok(Math.abs(out.headZ - z0) > 0.3,
        `headZ 随相位变化（${z0.toFixed(2)} → ${out.headZ.toFixed(2)}）`);
    }
  }

  console.log('[I] pet.js —— 摸头的接线（按下起手 / 松手收尾 / 抢占 / 主循环顺序）');
  {
    const r = stripComments(read('renderer/pet.js'));

    /* 必须在**按下**时就判头顶 —— 原来判在松手才跑的 onPetClicked 里 */
    const down = (r.match(/canvas\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*\{([\s\S]*?)\n\}\);/) || ['', ''])[1];
    ok(down !== '', 'mousedown 段落切得出来');
    ok(/isHeadPatTarget\(e\.clientX,\s*e\.clientY\)/.test(down), '按下时判头顶（不是等松手才判）');
    ok(/patStart\(\)/.test(down), '按下即起手 patStart()（A 段）');

    /* 摸头条带必须锚在**实量头顶**上：petRect.y 是解析推算的松边界，
     * 取景给头顶上方留了一整段放气泡（实测窗口 342 高时真头顶 y≈137，
     * petRect.y=14）—— 按它算「上 30%」整条带都在空气里，永远起不了手
     * （2026-10-14 ?snap=pat 实测踩过）。 */
    ok(!/petRect\.y \+ petRect\.h \* 0\.30/.test(r), '摸头条带不再锚在 petRect.y（那是推算值，不是真头顶）');
    ok(/headTopY \+ headBandH\(\)/.test(r), '条带锚在实量头顶 headTopY 上');
    ok(/headTopY <= 0\) return false/.test(r), '头顶还没量到时不起手（宁可不认，别在空气里起手）');
    ok(/queueHeadMeasure\(\)/.test(r), '布局变化后重新量头顶（queueHeadMeasure）');
    ok(/measureHeadTop\(\)/.test(r), '有实量头顶的实现（measureHeadTop）');
    ok(/readPixels\(/.test(r), '实量走 readPixels（mousedown 要同步判，走不了 IPC 往返）');

    /* 松手：先分流摸头，再走 onPetClicked */
    const up = (r.match(/window\.addEventListener\('mouseup',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/) || ['', ''])[1];
    ok(up !== '', 'mouseup 段落切得出来');
    ok(/if \(patState !== 'idle'\)/.test(up), 'mouseup 先分流摸头');
    ok(/patRelease\(\)/.test(up), '松手调 patRelease()（C 段）');
    {
      const pi = up.indexOf('patRelease()');
      const ci = up.indexOf('onPetClicked()');
      ok(pi >= 0 && ci > pi, '收尾在 onPetClicked() 之前 —— 摸头不会再走一遍"戳一下"');
    }

    /* onPetClicked 里不该再有摸头分支（否则摸头被算两次） */
    const click = (r.match(/function onPetClicked\(\)\s*\{([\s\S]*?)\n\}/) || ['', ''])[1];
    ok(click !== '', 'onPetClicked 切得出来且签名已无参');
    ok(!/headPat/.test(click), 'onPetClicked 里不再有摸头分支（已归 A-B-C）');
    ok(!/onHead/.test(click), 'onPetClicked 里不再有 onHead 判定');

    /* 抢占：拖拽优先 / 静默一起收手 */
    ok(/if \(patState !== 'idle'\) patAbort\(\);/.test(r), '变拖拽时 patAbort()（拖拽优先于摸头）');
    {
      const qi = r.indexOf('pet:quiet');
      ok(qi >= 0 && /patAbort\(\)/.test(r.slice(qi, qi + 900)), '静默收手里有 patAbort()（规矩 19）');
    }

    /* 主循环顺序：updatePat → buildEmoTarget → 插值(emoEff) → applyEmotion */
    const loop = (r.match(/app\.ticker\.add\(\(ticker\)\s*=>\s*\{([\s\S]*?)\},\s*null,\s*PIXI\.UPDATE_PRIORITY\.LOW\)/) || ['', ''])[1];
    ok(loop !== '', '主循环段落切得出来');
    {
      const a = loop.indexOf('updatePat(');
      const b = loop.indexOf('buildEmoTarget(');
      const c = loop.indexOf('for (const key in emoEff)');
      const d = loop.indexOf('applyEmotion()');
      ok(a >= 0 && b > a, 'updatePat 在 buildEmoTarget 之前（后者要用 patAmt/patPhase）');
      ok(b >= 0 && c > b, 'buildEmoTarget 在插值之前（插值逼近的是有效目标）');
      ok(c >= 0 && d > c, '插值在 applyEmotion 之前');
    }
    ok(/for \(const key in emoEff\)/.test(loop), '插值遍历 emoEff（有效目标）而不是 emoTarget');
    ok(!/for \(const key in emoTarget\)/.test(loop), '旧的 emoTarget 插值循环已移除');
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
