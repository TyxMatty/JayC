import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerSquare } from '../src/core/avatar.js';

test('crops the centered square of any image', () => {
  assert.deepEqual(centerSquare(1920, 1080), { sx: 420, sy: 0, size: 1080 });
  assert.deepEqual(centerSquare(600, 800), { sx: 0, sy: 100, size: 600 });
  assert.deepEqual(centerSquare(64, 64), { sx: 0, sy: 0, size: 64 });
});
