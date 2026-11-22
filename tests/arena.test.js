// Challenge Arena tests: rules, rooms, permissions, server-replayed turns, offline sync, weekly finalisation,
// anti-cheat and a four-player, multi-week simulation. Every test uses its own in-memory database.
// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, device, decide, CHARS, STRATS, HOUR, Turn, Rules } = require('./arena-helpers.js');

/* ---------- rules and the score engine ---------- */
test('ranking shares places on exact ties and never uses join order', () => {
  const rows = [{ pid: 'b', v: 10 }, { pid: 'a', v: 30 }, { pid: 'c', v: 30 }, { pid: 'd', v: 5 }];
  const r = Rules.rank(rows, [x => x.v]);
  assert.deepEqual(r, { a: 1, c: 1, b: 3, d: 4 });
});

test('life balance follows the documented weights and caps', () => {
  const R = Rules.RULES['arena-1'];
  const base = { money: 200000, usd: 0, energy: 50, mood: 50, health: 50, family: 50, community: 50, clout: 0, debt: 0, week: 5, region: 'lagos', skills: {}, phase: 'plan' };
  const m = Rules.metrics(base, R);
  const money = Math.round(100 * Math.log10(200000 / 10000) / Math.log10(20000000 / 10000) * 10) / 10;
  assert.equal(m.scores.money, money);
  assert.equal(m.lifeBalance, Math.round((0.25 * money + 0.125 * 50 * 5 + 0) * 10) / 10);
  const rich = Rules.metrics({ ...base, money: 9e9, clout: 1e7 }, R);
  assert.equal(rich.scores.money, 100); assert.equal(rich.scores.clout, 100);
});

test('borrowed money never counts as earned cash', () => {
  const R = Rules.RULES['arena-1'];
  const s = { money: 500000, usd: 0, energy: 50, mood: 50, health: 50, family: 50, community: 50, clout: 0, debt: 300000, week: 3, region: 'kano', skills: {}, phase: 'plan',
    build: { branches: 1, loan: 10000, loanWeeks: 10, supplier: 0, house: 0 } };
  const m = Rules.metrics(s, R);
  assert.equal(m.liabilities, 300000 + 100000);
  assert.equal(m.eligibleCash, 500000 - 400000);
  assert.ok(m.netWorth < m.cashNgn);
});

test('awards go to every tied player, comeback needs a climb, improvement needs a gain', () => {
  const R = Rules.RULES['arena-1'];
  const st = (money, mood) => ({ money, usd: 0, energy: 50, mood, health: 50, family: 50, community: 50, clout: 0, debt: 0, week: 9, region: 'lagos', skills: {}, phase: 'plan' });
  const prev = (rank, money, mood) => ({ m: Rules.metrics(st(money, mood), R), cum: null, ranks: { money: rank } });
  const out = Rules.computeWeek([
    { pid: 'a', state: st(400000, 70), prev: prev(3, 100000, 50) },
    { pid: 'b', state: st(400000, 70), prev: prev(1, 500000, 70) },
    { pid: 'c', state: st(100000, 40), prev: prev(2, 300000, 60) }
  ], R, 2);
  const money = out.awards.find(a => a.key === 'money');
  assert.deepEqual(money.pids, ['a', 'b']);
  assert.equal(out.results.a.ranks.money, 1); assert.equal(out.results.b.ranks.money, 1); assert.equal(out.results.c.ranks.money, 3);
  assert.deepEqual(out.awards.find(a => a.key === 'comeback').pids, ['a']);
  assert.deepEqual(out.awards.find(a => a.key === 'improved').pids, ['a']);
  // week 1 never has a comeback award
  assert.ok(!Rules.computeWeek([{ pid: 'a', state: st(1, 1), prev: null }], R, 1).awards.some(a => a.key === 'comeback'));
});

test('bounded stats carry their current value forward and lifetime gains are tracked separately', () => {
  const R = Rules.RULES['arena-1'];
  const st = e => ({ money: 1, usd: 0, energy: e, mood: 50, health: 50, family: 50, community: 50, clout: 0, debt: 0, week: 1, region: 'lagos', skills: {}, phase: 'plan' });
  let prev = { m: Rules.metrics(st(60), R), cum: null, opening: true };
  const weeks = [[65], [62]];
  let res;
  for (let w = 0; w < weeks.length; w++) {
    res = Rules.computeWeek([{ pid: 'a', state: st(weeks[w][0]), prev, statTrail: [] }], R, w + 1).results.a;
    prev = { m: res.m, cum: res.cum, ranks: res.ranks };
  }
  assert.equal(res.m.strength, 62, 'current Strength is 62, not a running total');
  assert.equal(res.cum.gains.strength, 5); assert.equal(res.cum.losses.strength, 3); assert.equal(res.cum.highs.strength, 65);
  assert.equal(Rules.average(res.cum, 'strength'), 63.5);
});

test('room settings are validated and text is cleaned', () => {
  const v = Rules.validateConfig({ name: '  <b>Lagos</b>  Ballers ', maxPlayers: 12, weeks: 5 });
  assert.equal(v.ok, false);
  assert.equal(v.config.name, 'bLagos/b Ballers');
  assert.ok(v.errors.some(e => /2–8/.test(e))); assert.ok(v.errors.some(e => /weeks/.test(e)));
  const ok = Rules.validateConfig({ name: 'Ajo Gang', awardNames: { money: 'Odogwu of the Week', bogus: 'x' } });
  assert.equal(ok.ok, true); assert.deepEqual(ok.config.awardNames, { money: 'Odogwu of the Week' });
  assert.equal(ok.config.maxPlayers, 6); assert.equal(ok.config.roundHours, 168);
});

test('the same seed and decisions always give the same turn, and different seeds can differ', () => {
  const A = device();
  const s0 = A.initState(CHARS[1], { startMoney: 200000, difficulty: 'normal' }, Rules.RULES['arena-1'], 'aa');
  let s = s0;
  for (let t = 0; t < 30; t++) {
    const { dec, result } = decide(A, s, 'seed-' + t, STRATS.Chidi);
    const again = A.play(s, 'seed-' + t, dec);
    assert.equal(Turn.stateHash(again.state), Turn.stateHash(result.state));
    s = result.state;
  }
  assert.ok(s.week > 25);
});

test('a forged or impossible decision is rejected by the engine', () => {
  const A = device();
  const s = A.initState(CHARS[0], { startMoney: 200000, difficulty: 'normal' }, Rules.RULES['arena-1'], 'bb');
  assert.equal(A.play(s, 'x', { picks: ['not_a_card'] }).status, 'invalid');
  assert.equal(A.play(s, 'x', { picks: ['rest', 'rest'] }).status, 'invalid');
  const notInHand = Object.keys(A.view(s, S => S)).length && ['b_branch'];
  assert.equal(A.play(s, 'x', { picks: notInHand }).status, 'invalid');
  // a device cannot add money by putting numbers in its decisions
  const honest = decide(A, s, 'x', STRATS.Amaka);
  const sneaky = A.play(s, 'x', { ...honest.dec, money: 99999999, state: { money: 1e9 } });
  assert.equal(sneaky.state.money, honest.result.state.money);
});

/* ---------- rooms, invitations and permissions ---------- */
async function setupRoom(W, n = 4, cfg = {}) {
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(await W.player(['Ada', 'Bayo', 'Chi', 'Dayo', 'Efe', 'Femi'][i]));
  const host = ps[0];
  const cr = await host.call('POST', '/rooms', { name: 'Friday Hustle', turnsPerWeek: 3, weeks: 4, roundHours: 24, graceMinutes: 30, ...cfg });
  assert.equal(cr.status, 200, cr.message);
  const room = cr.room;
  for (const p of ps.slice(1)) { const j = await p.call('POST', '/rooms/join', { code: room.code }); assert.equal(j.status, 200, j.message); }
  for (let i = 0; i < n; i++) {
    const c = await ps[i].call('POST', `/rooms/${room.id}/character`, CHARS[i % 4]); assert.equal(c.status, 200, c.message);
    const r = await ps[i].call('POST', `/rooms/${room.id}/ready`, { ready: true }); assert.equal(r.status, 200, r.message);
  }
  const st = await host.call('POST', `/rooms/${room.id}/start`); assert.equal(st.status, 200, st.message);
  return { ps, host, room };
}

test('creating, joining and starting a challenge, with host-only controls', async () => {
  const W = world();
  const a = await W.player('Ada'), b = await W.player('Bayo'), c = await W.player('Chi');
  const cr = await a.call('POST', '/rooms', { name: 'Ajo Gang', maxPlayers: 2, turnsPerWeek: 2 });
  assert.equal(cr.status, 200); assert.equal(cr.room.isHost, true); assert.match(cr.room.code, /^[A-Z2-9]{8}$/);
  const id = cr.room.id;
  assert.equal((await a.call('POST', `/rooms/${id}/character`, CHARS[0])).status, 200);
  assert.equal((await a.call('POST', `/rooms/${id}/ready`, { ready: true })).status, 200);
  assert.equal((await a.call('POST', `/rooms/${id}/start`)).error, 'not_enough_players', 'one player cannot start');
  assert.equal((await b.call('GET', `/rooms/${id}`)).status, 403, 'non-members cannot read a room');
  assert.equal((await b.call('POST', '/rooms/join', { code: 'WRONGCOD' })).status, 404);
  assert.equal((await b.call('POST', '/rooms/join', { code: cr.room.code })).status, 200);
  assert.equal((await c.call('POST', '/rooms/join', { code: cr.room.code })).error, 'full', 'capacity is enforced');
  assert.equal((await b.call('POST', `/rooms/${id}/start`)).status, 403, 'only the host starts');
  assert.equal((await b.call('POST', `/rooms/${id}/cancel`)).status, 403);
  assert.equal((await a.call('POST', `/rooms/${id}/start`)).error, 'not_ready');
  assert.equal((await b.call('POST', `/rooms/${id}/ready`, { ready: true })).status, 400, 'needs a character first');
  await b.call('POST', `/rooms/${id}/character`, CHARS[1]);
  await b.call('POST', `/rooms/${id}/ready`, { ready: true });
  const st = await a.call('POST', `/rooms/${id}/start`);
  assert.equal(st.status, 200); assert.equal(st.room.status, 'active'); assert.equal(st.room.week, 1);
  assert.equal((await c.call('POST', '/rooms/join', { code: cr.room.code })).error, 'not_lobby', 'nobody joins after the start');
  // both players start with the same money and stats
  const pa = await a.call('GET', `/rooms/${id}/play`), pb = await b.call('GET', `/rooms/${id}/play`);
  assert.equal(pa.state.money, pb.state.money); assert.equal(pa.state.energy, pb.state.energy);
  assert.equal(pa.tickets.length, 2);
});

test('approval rooms hold joiners until the host approves; removed players cannot rejoin', async () => {
  const W = world();
  const a = await W.player('Ada'), b = await W.player('Bayo'), c = await W.player('Chi');
  const { room } = await a.call('POST', '/rooms', { name: 'Closed Circle', approval: true });
  const j = await b.call('POST', '/rooms/join', { code: room.code });
  assert.equal(j.status, 200); assert.equal(j.status === 200 && j.room.participants.find(p => p.isMe).status, 'pending');
  assert.equal((await b.call('POST', `/rooms/${room.id}/character`, CHARS[1])).status, 403, 'pending players cannot act');
  const host = await a.call('GET', `/rooms/${room.id}`);
  const req = host.room.participants.find(p => p.status === 'pending');
  assert.equal((await c.call('POST', `/rooms/${room.id}/approve`, { participantId: req.id, accept: true })).status, 403);
  assert.equal((await a.call('POST', `/rooms/${room.id}/approve`, { participantId: req.id, accept: true })).status, 200);
  assert.equal((await b.call('POST', `/rooms/${room.id}/character`, CHARS[1])).status, 200);
  assert.equal((await a.call('POST', `/rooms/${room.id}/remove`, { participantId: req.id })).status, 200);
  assert.equal((await b.call('POST', '/rooms/join', { code: room.code })).status, 403);
  // a direct invitation from a friend counts as approval
  const fc = (await c.call('GET', '/friends')).friendCode;
  await a.call('POST', '/friends', { code: fc });
  await c.call('POST', `/friends/${a.id}`, { action: 'accept' });
  assert.equal((await a.call('POST', `/rooms/${room.id}/invite`, { playerIds: [c.id] })).invited, 1);
  const inv = (await c.call('GET', '/invitations')).invitations[0];
  assert.ok(inv);
  assert.equal((await c.call('POST', `/invitations/${inv.id}`, { accept: true })).roomId, room.id);
});

test('writes need the Arena header and a valid session', async () => {
  const W = world();
  const a = await W.player('Ada');
  assert.equal((await W.call('GET', '/home')).status, 401);
  assert.equal((await W.call('GET', '/home', null, 'f'.repeat(64))).status, 401);
  assert.equal((await a.call('POST', '/rooms', { name: 'No Header' }, { 'x-arena': '0' })).status, 403);
  const rec = await W.call('POST', '/auth/recover', { code: a.recovery }, null, { 'cf-connecting-ip': 'z' });
  assert.equal(rec.playerId, a.id);
  assert.equal((await a.call('GET', '/home')).status, 401, 'recovering on a new device signs the old one out');
  assert.equal((await W.call('GET', '/home', null, rec.token)).status, 200);
});

/* ---------- playing, syncing and anti-cheat ---------- */
async function playTurn(p, roomId, A, prefs, { opId, tamper } = {}) {
  const play = await p.call('GET', `/rooms/${roomId}/play`);
  const t = play.tickets[0];
  const { dec, result } = decide(A, play.state, t.seed, prefs);
  const op = { opId: opId || `op_${p.id}_${t.week}_${t.turn}_${Math.random().toString(36).slice(2, 8)}`, kind: 'turn', roomId, week: t.week, turn: t.turn, baseVersion: play.stateVersion, decisions: dec, clientHash: Turn.stateHash(result.state), ...(tamper || {}) };
  const res = await p.call('POST', '/sync', { ops: [op] });
  return { op, res: res.results[0], local: result.state, before: play.state };
}

test('turns are replayed by the server; retries, replays and stale turns cannot pay twice', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 2);
  const A = device();
  const one = await playTurn(ps[0], room.id, A, STRATS.Amaka);
  assert.equal(one.res.status, 'accepted'); assert.equal(one.res.match, true);
  const after1 = (await ps[0].call('GET', `/rooms/${room.id}/play`)).state;
  assert.equal(after1.money, one.local.money);
  // the same op again (a retry after a lost response) is a duplicate, not a second turn
  const again = await ps[0].call('POST', '/sync', { ops: [one.op] });
  assert.equal(again.results[0].duplicate, true);
  // the same decisions with a new op id: the turn is already taken
  const replay = await ps[0].call('POST', '/sync', { ops: [{ ...one.op, opId: one.op.opId + 'x' }] });
  assert.equal(replay.results[0].reason, 'turn_taken');
  const after2 = await ps[0].call('GET', `/rooms/${room.id}/play`);
  assert.equal(after2.state.money, after1.money); assert.equal(after2.turnsUsed, 1);
  // a turn from the future is out of order
  const fut = await ps[0].call('POST', '/sync', { ops: [{ ...one.op, opId: 'future_op_1', turn: 3, baseVersion: after2.stateVersion }] });
  assert.equal(fut.results[0].reason, 'out_of_order');
  // someone else's room, or another player's op id
  const other = await ps[1].call('POST', '/sync', { ops: [one.op] });
  assert.equal(other.results[0].status, 'rejected');
  // claimed numbers in the op are ignored: only decisions matter
  const cheat = await playTurn(ps[1], room.id, device(), STRATS.Chidi, { tamper: { money: 1e12, state: { money: 1e12 }, clientHash: 'deadbeef' } });
  assert.equal(cheat.res.status, 'accepted'); assert.equal(cheat.res.match, false, 'a wrong client hash makes the server send its own state');
  assert.ok(cheat.res.state.money < 1e9);
  const ledger = await W.DB.prepare('SELECT SUM(amount) AS s FROM ledger WHERE participant_id = ?').bind(cheat.res && (await ps[1].call('GET', `/rooms/${room.id}/play`)).participantId).first();
  assert.equal(ledger.s, Rules.metrics(cheat.res.state, Rules.RULES['arena-1']).cashNgn - Rules.metrics(cheat.before, Rules.RULES['arena-1']).cashNgn, 'ledger lines add up to the cash change');
});

test('a forged card is rejected and recorded, and never changes the state', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 2);
  const play = await ps[0].call('GET', `/rooms/${room.id}/play`);
  const t = play.tickets[0];
  const res = await ps[0].call('POST', '/sync', { ops: [{ opId: 'forged_card_1', kind: 'turn', roomId: room.id, week: 1, turn: 1, baseVersion: play.stateVersion, decisions: { picks: ['b_branch'] } }] });
  assert.equal(res.results[0].reason, 'invalid');
  const log = await W.DB.prepare(`SELECT status, reason FROM sync_ops WHERE op_id = 'forged_card_1'`).first();
  assert.deepEqual(log, { status: 'rejected', reason: 'invalid' });
  assert.equal((await ps[0].call('GET', `/rooms/${room.id}/play`)).stateVersion, play.stateVersion);
  assert.ok(t.seed.length === 64);
});

test('offline play: a whole week queued on the device syncs in order when the connection returns', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 2);
  const A = device();
  const play = await ps[0].call('GET', `/rooms/${room.id}/play`);
  assert.equal(play.tickets.length, 3);
  // offline: the device plays all three turns from its tickets, each on top of the last
  let s = play.state, v = play.stateVersion; const ops = [];
  for (const t of play.tickets) {
    const { dec, result } = decide(A, s, t.seed, STRATS.Tunde);
    ops.push({ opId: `off_${t.turn}_abcdef`, kind: 'turn', roomId: room.id, week: t.week, turn: t.turn, baseVersion: v, decisions: dec, clientHash: Turn.stateHash(result.state) });
    s = result.state; v++;
  }
  // back online: the queue is sent; the first attempt "loses" its response, so the device sends everything again
  await ps[0].call('POST', '/sync', { ops });
  const res = await ps[0].call('POST', '/sync', { ops });
  assert.deepEqual(res.results.map(r => r.status), ['accepted', 'accepted', 'accepted']);
  assert.ok(res.results.every(r => r.duplicate && r.match !== false));
  const server = await ps[0].call('GET', `/rooms/${room.id}/play`);
  assert.equal(Turn.stateHash(server.state), Turn.stateHash(s));
  assert.equal(server.turnsUsed, 3); assert.equal(server.tickets.length, 0, 'next week\'s seeds are not released early');
});

test('the deadline is the server\'s: late decisions are rejected and autopilot fills missed turns', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 2, { graceMinutes: 30 });
  const A = device();
  await playTurn(ps[0], room.id, A, STRATS.Chidi);
  const play = await ps[1].call('GET', `/rooms/${room.id}/play`);
  const t = play.tickets[0];
  const { dec, result } = decide(A, play.state, t.seed, STRATS.Zara);
  // made "offline" before the deadline, but it reaches the server after the cutoff
  W.advance(24 * HOUR + 31 * 60000);
  const late = await ps[1].call('POST', '/sync', { ops: [{ opId: 'late_op_123', kind: 'turn', roomId: room.id, week: 1, turn: 1, baseVersion: play.stateVersion, decisions: dec, clientHash: Turn.stateHash(result.state), clientTime: Date.UTC(2020, 0, 1) }] });
  assert.equal(late.results[0].reason, 'week_closed');
  const r = await ps[0].call('GET', `/rooms/${room.id}`);
  assert.equal(r.room.week, 2);
  const auto = await W.DB.prepare('SELECT COUNT(*) AS n FROM turns WHERE room_id = ? AND week = 1 AND auto = 1').bind(room.id).first();
  assert.equal(auto.n, 2 + 3, 'player 1 missed 2 turns, player 2 missed all 3');
  const final = await ps[0].call('GET', `/rooms/${room.id}/board?week=1`);
  assert.equal(final.official, true); assert.equal(final.rows.length, 2);
});

test('weekly finalisation runs once, even when many requests race for it', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 3, { earlyFinish: false });
  W.advance(25 * HOUR);
  const { advance, finalizeWeek } = require('../arena/server/app.js');
  // simulate several requests arriving together after the deadline
  const hits = await Promise.all([ps[0].call('GET', `/rooms/${room.id}`), ps[1].call('GET', `/rooms/${room.id}/version`), ps[2].call('GET', `/rooms/${room.id}/board`), ps[0].call('GET', '/home')]);
  assert.ok(hits.every(h => h.status === 200));
  const C = { DB: W.DB };
  const count = async sql => (await W.DB.prepare(sql).bind(room.id).first()).n;
  const before = { results: await count('SELECT COUNT(*) AS n FROM week_results WHERE room_id = ?'), awards: await count('SELECT COUNT(*) AS n FROM week_awards WHERE room_id = ?'), notes: await count('SELECT COUNT(*) AS n FROM notifications WHERE room_id = ?') };
  assert.equal(before.results, 3);
  // a stray retry of the same week's finaliser changes nothing
  const ctx = { DB: W.DB, secret: W.env.ARENA_SECRET, now: W.env.now, q: (s, ...a) => W.DB.prepare(s).bind(...a), one: (s, ...a) => W.DB.prepare(s).bind(...a).first(), all: async (s, ...a) => (await W.DB.prepare(s).bind(...a).all()).results, run: (s, ...a) => W.DB.prepare(s).bind(...a).run(), batch: x => W.DB.batch(x) };
  const roomRow = await W.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(room.id).first();
  roomRow.config = JSON.parse(roomRow.config_json); roomRow.current_week = 1;
  await finalizeWeek(ctx, roomRow);
  await advance(ctx, room.id);
  assert.equal(await count('SELECT COUNT(*) AS n FROM week_results WHERE room_id = ?'), before.results);
  assert.equal(await count('SELECT COUNT(*) AS n FROM week_awards WHERE room_id = ?'), before.awards);
  assert.equal(await count('SELECT COUNT(*) AS n FROM notifications WHERE room_id = ?'), before.notes);
  assert.equal((await W.DB.prepare('SELECT current_week FROM rooms WHERE id = ?').bind(room.id).first()).current_week, 2);
  assert.ok(C);
});

test('privacy: summary rooms hide other players\' life stats; private profiles stay private', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 2, { statsVisibility: 'summary' });
  const b = await ps[0].call('GET', `/rooms/${room.id}/board`);
  const mine = b.rows.find(r => r.isMe), theirs = b.rows.find(r => !r.isMe);
  assert.ok(mine.stats && mine.lifeBalance !== null);
  assert.equal(theirs.stats, null); assert.equal(theirs.lifeBalance, null); assert.ok(theirs.eligibleCash > 0, 'money is always visible');
  await ps[1].call('PATCH', '/me', { privacy: 'private' });
  const stranger = await W.player('Stranger');
  const prof = await stranger.call('GET', `/players/${ps[1].id}`);
  assert.equal(prof.player.restricted, true); assert.equal(prof.player.records, undefined);
  const outsider = await stranger.call('GET', `/rooms/${room.id}/board`);
  assert.equal(outsider.status, 403, 'no cross-room reading');
});

/* ---------- the four-player season ---------- */
test('four players, four weeks: carry-forward, ledgers, awards, achievements, a missed week and a final table', async () => {
  const W = world();
  const { ps, room } = await setupRoom(W, 4, { weeks: 4, turnsPerWeek: 3, earlyFinish: true });
  const R = Rules.RULES['arena-1'];
  const devices = ps.map(() => device());
  const closing = {};
  for (let week = 1; week <= 4; week++) {
    for (let i = 0; i < 4; i++) {
      const p = ps[i], name = CHARS[i].name;
      if (week === 2 && name === 'Zara') continue; // Zara loses her connection for the whole of week 2
      const play = await p.call('GET', `/rooms/${room.id}/play`);
      assert.equal(play.week, week);
      if (week > 1 && closing[p.id]) assert.equal(play.state.money, closing[p.id], `${name}: week ${week} opens on last week's closing cash`);
      let s = play.state, v = play.stateVersion; const ops = [];
      for (const t of play.tickets) {
        const { dec, result } = decide(devices[i], s, t.seed, STRATS[name]);
        ops.push({ opId: `sim_${i}_${week}_${t.turn}_xyz`, kind: 'turn', roomId: room.id, week, turn: t.turn, baseVersion: v, decisions: dec, clientHash: Turn.stateHash(result.state) });
        s = result.state; v++;
      }
      const res = await p.call('POST', '/sync', { ops });
      for (const r of res.results) assert.equal(r.status, 'accepted', `${name} week ${week}: ${r.message}`);
    }
    if (week === 2) { W.advance(25 * HOUR); await ps[0].call('GET', `/rooms/${room.id}`); }
    const r = await ps[0].call('GET', `/rooms/${room.id}`);
    assert.equal(r.room.status, week < 4 ? 'active' : 'complete');
    const wk = await ps[0].call('GET', `/rooms/${room.id}/weeks/${week}`);
    assert.equal(wk.status, 200, wk.message);
    assert.equal(wk.standings.length, 4);
    assert.ok(wk.awards.find(a => a.key === 'money'));
    assert.ok(wk.highlights.length >= 2);
    for (const st of wk.standings) {
      const play = await ps.find(p => p.id === st.playerId).call('GET', `/rooms/${room.id}/play`);
      closing[st.playerId] = play.state.money;
      // the official snapshot equals the measures of the stored state at the end of the week
      if (week < 4) assert.equal(st.eligibleCash, Rules.metrics(play.state, R).eligibleCash);
    }
  }
  // Zara reconnects after missing week 2: her progress is intact and autopilot covered her turns
  const zara = ps[3];
  const zh = await zara.call('GET', `/rooms/${room.id}/history`);
  assert.equal(zh.results.length, 4);
  assert.equal(zh.turns.filter(t => t.week === 2 && t.auto).length, 3);
  assert.ok(zh.turns.filter(t => t.week !== 2).every(t => !t.auto));
  // the ledger always explains the cash: sum of lines equals the cash movement over the season
  for (const p of ps) {
    const h = await p.call('GET', `/rooms/${room.id}/history`);
    const sum = h.ledger.reduce((a, l) => a + l.amount, 0);
    const first = h.turns[0], last = h.turns[h.turns.length - 1];
    assert.equal(sum, last.cash_after - first.cash_before, 'ledger reconciles');
    assert.equal(h.turns.length, 12);
  }
  // finalised weeks are frozen: nothing can be written to week 1 now
  const late = await ps[0].call('POST', '/sync', { ops: [{ opId: 'too_late_now', kind: 'turn', roomId: room.id, week: 1, turn: 1, baseVersion: 0, decisions: { picks: ['rest'] } }] });
  assert.equal(late.results[0].status, 'rejected');
  const lt = await ps[0].call('GET', `/rooms/${room.id}/board?week=lifetime`);
  assert.equal(lt.rows.length, 4); assert.ok(lt.rows.some(r => r.rank === 1));
  const totalMoneyWins = lt.rows.reduce((a, r) => a + r.wins.money, 0);
  assert.ok(totalMoneyWins >= 4, 'one money crown (or more, when tied) per week');
  const champ = lt.rows.find(r => r.rank === 1);
  const prof = await ps[0].call('GET', `/players/${champ.playerId}`);
  assert.ok(prof.player.achievements.length >= 1);
  const ach = await W.DB.prepare(`SELECT COUNT(*) AS n FROM achievements WHERE key = 'season_champion'`).first();
  assert.ok(ach.n >= 1);
  // rematch with the same friends
  const rm = await ps[1].call('POST', `/rooms/${room.id}/rematch`);
  assert.ok(rm.roomId);
  const inv = await ps[2].call('GET', '/invitations');
  assert.ok(inv.invitations.some(i => i.room_id === rm.roomId));
  // head-to-head
  const rv = await ps[0].call('GET', `/rivals/${ps[1].id}`);
  assert.equal(rv.weeks, 4); assert.equal(rv.wins + rv.losses + rv.ties, 4);
});

/* ---------- the single-player game is never touched ---------- */
test('Arena turns on the page engine never change the single-player game, its save or its hall', () => {
  const { loadGame } = require('./load-game.js');
  const G = loadGame();
  G.run(`S = newState("Solo", "lagos", "hustler", AV_SKINS[2], "custom"); S.av = { ...AV_DEFAULT }; dealHand(); save(); 0`);
  const before = { save: G.store['jos-save'], hall: G.store['jos-hall'] || null, S: JSON.stringify(G.run('S')) };
  // the same adapter shape arena/client/arena.js builds from the page's globals
  const names = ['newState', 'dealHand', 'endWeek', 'choose', 'nextEvent', 'nextWeek', 'startBuild', 'startJapaY2', 'eventView', 'log', 'CARDS', 'BLOCKS', 'wallet', 'moneyCommitted', 'loanRoom', 'blocksUsed', 'japaProgress', 'REGIONS', 'TRAITS', 'AV_DEFAULT', 'AV_SKINS'];
  const E = Object.fromEntries(names.map(n => [n, G.run(n)]));
  Object.assign(E, { getS: () => G.run('S'), setS: v => { G.ctx.__v = v; G.run('S = __v'); }, setRandom: f => { const p = Math.random; Math.random = f; return p; }, setSandbox: b => { G.run(`ARENA_SANDBOX = ${!!b}`); } });
  const A = Turn.makeArena(E);
  let s = A.initState(CHARS[2], { startMoney: 200000, difficulty: 'normal' }, Rules.RULES['arena-1'], 'cafe');
  for (let t = 0; t < 70; t++) { const { result } = decide(A, s, 'p' + t, STRATS.Tunde); s = result.state; if (result.storyDone) break; }
  assert.ok(s.week > 40, 'the Arena character lived a long life (endings included)');
  assert.equal(G.store['jos-save'], before.save, 'single-player save unchanged');
  assert.equal(G.store['jos-hall'] || null, before.hall, 'hall of endings unchanged');
  assert.equal(JSON.stringify(G.run('S')), before.S, 'single-player state unchanged');
  assert.equal(G.run('ARENA_SANDBOX'), false);
  // and the page engine agrees with the server engine, turn for turn
  const srv = device(); let a = A.initState(CHARS[0], { startMoney: 200000, difficulty: 'hard' }, Rules.RULES['arena-1'], 'beef'), b = a;
  for (let t = 0; t < 25; t++) { const { dec, result } = decide(A, a, 'x' + t, STRATS.Amaka); const r2 = srv.play(b, 'x' + t, dec); assert.equal(Turn.stateHash(r2.state), Turn.stateHash(result.state), `turn ${t}`); a = result.state; b = r2.state; }
});
