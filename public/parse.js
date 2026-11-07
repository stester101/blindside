// Parsing of real Fleaflicker API responses into a small, spoiler-aware model.
// Written against actual responses for league 219707 (season 2026). Key facts:
//  - Standings: divisions[].teams[] {id, name, owners[]}. Also contains records/points (never used).
//  - Scoreboard: schedulePeriod.ordinal = requested/current week; eligibleSchedulePeriods[].ordinal;
//    games[] {id (fantasy game id, string), away{id,name}, home{id,name}, ...scores (never used)}.
//  - Boxscore: game.away.id / game.home.id; lineups[] where group === 'START' holds starters,
//    each slot {position.label, away?: player, home?: player}.
//    player.requestedGames[] is one entry per NFL game in that week:
//      {game:{id, away.abbreviation, home.abbreviation, startTimeEpochMilli, status?}, pointsActual?, participant?}
//    or {isBye: true} with no game. participant === 'HOME' when the player was on the home team.
//    The player's *current* proTeamAbbreviation can differ from the team he scored for (trades),
//    so the NFL game is taken from requestedGames, never from proTeam.
//    Sum of starters' pointsActual equals pointsAway/pointsHome.total (verified).

const round2 = (n) => Math.round(n * 100) / 100;

export function parseStandings(raw) {
  const teams = [];
  for (const div of raw?.divisions ?? []) {
    for (const t of div.teams ?? []) {
      teams.push({ id: t.id, name: t.name, owner: t.owners?.[0]?.displayName ?? '' });
    }
  }
  teams.sort((a, b) => a.name.localeCompare(b.name));
  return { leagueName: raw?.league?.name ?? '', season: raw?.season ?? null, teams };
}

export function parseScoreboard(raw, teamId) {
  const periods = raw?.eligibleSchedulePeriods ?? [];
  const weeks = periods.map((p) => p.ordinal).filter((n) => Number.isFinite(n));
  const nowP = periods.find((p) => p.containsNow || p.low?.isNow);
  const week = raw?.schedulePeriod?.ordinal ?? null;
  const currentWeek = nowP?.ordinal ?? (raw?.schedulePeriod?.containsNow ? week : null);
  let matchup = null;
  for (const g of raw?.games ?? []) {
    const side = g.away?.id === teamId ? 'away' : g.home?.id === teamId ? 'home' : null;
    if (!side) continue;
    const opp = side === 'away' ? g.home : g.away;
    matchup = {
      fantasyGameId: String(g.id),
      myName: (side === 'away' ? g.away : g.home).name,
      oppName: opp?.name ?? 'Opponent',
      oppId: opp?.id ?? null,
    };
    break;
  }
  return { week, currentWeek, weeks, matchup };
}

function parsePlayer(p, games) {
  if (!p?.proPlayer) return null;
  const pp = p.proPlayer;
  let gameId = null;
  let bye = false;
  let points = 0;
  let team = pp.proTeamAbbreviation ?? '';
  for (const rg of p.requestedGames ?? []) {
    if (rg.isBye || !rg.game) {
      if (rg.isBye) bye = true;
      continue;
    }
    const g = rg.game;
    const away = g.away?.abbreviation ?? '?';
    const home = g.home?.abbreviation ?? '?';
    if (!games.has(g.id)) {
      games.set(g.id, {
        id: g.id,
        away,
        home,
        kickoff: Number(g.startTimeEpochMilli) || 0,
        final: g.status === 'FINAL_SCORE',
        // NFL game scores are deliberately NOT copied.
      });
    }
    gameId = g.id;
    bye = false;
    points += Number(rg.pointsActual?.value) || 0;
    if (team !== away && team !== home) team = rg.participant === 'HOME' ? home : away;
  }
  return {
    id: pp.id,
    name: pp.nameShort || pp.nameFull || 'Unknown',
    pos: pp.position ?? '',
    team,
    gameId,
    bye: bye && gameId == null,
    points: round2(points),
  };
}

export function parseBoxscore(raw, teamId) {
  const mySide = raw?.game?.home?.id === teamId ? 'home' : 'away';
  const oppSide = mySide === 'away' ? 'home' : 'away';
  const lineups = raw?.lineups ?? [];
  const starters = lineups.find((l) => l.group === 'START') ?? lineups[0] ?? { slots: [] };
  const games = new Map();
  const slots = (starters.slots ?? []).map((s) => ({
    label: s.position?.label ?? '',
    me: parsePlayer(s[mySide], games),
    opp: parsePlayer(s[oppSide], games),
  }));
  // Only games that involve a starter matter for the matchup.
  const used = new Set();
  for (const s of slots) for (const p of [s.me, s.opp]) if (p?.gameId != null) used.add(p.gameId);
  const byKick = (a, b) => a.kickoff - b.kickoff || a.id - b.id;
  const relevant = [...games.values()].filter((g) => used.has(g.id)).sort(byKick);

  // Games where only bench/IR players play: listed for context, never scored.
  // Bench points are not kept at all (they never affect the matchup).
  const bench = new Map();
  for (const l of lineups) {
    if (l === starters) continue;
    for (const s of l.slots ?? []) {
      for (const [side, who] of [[mySide, 'me'], [oppSide, 'opp']]) {
        const p = parsePlayer(s[side], games);
        if (p?.gameId == null || used.has(p.gameId)) continue;
        if (!bench.has(p.gameId)) bench.set(p.gameId, { ...games.get(p.gameId), me: [], opp: [] });
        bench.get(p.gameId)[who].push(p.name);
      }
    }
  }
  return { slots, games: relevant, benchOnly: [...bench.values()].sort(byKick) };
}

/** Compute what may be shown, given the set of watched NFL game ids. */
export function computeReveal(model, watched) {
  let me = 0;
  let opp = 0;
  for (const s of model.slots) {
    if (s.me?.gameId != null && watched.has(s.me.gameId)) me += s.me.points;
    if (s.opp?.gameId != null && watched.has(s.opp.gameId)) opp += s.opp.points;
  }
  const watchedCount = model.games.filter((g) => watched.has(g.id)).length;
  const total = model.games.length;
  const allWatched = watchedCount === total;
  return {
    me: round2(me),
    opp: round2(opp),
    watchedCount,
    total,
    anyWatched: watchedCount > 0,
    allWatched,
    allFinal: model.games.every((g) => g.final),
  };
}
