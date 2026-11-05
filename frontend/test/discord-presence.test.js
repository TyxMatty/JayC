import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presenceActivity, startDiscordPresence } from '../src/core/discord-presence.js';
import { setLanguage } from '../src/core/i18n.js';

const base = { people: 3, sharing: false, watching: false, room: 'vision', showRoom: false, since: 1_700_000_000_000, style: 'neon' };

test('in a call: people and time, no room name unless asked', () => {
  setLanguage('en');
  assert.deepEqual(presenceActivity(base), {
    details: 'In a call',
    state: 'Talking',
    timestamps: { start: 1_700_000_000_000 },
    assets: { large_image: 'jayc_neon', large_text: 'Jay-C' },
    party: { size: [3, 16] },
  });
  assert.equal(presenceActivity({ ...base, showRoom: true }).details, 'In room #vision');
  assert.deepEqual(presenceActivity({ ...base, people: 20 }).party.size, [20, 20], 'never more people than the max');
  const wolf = (style) => presenceActivity({ ...base, style }).assets.large_image;
  assert.deepEqual([wolf('calm'), wolf('soft'), wolf(undefined)], ['jayc_purple', 'jayc_orange_thick', 'jayc_purple'], "each style's wolf");
});

test('streams show without names, with the live icon', () => {
  setLanguage('pt-BR');
  const sharing = presenceActivity({ ...base, sharing: true, watching: true });
  assert.equal(sharing.state, 'Transmitindo a tela', 'our own stream wins');
  assert.deepEqual(sharing.assets, { large_image: 'jayc_neon', large_text: 'Jay-C', small_image: 'live', small_text: 'Ao vivo' });
  assert.equal(presenceActivity({ ...base, watching: true }).state, 'Assistindo uma live');
  assert.equal(presenceActivity(base).details, 'Numa chamada');
  setLanguage('en');
});

test('follows the call: one status per change, nothing for unrelated events, one clear on leave', async () => {
  // A fake Windows app: what reaches Rust's discord_presence.
  const sent = [];
  globalThis.window = globalThis;
  globalThis.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => (cmd === 'discord_presence' ? sent.push(args.activity) : cmd === 'plugin:system-audio|is_supported'),
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const call = Object.assign(new EventTarget(), { participants: new Map(), sharing: false });
  const emit = (type) => call.dispatchEvent(new Event(type));
  try {
    startDiscordPresence(call, { room: 'vision' });
    await settle();
    assert.deepEqual(sent.map((a) => a.party.size[0]), [1], 'alone in the room');

    call.participants.set('a', { media: { screen: false }, watching: false });
    emit('participant-added');
    emit('participant-updated');
    await settle();
    assert.deepEqual(sent.map((a) => a.party.size[0]), [1, 2], 'a join (and its burst) is one update');

    emit('participant-updated'); // a mute, a preview...: same status
    await settle();
    assert.equal(sent.length, 2);

    call.participants.get('a').media.screen = true;
    call.participants.get('a').watching = true;
    emit('participant-updated');
    await settle();
    assert.equal(sent.at(-1).state, 'Watching a stream');

    // leave(): everyone removed, then 'ended', in one go.
    call.participants.clear();
    emit('participant-removed');
    emit('ended');
    await settle();
    assert.deepEqual(sent.slice(3), [null], 'cleared, without a last "1 of 16" first');
  } finally {
    delete globalThis.__TAURI_INTERNALS__;
    delete globalThis.window;
  }
});
