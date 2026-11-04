/** How a peer is described to the others (`avatar` and `color` only when set, to keep messages small). */
export const describePeer = (peer) => ({
  id: peer.id,
  name: peer.name,
  ...(peer.avatar ? { avatar: peer.avatar } : {}),
  ...(peer.color ? { color: peer.color } : {}),
});

/**
 * In-memory room registry. Transport-agnostic: a peer is any object with
 * `id`, `name`, `room` and a `send(message)` method.
 */
export class RoomRegistry {
  /** @param {{ maxPeersPerRoom: number }} options */
  constructor({ maxPeersPerRoom }) {
    this.maxPeersPerRoom = maxPeersPerRoom;
    /** @type {Map<string, Map<string, object>>} */
    this.rooms = new Map();
  }

  /**
   * Adds `peer` to `roomId`, leaving any room it was in before.
   * @returns {{ ok: true, others: object[] } | { ok: false, code: string }}
   */
  join(roomId, peer) {
    if (peer.room === roomId) {
      return { ok: true, others: this.othersInRoom(peer) };
    }

    const room = this.rooms.get(roomId);
    if (room && room.size >= this.maxPeersPerRoom) {
      return { ok: false, code: 'room-full' };
    }

    this.leave(peer);

    const target = room ?? new Map();
    const others = [...target.values()];
    target.set(peer.id, peer);
    this.rooms.set(roomId, target);
    peer.room = roomId;

    for (const other of others) {
      other.send({ type: 'peer-joined', ...describePeer(peer) });
    }
    return { ok: true, others };
  }

  /** Removes `peer` from its room (if any) and notifies the remaining peers. */
  leave(peer) {
    if (!peer.room) return;

    const roomId = peer.room;
    const room = this.rooms.get(roomId);
    peer.room = null;
    if (!room) return;

    room.delete(peer.id);
    if (room.size === 0) {
      this.rooms.delete(roomId);
      return;
    }
    for (const other of room.values()) {
      other.send({ type: 'peer-left', id: peer.id, name: peer.name });
    }
  }

  othersInRoom(peer) {
    const room = this.rooms.get(peer.room);
    return room ? [...room.values()].filter((p) => p.id !== peer.id) : [];
  }

  stats() {
    let peers = 0;
    for (const room of this.rooms.values()) peers += room.size;
    return { rooms: this.rooms.size, peers };
  }
}
