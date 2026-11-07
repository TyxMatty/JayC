// A home-link bottleneck in front of the test server's media port, both ways: listens on
// LISTEN_PORT, relays each client's UDP to 127.0.0.1:TARGET_PORT, and paces client -> server at
// UP_KBPS and server -> client at DOWN_KBPS (0 = no limit), each with a drop-tail queue of
// QUEUE_MS (like a router buffer). Optional EXTRA_MS of fixed delay each way. Prints
// sent/dropped per direction every 5 s.
//   node scripts/udp-shaper.mjs 40098 40001 4000 0 200 [20]
// A client goes through it when its UDP candidates point here instead of at the server: in the
// app, rewrite the port in the `createTransport` responses (a JSON.parse hook in the page); in a
// browser viewer, in the remote SDP's candidates (a setRemoteDescription hook).
// docs/spikes/10-live-nativa.md, "Engasgos, texto ilegível e a escada", was measured with it.
import dgram from 'node:dgram';

const [listenPort, targetPort, upKbps, downKbps, queueMs, extraMs = 0] = process.argv.slice(2).map(Number);
const front = dgram.createSocket('udp4');
const counts = { up: { sent: 0, dropped: 0 }, down: { sent: 0, dropped: 0 } };

/** A paced, drop-tail queue that calls `out(packet)`; rate 0 = straight through. */
function link(kbps, name, out) {
  const delayed = extraMs > 0 ? (d) => setTimeout(() => out(d), extraMs) : out;
  if (!kbps) return (d) => { counts[name].sent++; delayed(d); };
  const bytesPerMs = (kbps * 1000) / 8 / 1000;
  const maxQueue = bytesPerMs * queueMs;
  const queue = [];
  let queued = 0, credit = 0, last = performance.now();
  setInterval(() => {
    const now = performance.now();
    // Node's timers on Windows may tick only every ~15.6 ms: credit up to 25 ms keeps the rate.
    credit = Math.min(credit + (now - last) * bytesPerMs, bytesPerMs * 25 + 1500);
    last = now;
    while (queue.length && credit >= queue[0].length) {
      const d = queue.shift();
      credit -= d.length;
      queued -= d.length;
      counts[name].sent++;
      delayed(d);
    }
  }, 1);
  return (d) => {
    if (queued + d.length > maxQueue) { counts[name].dropped++; return; }
    queue.push(d);
    queued += d.length;
  };
}

const clients = new Map();
front.on('message', (msg, rinfo) => {
  const key = `${rinfo.address}:${rinfo.port}`;
  let c = clients.get(key);
  if (!c) {
    const up = dgram.createSocket('udp4');
    c = {
      toServer: link(upKbps, 'up', (d) => up.send(d, targetPort, '127.0.0.1')),
      toClient: link(downKbps, 'down', (d) => front.send(d, rinfo.port, rinfo.address)),
    };
    clients.set(key, c);
    up.on('message', (data) => c.toClient(data));
  }
  c.toServer(msg);
});
front.bind(listenPort, '127.0.0.1', () => console.log(`shaper :${listenPort} -> :${targetPort} up ${upKbps || '∞'} kbps, down ${downKbps || '∞'} kbps, queue ${queueMs} ms, +${extraMs} ms`));
setInterval(() => {
  console.log(`${new Date().toISOString().slice(11, 19)} up sent ${counts.up.sent} dropped ${counts.up.dropped} | down sent ${counts.down.sent} dropped ${counts.down.dropped}`);
  for (const k of ['up', 'down']) counts[k] = { sent: 0, dropped: 0 };
}, 5000);
