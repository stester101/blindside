// Pure logic for the Live Replay (beta) page. No DOM, no network: shared by public/live.js (browser),
// scripts/build-pbp.mjs (Node) and the unit tests.
//
// Game file format (written by scripts/build-pbp.mjs, one per NFL game):
//   { v, season, week, away, home, gameId, fx: [feature names], plays: [...scoring plays in order],
//     players: [[gsisId, name, pos, team], ...], effects: [[bucket, playerIdx, featureIdx, value, ...], ...] }
// "bucket b" holds every stat a player earned on plays after scoring play b-1 up to and including scoring
// play b, so the running total once scoring play b has been revealed is the sum over buckets <= b.
// Bucket plays.length holds whatever happened after the last score.

export const FEATURES = ['passYd', 'passTD', 'int', 'rushYd', 'rushTD', 'rec', 'recYd', 'recTD', 'fumLost', 'twoPt', 'fgS', 'fgM', 'fgL', 'xp', 'stTD'];

// Half-PPR, 6-point passing TD, 4 pts per 100 passing yards, kickers 3/4/5 by distance band.
export const DEFAULT_PROFILE = {
  passYd: 0.04, passTD: 6, int: -2, rushYd: 0.1, rushTD: 6, rec: 0.5, recYd: 0.1, recTD: 6, fumLost: -2, twoPt: 2,
  fgS: 3, fgM: 4, fgL: 5, xp: 1, stTD: 6,
};

export const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ names */
export const normName = (s) =>
  String(s ?? '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');

/** "Amon-Ra St. Brown" -> "a|stbrown": first initial plus the rest, so it also matches "A.St. Brown". */
export function initialLast(full) {
  const parts = String(full).trim().split(/\s+/);
  const first = normName(parts[0]);
  const last = normName(parts.slice(1).join(' '));
  return first && last ? `${first[0]}|${last}` : null;
}

/** "J.Chase" / "A.St. Brown" (play-by-play style) -> "j|chase". Null if the name is not in that style. */
export function feedInitialLast(short) {
  const s = String(short ?? '');
  const i = s.indexOf('.');
  if (i < 1 || i > 2) return null;
  const last = normName(s.slice(i + 1));
  return last ? `${normName(s[0])}|${last}` : null;
}

const normPos = (p) => (p === 'PK' ? 'K' : p === 'FB' ? 'RB' : p);

/** Index a game file's players for joining Fleaflicker players by name. */
export function buildNameIndex(players) {
  const full = new Map();
  const il = new Map();
  const put = (m, k, i) => {
    if (!k) return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  };
  players.forEach(([, name], i) => {
    put(full, normName(name), i);
    put(il, feedInitialLast(name) ?? initialLast(name), i);
  });
  return { full, il, players };
}

/**
 * Find a Fleaflicker player (full name, position, team) in a game file. Order: normalised full name,
 * then first initial + last name. Several candidates are narrowed by position, then team.
 * Returns the player index inside the file, or -1.
 */
export function joinPlayer(index, { full, pos, team }) {
  const narrow = (cands) => {
    if (!cands?.length) return -1;
    if (cands.length === 1) return cands[0];
    const p = normPos(pos);
    const byPos = cands.filter((i) => normPos(index.players[i][2]) === p);
    const pool = byPos.length ? byPos : cands;
    return pool.find((i) => index.players[i][3] === team) ?? pool[0];
  };
  const a = narrow(index.full.get(normName(full)));
  if (a >= 0) return a;
  return narrow(index.il.get(initialLast(full)));
}

/* ------------------------------------------------------------- scoring */
export const dot = (f, S) => FEATURES.reduce((t, k) => t + (f[k] ?? 0) * (S[k] ?? 0), 0);

/** Decode one effects row into [bucket, playerIdx, {feature: value}]. */
function decodeRow(row, fx) {
  const f = {};
  for (let i = 2; i < row.length; i += 2) f[fx[row[i]]] = (f[fx[row[i]]] ?? 0) + row[i + 1];
  return [row[0], row[1], f];
}

/** Whole-game stat totals per player index: Map(playerIdx -> {feature: value}). */
export function gameTotals(game) {
  const out = new Map();
  for (const row of game.effects) {
    const [, p, f] = decodeRow(row, game.fx);
    const t = out.get(p) ?? {};
    for (const [k, v] of Object.entries(f)) t[k] = (t[k] ?? 0) + v;
    out.set(p, t);
  }
  return out;
}

/**
 * Running approximate points: result[b] is a Map(playerIdx -> points) after scoring play b (0-based) has been
 * revealed; result[plays.length] is the end of the game. Players with no stats yet are absent (= 0).
 */
export function runningPoints(game, profile) {
  const n = game.plays.length;
  const per = Array.from({ length: n + 1 }, () => new Map());
  for (const row of game.effects) {
    const [b, p, f] = decodeRow(row, game.fx);
    const m = per[Math.min(b, n)];
    m.set(p, (m.get(p) ?? 0) + dot(f, profile));
  }
  const out = [];
  let run = new Map();
  for (let b = 0; b <= n; b++) {
    const next = new Map(run);
    for (const [p, v] of per[b]) next.set(p, (next.get(p) ?? 0) + v);
    out.push(next);
    run = next;
  }
  return out;
}

/** The true-up: whatever the approximation missed is applied at the end, so the final equals Fleaflicker's number. */
export const trueUp = (approx, exact) => round2(exact - approx);

/* ------------------------------------------------------------ league fit */
/**
 * Ridge regression of exact points on stat totals, pulled toward `prior` (so a stat with no data keeps its default).
 * rows: [{f: {feature: total}, y: exactPoints}]
 */
export function ridgeFit(rows, prior = DEFAULT_PROFILE, lambda = 0.01) {
  const n = FEATURES.length;
  const A = Array.from({ length: n }, () => Array(n + 1).fill(0));
  for (const { f, y } of rows) {
    const resid = y - dot(f, prior);
    for (let i = 0; i < n; i++) {
      const xi = f[FEATURES[i]] ?? 0;
      if (!xi) continue;
      for (let j = 0; j < n; j++) A[i][j] += xi * (f[FEATURES[j]] ?? 0);
      A[i][n] += xi * resid;
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
  return Object.fromEntries(FEATURES.map((k, i) => [k, (prior[k] ?? 0) + A[i][n] / A[i][i]]));
}

const COMMON = [-3, -2, -1.5, -1, -0.5, -0.25, 0, 0.02, 0.025, 0.04, 0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6];
/** Snap a fitted coefficient to the nearest common league value when it is close; otherwise round to 3 places. */
export function snapValue(v) {
  let best = null;
  for (const c of COMMON) if (best == null || Math.abs(v - c) < Math.abs(v - best)) best = c;
  return Math.abs(v - best) <= Math.max(0.004, 0.1 * Math.abs(best)) ? best : Math.round(v * 1000) / 1000;
}

export function meanAbsError(rows, S) {
  return rows.length ? rows.reduce((t, r) => t + Math.abs(dot(r.f, S) - r.y), 0) / rows.length : Infinity;
}

/**
 * Fit a league's scoring profile. Falls back to the default when there are too few samples or the
 * snapped fit is not clearly usable. Returns {profile, src: 'fit'|'default', mae, n}.
 */
export function fitProfile(rows, { minSamples = 20, maxMae = 1.5 } = {}) {
  const usable = rows.filter((r) => Object.keys(r.f).length);
  const defMae = meanAbsError(usable, DEFAULT_PROFILE);
  if (usable.length < minSamples) return { profile: { ...DEFAULT_PROFILE }, src: 'default', mae: defMae, n: usable.length };
  const raw = ridgeFit(usable);
  const snapped = Object.fromEntries(FEATURES.map((k) => [k, snapValue(raw[k])]));
  const mae = meanAbsError(usable, snapped);
  if (mae <= maxMae && mae < defMae) return { profile: snapped, src: 'fit', mae, n: usable.length };
  return { profile: { ...DEFAULT_PROFILE }, src: 'default', mae: defMae, n: usable.length };
}

/* --------------------------------------------------------------- display */
export const fmtClock = (q, sec) => `${q > 4 ? 'OT' : 'Q' + q} ${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * One card per scoring play, except a touchdown and the extra point or two-point try that
 * immediately follows it for the same team, which share a card. Indices refer to `plays`.
 */
export function groupPlays(plays) {
  const groups = [];
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const nx = plays[i + 1];
    if (p.type === 'TD' && nx && (nx.type === 'XP' || nx.type === '2PT') && nx.team === p.team) {
      groups.push({ start: i, end: i + 1, main: p, extra: nx });
      i++;
    } else {
      groups.push({ start: i, end: i, main: p, extra: null });
    }
  }
  return groups;
}
