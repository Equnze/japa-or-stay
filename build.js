// Builds the website for Cloudflare Pages.
// Input:  japa-or-stay.html (the game, also published as a claude.ai artifact) + the files in site/
// Output: dist/index.html (a full web page with share-preview tags) + icons and preview image.
// Cloudflare Pages settings: build command `node build.js`, output directory `dist`.
// Set SITE_URL in Cloudflare (Settings > Variables) if the site lives somewhere other than the default below.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE_URL = (process.env.SITE_URL || 'https://japa-or-stay.pages.dev').replace(/\/$/, '');
const root = __dirname;
const out = path.join(root, 'dist');

const title = 'Japa or Stay';
const desc = 'Leave Nigeria or build at home? A free Naija life-sim game: two years, one choice. Plays in your browser in English or Pidgin, and works offline after your first visit.';
const imgAlt = 'Japa or Stay: a snowy Northland street above a Lagos skyline, with the question "Leave Nigeria or build at home?"';

const head = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0E7A4C">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${title}">
<meta property="og:title" content="${title}: leave Nigeria or build at home?">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${SITE_URL}/">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${imgAlt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}: leave Nigeria or build at home?">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${SITE_URL}/og-image.png">
<meta name="twitter:image:alt" content="${imgAlt}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/icon-192.png" sizes="192x192" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${title}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<script>
  // Offline support: the service worker keeps a copy of the game on the device after the first visit.
  if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
</script>
<style>
  :root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }
  body { margin: 0; font: 14px system-ui, sans-serif; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const game = fs.readFileSync(path.join(root, 'japa-or-stay.html'), 'utf8');
// Multiplayer Arena (website only: the claude.ai artifact has no server). The rules, the turn runner and the screens are
// inlined so the Arena opens offline like the rest of the game. The server engine is generated from the same game file.
require('./arena/build-engine.js').writeEngine(root);
const arenaFile = f => fs.readFileSync(path.join(root, 'arena', f), 'utf8');
const arena = `<style>${arenaFile('client/arena.css')}</style>
<div id="arena-root" hidden></div>
<script>${arenaFile('shared/rules.js')}</script>
<script>${arenaFile('shared/turn.js')}</script>
<script>${arenaFile('client/arena.js')}</script>`;
const html = head + game + '\n' + arena + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const f of fs.readdirSync(path.join(root, 'site'))) fs.copyFileSync(path.join(root, 'site', f), path.join(out, f));

// Web app manifest: lets players "Add to Home Screen" and open the game full-screen like an app.
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify({
  name: title,
  short_name: title,
  description: desc,
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#EEF2EC',
  theme_color: '#0E7A4C',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }
  ]
}, null, 2));

// Service worker: caches the game so it opens and plays with no internet after the first visit.
// The cache name changes with every build, so players get the newest version next time they are online.
const files = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];
const version = crypto.createHash('sha1').update(html).digest('hex').slice(0, 10);
const fontCss = (game.match(/https:\/\/fonts\.googleapis\.com\/css2\?[^"']+/) || [''])[0].replace(/&amp;/g, '&');
fs.writeFileSync(path.join(out, 'sw.js'), `// Generated by build.js. Offline cache for Japa or Stay.
const CACHE = 'jos-${version}';
const FILES = ${JSON.stringify(files)};
const FONT_CSS = ${JSON.stringify(fontCss)};

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES);
    // Keep the fonts too, so the game looks the same offline. Skipped quietly if it fails.
    try {
      if (FONT_CSS) {
        const res = await fetch(FONT_CSS, { mode: 'cors' });
        if (res.ok) {
          const css = await res.clone().text();
          await cache.put(FONT_CSS, res);
          const urls = [...css.matchAll(/url\\((https:[^)]+)\\)/g)].map(m => m[1]);
          await Promise.all(urls.map(u => fetch(u, { mode: 'cors' }).then(r => r.ok && cache.put(u, r)).catch(() => {})));
        }
      }
    } catch (e) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  // the Arena API is live data: never cache it here (the Arena keeps its own offline copy in IndexedDB)
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  const url = new URL(req.url);
  // The game page: try the network first (to get updates), fall back to the saved copy offline.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('/', res.clone());
        return res;
      } catch (e) {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }
  // Fonts and the game's own files: use the saved copy, fetch and save it if missing.
  if (url.origin === location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
  }
});
`);

fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n/sw.js\n  Cache-Control: no-cache\n/manifest.webmanifest\n  Content-Type: application/manifest+json\n');
console.log(`Built dist/ for ${SITE_URL}`);
