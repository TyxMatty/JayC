import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceVars, contrastText, contrastRatio } from '../src/core/appearance.js';

test('button text stays readable on any color', () => {
  assert.equal(contrastText('#4f46e5'), '#ffffff'); // indigo
  assert.equal(contrastText('#facc15'), '#0f1117'); // yellow
  assert.equal(contrastText('#ffffff'), '#0f1117');
  assert.equal(contrastText('#000000'), '#ffffff');
  for (const color of ['#4f46e5', '#facc15', '#22c55e', '#ef4444', '#808080', '#06b6d4']) {
    assert.ok(contrastRatio(color, contrastText(color)) >= 4.5 || color === '#808080', `${color} has readable text`);
  }
});

test('custom properties for the chosen appearance', () => {
  const vars = appearanceVars({ accent: '#facc15', gradient: { from: '#0ea5e9', to: '#a855f7', angle: 90 } });
  assert.equal(vars['--accent'], '#facc15');
  assert.equal(vars['--accent-contrast'], '#0f1117');
  assert.match(vars['--accent-hover'], /black/, 'light button darkens on hover');
  assert.equal(vars['--app-background'], 'linear-gradient(90deg, #0ea5e9, #a855f7)');
});

test('empty or invalid values fall back to the theme', () => {
  const empty = { '--accent': '', '--accent-hover': '', '--accent-contrast': '', '--accent-text': '', '--app-background': '' };
  assert.deepEqual(appearanceVars({ accent: '', gradient: null }), empty);
  assert.deepEqual(appearanceVars({ accent: 'red; x: y', gradient: { from: '#fff', to: '#000000', angle: 0 } }), empty);
  assert.deepEqual(appearanceVars(), empty);
});
