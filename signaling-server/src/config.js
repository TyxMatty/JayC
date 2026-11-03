function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a non-negative integer)`);
  }
  return value;
}

function json(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${name}: not valid JSON`);
  }
}

export function loadConfig() {
  return {
    host: process.env.HOST || '0.0.0.0',
    port: int('PORT', 3000),
    maxPeersPerRoom: int('MAX_PEERS_PER_ROOM', 16),
    maxMessageBytes: int('MAX_MESSAGE_BYTES', 64 * 1024),
    heartbeatMs: int('HEARTBEAT_MS', 30_000),
    // Empty list = accept any origin (typical for a LAN/VPN self-hosted server).
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Forwarded to clients on join, e.g. [{"urls":"turn:host:3478","username":"u","credential":"p"}]
    iceServers: json('ICE_SERVERS', []),

    // ---- SFU (mediasoup) ----
    // Single UDP+TCP port for all media (0 = random, used by tests).
    rtcPort: int('RTC_PORT', 40000),
    rtcListenIp: process.env.RTC_LISTEN_IP || '0.0.0.0',
    // Address put in ICE candidates. Empty = the host each client used to reach the signaling server.
    announcedAddress: process.env.ANNOUNCED_ADDRESS || '',
    mediasoupLogLevel: process.env.MEDIASOUP_LOG_LEVEL || 'warn',
  };
}
