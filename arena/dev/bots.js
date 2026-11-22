// Local test bots for the Arena dev server: they join a room by code, make characters, get ready, and play turns
// through the same API (and the same offline-style turn runner) as the browser. Local development only.
// Usage: node arena/dev/bots.js join CODE [count]     then     node arena/dev/bots.js play ROOM_ID
const fs = require('fs');
const path = require('path');
const Turn = require('../shared/turn.js');
require('../build-engine.js').writeEngine(path.join(__dirname, '..', '..'));
const createEngine = require('../server/engine.generated.js');
const BASE = process.env.ARENA_URL || 'http://localhost:8791';
const file = path.join(__dirname, '..', '..', '.arena-dev', 'bots.json');
const bots = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const A = Turn.makeArena(createEngine());
const CHARS = [{ name: 'Chidi', region: 'lagos', trait: 'hustler' }, { name: 'Zara', region: 'kano', trait: 'family' }, { name: 'Tunde', region: 'ph', trait: 'book' }, { name: 'Amaka', region: 'enugu', trait: 'cruise' }];
const PREFS = [['work', 'jobhunt', 'pos', 'stock', 'rest', 'b_shop', 'b_restock', 'a_shift'], ['call', 'faith', 'work', 'jobhunt', 'rest', 'chill', 'b_shop', 'a_shift'], ['work', 'jobhunt', 'study', 'test', 'passport', 'apply', 'rest', 'a_shift'], ['skit', 'audition', 'work', 'jobhunt', 'rest', 'a_vlog', 'b_shop']];
async function call(bot, method, p, body) {
  const r = await fetch(BASE + '/api' + p, { method, headers: { 'content-type': 'application/json', 'x-arena': '1', ...(bot ? { authorization: 'Bearer ' + bot.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.message}`); return d;
}
function decide(state, seed, prefs) {
  const dec = { picks: null, choices: [], yearEnd: 'build' };
  if (state.phase === 'plan') {
    const out = [];
    for (const k of prefs) if (state.hand.includes(k) && A.play(state, seed, { picks: [...out, k] }, { acks: 0 }).status !== 'invalid') out.push(k);
    dec.picks = out.length ? out : ['rest'];
  }
  for (let i = 0; i < 12; i++) { const r = A.play(state, seed, dec); if (r.status === 'need' && r.need === 'choice') { dec.choices.push(0); continue; } return { dec, r }; }
}
(async () => {
  const [cmd, arg, n] = process.argv.slice(2);
  if (cmd === 'join') {
    const inv = await call(null, 'GET', '/invite/' + arg).catch(() => null);
    for (let i = 0; i < Number(n || 3); i++) {
      const a = await call(null, 'POST', '/auth/anon', { displayName: ['Bayo (bot)', 'Kemi (bot)', 'Ifeanyi (bot)', 'Musa (bot)'][i] });
      const bot = { token: a.token, id: a.playerId, i };
      const j = await call(bot, 'POST', '/rooms/join', { code: arg });
      await call(bot, 'POST', `/rooms/${j.room.id}/character`, CHARS[i % 4]);
      await call(bot, 'POST', `/rooms/${j.room.id}/ready`, { ready: true });
      bots.push({ ...bot, room: j.room.id });
      console.log('joined', a.playerId, CHARS[i % 4].name);
    }
    fs.writeFileSync(file, JSON.stringify(bots, null, 1));
  } else if (cmd === 'play') {
    for (const bot of bots.filter(b => b.room === arg)) {
      const p = await call(bot, 'GET', `/rooms/${arg}/play`);
      let s = p.state, v = p.stateVersion; const ops = [];
      for (const t of p.tickets) { const { dec, r } = decide(s, t.seed, PREFS[bot.i % 4]); ops.push({ opId: 'bot_' + Math.random().toString(36).slice(2) + Date.now(), kind: 'turn', roomId: arg, week: t.week, turn: t.turn, baseVersion: v, decisions: dec, clientHash: Turn.stateHash(r.state) }); s = r.state; v++; }
      const res = await call(bot, 'POST', '/sync', { ops });
      console.log(bot.id, res.results.map(x => x.status + (x.match === false ? '(corrected)' : '')).join(' '));
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
