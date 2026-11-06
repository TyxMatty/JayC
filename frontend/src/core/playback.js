// Plays the remote voices and stream sounds through WebAudio, each with its own gain, so a person
// or a stream can be turned up past 100% or muted just for us. The tiles keep their media elements
// muted and playing: Chrome only feeds a remote WebRTC track to WebAudio while it's attached to a
// playing element (see CLAUDE.md), and a muted element is also never blocked by autoplay rules.

import { levelDb } from './mic-shape.js';
import { playCue } from './sounds.js';

export const MAX_VOLUME = 2;
/** The alert cues' bus (core/sounds.js): ~-16 dB per note, ~-11 dBFS where two notes overlap. */
const ALERT_GAIN = 0.15;

/** @typedef {{ volume: number, muted: boolean }} Level */

/** @param {() => AudioContext} [makeContext] */
export function createMixer(makeContext = () => new AudioContext()) {
  let context = null;
  /** Every voice and stream goes through this bus: deafen silences it (sounds of our own don't). */
  let voices = null;
  let deafened = false;
  /** Our own alert cues: straight to the speakers, outside the voices bus. */
  let alerts = null;
  /** Output device (a deviceId from enumerateDevices; '' = the default). */
  let sinkId = '';
  const applySink = () => context?.setSinkId?.(sinkId).catch((error) => console.warn('[playback] output device', error));
  /** key -> { track, source, gain, analyser, samples } (samples: the analyser's reused buffer) */
  const playing = new Map();
  /** key -> Level; kept when a track goes away (e.g. a stream restarts). */
  const levels = new Map();

  const apply = (key) => {
    const entry = playing.get(key);
    if (!entry) return;
    const { volume, muted } = mixer.get(key);
    entry.gain.gain.value = muted ? 0 : volume;
  };

  /** The audio context and its buses, made on first use. */
  const ready = () => {
    if (!context) {
      context = makeContext();
      voices = context.createGain();
      voices.gain.value = deafened ? 0 : 1;
      voices.connect(context.destination);
      alerts = context.createGain();
      alerts.gain.value = ALERT_GAIN;
      alerts.connect(context.destination);
      if (sinkId) applySink();
    }
    context.resume?.().catch(() => {});
  };

  const mixer = {
    /** Plays alert cue `name` (core/sounds.js). */
    cue(name) {
      ready();
      playCue(context, alerts, name);
    },
    /**
     * Plays `track` under `key`, replacing what played there before; null stops it.
     * `listenOnly`: measure its level (levelDb) without playing it, e.g. our own mic.
     */
    play(key, track, { listenOnly = false } = {}) {
      if (playing.get(key)?.track === track) return;
      mixer.stop(key);
      if (!track) return;
      ready();
      const source = context.createMediaStreamSource(new MediaStream([track]));
      const gain = context.createGain();
      // Measured before the gain: muting someone for us still shows when they speak.
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      if (!listenOnly) source.connect(gain).connect(voices);
      playing.set(key, { track, source, gain, analyser, samples: new Float32Array(analyser.fftSize) });
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
      const entry = playing.get(key);
      if (!entry) return -Infinity;
      entry.analyser.getFloatTimeDomainData(entry.samples);
      return levelDb(entry.samples);
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
    /** Deafen: nothing received plays (a ~15 ms fade, so it doesn't click). */
    setDeafened(on) {
      deafened = Boolean(on);
      if (!voices) return;
      voices.gain.setTargetAtTime(deafened ? 0 : 1, context.currentTime, 0.015);
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
      voices = null;
      alerts = null;
    },
  };
  return mixer;
}
