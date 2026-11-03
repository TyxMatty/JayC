import { h } from './dom.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';

// Must match the signaling server's room-name rule.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const JOIN_ERRORS = {
  'room-full': 'This room is full (4 people max).',
  unreachable: "Couldn't reach the server. Check Settings › Server.",
  timeout: "The server didn't answer. Check Settings › Server.",
  'bad-message': 'The server rejected that name or room.',
};

/**
 * "Join a room" screen.
 * @param {{ openSettings: (focus?: string) => void, openGuide: () => void, onJoin: (opts: { name: string, room: string }) => Promise<void> }} options
 */
export function createLobby({ openSettings, openGuide, onJoin }) {
  const current = settings.get();
  const cleanups = [];

  const nameInput = h('input', {
    id: 'lobby-name',
    class: 'input',
    maxlength: 32,
    autocomplete: 'nickname',
    placeholder: 'Your name',
    value: current.displayName,
    onInput: (e) => settings.update({ displayName: e.target.value }),
  });
  cleanups.push(
    settings.subscribe((next) => {
      if (document.activeElement !== nameInput && nameInput.value !== next.displayName) {
        nameInput.value = next.displayName;
      }
    }),
  );

  const roomInput = h('input', {
    id: 'lobby-room',
    class: 'input',
    maxlength: 64,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'e.g. friday-game-night',
    value: current.lastRoom,
  });

  const joinButton = h('button', { type: 'submit', class: 'btn' }, 'Join room');
  const hint = h('p', { class: 'hint', 'aria-live': 'polite' });
  let joining = false;
  let error = null;

  const update = () => {
    const { state } = serverStatus.get();
    const serverOk = state !== 'unset' && state !== 'invalid';
    const nameOk = nameInput.value.trim().length > 0;
    const roomOk = ROOM_RE.test(roomInput.value.trim());

    delete hint.dataset.tone;
    if (!serverOk) {
      hint.replaceChildren(
        'Set your signaling server first in ',
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openSettings('server')) }, 'Settings › Server'),
        '. No server yet? Read the ',
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openGuide()) }, 'setup guide'),
        '.',
      );
    } else if (roomInput.value && !roomOk) {
      hint.textContent = 'Room names use letters, numbers, - and _ only.';
      hint.dataset.tone = 'error';
    } else if (error) {
      hint.textContent = error;
      hint.dataset.tone = 'error';
    } else {
      hint.textContent = 'Everyone who enters the same room name joins the same call.';
    }

    joinButton.disabled = joining || !serverOk || !nameOk || !roomOk;
    joinButton.textContent = joining ? 'Joining…' : 'Join room';
  };

  const clearError = () => {
    error = null;
    update();
  };
  nameInput.addEventListener('input', clearError);
  roomInput.addEventListener('input', clearError);
  cleanups.push(serverStatus.subscribe(update));

  const onSubmit = async (e) => {
    e.preventDefault();
    if (joinButton.disabled) return;
    joining = true;
    error = null;
    update();
    try {
      await onJoin({ name: nameInput.value.trim(), room: roomInput.value.trim() });
    } catch (err) {
      error = JOIN_ERRORS[err?.code] ?? `Couldn't join: ${err?.message ?? err}`;
    } finally {
      joining = false;
      update();
    }
  };

  const element = h(
    'main',
    { class: 'lobby' },
    h(
      'form',
      { class: 'card', onSubmit },
      h('h1', {}, 'Join a room'),
      h('p', {}, 'Share the room name with friends on the same server.'),
      h('div', { class: 'field' }, h('label', { for: 'lobby-name' }, 'Display name'), nameInput),
      h('div', { class: 'field' }, h('label', { for: 'lobby-room' }, 'Room'), roomInput),
      h('div', { class: 'field' }, joinButton, hint),
    ),
  );

  return {
    element,
    destroy: () => cleanups.forEach((fn) => fn()),
  };
}
