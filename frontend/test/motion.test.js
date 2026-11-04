import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMotion } from '../src/core/motion.js';

test('system follows the OS; on/off override it', () => {
  assert.equal(resolveMotion('system', false), 'full');
  assert.equal(resolveMotion('system', true), 'reduced');
  assert.equal(resolveMotion('on', true), 'full');
  assert.equal(resolveMotion('off', false), 'reduced');
  assert.equal(resolveMotion(undefined, true), 'reduced', 'unknown value = system');
});
