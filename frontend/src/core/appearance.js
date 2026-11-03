// User appearance (Settings › Appearance): button color and app background gradient, as CSS
// custom properties set on <html>. Empty values fall back to the theme's own tokens.

export const DEFAULT_APPEARANCE = Object.freeze({ accent: '', gradient: null });
/** Starting point when the user switches the background to a gradient. */
export const DEFAULT_GRADIENT = Object.freeze({ from: '#4f46e5', to: '#db2777', angle: 135 });

const HEX = /^#[0-9a-f]{6}$/i;
const isGradient = (g) => Boolean(g) && HEX.test(g.from) && HEX.test(g.to) && Number.isFinite(g.angle);

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const contrastRatio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Text color for a button of this color: white or near-black, whichever reads better. */
export const contrastText = (hex) => (contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#0f1117') ? '#ffffff' : '#0f1117');

export const gradientCss = ({ from, to, angle }) => `linear-gradient(${Math.round(angle)}deg, ${from}, ${to})`;

/** The custom properties for `appearance`; '' removes one (back to the theme). */
export function appearanceVars({ accent, gradient } = DEFAULT_APPEARANCE) {
  const vars = { '--accent': '', '--accent-hover': '', '--accent-contrast': '', '--accent-text': '', '--app-background': '' };
  if (HEX.test(accent ?? '')) {
    const text = contrastText(accent);
    vars['--accent'] = accent;
    // Hover moves away from the text color: lighter for dark buttons, darker for light ones.
    vars['--accent-hover'] = `color-mix(in srgb, ${accent} 85%, ${text === '#ffffff' ? 'white' : 'black'})`;
    vars['--accent-contrast'] = text;
    // The color as text on the theme's surfaces (e.g. yellow on white): pulled toward the text color.
    // 35% keeps >= 4.5:1 on both themes even for pure white or black (measured in the app).
    vars['--accent-text'] = `color-mix(in srgb, ${accent} 35%, var(--text))`;
  }
  if (isGradient(gradient)) vars['--app-background'] = gradientCss(gradient);
  return vars;
}
