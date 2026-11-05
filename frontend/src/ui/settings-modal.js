import { h } from './dom.js';
import { resolveStyle } from '../core/style.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { toWebSocketUrl, DEFAULT_PORT } from '../core/server-address.js';
import { checkServer } from '../core/server-check.js';
import { screenAudioSupported } from '../core/screen-audio.js';
import { SUGGESTED_APPS, addExcludedApp, removeExcludedApp, exeKey } from '../core/excluded-apps.js';
import * as systemAudio from 'tauri-plugin-system-audio-api';
import { DEFAULT_GRADIENT } from '../core/appearance.js';
import { callDiagnostics } from '../core/diagnostics.js';
import { createAudioSettings } from './audio-settings.js';
import { createAvatarEditor } from './avatar-editor.js';
import { createProfileColorField } from './profile-color-field.js';
import { createTabs } from './tabs.js';
import { POSITIONS, normalizeOrder, normalizePosition, moveControl, normalizeShape } from '../core/call-bar.js';
import { t } from '../core/i18n.js';

const CONTROL_LABELS = { mic: 'Microphone', camera: 'Camera', share: 'Share screen', chat: 'Chat', pip: 'Pop-out video', leave: 'Leave call' };

/** [settings key, label, when to change it]. Changes apply right away, also during a call. */
const MIC_OPTIONS = [
  ['echoCancellation', 'Echo cancellation', 'Stops others from hearing themselves through your speakers. Can be off with headphones.'],
  ['noiseSuppression', 'Noise suppression', 'Removes fans, hum and keyboard noise. Turn it off for music or instruments.'],
  ['autoGainControl', 'Automatic volume', 'Keeps your voice at a steady level.'],
];

const MOTION_OPTIONS = [
  ['system', 'System'],
  ['on', 'On'],
  ['off', 'Off'],
];

/** Each language in its own name, so it can be found whichever one is showing. */
const LANGUAGES = [
  ['system', null],
  ['en', 'English'],
  ['pt-BR', 'Português (Brasil)'],
];

/** Style choices: a small preview drawn with that style's own tokens (styles/theme.css). */
const STYLE_OPTIONS = [
  ['calm', 'Calm'],
  ['neon', 'Neon'],
  ['soft', 'Soft'],
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
export function createSettingsModal({ openGuide, getCall = () => null, openWelcome = () => {} }) {
  const current = settings.get();

  const nameInput = h('input', {
    id: 'settings-name',
    class: 'input',
    maxlength: 32,
    autocomplete: 'nickname',
    placeholder: t('How others will see you'),
    value: current.displayName,
    onInput: (e) => settings.update({ displayName: e.target.value }),
  });

  const motionGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'motion-label', 'aria-describedby': 'motion-hint' },
    MOTION_OPTIONS.map(([value, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'motion',
          value,
          checked: (current.motion ?? 'system') === value,
          onChange: () => settings.update({ motion: value }),
        }),
        t(label),
      ),
    ),
  );

  const styleGroup = h(
    'div',
    { class: 'style-picker', role: 'radiogroup', 'aria-labelledby': 'style-label' },
    STYLE_OPTIONS.map(([value, label]) =>
      h(
        'label',
        { class: 'style-option' },
        h('input', {
          type: 'radio',
          name: 'style',
          value,
          checked: resolveStyle(current.style) === value,
          onChange: () => settings.update({ style: value }),
        }),
        h(
          'span',
          { class: 'style-preview', 'data-style-preview': value, 'aria-hidden': 'true' },
          h('span', { class: 'style-preview-tile' }, h('span', { class: 'style-preview-avatar' })),
          h('span', { class: 'style-preview-bar' }, h('span', {}), h('span', {}), h('span', { class: 'is-danger' })),
        ),
        h('span', { class: 'style-option-name' }, t(label)),
      ),
    ),
  );

  const languageSelect = h(
    'select',
    { class: 'input', id: 'settings-language', 'aria-describedby': 'language-hint', onChange: (e) => settings.update({ language: e.target.value }) },
    LANGUAGES.map(([value, name]) => h('option', { value, selected: (current.language ?? 'system') === value }, name ?? t('System'))),
  );

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
        t(label),
      ),
    ),
  );

  // The radios follow changes made elsewhere too (the header's theme button, another tab).
  settings.subscribe((next) => {
    const values = { style: resolveStyle(next.style), theme: next.theme, motion: next.motion ?? 'system' };
    for (const group of [styleGroup, themeGroup, motionGroup]) {
      for (const radio of group.querySelectorAll('input[type=radio]')) radio.checked = radio.value === values[radio.name];
    }
  });

  // Profile picture: zoomed and moved in the editor, then cropped to a small square (core/avatar.js);
  // others see it while our camera is off.
  const avatarEditor = createAvatarEditor();
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
        const avatar = await avatarEditor.open(file);
        if (!avatar) return; // cancelled: keep the current picture
        settings.update({ avatar });
        delete avatarHint.dataset.tone;
        avatarHint.textContent = '';
      } catch {
        avatarHint.dataset.tone = 'error';
        avatarHint.textContent = t("That file couldn't be read as an image.");
      }
    },
  });
  const avatarRemove = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => settings.update({ avatar: null }) }, t('Remove'));
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
  const accentReset = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => setAppearance({ accent: '' }) }, t('Default'));
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
        t(label),
      ),
    ),
  );
  const gradientFrom = h('input', { type: 'color', class: 'color-input', 'aria-label': t('Gradient start color'), onInput: (e) => setGradient({ from: e.target.value }) });
  const gradientTo = h('input', { type: 'color', class: 'color-input', 'aria-label': t('Gradient end color'), onInput: (e) => setGradient({ to: e.target.value }) });
  const angleValue = h('output', { for: 'settings-angle', class: 'hint' });
  const angleInput = h('input', {
    type: 'range',
    id: 'settings-angle',
    'aria-label': t('Gradient angle'),
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
        t(value[0].toUpperCase() + value.slice(1)),
      ),
    ),
  );
  const barShapeGroup = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'bar-shape-label' },
    [
      ['auto', 'From the style'],
      ['round', 'Circles'],
      ['square', 'Squares'],
    ].map(([value, label]) =>
      h(
        'label',
        {},
        h('input', { type: 'radio', name: 'bar-shape', value, onChange: () => setCallBar({ shape: value }) }),
        t(label),
      ),
    ),
  );
  const barOrderList = h('ol', { class: 'order-list', 'aria-labelledby': 'bar-order-label' });
  const renderCallBar = () => {
    const { position, order, shape } = settings.get().callBar;
    for (const radio of barPositionGroup.querySelectorAll('input')) radio.checked = radio.value === normalizePosition(position);
    for (const radio of barShapeGroup.querySelectorAll('input')) radio.checked = radio.value === normalizeShape(shape);
    const keys = normalizeOrder(order);
    // Rebuilt on each change; keep focus on the button that moved so arrows can be pressed again.
    const focused = document.activeElement?.dataset?.move;
    barOrderList.replaceChildren(
      ...keys.map((key, i) => {
        const move = (delta, dir) =>
          h('button', {
            type: 'button',
            class: 'icon-btn icon-btn-small',
            'aria-label': t(dir === 'up' ? 'Move {control} up' : 'Move {control} down', { control: t(CONTROL_LABELS[key]) }),
            dataset: { move: `${key}:${dir}` },
            disabled: (delta < 0 && i === 0) || (delta > 0 && i === keys.length - 1),
            html: delta < 0 ? icons.arrowUp : icons.arrowDown,
            onClick: () => setCallBar({ order: moveControl(settings.get().callBar.order, key, delta) }),
          });
        return h('li', {}, h('span', {}, t(CONTROL_LABELS[key])), move(-1, 'up'), move(1, 'down'));
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
    setHint(t("Your server's IP and port, e.g. 192.168.1.50:{port}. The port defaults to {port}.", { port: DEFAULT_PORT }));

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
      if (value && !toWebSocketUrl(value)) setHint(t('That does not look like a valid address.'), 'error');
      else defaultHint();
    },
  });

  const testButton = h('button', { type: 'button', class: 'btn btn-secondary' }, t('Test'));
  testButton.addEventListener('click', async () => {
    const value = serverInput.value.trim();
    settings.update({ serverAddress: value });
    const url = toWebSocketUrl(value);
    if (!url) return setHint(t('Enter a valid address first.'), 'error');

    testButton.disabled = true;
    setHint(t('Connecting to {url}…', { url }));
    const result = await checkServer(url);
    testButton.disabled = false;
    if (result.ok) setHint(t('Connected — the server is reachable.'), 'success');
    else if (result.reason === 'timeout') setHint(t('No answer (timed out). Check the IP, port and firewall.'), 'error');
    else setHint(t('Could not connect. Is the server running and the port open?'), 'error');
  });

  defaultHint();

  // Streaming: apps left out of the entire-screen share's sound (Windows native capture only).
  const setExcluded = (excludedApps) => settings.update({ excludedApps });
  let playingApps = []; // apps with an audio session, refreshed each time Settings opens
  const excludedList = h('ul', { class: 'chip-list', 'aria-label': t('Excluded apps') });
  const suggestionList = h('div', { class: 'chip-list', role: 'group', 'aria-label': t('Apps to exclude') });
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
                'aria-label': t('Stop excluding {app}', { app: exe }),
                html: icons.close,
                onClick: () => setExcluded(removeExcludedApp(settings.get().excludedApps, exe)),
              }),
            ),
          )
        : [h('li', { class: 'hint' }, t('No apps excluded.'))]),
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
    placeholder: t('e.g. Spotify.exe'),
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
    h('h3', {}, t('Streaming')),
    h(
      'div',
      { class: 'field' },
      h('p', { class: 'hint' }, t('Sound from these apps is left out when you share your entire screen. Jay-C itself (the call) is never shared.')),
      excludedList,
    ),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Add an app')), suggestionList),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'settings-exclude' }, t('Or type its program name')),
      h('div', { class: 'input-row' }, excludeInput, h('button', { type: 'button', class: 'btn btn-secondary', onClick: addTyped }, t('Add'))),
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
    tabs.setHidden('streaming', !supported);
  });

  const audioSettings = createAudioSettings({ getCall });

  // ----- Troubleshooting: a snapshot of the running call for bug reports -----
  const diagHint = h('p', { class: 'hint', 'aria-live': 'polite' }, t('During a call: measures what you receive from each person and whether it plays, and copies it to send to whoever runs the server.'));
  const diagText = h('textarea', { class: 'input', rows: 8, readonly: true, hidden: true, 'aria-label': t('Call diagnostics') });
  const diagButton = h('button', { type: 'button', class: 'btn btn-secondary' }, t('Copy call diagnostics'));
  diagButton.addEventListener('click', async () => {
    const call = getCall();
    if (!call) {
      diagHint.textContent = t('Join a call first, then copy this while the problem is happening.');
      return;
    }
    diagButton.disabled = true;
    diagHint.textContent = t('Measuring for 2 seconds…');
    try {
      const text = JSON.stringify(await callDiagnostics(call), null, 2);
      diagText.value = text;
      try {
        await navigator.clipboard.writeText(text);
        diagHint.textContent = t('Copied. Paste it in a message.');
        diagText.hidden = true;
      } catch {
        diagHint.textContent = t("Couldn't copy: select the text below and copy it.");
        diagText.hidden = false;
      }
    } catch (error) {
      diagHint.textContent = t("Couldn't measure: {reason}", { reason: error?.message ?? error });
    } finally {
      diagButton.disabled = false;
    }
  });

  // ----- Tabs: one panel per topic instead of one long scrolling column (like Discord's settings) -----
  const tabLabel = (icon, text) => h('span', { class: 'tab-label' }, h('span', { class: 'tab-icon', html: icon, 'aria-hidden': 'true' }), text);
  const panel = (...children) => h('div', { class: 'settings-panel' }, ...children);
  const items = [
    {
      key: 'profile',
      label: tabLabel(icons.user, t('Profile')),
      panel: panel(
        h(
          'fieldset',
          {},
          h('h3', {}, t('Profile')),
          h('div', { class: 'field' }, h('label', { for: 'settings-name' }, t('Display name')), nameInput),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label' }, t('Profile picture')),
            h(
              'div',
              { class: 'avatar-row' },
              avatarPreview,
              h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => avatarFile.click() }, t('Choose picture')),
              avatarRemove,
              avatarFile,
            ),
            avatarHint,
            h('p', { class: 'hint' }, t('Shown to others while your camera is off.')),
          ),
          createProfileColorField(),
        ),
      ),
    },
    {
      key: 'appearance',
      label: tabLabel(icons.palette, t('Appearance')),
      panel: panel(
        h(
          'fieldset',
          {},
          h('h3', {}, t('Appearance')),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'settings-language' }, t('Language')),
            languageSelect,
            h('p', { class: 'hint', id: 'language-hint' }, t('Jay-C reloads to change the language. During a call, it changes when you leave.')),
          ),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'style-label' }, t('Style')), styleGroup),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'theme-label' }, t('Theme')), themeGroup),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label', id: 'motion-label' }, t('Animations')),
            motionGroup,
            h('p', { class: 'hint', id: 'motion-hint' }, t('System follows Windows (Accessibility › Visual effects › Animation effects).')),
          ),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'settings-accent' }, t('Button color')),
            h('div', { class: 'input-row' }, accentInput, accentReset),
          ),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field-label', id: 'background-label' }, t('Background')),
            backgroundGroup,
            gradientControls,
          ),
        ),
        h(
          'fieldset',
          {},
          h('h3', {}, t('Call controls')),
          h('p', { class: 'hint field' }, t('You can also drag the buttons, or the grip next to them, during a call.')),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'bar-position-label' }, t('Position')), barPositionGroup),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'bar-shape-label' }, t('Button shape')), barShapeGroup),
          h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'bar-order-label' }, t('Order')), barOrderList),
        ),
      ),
    },
    {
      key: 'audio',
      label: tabLabel(icons.mic, t('Audio')),
      panel: panel(
        audioSettings.element,
        h(
          'fieldset',
          {},
          h('h3', {}, t('Microphone processing')),
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
              h('span', { class: 'toggle-text' }, h('span', { class: 'toggle-title' }, t(title)), h('span', { class: 'hint' }, t(description))),
            ),
          ),
        ),
      ),
    },
    { key: 'streaming', label: tabLabel(icons.screenShare, t('Streaming')), panel: panel(streamingSection) },
    {
      key: 'server',
      label: tabLabel(icons.server, t('Server')),
      panel: panel(
        h(
          'fieldset',
          {},
          h('h3', {}, t('Server')),
          h(
            'div',
            { class: 'field' },
            h('label', { for: 'settings-server' }, t('Signaling server address')),
            h('div', { class: 'input-row' }, serverInput, testButton),
            serverHint,
            h(
              'p',
              { class: 'hint' },
              t('No server yet? '),
              h('a', { href: '#', onClick: (e) => (e.preventDefault(), openGuide()) }, t('Read the setup guide')),
              t('.'),
            ),
          ),
        ),
      ),
    },
    {
      key: 'help',
      label: tabLabel(icons.help, t('Help')),
      panel: panel(
        h(
          'fieldset',
          {},
          h('h3', {}, t('Getting started')),
          h(
            'div',
            { class: 'field' },
            h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => (dialog.close(), openWelcome()) }, t('Show the welcome tour')),
            h('p', { class: 'hint' }, t('A quick walk through servers, rooms, calls and screen sharing.')),
          ),
        ),
        h('fieldset', {}, h('h3', {}, t('Troubleshooting')), h('div', { class: 'field' }, diagButton, diagHint, diagText)),
      ),
    },
  ];
  const panels = h('div', { class: 'settings-panels' }, items.map((item) => item.panel));
  const tabs = createTabs({ idPrefix: 'settings', label: t('Settings sections'), className: 'settings-tabs', vertical: true, items, onSelect: () => (panels.scrollTop = 0) });
  const body = h('div', { class: 'modal-body settings-body' }, tabs.list, panels);
  tabs.setHidden('streaming', true); // shown once screen sound capture is known to work here
  tabs.select('profile');

  const dialog = h(
    'dialog',
    { class: 'modal modal-settings', 'aria-labelledby': 'settings-title' },
    avatarEditor.element, // its own modal dialog, outside the form (Enter there must not close Settings)
    h(
      'form',
      { method: 'dialog' },
      h(
        'header',
        { class: 'modal-header' },
        h('h2', { id: 'settings-title' }, t('Settings')),
        h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('Close settings'), html: icons.close }),
      ),
      body,
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, t('Done'))),
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
      if (focus === 'server') {
        tabs.select('server');
        serverInput.focus();
      } else if (focus === 'audio') {
        tabs.select('audio');
        audioSettings.element.querySelector('select:not([hidden])')?.focus();
      } else if (focus) {
        tabs.select(focus, { focus: true });
      }
    },
  };
}
