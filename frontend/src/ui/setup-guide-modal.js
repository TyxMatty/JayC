import { h } from './dom.js';
import { icons } from './icons.js';
import { renderMarkdown } from './markdown.js';
import { createTabs } from './tabs.js';
import { t, language } from '../core/i18n.js';
import connectGuide from '../content/setup-guide-connect.md?raw';
import hostGuide from '../content/setup-guide-host.md?raw';
import connectGuidePt from '../content/setup-guide-connect.pt-BR.md?raw';
import hostGuidePt from '../content/setup-guide-host.pt-BR.md?raw';

// Most people only connect to a friend's server, so that tab comes first.
const TABS = [
  { key: 'connect', label: 'Connecting', guide: { en: connectGuide, 'pt-BR': connectGuidePt } },
  { key: 'host', label: 'Hosting', guide: { en: hostGuide, 'pt-BR': hostGuidePt } },
];

/** The server setup guide (src/content/setup-guide-*.md), one tab per role. */
export function createSetupGuideModal() {
  const body = h('div', { class: 'modal-body' });
  const items = TABS.map(({ key, label, guide }) => ({ key, label: t(label), panel: h('div', { class: 'markdown' }, renderMarkdown(guide[language()] ?? guide.en)) }));
  const tabs = createTabs({ idPrefix: 'guide', label: t('Your role'), className: 'guide-tabs', items, onSelect: () => (body.scrollTop = 0) });
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
        h('h2', { id: 'guide-title' }, t('Server setup guide')),
        h('button', { type: 'submit', class: 'icon-btn', 'aria-label': t('Close guide'), html: icons.close }),
      ),
      body,
      h('footer', { class: 'modal-footer' }, h('button', { type: 'submit', class: 'btn' }, t('Done'))),
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
