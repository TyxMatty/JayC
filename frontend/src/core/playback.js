// Plays the remote voices and stream sounds through WebAudio, each with its own gain, so a person
// or a stream can be turned up past 100% or muted just for us. The tiles keep their media elements
// muted and playing: Chrome only feeds a remote WebRTC track to WebAudio while it's attached to a
// playing element (see CLAUDE.md), and a muted element is also never blocked by autoplay rules.

import { levelDb } from './mic-shape.js';

export const MAX_VOLUME = 2;

/** @typedef {{ volume: number, muted: boolean }} Level */

/** @param {() => AudioContext} [makeContext] */
export function createMixer(makeContext = () => new AudioContext()) {
  let context = null;
  /** Output device (a deviceId from enumerateDevices; '' = the default). */
  let sinkId = '';
  const applySink = () => context?.setSinkId?.(sinkId).catch((error) => console.warn('[playback] output device', error));
  /** key -> { track, source, gain, analyser } */
  const playing = new Map();
  /** key -> Level; kept when a track goes away (e.g. a stream restarts). */
  const levels = new Map();

  const apply = (key) => {
    const entry = playing.get(key);
    if (!entry) return;
    const { volume, muted } = mixer.get(key);
    entry.gain.gain.value = muted ? 0 : volume;
  };

  const mixer = {
    /**
     * Plays `track` under `key`, replacing what played there before; null stops it.
     * `listenOnly`: measure its level (levelDb) without playing it, e.g. our own mic.
     */
    play(key, track, { listenOnly = false } = {}) {
      if (playing.get(key)?.track === track) return;
      mixer.stop(key);
      if (!track) return;
      if (!context) {
        context = makeContext();
        if (sinkId) applySink();
      }
      context.resume?.().catch(() => {});
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const gain = context.createGain();
      // Measured before the gain: muting someone for us still shows when they speak.
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      if (!listenOnly) source.connect(gain).connect(context.destination);
      playing.set(key, { track, source, gain, analyser });
      apply(key);
    },
    stop(key) {
      const entry = playing.get(key);
      if (!entry) return;
      entry.source.disconnect();
      entry.gain.disconnect();
      playing.delete(key);
    },
    /** The current level of `key`'s sound in dBFS (-Infinity when silent or not playing). */
    levelDb(key) {
      const analyser = playing.get(key)?.analyser;
      if (!analyser) return -Infinity;
      const samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      return levelDb(samples);
    },
    /** @returns {Level} */
    get(key) {
      return levels.get(key) ?? { volume: 1, muted: false };
    },
    /** @param {Partial<Level>} patch */
    set(key, patch) {
      const next = { ...mixer.get(key), ...patch };
      next.volume = Math.min(MAX_VOLUME, Math.max(0, Number(next.volume) || 0));
      levels.set(key, next);
      apply(key);
      return next;
    },
    /** Plays everything on another output device ('' = the default). */
    setSink(id) {
      if (id === sinkId) return;
      sinkId = id ?? '';
      applySink();
    },
    close() {
      for (const key of [...playing.keys()]) mixer.stop(key);
      context?.close().catch(() => {});
      context = null;
    },
  };
  return mixer;
}
