// Blindside Live Replay (beta): step through one NFL game one scoring play at a time.
// Spoiler rules: play data and points live only in memory. The DOM receives a scoring play only when the
// user presses the button for it. localStorage holds integers (plays revealed) and scoring coefficients only.
// No console output, no data in attributes/titles, the page title never changes.
import { parseScoreboard, parseBoxscore } from './parse.js';
import {
  buildNameIndex, joinPlayer, gameTotals, runningPoints, fitProfile, DEFAULT_PROFILE, FEATURES, round2, fmtClock, groupPlays,
} from './live-core.js';

const KEY = 'blindside:v1:';
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(KEY + k);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(KEY + k, JSON.stringify(v));
    } catch {
      /* storage blocked: still works for this visit */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(KEY + k);
    } catch {
      /* ignore */
    }
  },
};

const state = {
  leagues: store.get('leagues', []),
  lgs: [], // leagues in the newest season
  mode: 'all', // 'all' or a leagueId
  week: null,
  meta: new Map(), // leagueId -> {currentWeek, weeks}
  weekData: new Map(), // `${leagueId}:${season}:${week}` -> {matchup, matchups, model, league}
  manifest: null,
  files: new Map(), // game file cache (memory only)
  profiles: new Map(), // leagueId -> profile
  items: [], // [{lg, d}] for the shown week
  seq: 0,
  game: null, // open game session
};

/* ---------- helpers ---------- */
class ApiError extends Error {}
async function api(method, params) {
  let res;
  try {
    res = await fetch(`api/${method}?${new URLSearchParams(params)}`, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError('Network error. Check your connection and try again.');
  }
  if (!res.ok) throw new ApiError('Fleaflicker request failed. Try again in a moment.');
  try {
    return await res.json();
  } catch {
    throw new ApiError('Fleaflicker sent an unreadable response. Try again.');
  }
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const main = () => $('app');
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const fmtKick = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '');
const gameStatus = (g) => (g.final ? 'final' : g.kickoff && Date.now() >= g.kickoff ? 'live' : 'upcoming');
const gkey = (g) => `${g.away}@${g.home}`;
const sign = (n) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(1);
const approx = (n) => `~${n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
const exact = (n) => (n < 0 ? '−' : '') + Math.abs(n).toFixed(2);

/* ---------- league data (copied in small form from app.js) ---------- */
async function ensureMeta(lg) {
  let m = state.meta.get(lg.leagueId);
  if (m) return m;
  const raw = await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season });
  const p = parseScoreboard(raw, lg.teamId);
  m = { currentWeek: p.currentWeek ?? p.week, weeks: p.weeks.length ? p.weeks : [p.week] };
  state.meta.set(lg.leagueId, m);
  return m;
}

async function getWeek(lg, week) {
  const ck = `${lg.leagueId}:${lg.season}:${week}`;
  let d = state.weekData.get(ck);
  if (d) return d;
  const sb = parseScoreboard(await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season, scoring_period: week }), lg.teamId);
  d = { week, matchup: sb.matchup, matchups: sb.matchups, model: null, league: null };
  if (sb.matchup) {
    d.model = parseBoxscore(await api('FetchLeagueBoxscore', { league_id: lg.leagueId, scoring_period: week, fantasy_game_id: sb.matchup.fantasyGameId }), lg.teamId);
  }
  state.weekData.set(ck, d);
  return d;
}

async function getLeagueModels(lg, d) {
  if (d.league) return d.league;
  d.league = await Promise.all(
    d.matchups.map(async (m) => ({
      ...m,
      model: parseBoxscore(await api('FetchLeagueBoxscore', { league_id: lg.leagueId, scoring_period: d.week, fantasy_game_id: m.fantasyGameId }), m.awayId),
    }))
  );
  return d.league;
}

async function loadManifest(season) {
  if (state.manifest?.season === season) return state.manifest;
  let weeks = {};
  try {
    const r = await fetch(`data/pbp/${season}/manifest.json`, { cache: 'no-store' });
    if (r.ok) weeks = (await r.json()).weeks ?? {};
  } catch {
    /* no play data */
  }
  state.manifest = { season, weeks };
  return state.manifest;
}
const hasData = (week, key) => (state.manifest?.weeks?.[week] ?? []).includes(key);

async function fetchGameFile(season, week, key) {
  const ck = `${season}/${week}/${key}`;
  if (state.files.has(ck)) return state.files.get(ck);
  // no-store: play data must never be kept by the HTTP cache or the service worker.
  const r = await fetch(`data/pbp/${season}/${week}/${key.replace('@', '-')}.json`, { cache: 'no-store' });
  if (!r.ok) throw new ApiError('Play data for this game is not available.');
  const f = await r.json();
  if (!f || !Array.isArray(f.plays) || !Array.isArray(f.effects) || !Array.isArray(f.players) || !Array.isArray(f.fx)) throw new ApiError('Play data for this game is not readable.');
  state.files.set(ck, f);
  return f;
}

/* ---------- scoring profile: fitted per league, only the coefficients are remembered ---------- */
const profKey = (lg) => `live:scoring:${lg.leagueId}`;

async function fitLeagueProfile(lg, week) {
  const meta = await ensureMeta(lg);
  const rows = [];
  const weeks = meta.weeks.filter((w) => w <= week).sort((a, b) => b - a).slice(0, 3);
  for (const w of weeks) {
    if (!state.manifest.weeks[w]) continue;
    let league;
    try {
      league = await getLeagueModels(lg, await getWeek(lg, w));
    } catch {
      continue;
    }
    for (const m of league) {
      const finals = new Map(m.model.games.filter((g) => g.final).map((g) => [g.id, g]));
      for (const s of m.model.slots) {
        for (const p of [s.me, s.opp]) {
          const g = p?.gameId != null ? finals.get(p.gameId) : null;
          if (!g || !hasData(w, gkey(g))) continue;
          try {
            const file = await fetchGameFile(lg.season, w, gkey(g));
            const pi = joinPlayer(buildNameIndex(file.players), { full: p.full || p.name, pos: p.pos, team: p.team });
            const t = pi >= 0 ? gameTotals(file).get(pi) : null;
            if (t) rows.push({ f: t, y: p.points });
          } catch {
            /* skip this player */
          }
        }
      }
    }
    if (rows.length >= 60) break;
  }
  return fitProfile(rows);
}

async function getProfile(lg, week) {
  if (state.profiles.has(lg.leagueId)) return state.profiles.get(lg.leagueId);
  const saved = store.get(profKey(lg), null);
  if (saved?.v === 1 && FEATURES.every((k) => Number.isFinite(saved.c?.[k]))) {
    state.profiles.set(lg.leagueId, saved.c);
    return saved.c;
  }
  let res;
  try {
    res = await fitLeagueProfile(lg, week);
  } catch {
    res = { profile: { ...DEFAULT_PROFILE }, src: 'default', n: 0, mae: 0 };
  }
  // Remember a fit, or a default that was checked against enough samples; retry later otherwise.
  if (res.src === 'fit' || res.n >= 20) store.set(profKey(lg), { v: 1, c: res.profile, n: res.n, src: res.src });
  state.profiles.set(lg.leagueId, res.profile);
  return res.profile;
}

/* ---------- navigation / hash ---------- */
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { l: p.get('l'), w: Number(p.get('w')) || null, g: p.get('g') };
}
function writeHash({ l, w, g }) {
  const p = new URLSearchParams();
  if (l) p.set('l', l);
  if (w) p.set('w', String(w));
  if (g) p.set('g', g);
  history.replaceState(null, '', `${location.pathname}${p.size ? '#' + p : ''}`);
}

/* ---------- screens ---------- */
function message(text, withLink = true) {
  $('livebar').hidden = true;
  main().replaceChildren(
    h('section', { class: 'card' }, h('p', { class: 'muted', text }), withLink ? h('a', { class: 'btn', href: './', text: 'Back to Blindside' }) : null)
  );
}

function entriesFor(g) {
  const out = [];
  for (const { lg, d } of state.items) {
    if (!d?.model) continue;
    const e = { lg, me: [], opp: [] };
    for (const s of d.model.slots) {
      for (const side of ['me', 'opp']) if (s[side]?.gameId === g.id) e[side].push(s[side]);
    }
    if (e.me.length || e.opp.length) out.push(e);
  }
  return out;
}

function unionGames() {
  const games = new Map();
  for (const { d } of state.items) for (const g of d?.model?.games ?? []) games.set(g.id, g);
  return [...games.values()].sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
}

async function boot() {
  state.lgs = [];
  if (!state.leagues.length) return message('Add a league in Blindside first, then come back here.');
  const season = Math.max(...state.leagues.map((l) => l.season));
  state.lgs = state.leagues.filter((l) => l.season === season);
  const hash = readHash();
  const ids = state.lgs.map((l) => l.leagueId);
  state.mode = hash.l && (hash.l === 'all' || ids.includes(hash.l)) ? hash.l : state.lgs.length > 1 ? 'all' : state.lgs[0].leagueId;
  if (state.mode === 'all' && state.lgs.length < 2) state.mode = state.lgs[0].leagueId;
  await showList(hash.w, hash.g);
}

const modeLeagues = () => (state.mode === 'all' ? state.lgs : state.lgs.filter((l) => l.leagueId === state.mode));

async function showList(wantWeek = null, openKey = null) {
  const seq = ++state.seq;
  state.game = null;
  $('livebar').hidden = true;
  main().replaceChildren(h('p', { class: 'muted center pad', text: 'Loading…' }));
  try {
    const lgs = modeLeagues();
    const metas = await Promise.all(state.lgs.map((lg) => ensureMeta(lg)));
    const meta = metas[0];
    await loadManifest(state.lgs[0].season);
    let week = wantWeek && meta.weeks.includes(wantWeek) ? wantWeek : state.week && meta.weeks.includes(state.week) ? state.week : null;
    const load = (w) => Promise.all(lgs.map(async (lg) => ({ lg, d: await getWeek(lg, w).catch(() => null) })));
    let items;
    if (week == null) {
      week = meta.currentWeek;
      items = await load(week);
      const prev = meta.weeks[meta.weeks.indexOf(week) - 1];
      const games = items.flatMap((i) => i.d?.model?.games ?? []);
      if (prev != null && games.length && games.every((g) => gameStatus(g) === 'upcoming')) {
        week = prev;
        items = await load(week);
      }
    } else items = await load(week);
    if (seq !== state.seq) return;
    state.week = week;
    state.items = items;
    writeHash({ l: state.mode, w: week });
    renderList(meta);
    if (openKey) {
      const g = unionGames().find((x) => gkey(x) === openKey);
      if (g) await openGame(g);
    }
  } catch (e) {
    if (seq !== state.seq) return;
    main().replaceChildren(
      h('section', { class: 'card' }, h('p', { class: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong loading your leagues.' }), h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => showList() }))
    );
  }
}

function renderList(meta) {
  const games = unionGames();
  const modeSel = h(
    'select',
    { 'aria-label': 'League', onchange: (e) => { state.mode = e.target.value; showList(state.week); } },
    state.lgs.length > 1 ? h('option', { value: 'all', text: 'All leagues', selected: state.mode === 'all' }) : null,
    state.lgs.map((lg) => h('option', { value: lg.leagueId, text: lg.teamName, selected: state.mode === lg.leagueId }))
  );
  const weekSel = h(
    'select',
    { 'aria-label': 'NFL week', onchange: (e) => { state.week = Number(e.target.value); showList(state.week); } },
    meta.weeks.map((w) => h('option', { value: String(w), text: `Wk ${w}${w === meta.currentWeek ? ' · now' : ''}`, selected: w === state.week }))
  );
  const names = (list) => (list.length ? list.map((p) => p.last).join(', ') : '—');
  main().replaceChildren(
    h('div', { class: 'controls' }, h('div', { class: 'pill selpill' }, modeSel), h('div', { class: 'pill selpill' }, weekSel)),
    h(
      'section',
      { class: 'card' },
      h('h2', { text: 'Pick a game to replay' }),
      h(
        'div',
        { class: 'games' },
        games.length
          ? games.map((g) => {
              const st = gameStatus(g);
              const ready = st !== 'upcoming' && hasData(state.week, gkey(g));
              const note = st === 'upcoming' ? 'Not started' : ready ? null : 'No play data yet';
              return h(
                'button',
                { class: 'game', type: 'button', disabled: !ready, onclick: () => openGame(g), 'data-game': gkey(g) },
                h('div', { class: 'gi' }, h('span', { class: 'matchupname', text: `${g.away} @ ${g.home}` }), h('span', { class: 'meta', text: `${fmtKick(g.kickoff)}${st === 'final' ? ' · Final' : st === 'live' ? ' · Live' : ''}` })),
                note ? h('span', { class: 'state soon', text: note }) : h('span', { class: 'state' }, 'Replay'),
                h(
                  'div',
                  { class: 'lgs' },
                  entriesFor(g).map((e) =>
                    h(
                      'div',
                      { class: 'lgline' },
                      state.lgs.length > 1 && state.mode === 'all' ? h('div', { class: 'lgname', text: e.lg.leagueName }) : null,
                      h('div', { class: 'who' }, h('span', { class: 'm', text: `You: ${names(e.me)}` }), h('span', { class: 'sep', text: '|' }), h('span', { class: 'o', text: `Opp: ${names(e.opp)}` }))
                    )
                  )
                )
              );
            })
          : h('p', { class: 'empty-note', text: 'No NFL games for your starters this week.' })
      )
    ),
    h('p', { class: 'small muted pad credit' }, 'Beta. Play data: ', h('a', { href: 'https://github.com/nflverse/nflverse-data', text: 'nflverse', rel: 'noopener' }), ' (CC BY 4.0). Points shown while you step are approximate (~) and become exact when you finish the game.')
  );
}

/* ---------- a game session ---------- */
const progKey = (season, week, key) => `live:p:${season}:${week}:${key}`;

async function openGame(g) {
  const seq = ++state.seq;
  const key = gkey(g);
  const season = state.lgs[0].season;
  main().replaceChildren(h('p', { class: 'muted center pad', text: 'Getting the game ready…' }));
  $('livebar').hidden = true;
  try {
    const file = await fetchGameFile(season, state.week, key);
    const entries = entriesFor(g);
    const profiles = await Promise.all(entries.map((e) => getProfile(e.lg, state.week)));
    if (seq !== state.seq) return;
    const idx = buildNameIndex(file.players);
    const blocks = entries.map((e, i) => {
      const runs = runningPoints(file, profiles[i]);
      const mk = (p) => {
        const pi = joinPlayer(idx, { full: p.full || p.name, pos: p.pos, team: p.team });
        return { p, at: (b) => (pi >= 0 ? runs[b].get(pi) ?? 0 : 0), tracked: pi >= 0 };
      };
      return { lg: e.lg, me: e.me.map(mk), opp: e.opp.map(mk) };
    });
    const groups = groupPlays(file.plays);
    const total = groups.length;
    const saved = store.get(progKey(season, state.week, key), 0);
    const sess = { g, file, blocks, groups, total, n: Number.isInteger(saved) ? Math.max(0, Math.min(total + 1, saved)) : 0, key, season, week: state.week };
    state.game = sess;
    writeHash({ l: state.mode, w: state.week, g: key });
    renderGame(sess);
  } catch (e) {
    if (seq !== state.seq) return;
    main().replaceChildren(
      h('section', { class: 'card' }, h('p', { class: 'error', text: e instanceof ApiError ? e.message : 'Could not open this game.' }), h('button', { class: 'btn', type: 'button', text: 'Back to games', onclick: () => showList(state.week) }))
    );
  }
}

function renderGame(s) {
  const { g } = s;
  const feed = h('div', { class: 'feed', id: 'feed', 'aria-live': 'polite' });
  s.feed = feed;
  const kick = h('div', { class: 'gmeta' }, h('div', { class: 'gteams', text: `${g.away} @ ${g.home}` }), h('div', { class: 'muted small', text: fmtKick(g.kickoff) }));
  const head = h(
    'section',
    { class: 'card gamehead' },
    h('div', { class: 'row' }, kick, h('button', { class: 'btn ghost small-btn', type: 'button', text: 'Change game', onclick: () => showList(state.week) })),
    h('div', { class: 'who' }, ...blocks_names(s))
  );
  const refit = h('button', { class: 'btn ghost small-btn refit', type: 'button', text: 'Recalculate league scoring', onclick: () => refitScoring(s) });
  main().replaceChildren(head, h('p', { id: 'hint', class: 'hint muted small' }), feed, h('p', { class: 'small muted pad credit' }, 'Play data: ', h('a', { href: 'https://github.com/nflverse/nflverse-data', text: 'nflverse', rel: 'noopener' }), ' (CC BY 4.0). Defenses and any player we cannot match show up when you finish the game.'), refit);
  // Newest card first. Resume: rebuild the cards already seen, no animation.
  for (let k = 0; k < Math.min(s.n, s.total); k++) feed.prepend(playCard(s, k, false));
  if (s.n > s.total) feed.prepend(finalCard(s, false));
  syncBar(s);
}

function blocks_names(s) {
  const names = (list) => (list.length ? list.map((x) => x.p.last).join(', ') : '—');
  return s.blocks.map((b) =>
    h('div', { class: 'lgline' }, s.blocks.length > 1 ? h('div', { class: 'lgname', text: b.lg.leagueName }) : null, h('div', { class: 'who' }, h('span', { class: 'm', text: `You: ${names(b.me)}` }), h('span', { class: 'sep', text: '|' }), h('span', { class: 'o', text: `Opp: ${names(b.opp)}` })))
  );
}

function syncBar(s) {
  const bar = $('livebar');
  bar.hidden = false;
  const finished = s.n > s.total;
  const last = s.n >= s.total;
  const hint = $('hint');
  if (hint) hint.textContent = s.n === 0 ? 'Nothing is shown until you press the button.' : '';
  bar.replaceChildren(
    h('button', { class: 'btn ghost resetbtn', type: 'button', text: 'Reset game', onclick: () => resetGame(s) }),
    h('button', { class: 'btn primary bigbtn', id: 'nextbtn', type: 'button', disabled: finished, text: finished ? 'Game finished' : last ? 'Finish game' : 'Next scoring play', onclick: () => advance(s) })
  );
}

function advance(s) {
  if (s.n > s.total) return;
  let card;
  if (s.n < s.total) {
    card = playCard(s, s.n, true);
    s.n++;
  } else {
    card = finalCard(s, true);
    s.n = s.total + 1;
  }
  store.set(progKey(s.season, s.week, s.key), s.n);
  s.feed.prepend(card);
  syncBar(s);
  if (!reduceMotion()) window.scrollTo({ top: 0, behavior: 'smooth' });
  else window.scrollTo(0, 0);
}

async function refitScoring(s) {
  for (const b of s.blocks) {
    store.del(profKey(b.lg));
    state.profiles.delete(b.lg.leagueId);
  }
  state.files.clear();
  openGame(s.g);
}

function resetGame(s) {
  if (!confirm('Reset this game back to the start? Your progress here will be cleared.')) return;
  s.n = 0;
  store.del(progKey(s.season, s.week, s.key));
  s.feed.replaceChildren();
  syncBar(s);
  window.scrollTo(0, 0);
}

/* ---------- cards ---------- */
const TYPE_LABEL = { TD: 'TD', FG: 'FG', XP: 'XP', '2PT': '2PT', SAF: 'SAF', PTS: 'PTS' };

function playCard(s, k, animate) {
  const grp = s.groups[k];
  const pl = grp.main;
  const end = s.file.plays[grp.end];
  const { g } = s;
  const how = pl.how ? (pl.by ? `${pl.how} from ${pl.by}` : pl.how) : '';
  const score = `${g.away} ${end.a} – ${g.home} ${end.h}`;
  const head = h(
    'div',
    { class: 'phead' },
    h('span', { class: `chip t-${pl.type}`, text: TYPE_LABEL[pl.type] ?? pl.type }),
    h('span', { class: 'clock', text: fmtClock(pl.q, pl.t) }),
    h('span', { class: 'pteam', text: pl.team }),
    h('span', { class: 'pscore', text: score })
  );
  const who = h('div', { class: 'pwho' }, h('b', { text: pl.scorer || pl.team }), how ? h('span', { class: 'phow', text: ` ${how}` }) : null);
  const extra = grp.extra ? h('div', { class: 'pdesc extra', text: `${grp.extra.type === '2PT' ? 'Two-point try' : 'Extra point'}: ${grp.extra.desc || grp.extra.scorer || ''}` }) : null;
  // Only blocks where one of the user's or opponent's starters actually changed on this card.
  const blocks = s.blocks.map((b) => impactBlock(s, b, grp)).filter(Boolean);
  return h('article', { class: animate && !reduceMotion() ? 'pcard play enter' : 'pcard play' }, head, who, pl.desc ? h('div', { class: 'pdesc', text: pl.desc }) : null, extra, ...blocks);
}

function impactBlock(s, b, grp) {
  const now = (x) => x.at(grp.end);
  const before = (x) => (grp.start ? x.at(grp.start - 1) : 0);
  const changed = (list) => list.filter((x) => Math.abs(now(x) - before(x)) >= 0.005);
  if (!changed(b.me).length && !changed(b.opp).length) return null;
  const rowsFor = (list) =>
    changed(list).map((x) => ({ x, now: now(x), prev: before(x) })).map((r) =>
      h('div', { class: 'prow' }, h('span', { class: 'pn', text: r.x.p.last }), h('span', { class: 'pv', text: approx(r.now) }), h('span', { class: 'pd', text: sign(r.now - r.prev) }))
    );
  const col = (cls, label, list) => {
    const rows = rowsFor(list);
    return h('div', { class: `side ${cls}` }, h('div', { class: 'slabel', text: label }), rows.length ? rows : h('div', { class: 'prow none', text: '—' }));
  };
  const sum = (list) => list.reduce((t, x) => t + now(x), 0);
  return h(
    'div',
    { class: 'impact' },
    s.blocks.length > 1 ? h('div', { class: 'lgname', text: b.lg.leagueName }) : null,
    h('div', { class: 'sides' }, col('me', 'You', b.me), col('opp', 'Opp', b.opp)),
    h('div', { class: 'sub' }, h('span', { class: 'm', text: `You ${approx(sum(b.me))}` }), ' – ', h('span', { class: 'o', text: `Opp ${approx(sum(b.opp))}` }), h('span', { class: 'subnote', text: ' this game' }))
  );
}

function finalCard(s, animate) {
  const blocks = s.blocks.map((b) => {
    const col = (cls, label, list) =>
      h(
        'div',
        { class: `side ${cls}` },
        h('div', { class: 'slabel', text: label }),
        list.length
          ? [...list].sort((a, c) => c.p.points - a.p.points).map((x) => h('div', { class: 'prow' }, h('span', { class: 'pn', text: x.p.last }), h('span', { class: 'pv', text: exact(x.p.points) })))
          : h('div', { class: 'prow none', text: '—' })
      );
    const sum = (list) => round2(list.reduce((t, x) => t + x.p.points, 0));
    return h(
      'div',
      { class: 'impact' },
      s.blocks.length > 1 ? h('div', { class: 'lgname', text: b.lg.leagueName }) : null,
      h('div', { class: 'sides' }, col('me', 'You', b.me), col('opp', 'Opp', b.opp)),
      h('div', { class: 'sub final' }, h('span', { class: 'm', text: `You ${exact(sum(b.me))}` }), ' – ', h('span', { class: 'o', text: `Opp ${exact(sum(b.opp))}` }), h('span', { class: 'subnote', text: ' this game' }))
    );
  });
  return h('article', { class: animate && !reduceMotion() ? 'pcard final enter' : 'pcard final' }, h('div', { class: 'phead' }, h('span', { class: 'chip t-FINAL', text: 'FINAL' }), h('span', { class: 'clock', text: 'Exact points for this game' })), ...blocks);
}

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
