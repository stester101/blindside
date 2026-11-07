# Blindside: spoiler-free fantasy tracker for Fleaflicker

Watching NFL highlights after the games? Blindside keeps your Fleaflicker fantasy matchup hidden. You tick the real NFL games you've watched, and it reveals points only from those games, so your matchup total builds up as you go.

- Everything starts hidden (`••`). There are no scores, player points or win/loss.
- Ticking a game reveals the points of every starter (yours and your opponent's) who played in it.
- The win/loss result stays locked until every relevant game is ticked.
- You can save several leagues as tabs. Each league remembers your team, and watched games are saved per league and week (all in `localStorage`, on your device only).
- It's a mobile-first, dark-theme PWA you can install to your home screen.

## How it works

```
phone ──► your host (Cloudflare Worker or Node/Express)
            ├── /            static PWA (public/)
            └── /api/<Method> ──► https://www.fleaflicker.com/api/<Method>  (allowlisted)
```

Fleaflicker blocks cross-origin browser calls, so the app ships with a tiny proxy. The frontend only ever calls its own origin. The proxy:

- forwards only `FetchLeagueStandings`, `FetchLeagueScoreboard` and `FetchLeagueBoxscore`;
- forwards only numeric `league_id`, `season`, `scoring_period` and `fantasy_game_id`;
- can only reach `https://www.fleaflicker.com/api/`;
- never passes Fleaflicker error pages through and never logs responses.

The same proxy code (`src/proxy.js`) is used by `worker.js` (Cloudflare) and `server.js` (Node/Express, e.g. Render).

## Deploy (free) → public URL

### Option A: Cloudflare Workers (recommended: free, fast, no cold starts)

**From the dashboard, no CLI needed:**

1. Push this repo to GitHub (it's already at `stester101/blindside`).
2. Go to <https://dash.cloudflare.com> → sign up or log in (free plan).
3. **Workers & Pages** → **Create** → **Import a repository** → connect GitHub → choose `blindside`.
4. Leave the defaults. Cloudflare reads `wrangler.toml`. The build command can stay empty, and the deploy command is `npx wrangler deploy`.
5. Click **Deploy**. Your URL is `https://blindside.<your-subdomain>.workers.dev`.
   Every push to the main branch redeploys automatically.

**From your computer, with the CLI:**

```bash
git clone https://github.com/stester101/blindside && cd blindside
npx wrangler login      # opens a browser to authorise your Cloudflare account
npx wrangler deploy     # prints https://blindside.<your-subdomain>.workers.dev
```

### Option B: Render (free web service)

1. Go to <https://dashboard.render.com> → **New** → **Blueprint** → connect GitHub → pick `blindside` → **Apply**. `render.yaml` sets everything up.
   Or use **New → Web Service**: Runtime *Node*, Build `npm install`, Start `npm start`, Instance type *Free*.
2. Your URL is `https://blindside-xxxx.onrender.com`.

On Render's free plan the service sleeps after about 15 minutes idle, so the first load after that can take 30–60 seconds. Cloudflare doesn't have this problem.

## Install on your phone (Galaxy Z Flip 6 / Android)

Open the URL in Chrome → **⋮** menu → **Add to home screen** → **Install**. It then opens full-screen like an app. (Samsung Internet: menu → **Add page to** → **Home screen**.)

## Using it

1. On first launch the league ID **219707** is pre-filled and its teams load. Tap your team.
2. Tap **+** to add more leagues (e.g. `332885`). Each league becomes a tab showing your team name.
3. The week picker defaults to the current NFL week. Use ‹ › or the dropdown to change it.
4. Tick the games you've watched. Games that haven't kicked off can't be ticked. Games in progress show **LIVE**, and ticking one reveals the points so far.
5. **Mark all watched** asks for confirmation first, because it can reveal the result. **Reset** hides everything again for that week. **↻** re-fetches from Fleaflicker.

**Sharing with league mates:** send them `https://<your-url>/?league=<their league id>`. That pre-fills the league ID so they just tap their own team. Nothing in the app is tied to one person.

## Run locally

```bash
npm install
npm start              # http://localhost:8787
npm test               # unit tests (parsing + proxy allowlist)
```

If you're behind an HTTP proxy, run `NODE_USE_ENV_PROXY=1 npm start` (Node 22.21+ / 24).

There is also an end-to-end check that drives the real app against the real API with Playwright:
`node scripts/e2e.mjs http://localhost:8787` (requires Playwright to be installed).

## Fleaflicker API notes (from real responses, league 219707, season 2026)

| Endpoint | Used for | Notes |
|---|---|---|
| `FetchLeagueStandings?sport=NFL&league_id&season` | team picker | `divisions[].teams[] {id, name, owners[]}`. Also includes records/points/streaks, which are **never displayed** (they'd spoil last week). |
| `FetchLeagueScoreboard?sport=NFL&league_id&season[&scoring_period]` | current week, week list, opponent | Without `scoring_period` it returns the current week. `schedulePeriod.ordinal` = week, `eligibleSchedulePeriods[]` = weeks 1–17 (`containsNow` marks the current one). `games[]` have `id` (= `fantasy_game_id`), `away`/`home` team ids and names. |
| `FetchLeagueBoxscore?sport=NFL&league_id&scoring_period&fantasy_game_id` | lineups and per-game points | **Returns HTTP 400 if `season` is passed**, so the proxy drops it. `lineups[]` with `group: "START"` holds the starters (the bench and IR groups are ignored). Each slot is `{position.label, away?, home?}`. |

**Linking points to NFL games.** Each player in a slot has `requestedGames[]`, one entry per NFL game that week:
`{ game: {id, away.abbreviation, home.abbreviation, startTimeEpochMilli, status}, pointsActual: {value}, participant? }`.
On a bye week, the entry is `{ isBye: true }` with no game. `participant: "HOME"` is present when the player was on the home team, and missing for away players. The app keys everything on `game.id` (the NFL game id). It doesn't use the player's `proTeamAbbreviation`, because that's his *current* team: a player traded after the game still shows his new team, while `requestedGames` correctly points to the game he actually played in. The sum of the starters' `pointsActual` equals Fleaflicker's official matchup total.

Fleaflicker game `status` is `FINAL_SCORE` once a game is final and absent before kickoff. Blindside treats "kickoff passed but not final" as live.

## Spoiler safety

- The raw API JSON is parsed straight into a small in-memory model and then discarded. NFL game scores are never copied into the model.
- The DOM only ever receives values for watched games. Placeholders are always `••`. The page title is always "Blindside".
- There are no `console.log` calls with data, no numbers in error messages, and no scores in `localStorage` (it only stores league/team IDs and watched NFL game IDs).
- The service worker caches only the app shell. `/api/*` is never cached.
- The e2e test records every text node that enters the DOM and checks that no point value appears before a game is ticked.
