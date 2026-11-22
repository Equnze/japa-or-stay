// Japa or Stay: Challenge Arena — turn runner.
// Plays one Arena turn (one in-game week of the classic loop: plan cards → life events → settle-up) on the
// existing single-player engine, with a seeded random-number generator. Given the same starting state, seed and
// decisions it always produces the same result, so the server can replay what a player did offline and trust nothing
// the device says about money or stats. Players submit decisions only: which cards, which event choices.
//
// The engine adapter `E` hides where the engine lives (the page's globals in the browser, a factory on the server):
//   E.getS(), E.setS(v), E.setRandom(fn) → previous fn, E.setSandbox(bool), and the engine functions listed in NEEDS.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ArenaTurn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NEEDS = ['newState', 'dealHand', 'endWeek', 'choose', 'nextEvent', 'nextWeek', 'startBuild', 'startJapaY2', 'eventView', 'log',
    'CARDS', 'BLOCKS', 'wallet', 'moneyCommitted', 'loanRoom', 'blocksUsed', 'japaProgress', 'REGIONS', 'TRAITS', 'AV_DEFAULT', 'AV_SKINS'];

  /* ---------- seeded randomness (sfc32), seeded from a hex string ---------- */
  function seededRng(hex) {
    const h = String(hex).replace(/[^0-9a-f]/gi, '').padEnd(32, '0');
    let a = parseInt(h.slice(0, 8), 16) >>> 0, b = parseInt(h.slice(8, 16), 16) >>> 0, c = parseInt(h.slice(16, 24), 16) >>> 0, d = parseInt(h.slice(24, 32), 16) >>> 0;
    const next = () => {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 12; i++) next(); // warm up
    return next;
  }

  /* ---------- a short, stable fingerprint of the numbers that matter ---------- */
  function coreOf(s) {
    return { week: s.week, phase: s.phase, money: s.money, usd: Math.round(s.usd * 100), energy: s.energy, mood: s.mood, health: s.health, family: s.family,
      community: s.community, clout: s.clout, debt: s.debt, resolve: s.resolve, hand: s.hand, ending: s.ending || null };
  }
  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  const stateHash = s => fnv(JSON.stringify(coreOf(s)));
  const clone = o => JSON.parse(JSON.stringify(o));
  const lifeStats = s => ({ strength: s.energy, happiness: s.mood, body: s.health, family: s.family, people: s.community, clout: s.clout });

  function makeArena(E) {
    for (const k of NEEDS) if (E[k] === undefined) throw new Error('Arena engine adapter is missing ' + k);

    // run engine code against an Arena state without touching the player's single-player game
    function exec(state, rng, fn) {
      const prevS = E.getS();
      const prevR = E.setRandom(rng || (() => { throw new Error('This step must not use randomness'); }));
      E.setSandbox(true); E.setS(state);
      try { return fn(); } finally { E.setS(prevS); E.setSandbox(false); E.setRandom(prevR); }
    }

    /* ---------- characters ---------- */
    function sanitizeAvatar(av) {
      const out = {};
      for (const k of Object.keys(E.AV_DEFAULT)) {
        const def = E.AV_DEFAULT[k], v = av && av[k];
        if (typeof def === 'boolean') out[k] = typeof v === 'boolean' ? v : def;
        else if (typeof def === 'number') out[k] = Number.isInteger(v) && v >= 0 && v <= 40 ? v : def;
        else out[k] = typeof v === 'string' && /^[a-z0-9_-]{1,24}$/i.test(v) ? v : def;
      }
      return out;
    }
    function validateCharacter(c) {
      const errors = [];
      const name = typeof c?.name === 'string' ? c.name.replace(/[\u0000-\u001f\u007f<>`"&]/g, '').trim().slice(0, 20) : '';
      if (!name) errors.push('Give your character a name.');
      if (!E.REGIONS[c?.region]) errors.push('Pick a home city.');
      if (!E.TRAITS[c?.trait]) errors.push('Pick a trait.');
      return { ok: !errors.length, errors, character: { name, region: c?.region, trait: c?.trait, av: sanitizeAvatar(c?.av) } };
    }
    // the opening state for a room member; every member of a room starts with the same money and stats
    function initState(character, room, rules, seed) {
      const v = validateCharacter(character);
      if (!v.ok) throw new Error(v.errors.join(' '));
      const ch = v.character, diff = rules.difficulty[room.difficulty] || rules.difficulty.normal;
      return exec(null, seededRng(seed), () => {
        const S = E.newState(ch.name, ch.region, ch.trait, E.AV_SKINS[ch.av.skin] || E.AV_SKINS[0], 'custom');
        E.setS(S);
        S.av = ch.av; S.arena = true;
        S.money = Math.round(room.startMoney * diff.money);
        S.energy = Math.max(1, Math.min(100, S.energy + diff.energy)); S.mood = Math.max(1, Math.min(100, S.mood + diff.mood)); S.health = Math.max(1, Math.min(100, S.health + diff.health));
        E.dealHand();
        E.log(`<b>Arena start:</b> ${ch.name} enters the challenge with ₦${S.money.toLocaleString('en-NG')}.`);
        return clone(E.getS());
      });
    }

    /* ---------- one turn ---------- */
    // decisions: { picks: [cardKey…], choices: [index…], yearEnd: 'build' | 'japa2' }
    // opts.acks: how many "Next" taps to apply (the device uses this to land on the exact screen; the server plays it all)
    // returns { status: 'done' | 'need', need: 'picks' | 'choice' | 'ack' | 'yearEnd', state, steps, storyDone }
    // or { status: 'invalid', error }
    function play(startState, seed, decisions, opts = {}) {
      const dec = decisions || {}, choices = Array.isArray(dec.choices) ? dec.choices : [];
      const acks = opts.acks === undefined ? Infinity : opts.acks;
      const st = clone(startState), rng = seededRng(seed);
      let ci = 0, ai = 0, steps = 0, pickedUsed = false;
      const fail = error => ({ status: 'invalid', error });
      try {
        return exec(st, rng, () => {
          const S = () => E.getS();
          if (S().phase === 'end' && S().arenaDone) return { status: 'done', state: clone(S()), steps, storyDone: true, used: { picks: false, choices: 0 } };
          for (let guard = 0; guard < 60; guard++) {
            const ph = S().phase;
            if (ph === 'plan') {
              if (pickedUsed) return fail('The turn went back to planning twice.');
              if (!dec.picks) return need('picks');
              const err = applyPicks(dec.picks); if (err) return fail(err);
              pickedUsed = true; E.endWeek(); steps++;
            } else if (ph === 'life') {
              if (S().result == null) {
                if (ci >= choices.length) return need('choice');
                const q = S().queue[0], n = E.eventView(q).choices.length, c = choices[ci];
                if (!Number.isInteger(c) || c < 0 || c >= n) return fail(`Choice ${ci + 1} is not one of the options.`);
                ci++; E.choose(c); steps++;
              } else {
                if (ai >= acks) return need('ack');
                ai++; E.nextEvent(); steps++;
              }
            } else if (ph === 'settle') {
              if (ai >= acks) return need('ack');
              ai++; E.nextWeek(); steps++;
              if (S().phase !== 'end') return done(false);
            } else if (ph === 'end') {
              const s = S();
              const canContinue = !s.abroad && !s.build && !s.japaY2 && s.ending === 'year';
              if (canContinue) {
                if (!dec.yearEnd) return need('yearEnd');
                if (dec.yearEnd === 'japa2' && E.japaProgress() >= 2) E.startJapaY2();
                else if (dec.yearEnd === 'build' || dec.yearEnd === 'japa2') E.startBuild(false);
                else return fail('Pick how Year 2 continues.');
                E.dealHand(); S().phase = 'plan'; steps++;
                return done(false);
              }
              s.arenaDone = true;
              return done(true);
            } else return fail('Unknown phase ' + ph);
          }
          return fail('The turn did not finish.');
          function need(what) { return { status: 'need', need: what, state: clone(S()), steps, used: { picks: pickedUsed, choices: ci } }; }
          function done(storyDone) {
            if (ci < choices.length) return fail('More event choices were sent than the turn had events.');
            return { status: 'done', state: clone(S()), steps, storyDone, used: { picks: pickedUsed, choices: ci } };
          }
        });
      } catch (e) {
        return fail('The game engine stopped: ' + (e && e.message || e));
      }
    }
    // same checks the single-player screen makes when you tap a card
    function applyPicks(picks) {
      if (!Array.isArray(picks) || picks.length < 1 || picks.length > 10) return 'Pick between 1 and 10 cards.';
      const S = E.getS(); S.picked = [];
      for (const k of picks) {
        if (typeof k !== 'string' || !S.hand.includes(k)) return 'A picked card is not in your hand.';
        if (S.picked.includes(k)) return 'The same card was picked twice.';
        const c = E.CARDS[k];
        if (!c.can()) return `${c.name} cannot be played now.`;
        if (c.blocks > E.BLOCKS - E.blocksUsed()) return 'Not enough time blocks for those cards.';
        if (c.cost() - (E.wallet() - E.moneyCommitted()) > E.loanRoom()) return `Not enough money for ${c.name}.`;
        S.picked.push(k);
      }
      return null;
    }

    // Autopilot for missed turns: a cautious week (work or job hunt, then rest), first option for every event, keep building at year end.
    function autopilotDecisions(state, seed) {
      const dec = { picks: null, choices: [], yearEnd: 'build', auto: true };
      if (state.phase === 'plan') {
        dec.picks = exec(clone(state), null, () => {
          const S = E.getS(), out = []; S.picked = [];
          for (const k of ['work', 'a_shift', 'b_shop', 'jobhunt', 'rest', 'a_rest']) {
            if (!S.hand.includes(k)) continue;
            const c = E.CARDS[k];
            if (c.can() && c.blocks <= E.BLOCKS - E.blocksUsed() && c.cost() - (E.wallet() - E.moneyCommitted()) <= Math.min(0, E.loanRoom())) { S.picked.push(k); out.push(k); }
          }
          if (!out.length) { const k = S.hand.find(x => E.CARDS[x].cost() === 0) || S.hand[0]; out.push(k); }
          return out;
        });
      }
      for (let i = 0; i < 12; i++) {
        const r = play(state, seed, dec);
        if (r.status === 'need' && r.need === 'choice') { dec.choices.push(0); continue; }
        return dec;
      }
      return dec;
    }

    // read-only helpers for screens (run with the Arena state swapped in, no randomness allowed)
    // screens read the state through this; a fixed "random" keeps any flavour text steady and never moves a turn's seed
    const view = (state, fn) => exec(clone(state), () => 0.5, () => fn(E.getS()));
    // the event waiting for a choice, as the single-player screen shows it
    const currentEvent = state => view(state, S => S.phase === 'life' && S.queue && S.queue[0] ? E.eventView(S.queue[0]) : null);

    return { play, initState, validateCharacter, autopilotDecisions, view, currentEvent, exec };
  }

  return { makeArena, seededRng, stateHash, coreOf, lifeStats, clone };
});
