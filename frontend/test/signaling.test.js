// Runs the real signaling server and drives it with the app's client (Node has a global WebSocket).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../signaling-server/src/server.js';
import { SignalingClient, SignalingError } from '../src/core/signaling.js';

const config = {
  host: '127.0.0.1',
  port: 0,
  maxPeersPerRoom: 2,
  maxMessageBytes: 64 * 1024,
  heartbeatMs: 60_000,
  allowedOrigins: [],
  iceServers: [],
  rtcPort: 0,
  rtcListenIp: '127.0.0.1',
  announcedAddress: '',
  mediasoupLogLevel: 'error',
};

const once = (target, type) => new Promise((resolve) => target.addEventListener(type, (e) => resolve(e.detail), { once: true }));

describe('SignalingClient', () => {
  let server;
  let url;

  before(async () => {
    server = startServer(config, { log: () => {} });
    url = `ws://127.0.0.1:${await server.ready}`;
  });

  after(() => server.close());

  test('joins, sees peers and gets router capabilities', async () => {
    const alice = new SignalingClient(url);
    const bob = new SignalingClient(url);

    const aJoined = await alice.join('room-a', 'Alice');
    assert.deepEqual(aJoined.peers, []);
    assert.equal(alice.id, aJoined.id);
    assert.ok(aJoined.routerRtpCapabilities.codecs.length > 0);

    const peerJoined = once(alice, 'peer-joined');
    const bJoined = await bob.join('room-a', 'Bob');
    assert.deepEqual(bJoined.peers, [{ id: alice.id, name: 'Alice', producers: [] }]);
    assert.equal((await peerJoined).name, 'Bob');

    const left = once(alice, 'peer-left');
    bob.close();
    assert.equal((await left).name, 'Bob');
    alice.close();
  });

  test('request() resolves with data or rejects with the server error code', async () => {
    const client = new SignalingClient(url);
    await client.join('room-req', 'Req');

    const transport = await client.request('createTransport', { direction: 'recv' });
    assert.ok(transport.id);
    assert.equal(transport.iceCandidates[0].address, '127.0.0.1');

    await assert.rejects(client.request('createTransport', { direction: 'nope' }), (err) => err instanceof SignalingError && err.code === 'bad-request');

    client.close();
    await assert.rejects(client.request('createTransport', { direction: 'send' }), (err) => err.code === 'not-connected');
  });

  test('rejects join with the server error code (room-full)', async () => {
    const a = new SignalingClient(url);
    const b = new SignalingClient(url);
    const c = new SignalingClient(url);
    await a.join('room-full', 'A');
    await b.join('room-full', 'B');
    await assert.rejects(c.join('room-full', 'C'), (err) => err instanceof SignalingError && err.code === 'room-full');
    a.close();
    b.close();
  });

  test('rejects join when the server is unreachable', async () => {
    const client = new SignalingClient('ws://127.0.0.1:1');
    await assert.rejects(client.join('room', 'X'), (err) => err.code === 'unreachable');
  });

  test('reconnects and re-joins after the connection drops', async () => {
    const client = new SignalingClient(url);
    await client.join('room-re', 'Re');
    const firstId = client.id;

    const rejoined = once(client, 'rejoined');
    const states = [];
    client.addEventListener('state', (e) => states.push(e.detail.state));
    // Simulate a network drop.
    for (const ws of server.wss.clients) ws.terminate();

    const msg = await rejoined;
    assert.notEqual(msg.id, firstId);
    assert.deepEqual(states.slice(0, 2), ['reconnecting', 'connecting']);
    client.close();
  });
});
