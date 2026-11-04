import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDiagnostics } from '../src/core/diagnostics.js';

// A consumer whose inbound-rtp counters advance between the two samples.
const consumer = (kind, steps) => {
  let n = 0;
  return {
    kind,
    track: { readyState: 'live', muted: false, enabled: true },
    async getStats() {
      const s = steps[Math.min(n++, steps.length - 1)];
      return new Map([['x', { type: 'inbound-rtp', packetsReceived: s[0], bytesReceived: s[1], totalAudioEnergy: s[2] }]]);
    },
  };
};

test('reports rates, played energy and the media element per participant', async () => {
  const stream = { getTracks: () => [1] };
  const screenStream = { getTracks: () => [] };
  const call = {
    room: 'r',
    micOn: true,
    cameraOn: false,
    micDevice: 'Mic (Realtek)',
    participants: new Map([
      ['a', {
        name: 'Ana',
        stream,
        screenStream,
        consumers: new Map([
          ['p1', { source: 'mic', paused: false, consumer: consumer('audio', [[0, 0, 0], [1, 80, 0]]) }],
          ['p2', { source: 'camera', paused: false, consumer: consumer('video', [[0, 0], [2, 5000]]) }],
        ]),
      }],
    ]),
  };
  const root = { querySelectorAll: () => [{ srcObject: stream, paused: false, muted: false, volume: 1, readyState: 4, sinkId: '' }] };
  const devices = async () => [{ kind: 'audiooutput', label: 'Speakers' }, { kind: 'audioinput', label: 'Mic' }];

  const d = await callDiagnostics(call, { sampleMs: 20, root, devices });
  assert.deepEqual(d.audioOutputs, ['Speakers']);
  assert.equal(d.me.micDevice, 'Mic (Realtek)');
  const [ana] = d.participants;
  assert.deepEqual(ana.player, { paused: false, muted: false, volume: 1, readyState: 4, sinkId: 'default' });
  assert.equal(ana.screenPlayer, undefined);
  // Audio arrives (50 packets/s) but nothing is played out: the bug's signature.
  assert.deepEqual(ana.receiving[0], { source: 'mic', producerPaused: false, track: 'live', packetsPerSec: 50, kbps: 32, playedEnergy: 0 });
  assert.equal(ana.receiving[1].packetsPerSec, 100);
  assert.equal('playedEnergy' in ana.receiving[1], false);
});
