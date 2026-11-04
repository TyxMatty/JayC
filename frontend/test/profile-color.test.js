import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoColor, AUTO_COLORS, cleanProfileColor, profileBackground } from '../src/core/profile-color.js';

test('a chosen color becomes the tile background', () => {
  assert.equal(profileBackground({ from: '#112233' }, 'Ana'), '#112233');
  assert.equal(profileBackground({ from: '#112233', to: '#445566', angle: 90 }, 'Ana'), 'linear-gradient(90deg, #112233, #445566)');
});

test('no color (or a bad one) falls back to a stable color from the name', () => {
  assert.deepEqual(autoColor('Ana'), autoColor('Ana'));
  assert.ok(AUTO_COLORS.includes(autoColor('Beto')));
  const names = ['Ana', 'Beto', 'Carla', 'Davi', 'Eva', 'Fábio', 'Gil', 'Hana'];
  assert.ok(new Set(names.map((n) => autoColor(n).from)).size >= 4, 'names spread over the palette');
  // Never free CSS into the style attribute, even if something slipped past the server.
  for (const bad of [null, { from: 'red' }, { from: '#112233; background:url(x)' }, { from: 'url(x)' }]) {
    const css = profileBackground(bad, 'Ana');
    const auto = autoColor('Ana');
    assert.equal(css, `linear-gradient(${auto.angle}deg, ${auto.from}, ${auto.to})`, JSON.stringify(bad));
  }
  assert.deepEqual(cleanProfileColor({ from: '#112233', to: 'nope' }), { from: '#112233' });
  assert.deepEqual(cleanProfileColor({ from: '#112233', to: '#445566', angle: 999 }), { from: '#112233', to: '#445566', angle: 135 });
});
