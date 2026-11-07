import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeQuality, nativeRtpParameters, avcCodec } from '../src/core/native-live.js';

test('the picked quality becomes the top of the native ladder', () => {
  const screen = { width: 1920, height: 1080 };
  assert.deepEqual(nativeQuality({ resolution: '720', fps: 30 }, screen, 1), { maxHeight: 720, maxFps: 30, maxKbps: 2212, motion: false });
  // "Optimize for": motion gives up resolution first in Rust's ladder; detail (text), frame rate.
  assert.equal(nativeQuality({ resolution: '1080', fps: 60, optimizeFor: 'motion' }, screen, 1).motion, true);
  assert.equal(nativeQuality({ resolution: '1080', fps: 60, optimizeFor: 'detail' }, screen, 1).motion, false);
  // "Source" leaves the height to the monitor; the bitrate cap counts its real pixels (125% scaling).
  const source = nativeQuality({ resolution: 'source', fps: 60 }, { width: 1536, height: 864 }, 1.25);
  assert.equal(source.maxHeight, null);
  assert.equal(source.maxKbps, 7465);
  // Asking above the monitor caps the bitrate at the monitor's size.
  assert.equal(nativeQuality({ resolution: '1440', fps: 30 }, screen, 1).maxKbps, nativeQuality({ resolution: '1080', fps: 30 }, screen, 1).maxKbps);
});

test('the native producer matches what the Rust sender puts on the wire', () => {
  const p = nativeRtpParameters({ ssrc: 1111, rtxSsrc: 2222 });
  assert.equal(p.mid, '0');
  const [h264, rtx] = p.codecs;
  assert.equal(h264.payloadType, 102);
  assert.equal(h264.parameters['profile-level-id'], '640032');
  assert.ok(h264.rtcpFeedback.some((f) => f.type === 'transport-cc'), 'bandwidth estimation needs TWCC feedback');
  assert.deepEqual(rtx.parameters, { apt: 102 }, 'str0m only resends over RTX');
  assert.deepEqual(
    Object.fromEntries(p.headerExtensions.map((e) => [e.id, e.uri.split(/[/:]/).at(-1)])),
    { 2: 'abs-send-time', 3: 'draft-holmer-rmcat-transport-wide-cc-extensions-01', 4: 'mid' },
  );
  assert.deepEqual(p.encodings, [{ ssrc: 1111, rtx: { ssrc: 2222 } }]);
});

test('the decoder codec comes from the keyframe\'s SPS', () => {
  // start code, SPS (High = 100, constraints 0, level 4.2), PPS, start of an IDR
  const keyframe = new Uint8Array([0, 0, 0, 1, 0x67, 100, 0, 42, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88]);
  assert.equal(avcCodec(keyframe), 'avc1.64002a');
  assert.equal(avcCodec(new Uint8Array([0, 0, 1, 0x65, 0x88])), 'avc1.640032', 'no SPS: what the encoder sends');
});
