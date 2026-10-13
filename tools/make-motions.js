'use strict';
/* ============================================================
 *  生成并注册本项目自制的两个动作组：Drag（被拎起来）与 Walk（溜达）。
 *
 *  为什么要有这个文件：
 *    官方 Hiyori 只有 Idle(10) + TapBody(1) 两组动作。代码里「拖着走会挣扎」
 *    只能借用 TapBody（= 被戳一下），「溜达」则完全没有动作 —— 她像张贴纸
 *    一样平移过去。这两个动作补上。
 *
 *  为什么是「生成」而不是手写 motion3.json：
 *    动作文件要求**首尾闭合**（否则循环播放会瞬间回绕，观感是"动作结尾
 *    卡一下"；更糟的是 isFinished() 永远不成立，插件的 idle 自动调度就死了
 *    —— 这两条 pet.js 的 KEEP_LOOP 注释里都记着）。手写几十个关键帧不可能
 *    保证闭合；用参数化函数采样生成，闭合是构造出来的，不是碰运气。
 *
 *  边界（遵守 Live2D Free Material License / Sample Data Terms）：
 *    只**驱动已有参数**，不新增/修改任何贴图、网格、部件造型 ——
 *    角色「设计」分毫未动。素材仍不进仓库（见 README 第三方声明）。
 *
 *  用法：
 *    node tools/make-motions.js            # 生成 + 注册 + 自检
 *    node tools/make-motions.js --restore  # 用 .orig 备份还原 model3.json
 * ========================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODEL_DIR = path.join(ROOT, 'src', 'assets', 'models', 'hiyori');
const MOC = 'Hiyori.model3.json';

/* ────────────────────────────────────────────────────────────
 *  参数取值参考（从官方 11 个动作里逐曲线统计出来的实际范围）
 *
 *  Cubism 对越界值是**静默钳位**的：写出去的值一旦超出模型的 min/max，
 *  不会报错，只会停在边界上 —— 动作看起来就是"卡死了"。
 *  所以下面每个通道的振幅都取自这张表（±安全余量），不凭感觉定。
 *  ParamHairFront/Back/Skirt 等**物理输出**参数刻意一个都不写：
 *  它们每帧都会被物理演算覆盖，写了也是白写 —— 让身体/头部角度去
 *  喂物理（Hiyori.physics3.json 的输入就是这 5 个），头发裙子自然甩起来。
 * ──────────────────────────────────────────────────────────── */
const OBSERVED = {
  ParamAngleX: [-30, 30],        ParamAngleY: [-30, 30],
  ParamAngleZ: [-30, 30],        ParamBodyAngleX: [-10, 10],
  ParamBodyAngleY: [-10, 10],    ParamBodyAngleZ: [-10, 10],
  ParamBreath: [0, 1],           ParamShoulder: [-1, 1],
  ParamArmLA: [-10, 1],          ParamArmRA: [-10, 3],
  ParamArmLB: [-10, 10],         ParamArmRB: [-10, 10],
  ParamHandL: [-1, 1],           ParamHandR: [-1, 1],
  ParamHandLB: [-9, 10],         ParamHandRB: [-9, 10],
  ParamLeg: [0, 1]
};

/* ────────────────────────────────────────────────────────────
 *  曲线合成
 *
 *  每个通道 = { id, target, fn }，fn(t) 定义 [0, D] 上的值。
 *  采样成线性段（30fps 采样足够密，线性插值出来的曲线肉眼是平滑的，
 *  而且不存在"控制点写错导致曲线飞出去"这种手写贝塞尔的经典事故）。
 * ──────────────────────────────────────────────────────────── */
const FPS = 30;

function sampleCurve(fn, duration) {
  const n = Math.round(duration * FPS);
  const keys = [];
  for (let i = 0; i <= n; i++) keys.push([i / FPS, fn(i / FPS)]);
  return keys;
}

function toSegments(keys) {
  // 首点 + 之后每个线性段 3 个数（type 0 = Linear）
  const seg = [keys[0][0], keys[0][1]];
  for (let i = 1; i < keys.length; i++) seg.push(0, keys[i][0], keys[i][1]);
  return seg;
}

/* 一条动作的描述：{ duration, channels: [{ id, target, fn }] } */
function buildMotion(def) {
  const D = def.duration;
  const curves = def.channels.map((c) => {
    const keys = sampleCurve(c.fn, D);
    // 🔴 首尾必须闭合，这是 Loop:true 的前提（差一点都不行）
    const a = keys[0][1];
    const b = keys[keys.length - 1][1];
    if (Math.abs(a - b) > 1e-9) {
      throw new Error(`曲线 ${c.id} 首尾不闭合（${a} vs ${b}）——循环会回绕`);
    }
    return { Target: c.target, Id: c.id, Segments: toSegments(keys) };
  });

  const segments = curves.reduce((s, c) => s + (c.Segments.length - 2) / 3, 0);
  const points = curves.length + segments;   // 线性段：每段 1 个点，每条曲线 1 个首点

  return {
    Version: 3,
    Meta: {
      Duration: D,
      Fps: FPS,
      Loop: true,
      AreBeziersRestricted: false,
      CurveCount: curves.length,
      TotalSegmentCount: segments,
      TotalPointCount: points,
      UserDataCount: 0,
      TotalUserDataSize: 0
    },
    Curves: curves
  };
}

/* 常数通道（部件不透明度那类） */
function constant(id, target, v) {
  return { id, target, fn: () => v };
}

/* 正弦通道：幅值 amp、周期 period 秒、相位 phase、中心 center。 */
function sine(id, target, { center = 0, amp, period, phase = 0 }) {
  const w = (2 * Math.PI) / period;
  return { id, target, fn: (t) => center + amp * Math.sin(w * t + phase) };
}

/* ────────────────────────────────────────────────────────────
 *  Drag —— 「被拎起来了」
 *
 *  观感目标：整个身体悬空、左右晃、四肢乱扑腾、呼吸变急。
 *  手臂用 **B 组**（PartArmB = 手臂举起的绘制，官方 m06/m08 用的那套），
 *  摆动频率 0.5~0.8s 一拍 —— 挣扎是快的，跟 Walk 的慢摆臂区分开。
 * ──────────────────────────────────────────────────────────── */
const DRAG = {
  name: 'Drag',
  file: 'motions/pet_drag.motion3.json',
  duration: 2.4,
  fadeIn: 0.12,     // 被抓住要**立刻**有反应，0.5s 的默认淡入太钝
  fadeOut: 0.3,
  channels: [
    constant('PartArmA', 'PartOpacity', 0),
    constant('PartArmB', 'PartOpacity', 1),
    // B 组手臂参数（A 组归零，别留上一条动作的残值 —— 官方 m08 也这么做）
    sine('ParamArmLB', 'Parameter', { center: -1, amp: 5.5, period: 0.8, phase: 0.4 }),
    sine('ParamArmRB', 'Parameter', { center: 1, amp: 5, period: 0.8, phase: 2.2 }),
    // ⚠️ 周期必须整除 duration（2.4s），否则首尾不闭合、循环会回绕 ——
    //    下面的闭合断言会拦（0.5s 那版就是被它拦下来的）
    sine('ParamHandLB', 'Parameter', { center: 2, amp: 6, period: 0.6 }),
    sine('ParamHandRB', 'Parameter', { center: 1, amp: 6, period: 0.6, phase: 2.0 }),
    constant('ParamArmLA', 'Parameter', 0),
    constant('ParamArmRA', 'Parameter', 0),
    constant('ParamHandL', 'Parameter', 0),
    constant('ParamHandR', 'Parameter', 0),
    // 身体：左右晃 + 扭 + 上下扑腾
    sine('ParamBodyAngleZ', 'Parameter', { center: 0, amp: 4.5, period: 1.2, phase: 0.6 }),
    sine('ParamBodyAngleX', 'Parameter', { center: 0, amp: 3, period: 2.4, phase: 1.2 }),
    sine('ParamBodyAngleY', 'Parameter', { center: 0, amp: 3.5, period: 0.6 }),
    // 头跟着身体晃（AngleX 表情系统不写，不会打架；Y/Z 留给表情系统）
    sine('ParamAngleX', 'Parameter', { center: 0, amp: 6, period: 1.2 }),
    // 呼吸变急
    sine('ParamBreath', 'Parameter', { center: 0.55, amp: 0.35, period: 0.4 })
  ]
};

/* ────────────────────────────────────────────────────────────
 *  Walk —— 「自己溜达」
 *
 *  观感目标：手臂一前一后慢摆、身体随步伐轻微起伏、头左右张望。
 *  手臂用 **A 组**（PartArmA = 手臂垂下的绘制，官方 7 个 idle 都用它）。
 *  周期 1.6s = 一个完整步态（左右各一步），窗口平移 1100ms 跟它同量级，
 *  看起来就是"她走过去的"。
 * ──────────────────────────────────────────────────────────── */
const WALK = {
  name: 'Walk',
  file: 'motions/pet_walk.motion3.json',
  duration: 1.6,
  fadeIn: 0.3,
  fadeOut: 0.3,
  channels: [
    constant('PartArmA', 'PartOpacity', 1),
    constant('PartArmB', 'PartOpacity', 0),
    // A 组手臂：一前一后摆（B 组归零）
    sine('ParamArmLA', 'Parameter', { center: -7, amp: 2.5, period: 1.6 }),
    sine('ParamArmRA', 'Parameter', { center: -7, amp: 2.5, period: 1.6, phase: Math.PI }),
    sine('ParamHandL', 'Parameter', { center: 0, amp: 0.5, period: 1.6 }),
    sine('ParamHandR', 'Parameter', { center: 0, amp: 0.5, period: 1.6, phase: Math.PI }),
    constant('ParamArmLB', 'Parameter', 0),
    constant('ParamArmRB', 'Parameter', 0),
    constant('ParamHandLB', 'Parameter', 0),
    constant('ParamHandRB', 'Parameter', 0),
    // 身体：重心左右移 + 微倾 + 每步一次的上下起伏（半步一跳）
    sine('ParamBodyAngleX', 'Parameter', { center: 0, amp: 3, period: 1.6 }),
    sine('ParamBodyAngleZ', 'Parameter', { center: 0, amp: 2, period: 1.6, phase: Math.PI / 2 }),
    sine('ParamBodyAngleY', 'Parameter', { center: 0, amp: 2.5, period: 0.8 }),
    // 头左右张望
    sine('ParamAngleX', 'Parameter', { center: 0, amp: 5, period: 1.6, phase: 0.9 }),
    sine('ParamBreath', 'Parameter', { center: 0.5, amp: 0.15, period: 1.6 })
  ]
};

const MOTIONS = [DRAG, WALK];

/* model3.json 里这两个组怎么注册（淡入淡出只是兜底，pet.js 会再钉一遍） */
const GROUP_DEF = {
  Drag: [{ File: DRAG.file, FadeInTime: DRAG.fadeIn, FadeOutTime: DRAG.fadeOut }],
  Walk: [{ File: WALK.file, FadeInTime: WALK.fadeIn, FadeOutTime: WALK.fadeOut }]
};

/* ────────────────────────────────────────────────────────────
 *  自检
 * ──────────────────────────────────────────────────────────── */
function checkValueRanges(motion) {
  const bad = [];
  for (const c of motion.Curves) {
    const range = OBSERVED[c.Id];
    if (!range) continue;                       // PartOpacity / 未收录的参数不查
    for (let i = 2; i < c.Segments.length; i += 3) {
      const v = c.Segments[i];
      if (v < range[0] - 0.01 || v > range[1] + 0.01) {
        bad.push(`${c.Id}=${v} 超出官方动作的实际范围 ${range[0]}..${range[1]}`);
      }
    }
  }
  return bad;
}

function validateAgainstModel(modelJson, motion) {
  const problems = [];
  const cdi = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'Hiyori.cdi3.json'), 'utf8'));
  const paramIds = new Set((cdi.Parameters || []).map((p) => p.Id));
  const partIds = new Set((cdi.Parts || []).map((p) => p.Id));

  for (const c of motion.Curves) {
    if (c.Target === 'Parameter' && !paramIds.has(c.Id)) {
      problems.push(`参数 ${c.Id} 不在这个模型里（写了也是无效曲线）`);
    }
    if (c.Target === 'PartOpacity' && !partIds.has(c.Id)) {
      problems.push(`部件 ${c.Id} 不在这个模型里`);
    }
  }
  // 注册的组必须能对上生成的文件
  for (const [group, arr] of Object.entries(GROUP_DEF)) {
    for (const d of arr) {
      const p = path.join(MODEL_DIR, d.File);
      if (!fs.existsSync(p)) problems.push(`注册了 ${group} 但文件不存在：${d.File}`);
    }
  }
  return problems;
}

/* ────────────────────────────────────────────────────────────
 *  主流程
 * ──────────────────────────────────────────────────────────── */
const RESTORE = process.argv.includes('--restore');
const modelJsonPath = path.join(MODEL_DIR, MOC);
const origPath = modelJsonPath + '.orig';

if (RESTORE) {
  if (!fs.existsSync(origPath)) {
    console.error(`没有备份可还原：${origPath}`);
    process.exit(1);
  }
  fs.copyFileSync(origPath, modelJsonPath);
  for (const m of MOTIONS) {
    const p = path.join(MODEL_DIR, m.file);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  console.log('已还原 model3.json 并删除生成的动作文件。');
  process.exit(0);
}

if (!fs.existsSync(path.join(MODEL_DIR, MOC))) {
  console.error(`找不到 ${modelJsonPath}`);
  console.error('模型素材不随仓库分发：先从 Releases 下载 models.zip 解压到 src/assets/。');
  process.exit(1);
}

// ---- 1) 生成 + 自检 ----
const built = MOTIONS.map((m) => {
  const json = buildMotion(m);
  const bad = checkValueRanges(json);
  if (bad.length) {
    console.error(`\n${m.name} 有通道越界（Cubism 会静默钳位，动作会卡死在边界）：`);
    for (const b of bad) console.error('  ' + b);
    process.exit(1);
  }
  return { def: m, json };
});

// ---- 2) 写动作文件 ----
for (const { def, json } of built) {
  const p = path.join(MODEL_DIR, def.file);
  fs.writeFileSync(p, JSON.stringify(json, null, '\t') + '\n');
  console.log(`写出 ${def.file}  (${def.duration}s, ${json.Curves.length} 条曲线, ${json.Meta.TotalSegmentCount} 段)`);
}

// ---- 3) 注册进 model3.json（幂等；首次改动前备份 .orig）----
if (!fs.existsSync(origPath)) fs.copyFileSync(modelJsonPath, origPath);
const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
modelJson.FileReferences.Motions = modelJson.FileReferences.Motions || {};
for (const [group, arr] of Object.entries(GROUP_DEF)) {
  modelJson.FileReferences.Motions[group] = arr;
}
fs.writeFileSync(modelJsonPath, JSON.stringify(modelJson, null, '\t') + '\n');
console.log(`已注册动作组 ${Object.keys(GROUP_DEF).join(' / ')} → ${MOC}（原文件备份在 ${path.basename(origPath)}）`);

// ---- 4) 复检：重新从磁盘读回来验，别信刚写出去的内存对象 ----
const reread = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
const problems = [];
for (const { def } of built) {
  const onDisk = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, def.file), 'utf8'));
  problems.push(...validateAgainstModel(reread, onDisk));
  // 逐条曲线重验闭合与段完整性
  for (const c of onDisk.Curves) {
    const first = c.Segments[1];
    const last = c.Segments[c.Segments.length - 1];
    if (Math.abs(first - last) > 1e-9) problems.push(`${def.name}/${c.Id} 首尾不闭合`);
    if ((c.Segments.length - 2) % 3 !== 0) problems.push(`${def.name}/${c.Id} 段长度不对`);
  }
  const reg = reread.FileReferences.Motions[def.name];
  if (!reg || !reg.length) problems.push(`${def.name} 没注册进 model3.json`);
}
if (problems.length) {
  console.error('\n自检没过：');
  for (const p of problems) console.error('  ❌ ' + p);
  process.exit(1);
}
console.log('\n✅ 自检通过：曲线都在模型里、首尾全部闭合、两个组都已注册。');
console.log('   下一步：实跑看效果（PET_SNAPSHOT=ui），观感不对就回来调振幅/周期。');
