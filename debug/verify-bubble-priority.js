'use strict';
const assert = require('assert');
const path = require('path');
const { createArbiter, RANK, rankOf } = require(
  path.join(__dirname, '..', 'src', 'main', 'bubble-priority.js')
);

assert.strictEqual(rankOf('status'), 0);
assert.strictEqual(rankOf('stream'), 1);
assert.strictEqual(rankOf('alert'), 2);
assert.deepStrictEqual(RANK, { status: 0, stream: 1, alert: 2 });

const a = createArbiter();

/* status 可占 */
{
  const g = a.acquire('status');
  assert.ok(g.ok);
  assert.ok(a.allowsAppend(g.token) === false); // status 不是 stream append
  a.release(g.token);
  assert.strictEqual(a.peek(), null);
}

/* stream 期间 status 被拒 */
{
  const s = a.acquire('stream');
  assert.ok(s.ok);
  const st = a.acquire('status');
  assert.strictEqual(st.ok, false);
  assert.ok(a.allowsAppend(s.token));
  a.release(s.token);
}

/* alert 可盖 status / stream */
{
  a.acquire('status');
  const al = a.acquire('alert');
  assert.ok(al.ok);
  assert.strictEqual(a.peek().kind, 'alert');
  /* 旧 stream token 不该再 append */
  assert.strictEqual(a.allowsAppend(999), false);
  a.release(al.token);
}

/* 错 token 不能 release */
{
  const s = a.acquire('stream');
  assert.strictEqual(a.release(s.token + 1), false);
  assert.ok(a.peek());
  assert.ok(a.release(s.token));
  assert.strictEqual(a.peek(), null);
}

a.reset();
console.log('verify-bubble-priority: OK');
