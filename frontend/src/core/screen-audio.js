// Screen-share sound: native per-process capture (Rust plugin) -> AudioWorklet -> MediaStreamTrack.
import * as systemAudio from 'tauri-plugin-system-audio-api';

const SAMPLE_RATE = 48_000;

/** Turns pushed PCM chunks into a live MediaStreamTrack (not played locally). */
export class PcmTrackSource {
  /** @param {{ channels?: 1 | 2 }} [options] */
  static async create({ channels = 2 } = {}) {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await context.audioWorklet.addModule(new URL('./pcm-player.worklet.js', import.meta.url));
    const node = new AudioWorkletNode(context, 'pcm-player', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      processorOptions: { channels },
    });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = channels;
    node.connect(destination);
    await context.resume();
    return new PcmTrackSource(context, node, destination);
  }

  constructor(context, node, destination) {
    this.context = context;
    this.node = node;
    this.track = destination.stream.getAudioTracks()[0];
  }

  /** @param {Float32Array} samples interleaved */
  push(samples) {
    this.node.port.postMessage(samples, [samples.buffer]);
  }

  close() {
    this.track.stop();
    this.context.close().catch(() => {});
  }
}

export const screenAudioSupported = () => systemAudio.isSupported();

/**
 * Starts capturing the sound that goes with a screen share:
 *   mode 'window' -> only the app that owns the shared window (and its helper processes)
 *   mode 'screen' -> everything except Jay-C itself (so the call's voices aren't echoed back)
 * Resolves with `{ track, stop(), description }`, or null when native capture isn't available.
 * @param {{ mode: 'screen' | 'window', windowHandle: number | null, onError?: (message: string) => void }} options
 */
export async function startScreenAudio({ mode, windowHandle, onError }) {
  if (!(await systemAudio.isSupported())) return null;

  let target;
  let description;
  if (mode === 'window') {
    if (windowHandle == null) throw new Error("couldn't tell which window was shared");
    const app = await systemAudio.windowProcess(windowHandle);
    target = { include: [app.rootPid] };
    description = app.exe;
  } else {
    target = { excludeSelf: true };
    description = 'all apps except Jay-C';
  }

  const source = await PcmTrackSource.create();
  try {
    await systemAudio.startCapture(target, { onAudio: (samples) => source.push(samples), onError });
  } catch (error) {
    source.close();
    throw error;
  }
  return {
    track: source.track,
    description,
    stop() {
      systemAudio.stopCapture().catch(() => {});
      source.close();
    },
  };
}
