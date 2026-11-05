import { h } from './dom.js';
import { icons } from './icons.js';
import { WELCOME_STEPS, clampStep } from '../core/welcome.js';
import { t } from '../core/i18n.js';

// Placeholder art until the animated illustrations (W2): one icon per step.
const ART_ICONS = {
  welcome: icons.video,
  server: icons.server,
  profile: icons.user,
  room: icons.door,
  call: icons.mic,
  share: icons.screenShare,
  extras: icons.chat,
};

/**
 * The "Welcome!" tour: one card per step (core/welcome.js), Back/Next, dots, Skip.
 * Skip, Get started and Esc close it.
 * @param {{ openGuide: () => void, openSettings: (focus?: string) => void }} actions
 */
export function createWelcomeModal({ openGuide, openSettings }) {
  let index = 0;

  const art = h('div', { class: 'welcome-art', 'aria-hidden': 'true' });
  const counter = h('p', { class: 'welcome-counter' });
  const title = h('h2', { id: 'welcome-title', class: 'welcome-title' });
  const body = h('p', { class: 'welcome-text' });
  const action = h('button', { type: 'button', class: 'btn btn-secondary welcome-action' });
  // Announces the new step to screen readers when Back/Next is used.
  const content = h('div', { class: 'welcome-content', 'aria-live': 'polite' }, counter, title, body);

  const dotButtons = WELCOME_STEPS.map((step, i) =>
    h('button', { type: 'button', class: 'welcome-dot', 'aria-label': t('Step {n}: {title}', { n: i + 1, title: t(step.title) }), onClick: () => go(i) }),
  );
  const dots = h('div', { class: 'welcome-dots' }, dotButtons);

  const skipButton = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => dialog.close() }, t('Skip'));
  const backButton = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => go(index - 1) }, t('Back'));
  const nextButton = h('button', { type: 'button', class: 'btn', onClick: next }, t('Next'));

  const dialog = h(
    'dialog',
    { class: 'modal welcome-modal', 'aria-labelledby': 'welcome-title' },
    h(
      'form',
      { method: 'dialog' },
      h('div', { class: 'welcome-body' }, art, content, action, dots),
      h('footer', { class: 'modal-footer welcome-footer' }, skipButton, h('span', { class: 'welcome-spacer' }), backButton, nextButton),
    ),
  );

  function next() {
    if (index === WELCOME_STEPS.length - 1) dialog.close();
    else go(index + 1);
  }

  function go(target) {
    index = clampStep(target);
    const step = WELCOME_STEPS[index];
    const last = index === WELCOME_STEPS.length - 1;
    dialog.dataset.step = step.key;
    art.dataset.art = step.art;
    art.innerHTML = ART_ICONS[step.art] ?? '';
    counter.textContent = t('Step {n} of {total}', { n: index + 1, total: WELCOME_STEPS.length });
    title.textContent = t(step.title);
    body.textContent = t(step.body);
    action.hidden = !step.action;
    if (step.action) action.textContent = t(step.action.label);
    dotButtons.forEach((dot, i) => (i === index ? dot.setAttribute('aria-current', 'step') : dot.removeAttribute('aria-current')));
    backButton.disabled = index === 0;
    nextButton.textContent = last ? t('Get started') : t('Next');
    skipButton.hidden = last;
  }

  action.addEventListener('click', () => {
    const target = WELCOME_STEPS[index].action?.target;
    if (target === 'guide') openGuide();
    else if (target === 'profile') openSettings('profile');
  });

  // Left/right arrows move between steps.
  dialog.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'ArrowRight') go(index + 1);
    else if (e.key === 'ArrowLeft') go(index - 1);
    else return;
    e.preventDefault();
  });

  go(0);

  return {
    element: dialog,
    open() {
      go(0);
      dialog.showModal();
      nextButton.focus();
    },
  };
}
