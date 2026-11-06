import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cueNotes } from '../src/core/sounds.js';

const freqs = (name, random = () => 0.5) => cueNotes(name, random).map((n) => Math.round(n.freq));

test('on and arriving rise, off and leaving fall', () => {
  const rising = (f) => f.every((x, i) => i === 0 || x > f[i - 1]);
  const falling = (f) => f.every((x, i) => i === 0 || x < f[i - 1]);
  for (const name of ['mic-on', 'undeafen', 'join', 'stream']) assert.ok(rising(freqs(name)), name);
  for (const name of ['mic-off', 'deafen', 'leave']) assert.ok(falling(freqs(name)), name);
  assert.ok(freqs('deafen')[0] < freqs('mic-off')[1], 'deafen sits lower than the mic cues');
  assert.deepEqual(cueNotes('nope'), []);
});

test('notes are a step apart, and repeats vary at most 2% in pitch', () => {
  const notes = cueNotes('join', () => 0.5);
  assert.deepEqual(notes.map((n) => n.at), [0, 0.07, 0.14]);
  const low = cueNotes('chat', () => 0)[0].freq;
  const high = cueNotes('chat', () => 1)[0].freq;
  assert.ok(Math.abs(low / 987.77 - 0.98) < 1e-9 && Math.abs(high / 987.77 - 1.02) < 1e-9);
});
