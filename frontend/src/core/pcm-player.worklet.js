// AudioWorklet: plays interleaved Float32 chunks (mono or stereo) posted from the main thread.
// Small jitter buffer: starts after ~60 ms is queued, drops the oldest audio above ~250 ms
// (keeps latency bounded if the producer runs fast), and re-buffers after an underrun.

const START_SECONDS = 0.06;
const MAX_SECONDS = 0.25;

class PcmPlayer extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.channels = processorOptions?.channels ?? 2;
    /** @type {Float32Array[]} */
    this.queue = [];
    this.offset = 0; // read position (in samples) inside queue[0]
    this.frames = 0; // frames queued and not yet played
    this.playing = false;

    this.port.onmessage = ({ data }) => {
      this.queue.push(data);
      this.frames += data.length / this.channels;
      const max = sampleRate * MAX_SECONDS;
      while (this.frames > max && this.queue.length > 1) {
        const dropped = this.queue.shift();
        this.frames -= (dropped.length - this.offset) / this.channels;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const length = output[0].length;
    if (!this.playing) {
      if (this.frames < sampleRate * START_SECONDS) return true; // outputs stay silent
      this.playing = true;
    }
    for (let i = 0; i < length; i++) {
      const chunk = this.queue[0];
      if (!chunk) {
        for (const channel of output) channel[i] = 0;
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
    if (this.queue.length === 0) this.playing = false; // underrun: wait for a new cushion
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
