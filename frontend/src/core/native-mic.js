// The call microphone captured natively (Rust: plain WASAPI + WebRTC echo cancellation, noise
// suppression and gain). WebView2's own getUserMedia mic puts some laptops' audio into "call mode",
// muffling every other app (docs/spikes/09-som-abafado.md); a native capture doesn't.
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { PcmTrackSource } from './screen-audio.js';
import { shapeMic, createShapeState } from './mic-shape.js';

export const nativeMicSupported = () => systemAudio.isSupported();

/** Microphones Windows has right now: `[{ id, name, isDefault }]`. */
export const listMics = () => systemAudio.listMics();

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
 * Starting a new mic replaces the running one on the Rust side; call `close()` (not `stop()`) on
 * the old handle then, so it doesn't stop the new capture.
 * @param {{ echoCancellation?: boolean, noiseSuppression?: boolean, autoGainControl?: boolean, device?: string | null,
 *   shape?: { gain: number, gateDb: number | null }, onLevel?: (db: number, open: boolean) => void, onError?: (message: string) => void }} [options]
 *   shape: read on every chunk, so changing its fields applies at once; onLevel: each chunk's level (dBFS)
 *   and whether the gate let it through.
 * @returns {Promise<{ track: MediaStreamTrack, device: string, echoReference: boolean, stop(): void, close(): void }>}
 */
export async function startNativeMic({ onError, shape = { gain: 1, gateDb: null }, onLevel, ...processing } = {}) {
  const source = await PcmTrackSource.create({ channels: 1 });
  const state = createShapeState();
  const onAudio = (samples) => {
    const level = shapeMic(samples, state, shape);
    onLevel?.(level, state.open);
    source.push(samples);
  };
  let info;
  try {
    info = await systemAudio.startMic(processing, { onAudio, onError });
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
