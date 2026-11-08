# Build your own spoiler-free fantasy tracker (Fleaflicker)

> **For the AI assistant reading this (ChatGPT, Claude or similar):** the person who gave you this file wants their own version of an app called **Blindside**, to use and customise. Everything below was worked out from the real Fleaflicker API and the shipped app, so trust these details over assumptions. Work step by step: first ask what they want changed, then give complete files they can copy, then the deploy steps. If they've also attached an APK, it is only a wrapper around a hosted copy of the web app (see section 7), so the web app is still the thing to change.

---

## 1. What the app does

People who watch NFL highlights after the games don't want fantasy results spoiled. Blindside lets them:

- Pick a Fleaflicker league and their team.
- See the NFL games that involve their starters or their opponent's starters, in kickoff order.
- **Tick** each NFL game once they've watched it. Only then are that game's fantasy points revealed, so the matchup total builds up as they go.
- See the win/loss result only once every relevant game is ticked.

It's a mobile-first, dark-theme, installable web app (PWA). It works on a phone home screen and in a desktop browser.

### Current features (all shipped)

**Leagues and teams**
- Add a league by its Fleaflicker league ID (it's in the league's URL). The app lists the teams; tap yours.
- Several leagues can be saved. Your team's name at the top opens a **league switcher** sheet.
- With two or more leagues, the switcher also has an **All leagues** row. That view shows your matchups in every league and the NFL games across all of them, with one **You (green) | Opp (orange)** line per league under each game.
- Settings (the gear icon) has: **Change team**, **Hide watched games**, **Remove league**, and **Make this my own**.

**Week**
- One selected week is shared across the whole app. Switching leagues or opening All leagues keeps the week you're on.
- On first open it picks the current NFL week. The exception: if none of this week's starters have kicked off yet and last week isn't finished, it opens on last week (handy for a Monday-night catch-up on a Tuesday).
- The week picker has ‹ › buttons and a dropdown.

**Matchup card (top of the screen)**
- One row per team: the team name, "N players left" (starters whose NFL game isn't ticked yet), and the score.
- **A score only appears once at least one game is ticked.** Before that there is no placeholder text, just the names and counts.
- A progress bar and "X / Y games revealed" with a percentage.
- A win/lose banner ("You win", "You lose", "Tie", or "You lead/trail (still in progress)") appears only once every game is ticked.
- Totals animate like slot-machine reels when they change. Only the changing digits spin, the reels land on the exact total, and the animation is skipped if the phone's "reduce motion" setting is on.

**Bottom navigation (floating)**
- Three tabs: **Games**, **Lineups** and **League**.
- The bar slides away when you scroll down and comes back when you scroll up. It's always shown near the top and at the very bottom of the page.

**Games tab**
- Each NFL game is one card: the two teams, the kickoff time or "Final", a LIVE badge while a game is in progress, a **Revealed / Hidden / Not started** pill, and the You and Opp starters' last names.
- Once a game is ticked, each starter's points are shown next to their name.
- Tap a card to tick or un-tick it. Games that haven't kicked off can't be ticked.
- Card header icons: a tick icon marks every game watched (it asks for confirmation, because it can reveal results), a counter-clockwise arrow resets the week's ticks, and an eye icon hides or shows games you've already ticked.
- **Hide watched:** a game you tick while hiding stays on screen for 5 seconds with its points visible and a bar counting down, then it drops out. This is so you can read the points before the game disappears. Tapping it again during those 5 seconds un-ticks it.

**Lineups tab**
- Both starting lineups side by side: each slot shows the player, position and team, and their points once that player's game is ticked. Bye weeks show "BYE".

**League tab**
- Every matchup in the league (yours first), with each team's players left and score once something is ticked. A leader is highlighted only once that matchup is fully watched.

**Watched state**
- Ticking a game is saved **once for all your leagues**, per season and week. Watching a real game doesn't depend on which fantasy league you're looking at.
- Resetting a week clears it everywhere.
- Everything is stored in the browser's `localStorage` on that device only.

---

## 2. The one hard requirement: CORS

Fleaflicker's API sends **no `Access-Control-Allow-Origin` header**, so a browser page **cannot** call it directly. The app needs a small backend on the same origin that proxies `/api/*` to Fleaflicker. Don't use third-party CORS proxies.

The easiest free option is a **Cloudflare Worker with static assets**: one deploy serves the web app and the proxy.

### Proxy (`src/proxy.js`): allowlisted and locked to Fleaflicker

```js
const UPSTREAM = 'https://www.fleaflicker.com/api/';
const METHODS = {
  FetchLeagueStandings: ['league_id', 'season'],
  FetchLeagueScoreboard: ['league_id', 'season', 'scoring_period'],
  // NOTE: Boxscore returns HTTP 400 if `season` is sent, so it is not forwarded.
  FetchLeagueBoxscore: ['league_id', 'scoring_period', 'fantasy_game_id'],
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function proxyFleaflicker(url) {
  const method = url.pathname.replace(/^\/api\//, '');
  if (!Object.prototype.hasOwnProperty.call(METHODS, method)) return json(404, { error: 'Unknown API endpoint' });
  const out = new URLSearchParams({ sport: 'NFL' });
  for (const key of METHODS[method]) {
    const v = url.searchParams.get(key);
    if (v == null || v === '') continue;
    if (!/^\d{1,12}$/.test(v)) return json(400, { error: `Invalid ${key}` });
    out.set(key, v);
  }
  if (!out.has('league_id')) return json(400, { error: 'league_id is required' });
  if (method === 'FetchLeagueBoxscore' && !out.has('fantasy_game_id')) return json(400, { error: 'fantasy_game_id is required' });
  let r;
  try {
    r = await fetch(new URL(`${method}?${out}`, UPSTREAM), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  } catch { return json(502, { error: 'Could not reach Fleaflicker' }); }
  if (!r.ok) return json(502, { error: `Fleaflicker returned HTTP ${r.status}`, upstreamStatus: r.status });
  return new Response(await r.text(), { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=15' } });
}
```

### Worker entry (`worker.js`)

```js
import { proxyFleaflicker } from './src/proxy.js';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return proxyFleaflicker(url);
    return env.ASSETS.fetch(request);
  },
};
```

### `wrangler.toml`

```toml
name = "blindside"
main = "worker.js"
compatibility_date = "2025-06-01"
workers_dev = true

[assets]
directory = "./public"
binding = "ASSETS"
```

### Frontend files (`public/`)

`index.html`, `styles.css`, `app.js`, `parse.js`, `sw.js`, `manifest.webmanifest`, `make-your-own.md` and `icons/`. The app only calls relative URLs such as `api/FetchLeagueScoreboard?...`, so it works wherever it's hosted.

`sw.js` is a network-first service worker that caches only the app shell. It must never cache `/api/` responses, so scores are always fresh and never kept on the device.

**Pages alternative:** if you'd rather have a `<name>.pages.dev` address, put the same proxy in `functions/api/[[path]].js`:

```js
import { proxyFleaflicker } from '../../src/proxy.js';
export const onRequestGet = ({ request }) => proxyFleaflicker(new URL(request.url));
```

Then deploy the repo as a Pages project with build output directory `public`.

---

## 3. Fleaflicker API: what the real responses look like

Base: `https://www.fleaflicker.com/api/`. It's public and needs no login. Always send `sport=NFL`.

| Endpoint | Params | Used for |
|---|---|---|
| `FetchLeagueStandings` | `league_id`, `season` | Team picker |
| `FetchLeagueScoreboard` | `league_id`, `season`, optional `scoring_period` (NFL week) | Current week, week list, matchups |
| `FetchLeagueBoxscore` | `league_id`, `scoring_period`, `fantasy_game_id` (**no `season`, or you get a 400**) | Lineups and per-game points |

### Standings
`divisions[].teams[]` → `{ id, name, owners: [{ displayName }] }`, plus `league.name` and `season`.
⚠️ It also contains `recordOverall`, `pointsFor` and `streak`. **Never show these**, because they spoil results.

### Scoreboard
- Without `scoring_period` it returns the **current** week. `schedulePeriod.ordinal` is the week returned.
- `eligibleSchedulePeriods[]` lists the season's weeks; the one with `containsNow` / `low.isNow` is the current week.
- `games[]` → `{ id, away: { id, name }, home: { id, name } }`. `id` (a string) is the `fantasy_game_id`. It also has scores; never read them.

### Boxscore
- `game.away.id` / `game.home.id` tell you which side is which team.
- `lineups[]`: the entry with `group: "START"` holds the **starters**. Ignore the bench and `INJURED` entries.
- Each slot: `{ position: { label }, away?: Player, home?: Player }`. A missing side is an empty slot. Labels include `QB`, `RB`, `WR`, `TE`, `RB/WR/TE` (flex) and `QB/RB/WR/TE` (superflex).
- Player: `proPlayer { id, nameShort, nameFull, nameLast, position, proTeamAbbreviation }` and **`requestedGames[]`**.

**Linking points to the real NFL game (the key part):**

```
requestedGames[] = one entry per NFL game that week:
  { game: { id, away: { abbreviation }, home: { abbreviation }, startTimeEpochMilli, status? },
    pointsActual?: { value },          // this player's fantasy points from that game
    participant?: "HOME" }             // present if he was on the home team, absent if away
  or { isBye: true }                   // bye week, no game
```

- Use `game.id` as the NFL game key. **Don't** use `proTeamAbbreviation`: it's the player's *current* team, and a traded player still points to the game he actually played in.
- `game.status === "FINAL_SCORE"` once a game is final. It's absent before kickoff. "Kicked off but not final" is treated as live.
- The `game` object also has NFL scores. Never copy them.
- Verified: the sum of the starters' `pointsActual` equals Fleaflicker's official matchup total.

### Parsing outline (`public/parse.js`)

```js
export function parseBoxscore(raw, teamId) {
  const mySide = raw?.game?.home?.id === teamId ? 'home' : 'away';
  const oppSide = mySide === 'away' ? 'home' : 'away';
  const starters = raw.lineups.find((l) => l.group === 'START') ?? raw.lineups[0];
  const games = new Map(); // NFL game id -> { id, away, home, kickoff, final }
  const slots = starters.slots.map((s) => ({
    label: s.position.label,
    me: parsePlayer(s[mySide], games),   // { name, last, pos, team, gameId, bye, points }
    opp: parsePlayer(s[oppSide], games),
  }));
  // keep only games that involve a starter, sorted by kickoff
  return { slots, games: [...] };
}
// Reveal: a player's points count toward the totals only if his gameId is in the watched Set.
```

---

## 4. Spoiler-safety rules (keep these whatever else you change)

1. Parse API JSON straight into a small in-memory model. Never keep NFL game scores, records or streaks.
2. Only put numbers into the page for games the user has ticked. Build the DOM with `textContent` / element builders, not `innerHTML` with data. (The icon SVGs are static, so they are the only exception.)
3. No numbers in the page title, error messages or `console.log`.
4. `localStorage` holds only league/team IDs, the selected week, preferences and the watched NFL game IDs. Never points.
5. The service worker caches only the app shell, never `/api/*`.
6. The team picker shows names only, with no records or streaks.
7. The "hide watched" linger keeps a game visible only because the user just ticked it. Don't let it reveal anything else.

---

## 5. Deploy (free, about 5 minutes)

**Cloudflare Workers (recommended):**
1. Put the files in a GitHub repo.
2. Go to dash.cloudflare.com → **Workers & Pages → Create → Import a repository** → pick the repo → **Deploy**. It reads `wrangler.toml`.
3. If the overview says "No URLs enabled", go to **Settings → Domains & Routes** and enable **workers.dev**.
4. Open `https://<name>.<your-subdomain>.workers.dev`.

**Or from a terminal:** `npx wrangler login`, then `npx wrangler deploy`.

**Installing on a phone:** open the URL in Chrome → ⋮ → **Add to home screen**.

**Testing locally without Cloudflare:** write a ~20-line Node/Express `server.js` that serves `public/` as static files and sends `/api/*` to `proxyFleaflicker`, then run `node server.js`.

---

## 6. Ideas for making it your own

- Change the colours, fonts or layout in `styles.css`, or the team-name display.
- Add your own league's logo (`league.logoUrl` in standings), or your own app name and icon.
- Show projected points before kickoff (`requestedGames[].pointsProjected`). Use only pre-kickoff values, because live projections can leak the score.
- Change the "hide watched" linger time (5 seconds, `LINGER_MS` in `app.js`).
- Support another platform (Sleeper, ESPN) by swapping the proxy allowlist and the parser while keeping the reveal logic.

---

## 7. Making an Android app (APK), optional

The app is a web app. To put it on Android as a real app icon, you wrap your hosted URL in a Trusted Web Activity (TWA). The APK just opens your site full-screen, so keep changing the web code.

On a computer with **Android Studio** installed (or the Android SDK and Java 17):

1. `npm i -g @bubblewrap/cli`
2. `bubblewrap init --manifest=https://<your-url>/manifest.webmanifest` and answer the prompts (package name such as `com.yourname.blindside`).
3. `bubblewrap build` produces an `app-release-signed.apk` (or `.aab`) and asks you to create a signing key the first time. **Keep that key file safe**: you need it for every update.
4. Install the APK on a phone, or upload it to Google Play (which needs the `.aab` and a developer account).

For full-screen with no address bar, publish a `/.well-known/assetlinks.json` file on your domain containing the app's signing fingerprint (Bubblewrap prints it). The files for that go in `public/.well-known/`.

An APK is not needed to use the app; the home-screen install does the same job.

---

Tell the assistant what you want changed, and ask for complete files back.
