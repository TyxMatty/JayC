import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, normalizePosition, moveControl, dropIndex, nearestEdge } from '../src/core/call-bar.js';

test('saved order is cleaned and completed', () => {
  assert.deepEqual(normalizeOrder(['leave', 'mic', 'mic', 'nope']), ['leave', 'mic', 'camera', 'share', 'pip']);
  assert.deepEqual(normalizeOrder(undefined), ['mic', 'camera', 'share', 'pip', 'leave']);
  assert.equal(normalizePosition('left'), 'left');
  assert.equal(normalizePosition('middle'), 'bottom');
});

test('moving a button by keyboard', () => {
  assert.deepEqual(moveControl(undefined, 'leave', -1), ['mic', 'camera', 'share', 'leave', 'pip']);
  assert.deepEqual(moveControl(undefined, 'mic', -1), ['mic', 'camera', 'share', 'pip', 'leave'], 'already first');
  assert.deepEqual(moveControl(undefined, 'mic', 9), ['camera', 'share', 'pip', 'leave', 'mic']);
});

test('drop index and nearest edge', () => {
  assert.equal(dropIndex([100, 160, 220], 50), 0);
  assert.equal(dropIndex([100, 160, 220], 170), 2);
  assert.equal(dropIndex([100, 160, 220], 400), 3);
  const rect = { top: 0, left: 0, right: 1000, bottom: 600 };
  assert.equal(nearestEdge(rect, 500, 590), 'bottom');
  assert.equal(nearestEdge(rect, 20, 300), 'left');
  assert.equal(nearestEdge(rect, 990, 300), 'right');
  assert.equal(nearestEdge(rect, 500, 10), 'top');
});
