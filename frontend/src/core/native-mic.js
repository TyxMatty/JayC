// The call microphone captured natively (Rust: plain WASAPI + WebRTC echo cancellation, noise
// suppression and gain). WebView2's own getUserMedia mic puts some laptops' audio into "call mode",
// muffling every other app (docs/spikes/09-som-abafado.md); a native capture doesn't.
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { PcmTrackSource } from './screen-audio.js';

export const nativeMicSupported = () => systemAudio.isSupported();

/**
 * Starting a new mic replaces the running one on the Rust side; call `close()` (not `stop()`) on
 * the old handle then, so it doesn't stop the new capture.
 * @param {{ echoCancellation?: boolean, noiseSuppression?: boolean, autoGainControl?: boolean, onError?: (message: string) => void }} [options]
 * @returns {Promise<{ track: MediaStreamTrack, device: string, echoReference: boolean, stop(): void, close(): void }>}
 */
export async function startNativeMic({ onError, ...processing } = {}) {
  const source = await PcmTrackSource.create({ channels: 1 });
  let info;
  try {
    info = await systemAudio.startMic(processing, { onAudio: (samples) => source.push(samples), onError });
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
