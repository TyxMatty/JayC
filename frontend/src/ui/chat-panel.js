// The call's text chat: a side panel opened from the control bar's Chat button, which counts
// unread messages while it's closed. Only messages sent while you're in the call are shown (the
// server keeps no history). Text is always inserted as text, never as HTML.
import { h } from './dom.js';
import { icons } from './icons.js';

const MAX_LENGTH = 500;
/** Older messages are dropped past this, so a long call doesn't grow the page forever. */
const MAX_SHOWN = 200;

/**
 * @param {{ send: (text: string) => boolean, onIncoming?: (message: { name: string, text: string }) => void }} options
 *   send: false when offline (the text stays in the box); onIncoming: someone else's message arrived
 *   while the panel was closed (e.g. a toast).
 */
export function createChatPanel({ send, onIncoming }) {
  const badge = h('span', { class: 'control-badge', hidden: true });
  const button = h('button', { type: 'button', class: 'control-btn', 'aria-expanded': 'false', html: icons.chat }, badge);
  const log = h('ol', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  const empty = h('p', { class: 'chat-empty hint' }, 'Messages sent here go to everyone in the call. They disappear when the call ends.');
  const input = h('input', { class: 'input', type: 'text', maxlength: MAX_LENGTH, placeholder: 'Message everyone', 'aria-label': 'Message' });
  const status = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h('form', { class: 'chat-form' }, input, h('button', { type: 'submit', class: 'btn' }, 'Send'));
  const close = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close chat', html: icons.close });
  const panel = h(
    'aside',
    { class: 'chat-panel', hidden: true, 'aria-label': 'Chat' },
    h('header', { class: 'chat-header' }, h('h2', {}, 'Chat'), close),
    empty,
    log,
    status,
    form,
  );

  let unread = 0;
  const renderButton = () => {
    const open = !panel.hidden;
    const label = open ? 'Close chat' : unread ? `Chat, ${unread} unread` : 'Open chat';
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
      status.textContent = 'Not connected right now. Your message is still in the box.';
    }
  });

  renderButton();
  return {
    button,
    element: panel,
    /** @param {{ name: string, text: string, mine: boolean }} message */
    add({ name, text, mine }) {
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      log.append(
        h(
          'li',
          { class: mine ? 'chat-message mine' : 'chat-message' },
          h('div', { class: 'chat-meta' }, h('strong', {}, mine ? 'You' : name || 'Guest'), h('time', {}, time)),
          h('p', {}, text),
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
