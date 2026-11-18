# Engagement rules for every Short

Use this checklist when you script, edit and publish a skit. The current skits already get rules 1 and 3 mostly right (Chinedu asks "JAPA or STAY?" and an A/B card stays up for 5 seconds). The gaps are the logo outro, the titles and the pinned comments.

## 1. Ask a question they can't resist answering (comments)

- End on a **dilemma**, not on the answer. Cut or freeze the moment before the character decides.
- The voiced line is in character, e.g. *"If na you, wetin you go do?"*, then the A/B choice.
- **One-word answers:** every option starts with a short word people can type: `A: SEND` / `B: SAVE`, `A: JAPA` / `B: STAY`. A label they can type in one go gets more comments than "A" alone.
- The question has to be **specific to this story** ("Send the school fees or save?"), not the generic "Japa or stay?" every time.

## 2. Make the subscribe ask about the story

- Say **"Subscribe"** on YouTube ("Follow" is the TikTok/Instagram word). Keep "Follow" for the TikTok and Reels versions.
- Tie the ask to what happens next: **"Subscribe for Part 3: Mama lands in London"** beats "Subscribe for more".
- Optional in-character line from Mama or Tunde, e.g. *"If you no subscribe, I go tell your mama."* Use it once every few episodes so it stays funny.
- Every story Short belongs to the **"Chinedu's Japa Story"** playlist, and each one says what number Part it is.

## 3. Where and how

| Rule | Why |
|---|---|
| The ask goes in the **last 3–5 seconds**, right after the punchline | Viewers are still feeling the joke; asking at the start makes them swipe |
| **No logo or link outro after the A/B card.** End on the question | The outro is where people swipe away, and a Short that ends on the question loops straight back into the story. The game link goes in the pinned comment |
| Text stays above the bottom 25% and off the right edge | YouTube's title and like/comment buttons cover those areas |
| The card is readable with the sound off | Most Shorts get watched muted at first |
| The ask takes under 5 seconds | A long ending lowers how much of the video people watch |

### The tool: `tools/end-card.js`

```powershell
node tools/end-card.js in.mp4 out.mp4 --trim 3.4
```
Cuts the last 3.4 s (the logo outro) so a skit ends, and loops, on its own A/B card. Check the last `.srt` caption's end time so you don't cut a caption off (for `ep01-upload.mp4` the last caption ends at 31.9 s, so `--trim 3.4` leaves 32.3 s).

```powershell
node tools/end-card.js in.mp4 out.mp4 --question "Send the money or save am?" --a "A: SEND: cut your own spending" --b "B: SAVE: send less" --cta "Subscribe for Part 3" --hold 1.5
```
Adds an A/B and subscribe card to a video that has no ask (a trailer, how-to or re-cut). `--hold` freezes the last frame for a cliffhanger pause. The font has no emoji, so keep card text plain.

YouTube doesn't let you replace the video in an existing upload, so this is for new Shorts, Part 2s, and the TikTok/Reels versions.

## 4. Outside the video

- **Pin a comment within the first hour** that asks the same A/B question and asks *why*. Put the game link there: https://japa-or-stay.pages.dev
- **Reply to the first 10–20 comments.** Ask a follow-up question so they reply again.
- **Title:** hook first (that's what shows in the feed), question last: *"His First UK Salary Lasted 9 Days 😭💷 Send or Save?"*
- **Description:** the first two lines show before "more", so the A/B question goes right after the one-line story.
- **Next Part:** when one answer wins, say so in Part N+1: *"Una vote B… so Chinedu saved am. See wetin happen."* That shows viewers their comments change the story, and they'll comment again.

Copy for each existing Short: [shorts-engagement-pack.md](../shorts-engagement-pack.md).
