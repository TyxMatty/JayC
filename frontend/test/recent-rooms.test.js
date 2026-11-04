import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addRecentRoom, MAX_RECENT_ROOMS } from '../src/core/recent-rooms.js';

test('newest first, no duplicates, capped', () => {
  assert.deepEqual(addRecentRoom(undefined, 'gyro'), ['gyro']);
  assert.deepEqual(addRecentRoom(['a', 'gyro', 'b'], 'gyro'), ['gyro', 'a', 'b']);
  assert.deepEqual(addRecentRoom(['Gyro'], 'gyro'), ['gyro'], 'same room, other case');
  const many = addRecentRoom(['1', '2', '3', '4', '5'], 'new');
  assert.equal(many.length, MAX_RECENT_ROOMS);
  assert.deepEqual(many, ['new', '1', '2', '3', '4']);
  assert.deepEqual(addRecentRoom(['ok', 42, null, ''], 'x'), ['x', 'ok'], 'junk from storage dropped');
});
