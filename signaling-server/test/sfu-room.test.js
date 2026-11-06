import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SfuRoom } from '../src/sfu-room.js';

// A stand-in for mediasoup's router: just what SfuRoom touches. Each transport's bandwidth estimate
// (availableOutgoingBitrate, bps) is set by the test, since a real one needs a connected viewer.
function fakeRouter() {
  let n = 0;
  const events = { on() {} };
  const router = {
    transports: [],
    rtpCapabilities: {},
    canConsume: () => true,
    close() {},
    async createWebRtcTransport({ appData }) {
      const transport = {
        ...events,
        id: `t${++n}`,
        appData,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
        bps: undefined,
        statsCalls: 0,
        async setMaxIncomingBitrate() {},
        async getStats() {
          transport.statsCalls++;
          return [{ availableOutgoingBitrate: transport.bps }];
        },
        async produce({ kind, appData: data, paused }) {
          return { ...events, id: `p${++n}`, kind, appData: data, paused };
        },
        async consume({ producerId, paused }) {
          return {
            ...events,
            id: `c${++n}`,
            producerId,
            kind: 'video',
            type: 'simple',
            rtpParameters: {},
            producerPaused: false,
            paused,
            async resume() {
              this.paused = false;
            },
            async pause() {
              this.paused = true;
            },
          };
        },
      };
      router.transports.push(transport);
      return transport;
    },
  };
  return router;
}

test('a screen sharer hears the slowest bandwidth among those watching, once per viewer per round', async () => {
  const router = fakeRouter();
  const room = new SfuRoom({ router, webRtcServer: {} });
  const peer = (id) => ({ id, sent: [], send(m) { this.sent.push(m); } });
  const alice = peer('alice');
  for (const p of [alice, peer('bob'), peer('carol')]) room.addPeer(p);
  const at = { announcedAddress: '127.0.0.1' };
  const video = { codecs: [], encodings: [{ ssrc: 1 }] };
  const send = await room.createTransport('alice', { direction: 'send' }, at);
  const { id: screen } = await room.produce('alice', { transportId: send.id, kind: 'video', source: 'screen', rtpParameters: video });
  await room.produce('alice', { transportId: send.id, kind: 'video', source: 'camera', rtpParameters: video });
  const viewer = {};
  for (const [name, bps] of [['bob', 3_000_000], ['carol', 8_000_000]]) {
    const { id } = await room.createTransport(name, { direction: 'recv' }, at);
    const transport = router.transports.find((t) => t.id === id);
    transport.bps = bps;
    viewer[name] = { transport, consumer: (await room.consume(name, { producerId: screen, rtpCapabilities: {} })).id };
  }
  const report = async () => {
    alice.sent.length = 0;
    await room.reportViewerBandwidth();
    return alice.sent.filter((m) => m.type === 'viewer-bandwidth').map((m) => [m.producerId, m.kbps]);
  };

  // Consumers start paused: nobody watches yet. Only the screen is reported, not the camera.
  assert.deepEqual(await report(), [[screen, null]]);
  await room.resumeConsumer('bob', { consumerId: viewer.bob.consumer });
  await room.resumeConsumer('carol', { consumerId: viewer.carol.consumer });
  assert.deepEqual(await report(), [[screen, 3000]], 'the slowest viewer');
  assert.deepEqual([viewer.bob.transport.statsCalls, viewer.carol.transport.statsCalls], [1, 1], 'one query each per round');

  await room.pauseConsumer('bob', { consumerId: viewer.bob.consumer });
  assert.deepEqual(await report(), [[screen, 8000]], 'Bob stopped watching');
  viewer.carol.transport.bps = undefined;
  assert.deepEqual(await report(), [[screen, null]], 'no estimate yet: no limit');

  // A stalled worker: the next round is skipped instead of piling up behind it.
  viewer.carol.transport.bps = 8_000_000;
  let release;
  let calls = 0;
  viewer.carol.transport.getStats = () => (calls++, new Promise((resolve) => (release = () => resolve([{ availableOutgoingBitrate: 5_000_000 }]))));
  const stalled = room.reportViewerBandwidth();
  await Promise.race([room.reportViewerBandwidth(), new Promise((resolve) => setTimeout(resolve, 200))]);
  assert.equal(calls, 1, 'the second round did not query again');
  release();
  await stalled;
  assert.deepEqual(alice.sent.filter((m) => m.type === 'viewer-bandwidth').map((m) => m.kbps).slice(-1), [5000]);
  room.close();
});
