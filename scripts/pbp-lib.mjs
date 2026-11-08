// Turns nflverse play-by-play rows into the small per-game files the Live Replay page fetches.
// Pure functions only (no network, no disk), so they can be unit-tested. See scripts/build-pbp.mjs.
import { FEATURES } from '../public/live-core.js';

/** nflverse spells two teams differently from Fleaflicker. */
const NFL_TO_FF = { JAX: 'JAC', LA: 'LAR' };
export const ffTeam = (t) => NFL_TO_FF[t] ?? t;

/* ----------------------------------------------------------------------- csv */
export function* csvRows(text) {
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

const NUM = (v) => (v === '' || v === 'NA' || v == null ? 0 : Number(v));
const STR = (v) => (v === 'NA' || v == null ? '' : v);
/** Score columns: NaN when missing, so "0" can be told apart from "no value". */
const SCORE = (v) => (v === '' || v === 'NA' || v == null ? NaN : Number(v));

const NEED = [
  'game_id', 'week', 'season_type', 'home_team', 'away_team', 'posteam', 'defteam', 'qtr', 'quarter_seconds_remaining', 'desc', 'play_type', 'play_id',
  'passer_player_id', 'passer_player_name', 'rusher_player_id', 'rusher_player_name', 'receiver_player_id', 'receiver_player_name',
  'passing_yards', 'rushing_yards', 'receiving_yards', 'pass_touchdown', 'rush_touchdown', 'return_touchdown', 'touchdown', 'interception',
  'fumble_lost', 'fumbled_1_player_id', 'fumbled_2_player_id', 'complete_pass', 'two_point_conv_result', 'two_point_attempt',
  'defensive_two_point_conv', 'field_goal_result', 'kick_distance', 'kicker_player_id', 'kicker_player_name', 'extra_point_result', 'safety',
  'safety_player_name', 'td_team', 'td_player_id', 'td_player_name', 'total_home_score', 'total_away_score',
];

/** Parse the CSV text into plain play objects for REG-season rows (optionally one week). */
export function parsePlays(text, { week = null } = {}) {
  const rows = csvRows(text);
  const header = rows.next().value;
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const missing = NEED.filter((c) => !(c in col));
  if (missing.length) throw new Error(`play-by-play is missing expected columns: ${missing.join(', ')}`);
  const plays = [];
  for (const r of rows) {
    if (r[col.season_type] !== 'REG') continue;
    if (week != null && Number(r[col.week]) !== week) continue;
    const g = (c) => r[col[c]];
    plays.push({
      gid: g('game_id'), week: NUM(g('week')), home: g('home_team'), away: g('away_team'), posteam: STR(g('posteam')), defteam: STR(g('defteam')),
      qtr: NUM(g('qtr')), qsec: NUM(g('quarter_seconds_remaining')), desc: STR(g('desc')), type: STR(g('play_type')), id: NUM(g('play_id')),
      passer: STR(g('passer_player_id')), passerName: STR(g('passer_player_name')), rusher: STR(g('rusher_player_id')), rusherName: STR(g('rusher_player_name')),
      receiver: STR(g('receiver_player_id')), receiverName: STR(g('receiver_player_name')),
      passYd: NUM(g('passing_yards')), rushYd: NUM(g('rushing_yards')), recYd: NUM(g('receiving_yards')),
      passTD: NUM(g('pass_touchdown')), rushTD: NUM(g('rush_touchdown')), retTD: NUM(g('return_touchdown')), td: NUM(g('touchdown')), int: NUM(g('interception')),
      fumLost: NUM(g('fumble_lost')), fumbler1: STR(g('fumbled_1_player_id')), fumbler2: STR(g('fumbled_2_player_id')), comp: NUM(g('complete_pass')),
      twoPtAttempt: NUM(g('two_point_attempt')), twoPtGood: g('two_point_conv_result') === 'success', defTwoPtGood: NUM(g('defensive_two_point_conv')) === 1,
      fgGood: g('field_goal_result') === 'made', fgDist: NUM(g('kick_distance')), kicker: STR(g('kicker_player_id')), kickerName: STR(g('kicker_player_name')),
      xpGood: g('extra_point_result') === 'good', safety: NUM(g('safety')) === 1, safetyName: STR(g('safety_player_name')),
      tdTeam: STR(g('td_team')), tdPlayer: STR(g('td_player_id')), tdName: STR(g('td_player_name')),
      totalHome: SCORE(g('total_home_score')), totalAway: SCORE(g('total_away_score')),
    });
  }
  return plays;
}

/* ------------------------------------------------------------------- effects */
/**
 * Which players' tracked stats a play changes: { gsisId: {feature: delta} }.
 * Two-point tries count only the 2-pt bonus, not their yardage. When a lateral leads to a second fumble,
 * the lost fumble is credited to the last fumbler (fumbled_2), as Fleaflicker does.
 */
export function playEffects(p) {
  const fx = {};
  const add = (id, k, v) => {
    if (!id || !v) return;
    (fx[id] ??= {})[k] = (fx[id][k] ?? 0) + v;
  };
  if (p.twoPtAttempt) {
    if (p.twoPtGood) {
      if (p.rusher) add(p.rusher, 'twoPt', 1);
      else {
        add(p.passer, 'twoPt', 1);
        add(p.receiver, 'twoPt', 1);
      }
    }
    return fx;
  }
  add(p.passer, 'passYd', p.passYd);
  add(p.passer, 'passTD', p.passTD);
  add(p.passer, 'int', p.int);
  add(p.rusher, 'rushYd', p.rushYd);
  add(p.rusher, 'rushTD', p.rushTD);
  add(p.receiver, 'rec', p.comp);
  add(p.receiver, 'recYd', p.recYd);
  add(p.receiver, 'recTD', p.passTD);
  if (p.fumLost) add(p.fumbler2 || p.fumbler1, 'fumLost', 1);
  if (p.fgGood && p.kicker) add(p.kicker, p.fgDist >= 50 ? 'fgL' : p.fgDist >= 40 ? 'fgM' : 'fgS', 1);
  if (p.xpGood && p.kicker) add(p.kicker, 'xp', 1);
  if (p.retTD && p.tdPlayer && (p.type === 'kickoff' || p.type === 'punt')) add(p.tdPlayer, 'stTD', 1);
  return fx;
}

/* ---------------------------------------------------------- scoring plays */
function classify(p) {
  if (p.safety) return { type: 'SAF', team: p.defteam };
  if (p.xpGood) return { type: 'XP', team: p.posteam };
  if (p.defTwoPtGood) return { type: '2PT', team: p.defteam };
  if (p.twoPtGood) return { type: '2PT', team: p.posteam };
  if (p.fgGood) return { type: 'FG', team: p.posteam };
  if (p.td) return { type: 'TD', team: p.tdTeam || p.posteam };
  return { type: 'PTS', team: p.posteam };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Who scored, who helped, and a short phrase for how. Names come from `nameOf(id, feedName)`. */
function describeScore(p, type, nameOf) {
  const yds = (n) => (n ? `${Math.abs(n)} yd ` : '');
  if (type === 'FG') return { scorer: nameOf(p.kicker, p.kickerName), by: '', how: `${p.fgDist} yd field goal` };
  if (type === 'XP') return { scorer: nameOf(p.kicker, p.kickerName), by: '', how: 'extra point' };
  if (type === 'SAF') return { scorer: p.safetyName ? nameOf('', p.safetyName) : `${p.defteam} defense`, by: '', how: 'safety' };
  if (type === '2PT') {
    if (p.rusher) return { scorer: nameOf(p.rusher, p.rusherName), by: '', how: 'two-point run' };
    return { scorer: nameOf(p.receiver, p.receiverName), by: nameOf(p.passer, p.passerName), how: 'two-point pass' };
  }
  if (type === 'TD') {
    if (p.passTD) return { scorer: nameOf(p.receiver || p.tdPlayer, p.receiverName || p.tdName), by: nameOf(p.passer, p.passerName), how: `${yds(p.recYd)}pass` };
    if (p.rushTD) return { scorer: nameOf(p.rusher || p.tdPlayer, p.rusherName || p.tdName), by: '', how: `${yds(p.rushYd)}run` };
    const how = p.type === 'kickoff' ? 'kickoff return' : p.type === 'punt' ? 'punt return' : p.int ? 'interception return' : p.fumLost || p.type === 'fumble' ? 'fumble return' : 'return';
    return { scorer: nameOf(p.tdPlayer, p.tdName), by: '', how };
  }
  return { scorer: '', by: '', how: '' };
}

/**
 * Build one game file from that game's plays.
 * @param plays  plays of a single game
 * @param nameOf (gsisId, feedName) -> display name
 * @param posOf  (gsisId) -> position or ''
 */
export function buildGame(plays, { season, nameOf, posOf }) {
  plays = [...plays].sort((a, b) => a.id - b.id);
  const away = ffTeam(plays[0].away);
  const home = ffTeam(plays[0].home);

  // nflverse's total_away_score / total_home_score on a row already include that play's points, so the score
  // after play i is that row's value. Scores never go down, which also ignores the odd stale value on a
  // timeout / no-play row right after a score (and rows with no value).
  const after = [];
  let cur = [0, 0];
  for (const p of plays) {
    cur = [Math.max(cur[0], p.totalAway || 0), Math.max(cur[1], p.totalHome || 0)];
    after.push(cur);
  }
  const finalScore = after[after.length - 1];

  const scoring = [];
  const effects = new Map(); // `${bucket}|${gsis}` -> {feature: value}
  const people = new Map(); // gsis -> [name, pos, team]
  const odd = [];
  plays.forEach((p, i) => {
    const before = i ? after[i - 1] : [0, 0];
    const delta = after[i][0] - before[0] + (after[i][1] - before[1]);
    const bucket = scoring.length;
    for (const [id, f] of Object.entries(playEffects(p))) {
      const key = `${bucket}|${id}`;
      const t = effects.get(key) ?? {};
      for (const [k, v] of Object.entries(f)) t[k] = (t[k] ?? 0) + v;
      effects.set(key, t);
      if (!people.has(id)) people.set(id, [id, nameOf(id, p.passer === id ? p.passerName : p.rusher === id ? p.rusherName : p.receiver === id ? p.receiverName : p.kicker === id ? p.kickerName : p.tdPlayer === id ? p.tdName : ''), posOf(id), ffTeam(p.posteam || '')]);
    }
    if (delta <= 0) return;
    const { type, team } = classify(p);
    const expect = { TD: 6, FG: 3, XP: 1, '2PT': 2, SAF: 2 }[type];
    if (expect !== delta) odd.push(`${p.id}:${type}:${delta}`);
    const d = describeScore(p, type, nameOf);
    scoring.push({
      q: p.qtr, t: p.qsec, team: ffTeam(team), type, scorer: d.scorer, by: d.by, how: d.how, desc: clean(p.desc),
      a: after[i][0], h: after[i][1],
    });
  });

  // players array in a stable order; effects rows reference it by index.
  const ids = [...people.keys()].sort();
  const idx = new Map(ids.map((id, i) => [id, i]));
  const rows = [...effects.entries()]
    .map(([key, f]) => {
      const [b, id] = key.split('|');
      const row = [Number(b), idx.get(id)];
      FEATURES.forEach((k, ki) => {
        if (f[k]) row.push(ki, Math.round(f[k] * 100) / 100);
      });
      return row;
    })
    .filter((r) => r.length > 2)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  return {
    game: {
      v: 1, season, week: plays[0].week, away, home, gameId: plays[0].gid, fx: FEATURES, plays: scoring,
      players: ids.map((id) => people.get(id)), effects: rows,
    },
    odd,
    finalScore,
  };
}
