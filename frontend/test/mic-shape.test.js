import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeMic, createShapeState, levelDb } from '../src/core/mic-shape.js';

const chunk = (amplitude) => Float32Array.from({ length: 960 }, (_, i) => amplitude * Math.sin(i / 5));
const peak = (s) => Math.max(...s.map(Math.abs));

test('gain scales the level (2x = +6 dB) and clips at full scale', () => {
  const state = createShapeState();
  const quiet = chunk(0.1);
  const before = levelDb(quiet);
  const level = shapeMic(quiet, state, { gain: 2, gateDb: null });
  assert.ok(Math.abs(level - before - 6.02) < 0.01, `${level - before}`);
  const loud = chunk(0.9);
  shapeMic(loud, state, { gain: 3, gateDb: null });
  assert.ok(peak(loud) <= 1);
});

test('the gate passes the voice, holds briefly, then closes with a ramp', () => {
  const state = createShapeState();
  const options = { gain: 1, gateDb: -30 };
  const voice = chunk(0.5); // about -9 dBFS
  shapeMic(voice, state, options);
  assert.ok(peak(voice) > 0.45, 'voice passes');

  // Background noise under the threshold: still open during the hold (~300 ms)...
  for (let i = 0; i < 15; i++) {
    const noise = chunk(0.005);
    shapeMic(noise, state, options);
    assert.ok(peak(noise) > 0.004, `hold chunk ${i}`);
  }
  // ...then one ramp-down chunk and silence after it.
  const ramp = chunk(0.005);
  shapeMic(ramp, state, options);
  assert.equal(state.open, false);
  assert.ok(Math.abs(ramp[0]) > 0 || Math.abs(ramp[1]) > 0, 'starts from the previous level');
  assert.equal(Math.abs(ramp[959]), 0);
  const closed = chunk(0.005);
  shapeMic(closed, state, options);
  assert.equal(peak(closed), 0);

  // Speaking again reopens at once.
  const again = chunk(0.5);
  shapeMic(again, state, options);
  assert.equal(state.open, true);
  assert.ok(peak(again) > 0.4);
});
