# 4. Data model, API and authorisation

Schema: [`migrations/0001_arena.sql`](../../migrations/0001_arena.sql) (D1 / SQLite). Server: [`arena/server/app.js`](../../arena/server/app.js).

## Tables

| Table | Holds | Integrity |
|---|---|---|
| `players` | anonymous profile: display name, avatar, crown title, privacy, friend code | `token_hash`, `recovery_hash` (SHA-256 only), `friend_code` unique |
| `rooms` | challenge, config JSON, rules version, status, current week, deadline, `version` change counter | `code` unique; status CHECK |
| `participants` | room membership: pending / joined / removed / left / declined, ready, character | UNIQUE(room, player) |
| `char_states` | authoritative game state per participant, `state_version`, turns used this week, opening measures | written only by the server's replay |
| `turns` | every accepted turn: decisions, auto flag, rules version, state hash, stats after, cash before/after | **UNIQUE(participant, week, turn)** and UNIQUE(op_id) |
| `ledger` | money lines per turn, in naira at the competition rate plus original currency/amount | lines add up to the cash change (tested) |
| `weeks` | open/final per room week, deadline, highlights | PK(room, week) |
| `week_results` | official snapshot per player per week: ranks, measures, deltas, lifetime cumulative | PK(room, week, participant); insert-or-ignore, never updated |
| `week_awards` | award winners (several rows when shared) | PK(room, week, award, participant) |
| `achievements` | earned once per player | PK(player, key) |
| `friends` | pending/accepted pairs (smaller id first) | PK(a, b), CHECK a < b |
| `invitations` | direct room invites | UNIQUE(room, to) |
| `reactions` | fixed emoji per viewer per player per week | PK(room, week, from, to) |
| `notifications` | invites, results, join requests | deterministic ids, so retries never duplicate |
| `sync_ops` | every sync op seen, accepted or rejected, with reason and result | PK(op_id): the idempotency key |
| `audit_log` | room create/settings/start/remove/leave/finalise, recoveries, reports | append-only |
| `reports` | abuse reports | UNIQUE(reporter, kind, target) |
| `rate_limits` | fixed-window counters | PK(key, window) |

## Race safety without long transactions

D1 has no interactive transactions, but `batch()` is atomic. The Arena relies on that plus constraints:

- **A turn:** one batch = `UPDATE char_states … WHERE state_version = ?` + `INSERT turns` (UNIQUE) + ledger + op log. If two requests race for the same turn, the loser's insert hits the UNIQUE key and its whole batch rolls back.
- **Starting a room:** a guarded `UPDATE rooms … WHERE status = 'lobby'` plus the `char_states` inserts (primary keys) in one batch.
- **Finalising a week:** autopilot first (same guarded turn writes), then one batch with a guarded `UPDATE rooms … WHERE current_week = ?`, and `INSERT OR IGNORE` for results, awards, achievements and notifications. A second finaliser computes identical rows from identical states, so nothing changes. Tested with simultaneous requests and a forced re-run.
- Lifetime numbers (crowns, wins, records) are **counted from official rows** rather than kept as counters, so they cannot be double-counted.

## API

All routes are under `/api`. JSON in and out. Writes need `Authorization: Bearer <token>` and `X-Arena: 1`. Bodies over 64 KB are refused.

| Method and path | Who | What |
|---|---|---|
| `GET /health` | anyone | is the Arena configured (database and secret) |
| `POST /auth/anon` | anyone (8/hour per IP hash) | new player → token + recovery code |
| `POST /auth/recover` | anyone (10/hour) | recovery code → new token; the old device is signed out |
| `GET/PATCH /me` | self | profile; name, avatar, crown title, privacy |
| `GET /home` | self | rooms, invitations, unread counts (also advances due rooms) |
| `POST /rooms` | self (10/hour) | create (validated config) |
| `GET /rooms/public` | self | public lobbies |
| `GET /invite/:code` | self (30/10 min) | invitation preview |
| `POST /rooms/join` | self (20/10 min) | join by code or public id; capacity, removal and approval enforced |
| `GET /rooms/:id`, `GET /rooms/:id/version` | members (incl. pending) | room view; cheap change check for polling |
| `POST /rooms/:id/character`, `/ready` | joined members, lobby | character, ready flag |
| `POST /rooms/:id/approve`, `/remove`, `/cancel`, `PATCH /settings`, `POST /start` | host, lobby | host controls |
| `POST /rooms/:id/invite` | host (or members if allowed) | invite accepted friends only |
| `POST /rooms/:id/leave` | member | leave (after the start: results stay, autopilot plays on) |
| `GET /invitations`, `POST /invitations/:id` | invitee | list, accept/decline |
| `GET /rooms/:id/play` | joined member | my state, version, turns used, this week's seeds, deadline |
| `POST /sync` | self (60/min) | up to 20 queued turn ops, each answered accepted / rejected with reason |
| `GET /rooms/:id/board?week=current\|N\|lifetime` | joined member | live, official or whole-challenge standings |
| `GET /rooms/:id/weeks/:n` | joined member | ceremony data from official snapshots |
| `POST /rooms/:id/react` | joined member | emoji reaction to an official result |
| `GET /rooms/:id/history` | joined member (own data) | my results, ledger, turns, sync log |
| `POST /rooms/:id/rematch` | member of a complete room | new room, everyone invited |
| `GET /players/:id`, `GET /achievements`, `GET /leaderboard`, `GET /rivals/:id` | self | profile (privacy-checked), achievements, global board (public profiles), head-to-head |
| `GET/POST /friends`, `POST /friends/:id` | self | friend code, requests |
| `GET /notifications`, `POST /notifications/read` | self | in-app notification records |
| `POST /report` | self (10/hour) | report a player or room |

## What a player can and cannot change

| Data | Can change | Only through |
|---|---|---|
| Own money, stats, state | nobody directly | the server's replay of their own valid decisions for the open week |
| Another player's anything | no | – |
| Rankings, results, awards, achievements | no | the server's finaliser |
| Server timestamps, deadlines | no | the server clock |
| Rules of a started room | no | rules are frozen at the start (settings are lobby-only and un-ready everyone) |
| Room settings, removals, approvals, start, cancel | host | lobby only |
| Profile, privacy | self | `PATCH /me` |

## Privacy

- Inside a room, members always see each other's rank, names and money. In *money only* rooms, other players' life stats, Life Balance and moves are hidden (on the board, ceremony and comparison).
- Profiles: *public* (anyone; listed on the lifetime board), *members* (people who shared a challenge), *private* (only the player).
- The share card contains only the sharer's own numbers.
- No email, phone, real name or location is collected. IP addresses are only used as salted hashes for rate limits.
