// Draws the Windows installer's pictures in the "Soft" look (styles/theme.css) and returns them as
// 24-bit BMPs (what NSIS needs), base64. Runs inside the app so the canvas has the Inter font:
//   node scripts/installer-art.mjs   (needs the dev app with debugging: scripts/dev-debug.ps1)
// Sidebar: welcome and finish pages (164x314). Header: top right of the other pages (150x57).
const BG = '#fbf7f3';
const TEXT = '#2a2230';
const ACCENT = '#c4471f';
const PEACH = '#ff9068';

await document.fonts.load('700 30px Inter');
await document.fonts.load('600 14px Inter');

// The Jay-C wolf (src/assets/brand, from scripts/wolf-icon.ps1): the head and the lines, tinted.
const load = (src) => new Promise((resolve, reject) => Object.assign(new Image(), { onload: (e) => resolve(e.target), onerror: reject, src }));
const [wolfLines, wolfFill] = await Promise.all([load('/src/assets/brand/wolf-lines.png'), load('/src/assets/brand/wolf-fill.png')]);
const HEAD = '#16131b'; // Suave's dark accent contrast, as in the app icon

function tinted(img, color, size) {
  const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, size, size);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  return c;
}

function mark(g, x, y, size, lineColor) {
  g.drawImage(tinted(wolfFill, HEAD, size), x, y);
  g.drawImage(tinted(wolfLines, lineColor, size), x, y);
}

function sidebar() {
  const c = Object.assign(document.createElement('canvas'), { width: 164, height: 314 });
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 164, 314);
  grad.addColorStop(0, PEACH);
  grad.addColorStop(1, ACCENT);
  g.fillStyle = grad;
  g.fillRect(0, 0, 164, 314);
  // Soft light blobs, like the lobby's glow.
  for (const [x, y, r, a] of [[30, 40, 90, 0.22], [150, 260, 110, 0.16]]) {
    const glow = g.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255, 255, 255, ${a})`);
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, 164, 314);
  }
  g.shadowColor = 'rgba(60, 20, 10, 0.25)';
  g.shadowBlur = 16;
  g.shadowOffsetY = 6;
  mark(g, 42, 84, 80, '#ffffff');
  g.shadowColor = 'transparent';
  g.fillStyle = '#ffffff';
  g.font = '700 30px Inter';
  g.textAlign = 'center';
  g.fillText('Jay-C', 82, 200);
  g.globalAlpha = 0.85;
  g.fillRect(64, 216, 36, 3);
  return c;
}

function header() {
  const c = Object.assign(document.createElement('canvas'), { width: 150, height: 57 });
  const g = c.getContext('2d');
  g.fillStyle = BG;
  g.fillRect(0, 0, 150, 57);
  mark(g, 50, 10, 36, ACCENT);
  g.fillStyle = TEXT;
  g.font = '700 18px Inter';
  g.fillText('Jay-C', 90, 35);
  return c;
}

/** 24-bit bottom-up BMP of a canvas. */
function bmp(canvas) {
  const { width, height } = canvas;
  const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const out = new DataView(new ArrayBuffer(size));
  out.setUint16(0, 0x4d42, true); // "BM"
  out.setUint32(2, size, true);
  out.setUint32(10, 54, true);
  out.setUint32(14, 40, true);
  out.setInt32(18, width, true);
  out.setInt32(22, height, true);
  out.setUint16(26, 1, true);
  out.setUint16(28, 24, true);
  out.setUint32(34, row * height, true);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = 54 + (height - 1 - y) * row + x * 3;
      out.setUint8(o, pixels[i + 2]);
      out.setUint8(o + 1, pixels[i + 1]);
      out.setUint8(o + 2, pixels[i]);
    }
  }
  let binary = '';
  for (const byte of new Uint8Array(out.buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const s = sidebar();
const h = header();
return { sidebar: bmp(s), header: bmp(h), sidebarPng: s.toDataURL(), headerPng: h.toDataURL() };
