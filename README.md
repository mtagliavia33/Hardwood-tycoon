# 🚀 Galaxy Tycoon

An idle space tycoon game in a single HTML file. Blast ore from your home asteroid and build an empire across the galaxy.

## Features

- **Mine & refine** — tap the asteroid for ⛏️ ore (combos! crits!), refine it with 🧊 ice into 🚀 rocket fuel
- **Timed missions** — send 6 ship types from Moon Hops to 4-hour Edge Surveys and collect the cargo
- **12 planets to colonize** — from Moon Cheddar 🌕 to Umbra 🕳️, each with buildings, silos, and survey milestones
- **Deep Space expeditions** — stake fuel on push-your-luck runs; bank the pot or GO DEEPER for double
- **The Wormhole** — prestige for 🌌 Dark Matter and spend it in a 14-node tech tree you choose
- **20 collectibles** — 12 crew and 8 artifacts, each with a known way to earn it (no luck packs)
- **Galactic Market** — live ore/ice prices shared by every player; sell high, buy low
- **Weekly Galaxy Goal** — the whole server donates toward one target for a shared reward
- **6 leaderboards, private Comms chat, offline progress** — silos and missions keep working while you're away

## Play

▶ **[Play in your browser](https://mtagliavia33.github.io/Hardwood-tycoon/)**

Or download `index.html` and open it locally — the whole game is one self-contained file.

## Sync server (Railway)

`server.mjs` is a dependency-free Node server that serves the game and powers accounts, chat,
the market, the weekly goal, and the owner admin panel.

Deploy on [Railway](https://railway.app): new project → deploy this repo → set the `ADMIN_KEY`
variable to your owner passcode → attach a volume at `/data` so player data survives redeploys.
Player data lives in `/data/galaxy.json`.

## History

This repo previously hosted **Hardwood Tycoon**, a basketball idle game. The original lives on
at the [`hardwood-final`](../../tree/hardwood-final) branch. The August 2026 switch to Galaxy
Tycoon was a full fresh start — all accounts were reset (the old data file remains on the
server volume as a frozen backup).
