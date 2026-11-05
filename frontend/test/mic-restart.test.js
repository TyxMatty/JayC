import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micNeedsRestart } from '../src/core/native-mic.js';

const usb = { id: 'usb', name: 'USB mic', isDefault: false };
const laptop = { id: 'laptop', name: 'Laptop mic', isDefault: true };

test('a failed mic is reopened as soon as Windows has one', () => {
  assert.equal(micNeedsRestart({ failed: true, preferredId: 'usb', current: 'USB mic', mics: [] }), false, 'nothing to open yet');
  assert.equal(micNeedsRestart({ failed: true, preferredId: 'usb', current: 'USB mic', mics: [usb, laptop] }), true, 'plugged back in');
  assert.equal(micNeedsRestart({ failed: true, preferredId: 'usb', current: 'USB mic', mics: [laptop] }), true, 'falls back to the default');
});

test('a working mic switches back to the chosen one, or follows the Windows default', () => {
  assert.equal(micNeedsRestart({ failed: false, preferredId: 'usb', current: 'Laptop mic', mics: [laptop] }), false, 'chosen one still missing');
  assert.equal(micNeedsRestart({ failed: false, preferredId: 'usb', current: 'Laptop mic', mics: [usb, laptop] }), true, 'chosen one is back');
  assert.equal(micNeedsRestart({ failed: false, preferredId: 'usb', current: 'USB mic', mics: [usb, laptop] }), false, 'already on it');
  assert.equal(micNeedsRestart({ failed: false, preferredId: null, current: 'USB mic', mics: [usb, laptop] }), true, 'Windows default changed');
  assert.equal(micNeedsRestart({ failed: false, preferredId: null, current: 'Laptop mic', mics: [usb, laptop] }), false);
});
