// Run in the app: node scripts/cdp-eval.mjs scripts/contrast-audit.js (after scripts/dev-debug.ps1).
// Contrast of every visible text on screen against the solid background behind it (WCAG).
// Skips text over images, video and gradients (no single background color to measure).
// Returns the failures: < 4.5:1, or < 3:1 for large text (>= 24px, or >= 18.66px bold).
const parse = (c) => {
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  return { r, g, b, a };
};
const lum = ({ r, g, b }) => {
  const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});
/** The background color behind `el`, compositing translucent layers; null over an image/gradient/video. */
function backgroundOf(el) {
  const layers = [];
  for (let node = el; node; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (cs.backgroundImage !== 'none' || node.tagName === 'VIDEO' || node.tagName === 'IMG') return null;
    const c = parse(cs.backgroundColor);
    if (c && c.a > 0) {
      layers.push(c);
      if (c.a >= 1) break;
    }
  }
  let color = { r: 255, g: 255, b: 255, a: 1 };
  if (!layers.length || layers.at(-1).a < 1) color = parse(getComputedStyle(document.body).backgroundColor) ?? color;
  for (const layer of layers.reverse()) color = over(layer, color);
  return color;
}
const fails = [];
let checked = 0;
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const seen = new Set();
for (let node = walker.nextNode(); node; node = walker.nextNode()) {
  const el = node.parentElement;
  if (!node.textContent.trim() || seen.has(el)) continue;
  seen.add(el);
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) continue;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || el.closest('[hidden], dialog:not([open]), [popover]:not(:popover-open)')) continue;
  // Only what's on top at the text's position (not covered by a dialog).
  const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 8), rect.top + rect.height / 2);
  if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) continue;
  const bg = backgroundOf(el);
  if (!bg) continue;
  const fg = over(parse(cs.color), bg);
  const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  const ratio = (hi + 0.05) / (lo + 0.05);
  const size = parseFloat(cs.fontSize);
  const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
  const min = el.matches(':disabled, :disabled *') ? 0 : large ? 3 : 4.5; // disabled controls are exempt
  checked++;
  if (ratio < min) fails.push(`${ratio.toFixed(2)} "${node.textContent.trim().slice(0, 30)}" (${el.className || el.tagName})`);
}
return { checked, fails };
