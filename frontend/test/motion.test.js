import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMotion, resolveMotion } from '../src/core/motion.js';

test('animations are on unless turned off', () => {
  assert.equal(resolveMotion('on'), 'full');
  assert.equal(resolveMotion('off'), 'reduced');
  assert.equal(resolveMotion(undefined), 'full', 'default');
  assert.equal(normalizeMotion('system'), 'on', 'the old "follow Windows" choice becomes On');
});
