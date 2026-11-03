import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { toWebSocketUrl } from '../core/server-address.js';
import { Call } from '../core/call.js';
import { toggleTheme, currentTheme } from './theme.js';
import { createSettingsModal } from './settings-modal.js';
import { createLobby } from './lobby.js';
import { createCallView } from './call-view.js';

const STATUS_LABELS = {
  unset: 'No server',
  invalid: 'Invalid address',
  checking: 'Checking…',
  online: 'Online',
  offline: 'Offline',
};

function createStatusPill(onSetup) {
  const label = h('span', {});
  const pill = h(
    'button',
    { type: 'button', class: 'status-pill', 'aria-live': 'polite' },
    h('span', { class: 'label-long' }, 'Server: '),
    label,
  );

  serverStatus.subscribe(({ state, url }) => {
    pill.dataset.state = state;
    label.textContent = STATUS_LABELS[state];
    pill.title = url ? `${url} — click to check again` : 'Click to set up a server';
  });

  pill.addEventListener('click', () => {
    const { state } = serverStatus.get();
    if (state === 'unset' || state === 'invalid') onSetup();
    else serverStatus.refresh();
  });
  return pill;
}

function createThemeToggle() {
  const button = h('button', { type: 'button', class: 'icon-btn' });
  const render = () => {
    const dark = currentTheme() === 'dark';
    button.innerHTML = dark ? icons.sun : icons.moon;
    button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    button.title = button.getAttribute('aria-label');
  };
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
  // The theme can also change from Settings or the OS.
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  render();
  return button;
}

export function mountApp(root) {
  const settingsModal = createSettingsModal();
  const openSettings = (focus) => settingsModal.open(focus);
  const view = h('div', { class: 'view' });
  let destroyView = () => {};

  const show = (element, destroy = () => {}) => {
    destroyView();
    destroyView = destroy;
    view.replaceChildren(element);
  };

  const showLobby = () => {
    const lobby = createLobby({ openSettings, onJoin: join });
    show(lobby.element, lobby.destroy);
  };

  async function join({ name, room }) {
    const url = toWebSocketUrl(settings.get().serverAddress);
    const call = new Call();
    await call.join({ url, room, name });
    if (import.meta.env.DEV) window.__jaycCall = call; // for debugging from devtools
    settings.update({ lastRoom: room });
    show(createCallView(call, { displayName: name, onLeft: showLobby }), () => call.leave());
  }

  const header = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, 'Jay', h('span', {}, '-'), 'C'),
    createStatusPill(() => openSettings('server')),
    createThemeToggle(),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      'aria-label': 'Settings',
      title: 'Settings',
      html: icons.settings,
      onClick: () => openSettings(),
    }),
  );

  root.replaceChildren(header, view, settingsModal.element);
  showLobby();
}
