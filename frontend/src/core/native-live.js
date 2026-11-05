// Native screen share (Windows): Rust captures a monitor or window, encodes H.264 on the GPU and
// sends it over its own WebRTC transport (src-tauri/src/native_live; docs/spikes/10-live-nativa.md).
// ~20x less CPU than getDisplayMedia + WebView2's encoder. This side does the signaling.
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { streamBitrate, targetHeight } from './media.js';

// Must match src-tauri/src/native_live/webrtc.rs (PT, RTX_PT, MID) and str0m's extension ids.
const PT = 102;
const RTX_PT = 103;

/** Windows app: the native share and its own picker (ui/source-picker.js) replace getDisplayMedia's. */
export const nativeLiveSupported = () => systemAudio.isSupported();

async function invoke(command, args) {
  return (await import('@tauri-apps/api/core')).invoke(command, args);
}

/** Stops the native live, even one still starting (e.g. when leaving the call meanwhile). */
export const stopNativeLive = () => invoke('native_live_stop');

/** Monitors (primary first), then app windows, most recently used first. */
export const listSources = () => invoke('native_live_sources');

/** An object URL with a JPEG of the source right now (revoke it when done). */
export async function sourceThumbnail({ kind, id }) {
  const bytes = await invoke('native_live_thumbnail', { source: { kind, id } });
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
}

/** The quality picked in Settings › Streaming, as the top of Rust's quality ladder. */
export function nativeQuality({ resolution, fps }, screen = window.screen, ratio = window.devicePixelRatio || 1) {
  const screenHeight = Math.round(screen.height * ratio);
  const height = Math.min(targetHeight(resolution) ?? screenHeight, screenHeight);
  const width = Math.round((height * screen.width) / screen.height);
  return { maxHeight: targetHeight(resolution), maxFps: fps, maxKbps: Math.round(streamBitrate(width, height, fps) / 1000) };
}

/** The producer as the server must see it: what str0m sends (H.264 High + RTX, TWCC, mid). */
export function nativeRtpParameters({ ssrc, rtxSsrc }) {
  return {
    mid: '0',
    codecs: [
      {
        mimeType: 'video/H264',
        payloadType: PT,
        clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '640032', 'level-asymmetry-allowed': 1 },
        rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'transport-cc' }],
      },
      { mimeType: 'video/rtx', payloadType: RTX_PT, clockRate: 90000, parameters: { apt: PT }, rtcpFeedback: [] },
    ],
    headerExtensions: [
      { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 2 },
      { uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', id: 3 },
      { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 4 },
    ],
    encodings: [{ ssrc, rtx: { ssrc: rtxSsrc } }],
    rtcp: { cname: 'jayc-native' },
  };
}

/**
 * Starts the native share of `source` (from listSources) and publishes it as this peer's `screen` producer.
 * @param {{ source: { kind: 'monitor' | 'window', id: number }, request: (type: string, data: object) => Promise<any>, quality: object,
 *   onEnded: (reason: string) => void }} options `onEnded`: the share stopped on its own (not after close()).
 * @returns {Promise<{ id: string, stats: () => object | null, setQuality: (quality: object) => Promise<void>, close: () => Promise<void> }>}
 */
export async function startNativeLive({ source, request, quality, onEnded }) {
  const { invoke, Channel } = await import('@tauri-apps/api/core');
  const transport = await request('createTransport', { direction: 'send' });
  const candidate = transport.iceCandidates.find((c) => c.protocol === 'udp');
  const fingerprint = transport.dtlsParameters.fingerprints.find((f) => f.algorithm === 'sha-256');
  if (!candidate || !fingerprint) throw new Error('the server offered no UDP media port');

  let closed = false;
  let stats = null;
  const onEvent = new Channel();
  onEvent.onmessage = (event) => {
    if (event.type === 'stats') stats = event;
    if (event.type === 'ended' && !closed) {
      closed = true;
      onEnded(event.error ?? 'stopped');
    }
  };
  const close = async () => {
    closed = true;
    // Its transport was only for this share. An old server doesn't know closeTransport: the
    // transport then stays until we leave, as before.
    request('closeTransport', { transportId: transport.id }).catch(() => {});
    await invoke('native_live_stop');
  };
  let local;
  try {
    local = await invoke('native_live_start', {
      source: { kind: source.kind, id: source.id },
      remote: {
        ufrag: transport.iceParameters.usernameFragment,
        pwd: transport.iceParameters.password,
        ip: candidate.ip,
        port: candidate.port,
        fingerprint: `sha-256 ${fingerprint.value}`,
      },
      quality: nativeQuality(quality),
      onEvent,
    });
  } catch (error) {
    request('closeTransport', { transportId: transport.id }).catch(() => {});
    throw error;
  }
  try {
    const [algorithm, value] = local.fingerprint.split(' ');
    await request('connectTransport', { transportId: transport.id, dtlsParameters: { role: 'client', fingerprints: [{ algorithm, value }] } });
    const { id } = await request('produce', {
      transportId: transport.id,
      kind: 'video',
      source: 'screen',
      mode: source.kind === 'window' ? 'window' : 'screen',
      rtpParameters: nativeRtpParameters(local),
    });
    return { id, close, stats: () => stats, setQuality: (next) => invoke('native_live_set_quality', { quality: nativeQuality(next) }) };
  } catch (error) {
    await close();
    throw error;
  }
}
