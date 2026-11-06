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
    createGain() { return { ...node(), gain: { value: 1, setTargetAtTime(target) { this.value = target; } } }; },
    level: 0.1,
    createAnalyser() {
      const ctx = this;
      return { ...node(), fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(ctx.level); } };
    },
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

  // Level for the speaking ring: 0.1 constant = -20 dBFS; a listen-only key never reaches the output.
  assert.ok(Math.abs(mixer.levelDb('ana:voice') + 20) < 0.01);
  assert.equal(mixer.levelDb('nobody'), -Infinity);
  mixer.play('me:mic', { id: 'mine' }, { listenOnly: true });
  assert.ok(Math.abs(mixer.levelDb('me:mic') + 20) < 0.01);
  assert.equal(gainOf().connected.length, 0);

  mixer.play('ana:voice', null);
  mixer.set('ana:voice', { volume: 0.8 }); // no track playing: just remembered
  assert.equal(mixer.get('ana:voice').volume, 0.8);
  mixer.close();
});

test('deafen silences every voice and stream, before or after they start, and comes back', () => {
  const context = fakeContext();
  const gains = [];
  const realGain = context.createGain.bind(context);
  context.createGain = () => (gains.push(realGain()), gains.at(-1));
  const mixer = createMixer(() => context);
  mixer.setDeafened(true); // before anything plays: no context yet
  mixer.play('ana:voice', { id: 't1' });
  const [bus, , voice] = gains; // the second is the alert bus
  assert.equal(bus.connected[0], context.destination, 'the bus goes to the speakers');
  assert.equal(voice.connected[0], bus, 'a voice goes through the bus');
  assert.equal(bus.gain.value, 0);
  mixer.set('ana:voice', { volume: 1.5 });
  assert.equal(voice.gain.value, 1.5, "her own volume isn't touched");
  mixer.setDeafened(false);
  assert.equal(bus.gain.value, 1);
  mixer.setDeafened(true); // and once already playing
  assert.equal(bus.gain.value, 0);
});

test('alert cues go straight to the speakers, so deafen leaves them alone', () => {
  const context = fakeContext();
  const gains = [];
  const realGain = context.createGain.bind(context);
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  context.createGain = () => (gains.push({ ...realGain(), gain: param() }), gains.at(-1));
  const oscillators = [];
  context.currentTime = 0;
  context.createOscillator = () => {
    const osc = { connected: [], connect(n) { this.connected.push(n); return n; }, frequency: { value: 0 }, start() {}, stop() {} };
    oscillators.push(osc);
    return osc;
  };
  const mixer = createMixer(() => context);
  mixer.setDeafened(true);
  mixer.cue('mic-off');
  const [voices, alerts] = gains;
  assert.equal(alerts.connected[0], context.destination);
  assert.equal(oscillators.length, 2, 'two notes');
  for (const osc of oscillators) assert.equal(osc.connected[0].connected[0], alerts, 'note -> envelope -> alert bus');
  assert.equal(voices.gain.value, 0, 'deafened voices');
  assert.ok(alerts.gain.value > 0.1 && alerts.gain.value < 0.2, 'the alert bus sits well below the voices');
});
