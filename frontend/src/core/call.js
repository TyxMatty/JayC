import { Device } from 'mediasoup-client';
import { SignalingClient } from './signaling.js';
import { openLocalMedia, getMicTrack, getCameraTrack } from './media.js';

/** Camera simulcast: the SFU forwards one of these layers to each viewer. */
const CAMERA_ENCODINGS = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];

/** Which camera layer to receive, by how many cameras are on screen (bigger tiles -> higher layer). */
function cameraLayerFor(cameraCount) {
  if (cameraCount <= 2) return 2;
  if (cameraCount <= 6) return 1;
  return 0;
}

/**
 * A call in one room, with media routed through the server's SFU (mediasoup): we upload each
 * track once over a "send" transport and receive everyone else's over a "recv" transport.
 *
 * Events (CustomEvent):
 *   participant-added   { participant }
 *   participant-removed { participant }
 *   participant-updated { participant }   tracks, mute state or connection changed
 *   local-updated       {}                local tracks changed (mute, camera on/off)
 *   signaling-state     { state }
 *   ended               {}
 *
 * participant = { id, name, stream: MediaStream, media: { audio, video }, connectionState }
 */
export class Call extends EventTarget {
  local = { audio: null, video: null };
  /** For the local preview tile. */
  localStream = new MediaStream();
  /** @type {Map<string, object>} */
  participants = new Map();
  mediaErrors = {};
  room = null;

  #signaling = null;
  #device = null;
  #iceServers = [];
  #send = null;
  #recv = null;
  /** Resolves with the recv transport of the current setup (consumes wait for it). */
  #recvReady = null;
  /** @type {{ mic: import('mediasoup-client').types.Producer | null, camera: import('mediasoup-client').types.Producer | null }} */
  #producers = { mic: null, camera: null };
  #micMuted = false;
  /** Bumped on every (re)setup so late async results from an old setup are discarded. */
  #generation = 0;
  #ended = false;

  get micOn() {
    return Boolean(this.local.audio) && !this.#micMuted;
  }

  get cameraOn() {
    return Boolean(this.local.video);
  }

  /** Opens local media, joins the room and starts sending/receiving through the SFU. */
  async join({ url, room, name }) {
    this.room = room;
    const media = await openLocalMedia();
    this.local.audio = media.audio;
    this.local.video = media.video;
    this.mediaErrors = media.errors;
    this.#syncLocalStream();

    const signaling = new SignalingClient(url);
    this.#signaling = signaling;
    signaling.addEventListener('state', (e) => this.#emit('signaling-state', e.detail));
    signaling.addEventListener('peer-joined', (e) => this.#addParticipant(e.detail));
    signaling.addEventListener('peer-left', (e) => this.#removeParticipant(e.detail.id));
    signaling.addEventListener('new-producer', (e) => this.#consume(e.detail));
    signaling.addEventListener('producer-closed', (e) => this.#onProducerClosed(e.detail));
    signaling.addEventListener('producer-state', (e) => this.#onProducerState(e.detail));
    signaling.addEventListener('rejoined', (e) => this.#setup(e.detail).catch((err) => console.warn('[call] rejoin failed', err)));

    let joined;
    try {
      joined = await signaling.join(room, name);
      await this.#setup(joined);
    } catch (error) {
      signaling.close();
      this.#stopLocal();
      throw error;
    }
  }

  async toggleMic() {
    if (!this.local.audio) {
      // No mic yet (denied or missing at join): try again now.
      this.local.audio = await getMicTrack();
      this.#micMuted = false;
      if (this.#producers.mic) {
        await this.#producers.mic.replaceTrack({ track: this.local.audio });
        await this.#setProducerPaused('mic', false);
      } else {
        await this.#produce('mic', this.local.audio);
      }
    } else {
      this.#micMuted = !this.#micMuted;
      await this.#setProducerPaused('mic', this.#micMuted);
    }
    this.#syncLocalStream();
  }

  async toggleCamera() {
    if (this.local.video) {
      // Stop the track so the camera light turns off.
      await this.#setProducerPaused('camera', true);
      await this.#producers.camera?.replaceTrack({ track: null });
      this.local.video.stop();
      this.local.video = null;
    } else {
      this.local.video = await getCameraTrack();
      if (this.#producers.camera) {
        await this.#producers.camera.replaceTrack({ track: this.local.video });
        await this.#setProducerPaused('camera', false);
      } else {
        await this.#produce('camera', this.local.video);
      }
    }
    this.#syncLocalStream();
  }

  leave() {
    if (this.#ended) return;
    this.#ended = true;
    this.#generation++;
    this.#signaling?.close();
    this.#closeTransports();
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#stopLocal();
    this.#emit('ended', {});
  }

  /** Stats of what we upload, e.g. to confirm each track is sent once regardless of room size. */
  async sendStats() {
    return this.#send ? this.#send.getStats() : null;
  }

  // ---------- Setup (first join and every reconnect) ----------

  async #setup(joined) {
    const generation = ++this.#generation;
    this.#closeTransports();
    for (const id of [...this.participants.keys()]) this.#removeParticipant(id);
    this.#iceServers = joined.iceServers ?? [];

    if (!this.#device) {
      this.#device = new Device();
      await this.#device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
    }

    // Participants first, so producers announced while we build transports aren't lost.
    for (const p of joined.peers) this.#addParticipant(p);

    this.#recvReady = this.#createTransport('recv', generation);
    const sendReady = this.#createTransport('send', generation);

    for (const p of joined.peers) {
      for (const producer of p.producers ?? []) {
        this.#consume({ peerId: p.id, producerId: producer.id, kind: producer.kind, source: producer.source });
      }
    }

    this.#send = await sendReady;
    this.#recv = await this.#recvReady;
    if (generation !== this.#generation) return;

    if (this.local.audio) await this.#produce('mic', this.local.audio);
    if (this.local.video) await this.#produce('camera', this.local.video);
  }

  async #createTransport(direction, generation) {
    const params = await this.#signaling.request('createTransport', { direction });
    const options = { ...params, iceServers: this.#iceServers };
    const transport =
      direction === 'send' ? this.#device.createSendTransport(options) : this.#device.createRecvTransport(options);

    transport.on('connect', ({ dtlsParameters }, ok, fail) => {
      this.#signaling.request('connectTransport', { transportId: transport.id, dtlsParameters }).then(ok, fail);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters, appData }, ok, fail) => {
        this.#signaling
          .request('produce', { transportId: transport.id, kind, rtpParameters, source: appData.source, paused: appData.paused })
          .then(ok, fail);
      });
    }

    transport.on('connectionstatechange', (state) => {
      if (generation !== this.#generation) return;
      if (state === 'failed') this.#restartIce(transport);
      if (direction === 'recv') {
        for (const participant of this.participants.values()) this.#updateParticipant(participant);
      }
    });
    return transport;
  }

  async #restartIce(transport) {
    try {
      const { iceParameters } = await this.#signaling.request('restartIce', { transportId: transport.id });
      await transport.restartIce({ iceParameters });
    } catch (error) {
      console.warn('[call] ICE restart failed', error);
    }
  }

  #closeTransports() {
    // Closing transports closes their producers/consumers; our local tracks survive (stopTracks: false).
    this.#send?.close();
    this.#recv?.close();
    this.#send = this.#recv = this.#recvReady = null;
    this.#producers = { mic: null, camera: null };
  }

  // ---------- Sending ----------

  async #produce(source, track) {
    const options = {
      track,
      stopTracks: false,
      appData: { source, paused: source === 'mic' && this.#micMuted },
    };
    if (source === 'camera') {
      options.encodings = CAMERA_ENCODINGS;
      options.codecOptions = { videoGoogleStartBitrate: 1000 };
    } else if (source === 'mic') {
      options.codecOptions = { opusDtx: true, opusFec: true };
    }
    const producer = await this.#send.produce(options);
    if (options.appData.paused) producer.pause();
    this.#producers[source] = producer;
    return producer;
  }

  async #setProducerPaused(source, paused) {
    const producer = this.#producers[source];
    if (!producer || producer.paused === paused) return;
    if (paused) producer.pause();
    else producer.resume();
    await this.#signaling
      .request(paused ? 'pauseProducer' : 'resumeProducer', { producerId: producer.id })
      .catch((error) => console.warn('[call] pause/resume failed', error));
  }

  // ---------- Receiving ----------

  #addParticipant({ id, name }) {
    if (this.participants.has(id)) return this.participants.get(id);
    const participant = {
      id,
      name: name ?? 'Guest',
      stream: new MediaStream(),
      media: { audio: false, video: false },
      connectionState: 'connected',
      /** producerId -> { consumer, source, paused, layer } */
      consumers: new Map(),
      pending: new Set(),
    };
    this.participants.set(id, participant);
    this.#emit('participant-added', { participant });
    return participant;
  }

  #removeParticipant(id) {
    const participant = this.participants.get(id);
    if (!participant) return;
    this.participants.delete(id);
    for (const { consumer } of participant.consumers.values()) consumer.close();
    for (const track of participant.stream.getTracks()) participant.stream.removeTrack(track);
    this.#emit('participant-removed', { participant });
    this.#applyLayerPolicy();
  }

  async #consume({ peerId, producerId, source }) {
    const participant = this.participants.get(peerId);
    if (!participant || participant.consumers.has(producerId) || participant.pending.has(producerId)) return;
    if (source !== 'mic' && source !== 'camera') return; // screen sources arrive with the streaming milestone

    const generation = this.#generation;
    participant.pending.add(producerId);
    try {
      const recv = await this.#recvReady;
      const params = await this.#signaling.request('consume', { producerId, rtpCapabilities: this.#device.rtpCapabilities });
      if (generation !== this.#generation || !this.participants.has(peerId)) return;

      const consumer = await recv.consume({
        id: params.id,
        producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters,
        appData: { source: params.source },
      });
      participant.consumers.set(producerId, { consumer, source: params.source, paused: params.producerPaused, layer: null });
      participant.stream.addTrack(consumer.track);
      await this.#signaling.request('resumeConsumer', { consumerId: consumer.id });
      this.#updateParticipant(participant);
      if (params.source === 'camera') this.#applyLayerPolicy();
    } catch (error) {
      // The producer may have closed in the meantime.
      if (error?.code !== 'unknown-producer') console.warn('[call] consume failed', error);
    } finally {
      participant.pending.delete(producerId);
    }
  }

  #onProducerClosed({ peerId, producerId }) {
    const participant = this.participants.get(peerId);
    const entry = participant?.consumers.get(producerId);
    if (!entry) return;
    participant.consumers.delete(producerId);
    participant.stream.removeTrack(entry.consumer.track);
    entry.consumer.close();
    this.#updateParticipant(participant);
    if (entry.source === 'camera') this.#applyLayerPolicy();
  }

  #onProducerState({ peerId, producerId, paused }) {
    const participant = this.participants.get(peerId);
    const entry = participant?.consumers.get(producerId);
    if (!entry) return;
    entry.paused = paused;
    this.#updateParticipant(participant);
  }

  #updateParticipant(participant) {
    const live = (source) => [...participant.consumers.values()].some((c) => c.source === source && !c.paused);
    participant.media = { audio: live('mic'), video: live('camera') };
    const recvState = this.#recv?.connectionState ?? 'new';
    participant.connectionState = participant.consumers.size === 0 ? 'connected' : recvState;
    this.#emit('participant-updated', { participant });
  }

  /** Ask the SFU for a camera layer that fits the tile size. */
  #applyLayerPolicy() {
    const cameras = [];
    for (const participant of this.participants.values()) {
      for (const entry of participant.consumers.values()) if (entry.source === 'camera') cameras.push(entry);
    }
    const layer = cameraLayerFor(cameras.length);
    for (const entry of cameras) {
      if (entry.layer === layer) continue;
      entry.layer = layer;
      this.#signaling
        .request('setPreferredLayers', { consumerId: entry.consumer.id, spatialLayer: layer })
        .catch(() => (entry.layer = null));
    }
  }

  // ---------- Local media ----------

  #syncLocalStream() {
    for (const track of this.localStream.getTracks()) {
      if (track !== this.local.audio && track !== this.local.video) this.localStream.removeTrack(track);
    }
    for (const track of [this.local.audio, this.local.video]) {
      if (track && !this.localStream.getTracks().includes(track)) this.localStream.addTrack(track);
    }
    this.#emit('local-updated', {});
  }

  #stopLocal() {
    for (const track of [this.local.audio, this.local.video]) track?.stop();
    this.local.audio = this.local.video = null;
    for (const track of this.localStream.getTracks()) this.localStream.removeTrack(track);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
