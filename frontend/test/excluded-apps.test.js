import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addExcludedApp, removeExcludedApp, isExcluded } from '../src/core/excluded-apps.js';

test('adds executable names once, whatever the case or ".exe"', () => {
  let list = addExcludedApp([], ' Discord ');
  assert.deepEqual(list, ['Discord.exe']);
  assert.equal(addExcludedApp(list, 'discord.EXE'), list, 'duplicate keeps the same list');
  assert.equal(addExcludedApp(list, '   '), list, 'blank is ignored');
  assert.equal(addExcludedApp(list, '.exe'), list, 'no name is ignored');
  list = addExcludedApp(list, 'ms-teams.exe');
  assert.deepEqual(list, ['Discord.exe', 'ms-teams.exe']);
  assert.ok(isExcluded(list, 'MS-TEAMS'));
  assert.ok(!isExcluded(list, 'DiscordPTB.exe'));
});

test('removes by the same key', () => {
  assert.deepEqual(removeExcludedApp(['Discord.exe', 'Zoom.exe'], 'discord'), ['Zoom.exe']);
});
