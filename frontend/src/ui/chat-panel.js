// The call's text chat: a side panel opened from the control bar's Chat button, which counts
// unread messages while it's closed. Only messages sent while you're in the call are shown (the
// server keeps no history). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { icons } from './icons.js';
import { t } from '../core/i18n.js';

const MAX_LENGTH = 500;
/** Older messages are dropped past this, so a long call doesn't grow the page forever. */
const MAX_SHOWN = 200;
/** Messages from the same person within this gap share one avatar and name (like Discord). */
const GROUP_MS = 5 * 60 * 1000;

/**
 * @param {{ send: (text: string) => boolean, onIncoming?: (message: { name: string, text: string }) => void }} options
 *   send: false when offline (the text stays in the box); onIncoming: someone else's message arrived
 *   while the panel was closed (e.g. a toast).
 */
export function createChatPanel({ send, onIncoming }) {
  const badge = h('span', { class: 'control-badge', hidden: true });
  const button = h('button', { type: 'button', class: 'control-btn', 'aria-expanded': 'false', html: icons.chat }, badge);
  const log = h('ol', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('Messages') });
  const empty = h(
    'div',
    { class: 'chat-empty' },
    h('span', { class: 'chat-empty-icon', html: icons.chat, 'aria-hidden': 'true' }),
    h('p', { class: 'hint' }, t('Messages sent here go to everyone in the call. They disappear when the call ends.')),
  );
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_LENGTH, placeholder: t('Message everyone'), 'aria-label': t('Message') });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'chat-form' },
    input,
    h('button', { type: 'submit', class: 'btn chat-send', 'aria-label': t('Send'), title: t('Send'), html: icons.send }),
  );
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('Close chat'), html: icons.close });
  const panel = h(
    'aside',
    { class: 'chat-panel', hidden: true, 'aria-label': t('Chat') },
    h('header', { class: 'chat-header' }, h('h2', {}, t('Chat')), close),
    empty,
    log,
    status,
    form,
  );

  let unread = 0;
  const renderButton = () => {
    const open = !panel.hidden;
    const label = open ? t('Close chat') : unread ? t('Chat, {count} unread', { count: unread }) : t('Open chat');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.setAttribute('aria-expanded', String(open));
    button.classList.toggle('active', open);
    badge.hidden = open || unread === 0;
    badge.textContent = unread > 99 ? '99+' : String(unread);
  };

  const setOpen = (open) => {
    panel.hidden = !open;
    if (open) {
      unread = 0;
      input.focus();
      log.lastElementChild?.scrollIntoView({ block: 'end' });
    } else {
      button.focus();
    }
    renderButton();
  };
  button.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (send(text)) {
      input.value = '';
      status.textContent = '';
    } else {
      status.textContent = t('Not connected right now. Your message is still in the box.');
    }
  });

  renderButton();
  return {
    button,
    element: panel,
    /**
     * @param {{ id?: string, name: string, text: string, mine: boolean, avatar?: string | null, background?: string }} message
     *   avatar: the sender's picture (data URL); background: their profile color, behind the initial.
     */
    add({ id, name, text, mine, avatar = null, background = '' }) {
      const now = Date.now();
      const time = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const shownName = mine ? t('You') : name || t('Guest');
      const sender = mine ? 'me' : `peer:${id ?? name ?? ''}`;
      // Several in a row from the same person, close together: one avatar, name and time on top.
      const previous = log.lastElementChild;
      const continued = previous?.dataset.sender === sender && now - Number(previous.dataset.at) < GROUP_MS;
      const face = h(
        'span',
        { class: 'chat-avatar', 'aria-hidden': 'true' },
        avatar ? h('img', { src: avatar, alt: '' }) : ((mine ? name : shownName).trim()[0] ?? '?').toUpperCase(),
      );
      if (background) face.style.setProperty('--tile-bg', background);
      log.append(
        h(
          'li',
          { class: `chat-message${mine ? ' mine' : ''}${continued ? ' continued' : ''}`, dataset: { sender, at: String(now) } },
          face,
          h(
            'div',
            { class: 'chat-body' },
            h('div', { class: 'chat-meta' }, h('strong', {}, shownName), h('time', {}, time)),
            h('p', { class: 'chat-text' }, text),
          ),
        ),
      );
      while (log.children.length > MAX_SHOWN) log.firstElementChild.remove();
      empty.hidden = true;
      const stuckToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      if (stuckToBottom || mine) log.lastElementChild.scrollIntoView({ block: 'end' });
      if (!mine && panel.hidden) {
        unread++;
        renderButton();
        onIncoming?.({ name, text });
      }
    },
  };
}
