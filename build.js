// Builds the website for Cloudflare Pages.
// Input:  japa-or-stay.html (the game, also published as a claude.ai artifact) + the files in site/
// Output: dist/index.html (a full web page with share-preview tags) + icons and preview image.
// Cloudflare Pages settings: build command `node build.js`, output directory `dist`.
// Set SITE_URL in Cloudflare (Settings > Variables) if the site lives somewhere other than the default below.
const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.SITE_URL || 'https://japa-or-stay.pages.dev').replace(/\/$/, '');
const root = __dirname;
const out = path.join(root, 'dist');

const title = 'Japa or Stay';
const desc = 'Leave Nigeria or build at home? A free Naija life-sim game: two years, one choice. Plays in your browser, in English or Pidgin.';
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
fs.writeFileSync(path.join(out, 'index.html'), head + game + '\n</body>\n</html>\n');
for (const f of fs.readdirSync(path.join(root, 'site'))) fs.copyFileSync(path.join(root, 'site', f), path.join(out, f));
fs.writeFileSync(path.join(out, '_headers'), '/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n');
console.log(`Built dist/ for ${SITE_URL}`);
