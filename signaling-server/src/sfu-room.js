/** What a participant can publish, and the media kind each source must have. */
export const SOURCES = {
  mic: 'audio',
  camera: 'video',
  screen: 'video',
  'screen-audio': 'audio',
};

/** How a screen share was captured (sent along with `screen` producers). */
export const SHARE_MODES = new Set(['screen', 'window']);

export class SfuError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * mediasoup state of one room: a router plus, per participant, its transports, producers
 * (what it publishes) and consumers (what it receives).
 *
 * Methods named like protocol requests take `(peerId, data, context)` and return the response data.
 * Notifications to clients go through each participant's `peer.send()`.
 */
export class SfuRoom {
  /** @type {Map<string, { peer: object, transports: Map, producers: Map, consumers: Map }>} */
  #members = new Map();

  constructor({ router, webRtcServer, listenIp = '0.0.0.0' }) {
    this.router = router;
    this.webRtcServer = webRtcServer;
    this.listenIp = listenIp;
  }

  get rtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  isEmpty() {
    return this.#members.size === 0;
  }

  addPeer(peer) {
    if (!this.#members.has(peer.id)) {
      this.#members.set(peer.id, { peer, transports: new Map(), producers: new Map(), consumers: new Map() });
    }
  }

  /** Closing a participant's transports closes its producers, which closes everyone's consumers of them. */
  removePeer(peerId) {
    const member = this.#members.get(peerId);
    if (!member) return;
    this.#members.delete(peerId);
    for (const transport of member.transports.values()) transport.close();
  }

  /** What `peerId` currently publishes, for the `joined` snapshot. */
  producersOf(peerId) {
    const member = this.#members.get(peerId);
    if (!member) return [];
    return [...member.producers.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      source: p.appData.source,
      ...(p.appData.mode ? { mode: p.appData.mode } : {}),
      paused: p.paused,
    }));
  }

  // ---------- Requests ----------

  async createTransport(peerId, { direction, plain = false }, { announcedAddress }) {
    if (direction !== 'send' && direction !== 'recv') throw new SfuError('bad-request');
    if (plain && direction !== 'send') throw new SfuError('bad-request');
    const member = this.#member(peerId);
    if (plain) {
      // A native sender (docs/spikes/10-live-nativa.md): plain RTP + RTCP on one UDP port, bound to
      // whoever sends the first packet. shortcut: no SRTP and a random port (not the WebRtcServer's
      // single port); both are needed before this leaves the spike.
      const transport = await this.router.createPlainTransport({
        listenInfo: { protocol: 'udp', ip: this.listenIp },
        rtcpMux: true,
        comedia: true,
        appData: { direction },
      });
      member.transports.set(transport.id, transport);
      transport.on('routerclose', () => member.transports.delete(transport.id));
      return { id: transport.id, ip: announcedAddress, port: transport.tuple.localPort };
    }
    const transport = await this.router.createWebRtcTransport({
      webRtcServer: this.webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
      appData: { direction },
    });
    member.transports.set(transport.id, transport);
    transport.on('routerclose', () => member.transports.delete(transport.id));
    if (direction === 'send') {
      // Room for a 1080p60 screen share plus camera and audio.
      await transport.setMaxIncomingBitrate(20_000_000).catch(() => {});
    }
    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      // The WebRtcServer listens on 0.0.0.0; tell this client where it can actually reach us.
      iceCandidates: transport.iceCandidates.map((c) => ({ ...c, address: announcedAddress, ip: announcedAddress })),
      dtlsParameters: transport.dtlsParameters,
    };
  }

  async connectTransport(peerId, { transportId, dtlsParameters }) {
    if (!isObject(dtlsParameters)) throw new SfuError('bad-request');
    await this.#transport(peerId, transportId).connect({ dtlsParameters });
  }

  async restartIce(peerId, { transportId }) {
    return { iceParameters: await this.#transport(peerId, transportId).restartIce() };
  }

  async produce(peerId, { transportId, kind, rtpParameters, source, mode, paused = false }) {
    if (SOURCES[source] !== kind || !isObject(rtpParameters)) throw new SfuError('bad-request');
    if (source.startsWith('screen') ? mode !== undefined && !SHARE_MODES.has(mode) : mode !== undefined) {
      throw new SfuError('bad-request');
    }
    const member = this.#member(peerId);
    if ([...member.producers.values()].some((p) => p.appData.source === source)) {
      throw new SfuError('duplicate-source');
    }
    const transport = this.#transport(peerId, transportId);
    if (transport.appData.direction !== 'send') throw new SfuError('bad-request');

    const producer = await transport.produce({
      kind,
      rtpParameters,
      paused: Boolean(paused),
      appData: { source, peerId, ...(mode ? { mode } : {}) },
    });
    member.producers.set(producer.id, producer);
    producer.on('transportclose', () => member.producers.delete(producer.id));

    this.#broadcast(peerId, {
      type: 'new-producer',
      peerId,
      producerId: producer.id,
      kind,
      source,
      ...(mode ? { mode } : {}),
      paused: producer.paused,
    });
    return { id: producer.id };
  }

  async closeProducer(peerId, { producerId }) {
    const member = this.#member(peerId);
    const producer = this.#ownProducer(member, producerId);
    producer.close(); // consumers get 'producerclose' -> clients are told below
    member.producers.delete(producerId);
  }

  async pauseProducer(peerId, { producerId }) {
    await this.#ownProducer(this.#member(peerId), producerId).pause();
  }

  async resumeProducer(peerId, { producerId }) {
    await this.#ownProducer(this.#member(peerId), producerId).resume();
  }

  async consume(peerId, { producerId, rtpCapabilities }) {
    if (typeof producerId !== 'string' || !isObject(rtpCapabilities)) throw new SfuError('bad-request');
    const member = this.#member(peerId);
    const owner = this.#producerOwner(producerId);
    if (!owner || owner.peer.id === peerId) throw new SfuError('unknown-producer');
    if (!this.router.canConsume({ producerId, rtpCapabilities })) throw new SfuError('cannot-consume');

    const transport = [...member.transports.values()].find((t) => t.appData.direction === 'recv');
    if (!transport) throw new SfuError('unknown-transport');

    const producer = owner.producers.get(producerId);
    // Start paused: the client resumes once its consumer is wired up (avoids losing the first keyframe).
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    member.consumers.set(consumer.id, consumer);

    const ownerId = owner.peer.id;
    const tell = (message) => member.peer.send({ ...message, peerId: ownerId, producerId });
    consumer.on('transportclose', () => member.consumers.delete(consumer.id));
    consumer.on('producerclose', () => {
      member.consumers.delete(consumer.id);
      tell({ type: 'producer-closed' });
    });
    consumer.on('producerpause', () => tell({ type: 'producer-state', paused: true }));
    consumer.on('producerresume', () => tell({ type: 'producer-state', paused: false }));

    return {
      id: consumer.id,
      producerId,
      peerId: ownerId,
      kind: consumer.kind,
      source: producer.appData.source,
      ...(producer.appData.mode ? { mode: producer.appData.mode } : {}),
      type: consumer.type,
      rtpParameters: consumer.rtpParameters,
      producerPaused: consumer.producerPaused,
    };
  }

  async resumeConsumer(peerId, { consumerId }) {
    await this.#consumer(peerId, consumerId).resume();
  }

  /** Stop receiving (e.g. stopped watching a stream) without closing the consumer. */
  async pauseConsumer(peerId, { consumerId }) {
    await this.#consumer(peerId, consumerId).pause();
  }

  /** Simulcast: pick which spatial layer (0 = lowest) this client receives for one consumer. */
  async setPreferredLayers(peerId, { consumerId, spatialLayer, temporalLayer }) {
    const consumer = this.#consumer(peerId, consumerId);
    if (!Number.isInteger(spatialLayer) || spatialLayer < 0) throw new SfuError('bad-request');
    if (consumer.type !== 'simulcast' && consumer.type !== 'svc') return;
    await consumer.setPreferredLayers({
      spatialLayer,
      ...(Number.isInteger(temporalLayer) ? { temporalLayer } : {}),
    });
  }

  close() {
    this.router.close();
  }

  // ---------- Internals ----------

  #member(peerId) {
    const member = this.#members.get(peerId);
    if (!member) throw new SfuError('not-in-room');
    return member;
  }

  #transport(peerId, transportId) {
    const transport = this.#member(peerId).transports.get(transportId);
    if (!transport) throw new SfuError('unknown-transport');
    return transport;
  }

  #consumer(peerId, consumerId) {
    const consumer = this.#member(peerId).consumers.get(consumerId);
    if (!consumer) throw new SfuError('unknown-consumer');
    return consumer;
  }

  #ownProducer(member, producerId) {
    const producer = member.producers.get(producerId);
    if (!producer) throw new SfuError('unknown-producer');
    return producer;
  }

  #producerOwner(producerId) {
    for (const member of this.#members.values()) {
      if (member.producers.has(producerId)) return member;
    }
    return null;
  }

  #broadcast(fromPeerId, message) {
    for (const [id, member] of this.#members) {
      if (id !== fromPeerId) member.peer.send(message);
    }
  }
}
