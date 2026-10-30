'use strict';

/* 心境层（mood）—— 四条缓慢漂移的标量，表情偏置与说话语气是它们穿过阈值的副产物。
 *
 * 双蓝本（调研见 docs/open-source-reference.md 12.4 与 3D 版 PetMood.cs）：
 *   · PetMood（ayan-3d，M6-C）：工程纪律 —— [0,1] 轴、每分钟速率、事件入口、
 *     离线补漂与实时**同一个 Step**、NaN 防护计数、坏档不按坏钟补漂。
 *   · jiwen 积温：行为语义 —— 轴间制衡（想念侵蚀端着）、阈值触发替代
 *     概率骰子、getPromptContext 把数值翻译成人话进 prompt。
 *
 * 轴系取舍（为什么不是 PetMood 的四条原样搬）：
 *   valence（心情）/ social（互动渴望）原样；energy（活力）原样；
 *   **drowsy 换成 pride（端着）**——3D 版的 drowsy 消费端是 doze 姿势层
 *   （呼吸幅度/频率调制），2D 版没有那个层，drowsy 在这边只剩一个 sleepy
 *   表情可挂；而 pride（积温最有行为语义的轴）的消费端现成：主动搭话的
 *   话头方向（「想找他说话但拉不下脸」）。轴必须有输入**和**消费端，
 *   没有消费端的轴只是日志数字。
 *
 * ⚠️ 三条边界（从 PetMood 抄来的教训，违反任何一条都会和别的层打架）：
 *   1) 只输出**偏置**（bias 权重 + 人话），绝不直接 setEmotion —— 情绪
 *      标签的归属在 [emo:xxx] / 摸头 / 状态机那里，mood 抢标签会让
 *      「情绪衰减」「情绪安定」两套判据同时变脏。
 *   2) 表情偏置只在渲染层的 mixEmoMood() 里做**凸组合**（向 happy/
 *      serious/sleepy 三张姿态表加权靠），不做加性直写 —— 凸组合夹
 *      回 EMO_RANGE 后不会出鬼脸。
 *   3) 开关关掉（appearance.mood=false）= 零侵入：不注入 prompt、不推
 *      快照、偏置权重全 0 —— 渲染层拿不到快照时的行为与没这功能逐位一致。
 *
 * 单位约定：漂移速率全部是「每分钟」，与两个蓝本对齐，便于交叉核对。
 * ⚠️ 量纲陷阱（PetMood 头注释原话）：参考实现有用 0~100 尺度写「−1/分」的，
 *    直接照抄会快 100 倍。本文件的速率全部按「多久走完全程」重新定：
 *    心情回中 ~17 分钟；想念 40 分钟涨满；活力 3 小时耗尽（夜间×2）；
 *    端着 1 小时回中，被冷落两小时磨平。
 *
 * 纯逻辑、零依赖（不 require electron / fs 之外的东西，fs 也只在
 * loadAndDrift/save 里用）—— debug/verify-mood.js 直接 require 真跑。
 */

const fs = require('fs');

/* ───────────────────────── 漂移速率（每分钟）───────────────────────── */
const RATE = {
  /* 心情朝中位 0.5 回中：乘 |v−0.5|，越偏拉得越狠，时间常数 ≈17 分钟。
   * （PetMood 同款：ValencePull −0.06。） */
  valencePull: -0.06,
  /* 互动渴望只涨，被搭理（点击/摸头/说话）归零。0.025/min ≈ 40 分钟涨满。
   * 夜间再乘夜系数 —— 深夜没人理，想得更凶。 */
  socialRise: 0.025,
  /* 清醒时活力缓慢消耗，−0.0056/min ≈ 3 小时从满格耗到见底；夜间 ×2。 */
  energyDrift: -0.0056,
  /* 端着度朝 0.5 回中（性格回归），时间常数 ≈1.2 小时。 */
  pridePull: -0.0083
};

/* 想念侵蚀端着（积温的 pride erosion）：social 高到这个数还在涨，
 * 端着就守不住了 —— 冷落两小时能把傲娇磨软。 */
const PRIDE_EROSION_AT = 0.8;
const PRIDE_EROSION = -0.01;          // 每分钟

/* ───────────────────────── 事件增量 ───────────────────────── */
const GAIN = {
  clickValence: 0.06,                 // 点一下：心情 +（PetMood ValenceClickGain）
  clickEnergy: -0.004,
  dragEnergy: -0.02,                  // 被拎起来是扰动不是休息（PetMood 同款）
  patValencePerSec: 0.03,             // 摸头：每秒心情 +，单次计入上限见下
  patMaxSec: 1.2,
  softening: -0.01,                   // 被搭理一下，端着放软一丁点
  chatValence: 0.04,                  // 用户主动说话：心情 +
  emoPositive: 0.02,                  // 她自己聊出正向情绪，心情也跟着好
  emoNegative: -0.02,
  emoSleepyEnergy: -0.01
};

/* OCEAN·A（宜人）放大/缩小 softening（P3）。中性 1 = 与没这功能逐位一致。
 * 主进程改性格档时 setPrideSoftMul；verify 可直接拨。 */
let prideSoftMul = 1;
function setPrideSoftMul(m) {
  const n = Number(m);
  prideSoftMul = Number.isFinite(n) && n > 0 ? Math.min(2.5, Math.max(0.4, n)) : 1;
}
function softPride() {
  return GAIN.softening * prideSoftMul;
}

/* P5 Temperament：漂移速率乘子（默认全 1 = 与没气质层一致）。 */
let rateMul = { socialRiseMul: 1, valencePullMul: 1, energyDriftMul: 1, pridePullMul: 1 };
function setRateMul(m) {
  const src = m && typeof m === 'object' ? m : {};
  const clip = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(1.5, Math.max(0.5, n)) : 1;
  };
  rateMul = {
    socialRiseMul: clip(src.socialRiseMul),
    valencePullMul: clip(src.valencePullMul),
    energyDriftMul: clip(src.energyDriftMul),
    pridePullMul: clip(src.pridePullMul)
  };
}
function getRateMul() { return { ...rateMul }; }

/* ───────────────────────── 阈值 ───────────────────────── */
/* 表情偏置的起算线（PetMood 同值）：穿过才算「心情不错/闷/累」，
 * 中段不偏置 —— 否则偏置永远非零，「与没这功能逐位一致」就没法保证了。 */
const VAL_HAPPY = 0.70;
const VAL_SERIOUS = 0.28;
const ENERGY_LOW = 0.25;

/* ───────────────────────── 重聚（离线 ≥20 分钟）─────────────────────────
 * 借自 PetMood / VPet「久别重逢」。离线补漂只是静默的数值搬运，
 * 重聚把它变成一件**发生过的**事：开心一下 + 想念被部分满足 +
 * 8 秒的人话窗口（「他刚回来」刚好来得及进下一句 prompt）。 */
const REUNION_MIN_SEC = 1200;
const REUNION_VALENCE = 0.18;
const REUNION_SOCIAL_RELIEF = 0.35;   // 只回落三成五，不归零（不抹掉「想你了」）
const REUNION_HOLD_SEC = 8;
const OFFLINE_CAP_SEC = 8 * 3600;

/* ───────────────────────── 夜间系数（PetMood 同表）─────────────────────────
 * 22–06 点 = 2.0，06–09 点 = 1.4，其余 1.0。作用在 energy 消耗与
 * social 涨速上（夜里累得快、也孤独得快）。静默时段另有 quiet-hours，
 * 这儿只管轴的快慢，不管「说不说话」。 */
function nightFactor(hour) {
  if (hour >= 22 || hour < 6) return 2.0;
  if (hour < 9) return 1.4;
  return 1.0;
}

/* ───────────────────────── 存档 ───────────────────────── */
const SAVE_VERSION = 1;

function clamp01(v) {
  if (!Number.isFinite(v)) { this._nanSeen++; return 0; }
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/* 存档清洗：与 clamp01 分工（PetMood 同款教训）——运行期快速夹紧顺手计数；
 * 持久化边界发现脏值 = **这份档坏了**，退回初值而不是悄悄夹成 0
 * （悄悄夹 0 会让「活力」开局见底，看着像机制坏了）。 */
function sanitizeAxis(v, fallback, dirty) {
  if (!Number.isFinite(v)) { dirty.v = true; return fallback; }
  if (v < 0) { dirty.v = true; return 0; }
  if (v > 1) { dirty.v = true; return 1; }
  return v;
}

/* ============================================================
 *  工厂：createMoodEngine()
 *  有状态、单实例（主进程一份；verify 里可以随便造）。
 * ========================================================== */
function createMoodEngine() {
  const S = {
    /* 四轴初值（PetMood 同款起点） */
    valence: 0.55,
    social: 0.25,
    energy: 0.70,
    pride: 0.50,
    /* 派生（derive() 的出口，别手改） */
    bias: { happy: 0, serious: 0, sleepy: 0 },
    reunionLeft: 0,
    reunions: 0,
    interactions: 0,
    offlineAppliedSec: 0,
    _nanSeen: 0,
    _epoch: 0,
    _dragging: false,
    _patSince: 0,
    _lastLine: ''
  };

  const cl = clamp01.bind(S);

  /* ───────── 每步漂移。⚠️ 实时 tick 与离线补漂**同走这里**
   *（PetMood 2026-10-14 的教训：离线自己抄一份漂移公式，两份悄悄跑偏，
   *  回放测试拿 A 公式给 B 公式作证）。hour 是「这一步所在的小时数」
   *  （-1 = 现在）—— 补漂时按各步的历史时间传进来，夜系数才会随步变化。 */
  function step(dtSec, hour) {
    if (!(dtSec > 0)) return;            // 拦 NaN/0/负（PetMood：NaN<=0 是 false）
    const min = dtSec / 60;
    const h = hour >= 0 ? hour : new Date().getHours();
    const nf = nightFactor(h);

    S.valence = cl(S.valence + RATE.valencePull * rateMul.valencePullMul * Math.abs(S.valence - 0.5) * min);
    S.social = cl(S.social + RATE.socialRise * rateMul.socialRiseMul * nf * min);
    S.energy = cl(S.energy + RATE.energyDrift * rateMul.energyDriftMul * nf * min);
    let prideStep = RATE.pridePull * rateMul.pridePullMul * Math.abs(S.pride - 0.5) * min;
    if (S.social >= PRIDE_EROSION_AT) prideStep += PRIDE_EROSION * min;
    S.pride = cl(S.pride + prideStep);

    if (S.reunionLeft > 0) S.reunionLeft = Math.max(0, S.reunionLeft - dtSec);
    derive();
  }

  /* ───────── 派生：轴 → 偏置权重。全部连续映射，不是开关 ——
   * 「心情不错」是一个程度；突变会让脸看起来在抽筋（PetMood 原话）。
   * 中段（0.28 < valence < 0.70 且 energy > 0.25）权重全 0。 */
  function derive() {
    S.bias.happy = v2t((S.valence - VAL_HAPPY) / (1 - VAL_HAPPY));
    S.bias.serious = v2t((VAL_SERIOUS - S.valence) / VAL_SERIOUS);
    S.bias.sleepy = v2t((ENERGY_LOW - S.energy) / ENERGY_LOW);
  }
  const v2t = (v) => (v > 0 ? (v > 1 ? 1 : v) : 0);

  /* ───────── 人话翻译（积温 getPromptContext 的口径：模型不需要
   * 知道 valence=0.47，只需要「你有点想他」）。档位刻意少而准 ——
   * 每多一档，prompt 里就多一分「她在念状态栏」的味。
   * 空档返回 ''，调用方据此**不注入**（零侵入）。 */
  function promptLine() {
    const parts = [];
    if (S.reunionLeft > 0) parts.push('他刚回来，你有点惊喜');
    if (S.valence >= VAL_HAPPY) parts.push('你现在心情不错');
    else if (S.valence <= VAL_SERIOUS) parts.push('你有点闷闷的');
    if (S.social >= 0.8) parts.push('你很想他了');
    else if (S.social >= 0.5) parts.push('你有点想他');
    if (S.energy <= ENERGY_LOW) parts.push('你有点累了，提不起劲');
    if (S.social >= 0.5 && S.pride >= 0.7) parts.push('但你还端着，不好意思先开口');
    else if (S.social >= 0.5 && S.pride <= 0.3) parts.push('想黏着他');
    return parts.join('，');
  }

  /* ───────── 外部事件 ───────── */
  function onClick() {
    S.interactions++;
    S.valence = cl(S.valence + GAIN.clickValence);
    S.energy = cl(S.energy + GAIN.clickEnergy);
    S.pride = cl(S.pride + softPride());
    S.social = 0;                        // 互动渴望被满足
    derive();
  }

  /* 拖拽的 begin/end 由主进程的 drag-move / drag-end IPC 边沿判定，
   * 引擎这边只认这两个显式入口。 */
  function onDragBegin() {
    S.interactions++;
    S.energy = cl(S.energy + GAIN.dragEnergy);
    S.pride = cl(S.pride + softPride());
    S.social = 0;
    derive();
  }

  function onDragEnd() {
    S.interactions++;
    S.social = 0;
    derive();
  }

  /* 摸头：起手记时间，松手按「实际摸了多久」结账（上限挡摁着不放刷满）。
   * 摸头期间不逐秒推（渲染层自己有 patAmt 的手感节奏，别双写）。 */
  function onPatStart() { S._patSince = Date.now(); }

  function onPatEnd() {
    const sec = S._patSince ? Math.min((Date.now() - S._patSince) / 1000, GAIN.patMaxSec) : 0;
    S._patSince = 0;
    if (sec <= 0) return;
    S.interactions++;
    S.valence = cl(S.valence + GAIN.patValencePerSec * sec);
    S.pride = cl(S.pride + softPride());
    S.social = 0;
    derive();
  }

  /* 用户主动说话 = 最强的「被搭理」 */
  function onUserChat() {
    S.interactions++;
    S.valence = cl(S.valence + GAIN.chatValence);
    S.pride = cl(S.pride + softPride());
    S.social = 0;
    derive();
  }

  /* 她自己聊出的情绪也回灌一点进轴（正向情绪让心情更好、sleepy 耗活力）。
   * 挂在 emitChatEmotion（唯一出口，规矩 27）—— 本地回复池也走它，天然全覆盖。 */
  function onAssistantEmotion(name) {
    if (name === 'happy' || name === 'smile' || name === 'shy') {
      S.valence = cl(S.valence + GAIN.emoPositive);
    } else if (name === 'serious') {
      S.valence = cl(S.valence + GAIN.emoNegative);
    } else if (name === 'sleepy') {
      S.energy = cl(S.energy + GAIN.emoSleepyEnergy);
    }
    derive();
  }

  /* ───────── 离线补漂 + 重聚。与实时 tick 同一个 step（见上），
   * 60 秒一步、逐步取历史小时 —— 夜系数随步变化才对得起「补了一整晚」。 */
  function applyOffline(seconds) {
    if (!(seconds > 0)) return 0;
    const total = Math.min(seconds, OFFLINE_CAP_SEC);
    const steps = Math.max(1, Math.min(480, Math.ceil(total / 60)));
    const stepSec = total / steps;
    const nowTs = Date.now();
    for (let i = steps - 1; i >= 0; i--) {
      const ts = nowTs - stepSec * (i + 1);
      const hour = new Date(ts).getHours();
      step(stepSec, hour);
    }
    S.offlineAppliedSec += total;
    S._epoch = nowTs;

    if (total >= REUNION_MIN_SEC) {
      S.reunions++;
      S.valence = cl(S.valence + REUNION_VALENCE);
      S.social = cl(S.social * (1 - REUNION_SOCIAL_RELIEF));
      S.reunionLeft = REUNION_HOLD_SEC;
      derive();
    }
    return total;
  }

  /* ───────── 持久化。读档任何失败都不抛（坏档不该让桌宠起不来），
   * 但也不静默 —— 返回一句话进日志。 */
  function loadAndDrift(filePath) {
    S._epoch = Date.now();
    let raw = null;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch { return 'mood: no save, first run'; }
    try {
      const d = JSON.parse(raw);
      const dirty = { v: false };
      S.valence = sanitizeAxis(d.valence, S.valence, dirty);
      S.social = sanitizeAxis(d.social, S.social, dirty);
      S.energy = sanitizeAxis(d.energy, S.energy, dirty);
      S.pride = sanitizeAxis(d.pride, S.pride, dirty);
      S.interactions = Number(d.interactions) || 0;
      S.reunions = Number(d.reunions) || 0;
      const away = Math.floor((Date.now() - (Number(d.t) || 0)) / 1000);
      /* ⚠️ 已经判定损坏的存档，时间戳同样不可信（PetMood S12b 的教训：
       *    拿坏档的钟补漂 8 小时 = 开局就是空壳，恰好是清洗想避免的事）。 */
      const applied = dirty.v ? 0 : (away > 0 ? applyOffline(away) : 0);
      derive();
      return `mood: loaded (away ${away}s, drift ${Math.round(applied)}s`
        + ` → V${S.valence.toFixed(3)} S${S.social.toFixed(3)} E${S.energy.toFixed(3)} P${S.pride.toFixed(3)})`
        + (dirty.v ? ' [dirty save: axes reset, no drift]' : '');
    } catch (e) {
      return `mood: save unreadable (${String(e && e.message || e)}), defaults`;
    }
  }

  function save(filePath) {
    if (!filePath) return;
    try {
      const d = {
        t: Date.now(),
        valence: S.valence, social: S.social, energy: S.energy, pride: S.pride,
        interactions: S.interactions, reunions: S.reunions,
        version: SAVE_VERSION
      };
      const tmp = filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, filePath);
      S._epoch = d.t;
    } catch (e) {
      console.warn('[mood] save failed:', String(e && e.message || e));
    }
  }

  /* 快照（推给渲染层 / 进 proactive 上下文）。line 为空 = 中性，
   * 渲染层照样要 bias（可能非零吗？—— 中段 bias 全 0，线也空，一致）。 */
  function snapshot() {
    derive();
    return {
      valence: S.valence, social: S.social, energy: S.energy, pride: S.pride,
      bias: { ...S.bias },
      line: promptLine(),
      reunion: S.reunionLeft > 0,
      reunions: S.reunions
    };
  }

  derive();
  return {
    step, applyOffline, loadAndDrift, save, snapshot, promptLine,
    onClick, onDragBegin, onDragEnd, onPatStart, onPatEnd,
    onUserChat, onAssistantEmotion,
    /* 测试口（只读语义，别在外头改） */
    get axes() { return { valence: S.valence, social: S.social, energy: S.energy, pride: S.pride }; },
    get nanSeen() { return S._nanSeen; },
    get interactions() { return S.interactions; },
    get reunionLeft() { return S.reunionLeft; }
  };
}

/* 常量也导出 —— verify 拿同一份数值做解析解对照（单一事实源）。 */
module.exports = {
  createMoodEngine, nightFactor, setPrideSoftMul, setRateMul, getRateMul,
  RATE, GAIN, REUNION_MIN_SEC, REUNION_HOLD_SEC, OFFLINE_CAP_SEC,
  VAL_HAPPY, VAL_SERIOUS, ENERGY_LOW, PRIDE_EROSION_AT
};
