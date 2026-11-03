const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const JOIN_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 10000;

export class SignalingError extends Error {
  /** @param {'unreachable' | 'timeout' | 'room-full' | 'bad-message' | string} code */
  constructor(code) {
    super(`Signaling failed: ${code}`);
    this.code = code;
  }
}

/**
 * WebSocket client for the Jay-C signaling protocol (see docs/ARQUITETURA.md §4).
 *
 * Events (CustomEvent, payload in `detail`):
 *   state           { state: 'connecting' | 'open' | 'reconnecting' | 'closed' }
 *   rejoined        the server's `joined` message after an automatic reconnect (new id!)
 *   peer-joined     { id, name }
 *   peer-left       { id, name }
 *   new-producer    { peerId, producerId, kind, source, paused }
 *   producer-closed { peerId, producerId }
 *   producer-state  { peerId, producerId, paused }
 *   server-error    { code, ref? }
 *
 * SFU calls use `request(type, data)`, which resolves with the response data or rejects with
 * a SignalingError carrying the server's error code.
 */
export class SignalingClient extends EventTarget {
  #url;
  #ws = null;
  #room = null;
  #name = null;
  #attempt = 0;
  #reconnectTimer = null;
  #closed = true;
  #pendingJoin = null;
  #nextRequestId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function, timer: number }>} */
  #pendingRequests = new Map();

  /** Our peer id, assigned by the server on every (re)join. */
  id = null;

  constructor(url) {
    super();
    this.#url = url;
  }

  /** Connects and joins `room`. Resolves with the server's `joined` message. */
  join(room, name) {
    this.#room = room;
    this.#name = name;
    this.#closed = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#failJoin(new SignalingError('timeout')), JOIN_TIMEOUT_MS);
      this.#pendingJoin = {
        resolve: (msg) => (clearTimeout(timer), resolve(msg)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      };
      this.#open();
    });
  }

  /** Sends an SFU request and resolves with its response data. */
  request(type, data = {}) {
    if (this.#ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new SignalingError('not-connected'));
    }
    const id = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(new SignalingError('timeout'));
      }, REQUEST_TIMEOUT_MS);
      this.#pendingRequests.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ type, id, data }));
    });
  }

  close() {
    if (this.#closed && !this.#ws) return;
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    const ws = this.#ws;
    this.#ws = null;
    this.id = null;
    this.#rejectPendingRequests();
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
      ws.close();
    }
    this.#emit('state', { state: 'closed' });
  }

  #rejectPendingRequests() {
    for (const { reject, timer } of this.#pendingRequests.values()) {
      clearTimeout(timer);
      reject(new SignalingError('not-connected'));
    }
    this.#pendingRequests.clear();
  }

  #open() {
    this.#emit('state', { state: 'connecting' });
    const ws = new WebSocket(this.#url);
    this.#ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'join', room: this.#room, name: this.#name }));
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg && typeof msg.type === 'string') this.#handle(msg);
    };

    ws.onclose = () => {
      if (this.#ws !== ws) return; // closed on purpose or superseded
      this.#ws = null;
      this.id = null;
      this.#rejectPendingRequests();
      if (this.#pendingJoin) {
        this.#failJoin(new SignalingError('unreachable'));
        return;
      }
      if (this.#closed) return;
      this.#emit('state', { state: 'reconnecting' });
      const delay = RECONNECT_DELAYS_MS[Math.min(this.#attempt++, RECONNECT_DELAYS_MS.length - 1)];
      this.#reconnectTimer = setTimeout(() => this.#open(), delay);
    };
  }

  #handle(msg) {
    switch (msg.type) {
      case 'joined':
        this.id = msg.id;
        this.#attempt = 0;
        this.#emit('state', { state: 'open' });
        if (this.#pendingJoin) {
          const { resolve } = this.#pendingJoin;
          this.#pendingJoin = null;
          resolve(msg);
        } else {
          this.#emit('rejoined', msg);
        }
        return;

      case 'error':
        if (this.#pendingJoin && msg.ref === 'join') {
          this.#failJoin(new SignalingError(msg.code));
        } else {
          this.#emit('server-error', msg);
        }
        return;

      case 'response': {
        const pending = this.#pendingRequests.get(msg.id);
        if (!pending) return;
        this.#pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new SignalingError(msg.error ?? 'internal'));
        return;
      }

      case 'peer-joined':
      case 'peer-left':
      case 'new-producer':
      case 'producer-closed':
      case 'producer-state':
        this.#emit(msg.type, msg);
    }
  }

  #failJoin(error) {
    const pending = this.#pendingJoin;
    if (!pending) return;
    this.#pendingJoin = null;
    this.close();
    pending.reject(error);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
