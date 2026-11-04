import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamBitrate, targetHeight, describeCapture, openLocalMedia } from '../src/core/media.js';

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

test('openLocalMedia can leave the camera closed', async () => {
  const asked = [];
  const audioTrack = { kind: 'audio' };
  globalThis.navigator ??= {};
  const saved = navigator.mediaDevices;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async (c) => (asked.push(c), { getAudioTracks: () => (c.audio ? [audioTrack] : []), getVideoTracks: () => [] }) },
  });
  try {
    const media = await openLocalMedia({ audio: true, video: false });
    assert.equal(media.audio, audioTrack);
    assert.equal(media.video, null);
    assert.deepEqual(media.errors, {});
    assert.equal(asked[0].video, false);
    // Native mic and no camera: nothing to open at all.
    assert.deepEqual(await openLocalMedia({ audio: false, video: false }), { audio: null, video: null, errors: {} });
    assert.equal(asked.length, 1);
  } finally {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: saved });
  }
});
