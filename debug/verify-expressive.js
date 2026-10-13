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
  /* ---- 把 params.js 复制成 .mjs 再 import（工作区是 CJS 包，.js 会被拒）---- */
  const tmp = path.join(os.tmpdir(), `wb-params-${process.pid}.mjs`);
  fs.copyFileSync(path.join(SRC, 'renderer', 'params.js'), tmp);
  let M;
  try {
    M = await import(pathToFileURL(tmp).href);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
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
    const cdi = JSON.parse(fs.readFileSync(
      path.join(SRC, 'assets/models/hiyori/Hiyori.cdi3.json'), 'utf8'));
    const ids = new Set((cdi.Parameters || []).map((p) => p.Id));
    ok(ids.size >= 70, `CDI 清单可读（${ids.size} 个参数）`);
    for (const [k, v] of Object.entries(PARAM)) {
      ok(ids.has(v), `PARAM.${k} = ${v}`);
    }
    // 本版新增的五个（漏接一个就等于这个功能没做）
    for (const k of ['BROW_L_X', 'BROW_R_X', 'AHOGE', 'BODY_Y', 'BODY_Z']) {
      ok(typeof PARAM[k] === 'string', `本版新增参数 PARAM.${k} 已登记`);
    }
  }

  console.log('[D] params.js —— 数值范围（超范围会被 Cubism 静默 clamp，白写）');
  {
    const LIM = {
      browLY: [-1, 1], browRY: [-1, 1], browLX: [-1, 1], browRX: [-1, 1],
      browAngle: [-1, 1], browForm: [-1, 1], mouthForm: [-1, 1],
      eyeSmile: [0, 1], eyeOpen: [0, 1.1], cheek: [0, 1], shoulder: [-1, 1],
      ahoge: [-1, 1], headZ: [-30, 30], headY: [-30, 30],
      bodyY: [-10, 10], bodyZ: [-10, 10]
    };
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
    ok(/const sp = EMO_SPEED\[key\] \?\? EMO_SPEED_DEFAULT;/.test(loop),
      '逐字段查速度表（漏项退回默认）');
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

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
