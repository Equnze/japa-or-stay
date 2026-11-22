// Japa or Stay: Challenge Arena — the screens, offline storage and sync.
// Runs on the website build only (build.js inlines it after the game). It drives the single-player engine through
// ArenaTurn with a seeded random generator, so a turn played here is replayed identically by the server.
// Single-player progress is never touched: S is swapped only while an Arena step runs, and ARENA_SANDBOX blocks saves.
(function () {
  'use strict';
  const root = document.getElementById('arena-root'), openBtn = document.getElementById('arenabtn');
  if (!root || !openBtn || !window.ArenaRules || !window.ArenaTurn) return;
  const R = window.ArenaRules, TT = window.ArenaTurn;

  /* ---------- the engine, on the page's own game ---------- */
  const E = {
    getS: () => S, setS: v => { S = v; },
    setRandom: f => { const p = Math.random; Math.random = f; return p; },
    setSandbox: b => { ARENA_SANDBOX = b; },
    newState, dealHand, endWeek, choose, nextEvent, nextWeek, startBuild, startJapaY2, eventView, log,
    CARDS, BLOCKS, wallet, moneyCommitted, loanRoom, blocksUsed, japaProgress, REGIONS, TRAITS, AV_DEFAULT, AV_SKINS
  };
  const A = TT.makeArena(E);

  /* ---------- helpers ---------- */
  const h = s => esc(s == null ? '' : s);
  const N = n => naira(n || 0);
  const pct = v => Math.max(0, Math.min(100, v));
  const sign = (n, f = x => x) => n > 0 ? `<span class="ar-up">+${f(n)}</span>` : n < 0 ? `<span class="ar-down">−${f(-n)}</span>` : `<span class="ar-muted">±0</span>`;
  const STATN = { strength: 'Strength', happiness: 'Happiness', body: 'Body', family: 'Family Matters', people: 'Your People', clout: 'Clout' };
  const face = (av, cls = 'md', mood) => avatar({ ...AV_DEFAULT, ...(av || {}), ...(mood ? { mood } : {}) }, cls);
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  let skew = 0; // server time minus device time; deadlines are shown in server time
  const serverNow = () => Date.now() + skew;
  const left = ms => { if (ms <= 0) return 'closed'; const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), hh = Math.floor(m % 1440 / 60), mm = m % 60; return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`; };
  const when = t => t ? new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const calm = () => root.classList.contains('calm') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  function toastA(msg) { let el = root.querySelector('.ar-toast'); if (!el) { el = document.createElement('div'); el.className = 'ar-toast'; el.setAttribute('role', 'status'); root.appendChild(el); } el.textContent = msg; el.hidden = false; clearTimeout(toastA.t); toastA.t = setTimeout(() => { el.hidden = true; }, 2600); }

  /* ---------- device storage: IndexedDB, with localStorage as a fallback ---------- */
  const store = (() => {
    let dbp = null, useLS = typeof indexedDB === 'undefined';
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('jos-arena', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const s of ['kv', 'outbox', 'oplog']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
    const lsKey = (s, k) => `jos-arena:${s}:${k}`;
    async function run(s, mode, fn) {
      if (!useLS) try {
        const d = await open();
        return await new Promise((res, rej) => { const t = d.transaction(s, mode), q = fn(t.objectStore(s)); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      } catch (e) { useLS = true; }
      return null;
    }
    return {
      async get(s, k) { const v = await run(s, 'readonly', os => os.get(k)); if (!useLS) return v === undefined ? null : v; try { return JSON.parse(localStorage.getItem(lsKey(s, k))); } catch (e) { return null; } },
      async put(s, k, v) { await run(s, 'readwrite', os => os.put(v, k)); if (useLS) try { localStorage.setItem(lsKey(s, k), JSON.stringify(v)); } catch (e) {} },
      async del(s, k) { await run(s, 'readwrite', os => os.delete(k)); if (useLS) try { localStorage.removeItem(lsKey(s, k)); } catch (e) {} },
      async all(s) {
        if (!useLS) { const v = await run(s, 'readonly', os => os.getAll()); if (!useLS) return v || []; }
        const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(`jos-arena:${s}:`)) out.push(JSON.parse(localStorage.getItem(k))); } } catch (e) {} return out;
      }
    };
  })();

  /* ---------- the API ---------- */
  let session = null, online = navigator.onLine !== false, apiUp = null;
  class Offline extends Error {}
  async function api(method, path, body) {
    let r;
    try {
      r = await fetch('/api' + path, { method, headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-arena': '1' } : {}), ...(session ? { authorization: 'Bearer ' + session.token } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch (e) { setOnline(false); throw new Offline('You are offline.'); }
    setOnline(true);
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (data && typeof data.now === 'number') skew = data.now - Date.now();
    if (!r.ok) { const e = new Error(data.message || `Request failed (${r.status}).`); e.status = r.status; e.code = data.error; e.data = data; if (r.status === 401 && session) { /* signed out elsewhere */ } throw e; }
    return data;
  }
  // GET with a device copy for offline viewing
  async function cached(key, path) {
    try { const d = await api('GET', path); await store.put('kv', 'c:' + key, { d, at: Date.now() }); return { ...d, _fresh: true }; }
    catch (e) { if (!(e instanceof Offline)) throw e; const c = await store.get('kv', 'c:' + key); if (!c) throw e; return { ...c.d, _fresh: false, _at: c.at }; }
  }
  function setOnline(v) { if (online !== v) { online = v; paintTop(); if (v) kickSync(); } }
  addEventListener('online', () => { setOnline(true); kickSync(); });
  addEventListener('offline', () => setOnline(false));

  /* ---------- offline queue and sync ---------- */
  // Every finished turn becomes an operation with a unique id. It stays on the device until the server answers.
  // The server replays it and either accepts it (and may correct the numbers) or rejects it with a reason.
  let syncing = false, syncTimer = null, backoff = 0;
  const outbox = async () => (await store.all('outbox')).sort((a, b) => a.createdAt - b.createdAt);
  async function queueTurn(op) { await store.put('outbox', op.opId, op); paintTop(); kickSync(); }
  function kickSync(delay = 0) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, delay); }
  async function syncNow() {
    if (syncing || !session) return;
    const ops = await outbox();
    if (!ops.length) { backoff = 0; paintTop(); return; }
    syncing = true; paintTop();
    try {
      const res = await api('POST', '/sync', { ops: ops.slice(0, 20).map(o => ({ opId: o.opId, kind: o.kind, roomId: o.roomId, week: o.week, turn: o.turn, baseVersion: o.baseVersion, decisions: o.decisions, clientHash: o.clientHash })) });
      const rooms = new Set();
      let failedRoom = null;
      for (const r of res.results) {
        const op = ops.find(o => o.opId === r.opId); if (!op) continue;
        rooms.add(op.roomId);
        const entry = { opId: op.opId, roomId: op.roomId, roomName: op.roomName, week: op.week, turn: op.turn, status: r.status, reason: r.reason || null, message: r.message || null, corrected: r.status === 'accepted' && r.match === false, at: Date.now(), createdAt: op.createdAt };
        await store.put('oplog', op.opId, entry);
        await store.del('outbox', op.opId);
        if (r.status === 'rejected') failedRoom = op.roomId;
        if (entry.corrected) toastA('The server corrected one of your turns. Its numbers are the official ones.');
      }
      // turns that were built on a rejected turn cannot stand either: keep them visible in the sync log
      if (failedRoom) for (const op of (await outbox()).filter(o => o.roomId === failedRoom)) {
        await store.put('oplog', op.opId, { opId: op.opId, roomId: op.roomId, roomName: op.roomName, week: op.week, turn: op.turn, status: 'rejected', reason: 'depends_on_rejected', message: 'An earlier turn in this queue was not accepted, so this one could not be applied.', at: Date.now(), createdAt: op.createdAt });
        await store.del('outbox', op.opId);
      }
      for (const id of rooms) await refreshPlay(id).catch(() => {});
      if (failedRoom) toastA('A queued turn was not accepted. Open Sync status to see why.');
      backoff = 0;
      if ((await outbox()).length) kickSync(500);
    } catch (e) {
      backoff = Math.min(6, backoff + 1);
      for (const o of ops) { o.attempts = (o.attempts || 0) + 1; o.lastError = e instanceof Offline ? 'offline' : e.message; await store.put('outbox', o.opId, o); }
      kickSync(Math.min(60000, 1000 * 2 ** backoff) + Math.random() * 800);
    } finally { syncing = false; paintTop(); if (current && current.live) current.live(); }
  }
  addEventListener('visibilitychange', () => { if (!document.hidden) kickSync(); });

  // the server's copy of my state in a room, plus what is still waiting in the queue
  async function refreshPlay(roomId) {
    const p = await api('GET', `/rooms/${roomId}/play`);
    await store.put('kv', 'play:' + roomId, { ...p, fetchedAt: Date.now() });
    const t = await store.get('kv', 'turn:' + roomId);
    // a half-played turn that no longer fits the server's state is discarded only after it is shown to the player
    if (t && (t.week !== p.week || t.baseVersion < p.stateVersion)) { const pend = (await outbox()).filter(o => o.roomId === roomId); if (!pend.length) await store.put('kv', 'turn:' + roomId, { ...t, stale: true }); }
    return p;
  }
  async function localPlay(roomId) {
    const p = await store.get('kv', 'play:' + roomId);
    if (!p) return null;
    const pend = (await outbox()).filter(o => o.roomId === roomId && o.week === p.week).sort((a, b) => a.turn - b.turn);
    const last = pend[pend.length - 1];
    return { ...p, server: p, pending: pend, localState: last ? last.localState : p.state, localVersion: p.stateVersion + pend.length, localUsed: p.turnsUsed + pend.length };
  }

  /* ---------- session ---------- */
  async function loadSession() { session = await store.get('kv', 'session'); return session; }
  async function saveSession(s) { session = s; await store.put('kv', 'session', s); }

  /* ---------- the city at night (drawn in code, no image files) ---------- */
  function skyline() {
    let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const layer = (y, hmin, hmax, wmin, wmax, fill, lit, domes) => {
      let x = -10, out = '';
      while (x < 1610) {
        const w = wmin + r() * (wmax - wmin), hh = hmin + r() * (hmax - hmin), top = y - hh;
        out += `<rect x="${x.toFixed(0)}" y="${top.toFixed(0)}" width="${w.toFixed(0)}" height="${(400 - top).toFixed(0)}" fill="${fill}"/>`;
        if (domes && r() < 0.18) out += `<ellipse cx="${(x + w / 2).toFixed(0)}" cy="${top.toFixed(0)}" rx="${(w / 2.2).toFixed(0)}" ry="${(w / 2.6).toFixed(0)}" fill="${fill}"/>`;
        if (lit) for (let wy = top + 8; wy < 390; wy += 14) for (let wx = x + 5; wx < x + w - 6; wx += 11) if (r() < lit) out += `<rect class="${r() < 0.15 ? 'win' : ''}" x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="4" height="6" fill="${r() < 0.7 ? '#F3C65A' : '#9FB6FF'}" opacity=".8" style="animation-delay:${(r() * 6).toFixed(1)}s"/>`;
        x += w + r() * 6;
      }
      return out;
    };
    // back: Abuja domes and towers; middle: Lagos high-rises; front: Port Harcourt waterfront
    return `<svg viewBox="0 0 1600 400" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><defs><linearGradient id="arw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E2A3A"/><stop offset="1" stop-color="#061016"/></linearGradient></defs>
      <circle cx="1240" cy="120" r="46" fill="#F3B53A" opacity=".18"/><circle cx="1240" cy="120" r="24" fill="#FFD777" opacity=".5"/>
      ${layer(250, 30, 120, 40, 90, '#16264A', 0.05, true)}${layer(300, 40, 210, 30, 70, '#0F1C36', 0.12)}${layer(350, 20, 80, 50, 120, '#0A1424', 0.08)}
      <rect x="0" y="352" width="1600" height="48" fill="url(#arw)"/><path d="M0 360 Q 400 352 800 360 T 1600 360" stroke="#F3B53A" stroke-opacity=".25" fill="none"/></svg>`;
  }

  /* ---------- shell and routing ---------- */
  let current = null, pollTimer = null, opened = false;
  function shell() {
    root.innerHTML = `<div class="stars" aria-hidden="true"></div><div class="sky" aria-hidden="true">${skyline()}</div>
      <div class="ar-shell"><div class="ar-top" id="ar-top"></div><main id="ar-main" tabindex="-1" aria-live="polite"></main></div>`;
    try { if (localStorage.getItem('jos-arena-calm') === '1') root.classList.add('calm'); } catch (e) {}
  }
  async function paintTop() {
    const top = document.getElementById('ar-top'); if (!top) return;
    const n = session ? (await outbox()).length : 0;
    const chip = !online ? `<span class="ar-chip bad" title="Turns you play are saved on this device and sent when you are back online"><i></i>Offline</span>`
      : syncing ? `<span class="ar-chip warn"><i></i>Syncing…</span>` : n ? `<span class="ar-chip warn"><i></i>${n} waiting to sync</span>` : `<span class="ar-chip on"><i></i>Synced</span>`;
    top.innerHTML = `<button class="ar-btn ghost sm" data-a="exit" aria-label="Back to single player">← <span class="ar-hide-sm">Single player</span></button>
      <a class="brand" href="#arena" aria-label="Challenge Arena home">🏆 <span>Challenge <b>Arena</b></span> <small>Japa or Stay</small></a>
      ${session ? `<a href="#arena/sync" class="ar-chip-link" aria-label="Sync status">${chip}</a>` : ''}`;
  }
  const main = () => document.getElementById('ar-main');
  function paint(html) { const m = main(); if (m) m.innerHTML = html; }
  function loading() { paint(`<div class="ar-skel"></div><div class="ar-skel"></div><div class="ar-skel"></div>`); }
  function failure(e, retry) {
    const off = e instanceof Offline;
    paint(`<div class="ar-panel ar-empty"><b>${off ? 'You are offline' : 'That did not load'}</b>${h(off ? 'This screen needs the internet the first time. Screens you have opened before still work offline.' : e.message)}
      <div class="ar-row2" style="justify-content:center;margin-top:12px"><button class="ar-btn" data-a="retry">Try again</button><a class="ar-btn ghost" href="#arena">Arena home</a></div></div>`);
    current = { ...(current || {}), retry };
  }
  const ROUTES = [
    [/^arena$/, homeScreen], [/^arena\/welcome$/, welcomeScreen], [/^arena\/create$/, createScreen], [/^arena\/join(?:\/([A-Za-z0-9-]+))?$/, joinScreen],
    [/^arena\/invite\/([A-Za-z0-9-]+)$/, inviteScreen], [/^arena\/room\/([\w]+)$/, roomScreen], [/^arena\/room\/([\w]+)\/rules$/, rulesScreen],
    [/^arena\/room\/([\w]+)\/settings$/, settingsScreen], [/^arena\/room\/([\w]+)\/character$/, characterScreen], [/^arena\/room\/([\w]+)\/me$/, overviewScreen],
    [/^arena\/room\/([\w]+)\/play$/, playScreen], [/^arena\/room\/([\w]+)\/board(?:\/(\w+))?$/, boardScreen], [/^arena\/room\/([\w]+)\/compare\/([\w]+)$/, compareScreen],
    [/^arena\/room\/([\w]+)\/week\/(\d+)$/, ceremonyScreen], [/^arena\/room\/([\w]+)\/final$/, finalScreen], [/^arena\/room\/([\w]+)\/journey$/, journeyScreen],
    [/^arena\/leaderboard$/, globalBoardScreen], [/^arena\/profile(?:\/([\w]+))?$/, profileScreen], [/^arena\/achievements$/, achievementsScreen],
    [/^arena\/history$/, historyScreen], [/^arena\/friends$/, friendsScreen], [/^arena\/sync$/, syncScreen], [/^arena\/rival\/([\w]+)$/, rivalScreen]
  ];
  async function route() {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!/^arena(\/|$)/.test(hash)) { if (opened) close(); return; }
    if (!opened) openArena();
    clearInterval(pollTimer); pollTimer = null; current = null;
    await loadSession();
    if (!session && !/^arena\/(welcome|invite\/)/.test(hash)) { sessionStorage.setItem('jos-arena-after', hash); location.hash = '#arena/welcome'; return; }
    const [rx, fn] = ROUTES.find(([x]) => x.test(hash)) || [];
    paintTop();
    if (!fn) { paint(`<div class="ar-panel ar-empty"><b>That screen does not exist</b><a class="ar-btn" href="#arena">Arena home</a></div>`); return; }
    const args = hash.match(rx).slice(1);
    loading();
    try { await fn(...args); } catch (e) { failure(e, () => route()); }
    const m = main(); if (m && document.activeElement === document.body) m.focus({ preventScroll: true });
  }
  // the single-player page underneath is made inert, so keyboards and screen readers stay inside the Arena
const behind = () => document.querySelectorAll('body > .wrap, body > footer.foot');
  function openArena() { opened = true; shell(); root.hidden = false; document.body.classList.add('arena-open'); behind().forEach(el => { el.inert = true; }); }
  function close() { opened = false; clearInterval(pollTimer); root.hidden = true; root.innerHTML = ''; document.body.classList.remove('arena-open'); behind().forEach(el => { el.inert = false; }); }
  function exitArena() { history.pushState(null, '', location.pathname + location.search); close(); try { render(); } catch (e) {} }
  // live updates: poll a tiny "version" endpoint while a room screen is open and visible, refetch only on change
  function watchRoom(roomId, version, ms, onChange) {
    let v = version;
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (document.hidden || !online) return;
      try { const r = await api('GET', `/rooms/${roomId}/version`); if (r.version !== v) { v = r.version; onChange(r); } } catch (e) {}
    }, ms);
  }

  /* ---------- clicks, forms ---------- */
  const ACT = {};
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]'); if (!b || !root.contains(b)) return;
    e.preventDefault();
    const fn = ACT[b.dataset.a]; if (!fn) return;
    if (b.dataset.busy) return;
    b.dataset.busy = '1';
    try { await fn(b); } catch (err) { toastA(err instanceof Offline ? 'You are offline. Try again when you are connected.' : err.message); } finally { delete b.dataset.busy; }
  });
  root.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    const fn = ACT['form:' + f.dataset.form]; if (!fn) return;
    const btn = f.querySelector('[type=submit]'); if (btn) btn.disabled = true;
    try { await fn(f); } catch (err) { const el = f.querySelector('.ar-err'); if (el) el.textContent = err instanceof Offline ? 'You are offline. Try again when you are connected.' : err.message; else toastA(err.message); } finally { if (btn) btn.disabled = false; }
  });
  ACT.exit = exitArena;
  ACT.retry = () => current && current.retry ? current.retry() : route();
  ACT.go = b => { location.hash = b.dataset.to; };
  ACT.seg = b => { const g = b.closest('.ar-seg'); g.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b)); const inp = g.querySelector('input[type=hidden]') || g.parentElement.querySelector(`input[name="${g.dataset.name}"]`); if (inp) inp.value = b.dataset.v; };
  openBtn.addEventListener('click', () => { location.hash = '#arena'; });
  addEventListener('hashchange', route);

  /* ---------- welcome: an anonymous account, no email or password ---------- */
  async function welcomeScreen() {
    paint(`<section class="ar-hero"><h1>Welcome to the <em>Challenge Arena</em></h1><p>Play your own Japa or Stay life against friends. Every week the money table crowns a Cash King or Queen, and six more champions win the life categories.</p></section>
      <div class="ar-grid two">
        <form class="ar-panel ar-form" data-form="anon"><h2>New here?</h2>
          <label class="ar-field"><span>Display name</span><input type="text" name="displayName" maxlength="24" required autocomplete="nickname" placeholder="What friends call you"><small>Shown to the people in your challenges. No email, no password.</small></label>
          <p class="ar-err" role="alert"></p><button class="ar-btn" type="submit">Enter the Arena</button></form>
        <form class="ar-panel ar-form" data-form="recover"><h2>Played on another device?</h2>
          <label class="ar-field"><span>Recovery code</span><input type="text" name="code" maxlength="16" placeholder="XXXX-XXXX-XXXX" autocomplete="off"><small>You saw it when you first joined. It moves your Arena profile to this device.</small></label>
          <p class="ar-err" role="alert"></p><button class="ar-btn ghost" type="submit">Use my code</button></form>
      </div>`);
  }
  ACT['form:anon'] = async f => {
    const sp = (() => { try { return JSON.parse(localStorage.getItem('jos-save')); } catch (e) { return null; } })();
    const r = await api('POST', '/auth/anon', { displayName: f.displayName.value, avatar: sp && sp.av ? sp.av : (typeof setup !== 'undefined' ? setup.av : undefined) });
    await saveSession({ playerId: r.playerId, token: r.token, recoveryCode: r.recoveryCode });
    paint(`<div class="ar-panel ar-reveal" style="max-width:560px;margin:30px auto"><h2>You're in. Keep this code safe.</h2>
      <p>This is your recovery code. With it you can play from another phone or computer. Nobody else should see it.</p>
      <p class="ar-code" style="margin:14px 0">${h(r.recoveryCode)}</p>
      <div class="ar-row2"><button class="ar-btn ghost" data-a="copy" data-text="${h(r.recoveryCode)}">Copy code</button><button class="ar-btn" data-a="afterWelcome">Continue</button></div>
      <p class="ar-small ar-muted">You can see it again later in My profile on this device.</p></div>`);
  };
  ACT['form:recover'] = async f => {
    const r = await api('POST', '/auth/recover', { code: f.code.value });
    await saveSession({ playerId: r.playerId, token: r.token, recoveryCode: f.code.value.toUpperCase() });
    ACT.afterWelcome();
  };
  ACT.afterWelcome = () => { const next = sessionStorage.getItem('jos-arena-after'); sessionStorage.removeItem('jos-arena-after'); location.hash = '#' + (next && next !== 'arena/welcome' ? next : 'arena'); };
  ACT.copy = async b => { try { await navigator.clipboard.writeText(b.dataset.text); toastA('Copied.'); } catch (e) { toastA('Copy did not work. Select the text and copy it.'); } };

  /* ---------- 1. Arena home ---------- */
  async function homeScreen() {
    const d = await cached('home', '/home');
    const me = d.me, active = d.rooms.filter(r => r.status === 'active'), lobby = d.rooms.filter(r => r.status === 'lobby'), done = d.rooms.filter(r => r.status === 'complete');
    const pend = session ? (await outbox()).length : 0;
    const roomItem = r => {
      const due = r.status === 'active' ? `Week ${r.week} of ${r.weeks} · ${r.turnsUsed || 0}/${r.turnsPerWeek} turns · closes in ${left(r.deadline - serverNow())}` : r.status === 'lobby' ? `Lobby · ${r.players}/${r.maxPlayers} players${r.myStatus === 'pending' ? ' · waiting for the host' : r.myReady ? ' · you are ready' : ''}` : 'Complete';
      return `<button class="ar-item" data-a="go" data-to="#arena/room/${r.id}"><span class="grow"><span class="t">${h(r.name)}</span><span class="s">${h(due)}</span></span>${r.lastRank ? `<span class="ar-rank ${r.lastRank <= 3 ? 'g' + r.lastRank : ''}">${r.lastRank}</span>` : ''}</button>`;
    };
    paint(`${d._fresh ? '' : `<p class="ar-note warn">Offline copy from ${when(d._at)}.</p>`}
      <section class="ar-hero ar-reveal"><div class="ar-row2" style="margin-bottom:12px">${face(me.avatar, 'md')}<div><b>${h(me.displayName)}</b><div class="ar-small ar-muted">${me.moneyWins || 0} money crowns · ${me.categoryWins || 0} category wins</div></div></div>
        <h1>Who has the most <em>money</em> this week?</h1><p>Every player lives their own Naija life: a Lagos tech job, a shop in Kano, a flight to Northland. One table at the end of each game week decides who is winning.</p></section>
      <div class="ar-grid">
        <button class="ar-panel ar-tile feature" data-a="go" data-to="#arena/create"><span class="ic">✨</span><b>Create Challenge</b><span>Set the rules, invite friends, be the host.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/join"><span class="ic">🔑</span><b>Join Challenge</b><span>Use an invite code or browse open rooms.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/friends">${d.invitations.length + d.friendRequests ? `<span class="count">${d.invitations.length + d.friendRequests}</span>` : ''}<span class="ic">💌</span><b>Invitations & friends</b><span>${d.invitations.length} pending invitation${d.invitations.length === 1 ? '' : 's'}.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/leaderboard"><span class="ic">🌍</span><b>Lifetime leaderboard</b><span>Most weekly money crowns, everywhere.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/achievements"><span class="ic">🏅</span><b>Achievements</b><span>${(me.achievements || []).length} of ${Object.keys(R.ACHIEVEMENTS).length} unlocked.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/profile"><span class="ic">🪪</span><b>My profile</b><span>Records, privacy, recovery code.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/history"><span class="ic">📜</span><b>Challenge history</b><span>${done.length} finished · rematches.</span></button>
        <button class="ar-panel ar-tile" data-a="go" data-to="#arena/sync">${pend ? `<span class="count">${pend}</span>` : ''}<span class="ic">🔄</span><b>Sync status</b><span>${pend ? `${pend} turn${pend > 1 ? 's' : ''} waiting to sync.` : 'Everything is synced.'}</span></button>
      </div>
      <div class="ar-grid two" style="margin-top:14px">
        <section class="ar-panel"><h2>My active challenges</h2>${active.length ? `<div class="ar-list">${active.map(roomItem).join('')}</div>` : `<div class="ar-empty"><b>No challenge running</b>Create one and send the code to your friends.</div>`}</section>
        <section class="ar-panel"><h2>Lobbies & pending invitations</h2>
          ${d.invitations.map(i => `<div class="ar-item"><span class="grow"><span class="t">${h(i.room_name)}</span><span class="s">Invited by ${h(i.from_name)}</span></span><button class="ar-btn sm" data-a="inv" data-id="${i.id}" data-yes="1">Join</button><button class="ar-btn ghost sm" data-a="inv" data-id="${i.id}">Decline</button></div>`).join('')}
          ${lobby.length ? `<div class="ar-list">${lobby.map(roomItem).join('')}</div>` : d.invitations.length ? '' : `<div class="ar-empty"><b>Nothing waiting</b>Invitations from friends show up here.</div>`}</section>
      </div>`);
    current = { live: () => { if (location.hash === '#arena') homeScreen().catch(() => {}); } };
  }
  ACT.inv = async b => { const r = await api('POST', `/invitations/${b.dataset.id}`, { accept: !!b.dataset.yes }); if (r.roomId) location.hash = `#arena/room/${r.roomId}`; else route(); };

  /* ---------- 2. Create challenge, 23. Settings (same form) ---------- */
  function configForm(cfg, mode) {
    const c = { ...R.DEFAULTS, ...(cfg || {}) };
    const seg = (name, opts, val) => `<div class="ar-seg" data-name="${name}" role="group">${opts.map(([v, l]) => `<button type="button" data-a="seg" data-v="${v}" aria-pressed="${String(v) === String(val)}">${l}</button>`).join('')}<input type="hidden" name="${name}" value="${h(val)}"></div>`;
    return `<form class="ar-panel ar-form" data-form="${mode}">
      <h2>${mode === 'create' ? 'Create a challenge' : 'Challenge settings'}</h2>
      <label class="ar-field"><span>Challenge name</span><input type="text" name="name" maxlength="40" required value="${h(c.name)}" placeholder="e.g. Friday Hustle League"></label>
      <label class="ar-field"><span>Description <small>(optional)</small></span><textarea name="description" maxlength="200" placeholder="House rules, bragging rights…">${h(c.description)}</textarea></label>
      <div class="cols">
        <label class="ar-field"><span>Players (2–8)</span><select name="maxPlayers">${[2, 3, 4, 5, 6, 7, 8].map(n => `<option ${n === c.maxPlayers ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <div class="ar-field"><span>Length</span>${seg('weeks', R.OPTIONS.weeks.map(w => [w, `${w} weeks`]), c.weeks)}</div>
        <div class="ar-field"><span>Turns per game week</span>${seg('turnsPerWeek', R.OPTIONS.turnsPerWeek.map(w => [w, w]), c.turnsPerWeek)}<small>Each turn is one in-game week: plan cards, face events, settle up. Everyone gets the same number.</small></div>
        <div class="ar-field"><span>Each game week lasts</span>${seg('roundHours', [[24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '7 days']], c.roundHours)}<small>Real time. The server clock decides.</small></div>
      </div>
      <div class="cols">
        <div class="ar-field"><span>Starting money</span>${seg('startMoney', R.OPTIONS.startMoney.map(v => [v, N(v)]), c.startMoney)}</div>
        <div class="ar-field"><span>Difficulty</span>${seg('difficulty', [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], c.difficulty)}<small>Same start for everyone: Easy gives more money and energy, Hard less.</small></div>
        <div class="ar-field"><span>Who can see life stats</span>${seg('statsVisibility', [['full', 'Everyone'], ['summary', 'Money only']], c.statsVisibility)}</div>
      </div>
      <div class="cols">
        <div class="ar-field"><span>Room</span>${seg('visibility', [['private', 'Private (code only)'], ['public', 'Public (listed)']], c.visibility)}</div>
        <div class="ar-field"><span>Who can invite friends</span>${seg('invitePermission', [['host', 'Host only'], ['members', 'All members']], c.invitePermission)}</div>
        <label class="ar-field"><span>Late sync grace</span><select name="graceMinutes">${[0, 15, 30, 60, 120, 180].map(n => `<option value="${n}" ${n === c.graceMinutes ? 'selected' : ''}>${n ? n + ' minutes' : 'None'}</option>`).join('')}</select><small>Extra time for turns played offline to arrive after the deadline.</small></label>
      </div>
      <label class="ar-check"><input type="checkbox" name="approval" ${c.approval ? 'checked' : ''}><span><b>Approve join requests</b><br><small class="ar-muted">People with the code wait in the lobby until you let them in.</small></span></label>
      <label class="ar-check"><input type="checkbox" name="earlyFinish" ${c.earlyFinish ? 'checked' : ''}><span><b>End the week early when everyone has played</b><br><small class="ar-muted">Otherwise results come at the deadline.</small></span></label>
      <label class="ar-field"><span>Start date <small>(optional)</small></span><input type="datetime-local" name="startAt" value="${c.startAt ? new Date(c.startAt).toISOString().slice(0, 16) : ''}"><small>Leave empty to start by hand when everyone is ready.</small></label>
      <details><summary class="ar-link">Rename the awards</summary><div class="cols" style="margin-top:10px">${R.AWARDS.map(a => `<label class="ar-field"><span>${h(a.name)}</span><input type="text" name="aw_${a.key}" maxlength="28" value="${h((c.awardNames || {})[a.key] || '')}" placeholder="${h(a.name)}"></label>`).join('')}</div><small class="ar-muted">Names only: the scoring stays the same.</small></details>
      <p class="ar-err" role="alert"></p>
      <div class="ar-row2 ar-end"><a class="ar-btn ghost" href="${mode === 'create' ? '#arena' : location.hash.replace('/settings', '')}">Cancel</a><button class="ar-btn" type="submit">${mode === 'create' ? 'Create challenge' : 'Save settings'}</button></div>
    </form>`;
  }
  function readConfig(f) {
    const v = n => f.elements[n] && f.elements[n].value;
    const awardNames = {}; for (const a of R.AWARDS) { const x = v('aw_' + a.key); if (x) awardNames[a.key] = x; }
    return { name: v('name'), description: v('description'), maxPlayers: Number(v('maxPlayers')), weeks: Number(v('weeks')), turnsPerWeek: Number(v('turnsPerWeek')), roundHours: Number(v('roundHours')),
      startMoney: Number(v('startMoney')), difficulty: v('difficulty'), statsVisibility: v('statsVisibility'), visibility: v('visibility'), invitePermission: v('invitePermission'), graceMinutes: Number(v('graceMinutes')),
      approval: f.elements.approval.checked, earlyFinish: f.elements.earlyFinish.checked, startAt: v('startAt') ? new Date(v('startAt')).toISOString() : null, awardNames };
  }
  async function createScreen() { paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>${configForm({}, 'create')}`); }
  ACT['form:create'] = async f => { const r = await api('POST', '/rooms', readConfig(f)); location.hash = `#arena/room/${r.room.id}`; };
  async function settingsScreen(id) {
    const { room } = await api('GET', `/rooms/${id}`);
    if (!room.isHost || room.status !== 'lobby') { paint(`<div class="ar-panel ar-empty"><b>Settings are locked</b>Only the host can change settings, and only before the start.<a class="ar-btn" href="#arena/room/${id}">Back to the room</a></div>`); return; }
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← Lobby</a></div><p class="ar-note">Saving changes un-readies everyone, so nobody starts on rules they did not see.</p>${configForm({ ...room.config, name: room.name }, 'settings')}`);
    current = { roomId: id };
  }
  ACT['form:settings'] = async f => { const id = current.roomId; await api('PATCH', `/rooms/${id}/settings`, readConfig(f)); location.hash = `#arena/room/${id}`; };

  /* ---------- 3. Join, 4. Invitation details ---------- */
  async function joinScreen(code) {
    let pub = { rooms: [] };
    try { pub = await api('GET', '/rooms/public'); } catch (e) {}
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <form class="ar-panel ar-form" data-form="code" style="max-width:520px"><h2>Join with a code</h2>
        <label class="ar-field"><span>Invitation code</span><input type="text" name="code" maxlength="10" required value="${h(code || '')}" placeholder="8 letters and numbers" autocomplete="off" style="text-transform:uppercase;letter-spacing:.12em"></label>
        <p class="ar-err" role="alert"></p><button class="ar-btn" type="submit">See the challenge</button></form>
      <section class="ar-panel"><h2>Open challenges</h2>${pub.rooms.length ? `<div class="ar-list">${pub.rooms.map(r => `<div class="ar-item"><span class="grow"><span class="t">${h(r.name)}</span><span class="s">Host ${h(r.host)} · ${r.players}/${r.maxPlayers} players · ${r.weeks} weeks${r.approval ? ' · host approves' : ''}</span></span><button class="ar-btn sm" data-a="joinPublic" data-id="${r.id}">Join</button></div>`).join('')}</div>` : `<div class="ar-empty"><b>No public lobbies right now</b>Ask a friend for their code, or create your own.</div>`}</section>`);
  }
  ACT['form:code'] = async f => { location.hash = `#arena/invite/${f.code.value.trim().toUpperCase()}`; };
  ACT.joinPublic = async b => { const r = await api('POST', '/rooms/join', { roomId: b.dataset.id }); location.hash = `#arena/room/${r.room.id}`; };
  async function inviteScreen(code) {
    if (!session) { sessionStorage.setItem('jos-arena-after', 'arena/invite/' + code); location.hash = '#arena/welcome'; return; }
    const { invite: i } = await api('GET', `/invite/${encodeURIComponent(code)}`);
    const c = i.rules;
    paint(`<div class="ar-panel ar-reveal" style="max-width:620px;margin:20px auto">
      <div class="ar-small ar-muted">Invitation from ${h(i.host)}</div><h2 style="font-size:28px">${h(i.name)}</h2>${i.description ? `<p>${h(i.description)}</p>` : ''}
      <div class="ar-stats" style="margin:14px 0">${[['Players', `${i.players}/${i.maxPlayers}`], ['Length', `${c.weeks} game weeks`], ['Turns a week', c.turnsPerWeek], ['Week lasts', c.roundHours >= 168 ? '7 days' : c.roundHours / 24 + ' day' + (c.roundHours > 24 ? 's' : '')], ['Start money', N(c.startMoney)], ['Difficulty', c.difficulty]].map(([k, v]) => `<div class="ar-stat"><div class="k">${k}</div><div class="v" style="font-size:16px">${h(v)}</div></div>`).join('')}</div>
      ${i.status !== 'lobby' ? `<p class="ar-note bad">This challenge has ${i.status === 'active' ? 'already started' : 'ended'}, so it cannot take new players.</p>` : c.approval ? '<p class="ar-note">The host approves each new player.</p>' : ''}
      <div class="ar-row2"><a class="ar-btn ghost" href="#arena">Not now</a><button class="ar-btn" data-a="joinCode" data-code="${h(code)}" ${i.status !== 'lobby' || i.players >= i.maxPlayers ? 'disabled' : ''}>${i.players >= i.maxPlayers ? 'Challenge full' : 'Join challenge'}</button></div></div>`);
  }
  ACT.joinCode = async b => { const r = await api('POST', '/rooms/join', { code: b.dataset.code }); toastA(r.status === 'pending' ? 'Request sent. The host will let you in.' : 'You joined!'); location.hash = `#arena/room/${r.room.id}`; };

  /* ---------- 5. Lobby, or the week dashboard, or the final results ---------- */
  async function roomScreen(id) {
    const d = await cached('room:' + id, `/rooms/${id}`);
    const room = d.room;
    if (room.status === 'active') return dashboardScreen(id, room, d._fresh);
    if (room.status === 'complete') return finalScreen(id, room);
    return lobbyScreen(id, room);
  }
  async function lobbyScreen(id, room) {
    const me = room.participants.find(p => p.isMe), joined = room.participants.filter(p => p.status === 'joined'), pending = room.participants.filter(p => p.status === 'pending');
    const allReady = joined.length >= 2 && joined.every(p => p.ready);
    const startAt = room.config.startAt && Date.parse(room.config.startAt);
    // /i/CODE is a real page, so chat apps show a preview of the game and the challenge (a #link would not)
    const link = room.code ? `${location.origin}/i/${room.code}` : '';
    const host = room.participants.find(p => p.isHost);
    const msg = `🏆 ${host ? host.displayName : 'I'} is challenging you on Japa or Stay!\n\n`
      + `It's a free Naija life game: japa abroad or stay and build at home. Get a job, start a business, chase the visa, and look after your family, your body and your people.\n\n`
      + `In our challenge "${room.name}", everyone lives their own life. Each week, whoever has the most money wins the crown. ${room.config.weeks} weeks, ${room.config.turnsPerWeek} turns a week.\n\n`
      + `Join here: ${link}\n(or use code ${room.code} in the Multiplayer Arena)`;
    if (room.status === 'cancelled') { paint(`<div class="ar-panel ar-empty"><b>${h(room.name)} was cancelled</b>The host cancelled it before it started.<a class="ar-btn" href="#arena">Arena home</a></div>`); return; }
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <section class="ar-panel ar-reveal"><div class="ar-row2"><div class="grow" style="flex:1;min-width:220px"><div class="ar-small ar-muted">Lobby · ${joined.length} of ${room.config.maxPlayers} players</div><h2 style="font-size:26px;margin:2px 0 4px">${h(room.name)}</h2>${room.description ? `<p class="ar-muted" style="margin:0">${h(room.description)}</p>` : ''}</div>
        <div><span class="ar-chip ${allReady ? 'on' : 'warn'}"><i></i>${startAt ? `Starts ${when(startAt)}` : allReady ? 'Everyone is ready' : 'Waiting for players'}</span></div></div>
        ${me && me.status === 'pending' ? '<p class="ar-note" style="margin-top:12px">Your request is waiting for the host. This page updates by itself.</p>' : ''}</section>
      <section class="ar-panel"><h2>Players</h2><div class="ar-seats">
        ${joined.map(p => `<div class="ar-seat ${p.ready ? 'ready' : ''}">${face(p.character ? p.character.av : p.avatar, 'lg', p.ready ? 'happy' : 'flat')}<b>${h(p.character ? p.character.name : p.displayName)}</b><span class="s">${h(p.displayName)}${p.isHost ? ' · host' : ''}</span>
          <span class="ar-chip ${p.ready ? 'on' : ''}"><i></i>${p.ready ? 'Ready' : p.character ? 'Not ready' : 'Making character'}</span>
          ${room.isHost && !p.isMe ? `<button class="ar-link ar-small" data-a="removeP" data-id="${p.id}" data-name="${h(p.displayName)}">Remove</button>` : ''}</div>`).join('')}
        ${Array.from({ length: Math.max(0, room.config.maxPlayers - joined.length) }, () => `<div class="ar-seat open">Open seat</div>`).join('')}
      </div>
      ${room.isHost && pending.length ? `<h3 style="margin-top:16px">Join requests</h3><div class="ar-list">${pending.map(p => `<div class="ar-item">${face(p.avatar, 'sm')}<span class="grow"><span class="t">${h(p.displayName)}</span></span><button class="ar-btn sm" data-a="approve" data-id="${p.id}" data-yes="1">Let in</button><button class="ar-btn ghost sm" data-a="approve" data-id="${p.id}">Decline</button></div>`).join('')}</div>` : ''}
      </section>
      ${me && me.status === 'joined' ? `<section class="ar-panel"><h2>You</h2><div class="ar-row2">
        ${me.character ? `${face(me.character.av, 'lg')}<div style="flex:1"><b>${h(me.character.name)}</b><div class="ar-small ar-muted">${h(REGIONS[me.character.region].name)} · ${h(TRAITS[me.character.trait].name)}</div></div><a class="ar-btn ghost sm" href="#arena/room/${id}/character">Edit character</a>
          <button class="ar-btn ${me.ready ? 'ghost' : 'stay'}" data-a="ready" data-v="${me.ready ? '' : '1'}">${me.ready ? 'Not ready' : "I'm ready"}</button>`
        : `<p style="flex:1;margin:0">Create the character you will play in this challenge.</p><a class="ar-btn" href="#arena/room/${id}/character">Create character</a>`}</div></section>` : ''}
      ${room.code ? `<section class="ar-panel"><h2>Invite friends</h2><div class="ar-row2"><span class="ar-code">${h(room.code)}</span>
        <button class="ar-btn ghost sm" data-a="copy" data-text="${h(msg)}">Copy invitation</button><button class="ar-btn ghost sm" data-a="copy" data-text="${h(link)}">Copy link only</button>
        <a class="ar-btn ghost sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Share on WhatsApp</a>
        ${navigator.share ? `<button class="ar-btn ghost sm" data-a="shareLink" data-text="${h(msg)}">Share…</button>` : ''}
        <a class="ar-btn ghost sm" href="#arena/friends?room=${id}">Invite from friends</a></div>
        <p class="ar-small ar-muted">The code only shows the challenge; ${room.config.approval ? 'you still approve every player' : 'anyone with it can take an open seat until the start'}.</p></section>` : ''}
      <section class="ar-panel"><div class="ar-row2">
        <a class="ar-btn ghost" href="#arena/room/${id}/rules">Challenge rules</a>
        ${room.isHost ? `<a class="ar-btn ghost" href="#arena/room/${id}/settings">Settings</a><button class="ar-btn danger" data-a="cancelRoom">Cancel challenge</button>
          <span style="flex:1"></span><button class="ar-btn" data-a="start" ${allReady && !(startAt && startAt > serverNow()) ? '' : 'disabled'}>Start challenge</button>`
        : `<span style="flex:1"></span><button class="ar-btn danger" data-a="leave">Leave challenge</button>`}</div>
        ${room.isHost && !allReady ? `<p class="ar-small ar-muted" style="margin:10px 0 0">You can start when at least 2 players have joined and everyone is ready.</p>` : ''}</section>`);
    current = { roomId: id, room };
    watchRoom(id, room.version, 4000, () => roomScreen(id));
  }
  ACT.ready = async b => { await api('POST', `/rooms/${current.roomId}/ready`, { ready: !!b.dataset.v }); roomScreen(current.roomId); };
  ACT.approve = async b => { await api('POST', `/rooms/${current.roomId}/approve`, { participantId: b.dataset.id, accept: !!b.dataset.yes }); roomScreen(current.roomId); };
  ACT.removeP = async b => { if (!confirm(`Remove ${b.dataset.name} from this challenge? They will not be able to rejoin.`)) return; await api('POST', `/rooms/${current.roomId}/remove`, { participantId: b.dataset.id }); roomScreen(current.roomId); };
  ACT.cancelRoom = async () => { if (!confirm('Cancel this challenge for everyone? This cannot be undone.')) return; await api('POST', `/rooms/${current.roomId}/cancel`); location.hash = '#arena'; };
  ACT.leave = async () => { if (!confirm('Leave this challenge?')) return; await api('POST', `/rooms/${current.roomId}/leave`); location.hash = '#arena'; };
  ACT.start = async () => { await api('POST', `/rooms/${current.roomId}/start`); fire(); toastA('The challenge has started. Week 1 is open!'); roomScreen(current.roomId); };
  ACT.shareLink = async b => { try { await navigator.share({ text: b.dataset.text }); } catch (e) {} };

  /* ---------- 6. Player ready: create the Arena character ---------- */
  let draftChar = null;
  async function characterScreen(id) {
    const { room } = await api('GET', `/rooms/${id}`);
    const me = room.participants.find(p => p.isMe);
    if (room.status !== 'lobby') { location.hash = `#arena/room/${id}/me`; return; }
    let sp = null; try { sp = JSON.parse(localStorage.getItem('jos-save')); } catch (e) {}
    draftChar = draftChar && draftChar.room === id ? draftChar : { room: id, name: me.character ? me.character.name : (sp && sp.name) || me.displayName, region: me.character ? me.character.region : 'lagos', trait: me.character ? me.character.trait : 'hustler', av: me.character ? me.character.av : (sp && sp.av) || { ...AV_DEFAULT, ...(me.avatar || {}) } };
    const dc = draftChar;
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← Lobby</a></div>
      <form class="ar-panel ar-form" data-form="char"><h2>Your Arena character</h2>
        <div class="ar-row2"><div id="ar-av">${face(dc.av, 'xl')}</div><div class="ar-row2" style="flex-direction:column;align-items:flex-start">
          <button type="button" class="ar-btn ghost sm" data-a="avShuffle">🎲 New look</button>${sp && sp.av ? '<button type="button" class="ar-btn ghost sm" data-a="avMine">Use my single-player look</button>' : ''}</div></div>
        <label class="ar-field"><span>Character name</span><input type="text" name="name" maxlength="20" required value="${h(dc.name)}"></label>
        <div class="ar-field"><span>Home city</span><div class="ar-seg" data-name="region">${Object.entries(REGIONS).map(([k, r]) => `<button type="button" data-a="seg" data-v="${k}" aria-pressed="${k === dc.region}">${h(r.name)}</button>`).join('')}<input type="hidden" name="region" value="${dc.region}"></div><small>${Object.values(REGIONS).map(r => `${r.name}: ${r.note}`).join(' · ')}</small></div>
        <div class="ar-field"><span>Trait</span><div class="ar-seg" data-name="trait">${Object.entries(TRAITS).map(([k, t]) => `<button type="button" data-a="seg" data-v="${k}" aria-pressed="${k === dc.trait}" title="${h(t.d)}">${h(t.name)}</button>`).join('')}<input type="hidden" name="trait" value="${dc.trait}"></div><small>${Object.values(TRAITS).map(t => `${t.name}: ${t.d}`).join(' · ')}</small></div>
        <p class="ar-note">Everyone in this challenge starts with ${N(room.config.startMoney)} on ${h(room.config.difficulty)} difficulty. Your choices from here make the difference.</p>
        <p class="ar-err" role="alert"></p><div class="ar-row2 ar-end"><button class="ar-btn" type="submit">Save character</button></div></form>`);
    current = { roomId: id };
  }
  ACT.avShuffle = () => { draftChar.av = randomAv(); document.getElementById('ar-av').innerHTML = face(draftChar.av, 'xl'); };
  ACT.avMine = () => { try { draftChar.av = JSON.parse(localStorage.getItem('jos-save')).av; document.getElementById('ar-av').innerHTML = face(draftChar.av, 'xl'); } catch (e) {} };
  ACT['form:char'] = async f => {
    const body = { name: f.name.value, region: f.elements.region.value, trait: f.elements.trait.value, av: draftChar.av };
    await api('POST', `/rooms/${current.roomId}/character`, body);
    draftChar = null; toastA('Character saved. Mark yourself ready when you are set.');
    location.hash = `#arena/room/${current.roomId}`;
  };

  /* ---------- 7. Challenge rules ---------- */
  async function rulesScreen(id) {
    const d = await cached('room:' + id, `/rooms/${id}`), c = d.room.config, RV = R.rulesFor(d.room.rulesVersion) || R.RULES[R.CURRENT];
    const w = RV.weights;
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← Back to the challenge</a></div>
      <article class="ar-panel"><h2>How ${h(d.room.name)} works</h2>
      <h3>The weeks</h3><p>The challenge runs for <b>${c.weeks} game weeks</b>. Each game week lasts <b>${c.roundHours / 24} real day${c.roundHours > 24 ? 's' : ''}</b> on the server clock, not your phone's clock. In each game week every player gets exactly <b>${c.turnsPerWeek} turns</b>. A turn is one in-game week of the normal game: pick cards with your 21 time blocks, face what life throws at you, then settle up (pay, rent, food, debts). Playing faster never gives you more turns.</p>
      <p>${c.earlyFinish ? 'If everyone finishes their turns early, the week closes straight away and the results ceremony opens.' : 'Results are announced at the deadline.'} Turns you do not play by the deadline are played by <b>autopilot</b>: it works (or job-hunts) and rests, takes the first option on every event, and keeps building at home at the end of Year 1. Autopilot turns are marked in the history.</p>
      <h3>Offline play</h3><p>Once you have opened a week online, you can play all of that week's remaining turns with no internet. They are saved on your device and sent when you reconnect. The server replays every decision on the same game rules and the same hidden dice, so the numbers can never be edited on a device. Turns that reach the server after the deadline${c.graceMinutes ? ` plus ${c.graceMinutes} minutes of grace` : ''} do not count; a finished week is final and never changes.</p>
      <h3>The money table</h3><p><b>Weekly Money Rank = end-of-week eligible cash.</b> Eligible cash is your naira, plus your dollars at a fixed competition rate of <b>${N(RV.fxRate)} per $1</b> (the same for everyone), minus everything you owe: loan-app debt, credit-card debt, bank-loan repayments still to make and supplier credit. Borrowed money never counts as earned wealth. Net worth (cash plus business, land, house and solar at book value, minus debts) is shown separately.</p>
      <p>Ties: equal eligible cash is decided by net worth, then Life Balance. Players still level on all three share the place and the award.</p>
      <h3>The life categories</h3><p>Strength, Happiness, Body, Family Matters, Your People (0–100) and Clout (fans). The winner of each is the highest current value at the end of the week; ties go to the better Life Balance, then the award is shared. Weekly change and lifetime gains are tracked separately from the current value, so a stat is never added up week after week.</p>
      <h3>Life Balance Score</h3><p>Money ${w.money * 100}% (eligible cash on a log scale from ${N(RV.moneyFloor)} = 0 to ${N(RV.moneyCap)} = 100), and ${w.strength * 100}% each for Strength, Happiness, Body, Family Matters, Your People and Clout (fans on a log scale, ${RV.cloutCap.toLocaleString()} fans = 100).</p>
      <h3>Awards</h3><ul>${R.AWARDS.map(a => `<li><b>${h(R.awardName(a.key, c, null))}</b>: ${{ money: 'most eligible cash', overall: 'highest Life Balance', comeback: 'biggest climb up the money table (from week 2)', improved: 'biggest rise in Life Balance' }[a.key] || 'highest ' + STATN[a.key]}</li>`).join('')}</ul>
      <p class="ar-small ar-muted">Awards are titles: they never add money or stats. Rules version ${h(d.room.rulesVersion)}. Northland and everyone in the game are fictional; nothing here is financial or immigration advice.</p></article>`);
  }

  /* ---------- 10. Weekly progress dashboard ---------- */
  async function dashboardScreen(id, room, fresh) {
    let lp = await localPlay(id);
    if (online) try { await refreshPlay(id); lp = await localPlay(id); } catch (e) {}
    let board = null; try { board = await cached('board:' + id + ':current', `/rooms/${id}/board?week=current`); } catch (e) {}
    const T = room.config.turnsPerWeek, used = lp ? lp.localUsed : 0, cutoff = lp ? lp.cutoff : room.cutoff, closed = serverNow() > cutoff;
    const st = lp ? lp.localState : null, m = st ? R.metrics(st, R.rulesFor(room.rulesVersion)) : null;
    const turnDraft = await store.get('kv', 'turn:' + id);
    const lastWeek = room.week - 1;
    const pips = Array.from({ length: T }, (_, i) => `<i class="${i < (lp ? lp.server.turnsUsed : 0) ? 'done' : i < used ? 'pend' : i === used ? 'now' : ''}"></i>`).join('');
    const top = board ? board.rows.slice().sort((a, b) => a.ranks.money - b.ranks.money) : [];
    paint(`${fresh === false ? '<p class="ar-note warn">Offline: showing your saved copy.</p>' : ''}
      <div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <section class="ar-panel ar-reveal"><div class="ar-small ar-muted">${h(room.name)}</div>
        <div class="ar-row2" style="margin-top:2px"><h2 style="font-size:28px;margin:0;flex:1">Week ${room.week} <span class="ar-muted" style="font-size:16px">of ${room.config.weeks}</span></h2>
          <span class="ar-chip ${closed ? 'bad' : 'warn'}"><i></i>${closed ? 'Deadline passed' : `Closes in ${left(room.deadline - serverNow())}`}</span></div>
        <div class="ar-turnbar" style="margin-top:12px"><div class="ar-pips" aria-label="${used} of ${T} turns played">${pips}</div><span class="ar-small ar-muted">${used} of ${T} turns played${lp && lp.pending.length ? ` · ${lp.pending.length} waiting to sync` : ''}</span></div>
        <div class="ar-row2" style="margin-top:14px">${lp && lp.server.storyDone ? '<p class="ar-note" style="margin:0">Your story is complete. Your final life stands on the table.</p>'
          : used >= T ? `<p class="ar-note" style="margin:0;flex:1">You have played all your turns for this week. ${room.config.earlyFinish ? 'Results come when everyone has played, or at the deadline.' : 'Results come at the deadline.'}</p>`
          : closed ? '<p class="ar-note bad" style="margin:0">This week is closed. Results are being prepared.</p>'
          : !lp ? '<p class="ar-note bad" style="margin:0">Connect once to download this week, then you can play it offline.</p>'
          : `<a class="ar-btn" href="#arena/room/${id}/play">${turnDraft && !turnDraft.stale ? 'Continue turn' : `Play turn ${used + 1}`}</a>`}
          ${lastWeek >= 1 ? `<a class="ar-btn ghost" href="#arena/room/${id}/week/${lastWeek}">🏆 Week ${lastWeek} results</a>` : ''}</div></section>
      ${m ? `<section class="ar-panel"><div class="ar-row2" style="margin-bottom:12px">${face(st.av, 'lg')}<div style="flex:1"><b>${h(st.name)}</b><div class="ar-small ar-muted">${h(m.career)} · ${h(m.place)} · ${h(m.path)}</div></div><a class="ar-btn ghost sm" href="#arena/room/${id}/me">My character</a></div>${statGrid(m)}</section>` : ''}
      <section class="ar-panel"><div class="ar-row2"><h2 style="flex:1;margin:0">Live money table</h2><a class="ar-btn ghost sm" href="#arena/room/${id}/board">Full leaderboards</a></div>
        <p class="ar-small ar-muted">Provisional: it moves as turns are accepted. Official results are set once at the end of the week.</p>
        ${top.length ? `<div class="ar-board">${top.map(r => boardRow(id, r, 'money', r.ranks.money)).join('')}</div>` : '<div class="ar-empty">Standings appear once you are online.</div>'}</section>
      <div class="ar-row2" style="margin-top:14px"><a class="ar-btn ghost" href="#arena/room/${id}/journey">My money journey</a><a class="ar-btn ghost" href="#arena/room/${id}/rules">Rules</a><button class="ar-btn danger sm" data-a="leaveActive">Leave challenge</button></div>`);
    current = { roomId: id, live: () => roomScreen(id) };
    watchRoom(id, room.version, 15000, () => roomScreen(id));
  }
  ACT.leaveActive = async () => { if (!confirm('Leave this running challenge? Your results so far stay on the table, and autopilot plays your remaining turns.')) return; await api('POST', `/rooms/${current.roomId}/leave`); location.hash = '#arena'; };
  function statGrid(m, deltas) {
    const d = deltas || {};
    return `<div class="ar-stats"><div class="ar-stat ar-money"><div class="k"><span>Eligible cash (money rank)</span>${d.eligibleCash !== undefined ? sign(d.eligibleCash, N) : ''}</div><div class="v">${N(m.eligibleCash)}</div>
        <div class="ar-small ar-muted">Cash ${N(m.cash)}${m.usd ? ` + ${usd(m.usd)}` : ''}${m.liabilities ? ` · owes ${N(m.liabilities)}` : ''} · net worth ${N(m.netWorth)}</div></div>
      ${R.STAT_KEYS.map(k => `<div class="ar-stat"><div class="k"><span>${STATN[k]}</span>${d[k] !== undefined ? sign(d[k], x => k === 'clout' ? x.toLocaleString() : x) : ''}</div><div class="v">${k === 'clout' ? m[k].toLocaleString() : m[k]}</div><div class="ar-bar"><i style="width:${k === 'clout' ? m.scores.clout : pct(m[k])}%"></i></div></div>`).join('')}
      <div class="ar-stat"><div class="k"><span>Life Balance</span>${d.lifeBalance !== undefined ? sign(Math.round(d.lifeBalance * 10) / 10) : ''}</div><div class="v">${m.lifeBalance}</div><div class="ar-bar"><i style="width:${pct(m.lifeBalance)}%"></i></div></div></div>`;
  }

  /* ---------- 8. Character overview ---------- */
  async function overviewScreen(id) {
    const d = await cached('room:' + id, `/rooms/${id}`);
    let lp = await localPlay(id); if (!lp && online) { await refreshPlay(id); lp = await localPlay(id); }
    if (!lp) throw new Error('Your character appears here once the challenge starts.');
    const st = lp.localState, m = R.metrics(st, R.rulesFor(d.room.rulesVersion));
    const skills = A.view(st, S => ({ work: S.skills.work, english: S.skills.english, tech: S.skills.tech || 0, passport: S.passport, ielts: S.ielts, offer: S.offer, biz: S.biz, job: S.job, resolve: S.resolve, week: S.week, abroad: !!S.abroad, build: S.build }));
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← Week dashboard</a></div>
      <section class="ar-panel ar-reveal"><div class="ar-row2">${face(st.av, 'xl')}<div style="flex:1"><h2 style="font-size:26px;margin:0">${h(st.name)}</h2><div class="ar-muted">${h(m.career)} · ${h(m.place)}</div>
        <div class="ar-row2" style="margin-top:8px"><span class="ar-chip">${h(TRAITS[st.trait].name)}</span><span class="ar-chip">In-game week ${skills.week}</span><span class="ar-chip">${skills.resolve > 0 ? 'Leaning japa ' + skills.resolve : skills.resolve < 0 ? 'Leaning stay ' + -skills.resolve : 'Undecided'}</span></div></div></div></section>
      <section class="ar-panel"><h2>The seven measures</h2>${statGrid(m)}</section>
      <section class="ar-panel"><h2>Life so far</h2><div class="ar-stats">
        ${[['Job', skills.job ? 'Employed' : 'Looking'], ['Business level', skills.biz], ['Work skill', skills.work.toFixed(1)], ['Tech skill', `${skills.tech}/3`], ['English', skills.ielts ? `Score ${skills.ielts}` : `Skill ${skills.english.toFixed(1)}`], ['Passport', skills.passport ? 'Ready' : 'Not yet'], ['Job offer abroad', skills.offer ? 'Yes' : 'No'], ['Owes', N(m.liabilities)], ['Assets (book value)', N(m.assets)]].map(([k, v]) => `<div class="ar-stat"><div class="k">${k}</div><div class="v" style="font-size:16px">${h(v)}</div></div>`).join('')}
      </div></section>
      <section class="ar-panel"><h2>Recent life events</h2><ul class="ar-list">${(st.log || []).slice(0, 12).map(l => `<li class="ar-item"><span class="ar-chip">Wk ${l.w}</span><span class="grow ar-small">${l.m}</span></li>`).join('')}</ul></section>`);
  }

  /* ---------- 9. The life decision screen: one turn on the real engine ---------- */
  async function playScreen(id) {
    const room = (await cached('room:' + id, `/rooms/${id}`)).room;
    if (online) try { await refreshPlay(id); } catch (e) {}
    const lp = await localPlay(id);
    if (!lp) throw new Offline('Open this week once online first.');
    if (room.status !== 'active') { location.hash = `#arena/room/${id}`; return; }
    let t = await store.get('kv', 'turn:' + id);
    if (t && t.stale) {
      await store.del('kv', 'turn:' + id); t = null;
      toastA('Your half-played turn no longer matched the server (another device or autopilot played it). Start from the official state.');
    }
    if (!t) {
      const T = lp.turnsPerWeek, next = lp.localUsed + 1;
      if (next > T || lp.server.storyDone) { location.hash = `#arena/room/${id}`; return; }
      if (serverNow() > lp.cutoff) { paint(`<div class="ar-panel ar-empty"><b>This week has closed</b>Turns played now would not count. Results are coming.<a class="ar-btn" href="#arena/room/${id}">Back</a></div>`); return; }
      const ticket = (lp.tickets || []).find(x => x.turn === next && x.week === lp.week);
      if (!ticket) throw new Offline('Connect once to download the dice for this turn.');
      t = { roomId: id, roomName: room.name, week: lp.week, turn: next, seed: ticket.seed, baseVersion: lp.localVersion, base: lp.localState, dec: { picks: null, choices: [], yearEnd: null }, draft: [], acks: 0, startedAt: Date.now() };
      await store.put('kv', 'turn:' + id, t);
    }
    current = { roomId: id, turn: t, room, lp };
    paintTurn();
  }
  function stepOf(t) { return A.play(t.base, t.seed, t.dec.picks ? t.dec : { ...t.dec, picks: null }, { acks: t.acks }); }
  async function saveTurn() { await store.put('kv', 'turn:' + current.roomId, current.turn); }
  function paintTurn() {
    const t = current.turn, lp = current.lp, room = current.room, T = room.config.turnsPerWeek;
    const r = stepOf(t);
    const head = `<div class="ar-back"><a class="ar-link" href="#arena/room/${t.roomId}">← Week dashboard</a></div>
      <section class="ar-panel"><div class="ar-row2"><div style="flex:1"><div class="ar-small ar-muted">${h(room.name)} · game week ${t.week}</div><h2 style="margin:2px 0 0">Turn ${t.turn} of ${T}</h2></div>
        <span class="ar-chip warn"><i></i>Closes in ${left(room.deadline - serverNow())}</span>${online ? '' : '<span class="ar-chip bad"><i></i>Offline: saved on this device</span>'}</div></section>`;
    if (r.status === 'invalid') { paint(head + `<div class="ar-panel"><p class="ar-err">${h(r.error)}</p><button class="ar-btn" data-a="resetTurn">Start this turn again</button></div>`); return; }
    const st = r.state;
    const m = R.metrics(st, R.rulesFor(room.rulesVersion));
    const strip = `<div class="ar-row2 ar-small" style="margin:10px 0"><span class="ar-chip">💰 ${S_cur(st)}</span>${R.STAT_KEYS.map(k => `<span class="ar-chip">${STATN[k]} ${k === 'clout' ? m[k].toLocaleString() : m[k]}</span>`).join('')}</div>`;
    if (r.status === 'done') return finishTurn(r);
    if (r.need === 'picks') {
      const html = A.view({ ...st, picked: t.draft }, S => {
        const used = blocksUsed(), leftB = BLOCKS - used, cash = wallet() - moneyCommitted();
        const cards = S.hand.map(k => {
          const c = CARDS[k], on = S.picked.includes(k), cost = c.cost();
          const dis = !on && (c.blocks > leftB || cost > cash + loanRoom() || !c.can());
          const onLoan = !on && !dis && cost > cash;
          const tags = (onLoan ? '<span class="ar-tag neg">borrow to pay</span>' : '') + c.tags().map(x => `<span class="ar-tag ${['Japa', 'Settle'].includes(x) ? 'j' : ['Stay', 'pulls home', 'roots at home'].includes(x) ? 's' : ''}">${h(x)}</span>`).join('');
          return `<button class="ar-card" data-a="card" data-k="${k}" aria-pressed="${on}" ${dis ? 'disabled' : ''}><span class="hd">${cardIcon(k)}<span>${h(c.name)}</span></span><span class="ar-meta"><span>${c.blocks} blocks</span><span>${cost ? cur(cost) : 'free'}</span></span><span class="ar-tags">${tags}</span></button>`;
        }).join('');
        return `<section class="ar-panel"><div class="ar-row2"><h2 style="flex:1;margin:0">Plan your week</h2><span class="ar-num">${used}/${BLOCKS} blocks · ${cur(cash)} left</span></div>
          <div class="ar-blocks" style="margin-top:10px" role="progressbar" aria-valuemin="0" aria-valuemax="${BLOCKS}" aria-valuenow="${used}"><i style="width:${used / BLOCKS * 100}%"></i></div>${strip}
          <div class="ar-cards">${cards}</div>
          <div class="ar-row2 ar-end" style="margin-top:14px"><button class="ar-btn" data-a="endWeek" ${S.picked.length ? '' : 'disabled'}>End the week</button></div></section>`;
      });
      paint(head + html); return;
    }
    if (r.need === 'choice') {
      const v = A.currentEvent(st);
      paint(head + `<section class="ar-panel ar-event ar-reveal">${st.weekFx && st.weekFx.length ? `<div class="ar-small ar-muted">Your week: </div>${chipsHtml(st.weekFx)}<hr class="ar-sep">` : ''}
        <div class="ar-who">${h(v.who || 'Life happens')}</div><h3>${h(v.title)}</h3><p>${h(v.text)}</p>
        <div class="ar-choices">${v.choices.map((c, i) => `<button class="ar-choice" data-a="choice" data-i="${i}"><b>${h(c.l)}</b>${c.h ? `<small>${h(c.h)}</small>` : ''}</button>`).join('')}</div>${strip}</section>`);
      return;
    }
    if (r.need === 'ack' && st.phase === 'life') {
      paint(head + `<section class="ar-panel ar-event ar-reveal"><div class="ar-who">What happened</div><p style="font-size:17px">${h(st.result)}</p>${chipsHtml(st.resultFx)}
        <div class="ar-row2 ar-end" style="margin-top:14px"><button class="ar-btn" data-a="ack">Next</button></div></section>`);
      return;
    }
    if (r.need === 'ack' && st.phase === 'settle') {
      const L = st.ledger || { lines: [] }, ab = L.abroad, tot = L.lines.reduce((a, [, v]) => a + v, 0), f = x => ab ? usd(x) : naira(x);
      paint(head + `<section class="ar-panel ar-reveal"><h2>Settle-up</h2>${st.settleFx && st.settleFx.length ? chipsHtml(st.settleFx) : ''}
        <table class="ar-ledger"><tbody>${L.lines.map(([k, v]) => `<tr><td>${h(k)}</td><td class="${v < 0 ? 'ar-down' : 'ar-up'}">${v < 0 ? '−' : '+'}${f(Math.abs(v))}</td></tr>`).join('')}<tr class="total"><td>Total</td><td>${tot < 0 ? '−' : '+'}${f(Math.abs(tot))}</td></tr></tbody></table>
        ${strip}<div class="ar-row2 ar-end"><button class="ar-btn" data-a="ack">Finish turn ${t.turn}</button></div></section>`);
      return;
    }
    if (r.need === 'yearEnd') {
      const canJapa = A.view(st, () => japaProgress() >= 2);
      paint(head + `<section class="ar-panel ar-reveal"><h2>Year 1 is over</h2><p>How does Year 2 begin?</p><div class="ar-choices">
        <button class="ar-choice" data-a="yearEnd" data-v="build"><b>Keep building at home</b><small>Open the Build chapter: shop, staff, branches, community.</small></button>
        ${canJapa ? '<button class="ar-choice" data-a="yearEnd" data-v="japa2"><b>Keep trying for the visa</b><small>Year 1 rules continue for another year.</small></button>' : ''}</div></section>`);
    }
  }
  const S_cur = st => st.abroad ? `${usd(st.usd)} · ${naira(st.money)} at home` : naira(st.money) + (st.usd ? ` · ${usd(st.usd)}` : '');
  ACT.card = async b => {
    const t = current.turn, k = b.dataset.k;
    if (t.draft.includes(k)) t.draft = t.draft.filter(x => x !== k);
    else {
      const test = A.play(t.base, t.seed, { picks: [...t.draft, k] }, { acks: 0 });
      if (test.status === 'invalid') { toastA(test.error); return; }
      t.draft = [...t.draft, k];
      try { if (Sound) Sound.play('tap'); } catch (e) {}
    }
    await saveTurn(); paintTurn();
  };
  ACT.endWeek = async () => { const t = current.turn; t.dec.picks = t.draft.slice(); await saveTurn(); try { Sound.play('drum'); } catch (e) {} paintTurn(); window.scrollTo(0, 0); root.scrollTo({ top: 0, behavior: calm() ? 'auto' : 'smooth' }); };
  ACT.choice = async b => { const t = current.turn; t.dec.choices.push(Number(b.dataset.i)); await saveTurn(); try { Sound.play('choose'); } catch (e) {} paintTurn(); };
  ACT.ack = async () => { current.turn.acks++; await saveTurn(); paintTurn(); root.scrollTo({ top: 0 }); };
  ACT.yearEnd = async b => { current.turn.dec.yearEnd = b.dataset.v; await saveTurn(); paintTurn(); };
  ACT.resetTurn = async () => { const t = current.turn; t.dec = { picks: null, choices: [], yearEnd: null }; t.draft = []; t.acks = 0; await saveTurn(); paintTurn(); };
  async function finishTurn(r) {
    const t = current.turn, room = current.room;
    if (!t.queued) {
      t.queued = true;
      const op = { opId: 'op_' + rid(), kind: 'turn', roomId: t.roomId, roomName: room.name, week: t.week, turn: t.turn, baseVersion: t.baseVersion, decisions: { picks: t.dec.picks, choices: t.dec.choices, yearEnd: t.dec.yearEnd }, clientHash: TT.stateHash(r.state), localState: r.state, createdAt: Date.now(), attempts: 0 };
      await queueTurn(op);
      await store.del('kv', 'turn:' + t.roomId);
    }
    const m0 = R.metrics(t.base, R.rulesFor(room.rulesVersion)), m1 = R.metrics(r.state, R.rulesFor(room.rulesVersion));
    const more = t.turn < room.config.turnsPerWeek && !r.storyDone;
    paint(`<section class="ar-panel ar-reveal" style="max-width:720px;margin:20px auto;text-align:center"><div class="kicker ar-small ar-muted">Turn ${t.turn} of ${room.config.turnsPerWeek} done</div>
      <h2 style="font-size:28px">${r.storyDone ? 'Your story is complete' : m1.eligibleCash >= m0.eligibleCash ? 'Money is moving' : 'A costly week'}</h2>
      <p class="ar-num" style="font-size:22px">${sign(m1.eligibleCash - m0.eligibleCash, N)} eligible cash</p>
      <div class="fx" style="justify-content:center">${R.STAT_KEYS.map(k => { const dv = m1[k] - m0[k]; return dv ? `<span class="fxc ${dv > 0 ? 'pos' : 'neg'}">${dv > 0 ? '+' : '−'}${Math.abs(dv).toLocaleString()} ${STATN[k]}</span>` : ''; }).join('')}</div>
      <p class="ar-small ar-muted" style="margin-top:12px">${online ? 'Sending to the server…' : 'Saved on this device. It will sync when you are back online.'}</p>
      <div class="ar-row2" style="justify-content:center;margin-top:12px">${more ? `<button class="ar-btn" data-a="nextTurn">Play turn ${t.turn + 1}</button>` : ''}<a class="ar-btn ${more ? 'ghost' : ''}" href="#arena/room/${t.roomId}">Week dashboard</a></div></section>`);
    try { Sound.play(m1.eligibleCash >= m0.eligibleCash ? 'coins' : 'thud'); } catch (e) {}
  }
  ACT.nextTurn = () => playScreen(current.roomId).catch(e => failure(e));

  /* ---------- 11–13. Leaderboards: money, character stats, life balance (one component, many views) ---------- */
  const METRICS = [['money', 'Money', r => N(r.eligibleCash), r => `cash ${N(r.cash)}${r.usd ? ' + ' + usd(r.usd) : ''}`], ['netWorth', 'Net worth', r => N(r.netWorth), r => `owes ${N(r.liabilities)}`],
    ['lifeBalance', 'Life Balance', r => r.lifeBalance === null ? '—' : r.lifeBalance, () => 'out of 100'], ['improvement', 'Weekly improvement', r => r.deltas && r.deltas.lifeBalance !== undefined ? (r.deltas.lifeBalance > 0 ? '+' : '') + r.deltas.lifeBalance : '—', () => 'Life Balance change'],
    ...R.STAT_KEYS.map(k => [k, STATN[k], r => r.stats ? (k === 'clout' ? r.stats[k].toLocaleString() : r.stats[k]) : '—', () => k === 'clout' ? 'fans' : 'out of 100'])];
  let boardState = { metric: 'money', period: 'current' };
  const prevPos = {};
  function boardRow(id, r, metric, rank) {
    const M = METRICS.find(x => x[0] === metric) || METRICS[0];
    const mv = r.rankChange || 0;
    return `<button class="ar-lrow ${r.isMe ? 'ar-me' : ''}" data-a="go" data-to="#arena/room/${id}/compare/${r.participantId}" data-pid="${r.participantId}" aria-label="Rank ${rank || '—'}: ${h(r.characterName)}">
      <span class="ar-rank ${rank <= 3 ? 'g' + rank : ''}">${rank || '—'}</span>
      <span class="ar-facewrap">${face(r.avatar, 'md')}${r.online !== undefined ? `<span class="dot ${r.online ? 'on' : ''}" title="${r.online ? 'Active recently' : 'Away'}"></span>` : ''}</span>
      <span class="ar-who"><b>${h(r.characterName || r.displayName)}${r.isMe ? ' (you)' : ''}</b><span>${h(r.displayName)} · ${h(r.career)} · ${h(r.place)}</span>
        <span class="ministats">${metric === 'money' && mv ? `<span class="ar-move ${mv > 0 ? 'ar-up' : 'ar-down'}">${mv > 0 ? '▲' : '▼'}${Math.abs(mv)}</span>` : ''}${r.turnsUsed !== undefined ? `<span>${r.turnsUsed} turns</span>` : ''}${r.wins && r.wins.money ? `<span>👑 ${r.wins.money}</span>` : ''}${r.left ? '<span>left</span>' : ''}${r.storyDone ? '<span>story complete</span>' : ''}${r.hidden ? '<span>stats private</span>' : ''}</span>
        ${r.badges && r.badges.length ? `<span class="ar-badges">${r.badges.slice(0, 3).map(b => `<span class="ar-badge">${h((R.ACHIEVEMENTS[b] || {}).name || b)}</span>`).join('')}</span>` : ''}</span>
      <span class="ar-val"><b>${M[2](r)}</b><span>${M[3](r)}</span></span></button>`;
  }
  async function boardScreen(id, metric) {
    if (metric) boardState.metric = metric;
    const d = await cached('room:' + id, `/rooms/${id}`), room = d.room;
    const finals = Math.max(0, room.status === 'complete' ? room.config.weeks : room.week - 1);
    const period = boardState.period === 'current' && room.status === 'complete' ? String(room.config.weeks) : boardState.period;
    const data = await cached(`board:${id}:${period}`, `/rooms/${id}/board?week=${period}`);
    const met = boardState.metric === 'improvement' && data.kind !== 'week' ? 'lifeBalance' : boardState.metric;
    const rankOf = r => data.kind === 'lifetime' ? r.rank : met === 'improvement' ? r.ranks.improvement : (r.ranks || {})[met];
    const rows = data.rows.slice().sort((a, b) => (rankOf(a) || 99) - (rankOf(b) || 99) || (a.participantId < b.participantId ? -1 : 1));
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← ${h(room.name)}</a></div>
      <section class="ar-panel"><div class="ar-row2"><h2 style="flex:1;margin:0">Leaderboards</h2>
        <label class="ar-field" style="min-width:200px"><select data-a-change="period" aria-label="Which week">
          ${room.status === 'active' ? `<option value="current" ${period === 'current' ? 'selected' : ''}>Week ${room.week} (live)</option>` : ''}
          ${Array.from({ length: finals }, (_, i) => finals - i).map(w => `<option value="${w}" ${String(w) === period ? 'selected' : ''}>Week ${w} (official)</option>`).join('')}
          <option value="lifetime" ${period === 'lifetime' ? 'selected' : ''}>Whole challenge</option></select></label></div>
        <div class="ar-tabs" role="tablist" style="margin-top:12px">${METRICS.filter(x => data.kind === 'week' || x[0] !== 'improvement').filter(x => data.kind !== 'lifetime' || ['money', 'netWorth'].includes(x[0])).map(x => `<button role="tab" aria-selected="${x[0] === met}" data-a="metric" data-v="${x[0]}">${x[1]}</button>`).join('')}</div>
        <p class="ar-small ar-muted" style="margin:10px 0 0">${data.official ? (data.kind === 'lifetime' ? 'Ranked by weekly money crowns, then eligible cash.' : 'Official results: final and never changed.') : 'Live and provisional. Official results are set once at the end of the week.'}${data._fresh === false ? ' Offline copy.' : ''}</p>
        <div class="ar-board" id="ar-board">${rows.map(r => boardRow(id, r, data.kind === 'lifetime' ? 'money' : met, rankOf(r))).join('') || '<div class="ar-empty">No standings yet.</div>'}</div></section>`);
    flip();
    current = { roomId: id };
    if (period === 'current') watchRoom(id, room.version, 15000, () => boardScreen(id));
  }
  // animated rank changes: rows slide from where they were to where they are now
  function flip() {
    const rows = root.querySelectorAll('.ar-lrow[data-pid]');
    rows.forEach(el => {
      const pid = el.dataset.pid, y = el.getBoundingClientRect().top, was = prevPos[pid];
      if (was !== undefined && !calm() && Math.abs(was - y) > 2) { el.style.transition = 'none'; el.style.transform = `translateY(${was - y}px)`; requestAnimationFrame(() => { el.style.transition = ''; el.style.transform = ''; }); }
      prevPos[pid] = y;
    });
  }
  ACT.metric = b => { boardState.metric = b.dataset.v; boardScreen(current.roomId); };
  root.addEventListener('change', e => { const s = e.target.closest('[data-a-change="period"]'); if (s) { boardState.period = s.value; boardScreen(current.roomId); } });

  /* ---------- 14. Player comparison ---------- */
  async function compareScreen(id, pid) {
    const d = await cached('room:' + id, `/rooms/${id}`), room = d.room;
    const board = await cached(`board:${id}:current`, `/rooms/${id}/board?week=${room.status === 'complete' ? room.config.weeks : 'current'}`);
    const me = board.rows.find(r => r.isMe), them = board.rows.find(r => r.participantId === pid);
    if (!me || !them) throw new Error('That player is not on this table.');
    let rival = null; if (!them.isMe && online) try { rival = await api('GET', `/rivals/${them.playerId}`); } catch (e) {}
    const line = (label, a, b, fmt = x => x) => { const wa = a !== null && b !== null && a > b, wb = a !== null && b !== null && b > a; return `<div class="l ${wa ? 'win' : ''}">${a === null ? '—' : fmt(a)}</div><div class="m">${label}</div><div class="r ${wb ? 'win' : ''}">${b === null ? '—' : fmt(b)}</div>`; };
    const sv = (r, k) => r.stats ? r.stats[k] : null;
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}/board">← Leaderboards</a></div>
      <section class="ar-panel ar-reveal"><div class="ar-vs"><div class="side">${face(me.avatar, 'xl')}<b style="display:block">${h(me.characterName)}</b><span class="ar-small ar-muted">You · ${h(me.career)}</span></div>
        <div class="ar-code" style="font-size:22px">VS</div><div class="side">${face(them.avatar, 'xl')}<b style="display:block">${h(them.characterName)}</b><span class="ar-small ar-muted">${h(them.displayName)} · ${h(them.career)}</span></div></div>
        <div class="ar-cmp">${line('Money rank', me.ranks ? -me.ranks.money : null, them.ranks ? -them.ranks.money : null, x => '#' + -x)}${line('Eligible cash', me.eligibleCash, them.eligibleCash, N)}${line('Net worth', me.netWorth, them.netWorth, N)}
          ${R.STAT_KEYS.map(k => line(STATN[k], sv(me, k), sv(them, k), x => x.toLocaleString())).join('')}${line('Life Balance', me.lifeBalance, them.lifeBalance)}${line('Money crowns', me.wins ? me.wins.money : 0, them.wins ? them.wins.money : 0)}</div>
        ${them.hidden ? '<p class="ar-small ar-muted">This room shows only money for other players.</p>' : ''}</section>
      ${rival ? `<section class="ar-panel"><h2>Rivalry record</h2><p>Across ${rival.weeks} shared week${rival.weeks === 1 ? '' : 's'} in ${rival.rooms.length} challenge${rival.rooms.length === 1 ? '' : 's'}: you finished ahead <b>${rival.wins}</b> times, behind <b>${rival.losses}</b>, level <b>${rival.ties}</b>. Total cash difference ${sign(rival.cashDiff, N)}.</p>
        ${Object.keys(rival.categories).length ? `<div class="ar-row2">${Object.entries(rival.categories).map(([k, v]) => `<span class="ar-chip">${STATN[k]} ${v.me}–${v.them}</span>`).join('')}</div>` : ''}</section>` : ''}`);
  }

  /* ---------- 15–16. Weekly results ceremony and award winners ---------- */
  async function ceremonyScreen(id, wk) {
    const d = await cached(`week:${id}:${wk}`, `/rooms/${id}/weeks/${wk}`);
    const room = d.room, top = d.standings.slice(0, 3), me = d.standings.find(s => s.isMe);
    const award = k => d.awards.find(a => a.key === k);
    const money = award('money');
    const pod = (s, p) => s ? `<div class="ar-pod p${p} ar-reveal" style="animation-delay:${(3 - p) * 0.35 + 0.3}s">${face(s.avatar, 'lg', p === 1 ? 'happy' : 'flat')}<b>${h(s.characterName)}</b><span class="ar-num">${N(s.eligibleCash)}</span><div class="step">${p}</div></div>` : '<div></div>';
    const seenKey = `jos-arena-seen:${id}:${wk}`; let seen = false; try { seen = localStorage.getItem(seenKey) === '1'; localStorage.setItem(seenKey, '1'); } catch (e) {}
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← ${h(room.name)}</a></div>
      <section class="ar-stage"><div class="kicker ar-reveal">${h(room.name)}</div><h1 class="ar-reveal" style="animation-delay:.1s">Week ${wk} results</h1>
        ${money ? `<p class="ar-reveal" style="animation-delay:.2s;font-size:18px">👑 <b>${h(money.names.join(' & '))}</b> ${money.names.length > 1 ? 'share' : 'takes'} the crown: <b>${h(money.name)}</b></p>` : ''}
        <div class="ar-podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div></section>
      <section class="ar-panel ar-reveal" style="animation-delay:1.3s"><h2>Award winners</h2><div class="ar-awards">${d.awards.map(a => `<div class="ar-award"><div class="n">${h(a.name)}</div><b>${h(a.names.join(' & '))}</b><span>${awardValue(a)}</span></div>`).join('')}</div></section>
      ${d.highlights.length ? `<section class="ar-panel ar-reveal" style="animation-delay:1.5s"><h2>Highlights</h2><ul>${d.highlights.map(x => `<li>${h(x)}</li>`).join('')}</ul></section>` : ''}
      ${me ? `<section class="ar-panel ar-reveal" style="animation-delay:1.7s"><div class="ar-row2"><h2 style="flex:1;margin:0">Your week: #${me.ranks.money}${me.ranks.moneyChange ? ` <span class="${me.ranks.moneyChange > 0 ? 'ar-up' : 'ar-down'}" style="font-size:15px">${me.ranks.moneyChange > 0 ? '▲' : '▼'}${Math.abs(me.ranks.moneyChange)}</span>` : ''}</h2><button class="ar-btn ghost sm" data-a="shareCard" data-wk="${wk}">Share my result</button></div>
        ${me.stats ? statGrid({ ...me, ...me.stats, scores: { clout: Math.min(100, 100 * Math.log10(1 + me.stats.clout) / Math.log10(20001)) } }, me.deltas) : ""}
        ${me.moves ? `<h3 style="margin-top:14px">Your moves</h3><ul class="ar-list">${me.moves.map(mv => `<li class="ar-item"><span class="ar-chip">Turn ${mv.turn}${mv.auto ? ' · autopilot' : ''}</span><span class="grow ar-small">${mv.picks.map(k => h(CARDS[k] ? CARDS[k].name : k)).join(', ') || 'A milestone week'}</span>${sign(mv.cashChange, N)}</li>`).join('')}</ul>` : ''}
        ${me.achievements.length ? `<h3 style="margin-top:14px">Unlocked</h3><div class="ar-badges">${me.achievements.map(k => `<span class="ar-badge">🏅 ${h(R.ACHIEVEMENTS[k].name)}</span>`).join('')}</div>` : ''}</section>` : ''}
      <section class="ar-panel ar-reveal" style="animation-delay:1.9s"><h2>Standings</h2><div class="ar-board">${d.standings.map(s => `<div>${boardRow(id, s, 'money', s.ranks.money)}
        <div class="ar-react" role="group" aria-label="React to ${h(s.characterName)}">${d.emoji.map(em => { const n = (s.reactions.find(x => x.emoji === em) || {}).n || 0, on = s.myReactions.includes(em); return `<button data-a="react" data-wk="${wk}" data-pid="${s.participantId}" data-e="${em}" aria-pressed="${on}" aria-label="${em}${n ? ' ' + n : ''}">${em}${n ? ' ' + n : ''}</button>`; }).join('')}</div></div>`).join('')}</div></section>
      <section class="ar-panel"><div class="ar-row2">${d.next ? `<p style="flex:1;margin:0"><b>Next:</b> week ${d.next.week} is open and closes ${when(d.next.deadline)}.</p><a class="ar-btn" href="#arena/room/${id}/play">Play week ${d.next.week}</a>` : `<p style="flex:1;margin:0">That was the final week.</p><a class="ar-btn" href="#arena/room/${id}/final">Final results</a>`}</div></section>`);
    current = { roomId: id, week: d };
    if (!seen) { fire(); try { if (Sound && Sound.mode !== 'off') Sound.play('fanfare'); } catch (e) {} }
  }
  const awardValue = a => a.key === 'money' ? N(a.value) + ' eligible cash' : a.key === 'comeback' ? `up ${a.value} place${a.value > 1 ? 's' : ''}` : a.key === 'improved' ? `+${a.value} Life Balance` : a.key === 'overall' ? `Life Balance ${a.value}` : a.key === 'clout' ? `${Math.round(a.value).toLocaleString()} fans` : `${a.value} / 100`;
  ACT.react = async b => { const on = b.getAttribute('aria-pressed') === 'true'; await api('POST', `/rooms/${current.roomId}/react`, { week: Number(b.dataset.wk), participantId: b.dataset.pid, emoji: b.dataset.e, remove: on }); ceremonyScreen(current.roomId, b.dataset.wk); };
  function fire() {
    if (calm()) return;
    const box = document.createElement('div'); box.className = 'ar-confetti'; box.setAttribute('aria-hidden', 'true');
    const cols = ['#F3B53A', '#FFD777', '#23C07C', '#8495FF', '#FF7A6B', '#ffffff'];
    box.innerHTML = Array.from({ length: 90 }, () => `<i style="left:${Math.random() * 100}%;background:${cols[Math.floor(Math.random() * cols.length)]};animation-duration:${2.2 + Math.random() * 2.4}s;animation-delay:${Math.random() * 0.8}s;transform:rotate(${Math.random() * 360}deg)"></i>`).join('');
    root.appendChild(box); setTimeout(() => box.remove(), 5500);
  }
  // a shareable card with only my own numbers (other players' figures are never put on it)
  ACT.shareCard = async b => {
    const d = current.week, me = d.standings.find(s => s.isMe); if (!me) return;
    const c = document.createElement('canvas'); c.width = 1080; c.height = 1080; const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 1080); grd.addColorStop(0, '#17305A'); grd.addColorStop(1, '#07130E'); g.fillStyle = grd; g.fillRect(0, 0, 1080, 1080);
    g.fillStyle = '#F3B53A'; g.font = '800 44px "Bricolage Grotesque", system-ui'; g.fillText('JAPA OR STAY · CHALLENGE ARENA', 70, 120);
    g.fillStyle = '#fff'; g.font = '800 92px "Bricolage Grotesque", system-ui'; g.fillText(`Week ${b.dataset.wk}: #${me.ranks.money}`, 70, 280);
    g.font = '600 46px Figtree, system-ui'; g.fillStyle = '#A8B8AE'; g.fillText(me.characterName + ' · ' + me.career, 70, 360);
    g.fillStyle = '#FFD777'; g.font = '700 80px "IBM Plex Mono", monospace'; g.fillText(N(me.eligibleCash), 70, 520);
    g.fillStyle = '#A8B8AE'; g.font = '500 36px Figtree, system-ui'; g.fillText('eligible cash this week', 70, 575);
    if (me.stats) { g.fillStyle = '#fff'; g.font = '600 40px Figtree, system-ui'; R.STAT_KEYS.forEach((k, i) => g.fillText(`${STATN[k]}: ${me.stats[k].toLocaleString()}`, 70 + (i % 2) * 480, 690 + Math.floor(i / 2) * 70)); }
    g.fillStyle = '#F3B53A'; g.font = '600 36px Figtree, system-ui'; g.fillText('Play free: https://japa-or-stay.pages.dev', 70, 1010);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const file = new File([blob], `japa-arena-week-${b.dataset.wk}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text: `I finished week ${b.dataset.wk} at #${me.ranks.money} in Japa or Stay: Challenge Arena. https://japa-or-stay.pages.dev` }); return; } catch (e) { return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  /* ---------- 24. Challenge completion ---------- */
  async function finalScreen(id, room) {
    room = room || (await cached('room:' + id, `/rooms/${id}`)).room;
    if (room.status !== 'complete') { location.hash = `#arena/room/${id}`; return; }
    const lt = await cached(`board:${id}:lifetime`, `/rooms/${id}/board?week=lifetime`);
    const rows = lt.rows.slice().sort((a, b) => a.rank - b.rank), champ = rows.filter(r => r.rank === 1);
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <section class="ar-stage"><div class="kicker ar-reveal">${h(room.name)} · ${room.config.weeks} weeks</div><h1 class="ar-reveal">Season champion${champ.length > 1 ? 's' : ''}</h1>
        <div class="ar-row2 ar-reveal" style="justify-content:center;margin-top:16px">${champ.map(c => `<div class="ar-pod p1" style="max-width:200px">${face(c.avatar, 'xl', 'happy')}<b>${h(c.characterName)}</b><span>${c.wins.money} money crown${c.wins.money === 1 ? '' : 's'} · ${N(c.eligibleCash)}</span></div>`).join('')}</div></section>
      <section class="ar-panel"><h2>Final table</h2><p class="ar-small ar-muted">Ranked by weekly money crowns, then final eligible cash, then total awards.</p>
        <div class="ar-board">${rows.map(r => boardRow(id, { ...r, ranks: { money: r.rank } }, 'money', r.rank)).join('')}</div></section>
      <section class="ar-panel"><div class="ar-row2"><a class="ar-btn ghost" href="#arena/room/${id}/board">Every week's tables</a>${Array.from({ length: room.config.weeks }, (_, i) => `<a class="ar-btn ghost sm" href="#arena/room/${id}/week/${i + 1}">Week ${i + 1}</a>`).join('')}<span style="flex:1"></span><button class="ar-btn" data-a="rematch">Rematch with the same friends</button></div></section>`);
    current = { roomId: id };
    let seen = false; try { seen = localStorage.getItem('jos-arena-final:' + id) === '1'; localStorage.setItem('jos-arena-final:' + id, '1'); } catch (e) {}
    if (!seen) fire();
  }
  ACT.rematch = async () => { const r = await api('POST', `/rooms/${current.roomId}/rematch`); toastA('Rematch created. Everyone from this challenge is invited.'); location.hash = `#arena/room/${r.roomId}`; };

  /* ---------- charts ---------- */
  function chart(series, { height = 220, fmt = x => x } = {}) {
    const pts = series.flatMap(s => s.points); if (!pts.length) return '<div class="ar-empty">Results appear here after the first official week.</div>';
    const W = 640, H = height, P = { l: 66, r: 14, t: 14, b: 26 };
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1), y0 = Math.min(0, ...ys), y1 = Math.max(...ys, y0 + 1);
    const X = x => P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r), Y = y => H - P.b - (y - y0) / (y1 - y0) * (H - P.t - P.b);
    const ticks = [0, 0.5, 1].map(f => y0 + (y1 - y0) * f);
    return `<svg class="ar-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${h(series.map(s => s.label).join(', '))} by week">
      ${ticks.map(v => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="rgba(255,255,255,.1)"/><text x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${h(fmt(v))}</text>`).join('')}
      ${[...new Set(xs)].map(x => `<text x="${X(x)}" y="${H - 6}" text-anchor="middle">W${x}</text>`).join('')}
      ${series.map(s => `<polyline fill="none" stroke="${s.color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" points="${s.points.map(p => `${X(p.x)},${Y(p.y)}`).join(' ')}"/>${s.points.map(p => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="4" fill="${s.color}"><title>${h(s.label)} week ${p.x}: ${h(fmt(p.y))}</title></circle>`).join('')}`).join('')}
    </svg><div class="ar-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${h(s.label)}</span>`).join('')}</div>`;
  }
  const kfmt = v => Math.abs(v) >= 1e6 ? '₦' + (v / 1e6).toFixed(1) + 'm' : Math.abs(v) >= 1e3 ? '₦' + Math.round(v / 1e3) + 'k' : '₦' + Math.round(v);

  /* ---------- money journey (financial ledger and history in one room) ---------- */
  async function journeyScreen(id) {
    const d = await cached(`history:${id}`, `/rooms/${id}/history`);
    const cats = {}; for (const l of d.ledger) cats[l.category] = (cats[l.category] || 0) + l.amount;
    const CN = { salary: 'Salary and wages', business_revenue: 'Business revenue', business_expense: 'Business expenses', living_costs: 'Living costs', debt: 'Debt and interest', savings: 'Ajo savings', investment: 'Investments', other_income: 'Money paid back', activity: 'Cards, hustles, events, transfers', other: 'Other' };
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/room/${id}">← Week dashboard</a></div>
      <section class="ar-panel"><h2>My money journey</h2>${chart([{ label: 'Eligible cash', color: '#F3B53A', points: d.results.map(r => ({ x: r.week, y: r.eligibleCash })) }, { label: 'Net worth', color: '#8495FF', points: d.results.map(r => ({ x: r.week, y: r.netWorth })) }], { fmt: kfmt })}</section>
      <section class="ar-panel"><h2>Character development</h2>${chart([{ label: 'Life Balance', color: '#23C07C', points: d.results.map(r => ({ x: r.week, y: r.lifeBalance })) }, { label: 'Happiness', color: '#FF7A6B', points: d.results.map(r => ({ x: r.week, y: r.m.happiness })) }, { label: 'Body', color: '#9FD3FF', points: d.results.map(r => ({ x: r.week, y: r.m.body })) }, { label: 'Family Matters', color: '#E7A6FF', points: d.results.map(r => ({ x: r.week, y: r.m.family })) }], { fmt: v => Math.round(v) })}
        ${d.results.length ? `<p class="ar-small ar-muted">Lifetime so far: ${R.STAT_KEYS.filter(k => k !== 'clout').map(k => { const c = d.results[d.results.length - 1].cum; return `${STATN[k]} +${c.gains[k] || 0} / −${c.losses[k] || 0} (best ${c.highs[k]}, average ${R.average(c, k)})`; }).join(' · ')}</p>` : ''}</section>
      <section class="ar-panel"><h2>Where the money went</h2><table class="ar-ledger"><tbody>${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${h(CN[k] || k)}</td><td class="${v < 0 ? 'ar-down' : 'ar-up'}">${v < 0 ? '−' : '+'}${N(Math.abs(v))}</td></tr>`).join('') || '<tr><td>No turns yet.</td><td></td></tr>'}</tbody></table>
        <p class="ar-small ar-muted">Every line comes from the server's replay of your turns, in naira at the competition rate. Dollar lines show their original amount below.</p></section>
      <section class="ar-panel"><h2>Ledger</h2><table class="ar-ledger"><tbody>${d.ledger.slice(0, 80).map(l => `<tr><td><span class="ar-chip">W${l.week}·T${l.turn}</span> ${h(l.label)}${l.currency === 'USD' ? ` <span class="ar-muted">(${usd(l.original_amount)})</span>` : ''}</td><td class="${l.amount < 0 ? 'ar-down' : 'ar-up'}">${l.amount < 0 ? '−' : '+'}${N(Math.abs(l.amount))}</td></tr>`).join('')}</tbody></table></section>`);
  }

  /* ---------- 17. Lifetime leaderboard (everyone with a public profile) ---------- */
  async function globalBoardScreen() {
    const d = await cached('global', '/leaderboard');
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div><section class="ar-panel"><h2>Lifetime leaderboard</h2><p class="ar-small ar-muted">Players with a public profile, ranked by weekly money crowns, then best eligible cash, then all awards. Make your profile public in My profile to appear here.</p>
      <div class="ar-board">${d.rows.map(r => `<a class="ar-lrow ${r.isMe ? 'ar-me' : ''}" href="#arena/profile/${r.id}"><span class="ar-rank ${r.rank <= 3 ? 'g' + r.rank : ''}">${r.rank}</span>${face(r.avatar, 'md')}<span class="ar-who"><b>${h(r.displayName)}${r.isMe ? ' (you)' : ''}</b><span>${r.allWins} awards · ${r.badges} achievements</span></span><span class="ar-val"><b>👑 ${r.moneyWins}</b><span>best ${N(r.bestCash)}</span></span></a>`).join('') || '<div class="ar-empty"><b>No finished weeks yet</b>The table fills up as challenges finish their weeks.</div>'}</div></section>`);
  }

  /* ---------- 18. Multiplayer profile ---------- */
  async function profileScreen(pid) {
    const self = !pid || pid === (session && session.playerId);
    const d = self ? await cached('me', '/me') : await cached('player:' + pid, `/players/${pid}`);
    const p = self ? d.me : d.player;
    const ach = p.achievements || [];
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <section class="ar-panel ar-reveal"><div class="ar-row2">${face(p.avatar, 'xl')}<div style="flex:1"><h2 style="font-size:28px;margin:0">${h(p.displayName)}</h2>${p.character ? `<div class="ar-muted">Plays ${h(p.character.name)} · ${h(REGIONS[p.character.region] ? REGIONS[p.character.region].name : '')}</div>` : ''}<div class="ar-small ar-muted">In the Arena since ${new Date(p.joinedAt).toLocaleDateString()}</div></div>
        ${!self && online ? `<a class="ar-btn ghost sm" href="#arena/rival/${p.id}">Rivalry</a><button class="ar-btn danger sm" data-a="report" data-kind="player" data-id="${p.id}">Report</button>` : ''}</div></section>
      ${p.restricted ? '<div class="ar-panel ar-empty"><b>This profile is private</b>Only the player can see their records.</div>' : `
      <div class="ar-stats" style="margin-top:14px">${[['Competitions', p.competitions], ['Money crowns', p.moneyWins], ['Category wins', p.categoryWins], ['Weeks played', p.records.weeksPlayed], ['Best eligible cash', p.records.bestCash === null ? '—' : N(p.records.bestCash)], ['Best Life Balance', p.records.bestLifeBalance === null ? '—' : p.records.bestLifeBalance], ['Best net worth', p.records.bestNetWorth === null ? '—' : N(p.records.bestNetWorth)], ['Achievements', ach.length]].map(([k, v]) => `<div class="ar-stat"><div class="k">${k}</div><div class="v" style="font-size:18px">${h(v)}</div></div>`).join('')}</div>
      <section class="ar-panel"><h2>Financial journey</h2>${chart([{ label: 'Eligible cash at each week end', color: '#F3B53A', points: p.journey.map((j, i) => ({ x: i + 1, y: j.eligible_cash })) }], { fmt: kfmt })}</section>
      <section class="ar-panel"><h2>Achievements</h2>${ach.length ? `<div class="ar-badges">${ach.map(a => `<span class="ar-badge">🏅 ${h((R.ACHIEVEMENTS[a.key] || {}).name || a.key)}</span>`).join('')}</div>` : '<p class="ar-muted">None yet.</p>'}</section>
      <section class="ar-panel"><h2>Challenges</h2><div class="ar-list">${p.rooms.map(r => `<a class="ar-item" href="#arena/room/${r.id}"><span class="grow"><span class="t">${h(r.name)}</span><span class="s">${r.status === 'complete' ? 'Complete' : 'Week ' + r.week}</span></span></a>`).join('') || '<p class="ar-muted">None yet.</p>'}</div></section>`}
      ${self ? `<form class="ar-panel ar-form" data-form="profile"><h2>Settings</h2>
        <label class="ar-field"><span>Display name</span><input type="text" name="displayName" maxlength="24" value="${h(p.displayName)}"></label>
        <div class="ar-field"><span>When you win the money crown, call you</span><div class="ar-seg" data-name="title">${[['king', 'Cash King'], ['queen', 'Cash Queen'], ['boss', 'Cash Boss']].map(([v, l]) => `<button type="button" data-a="seg" data-v="${v}" aria-pressed="${p.title === v}">${l}</button>`).join('')}<input type="hidden" name="title" value="${p.title}"></div></div>
        <div class="ar-field"><span>Who can see your records</span><div class="ar-seg" data-name="privacy">${[['public', 'Everyone (and the lifetime board)'], ['members', 'People in my challenges'], ['private', 'Only me']].map(([v, l]) => `<button type="button" data-a="seg" data-v="${v}" aria-pressed="${p.privacy === v}">${l}</button>`).join('')}<input type="hidden" name="privacy" value="${p.privacy}"></div><small>Inside a challenge, the other players always see your rank and money.</small></div>
        <label class="ar-check"><input type="checkbox" name="calm" ${root.classList.contains('calm') ? 'checked' : ''}><span><b>Reduce motion</b><br><small class="ar-muted">No confetti, no sliding rows. Your device setting is also respected.</small></span></label>
        <p class="ar-err" role="alert"></p><div class="ar-row2 ar-end"><button class="ar-btn" type="submit">Save</button></div>
        <hr class="ar-sep"><h3>Recovery code</h3><p class="ar-small ar-muted">Use it to move your Arena profile to another device. Keep it secret.</p>
        ${session && session.recoveryCode ? `<details><summary class="ar-link">Show my code</summary><p class="ar-code">${h(session.recoveryCode)}</p></details>` : '<p class="ar-small">Not stored on this device.</p>'}
        <h3>Friend code</h3><p class="ar-code" style="font-size:20px">${h(p.friendCode)}</p></form>` : ''}`);
  }
  ACT['form:profile'] = async f => {
    await api('PATCH', '/me', { displayName: f.displayName.value, title: f.elements.title.value, privacy: f.elements.privacy.value });
    root.classList.toggle('calm', f.calm.checked); try { localStorage.setItem('jos-arena-calm', f.calm.checked ? '1' : '0'); } catch (e) {}
    toastA('Saved.'); profileScreen();
  };
  ACT.report = async b => {
    const reason = prompt('What is wrong? (a rude name, cheating, harassment…)'); if (!reason) return;
    await api('POST', '/report', { kind: b.dataset.kind, targetId: b.dataset.id, reason }); toastA('Thank you. The report was sent.');
  };

  /* ---------- 19. Achievements ---------- */
  async function achievementsScreen() {
    const d = await cached('ach', '/achievements'), got = new Set(d.mine.map(a => a.key));
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div><section class="ar-panel"><h2>Achievements · ${got.size} of ${Object.keys(d.defs).length}</h2><p class="ar-small ar-muted">Decided only from official weekly results. Each one is earned once.</p>
      <div class="ar-ach">${Object.entries(d.defs).map(([k, a]) => `<div class="${got.has(k) ? 'got' : ''}"><b>${got.has(k) ? '🏅' : '🔒'} ${h(a.name)}</b><span>${h(a.d)}</span></div>`).join('')}</div></section>`);
  }

  /* ---------- 20. Challenge history ---------- */
  async function historyScreen() {
    const d = await cached('home', '/home'), done = d.rooms.filter(r => r.status === 'complete');
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div><section class="ar-panel"><h2>Challenge history</h2>
      ${done.length ? `<div class="ar-list">${done.map(r => `<a class="ar-item" href="#arena/room/${r.id}/final"><span class="grow"><span class="t">${h(r.name)}</span><span class="s">${r.weeks} weeks · ${r.players} players</span></span>${r.lastRank ? `<span class="ar-rank ${r.lastRank <= 3 ? 'g' + r.lastRank : ''}">${r.lastRank}</span>` : ''}</a>`).join('')}</div>` : '<div class="ar-empty"><b>No finished challenges yet</b>Your finished seasons and their final tables appear here.</div>'}</section>`);
  }

  /* ---------- 21. Friends and invitations ---------- */
  async function friendsScreen() {
    const roomFor = (location.hash.match(/room=([\w]+)/) || [])[1];
    const [f, inv] = await Promise.all([cached('friends', '/friends'), cached('invs', '/invitations')]);
    paint(`<div class="ar-back"><a class="ar-link" href="${roomFor ? `#arena/room/${roomFor}` : '#arena'}">← Back</a></div>
      ${roomFor ? '<p class="ar-note">Tick friends below, then press Invite.</p>' : ''}
      <div class="ar-grid two"><section class="ar-panel"><h2>Your friend code</h2><p class="ar-code">${h(f.friendCode)}</p><button class="ar-btn ghost sm" data-a="copy" data-text="${h(f.friendCode)}">Copy</button>
        <form class="ar-form" data-form="addFriend" style="margin-top:14px"><label class="ar-field"><span>Add a friend by their code</span><input type="text" name="code" maxlength="10" required autocomplete="off" style="text-transform:uppercase"></label><p class="ar-err" role="alert"></p><button class="ar-btn" type="submit">Send friend request</button></form></section>
      <section class="ar-panel"><h2>Challenge invitations</h2>${inv.invitations.length ? `<div class="ar-list">${inv.invitations.map(i => `<div class="ar-item"><span class="grow"><span class="t">${h(i.room_name)}</span><span class="s">From ${h(i.from_name)}</span></span><button class="ar-btn sm" data-a="inv" data-id="${i.id}" data-yes="1">Join</button><button class="ar-btn ghost sm" data-a="inv" data-id="${i.id}">Decline</button></div>`).join('')}</div>` : '<div class="ar-empty">No invitations waiting.</div>'}</section></div>
      <section class="ar-panel"><h2>Friends</h2>${f.friends.length ? `<div class="ar-list">${f.friends.map(x => `<div class="ar-item">${roomFor && x.status === 'accepted' ? `<input type="checkbox" class="ar-pick" value="${x.id}" aria-label="Invite ${h(x.displayName)}" style="width:20px;height:20px;accent-color:#F3B53A">` : ''}<span class="ar-facewrap">${face(x.avatar, 'sm')}<span class="dot ${x.online ? 'on' : ''}"></span></span><span class="grow"><span class="t">${h(x.displayName)}</span><span class="s">${x.status === 'accepted' ? (x.online ? 'Active recently' : 'Friend') : x.incoming ? 'Wants to be your friend' : 'Request sent'}</span></span>
        ${x.incoming ? `<button class="ar-btn sm" data-a="friend" data-id="${x.id}" data-v="accept">Accept</button><button class="ar-btn ghost sm" data-a="friend" data-id="${x.id}" data-v="reject">Reject</button>` : x.status === 'accepted' ? `<a class="ar-btn ghost sm" href="#arena/rival/${x.id}">Rivalry</a><button class="ar-link ar-small" data-a="friend" data-id="${x.id}" data-v="remove">Remove</button>` : ''}</div>`).join('')}</div>
        ${roomFor ? `<div class="ar-row2 ar-end" style="margin-top:12px"><button class="ar-btn" data-a="inviteFriends" data-room="${roomFor}">Invite to the challenge</button></div>` : ''}` : '<div class="ar-empty"><b>No friends yet</b>Swap friend codes to invite each other directly and track rivalries.</div>'}</section>`);
  }
  ACT['form:addFriend'] = async f => { const r = await api('POST', '/friends', { code: f.code.value }); toastA(r.status === 'accepted' ? 'You are now friends.' : 'Friend request sent.'); friendsScreen(); };
  ACT.friend = async b => { if (b.dataset.v === 'remove' && !confirm('Remove this friend?')) return; await api('POST', `/friends/${b.dataset.id}`, { action: b.dataset.v }); friendsScreen(); };
  ACT.inviteFriends = async b => { const ids = [...root.querySelectorAll('.ar-pick:checked')].map(x => x.value); if (!ids.length) { toastA('Tick at least one friend.'); return; } const r = await api('POST', `/rooms/${b.dataset.room}/invite`, { playerIds: ids }); toastA(`${r.invited} invitation${r.invited === 1 ? '' : 's'} sent.`); location.hash = `#arena/room/${b.dataset.room}`; };

  async function rivalScreen(pid) {
    const r = await api('GET', `/rivals/${pid}`);
    paint(`<div class="ar-back"><a class="ar-link" href="#arena/friends">← Friends</a></div><section class="ar-panel ar-reveal"><div class="ar-row2">${face(r.rival.avatar, 'xl')}<div><div class="ar-small ar-muted">Rivalry with</div><h2 style="font-size:28px;margin:0">${h(r.rival.displayName)}</h2></div></div>
      ${r.weeks ? `<div class="ar-stats" style="margin-top:14px">${[['Shared weeks', r.weeks], ['You ahead', r.wins], ['They ahead', r.losses], ['Level', r.ties], ['Cash difference', N(r.cashDiff)]].map(([k, v]) => `<div class="ar-stat"><div class="k">${k}</div><div class="v" style="font-size:18px">${h(v)}</div></div>`).join('')}</div>
      ${Object.keys(r.categories).length ? `<h3 style="margin-top:14px">Category head-to-head (weeks won)</h3><div class="ar-row2">${Object.entries(r.categories).map(([k, v]) => `<span class="ar-chip">${STATN[k]} ${v.me}–${v.them}</span>`).join('')}</div>` : ''}<p class="ar-small ar-muted">Challenges: ${r.rooms.map(h).join(', ')}</p>`
      : '<div class="ar-empty"><b>No shared weeks yet</b>Play a challenge together to start the record.</div>'}</section>`);
  }

  /* ---------- 22. Offline sync status ---------- */
  async function syncScreen() {
    const ops = await outbox(), log = (await store.all('oplog')).sort((a, b) => b.at - a.at).slice(0, 40);
    const R2 = { week_closed: 'Arrived after the week closed', deadline: 'Arrived after the deadline', turn_taken: 'That turn was already played (another device or autopilot)', out_of_order: 'An earlier turn was missing', invalid: 'The decisions did not fit the game state', not_member: 'Not a member of the challenge', not_active: 'The challenge was not running', story_done: 'Story already complete', depends_on_rejected: 'Built on a turn that was not accepted', bad_op: 'Damaged operation' };
    paint(`<div class="ar-back"><a class="ar-link" href="#arena">← Arena home</a></div>
      <section class="ar-panel"><div class="ar-row2"><h2 style="flex:1;margin:0">Sync status</h2><span class="ar-chip ${online ? 'on' : 'bad'}"><i></i>${online ? 'Online' : 'Offline'}</span><button class="ar-btn sm" data-a="syncNow" ${online && ops.length ? '' : 'disabled'}>Sync now</button></div>
        <p class="ar-small ar-muted">Turns are saved on this device first, then sent. The server replays each one and decides the official numbers. A turn is never thrown away silently: if it cannot be accepted, it stays listed here with the reason. Turns that arrive after a week's deadline cannot change that week's results.</p></section>
      <section class="ar-panel"><h2>Waiting to sync (${ops.length})</h2>${ops.length ? `<div class="ar-list">${ops.map(o => `<div class="ar-item"><span class="grow"><span class="t">${h(o.roomName || 'Challenge')} · week ${o.week}, turn ${o.turn}</span><span class="s">Played ${when(o.createdAt)}${o.attempts ? ` · ${o.attempts} attempt${o.attempts > 1 ? 's' : ''} · ${h(o.lastError === 'offline' ? 'offline' : o.lastError || '')}` : ''}</span></span><span class="ar-chip warn"><i></i>Queued</span></div>`).join('')}</div>` : '<div class="ar-empty">Nothing waiting.</div>'}</section>
      <section class="ar-panel"><h2>History</h2>${log.length ? `<div class="ar-list">${log.map(o => `<div class="ar-item"><span class="grow"><span class="t">${h(o.roomName || 'Challenge')} · week ${o.week}, turn ${o.turn}</span><span class="s">${o.status === 'accepted' ? (o.corrected ? 'Accepted with the server\'s numbers (your device differed)' : 'Accepted') : h(R2[o.reason] || o.message || o.reason)} · ${when(o.at)}</span></span><span class="ar-chip ${o.status === 'accepted' ? 'on' : 'bad'}"><i></i>${o.status === 'accepted' ? 'Accepted' : 'Not accepted'}</span></div>`).join('')}</div>` : '<div class="ar-empty">No synced turns yet.</div>'}</section>`);
    current = { live: () => { if (location.hash === '#arena/sync') syncScreen(); } };
  }
  ACT.syncNow = () => syncNow();

  /* ---------- start ---------- */
  // Show the Arena only where its server is set up (the website with a database); the artifact and local files never show it.
  (async () => {
    try { const r = await fetch('/api/health', { cache: 'no-store' }); const d = await r.json(); apiUp = !!d.ok; } catch (e) { apiUp = null; }
    const known = await loadSession().catch(() => null);
    if (apiUp || known) openBtn.hidden = false;
    if (/^#arena/.test(location.hash)) route();
    if (known) kickSync(1500);
  })();
})();
