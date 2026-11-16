# Contributing to Japa or Stay

Thanks for wanting to help! Japa or Stay is a free Naija life-sim game: play it at https://japa-or-stay.pages.dev.

## Ways to help

- **Report a bug**: open an issue saying what happened, what you expected, and your phone or browser.
- **Suggest an idea**: new life events, jobs, choices, Pidgin lines or features. Open an issue first so we can talk about it before you build it.
- **Fix something**: look for issues labelled `good first issue` or `help wanted`.
- **Improve the Pidgin or English**: spelling, grammar, or lines that don't sound natural.

## How the project is set up

- `japa-or-stay.html`: the whole game in one file (HTML, CSS and JavaScript). All art and music are made in code, so there are no image or sound files to add.
- `site/`: tab icon, app icons and the link-preview image.
- `build.js`: turns the game into the website in `dist/` (used by Cloudflare Pages).

No install step and no dependencies. You only need a browser, and [Node.js](https://nodejs.org) if you want to test the website build.

## Run it locally

1. Fork this repository on GitHub, then clone your fork.
2. Open `japa-or-stay.html` in your browser and play.
3. To test the website version:

   ```bash
   node build.js
   ```

   Then open `dist/index.html`.

## Making a change

1. Create a branch: `git checkout -b fix-short-description`.
2. Make your change. Keep it focused: one fix or feature per pull request.
3. Play through the parts you touched, in **both English and Pidgin**, and on a phone-sized screen.
4. Commit with a clear message saying what changed and why.
5. Push your branch and open a pull request against `main`. Describe what you changed and add a screenshot if it changes how something looks.

The maintainer reviews every pull request. Merged changes go live on the website automatically.

## Guidelines

- Keep the game a single self-contained file: no external libraries or trackers (the Google Fonts already in use are fine).
- Any new text a player sees needs both an English and a Pidgin version.
- Keep it fair and respectful. The game shows both japa and staying honestly, without mocking either choice or any group of people.
- Northland and every character, company and agent in the game are fictional. Don't add real people or real companies.
- Nothing in the game should read like real immigration, legal or financial advice.

## Code of conduct

By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
