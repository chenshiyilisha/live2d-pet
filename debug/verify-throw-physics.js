'use strict';
/* 甩抛物理纯函数回归 —— 不启 Electron。 */
const assert = require('assert');
const path = require('path');
const {
  CONSTS, estimateVelocity, shouldThrow, step, clampVel
} = require(path.join(__dirname, '..', 'src', 'main', 'throw-physics.js'));

assert.strictEqual(CONSTS.G, 1700);
assert.strictEqual(CONSTS.MAX_THROW, 1900);
assert.strictEqual(CONSTS.EDGE_DAMP, 0.45);
assert.strictEqual(CONSTS.GROUND_DAMP, 0.42);
assert.strictEqual(CONSTS.THROW_MIN, 280);

/* 估速：静止 */
{
  const v = estimateVelocity([{ t: 0, x: 0, y: 0 }, { t: 50, x: 0, y: 0 }]);
  assert.ok(v.speed < 1);
  assert.strictEqual(shouldThrow(v.speed, true), false);
}

/* 估速：向右快甩 */
{
  const v = estimateVelocity([
    { t: 0, x: 100, y: 200 },
    { t: 40, x: 140, y: 200 }
  ]);
  assert.ok(v.vx > 500, 'vx=' + v.vx);
  assert.ok(shouldThrow(v.speed, true));
  assert.strictEqual(shouldThrow(v.speed, false), false);
}

/* clampVel 限模 */
{
  const c = clampVel(3000, 0);
  assert.ok(Math.hypot(c.vx, c.vy) <= CONSTS.MAX_THROW + 1e-6);
}

/* 自由落体落地停稳 */
{
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  let s = { x: 100, y: 100, vx: 0, vy: 0, w: 308, h: 342 };
  let stopped = false;
  for (let i = 0; i < 400; i++) {
    const n = step(s, wa, 1 / 60, { bounce: true });
    s = { ...s, x: n.x, y: n.y, vx: n.vx, vy: n.vy };
    if (n.stopped) { stopped = true; break; }
  }
  assert.ok(stopped, '应在几秒内落地停稳');
  assert.ok(s.y >= wa.height - s.h - 1, '应贴地');
}

/* 弹跳关闭时落地立刻刹住竖直速度 */
{
  const wa = { x: 0, y: 0, width: 800, height: 600 };
  /* 已贴地线上方、带向下速度 → 一帧必落地 */
  const s = { x: 10, y: 490, vx: 0, vy: 800, w: 100, h: 100 };
  const n = step(s, wa, 0.05, { bounce: false });
  assert.ok(n.landed, '应判定落地');
  assert.strictEqual(n.vy, 0);
}

console.log('verify-throw-physics: OK');
