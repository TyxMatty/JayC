// JS API for tauri-plugin-system-audio. See ../src/lib.rs for the data format.
import { invoke, Channel } from '@tauri-apps/api/core';

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** True on platforms where per-process capture works (currently Windows). */
export async function isSupported() {
  if (!inTauri()) return false;
  try {
    return await invoke('plugin:system-audio|is_supported');
  } catch {
    return false;
  }
}

/** @returns {Promise<Array<{ pid: number, exe: string, displayName: string, active: boolean }>>} */
export function listAudioApps() {
  return invoke('plugin:system-audio|list_audio_apps');
}

/** Active microphones (Windows endpoints); pass an `id` as `startMic`'s `device`.
 * @returns {Promise<Array<{ id: string, name: string, isDefault: boolean }>>} */
export function listMics() {
  return invoke('plugin:system-audio|list_mics');
}

/** @returns {Promise<{ pid: number, rootPid: number, exe: string, title: string }>} */
export function windowProcess(hwnd) {
  return invoke('plugin:system-audio|window_process', { hwnd });
}

/**
 * Starts capturing. Audio arrives in `onAudio(Float32Array)`: interleaved stereo at 48 kHz, 20 ms per call.
 * @param {{ include?: number[], excludeSelf?: boolean, excludeExes?: string[] }} target
 * @param {{ onAudio: (samples: Float32Array) => void, onError?: (message: string) => void }} handlers
 * @returns {Promise<{ sampleRate: number, channels: number, chunkFrames: number, streams: number }>}
 */
export function startCapture(target, { onAudio, onError }) {
  const channel = new Channel();
  channel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onAudio(new Float32Array(message));
    else if (message?.error) onError?.(message.error);
  };
  return invoke('plugin:system-audio|start_capture', { target, onAudio: channel });
}

export function stopCapture() {
  return invoke('plugin:system-audio|stop_capture');
}

/**
 * Starts the native call microphone (cleaned by WebRTC audio processing). Audio arrives in
 * `onAudio(Float32Array)`: mono at 48 kHz, 20 ms per call.
 * With `filter: 'jay-a'`, the audio is Jay-A's while it flows and Jay-C's own otherwise
 * (docs/JAY-A.md); `onStatus` gets `{ link: 'searching' | 'jay-a' | 'fallback' | 'incompatible',
 * version, reason, device, deviceId }` when that changes, always before the chunks it applies to
 * (`deviceId`: Jay-A's microphone, which the reserve should use).
 * @param {{ echoCancellation?: boolean, noiseSuppression?: boolean, autoGainControl?: boolean, device?: string | null,
 *   filter?: 'jay-c' | 'jay-a', jayAImport?: object }} options
 * @param {{ onAudio: (samples: Float32Array) => void, onError?: (message: string) => void,
 *   onStatus?: (status: { link: string, version: string | null, reason: string | null }) => void }} handlers
 * @returns {Promise<{ sampleRate: number, channels: number, chunkFrames: number, device: string, echoReference: boolean }>}
 */
export function startMic(options, { onAudio, onError, onStatus }) {
  const channel = new Channel();
  channel.onmessage = (message) => {
    if (message instanceof ArrayBuffer) onAudio(new Float32Array(message));
    else if (message?.error) onError?.(message.error);
    else if (message?.link) onStatus?.(message);
  };
  return invoke('plugin:system-audio|start_mic', { options, onAudio: channel });
}

/** Whether Jay-A is installed for this user (Windows). */
export async function jayAInstalled() {
  return inTauri() ? invoke('plugin:system-audio|jay_a_installed').catch(() => false) : false;
}

/** Opens Jay-A's releases page in the browser. */
export function jayAOpenReleases() {
  return invoke('plugin:system-audio|jay_a_open_releases');
}

/** Jay-A mode: asks Jay-A to show its window. */
export function jayAShow() {
  return invoke('plugin:system-audio|jay_a_show');
}

/** Jay-A mode: tells Jay-A whether we're in a call and muted (shown in its window). */
export function micCallState({ inCall, muted }) {
  return invoke('plugin:system-audio|mic_call_state', { inCall, muted });
}

export function stopMic() {
  return invoke('plugin:system-audio|stop_mic');
}
