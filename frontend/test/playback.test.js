import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMixer, MAX_VOLUME } from '../src/core/playback.js';

globalThis.MediaStream ??= class {
  constructor(tracks) {
    this.tracks = tracks;
  }
};

function fakeContext() {
  const node = () => ({ connected: [], connect(n) { this.connected.push(n); return n; }, disconnect() { this.connected = []; } });
  return {
    destination: { name: 'out' },
    created: 0,
    createMediaStreamSource(stream) { this.created++; return { ...node(), stream }; },
    createGain() { return { ...node(), gain: { value: 1 } }; },
    resume: async () => {},
    close: async () => {},
  };
}

test('per-key volume above 100%, mute, and levels that outlive the track', () => {
  const context = fakeContext();
  let made = 0;
  const mixer = createMixer(() => (made++, context));
  const gainOf = () => context.lastGain;
  const realGain = context.createGain.bind(context);
  context.createGain = () => (context.lastGain = realGain());

  assert.deepEqual(mixer.get('ana:voice'), { volume: 1, muted: false });
  mixer.play('ana:voice', { id: 't1' });
  assert.equal(made, 1);
  assert.equal(gainOf().gain.value, 1);

  mixer.set('ana:voice', { volume: 1.5 });
  assert.equal(gainOf().gain.value, 1.5);
  mixer.set('ana:voice', { muted: true });
  assert.equal(gainOf().gain.value, 0);
  assert.equal(mixer.set('ana:voice', { muted: false, volume: 9 }).volume, MAX_VOLUME);
  assert.equal(mixer.set('ana:voice', { volume: -1 }).volume, 0);

  // Same track again: nothing rebuilt. New track: rebuilt with the saved level, one shared context.
  mixer.set('ana:voice', { volume: 0.5 });
  mixer.play('ana:voice', { id: 't1' }); // a different object = a new track
  assert.equal(context.created, 2);
  assert.equal(gainOf().gain.value, 0.5);
  mixer.play('ana:stream', { id: 's1' });
  assert.equal(made, 1);

  mixer.play('ana:voice', null);
  mixer.set('ana:voice', { volume: 0.8 }); // no track playing: just remembered
  assert.equal(mixer.get('ana:voice').volume, 0.8);
  mixer.close();
});
