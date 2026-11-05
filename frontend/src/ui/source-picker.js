// The app's own "what to share" picker (Windows, native share): screens and app windows with live
// thumbnails, instead of Chromium's picker. The list comes first; each thumbnail fills in as Rust
// grabs it (~0.2 s each, in parallel).
import { h } from './dom.js';
import { icons } from './icons.js';
import { listSources, sourceThumbnail } from '../core/native-live.js';
import { t } from '../core/i18n.js';

/** UWP apps all run in this host process: its name says nothing, so it isn't shown. */
const HIDDEN_APPS = new Set(['ApplicationFrameHost']);

/**
 * @returns {{ element: HTMLDialogElement, open: () => Promise<{ kind: 'monitor' | 'window', id: number, title: string } | null> }}
 */
export function createSourcePicker() {
  const body = h('div', { class: 'modal-body source-picker-body' });
  const cancelButton = h('button', { type: 'button', class: 'btn btn-secondary' }, t('Cancel'));
  const dialog = h(
    'dialog',
    { class: 'modal source-picker', 'aria-labelledby': 'source-picker-title' },
    h('header', { class: 'modal-header' }, h('h2', { id: 'source-picker-title' }, t('Choose what to share'))),
    body,
    h('footer', { class: 'modal-footer' }, cancelButton),
  );

  let resolve = null;
  let urls = [];
  const finish = (value) => {
    if (!resolve) return;
    dialog.close();
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    resolve(value);
    resolve = null;
  };
  cancelButton.addEventListener('click', () => finish(null));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    finish(null);
  });

  const option = (source, title, subtitle) => {
    const thumb = h('div', { class: 'source-thumb is-loading' });
    const button = h(
      'button',
      { type: 'button', class: 'source-option', onClick: () => finish({ kind: source.kind, id: source.id, title }) },
      thumb,
      h('span', { class: 'source-title', title }, title),
      subtitle ? h('span', { class: 'source-subtitle' }, subtitle) : null,
    );
    sourceThumbnail(source)
      .then((url) => {
        urls.push(url);
        thumb.append(h('img', { src: url, alt: '' }));
      })
      .catch(() => thumb.append(h('span', { class: 'source-thumb-icon', html: source.kind === 'monitor' ? icons.monitor : icons.appWindow })))
      .finally(() => thumb.classList.remove('is-loading'));
    return button;
  };

  const section = (label, items) =>
    items.length ? [h('h3', { class: 'source-section' }, label), h('div', { class: 'source-grid' }, items)] : [];

  async function fill() {
    body.replaceChildren(h('p', { class: 'hint' }, t('Loading…')));
    let sources;
    try {
      sources = await listSources();
    } catch (error) {
      body.replaceChildren(h('p', { class: 'hint' }, t("Couldn't list what to share: {reason}", { reason: error?.message ?? error })));
      return;
    }
    const monitors = sources.filter((s) => s.kind === 'monitor');
    const windows = sources.filter((s) => s.kind === 'window');
    body.replaceChildren(
      ...section(
        t('Screens'),
        monitors.map((s, i) =>
          option(s, monitors.length > 1 ? t('Screen {n}', { n: i + 1 }) : t('Entire screen'), [s.primary && monitors.length > 1 ? t('main') : '', `${s.width}×${s.height}`].filter(Boolean).join(' · ')),
        ),
      ),
      ...section(t('Windows'), windows.map((s) => option(s, s.title, HIDDEN_APPS.has(s.app) ? '' : s.app))),
    );
    body.querySelector('.source-option')?.focus();
  }

  return {
    element: dialog,
    open() {
      finish(null);
      dialog.showModal();
      fill();
      return new Promise((r) => (resolve = r));
    },
  };
}
