import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrastRatio } from '../src/core/appearance.js';
import { STYLES } from '../src/core/style.js';

// The hex tokens of each block in theme.css, keyed by its selector.
const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
const blocks = new Map();
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const vars = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, k, v]) => [k, v.toLowerCase()]));
  for (const part of selector.replace(/\/\*[\s\S]*?\*\//g, '').split(',')) {
    const key = part.trim();
    blocks.set(key, { ...blocks.get(key), ...vars });
  }
}

/** Colors as the cascade resolves them for a style and theme (same order as theme.css). */
function palette(style, theme) {
  const layers = [':root'];
  if (theme === 'dark') layers.push(":root[data-theme='dark']");
  if (style !== 'calm') layers.push(`:root[data-style='${style}']`);
  if (style !== 'calm' && theme === 'dark') layers.push(`:root[data-style='${style}'][data-theme='dark']`);
  return Object.assign({}, ...layers.map((l) => blocks.get(l) ?? assert.fail(`no block ${l}`)));
}

for (const style of STYLES) {
  for (const theme of ['light', 'dark']) {
    test(`${style} / ${theme}: text and controls are readable`, () => {
      const p = palette(style, theme);
      const check = (fg, bg, min) => {
        const ratio = contrastRatio(p[fg], p[bg]);
        assert.ok(ratio >= min, `${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
      };
      for (const bg of ['--bg', '--surface', '--surface-2', '--surface-3']) {
        check('--text', bg, 7);
        check('--text-muted', bg, 4.5);
      }
      check('--accent-contrast', '--accent', 4.5); // button labels
      check('--accent', '--surface', 3); // accent as an icon or ring
      check('--danger', '--surface', 4.5); // error text
      assert.ok(contrastRatio('#ffffff', p['--danger-fill']) >= 4.5, 'white on --danger-fill');
      check('--speaking', '--surface', 3); // the speaking ring
      check('--success', '--surface', 3);
    });
  }
}
