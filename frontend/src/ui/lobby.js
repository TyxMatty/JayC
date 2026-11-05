import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { profileBackground } from '../core/profile-color.js';
import { t } from '../core/i18n.js';

// Must match the signaling server's room-name rule.
const ROOM_RE = /^[A-Za-z0-9_-]{1,64}$/;

const JOIN_ERRORS = {
  'room-full': 'This room is full.',
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
    placeholder: t('Your name'),
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
    class: 'input input-with-prefix',
    maxlength: 64,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: t('e.g. friday-game-night'),
    value: current.lastRoom,
  });

  // Rooms joined lately: one click joins again.
  const recentList = h('div', { class: 'recent-rooms', role: 'group', 'aria-labelledby': 'recent-rooms-label' });
  const recentField = h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'recent-rooms-label' }, t('Recent rooms')), recentList);
  const renderRecent = () => {
    const { recentRooms, lastRoom } = settings.get();
    const rooms = recentRooms.length ? recentRooms : lastRoom ? [lastRoom] : [];
    recentField.hidden = rooms.length === 0;
    recentList.replaceChildren(
      ...rooms.map((room) =>
        h(
          'button',
          {
            type: 'button',
            class: 'room-chip-btn',
            'aria-label': t('Join {room}', { room }),
            onClick: () => {
              roomInput.value = room;
              clearError();
              if (!joinButton.disabled) form.requestSubmit();
              else roomInput.focus();
            },
          },
          h('span', { class: 'room-chip-hash', 'aria-hidden': 'true' }, '#'),
          room,
        ),
      ),
    );
  };

  // How others see you: profile color, picture or initial, and name (Settings › Profile edits it).
  const profileAvatar = h('div', { class: 'lobby-profile-avatar', 'aria-hidden': 'true' });
  const profileName = h('strong', { class: 'lobby-profile-name' });
  const profile = h(
    'div',
    { class: 'lobby-profile' },
    h('div', { class: 'lobby-profile-banner' }),
    h(
      'div',
      { class: 'lobby-profile-row' },
      profileAvatar,
      profileName,
      h('button', { type: 'button', class: 'btn btn-secondary btn-small', onClick: () => openSettings('profile') }, t('Edit profile')),
    ),
  );
  const renderProfile = () => {
    const { displayName, avatar, profileColor } = settings.get();
    const name = displayName.trim();
    profile.style.setProperty('--tile-bg', profileBackground(profileColor, name));
    profileName.textContent = name || t('Pick a name below');
    profileAvatar.replaceChildren(avatar ? h('img', { src: avatar, alt: '' }) : (name[0] ?? '?').toUpperCase());
  };
  cleanups.push(
    settings.subscribe((next, prev) => {
      if (next.displayName !== prev.displayName || next.avatar !== prev.avatar || next.profileColor !== prev.profileColor) renderProfile();
      if (next.recentRooms !== prev.recentRooms || next.lastRoom !== prev.lastRoom) renderRecent();
    }),
  );

  const joinLabel = h('span', {}, t('Join room'));
  const joinButton = h('button', { type: 'submit', class: 'btn btn-large' }, joinLabel, h('span', { class: 'btn-icon-end', html: icons.arrowRight, 'aria-hidden': 'true' }));
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
        t('Set your signaling server first in '),
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openSettings('server')) }, t('Settings › Server')),
        t('. No server yet? Read the '),
        h('a', { href: '#', onClick: (e) => (e.preventDefault(), openGuide()) }, t('setup guide')),
        t('.'),
      );
    } else if (roomInput.value && !roomOk) {
      hint.textContent = t('Room names use letters, numbers, - and _ only.');
      hint.dataset.tone = 'error';
    } else if (error) {
      hint.textContent = error;
      hint.dataset.tone = 'error';
    } else {
      hint.textContent = ''; // the card's intro already says it; this line is for errors and setup
    }

    joinButton.disabled = joining || !serverOk || !nameOk || !roomOk;
    joinLabel.textContent = joining ? t('Joining…') : t('Join room');
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
      error = JOIN_ERRORS[err?.code] ? t(JOIN_ERRORS[err.code]) : t("Couldn't join: {reason}", { reason: err?.message ?? err });
    } finally {
      joining = false;
      update();
    }
  };

  const form = h(
    'form',
    { class: 'card lobby-card', onSubmit },
    profile,
    h('h1', {}, t('Join a room')),
    h('p', {}, t('Share the room name with friends on the same server.')),
    h('div', { class: 'field' }, h('label', { for: 'lobby-name' }, t('Display name')), nameInput),
    h('div', { class: 'field' }, h('label', { for: 'lobby-room' }, t('Room')), h('div', { class: 'input-prefix' }, h('span', { 'aria-hidden': 'true' }, '#'), roomInput)),
    recentField,
    h('div', { class: 'field' }, joinButton, hint),
  );
  // Wide windows: what Jay-C is, next to the card (hidden on narrow ones).
  const feature = (icon, text) => h('li', {}, h('span', { class: 'lobby-feature-icon', html: icon, 'aria-hidden': 'true' }), text);
  const hero = h(
    'section',
    { class: 'lobby-hero', 'aria-labelledby': 'lobby-hero-title' },
    h('span', { class: 'lobby-hero-mark wolf-mark', 'aria-hidden': 'true' }),
    h('h2', { id: 'lobby-hero-title' }, t('Calls and streams that stay light')),
    h('p', {}, t('On a server you or a friend runs. No accounts and no ads.')),
    h(
      'ul',
      { class: 'lobby-features' },
      feature(icons.mic, t("Clear voice that doesn't muffle your other apps")),
      feature(icons.screenShare, t('Stream a game or a window, with its sound')),
      feature(icons.users, t('Up to 16 people per room')),
    ),
  );
  const element = h('main', { class: 'lobby' }, hero, form);
  renderProfile();
  renderRecent();

  return {
    element,
    destroy: () => cleanups.forEach((fn) => fn()),
  };
}
