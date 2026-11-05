import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitGrid } from '../src/core/grid-fit.js';

test('4 people in a wide, short stage: 2x2 is too tall, so one row', () => {
  assert.deepEqual(fitGrid(4, 1068, 300, 12), { columns: 4, tileWidth: 258 });
});

test('4 people in a roomy stage: 2x2 gives bigger tiles than one row', () => {
  const { columns, tileWidth } = fitGrid(4, 1068, 470, 12);
  assert.equal(columns, 2);
  assert.ok(tileWidth > 258, `${tileWidth}`);
});

test('tiles always fit both ways', () => {
  for (const [count, width, height] of [[3, 800, 600], [7, 1400, 700], [16, 1920, 1000], [5, 360, 640]]) {
    const { columns, tileWidth } = fitGrid(count, width, height, 12);
    const rows = Math.ceil(count / columns);
    assert.ok(columns * tileWidth + 12 * (columns - 1) <= width, `${count}: too wide`);
    assert.ok(rows * ((tileWidth * 9) / 16) + 12 * (rows - 1) <= height + 1, `${count}: too tall`);
  }
});

test('a phone in portrait stacks people in one column', () => {
  assert.equal(fitGrid(3, 360, 640, 8).columns, 1);
});
