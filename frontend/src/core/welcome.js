// The "Welcome!" tour shown on first launch (ui/welcome-modal.js) and from Settings › Help.
// Content and navigation live here so they can be tested without a DOM.

/**
 * One card per step. `art` names the illustration (ui/welcome-modal.js); `action` is an optional
 * button that opens a related screen.
 * @type {ReadonlyArray<{ key: string, art: string, title: string, body: string, action?: { label: string, target: 'guide' | 'profile' } }>}
 */
export const WELCOME_STEPS = Object.freeze([
  {
    key: 'welcome',
    art: 'welcome',
    title: 'Welcome to Jay-C!',
    body: "Calls and screen sharing that stay light on your PC, on a server that you or a friend run. Here's how it works, in a few quick steps.",
  },
  {
    key: 'server',
    art: 'server',
    title: 'Connect to a server',
    body: 'Whoever hosts the server gives you its address, like 192.168.0.10:3000. Put it in Settings › Server. The pill at the top turns green and says Online when the server is reachable.',
    action: { label: 'Open the setup guide', target: 'guide' },
  },
  {
    key: 'profile',
    art: 'profile',
    title: 'Make it yours',
    body: 'Choose the name others see, a photo and a profile color. They show on your card whenever your camera is off.',
    action: { label: 'Edit profile', target: 'profile' },
  },
  {
    key: 'room',
    art: 'room',
    title: 'Join a room',
    body: 'Type any room name: everyone who enters the same name on the same server is in the same call. Your recent rooms stay under the field, one click away.',
  },
  {
    key: 'call',
    art: 'call',
    title: 'In the call',
    body: "Your camera starts off, so turn it on when you want. Drag the call bar to any edge of the window. Right-click someone's card to change their volume or mute them just for you.",
  },
  {
    key: 'share',
    art: 'share',
    title: 'Share your screen',
    body: 'Share the entire screen or a single window, with its sound. When someone else goes live, click Watch stream on their card to see it.',
  },
  {
    key: 'extras',
    art: 'extras',
    title: 'Chat, pop-out and help',
    body: 'Open the chat from the call bar, and pop the video out into a small floating window while you use other apps. If something goes wrong, Settings › Help copies a report to send to whoever runs the server.',
  },
]);

/** Keeps a step index inside the tour. */
export function clampStep(index, count = WELCOME_STEPS.length) {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

/** The tour opens by itself once (ui/app-shell.js marks it seen as it opens). */
export function shouldShowWelcome(prefs) {
  return prefs?.welcomeSeen !== true;
}
