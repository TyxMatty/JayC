import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeakingDetector } from '../src/core/speaking.js';

test('speaking turns on above the threshold and holds briefly after', () => {
  const d = createSpeakingDetector({ thresholdDb: -50, holdMs: 400 });
  assert.equal(d.update('ana', -70, 0), false, 'quiet room');
  assert.equal(d.update('ana', -30, 100), true, 'talking');
  assert.equal(d.update('ana', -70, 400), true, 'pause between words');
  assert.equal(d.update('ana', -70, 501), false, 'stopped');
  assert.equal(d.update('ana', -Infinity, 600), false, 'no audio at all');
  assert.equal(d.update('beto', -40, 600), true, 'per person');
  d.forget('beto');
  assert.equal(d.update('beto', -70, 650), false);
});
