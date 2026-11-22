# Japa or Stay

A Naija life-sim game: a fresh graduate has two years to decide whether to **japa** (leave Nigeria) or **stay** and build at home. Plays in the browser, in English or Pidgin. All art and music are generated in code.

- `japa-or-stay.html`: the whole game (also published as a claude.ai artifact)
- `site/`: tab icon, app icons and the link-preview image
- `build.js`: builds the website into `dist/` for Cloudflare Pages

## Run it locally

Open `japa-or-stay.html` in a browser, or build the website version:

```bash
node build.js
```

## Deploy on Cloudflare Pages

1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Pages** > **Connect to Git**, and pick this repository.
2. Build command: `node build.js`. Build output directory: `dist`. Production branch: `main`.
3. If the site address is not `https://japa-or-stay.pages.dev`, add an environment variable `SITE_URL` with the real address (it is used for the link-preview image).
4. Optional: turn on **Web Analytics** for the project (free, cookie-free visit counts).

Every push to `main` then redeploys automatically.

## Challenge Arena (multiplayer)

Friends compete in weekly challenges: who has the most money at the end of each game week, plus champions for the six life stats. It runs on the same game engine, with a small Cloudflare Pages Functions + D1 server that replays every player's decisions, and it plays offline. It appears on the website only once the database and secret are set up. Try it locally with `node build.js` then `node arena/dev/server.js` (http://localhost:8791). Design, API, security and deployment steps: [docs/arena](docs/arena/README.md). Tests: `node --test tests/arena.test.js`.

## Feedback link

Set `FEEDBACK_URL` near the top of `setupView` in `japa-or-stay.html` to a form link (for example a Google Form) to show **Send feedback** in the footer.

## Contributing

Contributions are welcome: bug reports, ideas, new life events, better Pidgin and code fixes. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE). You are free to use, change and share the code, as long as you keep the copyright notice.

## Disclaimer

Northland and every character, company and agent in the game are fictional. Nothing in the game is immigration, legal or financial advice.
