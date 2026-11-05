// Saves the installer pictures drawn by scripts/installer-art.js (run in the dev app over CDP) to
// frontend/src-tauri/windows/, plus PNG previews in the given folder (optional).
//   node scripts/installer-art.mjs [previewDir]
import { readFileSync, writeFileSync } from 'node:fs';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost:5173'));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => (ws.onopen = resolve));
ws.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: `(async () => { ${readFileSync(new URL('./installer-art.js', import.meta.url), 'utf8')} })()`, awaitPromise: true, returnByValue: true },
  }),
);
const reply = await new Promise((resolve) => ws.addEventListener('message', (e) => resolve(JSON.parse(e.data))));
ws.close();
if (reply.result.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description);
const { sidebar, header, sidebarPng, headerPng } = reply.result.result.value;
const dir = new URL('../frontend/src-tauri/windows/', import.meta.url);
writeFileSync(new URL('installer-sidebar.bmp', dir), Buffer.from(sidebar, 'base64'));
writeFileSync(new URL('installer-header.bmp', dir), Buffer.from(header, 'base64'));
const preview = process.argv[2];
if (preview) {
  writeFileSync(`${preview}/installer-sidebar.png`, Buffer.from(sidebarPng.split(',')[1], 'base64'));
  writeFileSync(`${preview}/installer-header.png`, Buffer.from(headerPng.split(',')[1], 'base64'));
}
console.log('saved installer-sidebar.bmp and installer-header.bmp');
