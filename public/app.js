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

const watchedKey = (lg, week) => `watched:${lg.leagueId}:${lg.season}:${week}`;
const loadWatched = (lg, week) => new Set(store.get(watchedKey(lg, week), []));
const saveWatched = (lg, week, set) => store.set(watchedKey(lg, week), [...set]);
// A week is "done" once every game in your matchup is ticked and final (drives the default week).
const doneKey = (lg, week) => `done:${lg.leagueId}:${lg.season}:${lg.teamId}:${week}`;
const isDone = (lg, week) => store.get(doneKey(lg, week), false) === true;

/* ---------- state ---------- */
const state = {
  leagues: store.get('leagues', []), // [{leagueId, season, leagueName, teamId, teamName}]
  active: store.get('active', null), // leagueId or 'add'
  weekByLeague: {}, // leagueId -> selected week (in-memory, defaults to current)
  meta: {}, // leagueId -> {currentWeek, weeks}
  cache: new Map(), // `${leagueId}:${season}:${teamId}:${week}` -> view data (in memory only)
  view: null, // current rendered league view data
  mode: 'mine', // 'mine' | 'league'
  hideWatched: store.get('hideWatched', false) === true,
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

const fmtTotal = (n) => n.toFixed(2);
const fmtPts = (n) => String(Math.round(n * 100) / 100);
const fmtKick = (ms) =>
  ms ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const slotLabel = (l) => (l.includes('/') ? (l.includes('QB') ? 'SFLX' : 'FLEX') : l);
const gameStatus = (g) => (g.final ? 'final' : g.kickoff && Date.now() >= g.kickoff ? 'live' : 'upcoming');

/* ---------- tabs ---------- */
function renderTabs() {
  const nav = $('tabs');
  nav.replaceChildren(
    ...state.leagues.map((lg) =>
      h('button', {
        class: 'tab',
        role: 'tab',
        type: 'button',
        'aria-selected': String(state.active === lg.leagueId),
        title: lg.leagueName,
        text: lg.teamName,
        onclick: () => go(lg.leagueId),
      })
    ),
    h('button', {
      class: 'tab add',
      role: 'tab',
      type: 'button',
      'aria-label': 'Add league',
      'aria-selected': String(state.active === 'add'),
      text: '+',
      onclick: () => go('add'),
    })
  );
  nav.setAttribute('role', 'tablist');
  nav.querySelector('[aria-selected="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function go(id) {
  state.active = id;
  if (id !== 'add') store.set('active', id);
  renderTabs();
  if (id === 'add') renderSetup({});
  else loadLeague(findLeague(id));
}

/* ---------- setup ---------- */
function renderSetup({ prefill, changeTeamFor }) {
  $('actions').hidden = true;
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

/* ---------- league view ---------- */
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
  $('actions').hidden = true;
  state.view = null;
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
    let week = state.weekByLeague[lg.leagueId];
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
      state.weekByLeague[lg.leagueId] = week;
    } else {
      d = await getWeek(lg, week, { force, sbRaw: sbFor(week) });
    }
    if (state.mode === 'league') await getLeagueModels(lg, d);
    if (seq !== state.seq) return; // user navigated away meanwhile
    renderLeague(lg, meta, d);
  } catch (e) {
    if (seq !== state.seq) return;
    main().replaceChildren(
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong loading this league.' }),
        h('div', { class: 'manage' },
          h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: () => loadLeague(lg, { force: true }) }),
          manageButtons(lg)
        )
      )
    );
  }
}

function manageButtons(lg) {
  return [
    h('button', { class: 'btn ghost', type: 'button', text: 'Change team', onclick: () => renderSetup({ changeTeamFor: lg.leagueId }) }),
    h('button', {
      class: 'btn ghost danger',
      type: 'button',
      text: 'Remove league',
      onclick: () => {
        if (!confirm(`Remove ${lg.leagueName} from this device?`)) return;
        state.leagues = state.leagues.filter((l) => l.leagueId !== lg.leagueId);
        saveLeagues();
        go(state.leagues[0]?.leagueId ?? 'add');
      },
    }),
  ];
}

function weekBar(lg, meta, week) {
  const weeks = meta.weeks;
  const idx = weeks.indexOf(week);
  const setWeek = (w) => {
    state.weekByLeague[lg.leagueId] = w;
    loadLeague(lg);
  };
  const sel = h(
    'select',
    { 'aria-label': 'NFL week', onchange: (e) => setWeek(Number(e.target.value)) },
    weeks.map((w) => {
      const o = h('option', { value: String(w), text: `Week ${w}${w === meta.currentWeek ? ' (now)' : ''}` });
      if (w === week) o.selected = true;
      return o;
    })
  );
  return h(
    'div',
    { class: 'weekbar' },
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Previous week', text: '‹', disabled: idx <= 0, onclick: () => setWeek(weeks[idx - 1]) }),
    sel,
    h('button', { class: 'btn', type: 'button', 'aria-label': 'Next week', text: '›', disabled: idx < 0 || idx >= weeks.length - 1, onclick: () => setWeek(weeks[idx + 1]) })
  );
}

function modeSwitch(lg) {
  const btn = (mode, label) =>
    h('button', {
      type: 'button',
      class: 'seg',
      'aria-pressed': String(state.mode === mode),
      text: label,
      onclick: () => {
        if (state.mode === mode) return;
        state.mode = mode;
        loadLeague(lg);
      },
    });
  return h('div', { class: 'segbar', role: 'group', 'aria-label': 'View' }, btn('mine', 'Mine'), btn('league', 'League'));
}

function renderLeague(lg, meta, d) {
  const { week } = d;
  const head = [h('div', { class: 'controls' }, weekBar(lg, meta, week), modeSwitch(lg))];
  const manage = h('section', { class: 'card' }, h('h2', { text: lg.leagueName }), h('div', { class: 'manage' }, manageButtons(lg)));
  const watched = loadWatched(lg, week);

  if (state.mode === 'league') {
    state.view = { lg, meta, data: d, watched, mode: 'league' };
    main().replaceChildren(
      ...head,
      h('section', { class: 'card' }, h('h2', { text: 'Matchups' }), h('div', { class: 'mlist', id: 'mlist' })),
      h('section', { class: 'card' }, gamesHead('NFL games'), h('div', { class: 'games', id: 'games' })),
      manage
    );
  } else if (!d.matchup) {
    state.view = null;
    $('actions').hidden = true;
    main().replaceChildren(...head, h('section', { class: 'card' }, h('p', { class: 'muted', text: `${lg.teamName} has no matchup in week ${week}.` })), manage);
    return;
  } else {
    state.view = { lg, meta, data: d, watched, mode: 'mine' };
    main().replaceChildren(
      ...head,
      h('section', { class: 'card matchup', id: 'matchup' }),
      h('section', { class: 'card' }, gamesHead('NFL games'), h('div', { class: 'games', id: 'games' })),
      h('section', { class: 'card' }, h('h2', { text: 'Starting lineups' }), h('div', { class: 'lineup', id: 'lineup' })),
      manage
    );
  }
  $('actions').hidden = false;
  paint();
}

/* ---------- shared view pieces ---------- */

/** Starters whose NFL game hasn't been ticked (byes and empty slots excluded). */
const playersLeft = (model, side, watched) =>
  model.slots.reduce((n, s) => n + (s[side]?.gameId != null && !watched.has(s[side].gameId) ? 1 : 0), 0);

/**
 * Scoreboard rows: one row per team, name + players left on the left, score on the right.
 * A score only appears once at least one of that matchup's games has been watched.
 */
function scoreRows(model, names, watched, { big = true } = {}) {
  const r = computeReveal(model, watched);
  const row = (side, name, pts) => {
    const left = playersLeft(model, side, watched);
    return h(
      'div',
      { class: `srow ${side}` },
      h('div', { class: 'sname' }, h('div', { class: 'tname', text: name }), h('div', { class: 'left', text: left ? `${left} player${left === 1 ? '' : 's'} left` : 'All watched' })),
      r.anyWatched ? h('div', { class: big ? 'pts' : 'pts sm', text: fmtTotal(pts) }) : null
    );
  };
  return { r, rows: [row('me', names[0], r.me), row('opp', names[1], r.opp)] };
}

/** Status line: locked progress, or the result once every game is ticked. */
function statusLine(r, { mine }) {
  if (!r.allWatched) return h('div', { class: 'status', text: `🔒 ${r.watchedCount}/${r.total} games watched` });
  const diff = Math.round((r.me - r.opp) * 100) / 100;
  if (!mine) {
    const t = diff === 0 ? 'Tied' : r.allFinal ? 'Final' : 'In progress';
    return h('div', { class: 'status done', text: t });
  }
  const tail = r.allFinal ? '' : ' (still in progress)';
  if (diff > 0) return h('div', { class: 'result win', text: r.allFinal ? 'You win' : `You lead${tail}` });
  if (diff < 0) return h('div', { class: 'result loss', text: r.allFinal ? 'You lose' : `You trail${tail}` });
  return h('div', { class: 'result', text: r.allFinal ? 'Tie' : `Tied${tail}` });
}

/** Kickoff order; optionally drop games already watched. */
function visibleGames(games, watched) {
  const sorted = [...games].sort((a, b) => a.kickoff - b.kickoff || a.id - b.id);
  return state.hideWatched ? sorted.filter((g) => !watched.has(g.id)) : sorted;
}

/** Card header with a show/hide-watched chip. */
function gamesHead(title) {
  return h(
    'div',
    { class: 'cardhead' },
    h('h2', { text: title }),
    h('button', {
      class: 'chip',
      id: 'btn-hide',
      type: 'button',
      'aria-pressed': String(state.hideWatched),
      text: 'Hide watched',
      onclick: (e) => {
        state.hideWatched = !state.hideWatched;
        store.set('hideWatched', state.hideWatched);
        e.currentTarget.setAttribute('aria-pressed', String(state.hideWatched));
        paint();
      },
    })
  );
}

function renderGameList(games, watched, detailFor, emptyText) {
  const list = visibleGames(games, watched);
  const hidden = games.length - list.length;
  const nodes = list.map((g) => gameCard(g, watched, detailFor(g)));
  if (!games.length) nodes.push(h('p', { class: 'empty-note', text: emptyText }));
  else if (!list.length) nodes.push(h('p', { class: 'empty-note', text: `All ${hidden} watched games hidden.` }));
  $('games').replaceChildren(...nodes);
}

function gameCard(g, watched, detail) {
  const st = gameStatus(g);
  const on = watched.has(g.id);
  return h(
    'button',
    { class: 'game', type: 'button', 'aria-pressed': String(on), disabled: st === 'upcoming' && !on, onclick: () => toggleGame(g.id) },
    h(
      'div',
      {},
      h(
        'div',
        { class: 'gtop' },
        h('span', { class: 'matchupname', text: `${g.away} @ ${g.home}` }),
        st === 'live' ? h('span', { class: 'badge live', text: 'LIVE' }) : h('span', { class: 'meta', text: st === 'upcoming' ? fmtKick(g.kickoff) : `${fmtKick(g.kickoff)} · Final` })
      ),
      detail
    ),
    h('span', { class: 'toggle', 'aria-hidden': 'true' })
  );
}

/** Re-render all spoiler-sensitive parts from the in-memory model + watched set. */
function paint() {
  const v = state.view;
  if (!v) return;
  if (v.mode === 'league') return paintLeague(v);
  const { lg, data, watched } = v;
  const { model, matchup } = data;

  // Matchup card
  const { r, rows } = scoreRows(model, [matchup.myName, matchup.oppName], watched);
  const sum = r.me + r.opp;
  const bar =
    r.anyWatched && sum > 0
      ? h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { class: 'm', style: `width:${Math.max(0, (r.me / sum) * 100)}%` }), h('i', { class: 'o', style: `width:${Math.max(0, (r.opp / sum) * 100)}%` }))
      : null;
  $('matchup').replaceChildren(...[...rows, bar, statusLine(r, { mine: true })].filter(Boolean));
  store.set(doneKey(lg, data.week), r.allWatched && r.allFinal);

  // Games: names always, each player's points once the game is ticked.
  const byGame = new Map(model.games.map((g) => [g.id, { me: [], opp: [] }]));
  for (const s of model.slots) {
    if (s.me?.gameId != null) byGame.get(s.me.gameId)?.me.push(s.me);
    if (s.opp?.gameId != null) byGame.get(s.opp.gameId)?.opp.push(s.opp);
  }
  const playerList = (players, revealed) =>
    players.flatMap((p, i) => [i ? ', ' : '', p.name, revealed ? h('b', { class: 'gp', text: ` ${fmtPts(p.points)}` }) : null]);
  const whoLine = (who, revealed) =>
    h(
      'div',
      { class: 'who' },
      who.me.length ? h('span', { class: 'm' }, 'You: ', ...playerList(who.me, revealed)) : null,
      who.me.length && who.opp.length ? ' · ' : null,
      who.opp.length ? h('span', { class: 'o' }, 'Opp: ', ...playerList(who.opp, revealed)) : null
    );
  renderGameList(model.games, watched, (g) => whoLine(byGame.get(g.id), watched.has(g.id)), 'No NFL games for these starters this week.');

  // Lineups
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

  $('btn-all').disabled = r.allWatched;
  $('btn-reset').disabled = !r.anyWatched;
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
      const { r, rows } = scoreRows(m.model, [m.awayName, m.homeName], watched, { big: false });
      const mine = m.awayId === lg.teamId || m.homeId === lg.teamId;
      // Highlight the leader only once that matchup is fully watched.
      const lead = r.allWatched && r.me !== r.opp ? (r.me > r.opp ? 'me' : 'opp') : null;
      const card = h('div', { class: `mcard${mine ? ' yours' : ''}` }, ...rows, statusLine(r, { mine: false }));
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
  const all = games.length > 0 && games.every((g) => watched.has(g.id));
  $('btn-all').disabled = all;
  $('btn-reset').disabled = watched.size === 0;
}

function toggleGame(id) {
  const v = state.view;
  if (!v) return;
  if (v.watched.has(id)) v.watched.delete(id);
  else v.watched.add(id);
  saveWatched(v.lg, v.data.week, v.watched);
  paint();
}

/* ---------- actions ---------- */
$('btn-all').addEventListener('click', () => {
  const v = state.view;
  if (!v) return;
  const games = v.mode === 'league' ? leagueGames(v.data).games : v.data.model.games;
  const startable = games.filter((g) => gameStatus(g) !== 'upcoming' && !v.watched.has(g.id));
  if (!startable.length) return;
  if (!confirm(`Reveal ${startable.length} more game${startable.length === 1 ? '' : 's'} for week ${v.data.week}? This can show results.`)) return;
  for (const g of startable) v.watched.add(g.id);
  saveWatched(v.lg, v.data.week, v.watched);
  paint();
});
$('btn-reset').addEventListener('click', () => {
  const v = state.view;
  if (!v) return;
  v.watched.clear();
  saveWatched(v.lg, v.data.week, v.watched);
  paint();
});
$('btn-refresh').addEventListener('click', () => {
  const lg = state.view?.lg ?? findLeague(state.active);
  if (lg) loadLeague(lg, { force: true });
});

/* ---------- boot ---------- */
function boot() {
  const params = new URLSearchParams(location.search);
  const qLeague = params.get('league');
  renderTabs();
  if (qLeague && /^\d{1,12}$/.test(qLeague) && !findLeague(qLeague)) {
    state.active = 'add';
    renderTabs();
    renderSetup({ prefill: qLeague });
  } else if (qLeague && findLeague(qLeague)) {
    go(qLeague);
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
