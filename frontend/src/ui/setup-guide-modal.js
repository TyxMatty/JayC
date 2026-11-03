import { h } from './dom.js';
import { icons } from './icons.js';
import { renderMarkdown } from './markdown.js';
import guide from '../content/setup-guide.md?raw';

/** The "host your own server" guide (src/content/setup-guide.md). */
export function createSetupGuideModal() {
  const dialog = h(
    'dialog',
    { class: 'modal modal-wide', 'aria-labelledby': 'guide-title' },
    h(
      'form',
      { method: 'dialog' },
      h(
        'header',
        { class: 'modal-header' },
        h('h2', { id: 'guide-title' }, 'Server setup guide'),
        h('button', { type: 'submit', class: 'icon-btn', 'aria-label': 'Close guide', html: icons.close }),
      ),
      h('div', { class: 'modal-body markdown' }, renderMarkdown(guide)),
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, 'Done')),
    ),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  return {
    element: dialog,
    open() {
      dialog.showModal();
      dialog.querySelector('.modal-body').scrollTop = 0;
    },
  };
}
