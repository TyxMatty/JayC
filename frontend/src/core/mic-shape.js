// Mic volume and sensitivity for the native mic (Windows), applied to each 20 ms chunk after
// WebRTC's processing: a gain, then a gate that only lets the voice through above a threshold
// (like Discord's input sensitivity). The level is measured before the gate, for the meter.

export const MAX_MIC_GAIN = 3;
/** Keep the gate open this many chunks (20 ms each) after the voice drops, so word ends aren't cut. */
const HOLD_CHUNKS = 15;

export const levelDb = (samples) => {
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
};

/** @returns {{ open: boolean, hold: number, factor: number }} */
export const createShapeState = () => ({ open: true, hold: 0, factor: 1 });

/**
 * Shapes `samples` in place. `gateDb` null = gate off (always open).
 * @param {Float32Array} samples
 * @param {{ open: boolean, hold: number, factor: number }} state
 * @param {{ gain: number, gateDb: number | null }} options
 * @returns {number} the chunk's level in dBFS after the gain (before the gate)
 */
export function shapeMic(samples, state, { gain, gateDb }) {
  const g = Math.min(MAX_MIC_GAIN, Math.max(0, gain));
  if (g !== 1) for (let i = 0; i < samples.length; i++) samples[i] *= g;
  const level = levelDb(samples);

  if (gateDb == null || level >= gateDb) {
    state.open = true;
    state.hold = HOLD_CHUNKS;
  } else if (state.hold > 0) {
    state.hold--;
  } else {
    state.open = false;
  }

  // Ramp across the chunk instead of jumping, so opening/closing doesn't click.
  const target = state.open ? 1 : 0;
  const from = state.factor;
  for (let i = 0; i < samples.length; i++) {
    const f = from + ((target - from) * (i + 1)) / samples.length;
    samples[i] = Math.max(-1, Math.min(1, samples[i] * f));
  }
  state.factor = target;
  return level;
}
