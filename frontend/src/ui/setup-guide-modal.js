import { h } from './dom.js';
import { icons } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { createTabs } from './tabs.js';
import connectGuide from '../content/setup-guide-connect.md?raw';
import hostGuide from '../content/setup-guide-host.md?raw';

// Most people only connect to a friend's server, so that tab comes first.
const TABS = [
  { key: 'connect', label: 'Connecting', guide: connectGuide },
  { key: 'host', label: 'Hosting', guide: hostGuide },
];

/** The server setup guide (src/content/setup-guide-*.md), one tab per role. */
export function createSetupGuideModal() {
  const body = h('div', { class: 'modal-body' });
  const items = TABS.map(({ key, label, guide }) => ({ key, label, panel: h('div', { class: 'markdown' }, renderMarkdown(guide)) }));
  const tabs = createTabs({ idPrefix: 'guide', label: 'Your role', className: 'guide-tabs', items, onSelect: () => (body.scrollTop = 0) });
  body.append(tabs.list, ...items.map((item) => item.panel));

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
      body,
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, 'Done')),
    ),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  tabs.select(TABS[0].key);

  return {
    element: dialog,
    /** @param {'connect' | 'host'} [tab] */
    open(tab) {
      if (tab) tabs.select(tab);
      dialog.showModal();
      body.scrollTop = 0;
    },
  };
}
