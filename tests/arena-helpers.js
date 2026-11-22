// Test helpers for the Challenge Arena: a fresh in-memory database per test, a clock the test controls,
// and a tiny client that calls the API exactly as the browser does. Nothing here touches real player data.
const path = require('path');
const root = path.join(__dirname, '..');
require(path.join(root, 'arena', 'build-engine.js')).writeEngine(root);
const { openD1, migrate } = require(path.join(root, 'arena', 'dev', 'd1-shim.js'));
const { handle } = require(path.join(root, 'arena', 'server', 'app.js'));
const Turn = require(path.join(root, 'arena', 'shared', 'turn.js'));
const Rules = require(path.join(root, 'arena', 'shared', 'rules.js'));
const createEngine = require(path.join(root, 'arena', 'server', 'engine.generated.js'));

const HOUR = 3600000;
function world(start = Date.UTC(2026, 10, 2, 9)) {
  const DB = migrate(openD1(':memory:'));
  const clock = { t: start };
  const env = { DB, ARENA_SECRET: 'test-secret-0123456789abcdef0123456789', now: () => clock.t };
  async function call(method, p, body, token, extraHeaders = {}) {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (method !== 'GET' && !('x-arena' in extraHeaders)) headers['x-arena'] = '1';
    if (token) headers.authorization = 'Bearer ' + token;
    const res = await handle(new Request('https://arena.test/api' + p, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }), env);
    const data = await res.json();
    return { ...data, body: data, status: res.status };
  }
  async function player(name) {
    const r = await call('POST', '/auth/anon', { displayName: name }, null, { 'cf-connecting-ip': name });
    return { name, id: r.playerId, token: r.token, recovery: r.recoveryCode, call: (m, p, b, h) => call(m, p, b, r.token, h) };
  }
  return { DB, env, clock, call, player, advance: ms => { clock.t += ms; } };
}

// a device-side engine, like the browser's, for playing turns offline
function device() { return Turn.makeArena(createEngine()); }
const CHARS = [
  { name: 'Amaka', region: 'enugu', trait: 'cruise' }, { name: 'Chidi', region: 'lagos', trait: 'hustler' },
  { name: 'Tunde', region: 'ph', trait: 'book' }, { name: 'Zara', region: 'kano', trait: 'family' }
];
// a simple strategy per player, so the four lives go different ways
const STRATS = {
  Amaka: ['skit', 'audition', 'studio', 'work', 'jobhunt', 'rest', 'a_vlog', 'a_shift', 'b_shop', 'b_promote'],
  Chidi: ['work', 'jobhunt', 'pos', 'stock', 'rest', 'b_shop', 'b_restock', 'b_hire', 'a_shift'],
  Tunde: ['work', 'jobhunt', 'study', 'test', 'passport', 'apply', 'convert', 'rest', 'a_shift', 'a_course', 'a_rest', 'b_shop'],
  Zara: ['call', 'faith', 'work', 'jobhunt', 'rest', 'chill', 'a_call', 'a_shift', 'b_shop', 'b_union', 'b_house']
};
function decide(A, state, seed, prefs) {
  const dec = { picks: null, choices: [], yearEnd: 'build' };
  if (state.phase === 'plan') {
    dec.picks = A.view(state, S => {
      const out = [];
      for (const k of prefs) {
        if (!S.hand.includes(k) || out.includes(k)) continue;
        const r = A.play(state, seed, { picks: [...out, k] }, { acks: 0 });
        if (r.status !== 'invalid') out.push(k);
      }
      return out.length ? out : [S.hand.includes('rest') ? 'rest' : S.hand[0]];
    });
  }
  for (let i = 0; i < 12; i++) {
    const r = A.play(state, seed, dec);
    if (r.status === 'need' && r.need === 'choice') { const n = A.currentEvent(r.state).choices.length; dec.choices.push(Math.min(n - 1, dec.choices.length % 2)); continue; }
    if (r.status === 'need' && r.need === 'picks') { dec.picks = ['rest']; continue; }
    return { dec, result: r };
  }
  throw new Error('could not finish a turn');
}

module.exports = { world, device, decide, CHARS, STRATS, HOUR, Turn, Rules };
