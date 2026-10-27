'use strict';

/* 心境层（src/main/mood.js + 渲染层 params.js 的 mixEmoMood + 接线）的回归。
 *
 * 覆盖三类风险：
 *   1) **数值层**（真跑 mood.js / 真调 mixEmoMood）：漂移公式错 / 事件漏账 /
 *      离线补漂与重聚错 / 坏档把开局漂成空壳 —— 全是静默失效。
 *   2) **人话层**：promptLine 的档位是给 LLM 看的，错档 = 她的语气
 *      凭空拧巴（「很想他」挂在 social=0.3 上）。
 *   3) **接线层**（源码断言）：mixEmoMood 必须在 mixEmoDecay **之后**、
 *      插值**之前**；prompt 注入必须在用户消息之前；开关关 = 零侵入。
 *
 * 双蓝本对齐点也在这里钉死：速率表只有一份（离线补漂与实时 tick 同一
 * step，PetMood 2026-10-14 的教训）；nightFactor 只在 mood.js 定义。
 *
 * 跑法：node debug/verify-mood.js
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main/main.js');
const PET = read('renderer/pet.js');
const PRELOAD = read('main/preload.js');
const CFG = read('main/config.js');

const G = require(path.join(ROOT, 'src/main/mood.js'));
const {
  createMoodEngine, nightFactor, RATE, GAIN,
  REUNION_MIN_SEC, REUNION_HOLD_SEC, OFFLINE_CAP_SEC,
  VAL_HAPPY, VAL_SERIOUS, ENERGY_LOW
} = G;

(async () => {
  /* ============================================================
   *  A. 漂移与解析解（喂固定小时数，夜系数不随真钟漂）
   * ========================================================== */
  console.log('\n══════ A. 漂移与解析解 ══════\n');

  {
    /* social 线性涨（nf=1）：10 分钟 +0.25 */
    const m = createMoodEngine();
    for (let i = 0; i < 60; i++) m.step(10, 14);      // 600s = 10min
    ok(near(m.axes.social, 0.25 + RATE.socialRise * 10, 1e-4),
      `social 10 分钟线性 +${RATE.socialRise * 10}（实际 ${m.axes.social.toFixed(4)}）`);
  }

  {
    /* 夜系数 ×2：同一时长 social 涨幅翻倍（凌晨 2 点） */
    const m = createMoodEngine();
    for (let i = 0; i < 60; i++) m.step(10, 2);
    ok(near(m.axes.social, 0.25 + RATE.socialRise * 2 * 10, 1e-4),
      `凌晨 social 涨速 ×${nightFactor(2)}（实际 ${m.axes.social.toFixed(4)}）`);
    ok(nightFactor(23) === 2.0 && nightFactor(5) === 2.0, '22–06 点夜系数 2.0（6 点整起是 1.4 档）');
    ok(nightFactor(7) === 1.4 && nightFactor(8) === 1.4, '06–09 点夜系数 1.4');
    ok(nightFactor(12) === 1.0 && nightFactor(21) === 1.0, '白天夜系数 1.0');
  }

  {
    /* energy 白天耗（nf=1）：10 分钟 −0.056 */
    const m = createMoodEngine();
    for (let i = 0; i < 60; i++) m.step(10, 12);
    ok(near(m.axes.energy, 0.70 + RATE.energyDrift * 10, 1e-4),
      `energy 10 分钟耗 ${RATE.energyDrift * 10}（实际 ${m.axes.energy.toFixed(4)}）`);
  }

  {
    /* valence 回中是指数：v−0.5 = (v₀−0.5)·e^(−|pull|·min)，10 秒 ×60 步 */
    const m = createMoodEngine();
    const v0 = 1.0;                                  // 用事件把 valence 顶满
    for (let i = 0; i < 8; i++) m.onClick();         // 0.55 + 0.06×8 → clamp 1
    ok(m.axes.valence === v0, '起点顶满 1.0（事件累积）');
    for (let i = 0; i < 60; i++) m.step(10, 12);
    const want = 0.5 + (v0 - 0.5) * Math.exp(RATE.valencePull * 10);
    ok(Math.abs(m.axes.valence - want) < 0.005,
      `valence 回中 10 分钟 ≈ ${want.toFixed(4)}（实际 ${m.axes.valence.toFixed(4)}，离散步进容差 0.005）`);
  }

  {
    /* pride erosion：social≥0.8 时端着被磨（无回中项干扰：从 0.5 出发） */
    const m = createMoodEngine();
    /* social 顶到 0.9：onUserChat 会归零，不能用它 —— 只能靠漂。直接
     * 漂 27 分钟（0.25 + 0.025×27 ≈ 0.925 ≥ 0.8）再开始量 pride。 */
    for (let i = 0; i < 162; i++) m.step(10, 12);
    ok(m.axes.social >= 0.8, `漂到想念 ≥0.8（实际 ${m.axes.social.toFixed(3)}）`);
    const p0 = m.axes.pride;
    m.step(60, 12);                                  // 1 分钟
    ok(near(m.axes.pride, p0 + RATE.pridePull * Math.abs(p0 - 0.5) - 0.01, 1e-4),
      'social≥0.8 时 pride 每分钟 −0.01（erosion）+ 回中项');
  }

  {
    /* dt 防护：NaN / 0 / 负数一步都不走（PetMood：NaN<=0 是 false 的坑） */
    const m = createMoodEngine();
    const before = { ...m.axes };
    m.step(NaN, 12); m.step(0, 12); m.step(-5, 12);
    ok(m.axes.social === before.social && m.axes.energy === before.energy,
      'dt 为 NaN/0/负 → 轴纹丝不动');
  }

  /* ============================================================
   *  B. 事件账本
   * ========================================================== */
  console.log('\n══════ B. 事件账本 ══════\n');

  {
    const m = createMoodEngine();
    for (let i = 0; i < 30; i++) m.step(60, 12);     // social 涨起来（轴也各自漂了一点）
    const s0 = m.axes.social;
    const v0 = m.axes.valence;
    const e0 = m.axes.energy;
    ok(s0 > 0.25, `先让想念涨起来（${s0.toFixed(3)}）`);
    m.onClick();
    ok(m.axes.social === 0, '点击 → 想念归零');
    ok(near(m.axes.valence, v0 + GAIN.clickValence, 1e-9), '点击 → 心情 +0.06');
    ok(near(m.axes.energy, e0 + GAIN.clickEnergy, 1e-9), '点击 → 活力小耗');
    ok(m.interactions === 1, '互动计数 +1');
  }

  {
    const m = createMoodEngine();
    m.onDragBegin();
    ok(near(m.axes.energy, 0.70 + GAIN.dragEnergy, 1e-9), '被拎起来 → 活力 −0.02');
    m.onUserChat();
    ok(m.axes.social === 0, '用户开口 → 想念归零（最强被搭理）');
    ok(near(m.axes.valence, 0.55 + GAIN.chatValence, 1e-9), '用户开口 → 心情 +0.04');
  }

  {
    /* 摸头：立即松手不计（sec≈0 早退）；按满上限只结 1.2s 的账 */
    const m = createMoodEngine();
    m.onPatStart();
    m.onPatEnd();
    ok(m.interactions === 0 && m.axes.valence === 0.55,
      '按下立刻松开 = 没摸到，不结账');

    const m2 = createMoodEngine();
    m2.onPatStart();
    await new Promise((r) => setTimeout(r, 1300));   // 超过 patMaxSec=1.2
    m2.onPatEnd();
    ok(near(m2.axes.valence, 0.55 + GAIN.patValencePerSec * GAIN.patMaxSec, 5e-3),
      `按住超上限 → 只结 1.2s 的账（+${(GAIN.patValencePerSec * GAIN.patMaxSec).toFixed(3)}）`);
    ok(m2.axes.social === 0 && m2.interactions === 1, '摸完 → 想念归零、计数 +1');
  }

  {
    const m = createMoodEngine();
    m.onAssistantEmotion('happy');
    ok(near(m.axes.valence, 0.55 + GAIN.emoPositive, 1e-9), '她聊出 happy → 心情 +');
    m.onAssistantEmotion('serious');
    ok(near(m.axes.valence, 0.55 + GAIN.emoPositive + GAIN.emoNegative, 1e-9), 'serious → 心情 −');
    m.onAssistantEmotion('sleepy');
    ok(near(m.axes.energy, 0.70 + GAIN.emoSleepyEnergy, 1e-9), 'sleepy → 活力 −');
    const v = m.axes.valence;
    m.onAssistantEmotion('calm');
    m.onAssistantEmotion('不存在');
    ok(m.axes.valence === v, 'calm / 未知名 → 轴不动');
  }

  /* ============================================================
   *  C. 离线补漂 / 重聚 / 存档
   * ========================================================== */
  console.log('\n══════ C. 离线补漂与重聚 ══════\n');

  {
    /* 离线 1 小时（≥20 分钟 → 重聚生效）：social 涨满后被重聚回落 35%、
     * energy 落在夜系数区间内 —— **期望值要把重聚这一层算进去**，
     * 否则 1×0.65=0.65 会被当成"没涨满"的 bug（写这条断言时真踩了一次）。 */
    const m = createMoodEngine();
    const applied = m.applyOffline(3600);
    ok(applied === 3600, '补漂报告了实际时长');
    ok(m.snapshot().reunion === true, '离线 1 小时 ≥20 分钟 → 重聚生效');
    ok(near(m.axes.social, 1 * (1 - 0.35), 1e-9),
      `想念涨满后被重聚回落 35% → ${(1 * 0.65).toFixed(2)}（实际 ${m.axes.social.toFixed(3)}）`);
    const lo = 0.70 + RATE.energyDrift * 2 * 60;     // 全程夜里（×2）
    const hi = 0.70 + RATE.energyDrift * 60;         // 全程白天（×1）
    ok(m.axes.energy >= lo - 1e-6 && m.axes.energy <= hi + 1e-6,
      `离线 1 小时活力落在夜系数区间 [${lo.toFixed(3)}, ${hi.toFixed(3)}]（实际 ${m.axes.energy.toFixed(3)}）`);
  }

  {
    /* 重聚：离线 ≥20 分钟触发，8 秒窗口内可见 */
    const m = createMoodEngine();
    m.applyOffline(7200);
    ok(m.reunionLeft > 0 && m.snapshot().reunion === true, '离线 2 小时 → 重聚生效');
    ok(m.snapshot().line.includes('刚回来'), '重聚窗口的人话（他刚回来）');
    for (let i = 0; i < Math.ceil(REUNION_HOLD_SEC / 5) + 1; i++) m.step(5, 12);
    ok(m.reunionLeft === 0 && m.snapshot().reunion === false, `${REUNION_HOLD_SEC}s 后重聚窗口关闭`);
  }

  {
    /* 离线 < 20 分钟：只补漂，不重聚 */
    const m = createMoodEngine();
    m.applyOffline(600);
    ok(m.reunionLeft === 0 && m.snapshot().reunion === false, '离线 10 分钟 → 不算久别');
  }

  {
    /* 存档往返：好档按时间戳补漂 */
    const tmp = path.join(os.tmpdir(), `wb-mood-${process.pid}.json`);
    fs.rmSync(tmp, { force: true });
    const a = createMoodEngine();
    a.onClick(); a.onUserChat();
    a.save(tmp);
    const b = createMoodEngine();
    const msg = b.loadAndDrift(tmp);
    ok(msg.includes('loaded'), `好档读回（${msg}）`);
    ok(b.interactions === 2, '互动计数随档往返');
    ok(b.axes.offlineAppliedSec === undefined && msg.includes('drift'),
      '读档后按时间戳补漂（消息里有 drift 报数）');
    fs.rmSync(tmp, { force: true });
  }

  {
    /* 坏档：脏轴回退初值，且**不按坏钟补漂**（PetMood S12b 教训） */
    const tmp = path.join(os.tmpdir(), `wb-mood-bad-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({
      t: Date.now() - 8 * 3600 * 1000,
      valence: NaN, social: 0.9, energy: 0.9, pride: 0.9,
      interactions: 5, reunions: 1, version: 1
    }));
    const m = createMoodEngine();
    const msg = m.loadAndDrift(tmp);
    ok(msg.includes('dirty'), `坏档大声报 dirty（${msg}）`);
    ok(m.axes.valence === 0.55, 'NaN 轴回退初值（不是悄悄夹成 0）');
    /* 8 小时前的钟没被采信：social 若按坏钟补漂会涨满到 1 */
    ok(m.axes.social < 1, '坏档不按它的时间戳补漂（否则 social 已涨满）');
    fs.rmSync(tmp, { force: true });
  }

  {
    const m = createMoodEngine();
    ok(m.loadAndDrift(path.join(os.tmpdir(), `wb-nope-${process.pid}.json`)).includes('no save'),
      '档不存在 → 首启口径，用初值');
    const e0 = m.axes.energy;
    const applied = m.applyOffline(-100);
    ok(applied === 0 && m.axes.energy === e0, '离线秒数 ≤0 → 不补漂');
  }

  /* ============================================================
   *  D. 人话档位（promptLine —— 给 LLM 的语气方向）
   * ========================================================== */
  console.log('\n══════ D. 人话档位 ══════\n');

  {
    const m = createMoodEngine();                    // 初值 V.55 S.25 E.7 P.5 全中段
    ok(m.promptLine() === '', '全中段 → 空串（不注入，零侵入）');
    /* 阈值常量与 PetMood 对齐（同值才能交叉核对两个实现的行为口径） */
    ok(typeof VAL_HAPPY === 'number' && VAL_HAPPY === 0.70, 'VAL_HAPPY=0.70（PetMood 同值）');
    ok(VAL_SERIOUS === 0.28 && ENERGY_LOW === 0.25, 'VAL_SERIOUS=0.28 / ENERGY_LOW=0.25');
  }

  {
    /* 真驱动到档位：valence 顶满（事件）→ 「心情不错」 */
    const m = createMoodEngine();
    for (let i = 0; i < 12; i++) m.onAssistantEmotion('happy');
    ok(m.axes.valence >= VAL_HAPPY, `valence 顶到 ${m.axes.valence.toFixed(3)} ≥ 0.70`);
    ok(m.promptLine().includes('心情不错'), 'valence 高 → 人话「心情不错」');
  }

  {
    /* 想念档：漂 25 分钟（0.25+0.625=0.875 ≥ 0.8）→「很想他」 */
    const m = createMoodEngine();
    for (let i = 0; i < 150; i++) m.step(10, 12);
    ok(m.axes.social >= 0.8, `social 漂到 ${m.axes.social.toFixed(3)} ≥ 0.8`);
    ok(m.promptLine().includes('很想他'), '想念满 → 人话「很想他了」');
  }

  {
    /* 端着 vs 放软：social ≥0.5 时 pride 才进人话 */
    const m = createMoodEngine();
    for (let i = 0; i < 90; i++) m.step(10, 12);     // social≈0.625
    ok(m.axes.social >= 0.5, `social 到「有点想他」档（${m.axes.social.toFixed(3)}）`);
    ok(m.promptLine().includes('有点想他'), '想念半档 → 人话「有点想他」');
    ok(!m.promptLine().includes('端着') && !m.promptLine().includes('黏'),
      'pride 中段（0.5）→ 不提端着也不提黏');
  }

  /* ============================================================
   *  E. mixEmoMood（渲染层纯函数，真 import params.js）
   * ========================================================== */
  console.log('\n══════ E. mixEmoMood ══════\n');

  const tmp = path.join(os.tmpdir(), `wb-params-mood-${process.pid}`);
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
  const { EMOTION, EMO_RANGE, mixEmoMood, MOOD_BIAS_DIRS } = M;

  {
    /* 方向键必须是当前档案真实情绪（缺键 = 静默少一半偏置） */
    ok(MOOD_BIAS_DIRS.every((d) => !!EMOTION[d]),
      `方向键 ${MOOD_BIAS_DIRS.join('/')} 都在 EMOTION 表里`);
  }

  {
    /* 零侵入：权重全 0（含 null / undefined）→ 逐字段逐位一致 */
    const calm = { ...EMOTION.calm };
    const eff = { ...EMOTION.calm };
    mixEmoMood(eff, { happy: 0, serious: 0, sleepy: 0 });
    ok(Object.keys(eff).every((k) => eff[k] === calm[k]), '权重全 0 → 逐字段不动');
    mixEmoMood(eff, null);
    mixEmoMood(eff, undefined);
    ok(Object.keys(eff).every((k) => eff[k] === calm[k]), 'null/undefined 快照 → 逐字段不动');
  }

  {
    /* 凸组合口径：calm 基线上 w=1 的 happy 偏置 == happy 姿态本身 */
    const eff = { ...EMOTION.calm };
    mixEmoMood(eff, { happy: 1, serious: 0, sleepy: 0 });
    const want = EMOTION.happy;
    ok(Object.keys(eff).every((k) => !(k in want) || near(eff[k], want[k], 1e-6)),
      'calm + w(happy)=1 == happy 姿态（凸组合口径对）');
  }

  {
    /* 夹界：w=1 叠在 serious 上（happy+serious 对冲字段）不许出 EMO_RANGE */
    const eff = { ...EMOTION.serious };
    mixEmoMood(eff, { happy: 1, serious: 1, sleepy: 1 });
    const out = Object.keys(eff).every((k) => {
      const r = EMO_RANGE[k];
      if (!r) return true;
      return eff[k] >= r[0] - 1e-9 && eff[k] <= r[1] + 1e-9;
    });
    ok(out, '三方向满权重叠加 → 全字段仍夹在 EMO_RANGE 内（不出鬼脸）');
  }

  /* ============================================================
   *  F. 接线（源码断言）
   * ========================================================== */
  console.log('\n══════ F. 接线 ══════\n');

  {
    ok(/const \{ createMoodEngine \} = require\('\.\/mood'\)/.test(MAIN), 'main.js 引了 mood 模块');
    ok(/moodEngine\.loadAndDrift\(moodFile\(\)\)/.test(MAIN), '启动时读档（含离线补漂+重聚）');
    ok(/moodTimer = setTimeout\(moodTick, 10 \* 1000\)/.test(MAIN), 'tick 自调度（setTimeout 链，不用 setInterval）');
    ok(/moodEngine\.save\(moodFile\(\)\)/.test(MAIN) && /stopMoodTimer\(\);/.test(MAIN)
      && /will-quit/.test(MAIN), '退出时停表 + 落盘（下次启动按时间戳补漂）');

    /* prompt 注入：mood 在最外层（最贴人设），且空行不塞空 system */
    ok(/function injectMoodContext\(/.test(MAIN), 'injectMoodContext 定义存在');
    const nested = MAIN.match(/injectMoodContext\(\s*injectMediaContext\(/);
    ok(!!nested, 'chatStream：心境套在媒体外层 → [人设, 心境, 媒体, 复读, …历史]');
    ok(/if \(!line\) return arr;/.test(MAIN.slice(MAIN.indexOf('function injectMoodContext'), MAIN.indexOf('function injectVarietyHint'))),
      '心境空行 → 不注入（中段零侵入）');
    ok(/moodLine\(\)/.test(MAIN.slice(MAIN.indexOf('function chatStream'), MAIN.indexOf('function registerIpc'))),
      'chatStream 只通过 moodLine() 取人话');

    /* 事件挂点 */
    ok(/moodEngine\.onAssistantEmotion\(e\)/.test(MAIN.slice(MAIN.indexOf('function emitChatEmotion'), MAIN.indexOf('function emitChatThink'))),
      'emitChatEmotion（唯一出口）里挂了情绪回灌');
    ok(/moodEngine\.onUserChat\(\)/.test(MAIN.slice(MAIN.indexOf("ipcMain.handle('chat:send'"), MAIN.indexOf("ipcMain.handle('config:get'"))),
      'chat:send 里挂了 onUserChat');
    ok(/ipcMain\.on\('mood:event'/.test(MAIN), 'mood:event 通道（点击/摸头上报）');
    ok(/moodDragging = true;[\s\S]{0,80}moodEngine\.onDragBegin\(\)/.test(MAIN), 'drag-move 边沿 → onDragBegin');
    ok(/moodDragging = false;[\s\S]{0,80}moodEngine\.onDragEnd\(\)/.test(MAIN), 'drag-end → onDragEnd');

    /* 托盘 + 配置 */
    ok(/flag\('appearance', 'mood', '[^']+'\)/.test(MAIN), '托盘外观组有「心境」勾选');
    ok(/mood: true/.test(CFG), 'config.js 默认开（不占资源不打扰，同 emotionDecay 一档）');

    /* preload */
    ok(PRELOAD.includes("'mood:snapshot'"), "preload 白名单加了 'mood:snapshot'");
    ok(/moodEvent: \(type\) => ipcRenderer\.send\('mood:event', \{ type \}\)/.test(PRELOAD),
      'preload 暴露 moodEvent(type)');

    /* pet.js 顺序：decay 之后、插值之前 */
    const loop = PET.slice(PET.indexOf('app.ticker.add'), PET.indexOf('emoSteadyMs = emotionDeviation'));
    const iDecay = loop.indexOf('mixEmoDecay(emoEff');
    const iMood = loop.indexOf('mixEmoMood(emoEff');
    const iLerp = loop.indexOf('for (const key in emoEff)');
    ok(iDecay >= 0 && iMood > iDecay && iLerp > iMood,
      '主循环顺序：mixEmoDecay → mixEmoMood → 插值（衰减先收，心境再叠）');
    ok(/if \(cfg\?\.appearance\?\.mood !== false\) \{\s*\n\s*mixEmoMood\(emoEff, moodSnap\?\.bias\);/.test(PET),
      '开关读法 !== false（默认开，老配置没有该键）');
    ok(/window\.pet\?\.on\?\.\('mood:snapshot'/.test(PET), '渲染层订阅了快照');
    ok(/moodEvent\?\.\('patStart'\)/.test(PET) && /moodEvent\?\.\('patEnd'\)/.test(PET)
      && /moodEvent\?\.\('click'\)/.test(PET), '渲染层上报 click/patStart/patEnd');
    ok(/moodEvent\?\('patEnd'\);[\s\S]{0,120}patAbort/.test(PET) === false,
      'patEnd 只在真摸到（拖走/挣脱分支不计）');

    /* diag */
    ok(read('renderer/diag.js').includes("mood-axes"), '?snap=mood 探针输出四轴快照');
  }

  /* ============================================================
   *  G. 单一实现（别让速率表出现第二份）
   * ========================================================== */
  console.log('\n══════ G. 单一实现 ══════\n');

  {
    const files = ['main/main.js', 'renderer/pet.js', 'renderer/diag.js', 'renderer/params.js'];
    const dup = files.filter((f) => /hour >= 22 \|\| hour < 6/.test(read(f)));
    ok(dup.length === 0, `nightFactor 只在 mood.js 定义（其余文件命中：${dup.join(',') || '无'}）`);
    /* 离线补漂与实时 tick 共用一个 step：mood.js 里只有一个 step 函数、
     * applyOffline 内没有第二份速率算式 */
    const MOOD = read('main/mood.js');
    ok((MOOD.match(/function step\(/g) || []).length === 1, '漂移 step 只有一份实现');
    ok(/step\(stepSec, hour\)/.test(MOOD), 'applyOffline 复用同一个 step（不是抄第二份公式）');
    ok(MOOD.includes('socialRise: 0.025') && MOOD.includes('energyDrift: -0.0056'),
      '速率常量还在 mood.js 的 RATE 表里（没被抄散）');
  }

  console.log(`\n${fails === 0 ? '✅ verify-mood 全绿' : `❌ ${fails} 项失败`}\n`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => {
  console.error('verify-mood 崩了:', e);
  process.exit(1);
});
