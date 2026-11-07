#!/usr/bin/env node
// Feasibility test for a "game scrubber".
//
// Question: can public nflverse play-by-play be joined to Fleaflicker players, reproduce their
// stats, and give running fantasy points that land on Fleaflicker's exact final points?
//
// For every starter in every matchup of a league/week this script:
//   1. pulls Fleaflicker boxscores (the real per-player points + headline stats),
//   2. downloads nflverse play-by-play + the player-ID crosswalk (cached on disk),
//   3. joins the two (Fleaflicker player id -> GSIS id, Fleaflicker NFL game -> nflverse game),
//   4. checks headline stats agree, and how close play-derived points get to Fleaflicker's points,
//   5. with --demo, replays one player's game play by play like the scrubber would.
//
// Usage:  NODE_USE_ENV_PROXY=1 node scripts/pbp-feasibility.mjs [--league 219707] [--week 8]
//                                                               [--season 2026] [--demo] [--cache DIR]
// (NODE_USE_ENV_PROXY=1 is only needed behind an HTTP proxy; Node 22.21+.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[process.argv[i].slice(2)] = next && !next.startsWith('--') ? next : true;
}
const LEAGUE = String(args.league ?? '219707');
const WEEK = Number(args.week ?? 8);
const SEASON = Number(args.season ?? 2026);
const CACHE = String(args.cache ?? path.join(os.tmpdir(), 'blindside-pbp'));
fs.mkdirSync(CACHE, { recursive: true });

const FF = 'https://www.fleaflicker.com/api';
const PBP_URL = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${SEASON}.csv`;
const IDS_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';

const say = (s = '') => console.log(s);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : 'n/a');
const pad = (v, n, right = false) => (right ? String(v).padStart(n) : String(v).padEnd(n));
// Fleaflicker and nflverse spell a few teams differently.
const team = (t) => ({ JAC: 'JAX', LAR: 'LA', WSH: 'WAS' })[t] ?? t;

/* ------------------------------------------------------------------ fetching */
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function download(url, file, label) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) {
    say(`  ${label}: cached (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
    return fs.readFileSync(file, 'utf8');
  }
  const t0 = Date.now();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(file, buf);
  say(`  ${label}: downloaded ${(buf.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return buf.toString('utf8');
}

/* ----------------------------------------------------------------------- csv */
function* csvRows(text) {
  const re = /[",\r\n]/g;
  const n = text.length;
  let pos = 0;
  let field = '';
  let row = [];
  let inQ = false;
  while (pos < n) {
    re.lastIndex = pos;
    const m = re.exec(text);
    const j = m ? m.index : n;
    field += text.slice(pos, j);
    if (!m) break;
    const c = text[j];
    if (c === '"') {
      if (inQ && text[j + 1] === '"') {
        field += '"';
        pos = j + 2;
      } else {
        inQ = !inQ;
        pos = j + 1;
      }
    } else if (inQ) {
      field += c;
      pos = j + 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      pos = j + 1;
    } else {
      row.push(field);
      field = '';
      pos = c === '\r' && text[j + 1] === '\n' ? j + 2 : j + 1;
      yield row;
      row = [];
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    yield row;
  }
}

/* ------------------------------------------------------- 1. Fleaflicker side */
async function loadFleaflicker() {
  const sb = await getJson(`${FF}/FetchLeagueScoreboard?sport=NFL&league_id=${LEAGUE}&season=${SEASON}&scoring_period=${WEEK}`);
  const out = new Map(); // `${ffPlayerId}:${nflGameId}` -> player-game
  for (const g of sb.games ?? []) {
    const box = await getJson(`${FF}/FetchLeagueBoxscore?sport=NFL&league_id=${LEAGUE}&scoring_period=${WEEK}&fantasy_game_id=${g.id}`);
    const starters = (box.lineups ?? []).find((l) => l.group === 'START');
    for (const slot of starters?.slots ?? []) {
      for (const side of ['away', 'home']) {
        const p = slot[side];
        if (!p?.proPlayer) continue;
        for (const rg of p.requestedGames ?? []) {
          if (!rg.game) continue; // bye
          const key = `${p.proPlayer.id}:${rg.game.id}`;
          if (out.has(key)) continue;
          // null = Fleaflicker doesn't list that category for this player (e.g. QB rushing yards), so it can't be checked.
          const stat = (id) => {
            const c = rg.stats?.find((s) => s.category.id === id);
            return c ? (c.value?.value ?? 0) : null;
          };
          out.set(key, {
            ffId: String(p.proPlayer.id),
            name: p.proPlayer.nameFull,
            pos: p.proPlayer.position,
            team: p.proPlayer.proTeamAbbreviation,
            nflGame: rg.game.id,
            away: rg.game.away.abbreviation,
            home: rg.game.home.abbreviation,
            points: rg.pointsActual?.value ?? 0,
            ff: { passYd: stat(3), rushYd: stat(22), recYd: stat(42), offTD: stat(29) },
          });
        }
      }
    }
  }
  return { matchups: sb.games?.length ?? 0, players: [...out.values()] };
}

/* ------------------------------------------------------------ 2. play-by-play */
const NUM = (v) => (v === '' || v === 'NA' || v == null ? 0 : Number(v));
function loadPlays(text) {
  const rows = csvRows(text);
  const header = rows.next().value;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const need = ['game_id', 'week', 'season_type', 'home_team', 'away_team', 'qtr', 'quarter_seconds_remaining', 'desc', 'play_type',
    'passer_player_id', 'rusher_player_id', 'receiver_player_id', 'passing_yards', 'rushing_yards', 'receiving_yards', 'pass_touchdown',
    'rush_touchdown', 'interception', 'fumble_lost', 'fumbled_1_player_id', 'complete_pass', 'play_id', 'posteam', 'two_point_conv_result',
    'passer_player_name', 'rusher_player_name', 'receiver_player_name'];
  const missing = need.filter((c) => !(c in col));
  if (missing.length) throw new Error(`play-by-play is missing expected columns: ${missing.join(', ')}`);
  const plays = [];
  let total = 0;
  for (const r of rows) {
    total++;
    if (r[col.season_type] !== 'REG' || Number(r[col.week]) !== WEEK) continue;
    const g = (c) => r[col[c]];
    plays.push({
      gid: g('game_id'), home: g('home_team'), away: g('away_team'), qtr: NUM(g('qtr')), qsec: NUM(g('quarter_seconds_remaining')),
      desc: g('desc'), type: g('play_type'), passer: g('passer_player_id'), rusher: g('rusher_player_id'), receiver: g('receiver_player_id'),
      passYd: NUM(g('passing_yards')), rushYd: NUM(g('rushing_yards')), recYd: NUM(g('receiving_yards')),
      passTD: NUM(g('pass_touchdown')), rushTD: NUM(g('rush_touchdown')), int: NUM(g('interception')), fumLost: NUM(g('fumble_lost')),
      fumbler: g('fumbled_1_player_id'), comp: NUM(g('complete_pass')), id: NUM(g('play_id')), posteam: g('posteam'), twoPt: g('two_point_conv_result') === 'success',
      pName: g('passer_player_name'), rName: g('rusher_player_name'), cName: g('receiver_player_name'),
    });
  }
  return { plays, total };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
/** "Amon-Ra St. Brown" -> "a|stbrown": first initial + the rest of the name, so it matches "A.St. Brown" in the feed. */
function initialLast(full) {
  const parts = String(full).trim().split(/\s+/);
  return `${norm(parts[0])[0] ?? ''}|${norm(parts.slice(1).join(' '))}`;
}
function feedInitialLast(short) {
  const i = String(short).indexOf('.');
  return i < 0 ? null : `${norm(short[0])}|${norm(short.slice(i + 1))}`;
}

/** Per play: which players' stats change, as { gsisId: {feature: delta} }. */
function playEffects(p) {
  const fx = {};
  const add = (id, k, v) => {
    if (!id || id === 'NA' || !v) return;
    (fx[id] ??= {})[k] = (fx[id][k] ?? 0) + v;
  };
  add(p.passer, 'passYd', p.passYd);
  add(p.passer, 'passTD', p.passTD);
  add(p.passer, 'int', p.int);
  add(p.rusher, 'rushYd', p.rushYd);
  add(p.rusher, 'rushTD', p.rushTD);
  add(p.receiver, 'rec', p.comp);
  add(p.receiver, 'recYd', p.recYd);
  add(p.receiver, 'recTD', p.passTD);
  if (p.fumLost) add(p.fumbler, 'fumLost', 1);
  if (p.twoPt) {
    if (p.rusher && p.rusher !== 'NA') add(p.rusher, 'twoPt', 1);
    else {
      add(p.passer, 'twoPt', 1);
      add(p.receiver, 'twoPt', 1);
    }
  }
  return fx;
}

/* --------------------------------------------------------------- 3. scoring */
const FEATURES = ['passYd', 'passTD', 'int', 'rushYd', 'rushTD', 'rec', 'recYd', 'recTD', 'fumLost', 'twoPt'];
const dot = (f, S) => FEATURES.reduce((t, k) => t + (f[k] ?? 0) * (S[k] ?? 0), 0);
const std = (ppr, passTD) => ({ passYd: 0.04, passTD, int: -2, rushYd: 0.1, rushTD: 6, rec: ppr, recYd: 0.1, recTD: 6, fumLost: -2, twoPt: 2 });

function ridgeFit(rows, lambda = 1e-3) {
  const n = FEATURES.length;
  const A = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (const { f, y } of rows) {
    for (let i = 0; i < n; i++) {
      const xi = f[FEATURES[i]] ?? 0;
      for (let j = 0; j < n; j++) A[i][j] += xi * (f[FEATURES[j]] ?? 0);
      A[i][n] += xi * y;
    }
  }
  for (let i = 0; i < n; i++) A[i][i] += lambda;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j];
    }
  }
  return Object.fromEntries(FEATURES.map((k, i) => [k, A[i][n] / A[i][i]]));
}
const stats = (xs) => ({
  mae: xs.reduce((t, e) => t + Math.abs(e), 0) / xs.length,
  w05: xs.filter((e) => Math.abs(e) <= 0.5).length,
  w2: xs.filter((e) => Math.abs(e) <= 2).length,
});

/* --------------------------------------------------------------------- main */
say(`Blindside scrubber feasibility test: league ${LEAGUE}, week ${WEEK}, season ${SEASON}`);
say('='.repeat(72));

say('\n[1/4] Fleaflicker boxscores');
const { matchups, players } = await loadFleaflicker();
say(`  ${matchups} matchups, ${players.length} starter player-games (each is one starter in one NFL game)`);

say('\n[2/4] Public data (nflverse)');
const pbpText = await download(PBP_URL, path.join(CACHE, `play_by_play_${SEASON}.csv`), `play-by-play ${SEASON}`);
const idsText = await download(IDS_URL, path.join(CACHE, 'db_playerids.csv'), 'player-ID crosswalk');
const t0 = Date.now();
const { plays, total } = loadPlays(pbpText);
say(`  parsed ${total.toLocaleString()} plays in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${plays.length.toLocaleString()} are week ${WEEK}`);

const idRows = csvRows(idsText);
const idHead = idRows.next().value;
const ixFF = idHead.indexOf('fleaflicker_id');
const ixGsis = idHead.indexOf('gsis_id');
const ixName = idHead.indexOf('name');
const ixPos = idHead.indexOf('position');
const ixTeam = idHead.indexOf('team');
const toGsis = new Map(); // by Fleaflicker id (sparse)
const byName = new Map(); // "normalised name|position" -> [{gsis, team}]
let withGsis = 0;
for (const r of idRows) {
  if (!r[ixGsis] || r[ixGsis] === 'NA') continue;
  withGsis++;
  if (r[ixFF] && r[ixFF] !== 'NA') toGsis.set(String(r[ixFF]), r[ixGsis]);
  const k = `${norm(r[ixName])}|${r[ixPos]}`;
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push({ gsis: r[ixGsis], team: r[ixTeam] });
}
say(`  crosswalk: ${withGsis.toLocaleString()} players with a GSIS id, but only ${toGsis.size.toLocaleString()} have a Fleaflicker id filled in`);

// Names as the play data itself spells them (gsis id by team + initial/last name).
const feedNames = new Map();
for (const p of plays) {
  for (const [id, nm] of [[p.passer, p.pName], [p.rusher, p.rName], [p.receiver, p.cName]]) {
    const k = id && id !== 'NA' && nm ? feedInitialLast(nm) : null;
    if (k) feedNames.set(`${p.posteam}|${k}`, id);
  }
}

// nflverse game per team pair; accumulate per-player stats and keep each player's plays for the replay.
const games = new Map(); // "AWAY@HOME" (normalised) -> { gid, plays: [] }
for (const p of plays) {
  const k = `${p.away}@${p.home}`;
  if (!games.has(k)) games.set(k, { gid: p.gid, plays: [] });
  games.get(k).plays.push(p);
}
for (const g of games.values()) g.plays.sort((a, b) => a.id - b.id);

say('\n[3/4] Joining the two');
const rows = [];
const problems = { noGsis: [], noGame: [], noPlays: [], zero: [] };
for (const pl of players) {
  const g = games.get(`${team(pl.away)}@${team(pl.home)}`);
  if (!g) {
    problems.noGame.push(`${pl.name} (${pl.away}@${pl.home})`);
    continue;
  }
  // 1) Fleaflicker id in the crosswalk, 2) name + position in the crosswalk, 3) name inside the play data.
  let gsis = toGsis.get(pl.ffId);
  let via = 'id';
  if (!gsis) {
    const cands = byName.get(`${norm(pl.name)}|${pl.pos}`) ?? [];
    gsis = (cands.find((c) => [team(pl.away), team(pl.home), team(pl.team)].includes(team(c.team))) ?? cands[0])?.gsis;
    via = 'name';
  }
  if (!gsis) {
    const k = initialLast(pl.name);
    gsis = [pl.away, pl.home].map((t) => feedNames.get(`${team(t)}|${k}`)).find(Boolean);
    via = 'feed-name';
  }
  if (!gsis) {
    problems.noGsis.push(`${pl.name} (${pl.pos})`);
    continue;
  }
  const f = {};
  const log = [];
  for (const p of g.plays) {
    const fx = playEffects(p)[gsis];
    if (!fx) continue;
    for (const [k, v] of Object.entries(fx)) f[k] = (f[k] ?? 0) + v;
    log.push({ p, fx });
  }
  if (!log.length) {
    (pl.points === 0 ? problems.zero : problems.noPlays).push(`${pl.name} (${pl.pos})`);
    continue;
  }
  rows.push({ ...pl, gsis, via, f, log, y: pl.points });
}
say(`  Fleaflicker game -> nflverse game: ${pct(players.length - problems.noGame.length, players.length)} (${problems.noGame.length} unmatched)`);
say(`  Fleaflicker player -> GSIS id:     ${pct(players.length - problems.noGame.length - problems.noGsis.length, players.length - problems.noGame.length)} (${problems.noGsis.length} unmatched${problems.noGsis.length ? ': ' + problems.noGsis.join(', ') : ''})`);
say(`  Players with plays in the feed:    ${rows.length} of ${players.length}`);
if (problems.zero.length) say(`  No plays AND 0.00 points (consistent, nothing to replay): ${problems.zero.join(', ')}`);
if (problems.noPlays.length) say(`  No plays but Fleaflicker has points (a real gap): ${problems.noPlays.join(', ')}`);
const viaCount = rows.reduce((m, r) => ((m[r.via] = (m[r.via] ?? 0) + 1), m), {});
say(`  How players were matched: ${Object.entries(viaCount).map(([k, v]) => `${v} by ${k}`).join(', ')}`);
const joinRate = (rows.length + problems.zero.length) / players.length;

say('\n[4/4] Do the numbers agree?');
// Headline stats Fleaflicker exposes: Passing Yard (QBs), Rushing Yard, Receiving Yard, "Offensive + ST TD".
let hl = 0;
let hlOk = 0;
const hlBad = [];
for (const r of rows) {
  const checks = [['passYd', r.f.passYd ?? 0, r.ff.passYd], ['rushYd', r.f.rushYd ?? 0, r.ff.rushYd], ['recYd', r.f.recYd ?? 0, r.ff.recYd]];
  for (const [label, mine, theirs] of checks) {
    if (theirs == null || (!mine && !theirs)) continue;
    hl++;
    if (Math.round(mine) === Math.round(theirs)) hlOk++;
    else hlBad.push(`${r.name} ${label}: feed ${mine} vs Fleaflicker ${theirs}`);
  }
}
say(`  Yardage stats matching exactly:   ${hlOk}/${hl} (${pct(hlOk, hl)})`);
for (const b of hlBad.slice(0, 6)) say(`    mismatch: ${b}`);
// TD headline: try with and without passing TDs counted for the passer.
const tdA = rows.filter((r) => r.ff.offTD != null && (r.ff.offTD || (r.f.rushTD ?? 0) + (r.f.recTD ?? 0) + (r.f.passTD ?? 0)));
const tdWith = tdA.filter((r) => (r.f.passTD ?? 0) + (r.f.rushTD ?? 0) + (r.f.recTD ?? 0) === r.ff.offTD).length;
const tdWithout = tdA.filter((r) => (r.f.rushTD ?? 0) + (r.f.recTD ?? 0) === r.ff.offTD).length;
say(`  "Offensive TD" matches: ${tdWith}/${tdA.length} counting passing TDs for the passer, ${tdWithout}/${tdA.length} not counting them`);

// Points: standard-scoring guesses, then a fit of the league's own scoring from the data.
const combos = [];
for (const ppr of [0, 0.5, 1]) for (const passTD of [4, 6]) combos.push({ ppr, passTD, S: std(ppr, passTD) });
for (const c of combos) c.m = stats(rows.map((r) => dot(r.f, c.S) - r.y));
combos.sort((a, b) => a.m.mae - b.m.mae);
say('\n  Fantasy points from plays vs Fleaflicker\'s exact points (guessing standard scoring):');
for (const c of combos) say(`    ${pad(c.ppr === 1 ? 'PPR' : c.ppr === 0.5 ? 'half-PPR' : 'standard', 9)} ${c.passTD}-pt pass TD:  avg error ${c.m.mae.toFixed(2)}, within 0.5: ${pct(c.m.w05, rows.length)}, within 2: ${pct(c.m.w2, rows.length)}`);
const best = combos[0];
const fit = ridgeFit(rows);
const fitM = stats(rows.map((r) => dot(r.f, fit) - r.y));
say('\n  Fitting the league\'s scoring from the data (no rulebook needed):');
say('    ' + FEATURES.map((k) => `${k} ${fit[k].toFixed(2)}`).join('  '));
say(`    avg error ${fitM.mae.toFixed(2)}, within 0.5: ${pct(fitM.w05, rows.length)}, within 2: ${pct(fitM.w2, rows.length)}`);

const scoring = fitM.mae < best.m.mae ? { name: 'fitted league scoring', S: fit } : { name: 'standard guess', S: best.S };
say(`\n  Using ${scoring.name} for the rest.`);
const worst = rows.map((r) => ({ r, e: dot(r.f, scoring.S) - r.y })).sort((a, b) => Math.abs(b.e) - Math.abs(a.e));
say('\n  Biggest gaps (the true-up step would absorb these at the end of the game):');
for (const { r, e } of worst.slice(0, 5)) say(`    ${pad(r.name, 22)} ${pad(r.pos, 3)} Fleaflicker ${pad(r.y.toFixed(2), 6, true)}   from plays ${pad(dot(r.f, scoring.S).toFixed(2), 6, true)}   gap ${e >= 0 ? '+' : ''}${e.toFixed(2)}`);

/* ----------------------------------------------------------------- --who */
if (args.who && args.who !== true) {
  const r = rows.find((x) => norm(x.name) === norm(args.who));
  if (!r) say(`\n--who: no joined player called "${args.who}"`);
  else {
    say(`\n${r.name} (${r.pos}): Fleaflicker ${r.y.toFixed(2)}, from plays ${dot(r.f, scoring.S).toFixed(2)}; totals ${JSON.stringify(r.f)}`);
    for (const { p, fx } of r.log) say(`  Q${p.qtr} ${String(Math.floor(p.qsec / 60))}:${String(p.qsec % 60).padStart(2, '0')}  ${JSON.stringify(fx)}  ${p.desc.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
}

/* ----------------------------------------------------------------- demo */
if (args.demo) {
  const star = [...rows].sort((a, b) => b.y - a.y)[0];
  say(`\n${'='.repeat(72)}\nREPLAY: ${star.name} (${star.pos}), ${star.away} @ ${star.home}, Fleaflicker says ${star.y.toFixed(2)} points\n${'='.repeat(72)}`);
  say('  This is what the scrubber would show as you drag along the game.\n');
  let run = 0;
  const clock = (p) => `Q${p.qtr} ${Math.floor(p.qsec / 60)}:${String(p.qsec % 60).padStart(2, '0')}`;
  for (const { p, fx } of star.log) {
    const d = dot(fx, scoring.S);
    if (Math.abs(d) < 1.5) {
      run += d;
      continue; // only print the plays that move the needle
    }
    run += d;
    say(`  ${pad(clock(p), 9)} ${(d >= 0 ? '+' : '') + d.toFixed(1).padStart(5)}  -> ${run.toFixed(1).padStart(5)}   ${p.desc.replace(/\s+/g, ' ').slice(0, 78)}`);
  }
  say(`\n  Sum of all plays: ${run.toFixed(2)}   Fleaflicker: ${star.y.toFixed(2)}   true-up on the last play: ${(star.y - run >= 0 ? '+' : '') + (star.y - run).toFixed(2)}  (so the final number is exact)`);
}

/* --------------------------------------------------------------- verdict */
say(`\n${'='.repeat(72)}\nVERDICT (thresholds from the design: join >= 98%, yardage match ~100%, most points within 0.5)\n${'='.repeat(72)}`);
const ok = (b) => (b ? 'PASS' : 'FAIL');
say(`  ${ok(joinRate >= 0.98)}  players joined to play data: ${pct(rows.length + problems.zero.length, players.length)}`);
say(`  ${ok(hl > 0 && hlOk / hl >= 0.98)}  yardage matches Fleaflicker: ${pct(hlOk, hl)}`);
say(`  ${ok(fitM.w05 / rows.length >= 0.7)}  points within 0.5 of Fleaflicker (fitted scoring): ${pct(fitM.w05, rows.length)}   [within 2: ${pct(fitM.w2, rows.length)}]`);
