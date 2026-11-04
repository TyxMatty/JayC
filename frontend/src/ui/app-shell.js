import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { serverStatus } from '../core/server-status.js';
import { toWebSocketUrl } from '../core/server-address.js';
import { Call } from '../core/call.js';
import { toggleTheme, currentTheme } from './theme.js';
import { createSettingsModal } from './settings-modal.js';
import { createSetupGuideModal } from './setup-guide-modal.js';
import { createWelcomeModal } from './welcome-modal.js';
import { shouldShowWelcome } from '../core/welcome.js';
import { createLobby } from './lobby.js';
import { createCallView } from './call-view.js';
import { addRecentRoom } from '../core/recent-rooms.js';

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
  const guideModal = createSetupGuideModal();
  const openGuide = () => guideModal.open();
  let currentCall = null;
  let welcomeModal = null;
  const settingsModal = createSettingsModal({ openGuide, getCall: () => currentCall, openWelcome: () => welcomeModal.open() });
  const openSettings = (focus) => settingsModal.open(focus);
  welcomeModal = createWelcomeModal({ openGuide, openSettings });
  const view = h('div', { class: 'view' });
  let destroyView = () => {};

  const show = (element, destroy = () => {}) => {
    destroyView();
    destroyView = destroy;
    view.replaceChildren(element);
  };

  const showLobby = () => {
    const lobby = createLobby({ openSettings, openGuide, onJoin: join });
    show(lobby.element, lobby.destroy);
  };

  async function join({ name, room }) {
    const url = toWebSocketUrl(settings.get().serverAddress);
    const call = new Call();
    call.excludedApps = settings.get().excludedApps;
    const prefs = settings.get();
    await call.join({
      url,
      room,
      name,
      avatar: prefs.avatar,
      color: prefs.profileColor,
      micProcessing: prefs.micProcessing,
      micDeviceId: prefs.micDevice,
      micShape: { gain: prefs.micGain, gateDb: prefs.micGate },
    });
    if (import.meta.env.DEV) window.__jaycCall = call; // for debugging from devtools
    settings.update({ lastRoom: room, recentRooms: addRecentRoom(settings.get().recentRooms, room) });
    // Microphone and streaming options changed in Settings apply to the running call.
    const unsubscribe = settings.subscribe((next, prev) => {
      if (next.micProcessing !== prev.micProcessing) {
        call.setMicProcessing(next.micProcessing).catch((error) => console.warn('[app] mic options', error));
      }
      if (next.avatar !== prev.avatar || next.profileColor !== prev.profileColor) {
        call.setProfile({ avatar: next.avatar, color: next.profileColor });
      }
      if (next.micDevice !== prev.micDevice) {
        call.setMicDevice(next.micDevice).catch((error) => console.warn('[app] mic device', error));
      }
      if (next.micGain !== prev.micGain || next.micGate !== prev.micGate) call.setMicShape({ gain: next.micGain, gateDb: next.micGate });
      if (next.excludedApps !== prev.excludedApps) {
        call.setExcludedApps(next.excludedApps).catch((error) => console.warn('[app] excluded apps', error));
      }
    });
    currentCall = call;
    show(createCallView(call, { displayName: name, onLeft: showLobby, openSettings }), () => {
      currentCall = null;
      unsubscribe();
      call.leave();
    });
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

  root.replaceChildren(header, view, settingsModal.element, guideModal.element, welcomeModal.element);
  showLobby();
  // Marked as seen when it opens (not on close): it shows by itself once, even if the app is
  // closed mid-tour, and doesn't depend on the dialog's close event.
  if (shouldShowWelcome(settings.get())) {
    settings.update({ welcomeSeen: true });
    welcomeModal.open();
  }
}
