// Japa or Stay: Challenge Arena — competition rules and the weekly score engine.
// Pure functions only: no DOM, no storage, no clock, no randomness. The same file runs in the browser
// (as a classic script, exposed as window.ArenaRules), on the server (Cloudflare Pages Functions) and in Node tests.
// Every formula here is versioned: a room stores the rules version it started with, and finalised weeks never change.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArenaRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- versioned rules ---------- */
  const RULES = {
    'arena-1': {
      version: 'arena-1',
      // One competition rate for every room member, so a dollar is worth the same to everyone on the leaderboard.
      fxRate: 1500,
      // Book values used for net worth (never for cash rankings).
      assets: { bizLevel: 30000, branch: 1500000, landPlot: 2500000, houseStage: 200000, solar: 200000 },
      // Life Balance Score: each part is scored 0–100, then weighted. Weights add up to 1.
      weights: { money: 0.25, strength: 0.125, happiness: 0.125, body: 0.125, family: 0.125, people: 0.125, clout: 0.125 },
      moneyFloor: 10000,     // eligible cash at or below this scores 0 for money
      moneyCap: 20000000,    // eligible cash at or above this scores 100 (log scale in between)
      cloutCap: 20000,       // fans at or above this score 100 for clout (log scale)
      difficulty: {
        easy:   { money: 1.5, energy: 10, mood: 10, health: 5 },
        normal: { money: 1, energy: 0, mood: 0, health: 0 },
        hard:   { money: 0.5, energy: -10, mood: -10, health: -10 }
      }
    }
  };
  const CURRENT = 'arena-1';
  const rulesFor = v => RULES[v] || null;

  /* ---------- the seven measures ---------- */
  // Money is real cash. The six life stats map to the game's existing stats (the Pidgin labels already use these names).
  const STATS = [
    { k: 'strength', src: 'energy', label: 'Strength' },
    { k: 'happiness', src: 'mood', label: 'Happiness' },
    { k: 'body', src: 'health', label: 'Body' },
    { k: 'family', src: 'family', label: 'Family Matters' },
    { k: 'people', src: 'community', label: 'Your People' },
    { k: 'clout', src: 'clout', label: 'Clout', fans: true }
  ];
  const STAT_KEYS = STATS.map(s => s.k);

  const AWARDS = [
    { key: 'money', name: 'Cash King / Queen', metric: 'eligibleCash', money: true },
    { key: 'strength', name: 'Strength Champion', metric: 'strength' },
    { key: 'happiness', name: 'Happiness Champion', metric: 'happiness' },
    { key: 'body', name: 'Body Champion', metric: 'body' },
    { key: 'family', name: 'Family Champion', metric: 'family' },
    { key: 'people', name: "People's Champion", metric: 'people' },
    { key: 'clout', name: 'Clout Champion', metric: 'clout' },
    { key: 'overall', name: 'Best Overall Life', metric: 'lifeBalance' },
    { key: 'comeback', name: 'Biggest Financial Comeback', metric: 'comeback' },
    { key: 'improved', name: 'Most Improved Player', metric: 'improvement' }
  ];
  const AWARD_KEYS = AWARDS.map(a => a.key);
  // The money award title follows the winner's own choice in their profile; nobody's gender is guessed.
  const CASH_TITLES = { king: 'Cash King', queen: 'Cash Queen', boss: 'Cash Boss' };
  function awardName(key, room, title) {
    const custom = room && room.awardNames && room.awardNames[key];
    if (custom) return custom;
    if (key === 'money') return CASH_TITLES[title] || 'Cash King / Queen';
    const a = AWARDS.find(x => x.key === key);
    return a ? a.name : key;
  }

  const ACHIEVEMENTS = {
    first_millionaire: { name: 'First Millionaire', d: 'Ended a week with ₦1,000,000 of eligible cash' },
    lagos_hustler: { name: 'Lagos Hustler', d: 'Won the weekly money crown while living in Lagos' },
    business_mogul: { name: 'Business Mogul', d: 'Grew a business to level 8 or opened a second branch' },
    family_first: { name: 'Family First', d: 'Family Matters at 90 or more at the end of a week' },
    community_hero: { name: 'Community Hero', d: 'Your People at 90 or more at the end of a week' },
    iron_strength: { name: 'Iron Strength', d: 'Strength at 90 or more at the end of a week' },
    happiness_master: { name: 'Happiness Master', d: 'Happiness at 90 or more at the end of a week' },
    clout_celebrity: { name: 'Clout Celebrity', d: '10,000 fans or more' },
    financial_comeback: { name: 'Financial Comeback', d: 'Won Biggest Financial Comeback' },
    balanced_life: { name: 'Balanced Life Champion', d: 'Life Balance 70+ with every life stat at 50 or more' },
    weekly_champion: { name: 'Weekly Champion', d: 'Won a weekly money crown' },
    hat_trick: { name: 'Hat-trick', d: 'Three weekly money crowns in one challenge' },
    japa_made: { name: 'Japa Made', d: 'Landed abroad during a challenge' },
    season_champion: { name: 'Season Champion', d: 'Finished a challenge first on money' }
  };

  /* ---------- room configuration ---------- */
  // maxPlayers 0 means unlimited: no seat cap
  const LIMITS = { minPlayers: 2, maxPlayers: 8, unlimited: 0 };
  // a life in the game lasts 104 in-game weeks (two years) and every turn uses one, so a challenge can hold 104 turns
  const MAX_TURNS = 104;
  const isFull = (cfg, joined) => cfg.maxPlayers > 0 && joined >= cfg.maxPlayers;
  const seatsText = (cfg, joined) => cfg.maxPlayers > 0 ? `${joined} of ${cfg.maxPlayers} players` : `${joined} player${joined === 1 ? '' : 's'} · no limit`;
  const turnsFit = (weeks, turns) => weeks * turns <= MAX_TURNS;
  const OPTIONS = {
    weeks: [4, 8, 12, 16, 52],
    turnsPerWeek: [2, 3, 4, 5, 6],
    roundHours: [24, 48, 72, 168],
    difficulty: ['easy', 'normal', 'hard'],
    startMoney: [100000, 200000, 500000],
    visibility: ['private', 'public'],
    statsVisibility: ['full', 'summary'],
    invitePermission: ['host', 'members']
  };
  const DEFAULTS = {
    name: '', description: '', maxPlayers: 6, visibility: 'private', approval: false, weeks: 8, turnsPerWeek: 4,
    roundHours: 168, graceMinutes: 60, earlyFinish: true, difficulty: 'normal', startMoney: 200000,
    statsVisibility: 'full', invitePermission: 'host', awardNames: {}, startAt: null
  };
  // Display names, room names and award names: printable text only, no markup characters, length-limited.
  const BAD_WORDS = ['fuck', 'shit', 'bitch', 'cunt', 'nigger', 'nigga', 'faggot', 'whore', 'rape', 'ashawo', 'mumu', 'olodo'];
  function cleanText(s, max) {
    if (typeof s !== 'string') return '';
    // strip control characters and the characters that could open markup, then collapse spaces
    return s.replace(/[\u0000-\u001f\u007f<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  const isRude = s => { const x = String(s).toLowerCase().replace(/[^a-z]/g, ''); return BAD_WORDS.some(w => x.includes(w)); };

  function validateConfig(input, { now = 0 } = {}) {
    const i = input && typeof input === 'object' ? input : {};
    const errors = [], c = { ...DEFAULTS };
    c.name = cleanText(i.name, 40);
    if (c.name.length < 3) errors.push('Give the challenge a name of at least 3 characters.');
    if (isRude(c.name)) errors.push('Please choose a different challenge name.');
    c.description = cleanText(i.description || '', 200);
    if (isRude(c.description)) errors.push('Please change the description.');
    const intIn = (k, list) => { if (i[k] === undefined) return; const v = Number(i[k]); if (!list.includes(v)) errors.push(`${k} must be one of ${list.join(', ')}.`); else c[k] = v; };
    const oneOf = (k, list) => { if (i[k] === undefined) return; if (!list.includes(i[k])) errors.push(`${k} must be one of ${list.join(', ')}.`); else c[k] = i[k]; };
    if (i.maxPlayers !== undefined) { const v = i.maxPlayers === 'unlimited' ? 0 : Number(i.maxPlayers); if (!Number.isInteger(v) || (v !== LIMITS.unlimited && (v < LIMITS.minPlayers || v > LIMITS.maxPlayers))) errors.push(`Room size must be ${LIMITS.minPlayers}–${LIMITS.maxPlayers} players, or unlimited.`); else c.maxPlayers = v; }
    intIn('weeks', OPTIONS.weeks); intIn('turnsPerWeek', OPTIONS.turnsPerWeek); intIn('roundHours', OPTIONS.roundHours); intIn('startMoney', OPTIONS.startMoney);
    if (!turnsFit(c.weeks, c.turnsPerWeek)) errors.push(`A ${c.weeks}-week challenge fits at most ${Math.floor(MAX_TURNS / c.weeks)} turns a week, because a life in the game lasts ${MAX_TURNS} in-game weeks.`);
    oneOf('difficulty', OPTIONS.difficulty); oneOf('visibility', OPTIONS.visibility); oneOf('statsVisibility', OPTIONS.statsVisibility); oneOf('invitePermission', OPTIONS.invitePermission);
    if (i.graceMinutes !== undefined) { const v = Number(i.graceMinutes); if (!Number.isInteger(v) || v < 0 || v > 180) errors.push('Sync grace must be 0–180 minutes.'); else c.graceMinutes = v; }
    if (i.approval !== undefined) c.approval = !!i.approval;
    if (i.earlyFinish !== undefined) c.earlyFinish = !!i.earlyFinish;
    if (i.awardNames && typeof i.awardNames === 'object') {
      c.awardNames = {};
      for (const k of Object.keys(i.awardNames)) {
        if (!AWARD_KEYS.includes(k)) continue;
        const v = cleanText(i.awardNames[k], 28);
        if (v && isRude(v)) errors.push('Please change one of the award names.');
        else if (v) c.awardNames[k] = v;
      }
    }
    if (i.startAt) {
      const t = Date.parse(i.startAt);
      if (!isFinite(t)) errors.push('Start date is not a valid date.');
      else if (now && (t < now - 60000 || t > now + 30 * 864e5)) errors.push('Start date must be within the next 30 days.');
      else c.startAt = new Date(t).toISOString();
    }
    return { ok: !errors.length, config: c, errors };
  }

  /* ---------- per-player measures, from a trusted game state ---------- */
  const REGION_NAMES = { lagos: 'Lagos', kano: 'Kano', enugu: 'Enugu', ph: 'Port Harcourt' };
  const r0 = n => Math.round(n);
  const r1 = n => Math.round(n * 10) / 10;
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
  function career(s) {
    if (s.abroad) return s.abroad.promoted ? 'Senior carer · Northland' : 'Care worker · Northland';
    if (s.build) return `Shop owner · ${s.build.branches} branch${s.build.branches > 1 ? 'es' : ''}`;
    if (s.biz > 0 && s.job) return `Office job + business (level ${s.biz})`;
    if (s.biz > 0) return `Trader · business level ${s.biz}`;
    if (s.job) return (s.skills && s.skills.tech >= 3) ? 'Tech worker' : 'Office job';
    return 'Job seeker';
  }
  const place = s => s.abroad ? 'Northland (abroad)' : (REGION_NAMES[s.region] || s.region);
  const path = s => s.abroad ? 'japa' : s.build ? 'stay' : s.resolve > 10 ? 'leaning japa' : s.resolve < -10 ? 'leaning stay' : 'deciding';

  function metrics(s, rules) {
    const R = rules || RULES[CURRENT], fx = R.fxRate;
    const cash = r0(s.money || 0), usd = r0(s.usd || 0);
    const cashNgn = cash + usd * fx;
    const B = s.build, A = s.abroad;
    // borrowed money is counted against you: loan app debt, the credit card abroad, and bank loan repayments still to make
    const loanApp = r0(s.debt || 0), card = A ? r0((A.cc || 0) * fx) : 0, bank = B ? r0((B.loan || 0) * (B.loanWeeks || 0)) : 0, supplier = B ? r0(B.supplier || 0) : 0;
    const liabilities = loanApp + card + bank + supplier;
    const assets = r0((s.biz || 0) * R.assets.bizLevel + (B ? Math.max(0, B.branches - 1) * R.assets.branch + (B.house || 0) * R.assets.houseStage : 0)
      + (A ? (A.land || 0) * R.assets.landPlot : 0) + (s.solar ? R.assets.solar : 0));
    const eligibleCash = cashNgn - liabilities;
    const stats = {};
    for (const st of STATS) stats[st.k] = r0(s[st.src] || 0);
    const m = { cash, usd, cashNgn, liabilities, debts: { loanApp, card, bank, supplier }, assets, netWorth: cashNgn + assets - liabilities, eligibleCash, ...stats };
    m.scores = scores(m, R);
    m.lifeBalance = r1(Object.keys(R.weights).reduce((a, k) => a + R.weights[k] * m.scores[k], 0));
    m.week = s.week; m.place = place(s); m.career = career(s); m.path = path(s); m.ending = s.phase === 'end' ? (s.ending || null) : null;
    return m;
  }
  function scores(m, R) {
    const lg = (v, lo, hi) => clampN(100 * Math.log10(Math.max(v, lo) / lo) / Math.log10(hi / lo), 0, 100);
    const out = { money: r1(lg(m.eligibleCash, R.moneyFloor, R.moneyCap)) };
    for (const k of STAT_KEYS) out[k] = k === 'clout' ? r1(clampN(100 * Math.log10(1 + m.clout) / Math.log10(1 + R.cloutCap), 0, 100)) : clampN(m[k], 0, 100);
    return out;
  }

  /* ---------- ranking ---------- */
  // Competition ranking ("1, 2, 2, 4"): players whose sort keys are all equal share a place. Never uses join order or ids.
  function rank(rows, keys) {
    const cmp = (a, b) => { for (const k of keys) { const d = k(b) - k(a); if (d) return d; } return 0; };
    const sorted = rows.slice().sort((a, b) => cmp(a, b) || (a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0));
    const out = {};
    sorted.forEach((r, i) => { out[r.pid] = i > 0 && cmp(sorted[i - 1], r) === 0 ? out[sorted[i - 1].pid] : i + 1; });
    return out;
  }
  // Tie-break order for every board. Money: eligible cash, then net worth, then Life Balance.
  const BOARDS = {
    money: [r => r.m.eligibleCash, r => r.m.netWorth, r => r.m.lifeBalance],
    netWorth: [r => r.m.netWorth, r => r.m.eligibleCash],
    lifeBalance: [r => r.m.lifeBalance, r => r.m.eligibleCash],
    improvement: [r => r.d.lifeBalance, r => r.d.eligibleCash],
    strength: [r => r.m.strength, r => r.m.lifeBalance],
    happiness: [r => r.m.happiness, r => r.m.lifeBalance],
    body: [r => r.m.body, r => r.m.lifeBalance],
    family: [r => r.m.family, r => r.m.lifeBalance],
    people: [r => r.m.people, r => r.m.lifeBalance],
    clout: [r => r.m.clout, r => r.m.lifeBalance]
  };

  /* ---------- the weekly score engine ---------- */
  // input: rows = [{ pid, region, title, state, prev, statTrail }]
  //   prev: the player's previous official result for this room ({ m, cum, ranks }), or their opening snapshot for week 1 ({ m, cum: null, opening: true })
  //   statTrail: the six life stats after each turn this week, in order (used for lifetime gains and losses)
  // output: { results: { pid: { m, d, ranks, cum } }, awards: [{ key, pids, value }], highlights: [text] }
  function computeWeek(rows, rules, week) {
    const R = rules || RULES[CURRENT];
    const live = rows.map(r => {
      const m = metrics(r.state, R), pm = r.prev ? r.prev.m : m;
      const d = { eligibleCash: m.eligibleCash - pm.eligibleCash, netWorth: m.netWorth - pm.netWorth, lifeBalance: r1(m.lifeBalance - pm.lifeBalance) };
      for (const k of STAT_KEYS) d[k] = m[k] - pm[k];
      return { ...r, m, d };
    });
    const ranks = {};
    for (const b of Object.keys(BOARDS)) ranks[b] = rank(live, BOARDS[b]);
    const results = {};
    for (const r of live) {
      const prevCum = (r.prev && r.prev.cum) || null;
      results[r.pid] = { m: r.m, d: r.d, ranks: Object.fromEntries(Object.keys(ranks).map(b => [b, ranks[b][r.pid]])), cum: cumulate(prevCum, r.prev ? r.prev.m : r.m, r.statTrail || [], r.m, ranks.money[r.pid]) };
      results[r.pid].ranks.moneyChange = r.prev && r.prev.ranks ? r.prev.ranks.money - ranks.money[r.pid] : 0;
    }
    // awards: everyone tied on the deciding numbers shares the award
    const awards = [];
    const topOf = (board, val, ok = () => true) => {
      const pool = live.filter(ok); if (!pool.length) return null;
      const best = Math.min(...pool.map(r => ranks[board][r.pid]));
      const pids = pool.filter(r => ranks[board][r.pid] === best).map(r => r.pid).sort();
      return { pids, value: val(pool.find(r => r.pid === pids[0])) };
    };
    const add = (key, w) => { if (w) awards.push({ key, ...w }); };
    add('money', topOf('money', r => r.m.eligibleCash));
    for (const k of STAT_KEYS) add(k, topOf(k, r => r.m[k]));
    add('overall', topOf('lifeBalance', r => r.m.lifeBalance));
    if (week > 1) {
      // comeback: the biggest climb up the money table; ties broken by the bigger cash gain
      const climbers = live.filter(r => r.prev && r.prev.ranks && r.prev.ranks.money - ranks.money[r.pid] > 0);
      if (climbers.length) {
        const cr = rank(climbers, [r => r.prev.ranks.money - ranks.money[r.pid], r => r.d.eligibleCash]);
        const pids = climbers.filter(r => cr[r.pid] === 1).map(r => r.pid).sort();
        const w = climbers.find(r => r.pid === pids[0]);
        awards.push({ key: 'comeback', pids, value: w.prev.ranks.money - ranks.money[w.pid] });
      }
    }
    add('improved', topOf('improvement', r => r.d.lifeBalance, r => r.d.lifeBalance > 0));
    return { results, awards, ranks };
  }
  function cumulate(prevCum, prevM, trail, m, moneyRank) {
    const c = prevCum ? JSON.parse(JSON.stringify(prevCum)) : { weeks: 0, gains: {}, losses: {}, highs: {}, sums: {}, bestCash: -Infinity, bestMoneyRank: null };
    let last = {}; for (const k of STAT_KEYS) last[k] = prevM[k];
    for (const snap of trail.concat([m])) {
      for (const k of STAT_KEYS) {
        const v = snap[k] === undefined ? last[k] : snap[k], dv = v - last[k];
        if (dv > 0) c.gains[k] = (c.gains[k] || 0) + dv; else if (dv < 0) c.losses[k] = (c.losses[k] || 0) - dv;
        last[k] = v;
      }
    }
    c.weeks += 1;
    for (const k of STAT_KEYS.concat(['lifeBalance'])) { c.highs[k] = Math.max(c.highs[k] === undefined ? -Infinity : c.highs[k], m[k]); c.sums[k] = (c.sums[k] || 0) + m[k]; }
    c.bestCash = Math.max(c.bestCash, m.eligibleCash);
    c.bestMoneyRank = c.bestMoneyRank === null ? moneyRank : Math.min(c.bestMoneyRank, moneyRank);
    return c;
  }
  const average = (cum, k) => cum && cum.weeks ? r1(cum.sums[k] / cum.weeks) : null;

  /* ---------- achievements (decided only from official results) ---------- */
  function achievementsFor(row, result, awards, moneyWinsInRoom) {
    const m = result.m, s = row.state, won = k => awards.some(a => a.key === k && a.pids.includes(row.pid)), out = [];
    if (m.eligibleCash >= 1000000) out.push('first_millionaire');
    if (won('money') && s.region === 'lagos' && !s.abroad) out.push('lagos_hustler');
    if ((s.biz || 0) >= 8 || (s.build && s.build.branches >= 2)) out.push('business_mogul');
    if (m.family >= 90) out.push('family_first');
    if (m.people >= 90) out.push('community_hero');
    if (m.strength >= 90) out.push('iron_strength');
    if (m.happiness >= 90) out.push('happiness_master');
    if (m.clout >= 10000) out.push('clout_celebrity');
    if (won('comeback')) out.push('financial_comeback');
    if (m.lifeBalance >= 70 && ['strength', 'happiness', 'body', 'family', 'people'].every(k => m[k] >= 50)) out.push('balanced_life');
    if (won('money')) out.push('weekly_champion');
    if (moneyWinsInRoom >= 3) out.push('hat_trick');
    if (s.abroad) out.push('japa_made');
    return out;
  }

  /* ---------- weekly highlights: plain sentences from official numbers ---------- */
  const fmtN = n => (n < 0 ? '−' : '') + '₦' + Math.abs(Math.round(n)).toLocaleString('en-NG');
  function highlights(week, out, names) {
    const H = [], nm = pids => pids.map(p => names[p] || 'Someone').join(' and ');
    const aw = k => out.awards.find(a => a.key === k);
    const money = aw('money'); if (money) H.push(`${nm(money.pids)} ${money.pids.length > 1 ? 'share' : 'takes'} the cash crown with ${fmtN(money.value)} of eligible cash.`);
    const gains = Object.entries(out.results).map(([pid, r]) => ({ pid, g: r.d.eligibleCash })).sort((a, b) => b.g - a.g || (a.pid < b.pid ? -1 : 1));
    if (gains.length && gains[0].g > 0 && (!money || !money.pids.includes(gains[0].pid))) H.push(`${nm([gains[0].pid])} made the most money this week: ${fmtN(gains[0].g)}.`);
    const st = Object.entries(out.results).map(([pid, r]) => ({ pid, g: r.d.strength })).sort((a, b) => b.g - a.g || (a.pid < b.pid ? -1 : 1));
    if (week > 1 && st.length && st[0].g > 0) H.push(`${nm([st[0].pid])} built the most Strength (+${st[0].g}).`);
    const cl = aw('clout'); if (cl && cl.value > 0) H.push(`${nm(cl.pids)} ${cl.pids.length > 1 ? 'have' : 'has'} the most Clout: ${Math.round(cl.value).toLocaleString('en-NG')} fans.`);
    const ov = aw('overall'); if (ov) H.push(`${nm(ov.pids)} ${ov.pids.length > 1 ? 'are' : 'is'} living the best-balanced life (${ov.value}).`);
    const cb = aw('comeback'); if (cb) H.push(`${nm(cb.pids)} climbed ${cb.value} place${cb.value > 1 ? 's' : ''} on the money table.`);
    return H;
  }

  return {
    RULES, CURRENT, rulesFor, STATS, STAT_KEYS, AWARDS, AWARD_KEYS, ACHIEVEMENTS, CASH_TITLES, awardName, LIMITS, OPTIONS, DEFAULTS, MAX_TURNS, isFull, seatsText, turnsFit,
    validateConfig, cleanText, isRude, metrics, rank, BOARDS, computeWeek, average, achievementsFor, highlights, REGION_NAMES
  };
});
