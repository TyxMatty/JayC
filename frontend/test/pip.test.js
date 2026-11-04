import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPipTrack } from '../src/core/pip.js';

const track = (id, { muted = false, readyState = 'live' } = {}) => ({ id, muted, readyState, enabled: true });
const stream = (...tracks) => ({ getVideoTracks: () => tracks });
const person = ({ camera, screen, media = {} }) => ({
  media: { video: Boolean(camera), screen: Boolean(screen), ...media },
  stream: camera ? stream(camera) : stream(),
  screenStream: screen ? stream(screen) : undefined,
});

test('a stream we chose not to watch is skipped', () => {
  const sharer = person({ camera: track('cam-a'), screen: track('screen-a') });
  sharer.watching = false;
  assert.equal(pickPipTrack([sharer])?.id, 'cam-a');
});

test('a shared screen wins over cameras', () => {
  const people = [person({ camera: track('cam-a') }), person({ camera: track('cam-b'), screen: track('screen-b') })];
  assert.equal(pickPipTrack(people)?.id, 'screen-b');
});

test('else the first camera that is on', () => {
  const people = [
    person({ camera: track('cam-off', { muted: true }) }),
    person({ camera: track('cam-ended', { readyState: 'ended' }) }),
    person({ camera: track('cam-paused'), media: { video: false } }),
    person({ camera: track('cam-on') }),
  ];
  assert.equal(pickPipTrack(people)?.id, 'cam-on');
});

test('nothing to show', () => {
  assert.equal(pickPipTrack([]), null);
  assert.equal(pickPipTrack([person({})]), null);
});
