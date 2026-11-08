// Unit tests for the Live Replay logic (stat effects, running points, true-up, name join, scoring fit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_PROFILE, FEATURES, buildNameIndex, joinPlayer, normName, gameTotals, runningPoints, trueUp, ridgeFit, fitProfile, snapValue, dot, fmtClock,
} from '../public/live-core.js';
import { playEffects, buildGame, csvRows, ffTeam } from '../scripts/pbp-lib.mjs';

const P = (o) => ({
  id: 0, week: 8, qtr: 1, qsec: 600, type: 'pass', posteam: 'CIN', defteam: 'TEN', away: 'TEN', home: 'CIN', gid: 'g', desc: 'x',
  passer: '', rusher: '', receiver: '', passYd: 0, rushYd: 0, recYd: 0, passTD: 0, rushTD: 0, retTD: 0, td: 0, int: 0, fumLost: 0, fumbler1: '', fumbler2: '',
  comp: 0, twoPtAttempt: 0, twoPtGood: false, defTwoPtGood: false, fgGood: false, fgDist: 0, kicker: '', xpGood: false, safety: false, safetyName: '',
  tdTeam: '', tdPlayer: '', totalHome: 0, totalAway: 0, passerName: '', rusherName: '', receiverName: '', kickerName: '', tdName: '', ...o,
});

test('effects: completed pass credits passer and receiver', () => {
  const fx = playEffects(P({ passer: 'QB', receiver: 'WR', comp: 1, passYd: 20, recYd: 20 }));
  assert.deepEqual(fx, { QB: { passYd: 20 }, WR: { rec: 1, recYd: 20 } });
});

test('effects: touchdown pass counts passTD for QB and recTD for receiver', () => {
  const fx = playEffects(P({ passer: 'QB', receiver: 'WR', comp: 1, passYd: 30, recYd: 30, passTD: 1, td: 1 }));
  assert.equal(fx.QB.passTD, 1);
  assert.equal(fx.WR.recTD, 1);
});

test('effects: lost fumble after a lateral is credited to the second fumbler', () => {
  assert.deepEqual(playEffects(P({ type: 'run', rusher: 'RB', rushYd: 3, fumLost: 1, fumbler1: 'RB' })), { RB: { rushYd: 3, fumLost: 1 } });
  const lat = playEffects(P({ type: 'run', rusher: 'RB', rushYd: -2, fumLost: 1, fumbler1: 'RB', fumbler2: 'WR' }));
  assert.equal(lat.WR.fumLost, 1);
  assert.equal(lat.RB.fumLost, undefined);
});

test('effects: two-point conversions give the bonus, not yardage; kicks credit the kicker by distance', () => {
  assert.deepEqual(playEffects(P({ twoPtAttempt: 1, twoPtGood: true, rusher: 'RB', rushYd: 2 })), { RB: { twoPt: 1 } });
  assert.deepEqual(playEffects(P({ twoPtAttempt: 1, twoPtGood: true, passer: 'QB', receiver: 'TE', passYd: 2, recYd: 2, comp: 1 })), { QB: { twoPt: 1 }, TE: { twoPt: 1 } });
  assert.deepEqual(playEffects(P({ type: 'field_goal', fgGood: true, fgDist: 52, kicker: 'K' })), { K: { fgL: 1 } });
  assert.deepEqual(playEffects(P({ type: 'field_goal', fgGood: true, fgDist: 45, kicker: 'K' })), { K: { fgM: 1 } });
  assert.deepEqual(playEffects(P({ type: 'extra_point', xpGood: true, kicker: 'K' })), { K: { xp: 1 } });
  assert.deepEqual(playEffects(P({ type: 'kickoff', retTD: 1, td: 1, tdPlayer: 'R' })), { R: { stTD: 1 } });
});

// A small game: a 20-yard pass, a TD pass + extra point, then a late run after the last score.
const names = { QB: 'Joe Burrow', WR: "Ja'Marr Chase", K: 'Evan McPherson', RB: 'Chase Brown' };
const gamePlays = [
  P({ id: 1, passer: 'QB', receiver: 'WR', comp: 1, passYd: 20, recYd: 20, totalAway: 0, totalHome: 0 }),
  P({ id: 2, passer: 'QB', receiver: 'WR', comp: 1, passYd: 30, recYd: 30, passTD: 1, td: 1, tdTeam: 'CIN', tdPlayer: 'WR', totalAway: 0, totalHome: 6, qsec: 500 }),
  // stale score on a timeout row right after the score must be ignored
  P({ id: 3, type: 'no_play', totalAway: 0, totalHome: 0 }),
  P({ id: 4, type: 'extra_point', xpGood: true, kicker: 'K', totalAway: 0, totalHome: 7 }),
  P({ id: 5, type: 'run', rusher: 'RB', rushYd: 10, totalAway: 0, totalHome: 7 }),
];
const built = buildGame(gamePlays, { season: 2026, nameOf: (id, feed) => names[id] ?? feed, posOf: (id) => ({ QB: 'QB', WR: 'WR', K: 'K', RB: 'RB' })[id] ?? '' });

test('buildGame: scoring plays, running score, scorer and passer', () => {
  const g = built.game;
  assert.deepEqual(built.odd, []);
  assert.deepEqual(g.plays.map((p) => [p.type, p.a, p.h]), [['TD', 0, 6], ['XP', 0, 7]]);
  assert.equal(g.plays[0].scorer, "Ja'Marr Chase");
  assert.equal(g.plays[0].by, 'Joe Burrow');
  assert.equal(g.plays[0].how, '30 yd pass');
  assert.equal(g.plays[1].scorer, 'Evan McPherson');
  assert.equal(g.away + '@' + g.home, 'TEN@CIN');
});

test('running points include yardage since the previous scoring play, bucket by bucket', () => {
  const g = built.game;
  const idx = (id) => g.players.findIndex((p) => p[0] === id);
  const run = runningPoints(g, DEFAULT_PROFILE);
  assert.equal(run.length, 3); // two scoring plays + end of game
  // after the TD: QB 50 yds * .04 + 6 = 8; WR 2 rec * .5 + 50 * .1 + 6 = 12
  assert.ok(Math.abs(run[0].get(idx('QB')) - 8) < 1e-9);
  assert.ok(Math.abs(run[0].get(idx('WR')) - 12) < 1e-9);
  assert.equal(run[0].get(idx('K')) ?? 0, 0);
  assert.ok(Math.abs(run[1].get(idx('K')) - 1) < 1e-9); // extra point
  assert.equal(run[1].get(idx('RB')) ?? 0, 0); // late run not yet
  assert.ok(Math.abs(run[2].get(idx('RB')) - 1) < 1e-9);
});

test('true-up: final equals the exact number whatever the approximation was', () => {
  const approx = 11.97;
  const exact = 12.4;
  assert.equal(trueUp(approx, exact), 0.43);
  assert.equal(Math.round((approx + trueUp(approx, exact)) * 100) / 100, exact);
});

test('name join: full name, suffixes, accents of punctuation, initial+last fallback, position tie-break', () => {
  const players = [['a', 'Kenneth Walker III', 'RB', 'SEA'], ['b', "Ja'Marr Chase", 'WR', 'CIN'], ['c', 'J.Smith', 'WR', 'TEN'], ['d', 'Mike Williams', 'WR', 'CIN'], ['e', 'Mike Williams', 'TE', 'CIN']];
  const idx = buildNameIndex(players);
  assert.equal(joinPlayer(idx, { full: 'Kenneth Walker', pos: 'RB', team: 'SEA' }), 0);
  assert.equal(joinPlayer(idx, { full: 'Ja Marr Chase', pos: 'WR', team: 'CIN' }), 1);
  assert.equal(joinPlayer(idx, { full: 'John Smith', pos: 'WR', team: 'TEN' }), 2); // feed-style "J.Smith"
  assert.equal(joinPlayer(idx, { full: 'Mike Williams', pos: 'TE', team: 'CIN' }), 4);
  assert.equal(joinPlayer(idx, { full: 'Nobody Here', pos: 'WR', team: 'CIN' }), -1);
  assert.equal(normName('Marvin Harrison Jr.'), 'marvinharrison');
});

test('scoring fit recovers a league profile from stat totals and snaps coefficients', () => {
  const league = { ...DEFAULT_PROFILE, rec: 1, passTD: 4 };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = Array.from({ length: 60 }, () => {
    const f = { passYd: Math.round(rnd() * 300), passTD: Math.floor(rnd() * 4), int: Math.floor(rnd() * 2), rushYd: Math.round(rnd() * 80), rec: Math.floor(rnd() * 9), recYd: Math.round(rnd() * 120), recTD: Math.floor(rnd() * 2), rushTD: Math.floor(rnd() * 2) };
    return { f, y: Math.round(dot(f, league) * 100) / 100 };
  });
  const fit = fitProfile(rows);
  assert.equal(fit.src, 'fit');
  assert.equal(fit.profile.rec, 1);
  assert.equal(fit.profile.passTD, 4);
  assert.equal(fit.profile.passYd, 0.04);
  assert.equal(fit.profile.fgL, 5); // no kicker data: stays at the default
  assert.ok(fit.mae < 0.05);
  const raw = ridgeFit(rows);
  assert.ok(Math.abs(raw.rec - 1) < 0.02);
});

test('scoring fit falls back to the default with too few samples or a bad fit', () => {
  assert.equal(fitProfile([{ f: { rec: 3 }, y: 1.5 }]).src, 'default');
  const noise = Array.from({ length: 40 }, (_, i) => ({ f: { rushYd: 10 + i }, y: (i * 37) % 23 }));
  assert.equal(fitProfile(noise).src, 'default');
  assert.equal(snapValue(0.0397), 0.04);
  assert.equal(snapValue(0.46), 0.5);
  assert.equal(snapValue(0.77), 0.75);
});

test('misc: clock, team spelling, csv quoting', () => {
  assert.equal(fmtClock(2, 180), 'Q2 3:00');
  assert.equal(fmtClock(5, 427), 'OT 7:07');
  assert.equal(ffTeam('JAX'), 'JAC');
  assert.equal(ffTeam('LA'), 'LAR');
  assert.equal(ffTeam('WAS'), 'WAS');
  assert.deepEqual([...csvRows('a,"b,""c""",d\n1,2,3\n')], [['a', 'b,"c"', 'd'], ['1', '2', '3']]);
});

test('generated data: week 8 TEN@CIN file is small, ordered, and ends at the real final score', () => {
  const f = 'public/data/pbp/2026/8/TEN@CIN.json';
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(fs.statSync(f).size < 40 * 1024);
  const last = g.plays[g.plays.length - 1];
  assert.deepEqual([last.a, last.h], [36, 43]);
  assert.deepEqual(g.fx, FEATURES);
  const burrow = g.players.findIndex((p) => p[1] === 'Joe Burrow');
  const t = gameTotals(g).get(burrow);
  assert.equal(Math.round(dot(t, DEFAULT_PROFILE) * 100) / 100, 49.48);
});
