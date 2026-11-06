import { test } from 'node:test';
import assert from 'node:assert/strict';

// The worklet runs in AudioWorkletGlobalScope; stand in for the bits it uses.
let Player;
globalThis.sampleRate = 48_000;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { sent: [], postMessage: (message) => this.port.sent.push(message) };
  }
};
globalThis.registerProcessor = (_name, processor) => (Player = processor);
await import('../src/core/pcm-player.worklet.js');

const QUANTUM = 128;
const CHUNK = 960; // 20 ms, as the native mic sends

// A mono player fed with a ramp (1, 2, 3, ...), so any skipped, repeated or zeroed sample shows.
function player() {
  const p = new Player({ processorOptions: { channels: 1 } });
  let n = 0;
  let credit = 0;
  const self = {
    push: (chunks = 1) => {
      for (let i = 0; i < chunks; i++) p.port.onmessage({ data: Float32Array.from({ length: CHUNK }, () => ++n) });
    },
    render() {
      const out = new Float32Array(QUANTUM);
      p.process([], [[out]]);
      return out;
    },
    /** Renders `quanta` quanta while a steady producer pushes a chunk every 20 ms. */
    run(quanta) {
      const out = [];
      for (let i = 0; i < quanta; i++) {
        if ((credit += QUANTUM) >= CHUNK) {
          credit -= CHUNK;
          self.push();
        }
        out.push(...self.render());
      }
      return out;
    },
    /** The main thread stalls for `quanta` quanta: the chunks it owed arrive at once afterwards. */
    stall(quanta) {
      let owed = 0;
      for (let i = 0; i < quanta; i++) {
        if ((credit += QUANTUM) >= CHUNK) {
          credit -= CHUNK;
          owed++;
        }
        self.render();
      }
      self.push(owed);
    },
    stats() {
      p.port.onmessage({ data: 'stats' });
      return p.port.sent.at(-1);
    },
  };
  return self;
}

const counters = (stats) => ({ ...stats, queued: undefined });
const none = { drops: 0, droppedFrames: 0, skips: 0, skippedFrames: 0, underruns: 0, silentFrames: 0, queued: undefined };

test('chunks come out in order, sample for sample, once 60 ms is queued', () => {
  const p = player();
  p.push(2);
  assert.deepEqual([...p.render()].slice(0, 2), [0, 0], 'waits for 60 ms');
  p.push();
  const out = [];
  for (let i = 0; i < 15; i++) out.push(...p.render());
  out.forEach((v, i) => assert.equal(v, i + 1));
  assert.deepEqual(p.stats(), { ...none, queued: 3 * CHUNK - 15 * QUANTUM });
});

test('a steady producer is never trimmed, and nothing is lost', () => {
  const p = player();
  p.push(3);
  const out = p.run(375 * 20); // 20 s
  out.forEach((v, i) => assert.equal(v, i + 1));
  assert.deepEqual(counters(p.stats()), none);
});

test('an underrun is counted, with the silence it put in', () => {
  const p = player();
  p.push(3);
  for (let i = 0; i < 23; i++) p.render(); // 2944 frames: the queue runs dry in the last quantum
  assert.equal(p.stats().underruns, 1);
  assert.equal(p.stats().silentFrames, 23 * QUANTUM - 3 * CHUNK);
  p.render(); // waiting for a new cushion
  assert.equal(p.stats().silentFrames, 24 * QUANTUM - 3 * CHUNK);
});

test('re-buffering, a burst keeps its newest 250 ms (nothing was playing)', () => {
  const p = player();
  p.push(13); // e.g. what piled up while the main thread stalled
  assert.deepEqual(p.stats(), { ...none, drops: 1, droppedFrames: CHUNK, queued: 12 * CHUNK });
  assert.equal(p.render()[0], CHUNK + 1);
  assert.equal(p.stats().skips, 0, 'kept as a cushion for now');
});

test('playing, a burst above 250 ms jumps back to 60 ms with a crossfade', () => {
  const p = player();
  p.push(3);
  p.render(); // playing; next sample: 129
  p.push(12); // 14272 frames queued
  const skipped = 14272 - 2880;
  const fade = p.render();
  // A linear crossfade from where it was (129, 130, ...) to 'skipped' frames later.
  for (const i of [0, 63, 127]) {
    const g = (i + 0.5) / QUANTUM;
    assert.ok(Math.abs(fade[i] - (129 + i + skipped * g)) < 0.01, `frame ${i}: ${fade[i]}`);
  }
  assert.equal(p.render()[0], 129 + QUANTUM + skipped, 'then on from there');
  assert.deepEqual(p.stats(), { ...none, skips: 1, skippedFrames: skipped, queued: 2880 - 2 * QUANTUM });
});

test('a delay a burst left behind is trimmed within 20 s, after a 10 s window that never needed it', () => {
  const p = player();
  p.push(3);
  p.render();
  p.push(7); // ~200 ms queued: under the 250 ms cap, so it would stay for good
  p.run(375 * 10);
  assert.equal(p.stats().skips, 0, 'the window with the burst saw the queue low before it');
  p.run(375 * 10 + 2);
  const { skips, skippedFrames, underruns, queued } = p.stats();
  assert.equal(skips, 1);
  assert.equal(underruns, 0);
  assert.ok(skippedFrames > 5000, `skipped ${skippedFrames}`);
  assert.ok(queued <= 2880 + CHUNK, `back to ~60 ms at its lowest; queued ${queued}`);
  p.run(375 * 20);
  assert.equal(p.stats().skips, 1, 'and then left alone');
});

test('a cushion that keeps being needed stays: a 150 ms stall every 8 s never underruns', () => {
  const p = player();
  p.push(3);
  p.render();
  p.push(7); // what a first stall left behind: ~200 ms
  for (let i = 0; i < 6; i++) {
    p.run(375 * 8);
    p.stall(56);
  }
  assert.deepEqual(counters(p.stats()), none);
});
