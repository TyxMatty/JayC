import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeChunk } from '../src/core/native-mic.js';
import { createShapeState } from '../src/core/mic-shape.js';

const shape = { gain: 2, gateDb: -20 };

test("Jay-A's audio goes out as Jay-A sent it, only measured", () => {
  const samples = new Float32Array(960).fill(0.1);
  const { level, open } = shapeChunk(samples, { fromJayA: true, state: createShapeState(), shape });
  assert.equal(samples[500], Math.fround(0.1), 'no gain of our own on top of Jay-A');
  assert.equal(Math.round(level), -20);
  assert.equal(open, true);
  // Jay-A's gate closed: silence counts as not sent.
  assert.equal(shapeChunk(new Float32Array(960), { fromJayA: true, state: createShapeState(), shape }).open, false);
});

test("the reserve (Jay-C's own audio) gets Jay-C's volume and gate", () => {
  const samples = new Float32Array(960).fill(0.1);
  const { level, open } = shapeChunk(samples, { fromJayA: false, state: createShapeState(), shape });
  assert.equal(samples[959], Math.fround(0.2), 'gain 2');
  assert.equal(Math.round(level), -14);
  assert.equal(open, true);
});
