// AudioWorklet: plays interleaved Float32 chunks (mono or stereo) posted from the main thread.
// Small jitter buffer: starts after ~60 ms is queued and re-buffers after an underrun. A stall of
// the main thread arrives afterwards as a burst of chunks: that extra delay is kept as a cushion for
// the next stall, but never above 250 ms nor for good. Playing, it jumps ahead to 60 ms with a short
// crossfade above 250 ms, or by the part of the queue that 10 s never needed
// (docs/spikes/11-continuidade-do-mic.md).
// Posting 'stats' instead of a chunk answers with its counters (frames).

const START_SECONDS = 0.06;
const MAX_SECONDS = 0.25;
const WINDOW_SECONDS = 10; // the queue never went below START + SLACK in this long: trim it
const SLACK_SECONDS = 0.02;
const HARD_SECONDS = 1; // a render thread that stopped: drop the oldest, no crossfade
const FADE = 128; // frames, ~2.7 ms

class PcmPlayer extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.channels = processorOptions?.channels ?? 2;
    /** @type {Float32Array[]} */
    this.queue = [];
    this.offset = 0; // read position (in samples) inside queue[0]
    this.frames = 0; // frames queued and not yet played
    this.playing = false;
    this.started = false;
    this.low = Infinity; // lowest queue in this window, while playing
    this.elapsed = 0; // frames played in this window
    /** @type {{ from: Float32Array, to: Float32Array, i: number } | null} */
    this.fade = null;
    this.stats = { drops: 0, droppedFrames: 0, skips: 0, skippedFrames: 0, underruns: 0, silentFrames: 0 };

    this.port.onmessage = ({ data }) => {
      if (data === 'stats') {
        this.port.postMessage({ ...this.stats, queued: this.frames });
        return;
      }
      this.queue.push(data);
      this.frames += data.length / this.channels;
      // Playing, process() trims the excess with a crossfade; not playing, nothing is heard.
      const max = sampleRate * (this.playing ? HARD_SECONDS : MAX_SECONDS);
      while (this.frames > max && this.queue.length > 1) {
        const dropped = this.queue.shift();
        const frames = (dropped.length - this.offset) / this.channels;
        this.frames -= frames;
        this.offset = 0;
        this.stats.drops++;
        this.stats.droppedFrames += frames;
      }
    };
  }

  /** Removes `frames` frames from the front of the queue; returns them interleaved. */
  take(frames) {
    const out = new Float32Array(frames * this.channels);
    for (let n = 0; n < out.length; ) {
      const chunk = this.queue[0];
      const count = Math.min(out.length - n, chunk.length - this.offset);
      out.set(chunk.subarray(this.offset, this.offset + count), n);
      n += count;
      this.offset += count;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    this.frames -= frames;
    return out;
  }

  /** Jumps `frames` ahead, crossfading from here to there over the next FADE frames. */
  skip(frames) {
    frames = Math.round(frames);
    const from = this.take(FADE);
    this.take(frames - FADE);
    this.fade = { from, to: this.take(FADE), i: 0 };
    this.stats.skips++;
    this.stats.skippedFrames += frames;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const length = output[0].length;
    if (!this.playing) {
      if (this.frames < sampleRate * START_SECONDS) {
        if (this.started) this.stats.silentFrames += length;
        return true; // outputs stay silent
      }
      this.playing = this.started = true;
    }
    if (!this.fade && this.frames > sampleRate * MAX_SECONDS) this.skip(this.frames - sampleRate * START_SECONDS);
    for (let i = 0; i < length; i++) {
      if (this.fade) {
        const { from, to } = this.fade;
        const k = this.fade.i * this.channels;
        const g = (this.fade.i + 0.5) / FADE;
        for (let c = 0; c < output.length; c++) {
          const s = k + Math.min(c, this.channels - 1);
          output[c][i] = from[s] * (1 - g) + to[s] * g;
        }
        if (++this.fade.i === FADE) this.fade = null;
        continue;
      }
      const chunk = this.queue[0];
      if (!chunk) {
        for (const channel of output) channel[i] = 0;
        this.stats.silentFrames++;
        continue;
      }
      for (let c = 0; c < output.length; c++) output[c][i] = chunk[this.offset + Math.min(c, this.channels - 1)];
      this.offset += this.channels;
      this.frames--;
      if (this.offset >= chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    this.low = Math.min(this.low, this.frames);
    this.elapsed += length;
    if (this.elapsed >= sampleRate * WINDOW_SECONDS) {
      if (!this.fade && this.low > sampleRate * (START_SECONDS + SLACK_SECONDS)) this.skip(this.low - sampleRate * START_SECONDS);
      this.low = Infinity;
      this.elapsed = 0;
    }
    if (this.queue.length === 0 && !this.fade) {
      this.playing = false; // underrun: wait for a new cushion
      this.stats.underruns++;
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
