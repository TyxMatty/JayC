import { h } from './dom.js';
import { icons } from './icons.js';
import { renderMarkdown } from './markdown.js';
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
  const tabs = TABS.map(({ key, label, guide }) => ({
    key,
    tab: h('button', { type: 'button', role: 'tab', id: `guide-tab-${key}`, 'aria-controls': `guide-panel-${key}` }, label),
    panel: h('div', { class: 'markdown', role: 'tabpanel', id: `guide-panel-${key}`, 'aria-labelledby': `guide-tab-${key}` }, renderMarkdown(guide)),
  }));

  const select = (key, { focus = false } = {}) => {
    for (const t of tabs) {
      const on = t.key === key;
      t.tab.setAttribute('aria-selected', String(on));
      t.tab.tabIndex = on ? 0 : -1; // one tab stop; arrows move between tabs
      t.panel.hidden = !on;
      if (on && focus) t.tab.focus();
    }
    body.scrollTop = 0;
  };

  const tabList = h(
    'div',
    { class: 'guide-tabs', role: 'tablist', 'aria-label': 'Your role' },
    tabs.map((t) => t.tab),
  );
  tabList.addEventListener('click', (e) => {
    const t = tabs.find((x) => x.tab === e.target.closest('[role="tab"]'));
    if (t) select(t.key);
  });
  tabList.addEventListener('keydown', (e) => {
    const index = tabs.findIndex((t) => t.tab === document.activeElement);
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined || index < 0) return;
    e.preventDefault();
    select(tabs[(next + tabs.length) % tabs.length].key, { focus: true });
  });
  body.append(tabList, ...tabs.map((t) => t.panel));

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
  select(TABS[0].key);

  return {
    element: dialog,
    /** @param {'connect' | 'host'} [tab] */
    open(tab) {
      if (tab) select(tab);
      dialog.showModal();
      body.scrollTop = 0;
    },
  };
}
