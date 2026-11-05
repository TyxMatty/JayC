// Illustrations for the "Welcome!" tour (ui/welcome-modal.js), one small scene per step.
// Trusted static SVG (like icons.js). Colors come from the theme: `currentColor` is the accent,
// the .wa-* classes map to theme variables. Motion lives in app.css (.wa-* keyframes) and only runs
// with <html data-motion="full">; otherwise each scene is a still picture.

const svg = (body) =>
  `<svg viewBox="0 0 240 140" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A person: a round avatar with head and shoulders. `cls` adds animation classes. */
const person = (x, y, r, cls = '', style = '') =>
  `<g class="${cls}" style="${style}"><circle cx="${x}" cy="${y}" r="${r}" class="wa-fill-accent"/>` +
  `<circle cx="${x}" cy="${y - r * 0.22}" r="${r * 0.32}" class="wa-fill-surface"/>` +
  `<path d="M${x - r * 0.55} ${y + r * 0.62} a${r * 0.55} ${r * 0.45} 0 0 1 ${r * 1.1} 0" class="wa-fill-surface"/></g>`;

export const WELCOME_ART = {
  // Three friends in a call; one is speaking (green ring), sound waves go out.
  welcome: svg(
    `<rect x="34" y="22" width="172" height="96" rx="12" class="wa-card"/>` +
      `<circle cx="80" cy="70" r="24" class="wa-ring wa-pulse"/>` +
      person(80, 70, 18) +
      person(130, 70, 18, 'wa-pop', '--d:120ms') +
      person(176, 70, 18, 'wa-pop', '--d:240ms') +
      `<path d="M54 52 q-8 18 0 36" class="wa-stroke-accent wa-wave"/>` +
      `<path d="M46 46 q-12 24 0 48" class="wa-stroke-accent wa-wave" style="--d:200ms"/>`,
  ),
  // A server in the middle, PCs around it, data flowing on the links; the pill turns Online.
  server: svg(
    `<path d="M120 70 L46 36 M120 70 L46 104 M120 70 L194 36 M120 70 L194 104" class="wa-link wa-flow"/>` +
      `<rect x="98" y="44" width="44" height="52" rx="8" class="wa-card"/>` +
      `<path d="M106 58 h28 M106 70 h28 M106 82 h28" class="wa-stroke-muted"/>` +
      `<circle cx="136" cy="58" r="2.5" class="wa-fill-green wa-blink"/>` +
      [
        [46, 36],
        [46, 104],
        [194, 36],
        [194, 104],
      ]
        .map(([x, y], i) => `<rect x="${x - 15}" y="${y - 11}" width="30" height="22" rx="4" class="wa-card wa-pop" style="--d:${i * 100}ms"/>`)
        .join('') +
      `<rect x="84" y="112" width="72" height="18" rx="9" class="wa-card"/>` +
      `<circle cx="96" cy="121" r="4" class="wa-fill-green wa-blink"/>` +
      `<path d="M106 121 h40" class="wa-stroke-muted"/>`,
  ),
  // A profile card whose color keeps changing, with swatches popping in.
  profile: svg(
    `<rect x="62" y="16" width="116" height="108" rx="12" class="wa-card"/>` +
      `<rect x="62" y="16" width="116" height="38" rx="12" class="wa-fill-accent wa-hue"/>` +
      `<rect x="62" y="40" width="116" height="14" class="wa-fill-accent wa-hue"/>` +
      person(120, 58, 20) +
      `<path d="M96 94 h48" class="wa-stroke-text"/>` +
      `<path d="M106 106 h28" class="wa-stroke-muted"/>` +
      ['#4338ca', '#0e7490', '#047857', '#b45309', '#9d174d']
        .map((c, i) => `<circle cx="${198 + (i % 2) * 18}" cy="${34 + i * 18}" r="7" fill="${c}" class="wa-pop" style="--d:${i * 90}ms"/>`)
        .join(''),
  ),
  // A room name, and people walking into it one by one.
  room: svg(
    `<rect x="40" y="20" width="160" height="34" rx="17" class="wa-card"/>` +
      `<path d="M58 30 l-3 14 M66 30 l-3 14 M53 34 h16 M52 40 h16" class="wa-stroke-accent"/>` +
      `<path d="M80 37 h70" class="wa-stroke-text"/>` +
      `<path d="M158 37 h24" class="wa-stroke-muted wa-caret"/>` +
      person(80, 96, 17, 'wa-walk', '--d:0ms') +
      person(120, 96, 17, 'wa-walk', '--d:250ms') +
      person(160, 96, 17, 'wa-walk', '--d:500ms'),
  ),
  // Call tiles (one speaking) and the call bar with its buttons.
  call: svg(
    `<rect x="34" y="14" width="82" height="52" rx="8" class="wa-card wa-speaking"/>` +
      `<rect x="124" y="14" width="82" height="52" rx="8" class="wa-card"/>` +
      person(75, 40, 14) +
      person(165, 40, 14) +
      `<rect x="64" y="84" width="112" height="40" rx="20" class="wa-card"/>` +
      [84, 106, 128, 150]
        .map((x, i) => `<circle cx="${x + 3}" cy="104" r="${i === 3 ? 9 : 8}" class="${i === 3 ? 'wa-fill-red' : 'wa-fill-accent'} wa-bounce" style="--d:${i * 120}ms"/>`)
        .join(''),
  ),
  // A screen being shared: moving content, a LIVE badge, viewers watching.
  share: svg(
    `<rect x="30" y="18" width="116" height="76" rx="8" class="wa-card"/>` +
      `<path d="M74 94 l-6 18 h40 l-6 -18" class="wa-card"/>` +
      `<rect x="40" y="28" width="96" height="56" rx="4" class="wa-fill-accent wa-dim"/>` +
      `<rect x="50" y="64" width="14" height="14" rx="3" class="wa-fill-surface wa-slide"/>` +
      `<path d="M48 40 h40 M48 50 h26" class="wa-stroke-surface"/>` +
      `<rect x="104" y="32" width="28" height="12" rx="6" class="wa-fill-red wa-blink"/>` +
      `<path d="M158 56 h18" class="wa-stroke-accent wa-flow"/>` +
      person(196, 34, 12, 'wa-pop', '--d:0ms') +
      person(196, 70, 12, 'wa-pop', '--d:150ms') +
      person(196, 106, 12, 'wa-pop', '--d:300ms'),
  ),
  // Chat bubbles arriving, and a pop-out video floating over another window.
  extras: svg(
    `<rect x="24" y="18" width="104" height="104" rx="10" class="wa-card"/>` +
      `<rect x="34" y="30" width="64" height="20" rx="10" class="wa-fill-muted wa-pop" style="--d:0ms"/>` +
      `<rect x="54" y="58" width="64" height="20" rx="10" class="wa-fill-accent wa-pop" style="--d:400ms"/>` +
      `<rect x="34" y="86" width="50" height="20" rx="10" class="wa-fill-muted wa-pop" style="--d:800ms"/>` +
      `<rect x="146" y="30" width="72" height="88" rx="8" class="wa-card wa-faded"/>` +
      `<g class="wa-float"><rect x="156" y="50" width="62" height="40" rx="6" class="wa-fill-accent"/>` +
      person(187, 70, 11) +
      `</g>`,
  ),
};
