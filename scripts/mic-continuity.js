// Is the call mic's path continuous? Run inside the dev app with the fake Jay-A sending its tone
// (docs/spikes/11-continuidade-do-mic.md):
//   node scripts/cdp-eval.mjs scripts/mic-continuity.js
// Starts the native mic in Jay-A mode (outside a call) and records the 440 Hz tone at four points:
//   IN  the chunks reaching JS        P1  the worklet's output, in its own AudioContext
//   P2  the track, in another context, through an AudioWorklet
//   P3  the track, in another context, through a ScriptProcessor of 512 (the old meter)
// Any skipped, repeated or zeroed sample breaks the tone's recurrence x[n] = 2cos(w) x[n-1] - x[n-2].
const SECONDS = 60;
const STALL_AT = null; // seconds: block the main thread once, for STALL_MS
const STALL_MS = 300;

const W = (2 * Math.PI * 440) / 48000;
const C = 2 * Math.cos(W);
const residual = (x, n) => x[n] - (C * x[n - 1] - x[n - 2]);

const tapUrl = URL.createObjectURL(
  new Blob(
    [
      `registerProcessor('tap', class extends AudioWorkletProcessor {
        constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
        process(inputs) {
          const ch = inputs[0][0];
          for (let i = 0; i < 128; i++) {
            this.buf[this.n++] = ch ? ch[i] : 0;
            if (this.n === this.buf.length) {
              this.port.postMessage(this.buf, [this.buf.buffer]);
              this.buf = new Float32Array(4096); this.n = 0;
            }
          }
          return true;
        }
      });`,
    ],
    { type: 'text/javascript' },
  ),
);

async function tap(context, node) {
  await context.audioWorklet.addModule(tapUrl);
  const tapNode = new AudioWorkletNode(context, 'tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const parts = [];
  tapNode.port.onmessage = ({ data }) => parts.push(data);
  node.connect(tapNode);
  tapNode.connect(context.destination); // outputs silence; keeps it pulled
  return parts;
}

const concat = (parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((offset, p) => (out.set(p, offset), offset + p.length), 0);
  return out;
};

// Phase of the tone over [from, from + len), in radians against absolute sample numbers.
function phase(x, from, len) {
  let a = 0, b = 0;
  for (let k = from; k < from + len; k++) {
    a += x[k] * Math.sin(W * k);
    b += x[k] * Math.cos(W * k);
  }
  return { phase: Math.atan2(b, a), amp: (2 * Math.hypot(a, b)) / len };
}

function analyze(x) {
  // From the tone on: the first 100 ms that follow the recurrence at the tone's level.
  let start = -1;
  for (let n = 2, run = 0, peak = 0; n < x.length && start < 0; n++) {
    const ok = Math.abs(residual(x, n)) < 1e-3;
    run = ok ? run + 1 : 0;
    peak = ok ? Math.max(peak, Math.abs(x[n])) : 0;
    if (run >= 4800 && peak > 0.25) start = n - run + 1;
  }
  if (start < 0) return { empty: true };
  const end = x.length - 300;
  const events = [];
  for (let n = start, last = -100; n < end; n++) {
    if (Math.abs(residual(x, n)) <= 1e-3) continue;
    if (n - last > 8) events.push(n);
    last = n;
  }
  let zeroRuns = 0, zeroFrames = 0;
  for (let n = start; n < end; n++) {
    if (x[n] !== 0 || x[n + 1] !== 0) continue;
    let m = n;
    while (m < end && x[m] === 0) m++;
    zeroRuns++;
    zeroFrames += m - n;
    n = m;
  }
  // The old meter's test: Goertzel at 440 Hz on 512-sample blocks, ratio < 0.8 = "not a pure tone".
  let blocks = 0, bad = 0;
  for (let b = start; b + 512 <= end; b += 512) {
    let s1 = 0, s2 = 0, e = 0;
    for (let k = b; k < b + 512; k++) {
      [s1, s2] = [x[k] + C * s1 - s2, s1];
      e += x[k] * x[k];
    }
    if (e < 1e-6) continue;
    blocks++;
    if ((2 * (s1 * s1 + s2 * s2 - C * s1 * s2)) / (512 * e) < 0.8) bad++;
  }
  const L = 218; // ~2 periods on each side
  const first = events.slice(0, 10).map((n) => {
    const t = Math.round((n - start) / 48) / 1000;
    if (n - 3 - L < 0 || n + 3 + L >= x.length) return { t };
    const before = phase(x, n - 3 - L, L);
    const after = phase(x, n + 3, L);
    const period = 48000 / 440;
    const jump = ((((after.phase - before.phase) / W + period / 2) % period) + period) % period - period / 2;
    // jump: samples skipped (+) or repeated (-), modulo one period (109.1 samples)
    return { t, jump: Math.round(jump * 10) / 10, ampAfter: Math.round(after.amp * 1000) / 1000 };
  });
  return { seconds: Math.round((end - start) / 4800) / 10, events: events.length, zeroRuns, zeroFrames, goertzelBad: `${bad}/${blocks}`, first };
}

const resources = performance.getEntriesByType('resource').map((e) => e.name);
const url = (name) => resources.find((n) => n.includes(`/src/core/${name}`)) ?? `/src/core/${name}`;
const { startNativeMic } = await import(url('native-mic.js'));
const { PcmTrackSource } = await import(url('screen-audio.js'));

// The other contexts come first: creating one can block the main thread, and the mic with it.
const context2 = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
const context3 = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
await context2.audioWorklet.addModule(tapUrl);

const inParts = [];
const arrivals = [];
let source, p1;
const create = PcmTrackSource.create;
PcmTrackSource.create = async (options) => {
  source = await create.call(PcmTrackSource, options);
  p1 = await tap(source.context, source.node);
  const push = source.push.bind(source);
  source.push = (samples) => {
    arrivals.push(performance.now());
    inParts.push(samples.slice());
    push(samples);
  };
  return source;
};
const statuses = [];
let mic;
try {
  mic = await startNativeMic({ filter: 'jay-a', onStatus: (s) => statuses.push(s.link) });
} finally {
  PcmTrackSource.create = create;
}
const p2 = await tap(context2, context2.createMediaStreamSource(new MediaStream([mic.track])));
const p3 = [];
const processor = context3.createScriptProcessor(512, 1, 1);
processor.onaudioprocess = (e) => p3.push(e.inputBuffer.getChannelData(0).slice());
context3.createMediaStreamSource(new MediaStream([mic.track])).connect(processor);
processor.connect(context3.destination);
await Promise.all([context2.resume(), context3.resume()]);

const queued = [];
const started = performance.now();
let stalled = false;
while (performance.now() - started < SECONDS * 1000) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  queued.push((await source.stats()).queued);
  if (STALL_AT != null && !stalled && performance.now() - started >= STALL_AT * 1000) {
    const t = performance.now();
    while (performance.now() - t < STALL_MS);
    stalled = true;
  }
}
const stats = await source.stats();
mic.stop();
context2.close();
context3.close();

const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]);
const sorted = [...gaps].sort((a, b) => a - b);
const pick = (p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
const ms = (frames) => Math.round(frames / 48);
return {
  statuses,
  worklet: { ...stats, queued: undefined },
  queueMs: { min: ms(Math.min(...queued)), p50: ms([...queued].sort((a, b) => a - b)[queued.length >> 1]), max: ms(Math.max(...queued)), everySecond: queued.filter((_, i) => i % 10 === 0).map(ms) },
  arrivalsMs: { chunks: arrivals.length, p50: pick(0.5), p99: pick(0.99), max: pick(1) },
  stallsOver60Ms: gaps.flatMap((g, i) => (g > 60 ? [{ at: Math.round((arrivals[i] - arrivals[0]) / 100) / 10, ms: Math.round(g) }] : [])),
  IN: analyze(concat(inParts)),
  P1: analyze(concat(p1)),
  P2: analyze(concat(p2)),
  P3: analyze(concat(p3)),
};
