// The call's control bar: which edge it sits on and the order of its buttons (Settings and drag).

export const CONTROLS = ['mic', 'deafen', 'camera', 'share', 'chat', 'pip', 'leave'];
export const POSITIONS = ['bottom', 'right', 'top', 'left'];
/** Button shape: 'auto' (the style's), 'round' or 'square' (<html data-call-shape>, styles/theme.css). */
export const BUTTON_SHAPES = ['auto', 'round', 'square'];
export const DEFAULT_CALL_BAR = Object.freeze({ position: 'bottom', order: CONTROLS, shape: 'auto' });

/**
 * Known keys once each, in the saved order. A missing one (e.g. a button added in an update) goes
 * right after its neighbor in the default order, so "deafen" lands next to "mic".
 */
export function normalizeOrder(order) {
  const seen = new Set();
  const list = (Array.isArray(order) ? order : []).filter((key) => CONTROLS.includes(key) && !seen.has(key) && seen.add(key));
  CONTROLS.forEach((key, i) => {
    if (seen.has(key)) return;
    const before = CONTROLS.slice(0, i).findLast((k) => seen.has(k));
    list.splice(before ? list.indexOf(before) + 1 : 0, 0, key);
    seen.add(key);
  });
  return list;
}

export const normalizePosition = (position) => (POSITIONS.includes(position) ? position : 'bottom');
export const normalizeShape = (shape) => (BUTTON_SHAPES.includes(shape) ? shape : 'auto');

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
