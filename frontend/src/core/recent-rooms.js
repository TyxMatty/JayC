// The rooms you joined lately, newest first, for one-click rejoining from the lobby.

export const MAX_RECENT_ROOMS = 5;

/** `list` with `room` moved (or added) to the front, without duplicates (case-insensitive), capped. */
export function addRecentRoom(list, room) {
  const clean = Array.isArray(list) ? list.filter((r) => typeof r === 'string' && r) : [];
  return [room, ...clean.filter((r) => r.toLowerCase() !== room.toLowerCase())].slice(0, MAX_RECENT_ROOMS);
}
