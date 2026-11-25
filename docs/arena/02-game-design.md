# 2. Game design: rules, scoring and fairness

Rules version **`arena-1`** (`arena/shared/rules.js`). A room stores the version it was created with; finalised weeks are never recalculated.

## Rooms

- 2–8 players (default 6), or **Unlimited** (no seat cap; stored as `maxPlayers: 0`). Private (code only) or public (listed). Optional host approval of join requests. Host-only or all-member friend invitations.
- Settings: name, description, length (4, 8, 12, 16 or 52 game weeks), turns per game week (2–6, default 4; a life lasts 104 in-game weeks, so game weeks × turns may be at most 104, which means 52-week challenges have 2 turns a week), game-week length (1, 2, 3 or 7 real days, default 7), late-sync grace (0–180 minutes, default 60), end-early-when-everyone-has-played (default on), starting money (₦100k / ₦200k / ₦500k), difficulty, stats visibility (everyone / money only), optional start date, renamed award titles.
- Changing settings un-readies everyone. Nobody can join after the start (late joiners can never collect earlier weeks). Removed players cannot rejoin. The host cannot leave an unstarted room (they cancel it instead).

## Game weeks and turns

- A **game week** is one competition round on the **server clock**, independent of real calendar weeks and of any device clock.
- A **turn** is one in-game week of the normal game: pick cards with 21 time blocks, face up to two life events, settle up.
- Every player gets **exactly the same number of turns** each game week. Turns cannot be bought, skipped ahead or played faster than the schedule.
- **Deadline policy.** A turn counts if it reaches the server before `deadline + grace`. After that the week is closed. Turns not played by then are played by **autopilot** (work or job hunt, then rest; the first option on every event; keep building at the end of Year 1). Autopilot turns are marked in every history view.
- If *end early* is on and everyone has used their turns, the week closes immediately and the next one starts now. Otherwise the next week starts at the previous deadline, so the schedule never drifts.
- **Story endings.** If a life reaches a final ending mid-season (deported, settled abroad, councillor…), that player's numbers freeze and stay on the table. At the end of Year 1 the player chooses how Year 2 continues (Build, or keep chasing the visa).

## Carry-forward

The authoritative state of each player is stored after every accepted turn, so everything carries forward exactly: cash, dollars, debts, assets, skills, relationships, unresolved events and the chapter of the story. Week 3 opens on week 2's closing state, always. Stats are **current values**, never summed: Strength 60 → 65 → 62 is 62 in week 3. Lifetime gains, losses, highs, averages and the full per-turn history are stored separately (`week_results.cum_json`, `turns.stats_json`).

## The money table

```
Weekly Money Rank = end-of-week eligible cash
eligible cash = naira + dollars × 1,500 (competition rate, same for everyone)
              − loan-app debt − credit-card debt × 1,500
              − bank-loan repayments still to make − supplier credit
net worth     = naira + dollars × 1,500 + assets at book value − the same debts
```

Book values: ₦30,000 per business level, ₦1.5m per extra branch, ₦2.5m per land plot, ₦200,000 per house stage, ₦200,000 for solar. Borrowing raises cash but adds the same amount (or more) to debts, so a loan never raises eligible cash. The original currency of every ledger line is kept (`ledger.currency`, `ledger.original_amount`).

**Tie-breaks**: eligible cash → net worth → Life Balance. Players level on all three share the place ("1, 1, 3") and the award. Nothing uses join order or ids.

## The seven measures and Life Balance

| Measure | Game stat | Scale |
|---|---|---|
| Money | eligible cash | naira |
| Strength | energy | 0–100 |
| Happiness | mood | 0–100 |
| Body | health | 0–100 |
| Family Matters | family | 0–100 |
| Your People | community | 0–100 |
| Clout | clout (fans) | fans |

**Life Balance Score** (0–100) = 25% money score + 12.5% each for the other six.
- Money score = `100 × log10(eligible ÷ 10,000) ÷ log10(20,000,000 ÷ 10,000)`, clamped 0–100.
- Clout score = `100 × log10(1 + fans) ÷ log10(20,001)`, clamped 0–100.
- The four 0–100 stats count as they are.

## Awards (titles only: they never add money or stats)

| Award | Winner |
|---|---|
| Cash King / Cash Queen / Cash Boss (the winner picks their title in their profile) | most eligible cash |
| Strength, Happiness, Body, Family, People's, Clout Champion | highest current value (tie-break Life Balance) |
| Best Overall Life | highest Life Balance |
| Biggest Financial Comeback (from week 2) | biggest climb up the money table; tie-break bigger cash gain |
| Most Improved Player | biggest rise in Life Balance (must be a rise) |

Hosts can rename any award; the scoring does not change.

## Achievements (once per player, from official results only)

First Millionaire, Lagos Hustler, Business Mogul, Family First, Community Hero, Iron Strength, Happiness Master, Clout Celebrity, Financial Comeback, Balanced Life Champion, Weekly Champion, Hat-trick, Japa Made, Season Champion. Definitions are in `ACHIEVEMENTS` in `rules.js`.

## Season end

After the last week the room is complete. The final table ranks by weekly money crowns, then final eligible cash, then total awards. Rematch creates a new room with the same settings and invites everyone.

## Offline rules (as the player sees them)

- Opening a week online downloads that week's remaining turn seeds. All of those turns can then be played with no internet.
- Each finished turn is saved on the device with a unique id and sent when the connection returns, with retries and back-off.
- The server replays it. If the device's numbers differ, the server's numbers win and the player is told.
- Turns that arrive after the cutoff are not accepted and stay listed on the Sync status screen with the reason. Nothing is dropped silently.
- Next week's seeds are never released early, so nobody can play ahead.

## Highlights and recap

Each finalised week gets plain sentences built from official numbers ("Amaka takes the cash crown with ₦…", "Chidi built the most Strength (+12)"). No AI service is used.
