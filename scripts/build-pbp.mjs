#!/usr/bin/env node
// Builds the static play-by-play data for the Live Replay (beta) page.
//
// Downloads nflverse play-by-play (CC-BY 4.0) and the dynastyprocess player-ID crosswalk, and writes one small
// JSON file per NFL game plus a manifest:
//   public/data/pbp/<season>/manifest.json            { weeks: { "8": ["TEN@CIN", ...] } }
//   public/data/pbp/<season>/<week>/<AWAY>@<HOME>.json (team abbreviations in Fleaflicker's spelling)
// Output is deterministic (same input, same bytes), so re-running is safe and only changed games differ in git.
//
// Usage:   npm run build:pbp                      (all regular-season weeks in the file)
//          node scripts/build-pbp.mjs --season 2026 [--week 9] [--out public/data/pbp] [--cache DIR]
//          node scripts/build-pbp.mjs --csv local_pbp.csv --ids local_ids.csv   (skip the download)
// Behind an HTTP proxy use:  NODE_USE_ENV_PROXY=1 npm run build:pbp   (Node 22.21+)
// Re-run it after games finish to add them (the nflverse file is updated once the games are over). It is NOT run
// automatically: refresh by hand and commit public/data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvRows, parsePlays, buildGame } from './pbp-lib.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!process.argv[i].startsWith('--')) continue;
  const next = process.argv[i + 1];
  args[process.argv[i].slice(2)] = next && !next.startsWith('--') ? next : true;
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEASON = Number(args.season ?? new Date().getFullYear() - (new Date().getMonth() < 2 ? 1 : 0));
const WEEK = args.week ? Number(args.week) : null;
const OUT = path.resolve(root, String(args.out ?? 'public/data/pbp'));
const CACHE = String(args.cache ?? path.join(os.tmpdir(), 'blindside-pbp'));
const PBP_URL = `https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${SEASON}.csv`;
const IDS_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';

async function load(local, url, name) {
  if (local && local !== true) return fs.readFileSync(String(local), 'utf8');
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, name);
  // Always fetch fresh: the whole point of re-running is picking up new games.
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log(`downloaded ${name}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  return fs.readFileSync(file, 'utf8');
}

const pbpText = await load(args.csv, PBP_URL, `play_by_play_${SEASON}.csv`);
const idsText = await load(args.ids, IDS_URL, 'db_playerids.csv');

// gsis id -> {name, pos}
const cross = new Map();
{
  const rows = csvRows(idsText);
  const head = rows.next().value;
  const ix = (c) => head.indexOf(c);
  const [g, n, p] = [ix('gsis_id'), ix('name'), ix('position')];
  for (const r of rows) {
    if (!r[g] || r[g] === 'NA' || cross.has(r[g])) continue;
    cross.set(r[g], { name: r[n], pos: r[p] === 'PK' ? 'K' : r[p] });
  }
}
const nameOf = (id, feed) => cross.get(id)?.name || feed || '';
const posOf = (id) => cross.get(id)?.pos || '';

const plays = parsePlays(pbpText, { week: WEEK });
const games = new Map();
for (const p of plays) {
  if (!games.has(p.gid)) games.set(p.gid, []);
  games.get(p.gid).push(p);
}

const manifest = { season: SEASON, source: 'nflverse play-by-play (CC-BY 4.0)', weeks: {} };
const sizes = [];
let written = 0;
let unchanged = 0;
const oddAll = [];
for (const gp of games.values()) {
  const { game, odd } = buildGame(gp, { season: SEASON, nameOf, posOf });
  const key = `${game.away}@${game.home}`;
  const dir = path.join(OUT, String(SEASON), String(game.week));
  // File names use '-' not '@': Cloudflare redirects '@' URLs to '%40', and browsers send them straight back (redirect loop).
  const file = path.join(dir, `${game.away}-${game.home}.json`);
  const body = JSON.stringify(game);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) unchanged++;
  else {
    fs.writeFileSync(file, body);
    written++;
  }
  (manifest.weeks[game.week] ??= []).push(key);
  sizes.push(Buffer.byteLength(body));
  if (odd.length) oddAll.push(`${key} wk${game.week}: ${odd.join(' ')}`);
}
for (const w of Object.keys(manifest.weeks)) manifest.weeks[w].sort();
// A partial rebuild (--week) must not drop other weeks from the manifest.
const manifestFile = path.join(OUT, String(SEASON), 'manifest.json');
let merged = manifest;
if (WEEK != null && fs.existsSync(manifestFile)) {
  merged = { ...manifest, weeks: { ...JSON.parse(fs.readFileSync(manifestFile, 'utf8')).weeks, ...manifest.weeks } };
}
merged.weeks = Object.fromEntries(Object.entries(merged.weeks).sort((a, b) => Number(a[0]) - Number(b[0])));
fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
fs.writeFileSync(manifestFile, JSON.stringify(merged, null, 1) + '\n');

sizes.sort((a, b) => a - b);
const total = sizes.reduce((t, n) => t + n, 0);
console.log(`season ${SEASON}: ${games.size} games, ${written} written, ${unchanged} unchanged`);
if (sizes.length) console.log(`game files: total ${(total / 1024).toFixed(0)} KB, median ${(sizes[sizes.length >> 1] / 1024).toFixed(1)} KB, largest ${(sizes[sizes.length - 1] / 1024).toFixed(1)} KB`);
if (oddAll.length) console.log(`scoring plays whose point change is not 6/3/1/2/2:\n  ${oddAll.join('\n  ')}`);
