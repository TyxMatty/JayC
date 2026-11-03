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

/** @returns {Promise<{ pid: number, rootPid: number, exe: string, title: string }>} */
export function windowProcess(hwnd) {
  return invoke('plugin:system-audio|window_process', { hwnd });
}

/**
 * Starts capturing. Audio arrives in `onAudio(Float32Array)`: interleaved stereo at 48 kHz, 20 ms per call.
 * @param {{ include?: number[], excludeSelf?: boolean }} target
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
