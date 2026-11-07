# Build your own spoiler-free fantasy tracker (Fleaflicker)

> **For the AI assistant reading this (ChatGPT etc.):** the person who gave you this file wants their own copy of an app called **Blindside**, which they'll then customise. Everything below was worked out from the real Fleaflicker API, so trust these details over assumptions. Build it step by step. Ask them what they'd like to change, then give them complete files they can copy, plus the deploy steps at the end.

---

## 1. What the app does

People who watch NFL highlights after the games don't want to see their fantasy score early. Blindside lets them:

- Pick their Fleaflicker league and team.
- See this week's NFL games that involve their starters or their opponent's starters.
- Tick each NFL game once they've watched it. **Only then** are the fantasy points from that game revealed, so the matchup total builds up as they go.
- See the win/loss result only once every relevant game is ticked.

It's a mobile-first, dark-theme, installable web app (PWA).

### Current features

- **League setup:** enter a league ID, pick your team from a list, and save it. Several leagues can be saved as tabs. Everything is stored in `localStorage` on the device.
- **Week picker:** opens on the current NFL week. The exception: if none of this week's starters have kicked off and last week isn't fully watched, it opens on last week.
- **Two views:** "Mine" (your matchup) and "League" (every matchup in the league).
- **Matchup card:** one row per team, with the team name, "N players left" (starters whose game isn't ticked) and the score. The score only appears once at least one game is ticked. There's no placeholder text, and a single status line reads "🔒 3/9 games watched". Once everything is ticked, it becomes a "You win / You lose" banner.
- **NFL games list** in kickoff order. Each card shows the teams, kickoff time or "Final", a LIVE badge, and which starters play in it. Once ticked, it shows each player's points. Games that haven't kicked off can't be ticked. An eye icon hides or shows games already watched.
- **Starting lineups side by side.** A player's points appear only once their game is ticked.
- **Bottom bar:** Reset · Refresh · Mark all watched (asks for confirmation first).
- Watched games are saved per league + season + week.

---

## 2. The one hard requirement: CORS

Fleaflicker's API sends **no `Access-Control-Allow-Origin` header**, so a browser page **cannot** call it directly. The app needs a tiny backend on the same origin that proxies `/api/*` to Fleaflicker. Don't use third-party CORS proxies.

The easiest free option is a **Cloudflare Worker with static assets**: the same deploy serves the web app and the proxy.

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

The frontend lives in `public/` (`index.html`, `styles.css`, `app.js`, `parse.js`, `sw.js`, `manifest.webmanifest`, `icons/`) and only ever calls relative URLs like `api/FetchLeagueScoreboard?...`.

---

## 3. Fleaflicker API: what the real responses look like

Base: `https://www.fleaflicker.com/api/`. It's public and needs no auth. `sport=NFL` is always sent.

| Endpoint | Params | Use |
|---|---|---|
| `FetchLeagueStandings` | `league_id`, `season` | Team picker |
| `FetchLeagueScoreboard` | `league_id`, `season`, optional `scoring_period` (NFL week) | Current week, week list, matchups |
| `FetchLeagueBoxscore` | `league_id`, `scoring_period`, `fantasy_game_id` (**no `season`, or you get a 400**) | Lineups and per-game points |

### Standings

`divisions[].teams[]` → `{ id, name, owners: [{ displayName }] }`, plus `league.name` and `season`.
⚠️ It also contains `recordOverall`, `pointsFor` and `streak`. **Never show these**, because they spoil last week.

### Scoreboard

- Without `scoring_period` it returns the **current** week.
- `schedulePeriod.ordinal` is the week returned.
- `eligibleSchedulePeriods[]` → `{ ordinal, low: { startEpochMilli, isNow? }, containsNow? }`. These are the season's weeks; the one with `containsNow` / `low.isNow` is the current week.
- `games[]` → `{ id, away: { id, name }, home: { id, name }, ... }`. `id` (a string) is the `fantasy_game_id`. It also has scores and results, which you never read.

### Boxscore

- `game.away.id` / `game.home.id` tell you which side is which team.
- `lineups[]`: the entry with `group: "START"` holds the **starters**. The other entries are the bench (no group) and `INJURED`; ignore those.
- Each slot: `{ position: { label: "QB" | "RB" | "RB/WR/TE" (flex) | "QB/RB/WR/TE" (superflex) ... }, away?: Player, home?: Player }`. A missing side means an empty slot.
- Player: `proPlayer { id, nameShort, nameFull, position, proTeamAbbreviation }` and **`requestedGames[]`**.

**Linking points to the real NFL game (the key part):**

```
requestedGames[] = one entry per NFL game that week:
  { game: { id, away: { abbreviation }, home: { abbreviation }, startTimeEpochMilli, status? },
    pointsActual?: { value },          // this player's fantasy points from that game
    participant?: "HOME" }             // present if he was on the home team, absent if away
  or { isBye: true }                   // bye week, no game
```

- Use `game.id` as the NFL game key. **Don't** use `proTeamAbbreviation`: it's the player's *current* team, and a traded player still points to the game he actually played in.
- `game.status === "FINAL_SCORE"` once a game is final. It's absent before kickoff, and "kicked off but not final" is treated as live.
- The `game` object also has NFL scores (`awayScore`, `homeScore`). Never copy them.
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
    me: parsePlayer(s[mySide], games),   // { name, pos, team, gameId, bye, points }
    opp: parsePlayer(s[oppSide], games),
  }));
  // keep only games that involve a starter, sorted by kickoff
  return { slots, games: [...] };
}
// Reveal: total = sum of points for starters whose gameId is in the watched Set.
```

---

## 4. Spoiler-safety rules (keep these whatever else you change)

1. Parse API JSON straight into a small in-memory model. Never keep NFL game scores.
2. Only ever put numbers into the page for games the user has ticked. Build the DOM with `textContent`, not `innerHTML` with data.
3. No numbers in the page title, error messages or `console.log`.
4. `localStorage` holds only league/team IDs and watched NFL game IDs, never points.
5. The service worker caches only the app shell, never `/api/*`.
6. The team picker shows names only, with no records or streaks.

---

## 5. Deploy (free, about 5 minutes)

**Cloudflare (recommended):**
1. Put the files in a GitHub repo.
2. Go to dash.cloudflare.com → **Workers & Pages → Create → Import a repository** → pick the repo → **Deploy**. It reads `wrangler.toml`.
3. If the overview says "No URLs enabled", go to **Settings → Domains & Routes** and enable **workers.dev**.
4. Open `https://<name>.<your-subdomain>.workers.dev`. To install on Android, use Chrome → ⋮ → **Add to home screen**.

**Or from a terminal:** `npx wrangler login`, then `npx wrangler deploy`.

To test locally without Cloudflare, write a ~20-line Node/Express `server.js` that serves `public/` and calls `proxyFleaflicker` for `/api/*`, then run `node server.js`.

---

## 6. Ideas for making it your own

- Change the colours, the team-name display, or show your league's logo (`league.logoUrl` in standings).
- Show projected points before kickoff (`requestedGames[].pointsProjected`). Use only pre-kickoff values, because live projections can leak the score.
- Auto-refresh every few minutes while games are live.
- Support another platform (Sleeper, ESPN) by swapping the proxy allowlist and the parser while keeping the reveal logic.

Tell the assistant what you want changed, and ask for complete files back.
