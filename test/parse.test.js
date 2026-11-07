// Unit tests for parsing, using trimmed fixtures that mirror real Fleaflicker shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStandings, parseScoreboard, parseBoxscore, computeReveal } from '../public/parse.js';
import { proxyFleaflicker } from '../src/proxy.js';

const game = (id, away, home, extra = {}) => ({ id, away: { abbreviation: away }, home: { abbreviation: home }, startTimeEpochMilli: '1793556000000', status: 'FINAL_SCORE', awayScore: 33, homeScore: 30, ...extra });
const player = (id, name, team, rg) => ({ proPlayer: { id, nameShort: name, proTeamAbbreviation: team, position: 'WR' }, requestedGames: rg });

const box = {
  game: { id: '1', away: { id: 10 }, home: { id: 20 } },
  lineups: [
    {
      group: 'START',
      slots: [
        { position: { label: 'QB' }, away: player(1, 'A. Away', 'CIN', [{ game: game(7965, 'TEN', 'CIN'), pointsActual: { value: 20.5 }, participant: 'HOME' }]), home: player(2, 'H. Home', 'GB', [{ game: game(7963, 'CAR', 'GB'), pointsActual: { value: 10.25 }, participant: 'HOME' }]) },
        // Traded player: current team BAL, but scored for ARI (away side of ARI@DAL, no participant field)
        { position: { label: 'QB/RB/WR/TE' }, away: player(3, 'J. Traded', 'BAL', [{ game: game(7969, 'ARI', 'DAL'), pointsActual: { value: 4.65 } }]), home: player(4, 'B. Bye', 'HOU', [{ isBye: true }]) },
        { position: { label: 'RB/WR/TE' }, away: player(5, 'N. Zero', 'CIN', [{ game: game(7965, 'TEN', 'CIN'), participant: 'HOME' }]) },
      ],
    },
    { slots: [{ position: { label: 'BN' }, away: player(9, 'Bench', 'SEA', [{ game: game(7976, 'CHI', 'SEA'), pointsActual: { value: 99 } }]) }] },
  ],
};

test('standings → team list without records', () => {
  const s = parseStandings({ league: { name: 'L' }, season: 2026, divisions: [{ teams: [{ id: 2, name: 'B', owners: [{ displayName: 'o' }], recordOverall: { formatted: '7-1' } }, { id: 1, name: 'A' }] }] });
  assert.deepEqual(s.teams, [{ id: 1, name: 'A', owner: '' }, { id: 2, name: 'B', owner: 'o' }]);
});

test('scoreboard → current week and my matchup', () => {
  const sb = parseScoreboard({ schedulePeriod: { ordinal: 9 }, eligibleSchedulePeriods: [{ ordinal: 8 }, { ordinal: 9, low: { isNow: true }, containsNow: true }], games: [{ id: '5', away: { id: 7, name: 'X' }, home: { id: 10, name: 'Me' } }] }, 10);
  assert.equal(sb.currentWeek, 9);
  assert.deepEqual(sb.weeks, [8, 9]);
  assert.deepEqual(sb.matchup, { fantasyGameId: '5', myName: 'Me', oppName: 'X', oppId: 7 });
  assert.equal(parseScoreboard({ games: [] }, 10).matchup, null);
});

test('boxscore → starters linked to NFL games, bench ignored', () => {
  const m = parseBoxscore(box, 10);
  assert.deepEqual(m.games.map((g) => g.id).sort(), [7963, 7965, 7969]);
  assert.ok(m.games.every((g) => !('awayScore' in g) && !('homeScore' in g)), 'NFL scores not kept');
  assert.equal(m.slots[1].me.team, 'ARI');
  assert.equal(m.slots[1].me.gameId, 7969);
  assert.equal(m.slots[1].opp.bye, true);
  assert.equal(m.slots[2].opp, null);
  assert.equal(m.slots[2].me.points, 0);
  // bench-only game is listed separately, with names but no points
  assert.equal(m.benchOnly.length, 1);
  assert.equal(m.benchOnly[0].id, 7976);
  assert.deepEqual(m.benchOnly[0].me, ['Bench']);
  assert.ok(!JSON.stringify(m.benchOnly).includes('99'), 'bench points not kept');
  // perspective flips when I am the home team
  assert.equal(parseBoxscore(box, 20).slots[0].me.name, 'H. Home');
});

test('reveal only counts watched games', () => {
  const m = parseBoxscore(box, 10);
  let r = computeReveal(m, new Set());
  assert.equal(r.anyWatched, false);
  r = computeReveal(m, new Set([7965]));
  assert.deepEqual([r.me, r.opp, r.watchedCount, r.allWatched], [20.5, 0, 1, false]);
  r = computeReveal(m, new Set([7965, 7963, 7969]));
  assert.deepEqual([r.me, r.opp, r.allWatched, r.allFinal], [25.15, 10.25, true, true]);
});

test('proxy only reaches fleaflicker with allowed params', async () => {
  let called;
  const fake = async (u) => { called = String(u); return new Response('{"ok":1}', { status: 200 }); };
  let r = await proxyFleaflicker(new URL('http://x/api/FetchLeagueBoxscore?league_id=1&season=2026&scoring_period=8&fantasy_game_id=5&evil=1'), fake);
  assert.equal(r.status, 200);
  assert.equal(called, 'https://www.fleaflicker.com/api/FetchLeagueBoxscore?sport=NFL&league_id=1&scoring_period=8&fantasy_game_id=5');
  assert.equal((await proxyFleaflicker(new URL('http://x/api/FetchUserLeagues?league_id=1'), fake)).status, 404);
  assert.equal((await proxyFleaflicker(new URL('http://x/api/..%2F..%2Fevil?league_id=1'), fake)).status, 404);
  assert.equal((await proxyFleaflicker(new URL('http://x/api/FetchLeagueStandings?league_id=1x'), fake)).status, 400);
  const bad = await proxyFleaflicker(new URL('http://x/api/FetchLeagueStandings?league_id=1'), async () => new Response('<html>', { status: 404 }));
  assert.equal(bad.status, 502);
  assert.deepEqual(await bad.json(), { error: 'Fleaflicker returned HTTP 404', upstreamStatus: 404 });
});
