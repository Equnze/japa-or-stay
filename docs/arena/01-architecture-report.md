# 1. Architecture report: the existing game, and how the Arena fits

Audited 22 November 2026 on `main` (commit `dfbe037` plus uncommitted work). This report covers what the Challenge Arena build found, reused and added.

## What the project actually is

| Part | Finding |
|---|---|
| Frontend | One file, `japa-or-stay.html` (about 3,300 lines, 482 KB): hand-written CSS with design tokens, then one plain-JavaScript `<script>`. No React, no Next.js, no TypeScript, no `package.json`. |
| Rendering | A global mutable state object `S`, template-string view functions, and `render()` rebuilding `#app` on every change. One delegated click handler on `data-act`. |
| Backend, database, login | **None** before the Arena. Static files only. |
| Hosting | Cloudflare Pages runs `node build.js`, which writes `dist/` (page, manifest, service worker, headers). Live at https://japa-or-stay.pages.dev. |
| Second target | The same HTML is published as a claude.ai artifact (no server there). |
| Offline | A generated service worker caches the page and fonts; the game plays offline after the first visit. |
| Persistence | `localStorage`: `jos-save` (the whole `S`), `jos-hall` (endings and bests), `jos-daily`, settings. |
| Tests | `tests/load-game.js` loads the game script in a Node `vm` sandbox. `tests/cinema.test.js` existed already; 12 of its 13 tests fail on the current game file because they test a cinematic system (`FACE_EXPR`, `figure`, `CAST`) that is not in `japa-or-stay.html`. That is unrelated to the Arena and was failing before it. |

## Game state and rules (what the Arena reuses)

- **Stats.** `S.money` (naira), `S.usd` (dollar account), `S.energy`, `S.mood`, `S.health`, `S.family`, `S.community` (0–100), `S.clout` (fans, unbounded), `S.resolve` (−100 japa…stay +100), `S.debt` (loan app). The Pidgin labels in the game are already *Strength, Happiness, Body, Family matter, Your people, Clout*, so the Arena's seven measures map one-to-one onto existing stats: no new stat system was needed.
- **The week loop** (`endWeek → choose / nextEvent → settle → nextWeek`) is pure game logic: it changes `S` and never touches the page. 45 cards (`CARDS`), 79 events (`EV`), three chapters (Year 1, Abroad, Build), 22 endings.
- **Randomness** goes through `Math.random` (in `rnd`, `chance`, `pick`, `fillHand`).
- **Money.** Pay and business profit arrive at settle-up; rent, food, transport, wages, loan interest and auto-deductions leave there. The settle-up already produces a ledger (`S.ledger.lines`). Abroad, cash is dollars.

## Decision: keep the stack, add a small server

The brief allowed Supabase or another stack, but said to prefer what exists and not to migrate. The game is hosted on Cloudflare Pages, so the Arena uses **Cloudflare Pages Functions + D1 (SQLite)**:

- free tier, no new vendor, same deploy (`git push`), same domain (no CORS, no third-party cookies);
- the earlier design pack (`docs/2.0/06-master-brief-audit-and-kotlin.md`) had already named "Cloudflare D1 + a Worker" as the backend for any future leaderboard;
- D1 has no row-level security, so **authorisation lives in one API layer** that is the only way to reach the database (the browser never talks to the database directly). Every query is scoped by the signed-in player and room membership; the tests check the cross-room and cross-player cases.

No framework was added. The Arena screens are plain JavaScript in the same style as the game (template strings and delegated clicks), so nothing about the single-player game changes.

## The key idea: the server runs the real game

Players never send money or stats, only **decisions** (which cards, which event choices). The server replays those decisions on the **same game engine** with a **seeded random generator**, so the result is exact and cannot be edited on a device.

- `arena/build-engine.js` turns the game's own `<script>` into a factory module at build time (Workers forbid `eval`, so the code is pasted into a real function, in strict mode, with stubbed browser globals and a shadowed `Math.random`). It starts in about 25 ms and plays a turn in about 1 ms.
- `arena/shared/turn.js` plays one turn (plan → events → settle) on any copy of the engine. The browser uses the page's own engine; the server uses the generated one. A test checks they agree turn for turn.
- Seeds are `HMAC(server secret, room | player | week | turn)`: unpredictable to devices, identical on every replay.

## What was added, changed or refactored

| Kind | Files |
|---|---|
| Changed (minimal) | `japa-or-stay.html`: an `ARENA_SANDBOX` flag that makes `save()`, `saveHall()` and the hall part of `finishRun()` do nothing while an Arena turn runs; a hidden "🏆 Multiplayer Arena" header button. `build.js`: generates the engine, inlines the Arena into `dist/index.html`, and stops the service worker caching `/api/`. |
| Shared rules | `arena/shared/rules.js` (scoring, ranking, awards, achievements, room validation), `arena/shared/turn.js` (turn runner, seeded RNG, state hash). |
| Server | `arena/server/app.js` (API), `functions/api/[[path]].js` (Pages Function), `migrations/0001_arena.sql` (D1 schema). |
| Client | `arena/client/arena.js` (screens, IndexedDB, offline queue, sync, polling), `arena/client/arena.css`. |
| Dev and tests | `arena/dev/server.js` (local server on `node:sqlite`), `arena/dev/d1-shim.js`, `arena/dev/bots.js` (local test players), `tests/arena.test.js`, `tests/arena-helpers.js`. |

Nothing was refactored in the game. The artifact build is unchanged: it never shows the Arena, because the Arena script is only added to the website build and the button only appears when `/api/health` answers.

## Concerns found and how they are handled

| Concern | Handling |
|---|---|
| Arena turns run on the same global `S` as single-player | `S` is swapped only inside a synchronous step and restored in `finally`; `ARENA_SANDBOX` blocks every save path. Tested with an existing single-player save in place. |
| `normalize()` calls `save()` on every step | Blocked by the sandbox flag. |
| Different JS engines (Safari vs V8) could disagree on floating point | The server is authoritative. The device sends a state hash; if it differs, the server's state wins and the player is told ("accepted with the server's numbers"). The engine uses `round`, `sqrt`, `min`, `max`, which are exact in every engine. |
| Revealing seeds lets a modified client try every card combination for the current week | Known limitation, documented in the security review. Seeds are released one week at a time, never ahead. |
| Service worker caching API responses | `/api/` is excluded from the service worker. |
| No accounts existed | Anonymous accounts: a random token on the device (only its SHA-256 is stored) and a recovery code. No email, password or personal data. |
