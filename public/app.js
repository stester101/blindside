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

/* ---------- state ---------- */
const state = {
  leagues: store.get('leagues', []), // [{leagueId, season, leagueName, teamId, teamName}]
  active: store.get('active', null), // leagueId or 'add'
  weekByLeague: {}, // leagueId -> selected week (in-memory, defaults to current)
  meta: {}, // leagueId -> {currentWeek, weeks}
  cache: new Map(), // `${leagueId}:${season}:${teamId}:${week}` -> view data (in memory only)
  view: null, // current rendered league view data
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
async function loadLeague(lg, { force = false } = {}) {
  if (!lg) return go('add');
  const seq = ++state.seq;
  $('actions').hidden = true;
  state.view = null;
  main().replaceChildren(h('p', { class: 'muted center pad', text: 'Loading matchup…' }));

  try {
    let meta = state.meta[lg.leagueId];
    let firstSb = null;
    if (!meta || force) {
      // Without scoring_period Fleaflicker returns the current week.
      firstSb = await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season });
      const p = parseScoreboard(firstSb, lg.teamId);
      meta = { currentWeek: p.currentWeek ?? p.week, weeks: p.weeks.length ? p.weeks : [p.week] };
      state.meta[lg.leagueId] = meta;
    }
    const week = state.weekByLeague[lg.leagueId] ?? meta.currentWeek;
    state.weekByLeague[lg.leagueId] = week;
    const ck = `${lg.leagueId}:${lg.season}:${lg.teamId}:${week}`;
    let data = force ? null : state.cache.get(ck);
    if (!data) {
      const sbRaw =
        firstSb && parseScoreboard(firstSb, lg.teamId).week === week
          ? firstSb
          : await api('FetchLeagueScoreboard', { league_id: lg.leagueId, season: lg.season, scoring_period: week });
      const sb = parseScoreboard(sbRaw, lg.teamId);
      if (!sb.matchup) {
        data = { week, matchup: null };
      } else {
        const box = await api('FetchLeagueBoxscore', {
          league_id: lg.leagueId,
          scoring_period: week,
          fantasy_game_id: sb.matchup.fantasyGameId,
        });
        data = { week, matchup: sb.matchup, model: parseBoxscore(box, lg.teamId) };
      }
      state.cache.set(ck, data);
    }
    if (seq !== state.seq) return; // user navigated away meanwhile
    renderLeague(lg, meta, data);
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

function renderLeague(lg, meta, data) {
  const { week } = data;
  if (!data.matchup) {
    $('actions').hidden = true;
    main().replaceChildren(
      weekBar(lg, meta, week),
      h('section', { class: 'card' }, h('p', { class: 'muted', text: `${lg.teamName} has no matchup in week ${week}.` })),
      h('section', { class: 'card' }, h('div', { class: 'manage' }, manageButtons(lg)))
    );
    return;
  }
  const watched = loadWatched(lg, week);
  state.view = { lg, meta, data, watched };
  main().replaceChildren(
    weekBar(lg, meta, week),
    h('section', { class: 'card matchup', id: 'matchup' }),
    h('section', { class: 'card' }, h('h2', { text: 'NFL games' }), h('div', { class: 'games', id: 'games' })),
    h('section', { class: 'card' }, h('h2', { text: 'Starting lineups' }), h('div', { class: 'lineup', id: 'lineup' })),
    h('section', { class: 'card' }, h('h2', { text: lg.leagueName }), h('div', { class: 'manage' }, manageButtons(lg)))
  );
  $('actions').hidden = false;
  paint();
}

/** Re-render all spoiler-sensitive parts from the in-memory model + watched set. */
function paint() {
  const v = state.view;
  if (!v) return;
  const { data, watched } = v;
  const { model, matchup } = data;
  const r = computeReveal(model, watched);

  // Players left: starters whose NFL game isn't ticked yet (byes/empty slots excluded).
  // Uses only lineups, kickoff times and the watched set, never points.
  const gameById = new Map(model.games.map((g) => [g.id, g]));
  const leftFor = (side) => {
    let left = 0;
    let yet = 0;
    for (const s of model.slots) {
      const p = s[side];
      if (p?.gameId == null || watched.has(p.gameId)) continue;
      left++;
      if (gameStatus(gameById.get(p.gameId)) === 'upcoming') yet++;
    }
    return h(
      'div',
      { class: 'left' },
      h('div', { text: left ? `${left} left to watch` : 'All watched' }),
      yet ? h('div', { class: 'yet', text: `${yet} yet to play` }) : null
    );
  };

  // Matchup bar
  const show = r.anyWatched;
  const sum = r.me + r.opp;
  const mPct = show && sum > 0 ? Math.max(0, (r.me / sum) * 100) : 0;
  const oPct = show && sum > 0 ? Math.max(0, (r.opp / sum) * 100) : 0;
  let result;
  if (!r.allWatched) {
    const left = r.total - r.watchedCount;
    result = h('div', { class: 'result locked', text: `🔒 Result locked · ${left} game${left === 1 ? '' : 's'} left to watch` });
  } else {
    const diff = Math.round((r.me - r.opp) * 100) / 100;
    const live = !r.allFinal ? ' (games still in progress)' : '';
    if (diff > 0) result = h('div', { class: 'result win', text: r.allFinal ? 'You win!' : `You lead${live}` });
    else if (diff < 0) result = h('div', { class: 'result loss', text: r.allFinal ? 'You lose' : `You trail${live}` });
    else result = h('div', { class: 'result', text: r.allFinal ? 'Tie' : `Tied${live}` });
  }
  $('matchup').replaceChildren(
    h(
      'div',
      { class: 'scoreline' },
      h('div', { class: 'side me' }, h('div', { class: 'tname', text: matchup.myName }), show ? h('div', { class: 'pts', text: fmtTotal(r.me) }) : h('div', { class: 'pts off', text: 'Hidden' }), leftFor('me')),
      h('div', { class: 'vs', text: 'vs' }),
      h('div', { class: 'side opp right' }, h('div', { class: 'tname', text: matchup.oppName }), show ? h('div', { class: 'pts', text: fmtTotal(r.opp) }) : h('div', { class: 'pts off', text: 'Hidden' }), leftFor('opp'))
    ),
    h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { class: 'm', style: `width:${mPct}%` }), h('i', { class: 'o', style: `width:${oPct}%` })),
    h('div', { class: 'small muted center', text: `${r.watchedCount} of ${r.total} games watched` }),
    h('div', { style: 'height:8px' }),
    result
  );

  // Games
  const byGame = new Map(model.games.map((g) => [g.id, { me: [], opp: [] }]));
  for (const s of model.slots) {
    if (s.me?.gameId != null) byGame.get(s.me.gameId)?.me.push(s.me);
    if (s.opp?.gameId != null) byGame.get(s.opp.gameId)?.opp.push(s.opp);
  }
  // Names always; points only once this game is watched.
  const playerList = (players, revealed) =>
    players.flatMap((p, i) => [
      i ? ', ' : '',
      p.name,
      revealed ? h('b', { class: 'gp', text: ` ${fmtPts(p.points)}` }) : null,
    ]);
  const whoLine = (who, revealed) =>
    h(
      'div',
      { class: 'who' },
      who.me.length ? h('span', { class: 'm' }, 'You: ', ...playerList(who.me, revealed)) : null,
      who.me.length && who.opp.length ? ' · ' : null,
      who.opp.length ? h('span', { class: 'o' }, 'Opp: ', ...playerList(who.opp, revealed)) : null
    );
  $('games').replaceChildren(
    ...(model.games.length
      ? model.games.map((g) => {
          const st = gameStatus(g);
          const on = watched.has(g.id);
          const who = byGame.get(g.id);
          return h(
            'button',
            {
              class: 'game',
              type: 'button',
              'aria-pressed': String(on),
              disabled: st === 'upcoming' && !on,
              onclick: () => toggleGame(g.id),
            },
            h(
              'div',
              {},
              h('div', { class: 'matchupname' }, `${g.away} @ ${g.home}`, st === 'live' ? h('span', { class: 'badge live', text: 'LIVE' }) : null),
              h('div', {
                class: 'meta',
                text: st === 'upcoming' ? `Kicks off ${fmtKick(g.kickoff)}` : st === 'live' ? 'In progress · points so far' : `${fmtKick(g.kickoff)} · Final`,
              }),
              whoLine(who, on)
            ),
            h('span', { class: 'toggle', 'aria-hidden': 'true' })
          );
        })
      : [h('p', { class: 'muted', text: 'No NFL games for these starters this week.' })])
  );

  // Lineups
  const cell = (p, mine) => {
    const cls = mine ? 'pl mine' : 'pl theirs right';
    if (!p) return h('div', { class: `${cls} empty` }, h('div', { class: 'n', text: 'Empty' }));
    const rev = p.gameId != null && watched.has(p.gameId);
    // Only a revealed score or BYE gets a points line; otherwise nothing is shown.
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
  const startable = v.data.model.games.filter((g) => gameStatus(g) !== 'upcoming');
  if (!startable.length) return;
  if (!confirm(`Reveal all ${startable.length} games for week ${v.data.week}? This can show the result.`)) return;
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
