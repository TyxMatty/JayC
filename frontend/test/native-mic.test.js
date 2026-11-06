import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeChunk } from '../src/core/native-mic.js';
import { createShapeState } from '../src/core/mic-shape.js';

const shape = { gain: 2, gateDb: -20 };

test("Jay-A's audio goes out as Jay-A sent it, only measured", () => {
  const samples = new Float32Array(960).fill(0.1);
  const { level, open } = shapeChunk(samples, { fromJayA: true, state: createShapeState(), shape });
  assert.equal(samples[500], Math.fround(0.1), 'no gain of our own on top of Jay-A');
  assert.equal(Math.round(level), -20);
  assert.equal(open, true);
  // Jay-A's gate closed: silence counts as not sent.
  assert.equal(shapeChunk(new Float32Array(960), { fromJayA: true, state: createShapeState(), shape }).open, false);
});

test("the reserve (Jay-C's own audio) gets Jay-C's volume and gate", () => {
  const samples = new Float32Array(960).fill(0.1);
  const { level, open } = shapeChunk(samples, { fromJayA: false, state: createShapeState(), shape });
  assert.equal(samples[959], Math.fround(0.2), 'gain 2');
  assert.equal(Math.round(level), -14);
  assert.equal(open, true);
});

test('a notice only when the Jay-A link really changes', async () => {
  const { jayANotice } = await import('../src/core/native-mic.js');
  assert.equal(jayANotice(undefined, 'searching'), null, 'not the first search');
  assert.equal(jayANotice('searching', 'jay-a'), null, 'Jay-A taking over at the start is expected');
  assert.equal(jayANotice('jay-a', 'fallback'), "Jay-A stopped. Using Jay-C's filter.");
  assert.equal(jayANotice('fallback', 'fallback'), null, 'once');
  assert.equal(jayANotice('fallback', 'jay-a'), 'Jay-A is back.');
  assert.equal(jayANotice('searching', 'incompatible'), 'Update Jay-A: it speaks another version of the link.');
  assert.equal(jayANotice('incompatible', 'incompatible'), null, 'once');
});

test('notices skip brief stalls: a fallback is announced after 2 s, and only then its end', async () => {
  const { jayANotices } = await import('../src/core/native-mic.js');
  // Fake timers: run() fires everything pending.
  let pending = new Map();
  let id = 0;
  const timers = { setTimeout: (f) => (pending.set(++id, f), id), clearTimeout: (i) => pending.delete(i) };
  const run = () => { const due = [...pending.values()]; pending = new Map(); due.forEach((f) => f()); };
  const said = [];
  const notify = jayANotices((m) => said.push(m), { timers });

  notify('searching');
  notify('jay-a');
  notify('fallback'); // Jay-A stalls for a moment...
  notify('jay-a'); // ...and is back before 2 s
  run();
  assert.deepEqual(said, [], 'a brief stall says nothing');

  notify('fallback');
  run(); // 2 s later, still on the reserve
  assert.deepEqual(said, ["Jay-A stopped. Using Jay-C's filter."]);
  notify('jay-a');
  assert.deepEqual(said, ["Jay-A stopped. Using Jay-C's filter.", 'Jay-A is back.']);

  notify('fallback');
  notify(null); // switched to Jay-C's filter before the 2 s: nothing pending
  run();
  assert.equal(said.length, 2);
  notify('incompatible');
  assert.equal(said.at(-1), 'Update Jay-A: it speaks another version of the link.');
});
