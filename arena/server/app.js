// Japa or Stay: Challenge Arena — the API.
// Runs as a Cloudflare Pages Function (functions/api/[[path]].js) against D1, and in Node (arena/dev/server.js and the
// tests) against node:sqlite through a small D1-compatible shim. All game numbers are computed here by replaying
// players' decisions on the real game engine; no endpoint accepts money, stats, ranks or timestamps from a device.
'use strict';
const Rules = require('../shared/rules.js');
const Turn = require('../shared/turn.js');
const createEngine = require('./engine.generated.js');

let ARENA = null;
const arena = () => ARENA || (ARENA = Turn.makeArena(createEngine()));

const EMOJI = ['👏', '🔥', '😂', '💪', '👑', '😮'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_BODY = 64 * 1024;

/* ---------- small helpers ---------- */
class ApiError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const bad = (msg, code = 'bad_request') => new ApiError(400, code, msg);
const forbidden = (msg = 'You do not have permission to do that.') => new ApiError(403, 'forbidden', msg);
const notFound = (msg = 'Not found.') => new ApiError(404, 'not_found', msg);
const conflict = (msg, code = 'conflict', extra) => new ApiError(409, code, msg, extra);
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const randomCode = n => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join(''); };
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function ctxFor(env) {
  if (!env || !env.DB) throw new Error('The Arena needs a D1 database bound as DB.');
  if (!env.ARENA_SECRET || String(env.ARENA_SECRET).length < 32) throw new Error('Set ARENA_SECRET (32+ random characters) for the Arena.');
  const DB = env.DB;
  return {
    DB, secret: String(env.ARENA_SECRET),
    // autopilot turns this request may play while closing weeks (about 1 ms of CPU each; Workers Free allows 10 ms a request)
    autoBudget: Number(env.ARENA_AUTO_BUDGET) > 0 ? Number(env.ARENA_AUTO_BUDGET) : 6,
    now: typeof env.now === 'function' ? env.now : () => Date.now(),
    q: (sql, ...a) => DB.prepare(sql).bind(...a.map(v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)),
    one: (sql, ...a) => DB.prepare(sql).bind(...a).first(),
    all: async (sql, ...a) => (await DB.prepare(sql).bind(...a).all()).results || [],
    run: (sql, ...a) => DB.prepare(sql).bind(...a).run(),
    batch: stmts => DB.batch(stmts)
  };
}

/* ---------- router ---------- */
const ROUTES = [];
const route = (method, pattern, fn, opts = {}) => ROUTES.push({ method, rx: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, opts });

async function handle(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/^\/api/, '') || '/';
  // lets the page hide the Arena when the server side is not set up yet (no database or secret)
  if (p === '/health') return json({ ok: !!(env && env.DB && env.ARENA_SECRET && String(env.ARENA_SECRET).length >= 32), rules: Rules.CURRENT });
  const r = ROUTES.find(x => x.method === request.method && x.rx.test(p));
  if (!r) return json({ error: 'not_found', message: 'No such Arena endpoint.' }, 404);
  try {
    const C = ctxFor(env);
    const params = r.rx.exec(p).groups || {};
    let body = {};
    if (request.method !== 'GET') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_BODY) throw bad('That request is too large.');
      const text = await request.text();
      if (text.length > MAX_BODY) throw bad('That request is too large.');
      body = text ? parse(text, undefined) : {};
      if (body === undefined || typeof body !== 'object' || Array.isArray(body)) throw bad('The request body must be a JSON object.');
      // writes only from this site: browsers always send Origin on POST, and a form on another site cannot set this header
      if (request.headers.get('x-arena') !== '1') throw forbidden('Missing Arena request header.');
    }
    const me = r.opts.public ? await optionalAuth(C, request) : await auth(C, request);
    if (r.opts.limit) await limit(C, `${r.opts.limit[0]}:${me ? me.id : await clientKey(request, C.secret)}`, r.opts.limit[1], r.opts.limit[2]);
    const out = await r.fn({ C, me, params, body, query: url.searchParams, request });
    return out instanceof Response ? out : json(out);
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.code, message: e.message, ...(e.extra || {}) }, e.status);
    console.error('Arena error', e && e.stack || e);
    return json({ error: 'server_error', message: 'Something went wrong on the server. Your decisions are still saved on your device.' }, 500);
  }
}

/* ---------- identity, sessions, rate limits ---------- */
async function clientKey(request, secret) { return 'ip:' + (await hmac(secret, 'arena-ip|' + (request.headers.get('cf-connecting-ip') || 'local'))).slice(0, 24); }
async function optionalAuth(C, request) { const h = request.headers.get('authorization') || ''; return h ? auth(C, request) : null; }
async function auth(C, request) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '');
  if (!m) throw new ApiError(401, 'unauthorized', 'Sign in to the Arena first.');
  const me = await C.one('SELECT * FROM players WHERE token_hash = ?', await sha256(m[1]));
  if (!me) throw new ApiError(401, 'unauthorized', 'This device is no longer signed in. Use your recovery code.');
  const now = C.now();
  if (now - me.last_seen_at > 120000) await C.run('UPDATE players SET last_seen_at = ? WHERE id = ?', now, me.id);
  return me;
}
async function limit(C, key, max, windowSec) {
  const w = Math.floor(C.now() / 1000 / windowSec);
  const row = await C.one('INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT (key, window) DO UPDATE SET count = count + 1 RETURNING count', key, w);
  if (row && row.count > max) throw new ApiError(429, 'rate_limited', 'Too many requests. Wait a little and try again.');
  if (Math.random() < 0.02) await C.run('DELETE FROM rate_limits WHERE window < ?', w - 2);
}
const audit = (C, actor, room, action, detail) => C.q('INSERT INTO audit_log (actor_id, room_id, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?)', actor, room, action, JSON.stringify(detail || {}), C.now());
const notify = (C, id, player, kind, room, payload) => C.q('INSERT OR IGNORE INTO notifications (id, player_id, kind, room_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, player, kind, room, JSON.stringify(payload || {}), C.now());

function publicPlayer(p) { return { id: p.id, displayName: p.display_name, avatar: parse(p.avatar_json, {}), title: p.title }; }
function cleanName(s) {
  const v = Rules.cleanText(s, 24);
  if (v.length < 2) throw bad('Use a display name of at least 2 characters.');
  if (Rules.isRude(v)) throw bad('Please choose a different display name.');
  return v;
}

route('POST', '/auth/anon', async ({ C, body }) => {
  const token = randomHex(32), recovery = randomCode(12), id = 'p_' + randomHex(10), now = C.now();
  const name = body.displayName ? cleanName(body.displayName) : 'Player ' + randomCode(4);
  const avatar = arena().validateCharacter({ name: 'x', region: 'lagos', trait: 'hustler', av: body.avatar }).character.av;
  await C.run('INSERT INTO players (id, token_hash, recovery_hash, display_name, avatar_json, friend_code, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, await sha256(token), await sha256('rec|' + recovery), name, JSON.stringify(avatar), randomCode(8), now, now);
  return { playerId: id, token, recoveryCode: recovery.replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3') };
}, { public: true, limit: ['anon', 8, 3600] });

route('POST', '/auth/recover', async ({ C, body }) => {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 12) throw bad('Recovery codes have 12 letters and numbers.');
  const p = await C.one('SELECT * FROM players WHERE recovery_hash = ?', await sha256('rec|' + code));
  if (!p) throw notFound('That recovery code does not match a player.');
  // a fresh token signs this device in; the old device is signed out
  const token = randomHex(32);
  await C.batch([C.q('UPDATE players SET token_hash = ? WHERE id = ?', await sha256(token), p.id), audit(C, p.id, null, 'recover', {})]);
  return { playerId: p.id, token };
}, { public: true, limit: ['recover', 10, 3600] });

route('GET', '/me', async ({ C, me }) => ({ me: await profileOf(C, me, me, true) }));
route('PATCH', '/me', async ({ C, me, body }) => {
  const sets = [], vals = [];
  if (body.displayName !== undefined) { sets.push('display_name = ?'); vals.push(cleanName(body.displayName)); }
  if (body.avatar !== undefined) { sets.push('avatar_json = ?'); vals.push(JSON.stringify(arena().validateCharacter({ name: 'x', region: 'lagos', trait: 'hustler', av: body.avatar }).character.av)); }
  if (body.title !== undefined) { if (!['king', 'queen', 'boss'].includes(body.title)) throw bad('Pick King, Queen or Boss.'); sets.push('title = ?'); vals.push(body.title); }
  if (body.privacy !== undefined) { if (!['public', 'members', 'private'].includes(body.privacy)) throw bad('Pick a privacy setting.'); sets.push('privacy = ?'); vals.push(body.privacy); }
  if (sets.length) await C.run(`UPDATE players SET ${sets.join(', ')} WHERE id = ?`, ...vals, me.id);
  return { me: await profileOf(C, await C.one('SELECT * FROM players WHERE id = ?', me.id), me, true) };
}, { limit: ['me', 30, 60] });

/* ---------- home ---------- */
route('GET', '/home', async ({ C, me }) => {
  const rows = await C.all(`SELECT r.*, pa.id AS my_pid, pa.status AS my_status, pa.ready AS my_ready,
      (SELECT COUNT(*) FROM participants x WHERE x.room_id = r.id AND x.status = 'joined') AS players
    FROM participants pa JOIN rooms r ON r.id = pa.room_id
    WHERE pa.player_id = ? AND pa.status IN ('joined', 'pending') ORDER BY r.created_at DESC LIMIT 60`, me.id);
  // one room's trouble must never break everyone's home screen
  for (const r of rows) if (r.status === 'active' || r.status === 'lobby') { try { await advance(C, r.id); } catch (e) { console.error('Arena advance failed', r.id, e && e.message); } }
  const fresh = rows.length ? await C.all(`SELECT r.*, pa.id AS my_pid, pa.status AS my_status, pa.ready AS my_ready,
      (SELECT COUNT(*) FROM participants x WHERE x.room_id = r.id AND x.status = 'joined') AS players,
      (SELECT turns_used FROM char_states cs WHERE cs.participant_id = pa.id) AS turns_used,
      (SELECT rank_money FROM week_results wr WHERE wr.participant_id = pa.id ORDER BY week DESC LIMIT 1) AS last_rank
    FROM participants pa JOIN rooms r ON r.id = pa.room_id
    WHERE pa.player_id = ? AND pa.status IN ('joined', 'pending') ORDER BY r.created_at DESC LIMIT 60`, me.id) : [];
  const invitations = await C.all(`SELECT i.id, i.room_id, r.name AS room_name, r.status AS room_status, p.display_name AS from_name, i.created_at
    FROM invitations i JOIN rooms r ON r.id = i.room_id JOIN players p ON p.id = i.from_id WHERE i.to_id = ? AND i.status = 'pending' AND r.status = 'lobby' ORDER BY i.created_at DESC`, me.id);
  const unread = await C.one('SELECT COUNT(*) AS n FROM notifications WHERE player_id = ? AND read = 0', me.id);
  const friendReqs = await C.one(`SELECT COUNT(*) AS n FROM friends WHERE (a_id = ? OR b_id = ?) AND status = 'pending' AND requested_by != ?`, me.id, me.id, me.id);
  return { me: await profileOf(C, me, me, true), rooms: fresh.map(roomCard), invitations, unread: unread.n, friendRequests: friendReqs.n, now: C.now() };
});
function roomCard(r) {
  const cfg = parse(r.config_json, {});
  return { id: r.id, name: r.name, status: r.status, week: r.current_week, weeks: cfg.weeks, turnsPerWeek: cfg.turnsPerWeek, deadline: r.week_deadline_at,
    players: r.players, maxPlayers: cfg.maxPlayers, host: r.host_id, myStatus: r.my_status, myReady: !!r.my_ready, turnsUsed: r.turns_used, lastRank: r.last_rank, version: r.version };
}

/* ---------- rooms ---------- */
async function loadRoom(C, id) { const r = await C.one('SELECT * FROM rooms WHERE id = ?', id); if (!r) throw notFound('That challenge does not exist.'); r.config = parse(r.config_json, {}); return r; }
const myPart = (C, roomId, playerId) => C.one('SELECT * FROM participants WHERE room_id = ? AND player_id = ?', roomId, playerId);
async function requireMember(C, room, me, { pending = false } = {}) {
  const pa = await myPart(C, room.id, me.id);
  if (!pa || !(pa.status === 'joined' || (pending && pa.status === 'pending'))) throw forbidden('You are not a member of this challenge.');
  return pa;
}
const requireHost = (room, me) => { if (room.host_id !== me.id) throw forbidden('Only the host can do that.'); };
const requireLobby = room => { if (room.status !== 'lobby') throw conflict('This can only be done before the challenge starts.', 'not_lobby'); };
const bump = (C, roomId) => C.q('UPDATE rooms SET version = version + 1 WHERE id = ?', roomId);

route('POST', '/rooms', async ({ C, me, body }) => {
  const v = Rules.validateConfig(body, { now: C.now() });
  if (!v.ok) throw bad(v.errors.join(' '), 'invalid_config');
  const open = await C.one(`SELECT COUNT(*) AS n FROM rooms WHERE host_id = ? AND status IN ('lobby', 'active')`, me.id);
  if (open.n >= 10) throw bad('You are already hosting 10 open challenges.');
  const id = 'r_' + randomHex(10), now = C.now(), code = randomCode(8), pid = 'pa_' + randomHex(10);
  const rematch = body.rematchOf ? await C.one('SELECT id FROM rooms WHERE id = ?', String(body.rematchOf)) : null;
  await C.batch([
    C.q('INSERT INTO rooms (id, code, name, description, host_id, visibility, rules_version, config_json, created_at, rematch_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, code, v.config.name, v.config.description, me.id, v.config.visibility, Rules.CURRENT, JSON.stringify(v.config), now, rematch ? rematch.id : null),
    C.q(`INSERT INTO participants (id, room_id, player_id, status, joined_at) VALUES (?, ?, ?, 'joined', ?)`, pid, id, me.id, now),
    audit(C, me.id, id, 'room_create', { config: v.config })
  ]);
  return { room: await roomView(C, await loadRoom(C, id), me) };
}, { limit: ['create', 10, 3600] });

route('GET', '/rooms/public', async ({ C }) => {
  const rows = await C.all(`SELECT r.id, r.name, r.description, r.config_json, r.created_at, p.display_name AS host_name,
      (SELECT COUNT(*) FROM participants x WHERE x.room_id = r.id AND x.status = 'joined') AS players
    FROM rooms r JOIN players p ON p.id = r.host_id WHERE r.visibility = 'public' AND r.status = 'lobby' ORDER BY r.created_at DESC LIMIT 30`);
  return { rooms: rows.map(r => { const c = parse(r.config_json, {}); return { id: r.id, name: r.name, description: r.description, host: r.host_name, players: r.players, maxPlayers: c.maxPlayers, weeks: c.weeks, approval: c.approval }; }) };
});

// Invitation preview by code. The code is a secret only the host shares; knowing it never skips approval or capacity checks.
route('GET', '/invite/:code', async ({ C, params }) => {
  const r = await C.one('SELECT * FROM rooms WHERE code = ?', String(params.code).toUpperCase());
  if (!r) throw notFound('That invitation code does not match a challenge.');
  const cfg = parse(r.config_json, {}), host = await C.one('SELECT display_name FROM players WHERE id = ?', r.host_id);
  const n = await C.one(`SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = 'joined'`, r.id);
  return { invite: { roomId: r.id, name: r.name, description: r.description, host: host.display_name, status: r.status, players: n.n, maxPlayers: cfg.maxPlayers, rules: cfg } };
}, { limit: ['invite', 30, 600] });

route('POST', '/rooms/join', async ({ C, me, body }) => {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const r = code.length === 8 ? await C.one('SELECT * FROM rooms WHERE code = ?', code) : body.roomId ? await C.one(`SELECT * FROM rooms WHERE id = ? AND visibility = 'public'`, String(body.roomId)) : null;
  if (!r) throw notFound('That code does not match a challenge.');
  const room = await loadRoom(C, r.id);
  requireLobby(room);
  const pa = await myPart(C, room.id, me.id);
  if (pa && (pa.status === 'joined' || pa.status === 'pending')) return { room: await roomView(C, room, me), status: pa.status };
  if (pa && pa.status === 'removed') throw forbidden('The host removed you from this challenge.');
  const n = await C.one(`SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = 'joined'`, room.id);
  if (Rules.isFull(room.config, n.n)) throw conflict('This challenge is full.', 'full');
  const invited = await C.one(`SELECT id FROM invitations WHERE room_id = ? AND to_id = ? AND status = 'pending'`, room.id, me.id);
  // a host's direct invitation counts as approval; a code alone waits for the host when approval is on
  const status = room.config.approval && !invited ? 'pending' : 'joined', now = C.now();
  const stmts = [pa ? C.q('UPDATE participants SET status = ?, ready = 0, joined_at = ? WHERE id = ?', status, now, pa.id)
                    : C.q('INSERT INTO participants (id, room_id, player_id, status, joined_at) VALUES (?, ?, ?, ?, ?)', 'pa_' + randomHex(10), room.id, me.id, status, now),
    bump(C, room.id), audit(C, me.id, room.id, status === 'pending' ? 'join_request' : 'join', {})];
  if (invited) stmts.push(C.q(`UPDATE invitations SET status = 'accepted' WHERE id = ?`, invited.id));
  if (status === 'pending') stmts.push(notify(C, `${room.id}:req:${me.id}:${now}`, room.host_id, 'join_request', room.id, { name: me.display_name, room: room.name }));
  await C.batch(stmts);
  return { room: await roomView(C, await loadRoom(C, room.id), me), status };
}, { limit: ['join', 20, 600] });

route('GET', '/rooms/:id', async ({ C, me, params }) => {
  await advance(C, params.id);
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me, { pending: true });
  return { room: await roomView(C, room, me) };
});
// cheap change check for polling: clients refetch only when the version moves
route('GET', '/rooms/:id/version', async ({ C, me, params }) => {
  await advance(C, params.id);
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me, { pending: true });
  return { version: room.version, status: room.status, week: room.current_week, deadline: room.week_deadline_at, now: C.now() };
}, { limit: ['poll', 120, 60] });

async function roomView(C, room, me) {
  const parts = await C.all(`SELECT pa.*, p.display_name, p.avatar_json, p.title, p.last_seen_at, cs.turns_used, cs.story_done, cs.week AS cs_week
    FROM participants pa JOIN players p ON p.id = pa.player_id LEFT JOIN char_states cs ON cs.participant_id = pa.id
    WHERE pa.room_id = ? AND pa.status IN ('joined', 'pending') ORDER BY pa.joined_at`, room.id);
  const isHost = room.host_id === me.id, cfg = room.config, now = C.now();
  return {
    id: room.id, name: room.name, description: room.description, status: room.status, rulesVersion: room.rules_version, config: cfg,
    code: isHost || cfg.invitePermission === 'members' || room.status !== 'lobby' ? room.code : null,
    host: room.host_id, isHost, week: room.current_week, weekStartedAt: room.week_started_at, deadline: room.week_deadline_at,
    cutoff: room.week_deadline_at ? room.week_deadline_at + cfg.graceMinutes * 60000 : null, startedAt: room.started_at, completedAt: room.completed_at,
    version: room.version, now, rematchOf: room.rematch_of,
    participants: parts.filter(x => x.status === 'joined' || isHost || x.player_id === me.id).map(x => {
      const ch = parse(x.character_json, null);
      return { id: x.id, playerId: x.player_id, displayName: x.display_name, avatar: parse(x.avatar_json, {}), title: x.title, status: x.status, ready: !!x.ready, isHost: x.player_id === room.host_id,
        isMe: x.player_id === me.id, character: ch ? { name: ch.name, region: ch.region, trait: ch.trait, av: ch.av } : null,
        online: now - x.last_seen_at < 10 * 60000, turnsUsed: x.cs_week === room.current_week ? x.turns_used || 0 : 0, storyDone: !!x.story_done };
    })
  };
}

route('POST', '/rooms/:id/character', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireLobby(room);
  const pa = await requireMember(C, room, me);
  const v = arena().validateCharacter(body);
  if (!v.ok) throw bad(v.errors.join(' '));
  if (Rules.isRude(v.character.name)) throw bad('Please choose a different character name.');
  await C.batch([C.q('UPDATE participants SET character_json = ?, ready = 0 WHERE id = ?', JSON.stringify(v.character), pa.id), bump(C, room.id)]);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
}, { limit: ['write', 60, 60] });

route('POST', '/rooms/:id/ready', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireLobby(room);
  const pa = await requireMember(C, room, me);
  if (body.ready && !pa.character_json) throw bad('Create your character before you mark yourself ready.');
  await C.batch([C.q('UPDATE participants SET ready = ? WHERE id = ?', body.ready ? 1 : 0, pa.id), bump(C, room.id)]);
  await advance(C, room.id);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
}, { limit: ['write', 60, 60] });

route('POST', '/rooms/:id/approve', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireHost(room, me); requireLobby(room);
  const pa = await C.one(`SELECT * FROM participants WHERE id = ? AND room_id = ? AND status = 'pending'`, String(body.participantId || ''), room.id);
  if (!pa) throw notFound('That join request is not waiting any more.');
  if (body.accept) {
    const n = await C.one(`SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = 'joined'`, room.id);
    if (Rules.isFull(room.config, n.n)) throw conflict('The challenge is full.', 'full');
  }
  await C.batch([C.q('UPDATE participants SET status = ? WHERE id = ?', body.accept ? 'joined' : 'declined', pa.id), bump(C, room.id),
    notify(C, `${room.id}:approve:${pa.player_id}`, pa.player_id, body.accept ? 'join_accepted' : 'join_declined', room.id, { room: room.name }),
    audit(C, me.id, room.id, body.accept ? 'approve' : 'decline', { participant: pa.id })]);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
});

route('POST', '/rooms/:id/remove', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireHost(room, me); requireLobby(room);
  const pa = await C.one('SELECT * FROM participants WHERE id = ? AND room_id = ?', String(body.participantId || ''), room.id);
  if (!pa || pa.player_id === me.id) throw bad('Pick another player to remove.');
  await C.batch([C.q(`UPDATE participants SET status = 'removed', ready = 0 WHERE id = ?`, pa.id), bump(C, room.id), audit(C, me.id, room.id, 'remove', { participant: pa.id })]);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
});

route('POST', '/rooms/:id/leave', async ({ C, me, params }) => {
  const room = await loadRoom(C, params.id);
  const pa = await requireMember(C, room, me, { pending: true });
  if (room.status === 'lobby' && room.host_id === me.id) throw bad('The host cannot leave. Cancel the challenge instead.');
  // after the start, leaving keeps your official results but stops future turns (autopilot plays them so the table stays fair)
  await C.batch([C.q(`UPDATE participants SET status = 'left', ready = 0 WHERE id = ?`, pa.id), bump(C, room.id), audit(C, me.id, room.id, 'leave', { status: room.status })]);
  return { ok: true };
});

route('POST', '/rooms/:id/cancel', async ({ C, me, params }) => {
  const room = await loadRoom(C, params.id); requireHost(room, me); requireLobby(room);
  await C.batch([C.q(`UPDATE rooms SET status = 'cancelled', version = version + 1 WHERE id = ? AND status = 'lobby'`, room.id), audit(C, me.id, room.id, 'cancel', {})]);
  return { ok: true };
});

route('PATCH', '/rooms/:id/settings', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireHost(room, me); requireLobby(room);
  const v = Rules.validateConfig({ ...room.config, ...body }, { now: C.now() });
  if (!v.ok) throw bad(v.errors.join(' '), 'invalid_config');
  const n = await C.one(`SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = 'joined'`, room.id);
  if (v.config.maxPlayers > 0 && v.config.maxPlayers < n.n) throw bad(`${n.n} players have already joined.`);
  // changing the rules un-readies everyone, so nobody starts on rules they did not see
  await C.batch([C.q('UPDATE rooms SET name = ?, description = ?, visibility = ?, config_json = ?, version = version + 1 WHERE id = ? AND status = ?', v.config.name, v.config.description, v.config.visibility, JSON.stringify(v.config), room.id, 'lobby'),
    C.q('UPDATE participants SET ready = 0 WHERE room_id = ?', room.id), audit(C, me.id, room.id, 'settings', { config: v.config })]);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
});

route('POST', '/rooms/:id/start', async ({ C, me, params }) => {
  const room = await loadRoom(C, params.id); requireHost(room, me); requireLobby(room);
  if (room.config.startAt && Date.parse(room.config.startAt) > C.now()) throw conflict(`This challenge is set to start at ${room.config.startAt}.`, 'too_early');
  await startRoom(C, room, me.id);
  return { room: await roomView(C, await loadRoom(C, room.id), me) };
});

async function startRoom(C, room, actor) {
  const parts = await C.all(`SELECT * FROM participants WHERE room_id = ? AND status = 'joined'`, room.id);
  if (parts.length < Rules.LIMITS.minPlayers) throw conflict(`At least ${Rules.LIMITS.minPlayers} players must join first.`, 'not_enough_players');
  const notReady = parts.filter(p => !p.ready || !p.character_json);
  if (notReady.length) throw conflict(`${notReady.length} player${notReady.length > 1 ? 's are' : ' is'} not ready yet.`, 'not_ready');
  const R = Rules.rulesFor(room.rules_version), now = C.now(), cfg = room.config, deadline = now + cfg.roundHours * 3600000;
  const stmts = [C.q(`UPDATE rooms SET status = 'active', current_week = 1, started_at = ?, week_started_at = ?, week_deadline_at = ?, version = version + 1 WHERE id = ? AND status = 'lobby'`, now, now, deadline, room.id)];
  for (const pa of parts) {
    const ch = parse(pa.character_json);
    const st = arena().initState(ch, cfg, R, await hmac(C.secret, `init|${room.id}|${pa.id}`));
    stmts.push(C.q('INSERT INTO char_states (participant_id, room_id, state_json, week, opening_json, updated_at) VALUES (?, ?, ?, 1, ?, ?)', pa.id, room.id, JSON.stringify(st), JSON.stringify(Rules.metrics(st, R)), now));
    stmts.push(notify(C, `${room.id}:start:${pa.player_id}`, pa.player_id, 'challenge_started', room.id, { room: room.name }));
  }
  stmts.push(C.q(`INSERT OR IGNORE INTO weeks (room_id, week, status, started_at, deadline_at, rules_version) VALUES (?, 1, 'open', ?, ?, ?)`, room.id, now, deadline, room.rules_version));
  stmts.push(C.q(`UPDATE participants SET status = 'declined' WHERE room_id = ? AND status = 'pending'`, room.id));
  stmts.push(C.q(`UPDATE invitations SET status = 'expired' WHERE room_id = ? AND status = 'pending'`, room.id));
  stmts.push(audit(C, actor, room.id, 'start', { players: parts.length }));
  // the guarded UPDATE runs first; if another request already started the room, the char_states inserts collide and the whole batch rolls back
  try { await C.batch(stmts); } catch (e) { const r2 = await loadRoom(C, room.id); if (r2.status !== 'lobby') return; throw e; }
}

/* ---------- invitations and friends ---------- */
route('POST', '/rooms/:id/invite', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id); requireLobby(room);
  await requireMember(C, room, me);
  if (room.config.invitePermission === 'host') requireHost(room, me);
  const ids = Array.isArray(body.playerIds) ? body.playerIds.slice(0, 10).map(String) : [];
  const stmts = [];
  for (const id of ids) {
    const [a, b] = [me.id, id].sort();
    const fr = await C.one(`SELECT 1 AS ok FROM friends WHERE a_id = ? AND b_id = ? AND status = 'accepted'`, a, b);
    if (!fr) continue; // only friends can be invited directly; anyone else needs the code
    stmts.push(C.q(`INSERT INTO invitations (id, room_id, from_id, to_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?) ON CONFLICT (room_id, to_id) DO UPDATE SET status = 'pending', from_id = excluded.from_id WHERE invitations.status != 'accepted'`, 'i_' + randomHex(10), room.id, me.id, id, C.now()));
    stmts.push(notify(C, `${room.id}:invite:${id}`, id, 'invitation', room.id, { room: room.name, from: me.display_name }));
  }
  if (stmts.length) await C.batch(stmts);
  return { invited: stmts.length / 2 };
}, { limit: ['write', 60, 60] });

route('GET', '/invitations', async ({ C, me }) => ({ invitations: await C.all(`SELECT i.id, i.room_id, r.name AS room_name, r.description, p.display_name AS from_name, i.created_at FROM invitations i JOIN rooms r ON r.id = i.room_id JOIN players p ON p.id = i.from_id WHERE i.to_id = ? AND i.status = 'pending' AND r.status = 'lobby'`, me.id) }));
route('POST', '/invitations/:id', async ({ C, me, params, body }) => {
  const inv = await C.one(`SELECT * FROM invitations WHERE id = ? AND to_id = ? AND status = 'pending'`, params.id, me.id);
  if (!inv) throw notFound('That invitation is not waiting any more.');
  if (!body.accept) { await C.run(`UPDATE invitations SET status = 'declined' WHERE id = ?`, inv.id); return { ok: true }; }
  const room = await loadRoom(C, inv.room_id); requireLobby(room);
  const n = await C.one(`SELECT COUNT(*) AS n FROM participants WHERE room_id = ? AND status = 'joined'`, room.id);
  if (Rules.isFull(room.config, n.n)) throw conflict('This challenge is full.', 'full');
  const pa = await myPart(C, room.id, me.id);
  if (pa && pa.status === 'removed') throw forbidden('The host removed you from this challenge.');
  await C.batch([pa ? C.q(`UPDATE participants SET status = 'joined', ready = 0 WHERE id = ?`, pa.id) : C.q(`INSERT INTO participants (id, room_id, player_id, status, joined_at) VALUES (?, ?, ?, 'joined', ?)`, 'pa_' + randomHex(10), room.id, me.id, C.now()),
    C.q(`UPDATE invitations SET status = 'accepted' WHERE id = ?`, inv.id), bump(C, room.id), audit(C, me.id, room.id, 'join', { via: 'invitation' })]);
  return { roomId: room.id };
});

route('GET', '/friends', async ({ C, me }) => {
  const rows = await C.all(`SELECT f.*, p.id AS pid, p.display_name, p.avatar_json, p.title, p.last_seen_at FROM friends f JOIN players p ON p.id = (CASE WHEN f.a_id = ? THEN f.b_id ELSE f.a_id END) WHERE f.a_id = ? OR f.b_id = ? ORDER BY p.display_name`, me.id, me.id, me.id);
  return { friendCode: me.friend_code, friends: rows.map(r => ({ ...publicPlayer({ id: r.pid, display_name: r.display_name, avatar_json: r.avatar_json, title: r.title }), status: r.status, incoming: r.status === 'pending' && r.requested_by !== me.id, online: C.now() - r.last_seen_at < 600000 })) };
});
route('POST', '/friends', async ({ C, me, body }) => {
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const p = await C.one('SELECT * FROM players WHERE friend_code = ?', code);
  if (!p) throw notFound('No player has that friend code.');
  if (p.id === me.id) throw bad('That is your own friend code.');
  const [a, b] = [me.id, p.id].sort();
  const ex = await C.one('SELECT * FROM friends WHERE a_id = ? AND b_id = ?', a, b);
  if (ex && ex.status === 'accepted') return { status: 'accepted' };
  // if they already asked you, adding them back accepts
  if (ex && ex.requested_by === p.id) { await C.run(`UPDATE friends SET status = 'accepted' WHERE a_id = ? AND b_id = ?`, a, b); return { status: 'accepted' }; }
  await C.batch([C.q(`INSERT OR IGNORE INTO friends (a_id, b_id, status, requested_by, created_at) VALUES (?, ?, 'pending', ?, ?)`, a, b, me.id, C.now()),
    notify(C, `friend:${a}:${b}`, p.id, 'friend_request', null, { from: me.display_name })]);
  return { status: 'pending' };
}, { limit: ['friend', 20, 3600] });
route('POST', '/friends/:id', async ({ C, me, params, body }) => {
  const [a, b] = [me.id, String(params.id)].sort();
  const ex = await C.one('SELECT * FROM friends WHERE a_id = ? AND b_id = ?', a, b);
  if (!ex) throw notFound('No friend request found.');
  if (body.action === 'accept' && ex.requested_by !== me.id) await C.run(`UPDATE friends SET status = 'accepted' WHERE a_id = ? AND b_id = ?`, a, b);
  else if (body.action === 'reject' || body.action === 'remove') await C.run('DELETE FROM friends WHERE a_id = ? AND b_id = ?', a, b);
  else throw bad('Unknown friend action.');
  return { ok: true };
});

/* ---------- playing ---------- */
const seedFor = (C, room, pid, week, turn) => hmac(C.secret, `turn|${room.id}|${pid}|${week}|${turn}`);
const cutoffOf = room => room.week_deadline_at + room.config.graceMinutes * 60000;

route('GET', '/rooms/:id/play', async ({ C, me, params }) => {
  await advance(C, params.id);
  const room = await loadRoom(C, params.id);
  const pa = await requireMember(C, room, me);
  const cs = await C.one('SELECT * FROM char_states WHERE participant_id = ?', pa.id);
  if (!cs) throw conflict('This challenge has not started yet.', 'not_started');
  const used = cs.week === room.current_week ? cs.turns_used : 0, T = room.config.turnsPerWeek;
  // seeds for this week's remaining turns, so the week can be played offline. Next week's seeds are not released.
  const tickets = [];
  if (room.status === 'active' && !cs.story_done) for (let t = used + 1; t <= T; t++) tickets.push({ week: room.current_week, turn: t, seed: await seedFor(C, room, pa.id, room.current_week, t) });
  return { participantId: pa.id, status: room.status, week: room.current_week, weeks: room.config.weeks, turnsPerWeek: T, turnsUsed: used, storyDone: !!cs.story_done,
    stateVersion: cs.state_version, state: parse(cs.state_json), stateHash: Turn.stateHash(parse(cs.state_json)), tickets,
    deadline: room.week_deadline_at, cutoff: cutoffOf(room), now: C.now(), rulesVersion: room.rules_version };
});

// Offline-first sync: the device sends queued decisions; each op has a unique id, so a retry can never apply twice.
route('POST', '/sync', async ({ C, me, body }) => {
  const ops = Array.isArray(body.ops) ? body.ops.slice(0, 20) : [];
  const results = [];
  for (const op of ops) {
    try { results.push(await syncOp(C, me, op)); }
    catch (e) { if (e instanceof ApiError) results.push({ opId: op && op.opId, status: 'rejected', reason: e.code, message: e.message }); else throw e; }
  }
  return { results, now: C.now() };
}, { limit: ['sync', 60, 60] });

async function syncOp(C, me, op) {
  if (!op || typeof op.opId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(op.opId)) throw bad('Every operation needs a valid id.', 'bad_op');
  const seen = await C.one('SELECT * FROM sync_ops WHERE op_id = ?', op.opId);
  if (seen) {
    if (seen.player_id !== me.id) throw forbidden('That operation id belongs to someone else.');
    return { ...parse(seen.result_json, {}), opId: op.opId, status: seen.status, duplicate: true };
  }
  const reject = async (reason, message, extra) => {
    const res = { opId: op.opId, status: 'rejected', reason, message, ...(extra || {}) };
    await C.run(`INSERT OR IGNORE INTO sync_ops (op_id, player_id, room_id, kind, status, reason, received_at, result_json) VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?)`, op.opId, me.id, String(op.roomId || ''), String(op.kind || ''), reason, C.now(), JSON.stringify(res));
    return res;
  };
  if (op.kind !== 'turn') return reject('bad_op', 'Unknown operation.');
  if (JSON.stringify(op.decisions || {}).length > 4000) return reject('bad_op', 'Those decisions are too large.');
  await advance(C, String(op.roomId));
  const room = await loadRoom(C, String(op.roomId));
  const pa = await myPart(C, room.id, me.id);
  if (!pa || pa.status !== 'joined') return reject('not_member', 'You are not playing in this challenge.');
  if (room.status !== 'active') return reject('not_active', room.status === 'complete' ? 'This challenge has finished.' : 'This challenge is not running.');
  if (op.week !== room.current_week) return reject('week_closed', `Week ${op.week} closed before these decisions reached the server. Official results for that week are final.`, { serverWeek: room.current_week });
  if (C.now() > cutoffOf(room)) return reject('deadline', 'These decisions reached the server after the deadline.');
  const cs = await C.one('SELECT * FROM char_states WHERE participant_id = ?', pa.id);
  const used = cs.week === room.current_week ? cs.turns_used : 0;
  if (cs.story_done) return reject('story_done', 'Your story is complete. Your final life stands on the table.');
  if (op.turn !== used + 1 || op.baseVersion !== cs.state_version) return reject(op.turn <= used ? 'turn_taken' : 'out_of_order', op.turn <= used ? `Turn ${op.turn} was already played${cs.state_version !== op.baseVersion ? ' (from another device or by autopilot)' : ''}.` : 'An earlier turn has not been accepted yet.', { serverVersion: cs.state_version, serverTurnsUsed: used });
  const res = await applyTurn(C, room, pa, cs, room.current_week, used + 1, op.decisions || {}, op.opId, false);
  if (res.invalid) return reject('invalid', res.invalid);
  const out = { opId: op.opId, status: 'accepted', stateVersion: res.stateVersion, serverHash: res.hash, match: !op.clientHash || op.clientHash === res.hash, turnsUsed: used + 1 };
  if (!out.match) out.state = res.state;
  return out;
}

// replays one turn and writes it atomically; returns { invalid } or { state, stateVersion, hash }
async function applyTurn(C, room, pa, cs, week, turn, decisions, opId, auto) {
  const R = Rules.rulesFor(room.rules_version), before = parse(cs.state_json);
  const seed = await seedFor(C, room, pa.id, week, turn);
  const r = arena().play(before, seed, decisions);
  if (r.status === 'invalid') return { invalid: r.error };
  if (r.status !== 'done') return { invalid: `The decisions stop early: the turn still needs ${r.need === 'picks' ? 'your cards' : r.need === 'choice' ? 'an event choice' : r.need === 'yearEnd' ? 'your Year 2 choice' : 'more steps'}.` };
  const after = r.state, hash = Turn.stateHash(after), now = C.now();
  const mb = Rules.metrics(before, R), ma = Rules.metrics(after, R);
  const stmts = [
    C.q('UPDATE char_states SET state_json = ?, state_version = state_version + 1, week = ?, turns_used = ?, story_done = ?, updated_at = ? WHERE participant_id = ? AND state_version = ?',
      JSON.stringify(after), week, turn, r.storyDone ? 1 : 0, now, pa.id, cs.state_version),
    // UNIQUE (participant, week, turn) fails if another request wrote this turn first, which rolls back the whole batch
    C.q('INSERT INTO turns (participant_id, room_id, week, turn, op_id, decisions_json, auto, rules_version, state_hash, stats_json, cash_before, cash_after, game_week, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      pa.id, room.id, week, turn, opId, JSON.stringify({ picks: decisions.picks || null, choices: decisions.choices || [], yearEnd: decisions.yearEnd || null }), auto ? 1 : 0, room.rules_version, hash,
      JSON.stringify(Turn.lifeStats(after)), mb.cashNgn, ma.cashNgn, after.week, now),
    bump(C, room.id)
  ];
  for (const l of ledgerLines(before, after, R, mb, ma)) stmts.push(C.q('INSERT INTO ledger (participant_id, room_id, week, turn, category, label, amount, currency, original_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', pa.id, room.id, week, turn, l.category, l.label, l.amount, l.currency, l.original, now));
  if (!auto) stmts.push(C.q(`INSERT INTO sync_ops (op_id, player_id, room_id, kind, status, received_at, result_json) VALUES (?, ?, ?, 'turn', 'accepted', ?, ?)`, opId, pa.player_id, room.id, now, JSON.stringify({ stateVersion: cs.state_version + 1, serverHash: hash, turnsUsed: turn })));
  if (after.abroad && !before.abroad) stmts.push(C.q('INSERT OR IGNORE INTO achievements (player_id, key, room_id, week, created_at) VALUES (?, ?, ?, ?, ?)', pa.player_id, 'japa_made', room.id, week, now));
  try { await C.batch(stmts); }
  catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) throw conflict('That turn was already played.', 'turn_taken');
    throw e;
  }
  return { state: after, stateVersion: cs.state_version + 1, hash, storyDone: !!r.storyDone };
}

// The ledger explains every naira that moved in a turn. Settle-up lines come straight from the game's own money summary;
// everything else (cards, hustles, event choices, conversions) is one balancing line, so the lines always add up.
function ledgerLines(before, after, R, mb, ma) {
  const lines = [], fx = R.fxRate;
  // the money summary belongs to this turn only if the turn reached settle-up (the week number moved on)
  const L = after.ledger && after.week !== before.week ? after.ledger : null;
  const cat = label => /^(Pay|Wages|Your pay|Salary)/i.test(label) ? 'salary' : /Business profit|Shop sales/i.test(label) ? 'business_revenue'
    : /Staff wages|Apprentice|Branch rent|Shop rent|Supplier/i.test(label) ? 'business_expense' : /Rent|Food|Transport|Bus pass|Heating/i.test(label) ? 'living_costs'
    : /Loan|Credit card|loan/i.test(label) ? 'debt' : /Ajo/i.test(label) ? 'savings' : /Money Rain/i.test(label) ? 'investment' : /Emeka/i.test(label) ? 'other_income' : 'other';
  let sum = 0;
  if (L && Array.isArray(L.lines)) for (const [label, amt] of L.lines) {
    if (!amt) continue;
    const ngn = Math.round(L.abroad ? amt * fx : amt);
    lines.push({ category: cat(String(label)), label: String(label).slice(0, 80), amount: ngn, currency: L.abroad ? 'USD' : 'NGN', original: Math.round(amt) });
    sum += ngn;
  }
  // settle-up lines that only move debt (interest) change liabilities, not cash; the balancing line keeps cash exact
  const rest = (ma.cashNgn - mb.cashNgn) - sum;
  if (rest) lines.push({ category: 'activity', label: 'Cards, hustles, events and transfers', amount: rest, currency: 'NGN', original: rest });
  return lines;
}

/* ---------- the clock: starting rooms and finalising weeks ---------- */
// Called on most reads. Safe to call any number of times, from any number of requests at once.
// Closing a week is incremental: each request plays at most C.autoBudget autopilot turns (about 1 ms of CPU each), so no
// single request runs long, whatever the room size. Progress is saved turn by turn; the next request carries on.
async function advance(C, roomId) {
  for (let i = 0; i < 20; i++) {
    const room = await C.one('SELECT * FROM rooms WHERE id = ?', roomId);
    if (!room) return;
    room.config = parse(room.config_json, {});
    const now = C.now();
    if (room.status === 'lobby' && room.config.startAt && Date.parse(room.config.startAt) <= now) {
      try { await startRoom(C, room, null); } catch (e) { if (!(e instanceof ApiError)) throw e; return; }
      continue;
    }
    if (room.status !== 'active') return;
    const T = room.config.turnsPerWeek;
    let due = now >= cutoffOf(room);
    if (!due && room.config.earlyFinish) {
      const left = await C.one(`SELECT COUNT(*) AS n FROM participants pa JOIN char_states cs ON cs.participant_id = pa.id
        WHERE pa.room_id = ? AND pa.status = 'joined' AND cs.story_done = 0 AND (cs.week != ? OR cs.turns_used < ?)`, room.id, room.current_week, T);
      due = left.n === 0;
    }
    if (!due) return;
    if (!(await finalizeWeek(C, room))) return; // out of budget for this request: the next one continues
  }
}

// returns true when the week is scored (by this request or another), false when autopilot work remains
async function finalizeWeek(C, room) {
  const week = room.current_week, cfg = room.config, T = cfg.turnsPerWeek, R = Rules.rulesFor(room.rules_version);
  // 1. autopilot plays any turns still missing (players who left are played by autopilot too, so the table stays complete)
  const parts = await C.all(`SELECT pa.*, p.display_name, p.title FROM participants pa JOIN players p ON p.id = pa.player_id WHERE pa.room_id = ? AND pa.status IN ('joined', 'left') AND EXISTS (SELECT 1 FROM char_states cs WHERE cs.participant_id = pa.id)`, room.id);
  const states = {};
  for (const cs of await C.all('SELECT * FROM char_states WHERE room_id = ?', room.id)) states[cs.participant_id] = cs;
  // each request starts at a random player, so requests arriving together share the work instead of colliding
  const off = parts.length ? Math.floor(Math.random() * parts.length) : 0;
  for (const pa of parts.slice(off).concat(parts.slice(0, off))) {
    let cs = states[pa.id];
    for (let guard = 0; guard < T + 2; guard++) {
      const used = cs.week === week ? cs.turns_used : 0;
      if (cs.story_done || used >= T) break;
      if (C.autoBudget <= 0) return false;
      C.autoBudget--;
      const st = parse(cs.state_json), seed = await seedFor(C, room, pa.id, week, used + 1);
      const dec = arena().autopilotDecisions(st, seed);
      try {
        const res = await applyTurn(C, room, pa, cs, week, used + 1, dec, `auto_${pa.id}_${week}_${used + 1}`, true);
        if (res.invalid) throw new Error('Autopilot produced an invalid turn: ' + res.invalid);
        cs = { ...cs, state_json: JSON.stringify(res.state), state_version: res.stateVersion, week, turns_used: used + 1, story_done: res.storyDone ? 1 : 0 };
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'turn_taken')) throw e;
        cs = await C.one('SELECT * FROM char_states WHERE participant_id = ?', pa.id); // another request played it: reload and carry on
      }
    }
    states[pa.id] = cs;
  }
  const fresh = await C.one('SELECT current_week, status FROM rooms WHERE id = ?', room.id);
  if (fresh.status !== 'active' || fresh.current_week !== week) return true; // someone else finalised it meanwhile
  // 2. score the week from trusted states only (a fixed number of queries, whatever the room size)
  for (const cs of await C.all('SELECT * FROM char_states WHERE room_id = ?', room.id)) states[cs.participant_id] = cs;
  const prevRows = {}, trails = {}, winsBefore = {};
  if (week > 1) for (const r of await C.all('SELECT * FROM week_results WHERE room_id = ? AND week = ?', room.id, week - 1)) prevRows[r.participant_id] = r;
  for (const t of await C.all('SELECT participant_id, stats_json FROM turns WHERE room_id = ? AND week = ? ORDER BY participant_id, turn', room.id, week)) (trails[t.participant_id] = trails[t.participant_id] || []).push(parse(t.stats_json));
  for (const w of await C.all(`SELECT participant_id, COUNT(*) AS n FROM week_awards WHERE room_id = ? AND award_key = 'money' AND week < ? GROUP BY participant_id`, room.id, week)) winsBefore[w.participant_id] = w.n;
  const rows = [];
  for (const pa of parts) {
    const cs = states[pa.id], prevRow = prevRows[pa.id], st = parse(cs.state_json);
    const prev = prevRow ? { m: parse(prevRow.metrics_json), cum: parse(prevRow.cum_json), ranks: parse(prevRow.ranks_json) } : { m: parse(cs.opening_json), cum: null, opening: true };
    rows.push({ pid: pa.id, playerId: pa.player_id, name: (parse(pa.character_json, {}).name || pa.display_name), title: pa.title, region: st.region, state: st, prev, statTrail: trails[pa.id] || [] });
    winsBefore[pa.id] = winsBefore[pa.id] || 0;
  }
  const out = Rules.computeWeek(rows, R, week);
  const names = Object.fromEntries(rows.map(r => [r.pid, r.name]));
  const hl = Rules.highlights(week, out, names);
  const now = C.now(), last = week >= cfg.weeks;
  const nextStart = now >= cutoffOf(room) ? room.week_deadline_at : now; // overdue weeks keep the schedule; early finishes start the next week now
  const nextDeadline = nextStart + cfg.roundHours * 3600000;
  const stmts = [
    last ? C.q(`UPDATE rooms SET status = 'complete', completed_at = ?, version = version + 1 WHERE id = ? AND current_week = ? AND status = 'active'`, now, room.id, week)
         : C.q('UPDATE rooms SET current_week = ?, week_started_at = ?, week_deadline_at = ?, version = version + 1 WHERE id = ? AND current_week = ? AND status = ?', week + 1, nextStart, nextDeadline, room.id, week, 'active'),
    C.q(`UPDATE weeks SET status = 'final', finalized_at = ?, highlights_json = ? WHERE room_id = ? AND week = ? AND status = 'open'`, now, JSON.stringify(hl), room.id, week)
  ];
  if (!last) {
    stmts.push(C.q(`INSERT OR IGNORE INTO weeks (room_id, week, status, started_at, deadline_at, rules_version) VALUES (?, ?, 'open', ?, ?, ?)`, room.id, week + 1, nextStart, nextDeadline, room.rules_version));
    stmts.push(C.q('UPDATE char_states SET week = ?, turns_used = 0 WHERE room_id = ? AND week = ?', week + 1, room.id, week));
  }
  for (const r of rows) {
    const res = out.results[r.pid];
    stmts.push(C.q('INSERT OR IGNORE INTO week_results (room_id, week, participant_id, rank_money, eligible_cash, net_worth, life_balance, metrics_json, deltas_json, ranks_json, cum_json, rules_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      room.id, week, r.pid, res.ranks.money, res.m.eligibleCash, res.m.netWorth, res.m.lifeBalance, JSON.stringify(res.m), JSON.stringify(res.d), JSON.stringify(res.ranks), JSON.stringify(res.cum), room.rules_version, now));
    const wonMoney = out.awards.some(a => a.key === 'money' && a.pids.includes(r.pid));
    const keys = Rules.achievementsFor(r, res, out.awards, winsBefore[r.pid] + (wonMoney ? 1 : 0));
    if (last && res.ranks.money === 1) keys.push('season_champion');
    for (const k of keys) stmts.push(C.q('INSERT OR IGNORE INTO achievements (player_id, key, room_id, week, created_at) VALUES (?, ?, ?, ?, ?)', r.playerId, k, room.id, week, now));
    stmts.push(notify(C, `${room.id}:${week}:${r.playerId}:results`, r.playerId, last ? 'challenge_complete' : 'week_results', room.id, { room: room.name, week, rank: res.ranks.money }));
  }
  for (const a of out.awards) for (const pid of a.pids) stmts.push(C.q('INSERT OR IGNORE INTO week_awards (room_id, week, award_key, participant_id, value) VALUES (?, ?, ?, ?, ?)', room.id, week, a.key, pid, a.value));
  stmts.push(audit(C, null, room.id, 'finalize_week', { week, players: rows.length, awards: out.awards.length }));
  await C.batch(stmts);
  return true;
}

/* ---------- leaderboards and results ---------- */
// visibility: everyone in a room always sees ranks, names and money; 'summary' rooms hide other players' life stats
function shapeRow(row, room, meId, extra) {
  const full = room.config.statsVisibility === 'full' || row.playerId === meId;
  const m = row.m;
  return { participantId: row.pid, playerId: row.playerId, displayName: row.displayName, characterName: row.characterName, avatar: row.avatar, isMe: row.playerId === meId,
    place: m.place, career: m.career, path: m.path, cash: m.cash, usd: m.usd, eligibleCash: m.eligibleCash, netWorth: m.netWorth, liabilities: m.liabilities,
    stats: full ? { strength: m.strength, happiness: m.happiness, body: m.body, family: m.family, people: m.people, clout: m.clout } : null,
    lifeBalance: full ? m.lifeBalance : null, hidden: !full, ...extra };
}
async function membersOf(C, room) {
  return C.all(`SELECT pa.id AS pid, pa.player_id, pa.status, pa.character_json, p.display_name, p.avatar_json, p.title, p.last_seen_at, cs.state_json, cs.turns_used, cs.week AS cs_week, cs.story_done
    FROM participants pa JOIN players p ON p.id = pa.player_id LEFT JOIN char_states cs ON cs.participant_id = pa.id WHERE pa.room_id = ? AND pa.status IN ('joined', 'left') AND cs.participant_id IS NOT NULL`, room.id);
}
route('GET', '/rooms/:id/board', async ({ C, me, params, query }) => {
  await advance(C, params.id);
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me);
  const R = Rules.rulesFor(room.rules_version), which = query.get('week') || 'current', members = await membersOf(C, room);
  const base = m => ({ pid: m.pid, playerId: m.player_id, displayName: m.display_name, characterName: parse(m.character_json, {}).name, avatar: parse(m.character_json, {}).av || parse(m.avatar_json, {}) });
  const wins = await C.all('SELECT participant_id, award_key, COUNT(*) AS n FROM week_awards WHERE room_id = ? GROUP BY participant_id, award_key', room.id);
  const winsOf = pid => ({ money: (wins.find(w => w.participant_id === pid && w.award_key === 'money') || {}).n || 0, total: wins.filter(w => w.participant_id === pid).reduce((a, w) => a + w.n, 0) });
  const badges = await C.all('SELECT a.player_id, a.key FROM achievements a WHERE a.room_id = ?', room.id);
  const badgesOf = id => badges.filter(b => b.player_id === id).map(b => b.key);
  if (which === 'current') {
    // live standings: provisional numbers from the latest accepted turns
    const live = members.map(m => ({ ...base(m), m: Rules.metrics(parse(m.state_json), R), lastSeen: m.last_seen_at, turnsUsed: m.cs_week === room.current_week ? m.turns_used : 0, left: m.status === 'left', storyDone: !!m.story_done }));
    const prev = room.current_week > 1 ? await C.all('SELECT participant_id, ranks_json FROM week_results WHERE room_id = ? AND week = ?', room.id, room.current_week - 1) : [];
    const ranks = {}; for (const b of ['money', 'netWorth', 'lifeBalance', ...Rules.STAT_KEYS]) ranks[b] = Rules.rank(live, Rules.BOARDS[b]);
    const now = C.now();
    return { kind: 'live', official: false, week: room.current_week, status: room.status, turnsPerWeek: room.config.turnsPerWeek, rows: live.map(x => {
      const pr = prev.find(p => p.participant_id === x.pid);
      return shapeRow(x, room, me.id, { ranks: Object.fromEntries(Object.keys(ranks).map(b => [b, ranks[b][x.pid]])), rankChange: pr ? parse(pr.ranks_json).money - ranks.money[x.pid] : 0,
        turnsUsed: x.turnsUsed, online: now - x.lastSeen < 600000, left: x.left, storyDone: x.storyDone, wins: winsOf(x.pid), badges: badgesOf(x.playerId) });
    }) };
  }
  if (which === 'lifetime') {
    const res = await C.all('SELECT * FROM week_results WHERE room_id = ? ORDER BY week', room.id);
    const rows = members.map(m => {
      const mine = res.filter(r => r.participant_id === m.pid), lastR = mine[mine.length - 1];
      const mm = lastR ? parse(lastR.metrics_json) : Rules.metrics(parse(m.state_json), R);
      return { ...base(m), m: mm, weeks: mine.length, avgLife: mine.length ? Math.round(mine.reduce((a, r) => a + r.life_balance, 0) / mine.length * 10) / 10 : null, bestRank: mine.length ? Math.min(...mine.map(r => r.rank_money)) : null, wins: winsOf(m.pid) };
    });
    const order = Rules.rank(rows.map(r => ({ ...r, pid: r.pid })), [r => r.wins.money, r => r.m.eligibleCash, r => r.wins.total]);
    return { kind: 'lifetime', official: true, weeksFinal: Math.max(0, ...res.map(r => r.week)), rows: rows.map(r => shapeRow(r, room, me.id, { rank: order[r.pid], weeks: r.weeks, avgLife: room.config.statsVisibility === 'full' || r.playerId === me.id ? r.avgLife : null, bestRank: r.bestRank, wins: r.wins, badges: badgesOf(r.playerId) })) };
  }
  const wk = Number(which);
  if (!Number.isInteger(wk) || wk < 1) throw bad('Pick a week.');
  const res = await C.all('SELECT * FROM week_results WHERE room_id = ? AND week = ?', room.id, wk);
  if (!res.length) throw notFound(`Week ${wk} has no official results yet.`);
  return { kind: 'week', official: true, week: wk, rows: res.map(r => {
    const m = members.find(x => x.pid === r.participant_id) || {};
    return shapeRow({ pid: r.participant_id, playerId: m.player_id, displayName: m.display_name, characterName: parse(m.character_json, {}).name, avatar: parse(m.character_json, {}).av, m: parse(r.metrics_json) }, room, me.id,
      { ranks: parse(r.ranks_json), deltas: room.config.statsVisibility === 'full' || m.player_id === me.id ? parse(r.deltas_json) : { eligibleCash: parse(r.deltas_json).eligibleCash, netWorth: parse(r.deltas_json).netWorth }, rankChange: parse(r.ranks_json).moneyChange || 0, wins: winsOf(r.participant_id), badges: badgesOf(m.player_id) });
  }) };
});

// everything the weekly results ceremony needs, from official snapshots only
route('GET', '/rooms/:id/weeks/:week', async ({ C, me, params }) => {
  await advance(C, params.id);
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me);
  const wk = Number(params.week);
  const w = await C.one('SELECT * FROM weeks WHERE room_id = ? AND week = ?', room.id, wk);
  if (!w || w.status !== 'final') throw notFound(`Week ${wk} is not final yet.`);
  const members = await membersOf(C, room), titles = Object.fromEntries(members.map(m => [m.pid, m.title]));
  const awards = await C.all('SELECT * FROM week_awards WHERE room_id = ? AND week = ? ORDER BY award_key', room.id, wk);
  const grouped = {};
  for (const a of awards) (grouped[a.award_key] = grouped[a.award_key] || { key: a.award_key, value: a.value, pids: [] }).pids.push(a.participant_id);
  const results = await C.all('SELECT * FROM week_results WHERE room_id = ? AND week = ? ORDER BY rank_money', room.id, wk);
  const reactions = await C.all('SELECT to_participant, emoji, COUNT(*) AS n FROM reactions WHERE room_id = ? AND week = ? GROUP BY to_participant, emoji', room.id, wk);
  const mine = await C.all('SELECT to_participant, emoji FROM reactions WHERE room_id = ? AND week = ? AND from_id = ?', room.id, wk, me.id);
  const turns = await C.all(`SELECT t.participant_id, t.turn, t.decisions_json, t.auto, t.cash_before, t.cash_after FROM turns t WHERE t.room_id = ? AND t.week = ? ORDER BY t.turn`, room.id, wk);
  const ach = await C.all('SELECT player_id, key FROM achievements WHERE room_id = ? AND week = ?', room.id, wk);
  const nameOf = pid => { const m = members.find(x => x.pid === pid); return m ? (parse(m.character_json, {}).name || m.display_name) : '?'; };
  return {
    room: { id: room.id, name: room.name, weeks: room.config.weeks, status: room.status, statsVisibility: room.config.statsVisibility }, week: wk, finalizedAt: w.finalized_at, highlights: parse(w.highlights_json, []),
    awards: Object.values(grouped).sort((a, b) => Rules.AWARD_KEYS.indexOf(a.key) - Rules.AWARD_KEYS.indexOf(b.key)).map(g => ({ ...g, name: g.pids.length === 1 ? Rules.awardName(g.key, room.config, titles[g.pids[0]]) : Rules.awardName(g.key, room.config, null), names: g.pids.map(nameOf) })),
    standings: results.map(r => { const m = members.find(x => x.pid === r.participant_id) || {}; return shapeRow({ pid: r.participant_id, playerId: m.player_id, displayName: m.display_name, characterName: nameOf(r.participant_id), avatar: parse(m.character_json, {}).av, m: parse(r.metrics_json) }, room, me.id,
      { ranks: parse(r.ranks_json), deltas: parse(r.deltas_json), reactions: reactions.filter(x => x.to_participant === r.participant_id).map(x => ({ emoji: x.emoji, n: x.n })), myReactions: mine.filter(x => x.to_participant === r.participant_id).map(x => x.emoji),
        moves: room.config.statsVisibility === 'full' || m.player_id === me.id ? turns.filter(t => t.participant_id === r.participant_id).map(t => ({ turn: t.turn, auto: !!t.auto, picks: (parse(t.decisions_json, {}).picks || []), cashChange: t.cash_after - t.cash_before })) : null,
        achievements: ach.filter(a => a.player_id === m.player_id).map(a => a.key) }); }),
    next: room.status === 'active' ? { week: room.current_week, deadline: room.week_deadline_at } : null, emoji: EMOJI
  };
});

route('POST', '/rooms/:id/react', async ({ C, me, params, body }) => {
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me);
  if (!EMOJI.includes(body.emoji)) throw bad('Pick one of the reactions.');
  const target = await C.one('SELECT id FROM participants WHERE id = ? AND room_id = ?', String(body.participantId || ''), room.id);
  const w = await C.one(`SELECT 1 AS ok FROM weeks WHERE room_id = ? AND week = ? AND status = 'final'`, room.id, Number(body.week));
  if (!target || !w) throw bad('You can react to official results only.');
  if (body.remove) await C.run('DELETE FROM reactions WHERE room_id = ? AND week = ? AND from_id = ? AND to_participant = ?', room.id, Number(body.week), me.id, target.id);
  else await C.run('INSERT INTO reactions (room_id, week, from_id, to_participant, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (room_id, week, from_id, to_participant) DO UPDATE SET emoji = excluded.emoji', room.id, Number(body.week), me.id, target.id, body.emoji, C.now());
  return { ok: true };
}, { limit: ['write', 60, 60] });

// my own financial journey and turn history in a room
route('GET', '/rooms/:id/history', async ({ C, me, params }) => {
  const room = await loadRoom(C, params.id);
  const pa = await requireMember(C, room, me);
  const results = await C.all('SELECT week, rank_money, eligible_cash, net_worth, life_balance, metrics_json, cum_json FROM week_results WHERE participant_id = ? ORDER BY week', pa.id);
  const ledger = await C.all('SELECT week, turn, category, label, amount, currency, original_amount FROM ledger WHERE participant_id = ? ORDER BY id DESC LIMIT 300', pa.id);
  const turns = await C.all('SELECT week, turn, auto, decisions_json, cash_before, cash_after, stats_json, game_week, created_at FROM turns WHERE participant_id = ? ORDER BY week, turn', pa.id);
  const ops = await C.all('SELECT op_id, status, reason, received_at FROM sync_ops WHERE player_id = ? AND room_id = ? ORDER BY received_at DESC LIMIT 50', me.id, room.id);
  return { results: results.map(r => ({ week: r.week, rank: r.rank_money, eligibleCash: r.eligible_cash, netWorth: r.net_worth, lifeBalance: r.life_balance, m: parse(r.metrics_json), cum: parse(r.cum_json) })),
    ledger, turns: turns.map(t => ({ ...t, decisions: parse(t.decisions_json), stats: parse(t.stats_json) })), ops };
});

route('POST', '/rooms/:id/rematch', async ({ C, me, params }) => {
  const room = await loadRoom(C, params.id);
  await requireMember(C, room, me);
  if (room.status !== 'complete') throw conflict('Rematches open when the challenge is complete.', 'not_complete');
  const cfg = { ...room.config, name: Rules.cleanText(('Rematch: ' + room.name), 40), startAt: null };
  const v = Rules.validateConfig(cfg, { now: C.now() });
  const id = 'r_' + randomHex(10), now = C.now(), stmts = [];
  stmts.push(C.q('INSERT INTO rooms (id, code, name, description, host_id, visibility, rules_version, config_json, created_at, rematch_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, randomCode(8), v.config.name, v.config.description, me.id, v.config.visibility, Rules.CURRENT, JSON.stringify(v.config), now, room.id));
  stmts.push(C.q(`INSERT INTO participants (id, room_id, player_id, status, joined_at) VALUES (?, ?, ?, 'joined', ?)`, 'pa_' + randomHex(10), id, me.id, now));
  const others = await C.all(`SELECT player_id FROM participants WHERE room_id = ? AND status IN ('joined', 'left') AND player_id != ?`, room.id, me.id);
  for (const o of others) {
    stmts.push(C.q(`INSERT INTO invitations (id, room_id, from_id, to_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`, 'i_' + randomHex(10), id, me.id, o.player_id, now));
    stmts.push(notify(C, `${id}:invite:${o.player_id}`, o.player_id, 'invitation', id, { room: v.config.name, from: me.display_name }));
  }
  stmts.push(audit(C, me.id, id, 'rematch', { of: room.id }));
  await C.batch(stmts);
  return { roomId: id };
}, { limit: ['create', 10, 3600] });

/* ---------- profiles, achievements, global boards ---------- */
async function profileOf(C, p, viewer, self) {
  const shared = !self && viewer ? await C.one(`SELECT COUNT(*) AS n FROM participants a JOIN participants b ON a.room_id = b.room_id WHERE a.player_id = ? AND b.player_id = ? AND a.status IN ('joined','left') AND b.status IN ('joined','left')`, p.id, viewer.id) : { n: 0 };
  const canSee = self || p.privacy === 'public' || (p.privacy === 'members' && shared.n > 0);
  const out = { ...publicPlayer(p), joinedAt: p.created_at, privacy: self ? p.privacy : undefined, friendCode: self ? p.friend_code : undefined, restricted: !canSee };
  if (!canSee) return out;
  const rooms = await C.all(`SELECT r.id, r.name, r.status, r.current_week, r.completed_at, pa.id AS pid, pa.character_json FROM participants pa JOIN rooms r ON r.id = pa.room_id WHERE pa.player_id = ? AND pa.status IN ('joined', 'left') AND r.status IN ('active', 'complete') ORDER BY r.created_at DESC LIMIT 50`, p.id);
  const awards = await C.all(`SELECT wa.award_key, COUNT(*) AS n FROM week_awards wa JOIN participants pa ON pa.id = wa.participant_id WHERE pa.player_id = ? GROUP BY wa.award_key`, p.id);
  const best = await C.one(`SELECT MAX(wr.eligible_cash) AS cash, MAX(wr.life_balance) AS life, MAX(wr.net_worth) AS nw, COUNT(*) AS weeks FROM week_results wr JOIN participants pa ON pa.id = wr.participant_id WHERE pa.player_id = ?`, p.id);
  const ach = await C.all('SELECT key, room_id, week, created_at FROM achievements WHERE player_id = ? ORDER BY created_at', p.id);
  const journey = await C.all(`SELECT wr.room_id, wr.week, wr.eligible_cash, wr.life_balance, wr.rank_money FROM week_results wr JOIN participants pa ON pa.id = wr.participant_id WHERE pa.player_id = ? ORDER BY wr.created_at LIMIT 200`, p.id);
  const ch = rooms.length ? parse(rooms[0].character_json, null) : null;
  return { ...out, character: ch ? { name: ch.name, region: ch.region, trait: ch.trait } : null, competitions: rooms.length,
    rooms: rooms.map(r => ({ id: r.id, name: r.name, status: r.status, week: r.current_week })),
    moneyWins: (awards.find(a => a.award_key === 'money') || {}).n || 0, categoryWins: awards.filter(a => a.award_key !== 'money').reduce((a, x) => a + x.n, 0), awards: Object.fromEntries(awards.map(a => [a.award_key, a.n])),
    records: { bestCash: best.cash, bestLifeBalance: best.life, bestNetWorth: best.nw, weeksPlayed: best.weeks }, achievements: ach, journey };
}
route('GET', '/players/:id', async ({ C, me, params }) => {
  const p = await C.one('SELECT * FROM players WHERE id = ?', params.id);
  if (!p) throw notFound('No such player.');
  return { player: await profileOf(C, p, me, p.id === me.id) };
});
route('GET', '/achievements', async ({ C, me }) => ({ defs: Rules.ACHIEVEMENTS, mine: await C.all('SELECT key, room_id, week, created_at FROM achievements WHERE player_id = ?', me.id) }));
route('GET', '/leaderboard', async ({ C, me }) => {
  const rows = await C.all(`SELECT p.id, p.display_name, p.avatar_json, p.title,
      (SELECT COUNT(*) FROM week_awards wa JOIN participants pa ON pa.id = wa.participant_id WHERE pa.player_id = p.id AND wa.award_key = 'money') AS money_wins,
      (SELECT COUNT(*) FROM week_awards wa JOIN participants pa ON pa.id = wa.participant_id WHERE pa.player_id = p.id) AS all_wins,
      (SELECT MAX(wr.eligible_cash) FROM week_results wr JOIN participants pa ON pa.id = wr.participant_id WHERE pa.player_id = p.id) AS best_cash,
      (SELECT COUNT(*) FROM achievements a WHERE a.player_id = p.id) AS badges
    FROM players p WHERE p.privacy = 'public' OR p.id = ? ORDER BY money_wins DESC, best_cash DESC LIMIT 50`, me.id);
  const list = rows.filter(r => r.best_cash !== null).map(r => ({ pid: r.id, ...publicPlayer(r), moneyWins: r.money_wins, allWins: r.all_wins, bestCash: r.best_cash, badges: r.badges, isMe: r.id === me.id }));
  const ranks = Rules.rank(list, [r => r.moneyWins, r => r.bestCash, r => r.allWins]);
  return { rows: list.map(r => ({ ...r, rank: ranks[r.pid] })).sort((a, b) => a.rank - b.rank) };
});
// head-to-head record against another player across every challenge you both finished weeks in
route('GET', '/rivals/:id', async ({ C, me, params }) => {
  const other = await C.one('SELECT * FROM players WHERE id = ?', params.id);
  if (!other) throw notFound('No such player.');
  const rows = await C.all(`SELECT a.room_id, a.week, a.rank_money AS my_rank, b.rank_money AS their_rank, a.eligible_cash AS my_cash, b.eligible_cash AS their_cash, a.metrics_json AS my_m, b.metrics_json AS their_m, r.name AS room_name, r.config_json
    FROM week_results a JOIN participants pa ON pa.id = a.participant_id JOIN week_results b ON b.room_id = a.room_id AND b.week = a.week JOIN participants pb ON pb.id = b.participant_id JOIN rooms r ON r.id = a.room_id
    WHERE pa.player_id = ? AND pb.player_id = ? ORDER BY a.room_id, a.week`, me.id, other.id);
  const cat = {}; let wins = 0, losses = 0, ties = 0;
  for (const r of rows) {
    if (r.my_rank < r.their_rank) wins++; else if (r.my_rank > r.their_rank) losses++; else ties++;
    const full = parse(r.config_json, {}).statsVisibility === 'full', a = parse(r.my_m), b = parse(r.their_m);
    if (full) for (const k of Rules.STAT_KEYS) { cat[k] = cat[k] || { me: 0, them: 0 }; if (a[k] > b[k]) cat[k].me++; else if (a[k] < b[k]) cat[k].them++; }
  }
  return { rival: publicPlayer(other), weeks: rows.length, wins, losses, ties, cashDiff: rows.reduce((x, r) => x + r.my_cash - r.their_cash, 0), categories: cat,
    rooms: [...new Set(rows.map(r => r.room_name))] };
});

route('GET', '/notifications', async ({ C, me }) => ({ notifications: (await C.all('SELECT * FROM notifications WHERE player_id = ? ORDER BY created_at DESC LIMIT 40', me.id)).map(n => ({ id: n.id, kind: n.kind, roomId: n.room_id, payload: parse(n.payload_json, {}), read: !!n.read, at: n.created_at })) }));
route('POST', '/notifications/read', async ({ C, me }) => { await C.run('UPDATE notifications SET read = 1 WHERE player_id = ? AND read = 0', me.id); return { ok: true }; });

route('POST', '/report', async ({ C, me, body }) => {
  if (!['player', 'room'].includes(body.kind)) throw bad('Report a player or a challenge.');
  const reason = Rules.cleanText(body.reason || '', 300);
  if (reason.length < 3) throw bad('Say briefly what is wrong.');
  await C.batch([C.q('INSERT OR IGNORE INTO reports (id, reporter_id, kind, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'rp_' + randomHex(10), me.id, body.kind, String(body.targetId || '').slice(0, 40), reason, C.now()),
    audit(C, me.id, body.kind === 'room' ? String(body.targetId || '') : null, 'report', { kind: body.kind, target: String(body.targetId || '').slice(0, 40) })]);
  return { ok: true };
}, { limit: ['report', 10, 3600] });

module.exports = { handle, advance, finalizeWeek, ledgerLines, ApiError };
