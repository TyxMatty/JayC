import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as mediasoup from 'mediasoup';
import { SfuRoom } from './sfu-room.js';

/** Codecs every room's router offers. Opus is stereo-capable for screen-share audio. */
export const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 0 } },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
  // High profile, for screen shares: WebView2 hands it to the GPU encoder (Media Foundation), while
  // constrained baseline (42e01f) stays on OpenH264 in software (measured on an RTX 3050).
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '640032', 'level-asymmetry-allowed': 1 },
  },
];

/**
 * The address clients should send media to. mediasoup is ICE-lite, so the server only has to
 * advertise a reachable address: by default the same host the client used for the WebSocket
 * (its `Host` header), which works for LAN IPs, VPN IPs (ZeroTier/Radmin) and localhost alike.
 */
export async function resolveAnnouncedAddress(hostHeader, configured) {
  if (configured) return configured;
  let host = String(hostHeader ?? '').trim();
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']'));
  else host = host.replace(/:\d+$/, '');
  if (!host || host === 'localhost') return '127.0.0.1';
  if (isIP(host)) return host;
  try {
    return (await lookup(host)).address;
  } catch {
    return '127.0.0.1';
  }
}

/** One mediasoup worker + one WebRtcServer (single media port) + one router per room. */
export class Sfu {
  /** @type {Map<string, Promise<SfuRoom>>} */
  #rooms = new Map();

  constructor(worker, webRtcServer, listenIp) {
    this.worker = worker;
    this.webRtcServer = webRtcServer;
    this.listenIp = listenIp;
  }

  static async create(config, log) {
    const worker = await mediasoup.createWorker({ logLevel: config.mediasoupLogLevel });
    worker.on('died', (error) => {
      log('error', 'mediasoup worker died, exiting', { error: error?.message });
      process.exit(1); // the container restarts us
    });

    const port = config.rtcPort ? { port: config.rtcPort } : {};
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip: config.rtcListenIp, ...port },
        { protocol: 'tcp', ip: config.rtcListenIp, ...port },
      ],
    });
    return new Sfu(worker, webRtcServer, config.rtcListenIp);
  }

  /** Router-backed media state for a room, created on first use. */
  room(roomId) {
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = this.worker
        .createRouter({ mediaCodecs: MEDIA_CODECS })
        .then((router) => new SfuRoom({ router, webRtcServer: this.webRtcServer, listenIp: this.listenIp }));
      this.#rooms.set(roomId, room);
    }
    return room;
  }

  async closeRoomIfEmpty(roomId) {
    const pending = this.#rooms.get(roomId);
    if (!pending) return;
    const room = await pending;
    if (room.isEmpty() && this.#rooms.get(roomId) === pending) {
      this.#rooms.delete(roomId);
      room.close();
    }
  }

  get roomCount() {
    return this.#rooms.size;
  }

  close() {
    this.worker.close();
  }
}
