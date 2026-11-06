// Audio that fell far behind. Measured: after a 3 s network freeze the receiver kept 2.5 s of audio
// and drained it at only 0.2 s per second (about 17 s out of sync), while the video dropped its late
// frames and was back at once. When an audio's receive buffer stays this far behind, the call starts
// a fresh consumer for it (core/call.js), which plays from the live point again.

/** Normal is ~30 ms (measured); above this for 2 checks in a row is a backlog, not jitter. */
export const BEHIND_MS = 500;
/** At most one renewal per audio this often, so a very jittery network doesn't blip every second. */
export const RENEW_GAP_MS = 15000;

/** The receive buffer's average delay (ms) between two inbound-rtp stats, or null without new audio. */
export function bufferDelayMs(prev, now) {
  const emitted = now.jitterBufferEmittedCount - prev.jitterBufferEmittedCount;
  return emitted > 0 ? ((now.jitterBufferDelay - prev.jitterBufferDelay) / emitted) * 1000 : null;
}

/**
 * One check of one audio: the next state, and whether to renew its consumer now.
 * @param {{ high: number, renewedAt: number }} state
 * @param {number | null} delayMs from bufferDelayMs
 * @param {number} nowMs
 */
export function catchUp(state, delayMs, nowMs) {
  const high = delayMs != null && delayMs > BEHIND_MS ? state.high + 1 : 0;
  const renew = high >= 2 && nowMs - state.renewedAt >= RENEW_GAP_MS;
  return { state: { high: renew ? 0 : high, renewedAt: renew ? nowMs : state.renewedAt }, renew };
}
