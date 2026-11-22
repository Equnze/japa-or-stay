# Japa or Stay: Challenge Arena

A multiplayer mode for the existing game. One player creates a challenge, friends join with a code or a WhatsApp link, and each player lives their own Naija life (a Lagos job, a shop in Kano, a flight to Northland). At the end of every game week the server ranks everyone: the **Weekly Money Champion** has the most eligible cash, and six more champions win Strength, Happiness, Body, Family Matters, Your People and Clout.

The single-player game is unchanged. The Arena only appears on the website when its server side (a Cloudflare D1 database and a secret) is set up.

| # | Document | What's in it |
|---|---|---|
| 1 | [Architecture report](01-architecture-report.md) | What the project is, what was reused, the server-replay design, what changed, concerns |
| 2 | [Game design](02-game-design.md) | Rooms, game weeks and turns, deadlines and autopilot, carry-forward, the money formula, Life Balance, awards, achievements, offline rules |
| 3 | [Screens and flows](03-screens-and-flows.md) | All 24 screens with purpose and states, flow and sync diagrams |
| 4 | [Data and API](04-data-and-api.md) | Tables, race safety, every endpoint, who can change what, privacy |
| 5 | [Security review](05-security-review.md) | Threats, controls, the tests that prove them, known limitations |
| 6 | [Deployment and operations](06-deployment-and-operations.md) | Local dev, Cloudflare setup, limits, rule versions, backups, monitoring |

## Implementation status

| Phase | Status |
|---|---|
| 1. Project audit | Done |
| 2. Game design | Done (rules version `arena-1`) |
| 3. UI/UX | Done: 24 screens plus money journey and rivalry |
| 4. Database and authorisation | Done: migration, API-layer authorisation, constraints |
| 5. Rooms | Done: create, settings, code and link invites, WhatsApp share, approval, remove, cancel, ready, start, scheduled start |
| 6. Gameplay | Done: every turn runs on the real game engine, Year 1, Abroad and Build chapters, endings |
| 7. Weekly scoring | Done: deadlines, autopilot, race-safe finalisation, ranks with ties, awards, achievements, highlights |
| 8. Offline and realtime | Done: IndexedDB queue, retries with back-off, conflict handling, sync log; realtime by version polling |
| 9. Leaderboards and polish | Done: live/official/whole-challenge boards, 10 views, comparison, ceremony, charts, share card, reduced motion |
| 10. Testing and release | 19 automated tests pass; verified in a browser on desktop and phone sizes. **Not deployed** (needs your Cloudflare D1 and secret). |

Not built (phase two): room chat, spectator mode, team play, tournaments across rooms, push notifications (notification records are stored, but there is no notification list screen yet), a moderation dashboard, Pidgin for the Arena's own screens (event text inside turns does follow the language setting).

## Files

```
arena/shared/rules.js        scoring, ranking, awards, achievements, room validation (browser + server + tests)
arena/shared/turn.js         one turn on the game engine, seeded dice, state hash
arena/build-engine.js        wraps the game script into arena/server/engine.generated.js at build time
arena/server/app.js          the API
arena/client/arena.js/.css   the screens, offline storage and sync
arena/dev/                   local server (node:sqlite), D1 shim, test bots
functions/api/[[path]].js    Cloudflare Pages Function entry
migrations/0001_arena.sql    D1 schema
tests/arena.test.js          19 tests, including a four-player, four-week season
```
