// Who is speaking, for the green ring on the tiles: a level above the threshold turns it on, and it
// stays on for a moment after the voice drops so it doesn't flicker between words.

/** dBFS. Voices after Opus and noise suppression sit well above this; a quiet room well below. */
export const SPEAKING_DB = -50;
const HOLD_MS = 400;

export function createSpeakingDetector({ thresholdDb = SPEAKING_DB, holdMs = HOLD_MS } = {}) {
  /** id -> last time it was above the threshold */
  const lastLoud = new Map();
  return {
    /** @returns {boolean} whether `id` counts as speaking at `now` (ms) given its level `db`. */
    update(id, db, now) {
      if (db >= thresholdDb) lastLoud.set(id, now);
      const last = lastLoud.get(id);
      return last !== undefined && now - last <= holdMs;
    },
    forget(id) {
      lastLoud.delete(id);
    },
  };
}
