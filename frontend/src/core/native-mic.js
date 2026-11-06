// The call microphone captured natively (Rust: plain WASAPI + WebRTC echo cancellation, noise
// suppression and gain). WebView2's own getUserMedia mic puts some laptops' audio into "call mode",
// muffling every other app (docs/spikes/09-som-abafado.md); a native capture doesn't.
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { PcmTrackSource } from './screen-audio.js';
import { shapeMic, createShapeState, levelDb } from './mic-shape.js';

export const nativeMicSupported = () => systemAudio.isSupported();

/** Microphones Windows has right now: `[{ id, name, isDefault }]`. */
export const listMics = () => systemAudio.listMics();

/** Jay-A mode: tells Jay-A whether we're in a call and muted. Nothing happens in Jay-C's mode. */
export const micCallState = (state) => systemAudio.micCallState(state).catch(() => {});

/** Jay-A mode: asks Jay-A to show its window. */
export const jayAShow = () => systemAudio.jayAShow().catch(() => {});

/**
 * The notice for a change of the Jay-A link (`link` of two states in a row), or null. Only real
 * changes: not the first search, and not "fallback" when Jay-A never played.
 * @param {string | null | undefined} before
 * @param {string} now
 */
export function jayANotice(before, now) {
  if (now === 'fallback' && before === 'jay-a') return "Jay-A stopped. Using Jay-C's filter.";
  if (now === 'jay-a' && before === 'fallback') return 'Jay-A is back.';
  if (now === 'incompatible' && before !== 'incompatible') return 'Update Jay-A: it speaks another version of the link.';
  return null;
}

/**
 * Turns the Jay-A link's states into notices, without noise: a fallback is announced only once it
 * has lasted `delay` ms (Jay-A stalling for a moment under load is covered by the reserve, measured
 * in docs/JAY-A.md), and the return only after an announced fallback. Returns a function to call
 * with each state's `link` (null: Jay-A mode ended, nothing pending).
 * @param {(message: string) => void} emit gets the English text, for t()
 */
export function jayANotices(emit, { delay = 2000, timers = globalThis } = {}) {
  let link = null;
  let timer = 0;
  let announced = false;
  return (next) => {
    const message = next ? jayANotice(link, next) : null;
    if (!next || message) timers.clearTimeout(timer);
    link = next ?? null;
    if (!next) announced = false;
    if (!message) return;
    if (next === 'fallback') {
      timer = timers.setTimeout(() => {
        announced = true;
        emit(message);
      }, delay);
    } else if (next === 'jay-a') {
      if (announced) emit(message);
      announced = false;
    } else {
      emit(message);
    }
  };
}

/**
 * Whether the call's native mic should be reopened, checked every few seconds: it failed (e.g.
 * unplugged; Windows ends the capture) and a microphone is there to open, or it's running on another
 * mic than the one wanted (the chosen one came back, or Windows' default changed).
 * @param {{ failed: boolean, preferredId: string | null, current: string | null,
 *   mics: Array<{ id: string, name: string, isDefault: boolean }> }} state `current`: the open mic's name.
 */
export function micNeedsRestart({ failed, preferredId, current, mics }) {
  if (!mics.length) return false;
  if (failed) return true;
  const wanted = (preferredId && mics.find((m) => m.id === preferredId)) || mics.find((m) => m.isDefault);
  return Boolean(wanted && current && wanted.name !== current);
}

/**
 * One chunk on its way to the call. Jay-A's audio already has Jay-A's volume and gate, so it is
 * only measured; Jay-C's own gets Jay-C's (in place). Returns its level (dBFS) and whether it is
 * sent (the gate is open; for Jay-A, it isn't silence).
 * @param {Float32Array} samples
 * @param {{ fromJayA: boolean, state: ReturnType<typeof createShapeState>, shape: { gain: number, gateDb: number | null } }} options
 */
export function shapeChunk(samples, { fromJayA, state, shape }) {
  if (!fromJayA) return { level: shapeMic(samples, state, shape), open: state.open };
  const level = levelDb(samples);
  return { level, open: level > -Infinity };
}

/**
 * Starting a new mic replaces the running one on the Rust side; call `close()` (not `stop()`) on
 * the old handle then, so it doesn't stop the new capture.
 * @param {{ echoCancellation?: boolean, noiseSuppression?: boolean, autoGainControl?: boolean, device?: string | null,
 *   filter?: 'jay-c' | 'jay-a', jayAImport?: object,
 *   shape?: { gain: number, gateDb: number | null }, onLevel?: (db: number, open: boolean) => void, onError?: (message: string) => void,
 *   onStatus?: (status: { link: string, version: string | null, reason: string | null }) => void }} [options]
 *   shape: read on every chunk, so changing its fields applies at once; onLevel: each chunk's level (dBFS)
 *   and whether the gate let it through. filter 'jay-a': Jay-A's audio while it flows, this mic
 *   otherwise (docs/JAY-A.md); onStatus tells which.
 * @returns {Promise<{ track: MediaStreamTrack, device: string, echoReference: boolean, stop(): void, close(): void }>}
 */
export async function startNativeMic({ onError, onStatus, shape = { gain: 1, gateDb: null }, onLevel, ...processing } = {}) {
  const source = await PcmTrackSource.create({ channels: 1 });
  const state = createShapeState();
  let fromJayA = false;
  const onAudio = (samples) => {
    const { level, open } = shapeChunk(samples, { fromJayA, state, shape });
    onLevel?.(level, open);
    source.push(samples);
  };
  const status = (s) => {
    fromJayA = s.link === 'jay-a';
    onStatus?.(s);
  };
  let info;
  try {
    info = await systemAudio.startMic(processing, { onAudio, onError, onStatus: status });
  } catch (error) {
    source.close();
    throw Object.assign(new Error(String(error)), { name: 'NotReadableError' });
  }
  return {
    track: source.track,
    device: info.device,
    echoReference: info.echoReference,
    stop() {
      systemAudio.stopMic().catch(() => {});
      source.close();
    },
    close() {
      source.close();
    },
  };
}
