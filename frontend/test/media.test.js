import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamBitrate, targetHeight, describeCapture } from '../src/core/media.js';

test('stream bitrate scales with pixels and fps, within bounds', () => {
  const b1080p30 = streamBitrate(1920, 1080, 30);
  const b1080p60 = streamBitrate(1920, 1080, 60);
  assert.ok(b1080p30 > 4_000_000 && b1080p30 < 6_000_000, `1080p30 = ${b1080p30}`);
  assert.ok(b1080p60 > b1080p30 && b1080p60 < 2 * b1080p30, '60 fps costs more, but less than double');
  assert.equal(streamBitrate(320, 180, 5), 200_000); // floor
  assert.equal(streamBitrate(3840, 2160, 60), 12_000_000); // ceiling
});

test('resolution presets map to heights', () => {
  assert.equal(targetHeight('720'), 720);
  assert.equal(targetHeight('source'), null);
  assert.equal(targetHeight('nope'), null);
});

test('describeCapture reads the window handle from Chromium labels', () => {
  const track = (label, displaySurface) => ({ label, getSettings: () => ({ displaySurface }) });
  assert.deepEqual(describeCapture(track('window:1835810:0', 'window')), { mode: 'window', windowHandle: 1835810 });
  assert.deepEqual(describeCapture(track('screen:0:0', 'monitor')), { mode: 'screen', windowHandle: null });
  assert.deepEqual(describeCapture(track('Some title', 'window')), { mode: 'window', windowHandle: null });
});
