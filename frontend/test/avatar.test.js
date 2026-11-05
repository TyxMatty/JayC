import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cropSquare, MAX_AVATAR_ZOOM } from '../src/core/avatar.js';

test('crops the centered square of any image by default', () => {
  assert.deepEqual(cropSquare(1920, 1080), { sx: 420, sy: 0, size: 1080 });
  assert.deepEqual(cropSquare(600, 800), { sx: 0, sy: 100, size: 600 });
  assert.deepEqual(cropSquare(64, 64), { sx: 0, sy: 0, size: 64 });
});

test('zoom shrinks the square around the chosen center', () => {
  assert.deepEqual(cropSquare(1920, 1080, { zoom: 2, cx: 600, cy: 300 }), { sx: 330, sy: 30, size: 540 });
});

test('the square never leaves the image, and zoom stays between 1 and the max', () => {
  assert.deepEqual(cropSquare(1920, 1080, { zoom: 2, cx: -500, cy: 5000 }), { sx: 0, sy: 540, size: 540 });
  assert.deepEqual(cropSquare(1920, 1080, { zoom: 0.2 }), { sx: 420, sy: 0, size: 1080 });
  assert.equal(cropSquare(800, 800, { zoom: 99 }).size, 800 / MAX_AVATAR_ZOOM);
});
