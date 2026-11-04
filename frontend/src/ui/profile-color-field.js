// Settings › General › Profile color: Auto (from the name), a solid color or a gradient, with a
// preview of how others see you while your camera is off.
import { h } from './dom.js';
import { settings } from '../store/settings.js';
import { autoColor, cleanProfileColor, profileBackground } from '../core/profile-color.js';
import { t } from '../core/i18n.js';

const MODES = [
  ['auto', 'Auto'],
  ['solid', 'Solid'],
  ['gradient', 'Gradient'],
];

const modeOf = (color) => (!color ? 'auto' : color.to ? 'gradient' : 'solid');

export function createProfileColorField() {
  const save = (color) => settings.update({ profileColor: color });
  const current = () => cleanProfileColor(settings.get().profileColor);
  const seed = () => current() ?? autoColor(settings.get().displayName);

  const group = h(
    'div',
    { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'profile-color-label' },
    MODES.map(([value, label]) =>
      h(
        'label',
        {},
        h('input', {
          type: 'radio',
          name: 'profile-color-mode',
          value,
          onChange: () => {
            const base = seed();
            const fallback = autoColor(settings.get().displayName);
            if (value === 'auto') save(null);
            if (value === 'solid') save({ from: base.from });
            if (value === 'gradient') save({ from: base.from, to: base.to ?? fallback.to, angle: base.angle ?? 135 });
          },
        }),
        t(label),
      ),
    ),
  );
  const from = h('input', { type: 'color', class: 'color-input', 'aria-label': t('Profile color'), onInput: (e) => save({ ...seed(), from: e.target.value }) });
  const to = h('input', { type: 'color', class: 'color-input', 'aria-label': t('Profile gradient end color'), onInput: (e) => save({ ...seed(), to: e.target.value }) });
  const angleValue = h('output', { for: 'profile-color-angle', class: 'hint' });
  const angle = h('input', {
    type: 'range',
    id: 'profile-color-angle',
    'aria-label': t('Profile gradient angle'),
    min: 0,
    max: 360,
    step: 5,
    onInput: (e) => save({ ...seed(), angle: Number(e.target.value) }),
  });
  const pickers = h('div', { class: 'gradient-controls' }, from, to, angle, angleValue);

  // How others see you with the camera off: your picture or initial on your color.
  const previewAvatar = h('div', { class: 'profile-preview-avatar' });
  const previewName = h('span', { class: 'profile-preview-name' });
  const preview = h('div', { class: 'profile-preview', 'aria-hidden': 'true' }, previewAvatar, previewName);

  const render = () => {
    const s = settings.get();
    const color = cleanProfileColor(s.profileColor);
    const mode = modeOf(color);
    for (const input of group.querySelectorAll('input')) input.checked = input.value === mode;
    pickers.hidden = mode === 'auto';
    to.hidden = angle.hidden = angleValue.hidden = mode !== 'gradient';
    const shown = color ?? autoColor(s.displayName);
    from.value = shown.from;
    to.value = shown.to ?? '#000000';
    angle.value = String(shown.angle ?? 135);
    angleValue.textContent = `${shown.angle ?? 135}°`;
    preview.style.background = profileBackground(color, s.displayName);
    const name = s.displayName.trim() || t('You');
    previewName.textContent = name;
    previewAvatar.replaceChildren(s.avatar ? h('img', { src: s.avatar, alt: '' }) : name[0].toUpperCase());
  };
  settings.subscribe((next, prev) => {
    if (next.profileColor !== prev.profileColor || next.displayName !== prev.displayName || next.avatar !== prev.avatar) render();
  });
  render();

  return h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: 'profile-color-label' }, t('Profile color')),
    preview,
    group,
    pickers,
    h('p', { class: 'hint' }, t('Others see it behind your picture while your camera is off. Auto picks one from your name.')),
  );
}
