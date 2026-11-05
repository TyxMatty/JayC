// Joins a Jay-C room as "Native" through the signaling protocol, opens a plain RTP transport with a
// screen producer, and runs the Rust sender against it (docs/spikes/10-live-nativa.md).
//
//   node spikes/native-video/send.mjs [ws://localhost:3001] [room=spike] [seconds=30] [fps=60] [kbps=6000]
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [url = 'ws://localhost:3001', room = 'spike', seconds = '30', fps = '60', kbps = '6000'] = process.argv.slice(2);
const exe = join(homedir(), '.cargo-target', 'jay-c', 'release', 'native-video-spike.exe');

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
const transport = await request('createTransport', { direction: 'send', plain: true });
const ssrc = (Math.random() * 0xffffffff) >>> 0;
const payloadType = 102;
await request('produce', {
  transportId: transport.id,
  kind: 'video',
  source: 'screen',
  mode: 'screen',
  rtpParameters: {
    codecs: [
      {
        mimeType: 'video/H264',
        payloadType,
        clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '640032', 'level-asymmetry-allowed': 1 },
        rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
      },
    ],
    encodings: [{ ssrc }],
  },
});
console.log(`sending to ${transport.ip}:${transport.port}`);
const child = spawn(exe, [seconds, fps, kbps, '-', `${transport.ip}:${transport.port}`, String(ssrc), String(payloadType)], { stdio: 'inherit' });
child.on('exit', (code) => {
  ws.close();
  process.exit(code ?? 1);
});
