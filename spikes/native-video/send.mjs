// Joins a Jay-C room as "Native" through the signaling protocol and publishes a screen share from
// the Rust sender over a normal WebRtcTransport (same media port as the app), doing the
// createTransport -> connectTransport -> produce steps that mediasoup-client does in the app.
//
//   node spikes/native-video/send.mjs [ws://localhost:3001] [room=spike] [seconds=30] [fps=60] [max kbps=6000]
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [url = 'ws://localhost:3001', room = 'spike', seconds = '30', fps = '60', kbps = '6000'] = process.argv.slice(2);
const exe = join(homedir(), '.cargo-target', 'jay-c', 'release', 'native-video-spike.exe');
// Must match spikes/native-video/src/webrtc.rs and str0m's standard extension ids.
const PT = 102;
const RTX_PT = 103;

const ws = new WebSocket(url);
await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
const waiting = new Map();
let nextId = 1;
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const key = msg.type === 'response' ? msg.id : msg.type;
  waiting.get(key)?.(msg);
  waiting.delete(key);
};
const next = (key) => new Promise((resolve) => waiting.set(key, resolve));
async function request(type, data) {
  const id = nextId++;
  const reply = next(id);
  ws.send(JSON.stringify({ type, id, data }));
  const msg = await reply;
  if (!msg.ok) throw new Error(`${type}: ${msg.error}`);
  return msg.data;
}

const joined = next('joined');
ws.send(JSON.stringify({ type: 'join', room, name: 'Native' }));
console.log('joined as', (await joined).id);
const transport = await request('createTransport', { direction: 'send' });
const candidate = transport.iceCandidates.find((c) => c.protocol === 'udp');
const fingerprint = transport.dtlsParameters.fingerprints.find((f) => f.algorithm === 'sha-256');
console.log(`ICE to ${candidate.ip}:${candidate.port}`);

const child = spawn(exe, [
  seconds,
  fps,
  kbps,
  '-',
  transport.iceParameters.usernameFragment,
  transport.iceParameters.password,
  `${candidate.ip}:${candidate.port}`,
  `sha-256 ${fingerprint.value}`,
]);
child.stderr.pipe(process.stderr);
const lines = createInterface({ input: child.stdout });
let local = null;
for await (const line of lines) {
  if (local) {
    console.log(line);
    continue;
  }
  local = JSON.parse(line);
  const [algorithm, value] = local.fingerprint.split(' ');
  await request('connectTransport', { transportId: transport.id, dtlsParameters: { role: 'client', fingerprints: [{ algorithm, value }] } });
  const feedback = [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'transport-cc' }];
  await request('produce', {
    transportId: transport.id,
    kind: 'video',
    source: 'screen',
    mode: 'screen',
    rtpParameters: {
      mid: '0',
      codecs: [
        {
          mimeType: 'video/H264',
          payloadType: PT,
          clockRate: 90000,
          parameters: { 'packetization-mode': 1, 'profile-level-id': '640032', 'level-asymmetry-allowed': 1 },
          rtcpFeedback: feedback,
        },
        { mimeType: 'video/rtx', payloadType: RTX_PT, clockRate: 90000, parameters: { apt: PT }, rtcpFeedback: [] },
      ],
      headerExtensions: [
        { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 2 },
        { uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', id: 3 },
        { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 4 },
      ],
      encodings: [{ ssrc: local.ssrc, rtx: { ssrc: local.rtxSsrc } }],
      rtcp: { cname: 'jayc-native' },
    },
  });
  console.log('producing');
}
ws.close();
