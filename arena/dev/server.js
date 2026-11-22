// Local Arena server: serves the built site from dist/ and the API from arena/server/app.js on a local SQLite file.
// Usage: node build.js && node arena/dev/server.js   (then open http://localhost:8791)
// Data lives in .arena-dev/ (git-ignored). Delete that folder to start fresh. Never point this at production data.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const { openD1, migrate } = require('./d1-shim.js');
const { handle } = require('../server/app.js');
const { invitePage } = require('../server/invite-page.js');

const PORT = Number(process.env.PORT || 8791);
const dataDir = path.join(root, '.arena-dev');
fs.mkdirSync(dataDir, { recursive: true });
const secretFile = path.join(dataDir, 'secret.txt');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
// ARENA_CLOCK_OFFSET_HOURS lets you jump the server clock forward locally to test deadlines
const offset = Number(process.env.ARENA_CLOCK_OFFSET_HOURS || 0) * 3600000;
const env = { DB: migrate(openD1(path.join(dataDir, 'arena.sqlite'))), ARENA_SECRET: fs.readFileSync(secretFile, 'utf8').trim(), now: () => Date.now() + offset + (global.__arenaSkew || 0) };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (/^\/i\/[^/]+$/.test(url.pathname)) {
      const r = await invitePage(new Request(url), env);
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
    }
    if (url.pathname.startsWith('/api/')) {
      // dev-only helper: POST /api/_dev/skew {hours} moves the server clock so deadlines can be tested by hand
      if (url.pathname === '/api/_dev/skew' && req.method === 'POST') {
        let b = ''; for await (const c of req) b += c;
        global.__arenaSkew = (global.__arenaSkew || 0) + Number(JSON.parse(b || '{}').hours || 0) * 3600000;
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ skewHours: global.__arenaSkew / 3600000 })); return;
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const r = await handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    let file = path.join(root, 'dist', decodeURIComponent(url.pathname));
    if (!file.startsWith(path.join(root, 'dist'))) { res.writeHead(403); res.end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(root, 'dist', 'index.html');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); res.writeHead(500); res.end('dev server error'); }
}).listen(PORT, () => console.log(`Arena dev server: http://localhost:${PORT}`));
