import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { toWebSocketUrl, DEFAULT_PORT } from '../core/server-address.js';
import { checkServer } from '../core/server-check.js';
import { screenAudioSupported } from '../core/screen-audio.js';
import { SUGGESTED_APPS, addExcludedApp, removeExcludedApp, exeKey } from '../core/excluded-apps.js';
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { DEFAULT_GRADIENT } from '../core/appearance.js';
import { makeAvatar } from '../core/avatar.js';
import { callDiagnostics } from '../core/diagnostics.js';
import { createAudioSettings } from './audio-settings.js';
import { POSITIONS, normalizeOrder, normalizePosition, moveControl } from '../core/call-bar.js';

const CONTROL_LABELS = { mic: 'Microphone', camera: 'Camera', share: 'Share screen', chat: 'Chat', pip: 'Pop-out video', leave: 'Leave call' };

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
export function createSettingsModal({ openGuide, getCall = () => null }) {
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

  // Profile picture: cropped to a small square (core/avatar.js); others see it while our camera is off.
  const avatarPreview = h('span', { class: 'avatar-preview', 'aria-hidden': 'true' });
  const avatarHint = h('p', { class: 'hint', 'aria-live': 'polite' });
  const avatarFile = h('input', {
    type: 'file',
    accept: 'image/*',
    hidden: true,
    onChange: async (e) => {
      const file = e.target.files?.[0];
      e.target.value = ''; // picking the same file again still fires change
      if (!file) return;
      try {
        settings.update({ avatar: await makeAvatar(file) });
        delete avatarHint.dataset.tone;
        avatarHint.textContent = '';
      } catch {
        avatarHint.dataset.tone = 'error';
        avatarHint.textContent = "That file couldn't be read as an image.";
      }
    },
  });
  const avatarRemove = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => settings.update({ avatar: null }) }, 'Remove');
  const renderAvatar = () => {
    const { avatar, displayName } = settings.get();
    avatarPreview.replaceChildren(avatar ? h('img', { src: avatar, alt: '' }) : (displayName.trim()[0] ?? '?').toUpperCase());
    avatarRemove.hidden = !avatar;
  };
  settings.subscribe((next, prev) => (next.avatar !== prev.avatar || next.displayName !== prev.displayName) && renderAvatar());
  renderAvatar();

  // Appearance: button color and background gradient, applied live (see ui/theme.js).
  const setAppearance = (patch) => settings.update({ appearance: { ...settings.get().appearance, ...patch } });
  const setGradient = (patch) => setAppearance({ gradient: { ...settings.get().appearance.gradient, ...patch } });
  const accentInput = h('input', {
    type: 'color',
    id: 'settings-accent',
    class: 'color-input',
    onInput: (e) => setAppearance({ accent: e.target.value }),
  });
  const accentReset = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => setAppearance({ accent: '' }) }, 'Default');
  const backgroundGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'background-label' },
    [
      ['theme', 'Theme'],
      ['gradient', 'Gradient'],
    ].map(([value, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'background',
          value,
          onChange: () => setAppearance({ gradient: value === 'gradient' ? { ...DEFAULT_GRADIENT } : null }),
        }),
        label,
      ),
    ),
  );
  const gradientFrom = h('input', { type: 'color', class: 'color-input', 'aria-label': 'Gradient start color', onInput: (e) => setGradient({ from: e.target.value }) });
  const gradientTo = h('input', { type: 'color', class: 'color-input', 'aria-label': 'Gradient end color', onInput: (e) => setGradient({ to: e.target.value }) });
  const angleValue = h('output', { for: 'settings-angle', class: 'hint' });
  const angleInput = h('input', {
    type: 'range',
    id: 'settings-angle',
    'aria-label': 'Gradient angle',
    min: 0,
    max: 360,
    step: 5,
    onInput: (e) => setGradient({ angle: Number(e.target.value) }),
  });
  const gradientControls = h(
    'div',
    { class: 'gradient-controls' },
    gradientFrom,
    gradientTo,
    angleInput,
    angleValue,
  );
  const renderAppearance = () => {
    const { accent, gradient } = settings.get().appearance;
    // With no custom color, show the theme's own.
    accentInput.value = accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    accentReset.disabled = !accent;
    for (const radio of backgroundGroup.querySelectorAll('input')) radio.checked = radio.value === (gradient ? 'gradient' : 'theme');
    gradientControls.hidden = !gradient;
    if (gradient) {
      gradientFrom.value = gradient.from;
      gradientTo.value = gradient.to;
      angleInput.value = String(gradient.angle);
      angleValue.textContent = `${gradient.angle}°`;
    }
  };
  settings.subscribe((next, prev) => {
    if (next.appearance !== prev.appearance || next.theme !== prev.theme) queueMicrotask(renderAppearance);
  });

  // Call controls: the keyboard way to do what dragging the call's bar does (ui/control-bar.js).
  const setCallBar = (patch) => settings.update({ callBar: { ...settings.get().callBar, ...patch } });
  const barPositionGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'bar-position-label' },
    POSITIONS.map((value) =>
      h(
        'label',
        {},
        h('input', { type: 'radio', name: 'bar-position', value, onChange: () => setCallBar({ position: value }) }),
        value[0].toUpperCase() + value.slice(1),
      ),
    ),
  );
  const barOrderList = h('ol', { class: 'order-list', 'aria-labelledby': 'bar-order-label' });
  const renderCallBar = () => {
    const { position, order } = settings.get().callBar;
    for (const radio of barPositionGroup.querySelectorAll('input')) radio.checked = radio.value === normalizePosition(position);
    const keys = normalizeOrder(order);
    // Rebuilt on each change; keep focus on the button that moved so arrows can be pressed again.
    const focused = document.activeElement?.dataset?.move;
    barOrderList.replaceChildren(
      ...keys.map((key, i) => {
        const move = (delta, dir) =>
          h('button', {
            type: 'button',
            class: 'icon-btn icon-btn-small',
            'aria-label': `Move ${CONTROL_LABELS[key]} ${dir}`,
            dataset: { move: `${key}:${dir}` },
            disabled: (delta < 0 && i === 0) || (delta > 0 && i === keys.length - 1),
            html: delta < 0 ? icons.arrowUp : icons.arrowDown,
            onClick: () => setCallBar({ order: moveControl(settings.get().callBar.order, key, delta) }),
          });
        return h('li', {}, h('span', {}, CONTROL_LABELS[key]), move(-1, 'up'), move(1, 'down'));
      }),
    );
    if (focused) {
      const again = barOrderList.querySelector(`[data-move="${focused}"]`);
      (again?.disabled ? barOrderList.querySelector(`[data-move^="${focused.split(':')[0]}:"]:not(:disabled)`) : again)?.focus();
    }
  };
  settings.subscribe((next, prev) => next.callBar !== prev.callBar && renderCallBar());
  renderCallBar();

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

  const audioSettings = createAudioSettings({ getCall });

  // ----- Troubleshooting: a snapshot of the running call for bug reports -----
  const diagHint = h('p', { class: 'hint', 'aria-live': 'polite' }, 'During a call: measures what you receive from each person and whether it plays, and copies it to send to whoever runs the server.');
  const diagText = h('textarea', { class: 'input', rows: 8, readonly: true, hidden: true, 'aria-label': 'Call diagnostics' });
  const diagButton = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Copy call diagnostics');
  diagButton.addEventListener('click', async () => {
    const call = getCall();
    if (!call) {
      diagHint.textContent = 'Join a call first, then copy this while the problem is happening.';
      return;
    }
    diagButton.disabled = true;
    diagHint.textContent = 'Measuring for 2 seconds…';
    try {
      const text = JSON.stringify(await callDiagnostics(call), null, 2);
      diagText.value = text;
      try {
        await navigator.clipboard.writeText(text);
        diagHint.textContent = 'Copied. Paste it in a message.';
        diagText.hidden = true;
      } catch {
        diagHint.textContent = "Couldn't copy: select the text below and copy it.";
        diagText.hidden = false;
      }
    } catch (error) {
      diagHint.textContent = `Couldn't measure: ${error?.message ?? error}`;
    } finally {
      diagButton.disabled = false;
    }
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
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label' }, 'Profile picture'),
            h(
              'div',
              { class: 'avatar-row' },
              avatarPreview,
              h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => avatarFile.click() }, 'Choose picture'),
              avatarRemove,
              avatarFile,
            ),
            avatarHint,
            h('p', { class: 'hint' }, 'Shown to others while your camera is off.'),
          ),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'theme-label' }, 'Theme'), themeGroup),
        ),
        h(
          'fieldset',
          {},
          h('h3', {}, 'Appearance'),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'settings-accent' }, 'Button color'),
            h('div', { class: 'input-row' }, accentInput, accentReset),
          ),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label', id: 'background-label' }, 'Background'),
            backgroundGroup,
            gradientControls,
          ),
        ),
        h(
          'fieldset',
          {},
          h('h3', {}, 'Call controls'),
          h('p', { class: 'hint field' }, 'You can also drag the buttons, or the grip next to them, during a call.'),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'bar-position-label' }, 'Position'), barPositionGroup),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'bar-order-label' }, 'Order'), barOrderList),
        ),
        audioSettings.element,
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
        h('fieldset', {}, h('h3', {}, 'Troubleshooting'), h('div', { class: 'field' }, diagButton, diagHint, diagText)),
      ),
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, 'Done')),
    ),
  );

  dialog.addEventListener('close', () => audioSettings.close());

  // Close when clicking the backdrop.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });

  return {
    element: dialog,
    open(focus) {
      renderAppearance();
      dialog.showModal();
      audioSettings.open();
      if (!streamingSection.hidden) refreshPlayingApps();
      if (focus === 'server') serverInput.focus();
      if (focus === 'audio') {
        audioSettings.element.scrollIntoView({ block: 'start' });
        audioSettings.element.querySelector('select:not([hidden])')?.focus();
      }
    },
  };
}
