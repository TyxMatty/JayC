// Each person's profile color, shown behind their avatar while the camera is off (like Discord's
// profile colors). Someone who never picked one gets a gradient chosen from their name, so a room
// never looks like a row of identical gray boxes. Colors arrive from others validated by the server
// ({ from, to?, angle? } with #rrggbb only); they're checked again here before going into CSS.

const HEX = /^#[0-9a-f]{6}$/i;

/** Deep, saturated pairs: the white name label and the avatar circle stay readable on all of them. */
export const AUTO_COLORS = [
  { from: '#4338ca', to: '#7c3aed', angle: 135 },
  { from: '#0e7490', to: '#1d4ed8', angle: 135 },
  { from: '#047857', to: '#0f766e', angle: 135 },
  { from: '#b45309', to: '#be123c', angle: 135 },
  { from: '#9d174d', to: '#6d28d9', angle: 135 },
  { from: '#1e3a8a', to: '#0369a1', angle: 135 },
  { from: '#3f6212', to: '#047857', angle: 135 },
  { from: '#7c2d12', to: '#a21caf', angle: 135 },
];

/** Same name, same color, on every computer. */
export function autoColor(name) {
  let hash = 0;
  for (const ch of String(name ?? '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return AUTO_COLORS[hash % AUTO_COLORS.length];
}

/** A valid color as given, else null (the caller falls back to autoColor). */
export function cleanProfileColor(color) {
  if (!color || typeof color !== 'object' || !HEX.test(color.from ?? '')) return null;
  if (color.to == null) return { from: color.from };
  const angle = Number.isInteger(color.angle) && color.angle >= 0 && color.angle <= 360 ? color.angle : 135;
  return HEX.test(color.to) ? { from: color.from, to: color.to, angle } : { from: color.from };
}

/** The CSS background for someone's tile. */
export function profileBackground(color, name) {
  const c = cleanProfileColor(color) ?? autoColor(name);
  return c.to ? `linear-gradient(${c.angle}deg, ${c.from}, ${c.to})` : c.from;
}
