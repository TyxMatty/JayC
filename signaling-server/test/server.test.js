import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';

const baseConfig = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 2,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [{ urls: 'stun:stun.example.org:3478' }],
  rtcPort: 0,
  rtcListenIp: '127.0.0.1',
  announcedAddress: '',
  mediasoupLogLevel: 'error',
};

// A minimal valid Opus producer (no real RTP is sent in these tests).
const opusRtpParameters = {
  codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
  headerExtensions: [],
  encodings: [{ ssrc: 11111111 }],
  rtcp: { cname: 'test' },
};

/** WebSocket test client: `waitFor(predicate)` returns the first matching message (buffered or future). */
function connect(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const inbox = [];
  const waiters = [];
  let nextId = 1;

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else inbox.push(msg);
  });

  const client = {
    ws,
    open: () =>
      new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    waitFor(predicate, label = 'message') {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ predicate, resolve: (msg) => (clearTimeout(timer), resolve(msg)) });
      });
    },
    next: (type) => client.waitFor((m) => !type || m.type === type, type),
    async request(type, data) {
      const id = nextId++;
      client.send({ type, id, data });
      return client.waitFor((m) => m.type === 'response' && m.id === id, `response to ${type}`);
    },
    close: () => ws.close(),
  };
  return client;
}

async function joined(port, room, name) {
  const client = connect(port);
  await client.open();
  client.send({ type: 'join', room, name });
  const msg = await client.next('joined');
  return { client, msg };
}

describe('signaling server', () => {
  let server;
  let port;

  before(async () => {
    server = startServer(baseConfig, { log: () => {} });
    port = await server.ready;
  });

  after(() => server.close());

  test('GET /health reports status and counts', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.rooms, 'number');
    assert.equal(typeof body.peers, 'number');
  });

  test('join returns id, peers, ICE servers and router RTP capabilities', async () => {
    const a = await joined(port, 'room-join', 'Alice');
    assert.deepEqual(a.msg.peers, []);
    assert.deepEqual(a.msg.iceServers, baseConfig.iceServers);
    assert.match(a.msg.id, /^[0-9a-f-]{36}$/);
    const mimeTypes = a.msg.routerRtpCapabilities.codecs.map((c) => c.mimeType);
    for (const mime of ['audio/opus', 'video/VP8', 'video/H264']) assert.ok(mimeTypes.includes(mime), mime);

    const b = await joined(port, 'room-join', 'Bob');
    assert.deepEqual(b.msg.peers, [{ id: a.msg.id, name: 'Alice', producers: [] }]);
    assert.deepEqual(await a.client.next('peer-joined'), { type: 'peer-joined', id: b.msg.id, name: 'Bob' });

    a.client.close();
    b.client.close();
  });

  test('room capacity is enforced', async () => {
    const a = await joined(port, 'room-full', 'A');
    const b = await joined(port, 'room-full', 'B');
    const c = connect(port);
    await c.open();
    c.send({ type: 'join', room: 'room-full', name: 'C' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'room-full', ref: 'join' });
    a.client.close();
    b.client.close();
    c.close();
  });

  test('disconnect notifies remaining peers and empty rooms are removed', async () => {
    const a = await joined(port, 'room-leave', 'Alice');
    const b = await joined(port, 'room-leave', 'Bob');
    await a.client.next('peer-joined');

    b.client.close();
    assert.deepEqual(await a.client.next('peer-left'), { type: 'peer-left', id: b.msg.id, name: 'Bob' });

    a.client.send({ type: 'leave' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(server.registry.rooms.has('room-leave'), false);
    assert.equal((await server.sfu).roomCount, 0);
    a.client.close();
  });

  test('profile pictures travel on join and live updates; anything else is refused', async () => {
    const pixel = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
    const join = (name, avatar) => {
      const client = connect(port);
      return client.open().then(() => {
        client.send({ type: 'join', room: 'room-avatar', name, avatar });
        return client;
      });
    };

    const a = await join('Alice', pixel);
    const aJoined = await a.next('joined');
    const b = await join('Bob');
    const bJoined = await b.next('joined');
    assert.deepEqual(bJoined.peers, [{ id: aJoined.id, name: 'Alice', avatar: pixel, producers: [] }]);
    assert.deepEqual(await a.next('peer-joined'), { type: 'peer-joined', id: bJoined.id, name: 'Bob' });

    b.send({ type: 'profile', avatar: pixel });
    assert.deepEqual(await a.next('peer-updated'), { type: 'peer-updated', id: bJoined.id, avatar: pixel });
    b.send({ type: 'profile', avatar: null });
    assert.deepEqual(await a.next('peer-updated'), { type: 'peer-updated', id: bJoined.id, avatar: null });

    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', // SVG can carry scripts: raster only
      'https://example.com/me.png', // no remote URLs (tracking)
      `data:image/png;base64,${'A'.repeat(40_000)}`, // too big
      'data:image/png;base64,not base64!',
      42,
    ]) {
      b.send({ type: 'profile', avatar: bad });
      assert.deepEqual(await b.next('error'), { type: 'error', code: 'bad-message', ref: 'profile' }, String(bad).slice(0, 30));
    }
    const c = connect(port);
    await c.open();
    c.send({ type: 'join', room: 'room-avatar-2', name: 'Carol', avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });
    c.send({ type: 'profile', avatar: pixel });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'not-in-room', ref: 'profile' });

    for (const client of [a, b, c]) client.close();
  });

  test('malformed messages get bad-message errors', async () => {
    const c = connect(port);
    await c.open();

    c.send('not json');
    assert.equal((await c.next('error')).code, 'bad-message');

    c.send({ type: 'join', room: 'has spaces!', name: 'X' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'join', room: 'ok', name: '   ' });
    assert.deepEqual(await c.next('error'), { type: 'error', code: 'bad-message', ref: 'join' });

    c.send({ type: 'signal', to: 'x', data: {} }); // the mesh relay is gone
    assert.equal((await c.next('error')).code, 'bad-message');
    c.close();
  });
});

describe('SFU requests', () => {
  let server;
  let port;

  before(async () => {
    server = startServer({ ...baseConfig, maxPeersPerRoom: 16 }, { log: () => {} });
    port = await server.ready;
  });

  after(() => server.close());

  test('requests before joining are rejected', async () => {
    const c = connect(port);
    await c.open();
    const res = await c.request('createTransport', { direction: 'send' });
    assert.deepEqual(res, { type: 'response', id: res.id, ok: false, error: 'not-in-room' });
    c.close();
  });

  test('createTransport advertises the host the client connected to', async () => {
    const a = await joined(port, 'sfu-transport', 'Alice');
    const res = await a.client.request('createTransport', { direction: 'send' });
    assert.equal(res.ok, true);
    const { id, iceParameters, iceCandidates, dtlsParameters } = res.data;
    assert.ok(id && iceParameters.usernameFragment && dtlsParameters.fingerprints.length);
    assert.ok(iceCandidates.length >= 1);
    for (const candidate of iceCandidates) {
      assert.equal(candidate.address, '127.0.0.1');
      assert.ok(candidate.port > 0);
    }
    assert.equal((await a.client.request('createTransport', { direction: 'sideways' })).error, 'bad-request');
    a.client.close();
  });

  test('produce -> others are told -> consume -> pause/close propagate', async () => {
    const a = await joined(port, 'sfu-flow', 'Alice');
    const b = await joined(port, 'sfu-flow', 'Bob');
    const caps = b.msg.routerRtpCapabilities;

    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });

    // Wrong kind for the source, then a valid mic producer.
    const bad = await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(bad.error, 'bad-request');
    const produced = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(produced.ok, true);
    const producerId = produced.data.id;

    const dup = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters });
    assert.equal(dup.error, 'duplicate-source');

    assert.deepEqual(await b.client.next('new-producer'), {
      type: 'new-producer',
      peerId: a.msg.id,
      producerId,
      kind: 'audio',
      source: 'mic',
      paused: false,
    });

    const consumed = await b.client.request('consume', { producerId, rtpCapabilities: caps });
    assert.equal(consumed.ok, true);
    assert.equal(consumed.data.kind, 'audio');
    assert.equal(consumed.data.source, 'mic');
    assert.equal(consumed.data.peerId, a.msg.id);
    assert.equal(consumed.data.producerPaused, false);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await b.client.request('pauseConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await b.client.request('resumeConsumer', { consumerId: consumed.data.id })).ok, true);
    assert.equal((await a.client.request('pauseConsumer', { consumerId: consumed.data.id })).ok, false); // not Alice's

    // Can't consume your own producer.
    assert.equal((await a.client.request('consume', { producerId, rtpCapabilities: caps })).error, 'unknown-producer');

    // A latecomer sees the producer in the join snapshot.
    const c = await joined(port, 'sfu-flow', 'Carol');
    const alice = c.msg.peers.find((p) => p.id === a.msg.id);
    assert.deepEqual(alice.producers, [{ id: producerId, kind: 'audio', source: 'mic', paused: false }]);

    await a.client.request('pauseProducer', { producerId });
    assert.deepEqual(await b.client.next('producer-state'), {
      type: 'producer-state',
      paused: true,
      peerId: a.msg.id,
      producerId,
    });

    await a.client.request('closeProducer', { producerId });
    assert.deepEqual(await b.client.next('producer-closed'), { type: 'producer-closed', peerId: a.msg.id, producerId });

    a.client.close();
    b.client.close();
    c.client.close();
  });

  test('screen producers carry the share mode to everyone', async () => {
    const vp8 = {
      codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      headerExtensions: [],
      encodings: [{ ssrc: 22222222 }],
      rtcp: { cname: 'test' },
    };
    const a = await joined(port, 'sfu-screen', 'Alice');
    const b = await joined(port, 'sfu-screen', 'Bob');
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });

    const badMode = await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'screen', mode: 'tab', rtpParameters: vp8 });
    assert.equal(badMode.error, 'bad-request');
    const modeOnMic = await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', mode: 'window', rtpParameters: opusRtpParameters });
    assert.equal(modeOnMic.error, 'bad-request');

    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendT.id, kind: 'video', source: 'screen', mode: 'window', rtpParameters: vp8 })
    ).data;
    const announced = await b.client.next('new-producer');
    assert.equal(announced.source, 'screen');
    assert.equal(announced.mode, 'window');

    const consumed = await b.client.request('consume', { producerId, rtpCapabilities: b.msg.routerRtpCapabilities });
    assert.equal(consumed.data.mode, 'window');

    const c = await joined(port, 'sfu-screen', 'Carol');
    assert.equal(c.msg.peers.find((p) => p.id === a.msg.id).producers[0].mode, 'window');
    for (const x of [a, b, c]) x.client.close();
  });

  test('leaving closes your producers for everyone consuming them', async () => {
    const a = await joined(port, 'sfu-leave', 'Alice');
    const b = await joined(port, 'sfu-leave', 'Bob');
    const sendT = (await a.client.request('createTransport', { direction: 'send' })).data;
    await b.client.request('createTransport', { direction: 'recv' });
    const { id: producerId } = (
      await a.client.request('produce', { transportId: sendT.id, kind: 'audio', source: 'mic', rtpParameters: opusRtpParameters })
    ).data;
    await b.client.next('new-producer');
    await b.client.request('consume', { producerId, rtpCapabilities: b.msg.routerRtpCapabilities });

    a.client.close();
    assert.equal((await b.client.next('producer-closed')).producerId, producerId);
    assert.equal((await b.client.next('peer-left')).id, a.msg.id);
    b.client.close();
  });

  test('16 people fit in one room', async () => {
    const clients = [];
    for (let i = 0; i < 16; i++) clients.push(await joined(port, 'sfu-16', `P${i}`));
    assert.equal(clients.at(-1).msg.peers.length, 15);

    const extra = connect(port);
    await extra.open();
    extra.send({ type: 'join', room: 'sfu-16', name: 'P16' });
    assert.equal((await extra.next('error')).code, 'room-full');
    for (const { client } of clients) client.close();
    extra.close();
  });
});

describe('origin allow-list', () => {
  test('rejects origins not in ALLOWED_ORIGINS and accepts listed ones', async () => {
    const server = startServer({ ...baseConfig, allowedOrigins: ['http://tauri.localhost'] }, { log: () => {} });
    const port = await server.ready;
    try {
      const bad = connect(port, { origin: 'http://evil.example' });
      await assert.rejects(bad.open(), /403/);

      const good = connect(port, { origin: 'http://tauri.localhost' });
      await good.open();
      good.close();
    } finally {
      await server.close();
    }
  });
});
