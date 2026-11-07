// Blindside: spoiler-free fantasy tracker for Fleaflicker.
// Spoiler rules: real numbers live only in memory (the parsed model). The DOM only ever
// receives values for games the user has marked watched. No console logging of data,
// no numbers in the title, attributes or error messages.
import { parseStandings, parseScoreboard, parseBoxscore, computeReveal } from './parse.js';

const DEFAULT_LEAGUE_ID = '219707';
const KEY = 'blindside:v1:';

/* ---------- storage ---------- */
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
      /* storage full or blocked: app still works for this visit */
    }
  },
};

function defaultSeason() {
  const d = new Date();
  // NFL seasons run Sep–Feb; Jan/Feb belong to the previous season.
  return d.getMonth() < 2 ? d.getFullYear() - 1 : d.getFullYear();
}

// Watching an NFL game is a real-world fact, so the watched set is shared by every league (per season + week).
const watchedKey = (season, week) => `watched:${season}:${week}`;
const loadWatched = (season, week) => new Set(store.get(watchedKey(season, week), []));
const saveWatched = (season, week, set) => store.set(watchedKey(season, week), [...set]);

/** One-time: fold the old per-league sets (watched:<league>:<season>:<week>) into the shared ones. */
function migrateWatched() {
  try {
    const re = new RegExp('^' + KEY + 'watched:\\d+:(\\d+):(\\d+)$');
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      const m = k && re.exec(k);
      if (!m) continue;
      const merged = new Set([...store.get(`watched:${m[1]}:${m[2]}`, []), ...JSON.parse(localStorage.getItem(k) || '[]')]);
      store.set(`watched:${m[1]}:${m[2]}`, [...merged]);
      localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable: nothing to migrate */
  }
}
// A week is "done" once every game in your matchup is ticked and final (drives the default week).
const doneKey = (lg, week) => `done:${lg.leagueId}:${lg.season}:${lg.teamId}:${week}`;
const isDone = (lg, week) => store.get(doneKey(lg, week), false) === true;

/* ---------- state ---------- */
const state = {
  leagues: store.get('leagues', []), // [{leagueId, season, leagueName, teamId, teamName}]
  active: store.get('active', null), // leagueId or 'add'
  week: null, // the selected NFL week, shared by every league and the All view (null = pick the default)
  meta: {}, // leagueId -> {currentWeek, weeks}
  cache: new Map(), // `${leagueId}:${season}:${week}` -> view data (in memory only)
  view: null, // current rendered league view
  tab: 'games', // 'games' | 'lineups' | 'league'
  hideWatched: store.get('hideWatched', false) === true,
  linger: new Map(), // gameId -> {timer, started}: just-watched games kept visible briefly while hiding watched
  seq: 0,
};

const saveLeagues = () => store.set('leagues', state.leagues);
const findLeague = (id) => state.leagues.find((l) => l.leagueId === id);

/* ---------- api ---------- */
class ApiError extends Error {}

async function api(method, params) {
  const qs = new URLSearchParams(params);
  let res;
  try {
    res = await fetch(`api/${method}?${qs}`, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError('Network error. Check your connection and try again.');
  }
  if (!res.ok) {
    let code = res.status;
    try {
      const j = await res.json();
      if (j && Number.isInteger(j.upstreamStatus)) code = j.upstreamStatus;
    } catch {
      /* ignore */
    }
    throw new ApiError(`Fleaflicker request failed (HTTP ${code}). Check the league ID and try again.`);
  }
  try {
    return await res.json();
  } catch {
    throw new ApiError('Fleaflicker sent an unreadable response. Try again.');
  }
}

/* ---------- dom helpers ---------- */
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

// Static icon markup only (never data), so innerHTML is safe here.
const ICONS = {
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 7 11 7a18.6 18.6 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  checkAll: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><polyline points="22 4 12 14.01 9 11.01"/>',
  reset: '<polyline points="1 4 1 10 7 10"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  ball: '<ellipse cx="12" cy="12" rx="10" ry="6" transform="rotate(-35 12 12)"/><path d="M9.2 14.8l5.6-5.6M11 11.5l1.5 1.5M13 9.5l1.5 1.5M9 13.5l1.5 1.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.8"/><path d="M17.5 14.2c2.6.3 4.5 2.3 4.5 5.3"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
};
function icon(name, size = 20) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
}

const fmtTotal = (n) => n.toFixed(2);
const fmtPts = (n) => String(Math.round(n * 100) / 100);
const fmtKick = (ms) =>
  ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const slotLabel = (l) => (l.includes('/') ? (l.includes('QB') ? 'SFLX' : 'FLEX') : l);
const gameStatus = (g) => (g.final ? 'final' : g.kickoff && Date.now() >= g.kickoff ? 'live' : 'upcoming');

/* ---------- bottom sheets ---------- */
function openSheet(title, ...content) {
  const prevFocus = document.activeElement;
  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const wrap = h(
    'div',
    { class: 'sheetwrap' },
    h('div', { class: 'scrim', onclick: close }),
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheethead' }, h('h3', { text: title }), h('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('close'))),
      ...content
    )
  );
  document.body.append(wrap);
  document.addEventListener('keydown', onKey);
  return close;
}

function openLeagueSheet() {
  const close = openSheet(
    'Your leagues',
    h(
      'div',
      { class: 'sheetlist' },
      ...(state.leagues.length > 1
        ? [
            h(
              'button',
              { class: 'sheetrow allrow', type: 'button', 'aria-current': String(state.active === 'all'), onclick: () => { close(); go('all'); } },
              icon('layers'),
              h('span', { class: 'grow' }, h('b', { text: 'All leagues' }), h('small', { text: 'Your players across every league' })),
              state.active === 'all' ? icon('check') : null
            ),
          ]
        : []),
      ...state.leagues.map((lg) =>
        h(
          'button',
          { class: 'sheetrow leaguerow', type: 'button', 'aria-current': String(state.active === lg.leagueId), onclick: () => { close(); go(lg.leagueId); } },
          h('span', { class: 'grow' }, h('b', { text: lg.teamName }), h('small', { text: lg.leagueName })),
          state.active === lg.leagueId ? icon('check') : null
        )
      ),
      h('button', { class: 'sheetrow addrow', type: 'button', onclick: () => { close(); go('add'); } }, icon('plus'), h('span', { text: 'Add league' }))
    )
  );
}

function openSettingsSheet() {
  const lg = findLeague(state.active);
  const rows = [];
  let close = () => {};
  if (state.active !== 'add') {
    const hideRow = h(
      'button',
      { class: 'sheetrow', type: 'button', role: 'switch', 'aria-checked': String(state.hideWatched) },
      h('span', { class: 'grow', text: 'Hide watched games' }),
      h('span', { class: 'switch', 'aria-hidden': 'true' })
    );
    hideRow.addEventListener('click', () => {
      state.hideWatched = !state.hideWatched;
      store.set('hideWatched', state.hideWatched);
      hideRow.setAttribute('aria-checked', String(state.hideWatched));
      paint();
    });
    rows.push(hideRow);
  }
  if (lg) {
    rows.unshift(h('button', { class: 'sheetrow', type: 'button', onclick: () => { close(); renderSetup({ changeTeamFor: lg.leagueId }); } }, h('span', { class: 'grow', text: 'Change team' })));
    rows.push(
      h(
        'button',
        {
          class: 'sheetrow danger',
          type: 'button',
          onclick: () => {
            if (!confirm(`Remove ${lg.leagueName} from this device?`)) return;
            state.leagues = state.leagues.filter((l) => l.leagueId !== lg.leagueId);
            saveLeagues();
            close();
            go(state.leagues[0]?.leagueId ?? 'add');
          },
        },
        h('span', { class: 'grow', text: 'Remove league' })
      )
    );
  }
  rows.push(h('a', { class: 'sheetrow', href: 'make-your-own.md', download: 'blindside-make-your-own.md' }, h('span', { class: 'grow', text: 'Make this my own' })));
  close = openSheet('Settings', h('div', { class: 'sheetlist' }, ...rows));
}

/* ---------- navigation ---------- */
const TABS = [
  ['games', 'Games', 'ball'],
  ['lineups', 'Lineups', 'users'],
  ['league', 'League', 'trophy'],
];

function tabButtons(cls) {
  return TABS.map(([id, label, ic]) =>
    h('button', { class: cls, type: 'button', 'data-tab': id, 'aria-pressed': String(state.tab === id), onclick: () => setTab(id) }, icon(ic, 22), h('span', { text: label }))
  );
}

function renderNav() {
  const nav = $('nav');
  nav.replaceChildren(...tabButtons('navbtn'));
  nav.hidden = state.active === 'add' || !findLeague(state.active);
  nav.classList.remove('away');
}

function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  const lg = findLeague(state.active);
  if (lg) loadLeague(lg);
}

function go(id) {
  state.active = id;
  state.tab = 'games';
  if (id !== 'add') store.set('active', id);
  renderNav();
  if (id === 'add') renderSetup({});
  else if (id === 'all') loadAll();
  else loadLeague(findLeague(id));
}

/* ---------- setup ---------- */
function renderSetup({ prefill, changeTeamFor }) {
  $('nav').hidden = true;
  state.view = null;
  const existing = changeTeamFor ? findLeague(changeTeamFor) : null;
  const input = h('input', {
    class: 'field',
    id: 'league-id',
    inputmode: 'numeric',
    pattern: '[0-9]*',
    autocomplete: 'off',
    placeholder: 'Fleaflicker league ID',
    'aria-label': 'Fleaflicker league ID',
    value: existing?.leagueId ?? prefill ?? (state.leagues.length ? '' : DEFAULT_LEAGUE_ID),
  });
  const list = h('div', { class: 'teamlist' });
  const msg = h('p', { class: 'small muted' });
  const loadBtn = h('button', { class: 'btn primary', type: 'button', text: 'Load teams' });

  async function loadTeams() {
    const id = input.value.trim();
    if (!/^\d{1,12}$/.test(id)) {
      msg.className = 'small error';
      msg.textContent = 'Enter a numeric league ID (it is in your Fleaflicker league URL).';
      return;
    }
    msg.className = 'small muted';
    msg.textContent = 'Loading teams…';
    list.replaceChildren();
    loadBtn.disabled = true;
    const season = existing?.season ?? defaultSeason();
    try {
      const st = parseStandings(await api('FetchLeagueStandings', { league_id: id, season }));
      if (!st.teams.length) throw new ApiError('No teams found for that league and season.');
      msg.textContent = `${st.leagueName || 'League ' + id} — tap your team:`;
      list.replaceChildren(
        ...st.teams.map((t) =>
          h(
            'button',
            {
              class: 'teambtn',
              type: 'button',
              onclick: () => {
                const lg = { leagueId: id, season: st.season || season, leagueName: st.leagueName || `League ${id}`, teamId: t.id, teamName: t.name };
                const i = state.leagues.findIndex((l) => l.leagueId === id);
                if (i >= 0) state.leagues[i] = lg;
                else state.leagues.push(lg);
                saveLeagues();
                go(id);
              },
            },
            h('b', { text: t.name }),
            t.owner ? h('span', { text: t.owner }) : null
          )
        )
      );
    } catch (e) {
      msg.className = 'small error';
      msg.textContent = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
    } finally {
      loadBtn.disabled = false;
    }
  }
  loadBtn.addEventListener('click', loadTeams);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && loadTeams());

  main().replaceChildren(
    h(
      'section',
      { class: 'card' },
      h('h2', { text: existing ? 'Change team' : 'Add a league' }),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, input), loadBtn),
      msg,
      list
    ),
    h('p', { class: 'small muted pad' }, 'Scores stay hidden. Tick the NFL games you have watched and only those points are revealed.')
  );
  if (input.value) loadTeams();
}

/* ---------- data ---------- */
const weekKey = (lg, week) => `${lg.leagueId}:${lg.season}:${week}`;

/** Scoreboard + my matchup's boxscore for a week (cached in memory). */
async function getWeek(lg, week, { force = false, sbRaw = null } = {}) {
  const ck = weekKey(lg, week);
  let d = force ? null : state.cache.get(ck);
  if (d && d.teamId === lg.teamId) return d;
  const raw = sbRaw ?? (await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season, scoring_period: week }));
  const sb = parseScoreboard(raw, lg.teamId);
  d = { week, teamId: lg.teamId, matchup: sb.matchup, matchups: sb.matchups, model: null, league: null };
  if (sb.matchup) {
    const box = await api('FetchLeagueBoxscore', { league_id: lg.leagueId, scoring_period: week, fantasy_game_id: sb.matchup.fantasyGameId });
    d.model = parseBoxscore(box, lg.teamId);
  }
  state.cache.set(ck, d);
  return d;
}

/** Every matchup's boxscore for the week, from the away team's perspective. */
async function getLeagueModels(lg, d) {
  if (d.league) return d.league;
  d.league = await Promise.all(
    d.matchups.map(async (m) => {
      const box = await api('FetchLeagueBoxscore', { league_id: lg.leagueId, scoring_period: d.week, fantasy_game_id: m.fantasyGameId });
      return { ...m, model: parseBoxscore(box, m.awayId) };
    })
  );
  return d.league;
}

const allStartersUpcoming = (model) => model.games.length > 0 && model.games.every((g) => gameStatus(g) === 'upcoming');

async function loadLeague(lg, { force = false } = {}) {
  if (!lg) return go('add');
  const seq = ++state.seq;
  state.view = null;
  renderNav();
  main().replaceChildren(h('p', { class: 'muted center pad', text: 'Loading…' }));

  try {
    let meta = state.meta[lg.leagueId];
    let firstSb = null;
    if (!meta || force) {
      // Without scoring_period Fleaflicker returns the current week.
      firstSb = await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season });
      const p = parseScoreboard(firstSb, lg.teamId);
      meta = { currentWeek: p.currentWeek ?? p.week, weeks: p.weeks.length ? p.weeks : [p.week], sbWeek: p.week };
      state.meta[lg.leagueId] = meta;
    }
    let week = state.week;
    if (week != null && !meta.weeks.includes(week)) week = null; // not a week this league has
    const sbFor = (w) => (firstSb && meta.sbWeek === w ? firstSb : null);
    let d;
    if (week == null) {
      // Default week: the current one, unless none of its games have kicked off yet and
      // last week isn't finished (e.g. catching up on Monday night on a Tuesday).
      week = meta.currentWeek;
      d = await getWeek(lg, week, { force, sbRaw: sbFor(week) });
      const prev = meta.weeks[meta.weeks.indexOf(week) - 1];
      if (prev != null && d.model && allStartersUpcoming(d.model) && !isDone(lg, prev)) {
        week = prev;
        d = await getWeek(lg, week, { force });
      }
      state.week = week;
    } else {
      d = await getWeek(lg, week, { force, sbRaw: sbFor(week) });
    }
    if (state.tab === 'league') await getLeagueModels(lg, d);
    if (seq !== state.seq) return; // user navigated away meanwhile
    renderLeague(lg, meta, d);
  } catch (e) {
    if (seq !== state.seq) return;
    main().replaceChildren(
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong loading this league.' }),
        h('div', { class: 'manage' }, h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => loadLeague(lg, { force: true }) }))
      )
    );
  }
}

/* ---------- all leagues ---------- */
async function ensureMeta(lg, force) {
  let m = state.meta[lg.leagueId];
  if (m && !force) return m;
  const raw = await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season });
  const p = parseScoreboard(raw, lg.teamId);
  m = { currentWeek: p.currentWeek ?? p.week, weeks: p.weeks.length ? p.weeks : [p.week], sbWeek: p.week };
  state.meta[lg.leagueId] = m;
  return m;
}

async function loadItems(lgs, week, force) {
  const res = await Promise.allSettled(lgs.map((lg) => getWeek(lg, week, { force })));
  return lgs.map((lg, i) => ({ lg, d: res[i].status === 'fulfilled' ? res[i].value : null }));
}

/** One screen for every saved league: who of yours is in each NFL game. */
async function loadAll({ force = false } = {}) {
  const seq = ++state.seq;
  state.view = null;
  $('nav').hidden = true;
  main().replaceChildren(h('p', { class: 'muted center pad', text: 'Loading…' }));
  // Leagues from an older season can't share a week with the current ones.
  const season = Math.max(...state.leagues.map((l) => l.season));
  const lgs = state.leagues.filter((l) => l.season === season);
  try {
    const metas = (await Promise.allSettled(lgs.map((lg) => ensureMeta(lg, force)))).filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!metas.length) throw new ApiError('Could not load your leagues. Check your connection and try again.');
    const meta = metas[0];
    let week = state.week != null && meta.weeks.includes(state.week) ? state.week : null;
    const pickDefault = week == null;
    if (pickDefault) week = meta.currentWeek;
    let items = await loadItems(lgs, week, force);
    if (pickDefault) {
      // Same catch-up rule as a single league: stay on last week until it's finished.
      const prev = meta.weeks[meta.weeks.indexOf(week) - 1];
      const live = items.filter((i) => i.d?.model);
      if (prev != null && live.length && live.every((i) => allStartersUpcoming(i.d.model)) && lgs.some((lg) => !isDone(lg, prev))) {
        week = prev;
        items = await loadItems(lgs, week, force);
      }
      state.week = week;
    }
    if (seq !== state.seq) return;
    renderAll(season, week, meta, items);
  } catch (e) {
    if (seq !== state.seq) return;
    main().replaceChildren(
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong loading your leagues.' }),
        h('div', { class: 'manage' }, h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => loadAll({ force: true }) }))
      )
    );
  }
}

function renderAll(season, week, meta, items) {
  const watched = loadWatched(season, week);
  state.view = { tab: 'all', season, week, meta, items, watched };
  main().replaceChildren(
    controls('All leagues', 'layers', meta, week, (w) => {
      state.week = w;
      loadAll();
    }),
    h('section', { class: 'card' }, h('h2', { text: 'Your matchups' }), h('div', { class: 'mlist', id: 'amlist' })),
    h('section', { class: 'card' }, gamesHead('NFL games'), h('div', { class: 'games', id: 'games' })),
    makeOwn()
  );
  paint();
}

/** Union of NFL games across all leagues, plus which of my players (and their opponents) are in each. */
function unionGames(items) {
  const games = new Map();
  const byGame = new Map(); // gameId -> [{lg, me: [], opp: []}]
  for (const { lg, d } of items) {
    if (!d?.model) continue;
    for (const g of d.model.games) games.set(g.id, g);
    for (const s of d.model.slots) {
      for (const key of ['me', 'opp']) {
        const p = s[key];
        if (p?.gameId == null) continue;
        let list = byGame.get(p.gameId);
        if (!list) byGame.set(p.gameId, (list = []));
        let entry = list.find((x) => x.lg === lg);
        if (!entry) list.push((entry = { lg, me: [], opp: [] }));
        entry[key].push(p);
      }
    }
  }
  return { games: [...games.values()], byGame };
}

function paintAll(v) {
  const { items, watched } = v;
  $('amlist').replaceChildren(
    ...items.map(({ lg, d }) => {
      if (!d?.model) {
        return h('div', { class: 'amrow dim' }, h('div', { class: 'amtxt' }, h('div', { class: 'amvs' }, h('b', { text: lg.teamName })), h('div', { class: 'amsub', text: d ? 'No matchup this week' : "Couldn't load this league" })));
      }
      const r = computeReveal(d.model, watched);
      const done = r.allWatched && r.allFinal;
      const verdict = !done ? null : r.me > r.opp ? ['W', 'win'] : r.me < r.opp ? ['L', 'loss'] : ['T', 'tie'];
      return h(
        'button',
        { class: 'amrow', type: 'button', onclick: () => go(lg.leagueId), 'aria-label': `Open ${lg.leagueName}` },
        h(
          'div',
          { class: 'amtxt' },
          h('div', { class: 'amvs' }, h('b', { class: 'me', text: d.matchup.myName }), ' vs ', h('span', { class: 'opp', text: d.matchup.oppName })),
          h('div', { class: 'amsub', text: `${lg.leagueName} · ${leftText(playersLeft(d.model, 'me', watched))}` })
        ),
        r.anyWatched ? h('div', { class: 'amscore' }, h('span', { class: 'me', text: fmtTotal(r.me) }), ' – ', h('span', { class: 'opp', text: fmtTotal(r.opp) })) : null,
        verdict ? h('span', { class: `wl ${verdict[1]}`, text: verdict[0] }) : null
      );
    })
  );
  const { games, byGame } = unionGames(items);
  renderGameList(
    games,
    watched,
    (g) =>
      h(
        'div',
        { class: 'lgs' },
        // Same You (green) | Opp (orange) lines as the single-league view, one block per league.
        ...(byGame.get(g.id) ?? []).map((e) => h('div', { class: 'lgline' }, h('div', { class: 'lgname', text: e.lg.leagueName }), whoLine(e, watched.has(g.id))))
      ),
    'No NFL games this week.',
    (g) => {
      const n = (byGame.get(g.id) ?? []).reduce((t, e) => t + e.me.length, 0);
      return n ? `${n} of yours` : null;
    }
  );
  syncActions(games.length > 0 && games.every((g) => watched.has(g.id)), watched.size > 0);
}

/* ---------- controls: team picker, week stepper, tabs ---------- */
function weekBar(meta, week, setWeek) {
  const weeks = meta.weeks;
  const idx = weeks.indexOf(week);
  const sel = h(
    'select',
    { 'aria-label': 'NFL week', onchange: (e) => setWeek(Number(e.target.value)) },
    weeks.map((w) => {
      const o = h('option', { value: String(w), text: `Wk ${w}${w === meta.currentWeek ? ' · now' : ''}` });
      if (w === week) o.selected = true;
      return o;
    })
  );
  return h(
    'div',
    { class: 'pill weekbar' },
    h('button', { class: 'step', type: 'button', 'aria-label': 'Previous week', text: '‹', disabled: idx <= 0, onclick: () => setWeek(weeks[idx - 1]) }),
    sel,
    h('button', { class: 'step', type: 'button', 'aria-label': 'Next week', text: '›', disabled: idx < 0 || idx >= weeks.length - 1, onclick: () => setWeek(weeks[idx + 1]) })
  );
}

function controls(label, ic, meta, week, setWeek) {
  return h(
    'div',
    { class: 'controls' },
    h('button', { class: 'pill teampick', id: 'btn-league', type: 'button', 'aria-label': 'Switch league', onclick: openLeagueSheet }, icon(ic), h('span', { class: 'pt', text: label }), icon('chevron', 18)),
    weekBar(meta, week, setWeek)
  );
}

/** Bottom-of-page link that downloads a build brief to hand to ChatGPT. */
const makeOwn = () =>
  h('div', { class: 'ownrow' }, h('a', { class: 'btn ghost own', href: 'make-your-own.md', download: 'blindside-make-your-own.md', text: 'Make this my own' }));

/* ---------- league view ---------- */
function renderLeague(lg, meta, d) {
  renderNav();
  const { week } = d;
  const ctrl = controls(lg.teamName, 'user', meta, week, (w) => {
    state.week = w;
    loadLeague(lg);
  });
  const watched = loadWatched(lg.season, week);
  state.view = { lg, meta, data: d, watched, tab: state.tab };

  if (state.tab === 'league') {
    main().replaceChildren(
      ctrl,
      h('section', { class: 'card' }, h('h2', { text: 'Matchups' }), h('div', { class: 'mlist', id: 'mlist' })),
      h('section', { class: 'card' }, gamesHead('NFL games'), h('div', { class: 'games', id: 'games' })),
      makeOwn()
    );
  } else if (!d.matchup) {
    state.view = null;
    main().replaceChildren(ctrl, h('section', { class: 'card' }, h('p', { class: 'muted', text: `${lg.teamName} has no matchup in week ${week}.` })), makeOwn());
    return;
  } else {
    main().replaceChildren(
      ctrl,
      h('section', { class: 'matchup', id: 'matchup' }),
      state.tab === 'games'
        ? h('section', { class: 'card' }, gamesHead('NFL games'), h('div', { class: 'games', id: 'games' }))
        : h('section', { class: 'card' }, h('h2', { text: 'Starting lineups' }), h('div', { class: 'lineup', id: 'lineup' })),
      makeOwn()
    );
  }
  paint();
}

/* ---------- shared view pieces ---------- */

/** Starters whose NFL game hasn't been ticked (byes and empty slots excluded). */
const playersLeft = (model, side, watched) =>
  model.slots.reduce((n, s) => n + (s[side]?.gameId != null && !watched.has(s[side].gameId) ? 1 : 0), 0);
const leftText = (n) => (n ? `${n} player${n === 1 ? '' : 's'} left` : 'All watched');

/**
 * Compact scoreboard rows (league view): one row per team, name + players left on the left,
 * score on the right. A score only appears once at least one of that matchup's games is watched.
 */
function scoreRows(model, names, watched) {
  const r = computeReveal(model, watched);
  const row = (side, name, pts) =>
    h(
      'div',
      { class: `srow ${side}` },
      h('div', { class: 'sname' }, h('div', { class: 'tname', text: name }), h('div', { class: 'left', text: leftText(playersLeft(model, side, watched)) })),
      r.anyWatched ? h('div', { class: 'pts sm', text: fmtTotal(pts) }) : null
    );
  return { r, rows: [row('me', names[0], r.me), row('opp', names[1], r.opp)] };
}

/** League-view status: lock progress, or "Final"/"In progress" once the matchup is fully watched. */
function matchStatus(r) {
  if (!r.allWatched) return h('div', { class: 'status', text: `🔒 ${r.watchedCount}/${r.total} games watched` });
  const diff = Math.round((r.me - r.opp) * 100) / 100;
  return h('div', { class: 'status done', text: diff === 0 ? 'Tied' : r.allFinal ? 'Final' : 'In progress' });
}

/** Win/lose banner for my matchup: only once every relevant game is watched. */
function resultBanner(r) {
  if (!r.allWatched) return null;
  const diff = Math.round((r.me - r.opp) * 100) / 100;
  const tail = r.allFinal ? '' : ' (still in progress)';
  if (diff > 0) return h('div', { class: 'result win', text: r.allFinal ? 'You win' : `You lead${tail}` });
  if (diff < 0) return h('div', { class: 'result loss', text: r.allFinal ? 'You lose' : `You trail${tail}` });
  return h('div', { class: 'result', text: r.allFinal ? 'Tie' : `Tied${tail}` });
}

/** The big matchup card: names, revealed scores, players left, and watch progress. */
function matchupNodes(model, matchup, watched) {
  const r = computeReveal(model, watched);
  const side = (cls, name, pts, key) =>
    h(
      'div',
      { class: `mside ${cls}` },
      h('div', { class: 'mname', text: name }),
      r.anyWatched ? h('div', { class: 'pts', text: fmtTotal(pts) }) : null,
      h('div', { class: 'left', text: leftText(playersLeft(model, key, watched)) })
    );
  const pct = r.total ? Math.round((r.watchedCount / r.total) * 100) : 0;
  return {
    r,
    nodes: [
      h('div', { class: 'mhead' }, side('me', matchup.myName, r.me, 'me'), h('div', { class: 'vs', text: 'VS' }), side('opp', matchup.oppName, r.opp, 'opp')),
      h('div', { class: 'prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(r.total), 'aria-valuenow': String(r.watchedCount), 'aria-label': 'Games revealed' }, h('i', { style: `width:${pct}%` })),
      h('div', { class: 'mfoot' }, h('span', { text: `${r.watchedCount} / ${r.total} games revealed` }), h('b', { class: 'pct', text: `${pct}%` })),
      resultBanner(r),
    ].filter(Boolean),
  };
}

const LINGER_MS = 5000;

/** Keep a just-watched game on screen for a few seconds so its points can be read before it's filtered out. */
function lingerGame(id) {
  clearTimeout(state.linger.get(id)?.timer);
  const timer = setTimeout(() => {
    state.linger.delete(id);
    paint();
  }, LINGER_MS);
  state.linger.set(id, { timer, started: Date.now() });
}
function unlinger(id) {
  clearTimeout(state.linger.get(id)?.timer);
  state.linger.delete(id);
}
function clearLingers() {
  for (const id of [...state.linger.keys()]) unlinger(id);
}

/** Kickoff order; optionally drop games already watched (except ones that just were). */
function visibleGames(games, watched) {
  const sorted = [...games].sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
  return state.hideWatched ? sorted.filter((g) => !watched.has(g.id) || state.linger.has(g.id)) : sorted;
}

/** Games card header: title plus eye (hide watched), mark-all and reset icon buttons. */
function gamesHead(title) {
  const eye = h('button', { class: 'iconbtn', id: 'btn-hide', type: 'button' });
  const syncEye = () => {
    eye.setAttribute('aria-pressed', String(state.hideWatched));
    eye.setAttribute('aria-label', state.hideWatched ? 'Show watched games' : 'Hide watched games');
    eye.title = eye.getAttribute('aria-label');
    eye.replaceChildren(icon(state.hideWatched ? 'eyeOff' : 'eye'));
  };
  syncEye();
  eye.addEventListener('click', () => {
    state.hideWatched = !state.hideWatched;
    store.set('hideWatched', state.hideWatched);
    syncEye();
    paint();
  });
  return h(
    'div',
    { class: 'cardhead' },
    h('h2', { text: title }),
    h(
      'div',
      { class: 'headbtns' },
      h('button', { class: 'iconbtn', id: 'btn-all', type: 'button', 'aria-label': 'Mark all watched', title: 'Mark all watched', onclick: markAll }, icon('checkAll')),
      h('button', { class: 'iconbtn', id: 'btn-reset', type: 'button', 'aria-label': 'Reset watched games', title: 'Reset', onclick: resetWeek }, icon('reset')),
      eye
    )
  );
}

/** "Last names" list; each player's points are appended only when the game is watched. */
const playerList = (players, revealed) =>
  players.flatMap((p, i) => [i ? ', ' : '', p.last, revealed ? h('b', { class: 'pv', text: ` ${fmtPts(p.points)}` }) : null]);
const whoLine = (who, revealed) =>
  h(
    'div',
    { class: revealed ? 'who rev' : 'who' },
    h('span', { class: 'm' }, 'You: ', who.me.length ? playerList(who.me, revealed) : '—'),
    h('span', { class: 'sep', text: '|' }),
    h('span', { class: 'o' }, 'Opp: ', who.opp.length ? playerList(who.opp, revealed) : '—')
  );

function gameCard(g, watched, detail, extra) {
  const st = gameStatus(g);
  const on = watched.has(g.id);
  const upcoming = st === 'upcoming' && !on;
  const pill = on
    ? h('span', { class: 'state on' }, icon('check', 14), 'Revealed')
    : upcoming
      ? h('span', { class: 'state soon' }, icon('clock', 14), 'Not started')
      : h('span', { class: 'state' }, icon('eye', 14), 'Hidden');
  const when = st === 'final' ? `${fmtKick(g.kickoff)} · Final` : fmtKick(g.kickoff);
  const lingering = on && state.hideWatched ? state.linger.get(g.id) : null;
  return h(
    'button',
    { class: lingering ? 'game linger' : 'game', type: 'button', 'aria-pressed': String(on), disabled: upcoming, onclick: () => toggleGame(g.id) },
    h(
      'div',
      { class: 'gi' },
      h('span', { class: 'matchupname', text: `${g.away} @ ${g.home}` }),
      h('span', { class: 'meta' }, when, extra ? ` · ${extra}` : null, st === 'live' ? h('span', { class: 'badge live', text: 'LIVE' }) : null)
    ),
    pill,
    detail,
    // Countdown bar; the negative delay keeps it accurate if the list is re-rendered meanwhile.
    lingering ? h('span', { class: 'drain', 'aria-hidden': 'true', style: `animation-duration:${LINGER_MS}ms;animation-delay:-${Date.now() - lingering.started}ms` }) : null
  );
}

function renderGameList(games, watched, detailFor, emptyText, extraFor) {
  const list = visibleGames(games, watched);
  const hidden = games.length - list.length;
  const nodes = list.map((g) => gameCard(g, watched, detailFor(g), extraFor?.(g)));
  if (!games.length) nodes.push(h('p', { class: 'empty-note', text: emptyText }));
  else if (!list.length) nodes.push(h('p', { class: 'empty-note', text: `All ${hidden} watched games hidden.` }));
  $('games').replaceChildren(...nodes);
}

/** Re-render all spoiler-sensitive parts from the in-memory model + watched set. */
function paint() {
  const v = state.view;
  if (!v) return;
  if (v.tab === 'all') return paintAll(v);
  if (v.tab === 'league') return paintLeague(v);
  const { lg, data, watched } = v;
  const { model, matchup } = data;

  const { r, nodes } = matchupNodes(model, matchup, watched);
  $('matchup').replaceChildren(...nodes);
  store.set(doneKey(lg, data.week), r.allWatched && r.allFinal);

  if (v.tab === 'games') {
    // Names always; each player's points only once that game is ticked.
    const byGame = new Map(model.games.map((g) => [g.id, { me: [], opp: [] }]));
    for (const s of model.slots) {
      if (s.me?.gameId != null) byGame.get(s.me.gameId)?.me.push(s.me);
      if (s.opp?.gameId != null) byGame.get(s.opp.gameId)?.opp.push(s.opp);
    }
    renderGameList(model.games, watched, (g) => whoLine(byGame.get(g.id), watched.has(g.id)), 'No NFL games for these starters this week.');
    syncActions(r.allWatched, r.anyWatched);
  } else {
    const cell = (p, mine) => {
      const cls = mine ? 'pl mine' : 'pl theirs right';
      if (!p) return h('div', { class: `${cls} empty` }, h('div', { class: 'n', text: 'Empty' }));
      const rev = p.gameId != null && watched.has(p.gameId);
      const pts = p.bye ? 'BYE' : rev ? fmtPts(p.points) : null;
      return h(
        'div',
        { class: cls },
        h('div', { class: 'n', text: p.name }),
        h('div', { class: 't', text: [p.pos, p.team].filter(Boolean).join(' · ') }),
        pts != null ? h('div', { class: `p ${rev ? 'rev' : 'hid'}`, text: pts }) : null
      );
    };
    $('lineup').replaceChildren(
      h('div', { class: 'hdr', text: matchup.myName }),
      h('div', {}),
      h('div', { class: 'hdr right', text: matchup.oppName }),
      ...model.slots.flatMap((s) => [cell(s.me, true), h('div', { class: 'slot', text: slotLabel(s.label) }), cell(s.opp, false)])
    );
  }
}

function syncActions(all, any) {
  const a = $('btn-all');
  const r = $('btn-reset');
  if (a) a.disabled = all;
  if (r) r.disabled = !any;
}

/** Union of NFL games across every matchup in the league. */
function leagueGames(d) {
  const games = new Map();
  const count = new Map();
  for (const m of d.league) {
    for (const g of m.model.games) games.set(g.id, g);
    for (const s of m.model.slots) for (const p of [s.me, s.opp]) if (p?.gameId != null) count.set(p.gameId, (count.get(p.gameId) ?? 0) + 1);
  }
  return { games: [...games.values()], count };
}

function paintLeague(v) {
  const { data, watched, lg } = v;
  const mineFirst = [...data.league].sort((a, b) => (b.fantasyGameId === data.matchup?.fantasyGameId) - (a.fantasyGameId === data.matchup?.fantasyGameId));
  $('mlist').replaceChildren(
    ...mineFirst.map((m) => {
      const { r, rows } = scoreRows(m.model, [m.awayName, m.homeName], watched);
      const mine = m.awayId === lg.teamId || m.homeId === lg.teamId;
      // Highlight the leader only once that matchup is fully watched.
      const lead = r.allWatched && r.me !== r.opp ? (r.me > r.opp ? 'me' : 'opp') : null;
      const card = h('div', { class: `mcard${mine ? ' yours' : ''}` }, ...rows, matchStatus(r));
      if (lead) card.querySelector(`.srow.${lead}`)?.classList.add('lead');
      return card;
    })
  );
  const { games, count } = leagueGames(data);
  renderGameList(
    games,
    watched,
    (g) => {
      const n = count.get(g.id) ?? 0;
      return h('div', { class: 'who muted', text: `${n} league starter${n === 1 ? '' : 's'}` });
    },
    'No NFL games this week.'
  );
  syncActions(games.length > 0 && games.every((g) => watched.has(g.id)), watched.size > 0);
}

const weekOf = (v) => (v.tab === 'all' ? v.week : v.data.week);
const persist = (v) => saveWatched(v.tab === 'all' ? v.season : v.lg.season, weekOf(v), v.watched);
const viewGames = (v) => (v.tab === 'all' ? unionGames(v.items).games : v.tab === 'league' ? leagueGames(v.data).games : v.data.model.games);

function toggleGame(id) {
  const v = state.view;
  if (!v) return;
  if (v.watched.has(id)) {
    v.watched.delete(id);
    unlinger(id);
  } else {
    v.watched.add(id);
    if (state.hideWatched) lingerGame(id);
  }
  persist(v);
  paint();
}

/* ---------- actions ---------- */
function markAll() {
  const v = state.view;
  if (!v) return;
  const startable = viewGames(v).filter((g) => gameStatus(g) !== 'upcoming' && !v.watched.has(g.id));
  if (!startable.length) return;
  if (!confirm(`Reveal ${startable.length} more game${startable.length === 1 ? '' : 's'} for week ${weekOf(v)}? This can show results.`)) return;
  for (const g of startable) {
    v.watched.add(g.id);
    if (state.hideWatched) lingerGame(g.id);
  }
  persist(v);
  paint();
}

function resetWeek() {
  const v = state.view;
  if (!v) return;
  v.watched.clear();
  clearLingers();
  persist(v);
  paint();
}

$('btn-refresh').append(icon('refresh', 22));
$('btn-settings').append(icon('gear', 22));
$('btn-refresh').addEventListener('click', () => {
  if (state.active === 'all') return loadAll({ force: true });
  const lg = state.view?.lg ?? findLeague(state.active);
  if (lg) loadLeague(lg, { force: true });
});
$('btn-settings').addEventListener('click', openSettingsSheet);

/* ---------- bottom nav: hides while scrolling down, returns on scroll up ---------- */
{
  let lastY = window.scrollY;
  let queued = false;
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const y = Math.max(0, window.scrollY);
        const dy = y - lastY;
        const atTop = y < 80;
        const atBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 4;
        const nav = $('nav');
        if (atTop || atBottom || dy < -6) nav.classList.remove('away');
        else if (dy > 6) nav.classList.add('away');
        if (Math.abs(dy) > 6 || atTop) lastY = y; // ignore jitter so slow scrolls still add up
      });
    },
    { passive: true }
  );
}

/* ---------- boot ---------- */
function boot() {
  migrateWatched();
  const params = new URLSearchParams(location.search);
  const qLeague = params.get('league');
  if (qLeague && /^\d{1,12}$/.test(qLeague) && !findLeague(qLeague)) {
    state.active = 'add';
    renderNav();
    renderSetup({ prefill: qLeague });
  } else if (qLeague && findLeague(qLeague)) {
    go(qLeague);
  } else if (state.active === 'all' && state.leagues.length > 1) {
    go('all');
  } else if (state.active && findLeague(state.active)) {
    go(state.active);
  } else if (state.leagues.length) {
    go(state.leagues[0].leagueId);
  } else {
    go('add'); // first launch: league ID pre-filled with the default and teams auto-loaded
  }
  if (qLeague) history.replaceState(null, '', location.pathname);
}
boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
