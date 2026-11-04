import { initTheme } from './ui/theme.js';
import { mountApp } from './ui/app-shell.js';
import { serverStatus } from './core/server-status.js';
import { settings } from './store/settings.js';
import { setLanguage, resolveLanguage } from './core/i18n.js';

setLanguage(resolveLanguage(settings.get().language));
initTheme();
mountApp(document.getElementById('app'));

serverStatus.refresh();
// Re-check when the user comes back to the app (server may have been started meanwhile).
window.addEventListener('focus', () => serverStatus.refresh());
