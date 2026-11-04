import { h } from './dom.js';
import { icons } from './icons.js';
import { settings } from '../store/settings.js';
import { STREAM_RESOLUTIONS, STREAM_FRAME_RATES } from '../core/media.js';
import { screenAudioSupported } from '../core/screen-audio.js';
import { t } from '../core/i18n.js';

let audioSupported = false;
screenAudioSupported().then((supported) => (audioSupported = supported));

function soundHint(call) {
  if (call.sharing) {
    return call.screenShare?.audio
      ? t('Sound: {sound}. Changes apply right away.', { sound: call.screenShare.audio })
      : t('No sound is being shared. Changes apply right away.');
  }
  return audioSupported
    ? t("Sound: a window shares only that app's audio; the entire screen shares everything except Jay-C.")
    : t("Sound from the shared screen isn't available on this device.");
}

const MODES = [
  ['screen', 'Entire screen', icons.monitor],
  ['window', 'Window', icons.appWindow],
];

const OPTIMIZE = [
  ['detail', 'Text & detail'],
  ['motion', 'Motion & games'],
];

function segmented(name, options, current, onChange) {
  return h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'data-count': options.length },
    options.map(([value, label, icon]) =>
      h(
        'label',
        {},
        h('input', { type: 'radio', name, value, checked: current === value, onChange: () => onChange(value) }),
        icon ? h('span', { class: 'segmented-icon', html: icon }) : null,
        t(label),
      ),
    ),
  );
}

/**
 * Popover to start/stop a screen share and change its quality live.
 * @param {import('../core/call.js').Call} call
 * @param {{ onError: (message: string) => void }} options
 */
export function createSharePanel(call, { onError }) {
  const panel = h('div', { class: 'share-panel', popover: 'auto', id: 'share-panel', 'aria-labelledby': 'share-title' });
  let mode = settings.get().shareMode;

  const quality = () => settings.get().streamQuality;
  const updateQuality = async (patch) => {
    settings.update({ streamQuality: { ...quality(), ...patch } });
    if (!call.sharing) return;
    try {
      await call.setScreenQuality(quality());
    } catch (error) {
      onError(t("Couldn't change the quality: {reason}", { reason: error?.message ?? error }));
    }
  };

  const render = () => {
    const q = quality();
    const sharing = call.sharing;
    const title = sharing
      ? t(call.screenShare?.mode === 'window' ? 'Sharing your window' : 'Sharing your screen')
      : t('Share your screen');

    const resolution = h(
      'select',
      { class: 'input', id: 'share-resolution', onChange: (e) => updateQuality({ resolution: e.target.value }) },
      STREAM_RESOLUTIONS.map((r) => h('option', { value: r.id, selected: r.id === q.resolution }, t(r.label))),
    );
    const fps = h(
      'select',
      { class: 'input', id: 'share-fps', onChange: (e) => updateQuality({ fps: Number(e.target.value) }) },
      STREAM_FRAME_RATES.map((f) => h('option', { value: f, selected: f === q.fps }, `${f} fps`)),
    );

    const start = async () => {
      startButton.disabled = true;
      try {
        settings.update({ shareMode: mode });
        const started = await call.startScreenShare({ mode, quality: quality() });
        if (started) panel.hidePopover();
      } catch (error) {
        onError(t("Couldn't share: {reason}", { reason: error?.message ?? error }));
      } finally {
        startButton.disabled = false;
      }
    };
    const startButton = h('button', { type: 'button', class: 'btn', onClick: start }, t('Choose and share…'));
    const stopButton = h(
      'button',
      { type: 'button', class: 'btn btn-danger', onClick: () => call.stopScreenShare().then(() => panel.hidePopover()) },
      t('Stop sharing'),
    );

    // Built with h() so the conditional `null` below is skipped (replaceChildren would print "null").
    const content = h(
      'div',
      {},
      h('h2', { id: 'share-title' }, title),
      sharing
        ? null
        : h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('What to share')), segmented('share-mode', MODES, mode, (v) => (mode = v))),
      h(
        'div',
        { class: 'share-row' },
        h('div', { class: 'field' }, h('label', { for: 'share-resolution' }, t('Resolution')), resolution),
        h('div', { class: 'field' }, h('label', { for: 'share-fps' }, t('Frame rate')), fps),
      ),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, t('Optimize for')),
        segmented('share-optimize', OPTIMIZE, q.optimizeFor, (v) => updateQuality({ optimizeFor: v })),
      ),
      h('p', { class: 'hint' }, soundHint(call)),
      h(
        'div',
        { class: 'share-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => panel.hidePopover() }, sharing ? t('Done') : t('Cancel')),
        sharing ? stopButton : startButton,
      ),
    );
    panel.replaceChildren(...content.childNodes);
  };

  panel.addEventListener('beforetoggle', (e) => {
    if (e.newState === 'open') render();
  });
  call.addEventListener('local-updated', () => {
    if (panel.matches(':popover-open')) render();
  });

  return panel;
}
