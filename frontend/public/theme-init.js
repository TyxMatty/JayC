// Runs before CSS paints. Keep in sync with resolveTheme() in src/ui/theme.js, resolveStyle() in
// src/core/style.js and gradientCss() in src/core/appearance.js (only the background is set here; the
// rest follows when the app loads).
(function () {
  var theme = 'light';
  var style = 'calm';
  try {
    var saved = JSON.parse(localStorage.getItem('jayc.settings') || '{}');
    var pref = saved.theme || 'system';
    var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    theme = dark ? 'dark' : 'light';
    if (saved.style === 'neon' || saved.style === 'soft') style = saved.style;
    var g = saved.appearance && saved.appearance.gradient;
    var hex = /^#[0-9a-f]{6}$/i;
    if (g && hex.test(g.from) && hex.test(g.to) && isFinite(g.angle)) {
      document.documentElement.style.setProperty(
        '--app-background',
        'linear-gradient(' + Math.round(g.angle) + 'deg, ' + g.from + ', ' + g.to + ')',
      );
      document.documentElement.dataset.background = 'gradient';
    }
  } catch (e) {}
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.style = style;
})();
