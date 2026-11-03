// The call's control bar: which edge it sits on and the order of its buttons (Settings and drag).

export const CONTROLS = ['mic', 'camera', 'share', 'pip', 'leave'];
export const POSITIONS = ['bottom', 'right', 'top', 'left'];
export const DEFAULT_CALL_BAR = Object.freeze({ position: 'bottom', order: CONTROLS });

/** Known keys once each, in the saved order; any missing ones go at the end in default order. */
export function normalizeOrder(order) {
  const seen = new Set();
  const kept = (Array.isArray(order) ? order : []).filter((key) => CONTROLS.includes(key) && !seen.has(key) && seen.add(key));
  return [...kept, ...CONTROLS.filter((key) => !seen.has(key))];
}

export const normalizePosition = (position) => (POSITIONS.includes(position) ? position : 'bottom');

/** `order` with `key` moved by `delta` places (clamped). */
export function moveControl(order, key, delta) {
  const list = normalizeOrder(order).filter((k) => k !== key);
  const from = normalizeOrder(order).indexOf(key);
  list.splice(Math.max(0, Math.min(list.length, from + delta)), 0, key);
  return list;
}

/** Where a dragged button lands: how many of the other buttons' centers are before the pointer. */
export const dropIndex = (centers, pointer) => centers.filter((center) => center < pointer).length;

/** The edge of `rect` closest to the point (x, y). */
export function nearestEdge(rect, x, y) {
  const distances = { top: y - rect.top, bottom: rect.bottom - y, left: x - rect.left, right: rect.right - x };
  return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
}
