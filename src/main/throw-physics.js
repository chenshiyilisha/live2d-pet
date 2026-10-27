'use strict';

/* ============================================================
 *  甩抛物理（纯函数）
 * ==========================================================
 *
 *  蓝本：docs/open-source-reference.md 14.5 —— 三个开源来源互证
 *  （Vast-Beyond-Space float.js → XT-nya physics.py → dsh-pet physics.ts）。
 *
 *  本文件**零 Electron 依赖**：只算下一帧位置与速度，方便 verify 单测。
 *  主进程 motion.js 负责 setBounds / 取消 / 静默拦截。
 *
 *  单位：逻辑像素 / 秒；dt 以秒计。
 * ========================================================== */

const G = 1700;
const MAX_THROW = 1900;
const EDGE_DAMP = 0.45;
const GROUND_DAMP = 0.42;
const GROUND_FRICTION = 0.72;
const ROLL_FRICTION = 0.985;   // 贴地每秒衰减
const STOP_EPS = 26;
const THROW_MIN = 280;         // 低于此初速不算甩，当普通放下

const CONSTS = Object.freeze({
  G, MAX_THROW, EDGE_DAMP, GROUND_DAMP, GROUND_FRICTION,
  ROLL_FRICTION, STOP_EPS, THROW_MIN
});

/* 把速度钳到上限（各轴独立，再整体限模）。 */
function clampVel(vx, vy) {
  const sp = Math.hypot(vx, vy);
  if (sp <= MAX_THROW || sp < 1e-6) return { vx, vy };
  const s = MAX_THROW / sp;
  return { vx: vx * s, vy: vy * s };
}

/* 从拖拽采样估初速。samples: [{t,x,y}, ...] 时间升序，至少 2 点。
 * 取末尾最多 80ms 窗口的平均速度，避免最后一帧抖动。 */
function estimateVelocity(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { vx: 0, vy: 0, speed: 0 };
  }
  const last = samples[samples.length - 1];
  const t1 = last.t;
  let i0 = samples.length - 2;
  while (i0 > 0 && t1 - samples[i0].t < 80) i0--;
  const a = samples[i0];
  const dt = (t1 - a.t) / 1000;
  if (dt < 0.008) return { vx: 0, vy: 0, speed: 0 };
  const raw = clampVel((last.x - a.x) / dt, (last.y - a.y) / dt);
  const speed = Math.hypot(raw.vx, raw.vy);
  return { ...raw, speed };
}

function shouldThrow(speed, enabled) {
  return enabled !== false && speed >= THROW_MIN;
}

/**
 * 积分一帧。
 * @param {object} s  { x, y, vx, vy, w, h }
 * @param {object} wa workArea { x, y, width, height }
 * @param {number} dt 秒
 * @param {object} [opt]  { bounce: true }
 * @returns {{ x, y, vx, vy, bounced, landed, stopped, squash }}
 *   squash ∈ [0,1]：落地瞬间给渲染层做 Q 弹挤压的强度
 */
function step(s, wa, dt, opt = {}) {
  const bounce = opt.bounce !== false;
  let { x, y, vx, vy, w, h } = s;
  const dtClamped = Math.max(0, Math.min(0.05, Number(dt) || 0));

  vy += G * dtClamped;
  x += vx * dtClamped;
  y += vy * dtClamped;

  let bounced = false;
  let landed = false;
  let squash = 0;

  const left = wa.x;
  const top = wa.y;
  const right = wa.x + wa.width - w;
  const bottom = wa.y + wa.height - h;

  if (x < left) {
    x = left;
    vx = -vx * EDGE_DAMP;
    bounced = true;
  } else if (x > right) {
    x = right;
    vx = -vx * EDGE_DAMP;
    bounced = true;
  }

  if (y < top) {
    y = top;
    vy = -vy * EDGE_DAMP;
    bounced = true;
  } else if (y > bottom) {
    y = bottom;
    landed = true;
    if (bounce && Math.abs(vy) > STOP_EPS) {
      squash = Math.min(1, Math.abs(vy) / 900);
      vy = -vy * GROUND_DAMP;
      vx *= GROUND_FRICTION;
    } else {
      squash = Math.min(1, Math.abs(vy) / 600);
      vy = 0;
      vx *= GROUND_FRICTION;
      /* 贴地滚动摩擦（按秒指数衰减） */
      const roll = Math.pow(ROLL_FRICTION, dtClamped);
      vx *= roll;
    }
  }

  const stopped = Math.hypot(vx, vy) < STOP_EPS && y >= bottom - 0.5;

  return {
    x: Math.round(x),
    y: Math.round(y),
    vx: stopped ? 0 : vx,
    vy: stopped ? 0 : vy,
    bounced,
    landed,
    stopped,
    squash: stopped ? squash : (landed ? squash : 0)
  };
}

module.exports = {
  CONSTS,
  clampVel,
  estimateVelocity,
  shouldThrow,
  step
};
