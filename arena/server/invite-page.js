// The invite link: https://japa-or-stay.pages.dev/i/CODE
// A real page (not a #hash) so WhatsApp, X, Facebook and iMessage show a preview that says who is inviting, to which
// challenge, and what the game is. People who open it get a short explanation and a Join button that opens the Arena.
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GAME = 'Japa or Stay is a free Naija life game. Leave Nigeria or build at home: get a job, start a business, chase the visa, look after your family, your body and your people.';
const ARENA = 'In a challenge, every friend lives their own life. Each week, whoever has the most money wins the crown, and six more champions win the life categories.';

async function lookup(env, code) {
  if (!env || !env.DB || !/^[A-Z2-9]{8}$/.test(code)) return null;
  try {
    const r = await env.DB.prepare(`SELECT r.name, r.description, r.status, r.config_json, p.display_name AS host,
        (SELECT COUNT(*) FROM participants x WHERE x.room_id = r.id AND x.status = 'joined') AS players
      FROM rooms r JOIN players p ON p.id = r.host_id WHERE r.code = ?`).bind(code).first();
    if (!r) return null;
    let cfg = {}; try { cfg = JSON.parse(r.config_json); } catch (e) {}
    return { name: r.name, description: r.description, status: r.status, host: r.host, players: r.players, maxPlayers: cfg.maxPlayers, weeks: cfg.weeks, turns: cfg.turnsPerWeek, days: cfg.roundHours ? cfg.roundHours / 24 : null };
  } catch (e) { return null; }
}

function page({ origin, code, room, ogImage }) {
  // maxPlayers 0 means the host set no player limit
  const open = room && room.status === 'lobby' && !(room.maxPlayers > 0 && room.players >= room.maxPlayers);
  const seats = room ? (room.maxPlayers > 0 ? `${room.players} of ${room.maxPlayers} players` : `${room.players} player${room.players === 1 ? '' : 's'} so far · no player limit`) : '';
  const title = room ? `${room.host} invited you to "${room.name}" on Japa or Stay` : 'You are invited to Japa or Stay';
  const facts = room ? `${seats} · ${room.weeks} game weeks · ${room.turns} turns a week` : '';
  const desc = `${GAME} ${ARENA}${facts ? ' ' + facts + '.' : ''}`;
  const joinUrl = `${origin}/#arena/invite/${code}`;
  const url = `${origin}/i/${code}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#07130E">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Japa or Stay">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Japa or Stay: a snowy Northland street and a Lagos skyline at night, with the Multiplayer Arena">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,800&family=Figtree:wght@400;500;600;700&display=swap">
<style>
  :root { --ink: #F2F5F0; --muted: #A8B8AE; --line: rgba(255,255,255,.14); --gold: #F3B53A; --gold2: #FFD777; --stay: #23C07C; --japa: #8495FF; }
  * { box-sizing: border-box; }
  html { background: radial-gradient(120% 80% at 50% 0%, #17305A 0%, #0F1B33 38%, #07130E 78%) fixed #07130E; min-height: 100%; }
  body { margin: 0; color: var(--ink); font: 16px/1.5 Figtree, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  .ankara { height: 10px; background: repeating-linear-gradient(90deg, var(--stay) 0 18px, var(--gold) 18px 24px, var(--japa) 24px 42px, var(--gold) 42px 48px); }
  main { max-width: 560px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font: 800 clamp(34px, 9vw, 52px)/1 "Bricolage Grotesque", system-ui, sans-serif; letter-spacing: -.02em; margin: 0 0 6px; }
  h1 em { font-style: normal; background: linear-gradient(90deg, var(--gold2), var(--gold) 50%, #FF9E57); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tag { color: var(--muted); margin: 0 0 22px; font-size: 18px; }
  .panel { background: rgba(255,255,255,.065); border: 1px solid var(--line); border-radius: 18px; padding: 18px; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); margin-bottom: 14px; }
  .invite { border-color: rgba(243,181,58,.5); background: linear-gradient(135deg, rgba(243,181,58,.18), rgba(132,149,255,.1)); }
  .kick { font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; color: var(--gold2); }
  h2 { font: 800 26px/1.15 "Bricolage Grotesque", system-ui, sans-serif; margin: 6px 0; }
  .facts { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0; padding: 0; list-style: none; }
  .facts li { font-size: 13px; font-weight: 600; padding: 4px 10px; border-radius: 99px; background: rgba(0,0,0,.25); border: 1px solid var(--line); color: var(--muted); }
  .btn { display: flex; align-items: center; justify-content: center; min-height: 52px; border-radius: 14px; text-decoration: none; font-weight: 700; font-size: 17px; margin-top: 16px;
    background: linear-gradient(180deg, var(--gold2), var(--gold)); color: #1B1405; box-shadow: 0 8px 22px -8px rgba(243,181,58,.8); }
  .btn.ghost { background: rgba(255,255,255,.065); color: var(--ink); border: 1px solid var(--line); box-shadow: none; font-size: 15px; min-height: 46px; margin-top: 10px; }
  .btn:focus-visible { outline: 3px solid var(--gold2); outline-offset: 3px; }
  ol { margin: 0; padding-left: 22px; display: grid; gap: 8px; }
  ol b { color: var(--gold2); }
  .note { font-size: 13px; color: var(--muted); margin: 14px 0 0; }
  .code { font: 700 18px "IBM Plex Mono", ui-monospace, monospace; letter-spacing: .14em; color: var(--gold2); }
</style>
</head><body>
<div class="ankara" aria-hidden="true"></div>
<main>
  <h1>Japa <em>or</em> Stay</h1>
  <p class="tag">Leave Nigeria or build at home? Two years. One choice. Your life.</p>
  <section class="panel invite" aria-labelledby="inv">
    <div class="kick">🏆 Multiplayer Arena invitation</div>
    ${room ? `<h2 id="inv">${esc(room.host)} invited you to “${esc(room.name)}”</h2>${room.description ? `<p>${esc(room.description)}</p>` : ''}
    <ul class="facts"><li>${seats}</li><li>${room.weeks} game weeks</li><li>${room.turns} turns a week</li>${room.days ? `<li>a game week lasts ${room.days} day${room.days > 1 ? 's' : ''}</li>` : ''}</ul>
    ${open ? `<a class="btn" href="${esc(joinUrl)}">Join the challenge</a>` : `<p class="note">${room.status === 'lobby' ? 'This challenge is full.' : room.status === 'active' ? 'This challenge has already started, so it cannot take new players.' : 'This challenge is no longer open.'} You can still play on your own, or start your own challenge.</p><a class="btn" href="${esc(origin)}/#arena/create">Start my own challenge</a>`}
    <p class="note">Invite code <span class="code">${esc(code)}</span></p>`
    : `<h2 id="inv">You're invited to play</h2><p>We could not find a challenge with this code. It may have been cancelled. You can play on your own or start a challenge with your friends.</p><a class="btn" href="${esc(origin)}/#arena">Open the Multiplayer Arena</a>`}
  </section>
  <section class="panel" aria-labelledby="what">
    <h2 id="what" style="font-size:20px">What is Japa or Stay?</h2>
    <p>${esc(GAME)} Black tax, owambe, NEPA, visa wahala, snowy shifts abroad or a shop on the main road: every week brings real Naija choices.</p>
    <ol>
      <li><b>Plan your week:</b> spend 21 time blocks on cards like work, study, hustle, family or rest.</li>
      <li><b>Face what life throws at you</b> and choose how to handle it.</li>
      <li><b>Settle up:</b> pay, rent, food and debts. Watch your money, Strength, Happiness, Body, Family Matters, Your People and Clout.</li>
    </ol>
    <p class="note">${esc(ARENA)} Free, no sign-up form, English and Pidgin, and it works offline.</p>
  </section>
  <a class="btn ghost" href="${esc(origin)}/">Play on my own first</a>
</main>
</body></html>`;
}

// handles GET /i/CODE; returns a Response
async function invitePage(request, env) {
  const url = new URL(request.url);
  const code = decodeURIComponent(url.pathname.split('/')[2] || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const room = await lookup(env, code);
  const origin = url.origin;
  const html = page({ origin, code, room, ogImage: `${origin}/og-image.png` });
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' } });
}

module.exports = { invitePage, page };
