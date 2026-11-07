import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, newerRelease } from '../src/core/update.js';

test('versions compare part by part, ignoring a v and a suffix', () => {
  assert.ok(compareVersions('0.4.1', '0.4.0') > 0);
  assert.ok(compareVersions('0.4.0', '0.10.0') < 0, 'numbers, not text');
  assert.equal(compareVersions('v0.4.1', '0.4.1'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('0.5.0-beta', '0.5.0'), 0);
});

test('only a newer release with a checkable installer is offered', () => {
  const latest = { version: '0.4.2', url: 'https://github.com/TyxMatty/Jay-C/releases/tag/v0.4.2', installable: true };
  assert.equal(newerRelease(latest, '0.4.1'), latest);
  assert.equal(newerRelease(latest, '0.4.2'), null, 'same version');
  assert.equal(newerRelease(latest, '0.5.0'), null, 'a dev build ahead of the release');
  assert.equal(newerRelease({ ...latest, installable: false }, '0.4.1'), null, 'nothing to install');
  assert.equal(newerRelease(null, '0.4.1'), null, 'no release yet');
});
