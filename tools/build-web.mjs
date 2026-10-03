// Copies the web app into www/ for the native (Capacitor) build. The website itself is served
// straight from the repo by GitHub Pages; this only feeds the iPhone app.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'www');
const FILES = [
  'index.html', 'style.css', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && !['sw.js'].includes(f)),
];
const DIRS = ['data', 'vendor'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
for (const d of DIRS) fs.cpSync(path.join(ROOT, d), path.join(OUT, d), { recursive: true });
// Capacitor's JS runtime (registerPlugin etc). Only the app needs it, so it's injected here,
// as a classic script that runs before the deferred module scripts.
fs.copyFileSync(path.join(ROOT, 'node_modules/@capacitor/core/dist/capacitor.js'), path.join(OUT, 'capacitor.js'));
const html = path.join(OUT, 'index.html');
const page = fs.readFileSync(html, 'utf8');
if (!page.includes('</head>')) throw new Error('index.html has no </head>');
fs.writeFileSync(html, page.replace('</head>', '  <script src="capacitor.js"></script>\n</head>'));
console.log(`www/: ${FILES.length} files + ${DIRS.join(', ')}`);
