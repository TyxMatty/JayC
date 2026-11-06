import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferDelayMs, catchUp, BEHIND_MS, RENEW_GAP_MS } from '../src/core/catch-up.js';

test('the buffer delay over an interval', () => {
  // 48000 samples emitted in a second, each 2.5 s in the buffer: 120000 s of summed delay.
  assert.equal(bufferDelayMs({ jitterBufferDelay: 10, jitterBufferEmittedCount: 1000 }, { jitterBufferDelay: 120010, jitterBufferEmittedCount: 49000 }), 2500);
  assert.equal(bufferDelayMs({ jitterBufferDelay: 10, jitterBufferEmittedCount: 1000 }, { jitterBufferDelay: 10, jitterBufferEmittedCount: 1000 }), null, 'nothing new (paused)');
});

test('renews after two checks far behind, then not again for a while', () => {
  let state = { high: 0, renewedAt: 0 };
  const step = (delay, now) => {
    const r = catchUp(state, delay, now);
    state = r.state;
    return r.renew;
  };
  const t = 100000;
  assert.equal(step(30, t), false, 'normal');
  assert.equal(step(BEHIND_MS + 1, t + 1000), false, 'one high check: could be jitter');
  assert.equal(step(30, t + 2000), false, 'back to normal resets the count');
  assert.equal(step(2500, t + 3000), false);
  assert.equal(step(2300, t + 4000), true, 'second in a row: renew');
  assert.equal(step(2000, t + 5000), false);
  assert.equal(step(2000, t + 6000), false, 'still behind, but just renewed');
  assert.equal(step(2000, t + 4000 + RENEW_GAP_MS), true, 'after the gap it may renew again');
  assert.equal(step(null, t + 40000), false, 'no audio: nothing to judge');
});
