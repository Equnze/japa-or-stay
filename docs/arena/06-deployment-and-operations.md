# 6. Deployment and operations

Nothing here has been deployed. The steps below need your Cloudflare account, and the first one creates a new database, so run them yourself (or ask me to, with your go-ahead).

## Local development

```powershell
node build.js
```

```powershell
node arena/dev/server.js
```

Open http://localhost:8791 and press **🏆 Multiplayer Arena**. Data lives in `.arena-dev/` (git-ignored); delete the folder to start fresh. Useful extras:

- `node arena/dev/bots.js join CODE 3` adds three local test players to a lobby; `node arena/dev/bots.js play ROOM_ID` plays their turns for the current week.
- `POST /api/_dev/skew {"hours": 25}` on the dev server moves its clock forward to test deadlines and autopilot (dev server only; the production API has no such route).
- Tests: `node --test tests/arena.test.js` (19 tests, about 2 seconds, in-memory databases only).

## First production setup (Cloudflare Pages + D1)

1. Create the database:

   ```powershell
   npx wrangler d1 create japa-arena
   ```

2. Apply the schema (additive, creates new tables only):

   ```powershell
   npx wrangler d1 migrations apply japa-arena --remote
   ```

3. In the Cloudflare dashboard: **Workers & Pages → japa-or-stay → Settings → Bindings → Add → D1 database**, variable name `DB`, database `japa-arena`. Do this for Production (and Preview if you want previews to have the Arena).
4. **Settings → Variables and secrets → Add → Secret**, name `ARENA_SECRET`, value: 64 random characters. Generate one with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Never change it once a challenge is running: it seeds every turn, and changing it would make in-progress weeks replay differently.
5. Push to `main`. The build command stays `node build.js`; it generates `arena/server/engine.generated.js`, and Cloudflare then bundles `functions/api/[[path]].js`.
6. Open https://japa-or-stay.pages.dev, check that **🏆 Multiplayer Arena** appears (the page shows it only when `/api/health` says the database and secret are set), create a test challenge and play one turn.

Until steps 1–4 are done, the site behaves exactly as today: `/api/health` reports not ready and the Arena button stays hidden.

## Limits and costs

- D1 free tier: 5 GB storage, 5 million rows read and 100,000 rows written a day. One turn writes about 8–15 rows; one finalised week about 10 rows per player. A 6-player room with 4 turns a week uses a few hundred writes a week.
- Workers free tier: 100,000 requests a day. Polling is the biggest user: one open lobby tab makes about 900 requests an hour, a game tab about 240. Polling stops when the tab is hidden or offline.
- Rooms hold 2–8 players or are unlimited; a host can have 10 open rooms. Very large unlimited rooms work, but closing a week where many players missed turns takes several requests (about one per 6 autopilot turns), and the live board and ceremony read every member each time. For rooms of hundreds of players, Workers Paid and a scheduled closer are recommended.

## Changing the rules later

Add a new entry (for example `arena-2`) to `RULES` in `arena/shared/rules.js` and point `CURRENT` at it. Rooms keep the version they were created with, so running and finished challenges are never rescored. Changing game content (cards, events) changes how *future* turns play for everyone; it never touches stored turns or results.

## Backups and rollback

- `npx wrangler d1 export japa-arena --remote --output arena-backup.sql` before any migration.
- D1 Time Travel can restore the database to any minute in the last 30 days (paid plan: 30 days; free: 7).
- Rolling back the site (Cloudflare Pages → Deployments → Rollback) does not touch the database. The schema is additive, so an older site simply ignores the Arena tables.

## Monitoring

- Cloudflare **Workers & Pages → japa-or-stay → Functions → Logs** shows server errors (`Arena error …`).
- Useful queries (`npx wrangler d1 execute japa-arena --remote --command "…"`):
  - rejected syncs by reason: `SELECT reason, COUNT(*) FROM sync_ops WHERE status='rejected' GROUP BY reason`
  - reports to review: `SELECT * FROM reports ORDER BY created_at DESC LIMIT 50`
  - rooms overdue for finalisation: `SELECT id, name, current_week FROM rooms WHERE status='active' AND week_deadline_at < strftime('%s','now')*1000`
