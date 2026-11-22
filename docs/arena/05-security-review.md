# 5. Security and anti-cheat review

Scope: `arena/server/app.js`, `arena/shared/*`, `arena/client/arena.js`, `migrations/0001_arena.sql`, `functions/api/[[path]].js`. Tests: `tests/arena.test.js` (19 tests).

## Model

The server is authoritative for money, stats, turns, deadlines, rankings, awards and achievements. A device can only say *which cards and which choices*; the server replays them on the real engine with seeds the device cannot predict before the week opens.

## Threats and controls

| Threat | Control | Test |
|---|---|---|
| Money or stat manipulation (edited local storage, forged numbers in a request) | No endpoint accepts amounts or stats; extra fields are ignored; the server's state replaces the device's whenever the hashes differ | "turns are replayed by the server…", "a forged or impossible decision…" |
| Impossible decisions (card not in hand, twice, over time budget, unaffordable, invalid choice) | The turn runner repeats the game's own checks before every step; invalid turns are rejected and logged | "a forged card is rejected and recorded…" |
| Duplicate rewards / replayed offline ops | `sync_ops` op-id key returns the stored answer; `turns` UNIQUE(participant, week, turn); guarded `state_version` | "retries, replays and stale turns cannot pay twice", "offline play…" |
| Repeated weekly finalisation, race conditions | Guarded room update + insert-or-ignore snapshots in one atomic batch; lifetime counts derived from official rows | "weekly finalisation runs once…" |
| Manipulated device clocks | Only `Date.now()` on the server is used; client timestamps are ignored | "the deadline is the server's…" (sends a fake `clientTime`) |
| Late offline actions changing finished weeks | Ops for a closed week or after the cutoff are rejected; finished weeks are insert-only | same test, and the 4-player season |
| Forged player ids | Identity comes only from the bearer token (256-bit random, stored as SHA-256); ids in bodies are only targets checked against membership | "writes need the Arena header and a valid session" |
| Unauthorised room joining | The invite code (8 chars from 32 symbols ≈ 10¹²) only shows the room; joining checks lobby status, capacity, removal and approval; 20 join attempts per 10 min per player | "approval rooms…", "creating, joining…" |
| Cross-room data access | Every room read checks joined membership; history returns only the caller's own rows | "privacy…" (outsider gets 403) |
| Unauthorised leaderboard or rule changes | No write path exists for results; settings are host-only and lobby-only | "creating, joining…" |
| CSRF | Bearer tokens (not cookies) plus a required `X-Arena: 1` header on every write | header test |
| Stored XSS via names | Server strips control and markup characters (`< > \``), the client escapes every value with the game's `esc()`, avatar fields must match `^[a-z0-9_-]{1,24}$` | config test checks cleaning |
| Abuse | Rude-word filter on names and award titles, fixed-emoji reactions (no free text), no chat or private messages, report endpoint, host removal, rate limits | – |
| Secrets in the frontend | None. `ARENA_SECRET` lives only in Cloudflare settings; the dev secret is generated into the git-ignored `.arena-dev/` | – |
| Single-player data | The sandbox flag blocks every save path during Arena turns | "Arena turns on the page engine never change the single-player game…" |

## Known limitations (honest list)

1. **Seed scouting.** To allow offline play, a device receives the current week's seeds. A modified client could try every card combination for those turns before sending the best one. It cannot change the dice, play ahead, or touch other weeks. Possible later fixes: a room option for *online-only* play where the server reveals each step after the decision, and anomaly checks on win rates.
2. **Anonymous accounts.** Losing the device and the recovery code loses the Arena profile. There is no email recovery by design (no personal data).
3. **Realtime is polling.** A tiny version check every 4 s (lobby) or 15 s (game), only while the page is visible. Durable Objects with WebSockets could replace it later; correctness never depends on it.
4. **Rate limits use D1 writes**, which is fine for small groups; at large scale move them to a KV or Durable Object counter or Cloudflare's rate-limiting rules.
5. **Reports are stored, not reviewed.** There is no moderation dashboard yet; reports are in the `reports` table.
6. **Lazy clock.** Weeks are finalised by the first request after the deadline (any member opening the app). Results are correct whenever they are computed, because they come from stored states; adding a scheduled Worker (cron) would make them appear without anyone visiting.
7. **D1 has no row-level security.** All access goes through the API, which is the only database client.
