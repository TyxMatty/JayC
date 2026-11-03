import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { toWebSocketUrl, DEFAULT_PORT } from '../core/server-address.js';
import { checkServer } from '../core/server-check.js';
import { screenAudioSupported } from '../core/screen-audio.js';
import { SUGGESTED_APPS, addExcludedApp, removeExcludedApp, exeKey } from '../core/excluded-apps.js';
import * as systemAudio from 'tauri-plugin-system-audio-api';

/** [settings key, label, when to change it]. Changes apply right away, also during a call. */
const MIC_OPTIONS = [
  ['echoCancellation', 'Echo cancellation', 'Stops others from hearing themselves through your speakers. Can be off with headphones.'],
  ['noiseSuppression', 'Noise suppression', 'Removes fans, hum and keyboard noise. Turn it off for music or instruments.'],
  ['autoGainControl', 'Automatic volume', 'Keeps your voice at a steady level.'],
];

const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/**
 * Builds the Settings dialog. Changes apply immediately (theme switches live).
 * @param {{ openGuide: () => void }} options
 */
export function createSettingsModal({ openGuide }) {
  const current = settings.get();

  const nameInput = h('input', {
    id: 'settings-name',
    class: 'input',
    maxlength: 32,
    autocomplete: 'nickname',
    placeholder: 'How others will see you',
    value: current.displayName,
    onInput: (e) => settings.update({ displayName: e.target.value }),
  });

  const themeGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'theme-label' },
    THEMES.map(([value, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'theme',
          value,
          checked: current.theme === value,
          onChange: () => settings.update({ theme: value }),
        }),
        label,
      ),
    ),
  );

  const serverHint = h('p', { class: 'hint', id: 'settings-server-hint', 'aria-live': 'polite' });
  const setHint = (text, tone) => {
    serverHint.textContent = text;
    if (tone) serverHint.dataset.tone = tone;
    else delete serverHint.dataset.tone;
  };
  const defaultHint = () =>
    setHint(`Your server's IP and port, e.g. 192.168.1.50:${DEFAULT_PORT}. The port defaults to ${DEFAULT_PORT}.`);

  const serverInput = h('input', {
    id: 'settings-server',
    class: 'input',
    inputmode: 'url',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: `192.168.1.50:${DEFAULT_PORT}`,
    value: current.serverAddress,
    'aria-describedby': 'settings-server-hint',
    onChange: (e) => {
      const value = e.target.value.trim();
      settings.update({ serverAddress: value });
      if (value && !toWebSocketUrl(value)) setHint('That does not look like a valid address.', 'error');
      else defaultHint();
    },
  });

  const testButton = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Test');
  testButton.addEventListener('click', async () => {
    const value = serverInput.value.trim();
    settings.update({ serverAddress: value });
    const url = toWebSocketUrl(value);
    if (!url) return setHint('Enter a valid address first.', 'error');

    testButton.disabled = true;
    setHint(`Connecting to ${url}…`);
    const result = await checkServer(url);
    testButton.disabled = false;
    if (result.ok) setHint('Connected — the server is reachable.', 'success');
    else if (result.reason === 'timeout') setHint('No answer (timed out). Check the IP, port and firewall.', 'error');
    else setHint('Could not connect. Is the server running and the port open?', 'error');
  });

  defaultHint();

  // Streaming: apps left out of the entire-screen share's sound (Windows native capture only).
  const setExcluded = (excludedApps) => settings.update({ excludedApps });
  let playingApps = []; // apps with an audio session, refreshed each time Settings opens
  const excludedList = h('ul', { class: 'chip-list', 'aria-label': 'Excluded apps' });
  const suggestionList = h('div', { class: 'chip-list', role: 'group', 'aria-label': 'Apps to exclude' });
  const renderStreaming = () => {
    const list = settings.get().excludedApps;
    excludedList.replaceChildren(
      ...(list.length
        ? list.map((exe) =>
            h(
              'li',
              { class: 'chip' },
              exe,
              h('button', {
                type: 'button',
                class: 'chip-remove',
                'aria-label': `Stop excluding ${exe}`,
                html: icons.close,
                onClick: () => setExcluded(removeExcludedApp(settings.get().excludedApps, exe)),
              }),
            ),
          )
        : [h('li', { class: 'hint' }, 'No apps excluded.')]),
    );
    const seen = new Set(list.map(exeKey));
    const picks = [...playingApps, ...SUGGESTED_APPS].filter((app) => !seen.has(exeKey(app.exe)) && seen.add(exeKey(app.exe)));
    suggestionList.replaceChildren(
      ...picks.map((app) =>
        h(
          'button',
          {
            type: 'button',
            class: 'chip chip-add',
            title: app.exe,
            onClick: () => setExcluded(addExcludedApp(settings.get().excludedApps, app.exe)),
          },
          `+ ${app.displayName}`,
        ),
      ),
    );
  };
  const excludeInput = h('input', {
    id: 'settings-exclude',
    class: 'input',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'e.g. Spotify.exe',
    onKeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Enter would submit (close) the dialog's form
      addTyped();
    },
  });
  const addTyped = () => {
    setExcluded(addExcludedApp(settings.get().excludedApps, excludeInput.value));
    excludeInput.value = '';
  };
  const streamingSection = h(
    'fieldset',
    { hidden: true },
    h('h3', {}, 'Streaming'),
    h(
      'div',
      { class: 'field' },
      h('p', { class: 'hint' }, 'Sound from these apps is left out when you share your entire screen. Jay-C itself (the call) is never shared.'),
      excludedList,
    ),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Add an app'), suggestionList),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'settings-exclude' }, 'Or type its program name'),
      h('div', { class: 'input-row' }, excludeInput, h('button', { type: 'button', class: 'btn btn-secondary', onClick: addTyped }, 'Add')),
    ),
  );
  renderStreaming();
  settings.subscribe((next, prev) => next.excludedApps !== prev.excludedApps && renderStreaming());
  const refreshPlayingApps = () =>
    systemAudio
      .listAudioApps()
      .then((apps) => {
        playingApps = apps;
        renderStreaming();
      })
      .catch((error) => console.warn('[settings] audio apps', error));
  screenAudioSupported().then((supported) => {
    streamingSection.hidden = !supported;
  });

  const dialog = h(
    'dialog',
    { class: 'modal', 'aria-labelledby': 'settings-title' },
    h(
      'form',
      { method: 'dialog' },
      h(
        'header',
        { class: 'modal-header' },
        h('h2', { id: 'settings-title' }, 'Settings'),
        h('button', { type: 'submit', class: 'icon-btn', 'aria-label': 'Close settings', html: icons.close }),
      ),
      h(
        'div',
        { class: 'modal-body' },
        h(
          'fieldset',
          {},
          h('h3', {}, 'General'),
          h('div', { class: 'field' }, h('label', { for: 'settings-name' }, 'Display name'), nameInput),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'theme-label' }, 'Theme'), themeGroup),
        ),
        h(
          'fieldset',
          {},
          h('h3', {}, 'Microphone'),
          MIC_OPTIONS.map(([key, title, description]) =>
            h(
              'label',
              { class: 'toggle-row' },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                checked: current.micProcessing[key],
                onChange: (e) => settings.update({ micProcessing: { ...settings.get().micProcessing, [key]: e.target.checked } }),
              }),
              h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-title' }, title), h('span', { class: 'hint' }, description)),
            ),
          ),
        ),
        streamingSection,
        h(
          'fieldset',
          {},
          h('h3', {}, 'Server'),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'settings-server' }, 'Signaling server address'),
            h('div', { class: 'input-row' }, serverInput, testButton),
            serverHint,
            h(
              'p',
              { class: 'hint' },
              'No server yet? ',
              h('a', { href: '#', onClick: (e) => (e.preventDefault(), openGuide()) }, 'Read the setup guide'),
              '.',
            ),
          ),
        ),
      ),
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, 'Done')),
    ),
  );

  // Close when clicking the backdrop.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  return {
    element: dialog,
    open(focus) {
      dialog.showModal();
      if (!streamingSection.hidden) refreshPlayingApps();
      if (focus === 'server') serverInput.focus();
    },
  };
}
