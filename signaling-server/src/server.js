import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomRegistry, describePeer } from './rooms.js';
import { TokenBucket } from './rate-limit.js';
import { loadConfig } from './config.js';
import { Sfu, resolveAnnouncedAddress } from './sfu.js';

const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME_LENGTH = 32;
/** A 128 px WebP from the app is ~5-15 KB as a data URL; this leaves room without letting it grow. */
const MAX_AVATAR_LENGTH = 32_000;
// Raster images only (an SVG can carry scripts), inline only (a remote URL would track viewers).
const AVATAR_RE = /^data:image\/(?:webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/;

/** SFU requests: `{ type, id, data }` -> `{ type: 'response', id, ok, data | error }`. */
const REQUESTS = new Set([
  'createTransport',
  'closeTransport',
  'connectTransport',
  'restartIce',
  'produce',
  'closeProducer',
  'pauseProducer',
  'resumeProducer',
  'consume',
  'resumeConsumer',
  'pauseConsumer',
  'setPreferredLayers',
]);

function defaultLog(level, message, extra) {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  (level === 'error' ? console.error : console.log)(extra ? `${line} ${JSON.stringify(extra)}` : line);
}

function cleanName(value) {
  if (typeof value !== 'string') return null;
  // Drop control characters, collapse whitespace.
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : null;
}

const MAX_CHAT_LENGTH = 500;

/** A chat message: line breaks kept, other control and format characters (e.g. bidi overrides)
 * removed; null when empty, too long or not a string. */
function cleanChat(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\r\n?/g, '\n').replace(/[^\P{Cc}\n]|\p{Cf}/gu, '').trim();
  return text.length > 0 && text.length <= MAX_CHAT_LENGTH ? text : null;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The profile color as sent: { from, to?, angle? } (a solid color, or a gradient when `to` is set).
 * Only hex colors and an integer angle get through, never free CSS. null when absent, undefined when invalid.
 */
function cleanColor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { from, to = null, angle = 135 } = value;
  if (typeof from !== 'string' || !HEX_COLOR.test(from)) return undefined;
  if (to !== null && (typeof to !== 'string' || !HEX_COLOR.test(to))) return undefined;
  if (!Number.isInteger(angle) || angle < 0 || angle > 360) return undefined;
  return to ? { from: from.toLowerCase(), to: to.toLowerCase(), angle } : { from: from.toLowerCase() };
}

/** The profile picture as sent: null when absent, undefined when invalid. */
function cleanAvatar(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && value.length <= MAX_AVATAR_LENGTH && AVATAR_RE.test(value) ? value : undefined;
}

/**
 * Starts the HTTP + WebSocket signaling server and its mediasoup SFU.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{ log?: typeof defaultLog }} [options]
 */
export function startServer(config, { log = defaultLog } = {}) {
  const registry = new RoomRegistry({ maxPeersPerRoom: config.maxPeersPerRoom });
  const sfuReady = Sfu.create(config, log);
  const startedAt = Date.now();

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: Math.round((Date.now() - startedAt) / 1000), ...registry.stats() }));
      return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Jay-C signaling server\n');
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      log('warn', 'rejected origin', { origin });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  /** Leaves the current room: membership (notifies roommates) and SFU state. */
  async function leaveRoom(peer) {
    const roomId = peer.room;
    if (!roomId) return;
    registry.leave(peer);
    const sfu = await sfuReady;
    (await sfu.room(roomId)).removePeer(peer.id);
    await sfu.closeRoomIfEmpty(roomId);
  }

  wss.on('connection', (ws, req) => {
    // Joining a full room costs ~2 requests per remote producer; leave headroom.
    const bucket = new TokenBucket({ capacity: 300, perSecond: 100 });
    // Chat fans out to the whole room, so it gets a much smaller budget of its own.
    const chatBucket = new TokenBucket({ capacity: 10, perSecond: 2 });
    const peer = {
      id: randomUUID(),
      name: null,
      avatar: null,
      color: null,
      room: null,
      announcedAddress: null,
      send(message) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
    };
    const fail = (code, ref) => peer.send({ type: 'error', code, ...(ref ? { ref } : {}) });

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    log('info', 'connected', { peer: peer.id, ip: req.socket.remoteAddress });

    async function join(msg) {
      const name = cleanName(msg.name);
      const avatar = cleanAvatar(msg.avatar);
      const color = cleanColor(msg.color);
      if (typeof msg.room !== 'string' || !ROOM_RE.test(msg.room) || !name || avatar === undefined || color === undefined) {
        return fail('bad-message', 'join');
      }
      if (peer.room && peer.room !== msg.room) await leaveRoom(peer);

      peer.name = name;
      peer.avatar = avatar;
      peer.color = color;
      const result = registry.join(msg.room, peer);
      if (!result.ok) return fail(result.code, 'join');

      const room = await (await sfuReady).room(msg.room);
      room.addPeer(peer);
      peer.send({
        type: 'joined',
        id: peer.id,
        room: msg.room,
        peers: result.others.map((p) => ({ ...describePeer(p), producers: room.producersOf(p.id) })),
        iceServers: config.iceServers,
        routerRtpCapabilities: room.rtpCapabilities,
      });
      log('info', 'joined', { peer: peer.id, room: msg.room, size: result.others.length + 1 });
    }

    async function request(msg) {
      const respond = (body) => peer.send({ type: 'response', id: msg.id, ...body });
      if (!peer.room) return respond({ ok: false, error: 'not-in-room' });
      try {
        const room = await (await sfuReady).room(peer.room);
        peer.announcedAddress ??= await resolveAnnouncedAddress(req.headers.host, config.announcedAddress);
        const data = await room[msg.type](peer.id, msg.data ?? {}, { announcedAddress: peer.announcedAddress });
        respond({ ok: true, data: data ?? null });
      } catch (error) {
        // SfuError carries a protocol code; mediasoup throws TypeError for invalid parameters.
        const code = error?.code ?? (error instanceof TypeError ? 'bad-request' : 'internal');
        if (code === 'internal') log('error', `${msg.type} failed`, { peer: peer.id, error: error?.message });
        respond({ ok: false, error: code });
      }
    }

    ws.on('message', (raw, isBinary) => {
      if (!bucket.take()) return fail('rate-limited');
      if (isBinary) return fail('bad-message');

      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return fail('bad-message');
      }
      if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') {
        return fail('bad-message');
      }

      if (msg.type === 'join') {
        join(msg).catch((error) => {
          log('error', 'join failed', { peer: peer.id, error: error?.message });
          fail('internal', 'join');
        });
      } else if (msg.type === 'profile') {
        // A new profile picture or color mid-call: the others get it right away.
        const avatar = cleanAvatar(msg.avatar);
        const color = cleanColor(msg.color);
        if (avatar === undefined || color === undefined) return fail('bad-message', 'profile');
        if (!peer.room) return fail('not-in-room', 'profile');
        peer.avatar = avatar;
        peer.color = color;
        for (const other of registry.othersInRoom(peer)) other.send({ type: 'peer-updated', id: peer.id, avatar, color });
      } else if (msg.type === 'chat') {
        // Relayed to the others in the room; nothing is stored (late joiners don't see history).
        if (!peer.room) return fail('not-in-room', 'chat');
        if (!chatBucket.take()) return fail('rate-limited', 'chat');
        const text = cleanChat(msg.text);
        if (text === null) return fail('bad-message', 'chat');
        for (const other of registry.othersInRoom(peer)) other.send({ type: 'chat', id: peer.id, name: peer.name, text });
      } else if (msg.type === 'leave') {
        leaveRoom(peer).catch(() => {});
      } else if (REQUESTS.has(msg.type) && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        request(msg);
      } else {
        fail('bad-message');
      }
    });

    ws.on('close', () => {
      leaveRoom(peer).catch(() => {});
      log('info', 'disconnected', { peer: peer.id });
    });

    ws.on('error', (err) => log('error', 'socket error', { peer: peer.id, error: err.message }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  // Accept connections only once the SFU is up.
  const ready = sfuReady.then(
    () =>
      new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.port, config.host, () => {
          httpServer.off('error', reject);
          resolve(httpServer.address().port);
        });
      }),
  );

  async function close() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    await new Promise((resolve) => wss.close(resolve));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    (await sfuReady.catch(() => null))?.close();
  }

  return { ready, close, registry, wss, sfu: sfuReady };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = loadConfig();
  const server = startServer(config);
  const port = await server.ready;
  defaultLog('info', `Jay-C signaling server listening on ${config.host}:${port}, media on port ${config.rtcPort || 'random'}`);

  const shutdown = async (signal) => {
    defaultLog('info', `${signal} received, shutting down`);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
