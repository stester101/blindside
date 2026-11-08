// End-to-end check of the Live Replay (beta) page against the running server and the REAL Fleaflicker API.
// Usage: NODE_PATH=$(npm root -g) node scripts/e2e-live.mjs [baseUrl] [screenshotDir]
// Start the app first, e.g.  NODE_USE_ENV_PROXY=1 PORT=8788 node server.js
import { createRequire } from 'node:module';
import { groupPlays } from '../public/live-core.js';
const req = createRequire(import.meta.url);
// Playwright is normally global: NODE_PATH=$(npm root -g) works; otherwise look next to the node binary.
const { chromium } = (() => {
  try {
    return req('playwright');
  } catch {
    return req(`${process.execPath.replace(/\/bin\/node$/, '')}/lib/node_modules/playwright`);
  }
})();

const BASE = process.argv[2] || 'http://localhost:8788';
const SHOTS = process.argv[3] || null;
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const LEAGUES = [{ leagueId: '219707', season: 2026, leagueName: 'Falcon Money League', teamId: 1400091, teamName: 'Chase Spunk' }];
const browser = await chromium.launch();

async function newPage({ width = 412, height = 915, reduced = true, leagues = LEAGUES } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((lg) => {
    if (!localStorage.getItem('blindside:v1:leagues')) {
      localStorage.setItem('blindside:v1:leagues', JSON.stringify(lg));
      localStorage.setItem('blindside:v1:active', JSON.stringify(lg[0].leagueId));
    }
  }, leagues);
  const page = await ctx.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  return { ctx, page, consoleMsgs };
}
// The CC BY 4.0 credit line is the only static text with a decimal point.
const text = (page) => page.evaluate(() => document.body.innerText.replace(/CC BY 4\.0/g, 'CC BY'));
const cards = (page) => page.locator('.pcard.play').count();
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

// Oracle: the game file itself (only used by the test to know what must NOT be on screen yet).
const gameFile = await (await fetch(`${BASE}/data/pbp/2026/8/TEN-CIN.json`)).json();
// One oracle entry per CARD: a touchdown and its extra point share a card (see groupPlays).
const plays = groupPlays(gameFile.plays).map((grp) => {
  const end = gameFile.plays[grp.end];
  return { ...grp.main, a: end.a, h: end.h };
});
ok(plays.length > 10, `test oracle loaded (${plays.length} cards in TEN@CIN week 8, from ${gameFile.plays.length} scoring plays)`);

/* ------------------------------------------------------------ single league, reduced motion */
{
  const { ctx, page, consoleMsgs } = await newPage();
  await page.goto(`${BASE}/live.html#l=219707&w=8`);
  await page.waitForSelector('.game[data-game="TEN@CIN"]:not([disabled])', { timeout: 30000 });
  ok((await page.title()) === 'Blindside Live Replay', 'page title is static');
  ok((await page.locator('.backlink').getAttribute('href')) === './', 'back link to the main app');
  const listText = await text(page);
  ok(!/\d+\.\d/.test(listText), 'game list shows no decimal numbers');
  await page.locator('.game[data-game="TEN@CIN"]').click();
  await page.waitForSelector('#nextbtn', { timeout: 60000 });
  await page.waitForTimeout(300);

  let t = await text(page);
  ok((await cards(page)) === 0, 'no scoring play card before the first press');
  ok(!/~|touchdown|field goal|extra point|\bQ[1-5] \d/i.test(t) && !/\d+\.\d/.test(t), 'nothing about plays or points on screen before the first press');
  ok(!plays.some((p) => p.scorer && t.includes(p.scorer)) && !plays.some((p) => t.includes(p.desc)), 'no scorer name or play description anywhere before the first press');
  ok((await page.locator('#nextbtn').innerText()) === 'Next scoring play', 'button reads "Next scoring play"');
  const box = await page.locator('#nextbtn').boundingBox();
  ok(box.height >= 52 && box.y + box.height > 915 - 120, `big button sits at the bottom (height ${box.height}, bottom ${Math.round(box.y + box.height)})`);
  ok(await page.evaluate(() => Object.keys(localStorage).every((k) => !k.includes(':live:p:'))), 'no progress saved before pressing');
  await shot(page, '1-before-first-press');

  // Press through every scoring play.
  const seen = [];
  const seenScorers = new Set();
  let scoreOk = true;
  let lastTotal = 0;
  let allAbsent = true;
  let oneAtATime = true;
  let timeline = [];
  for (let i = 0; i < plays.length; i++) {
    await page.locator('#nextbtn').click();
    await page.waitForFunction((n) => document.querySelectorAll('.pcard.play').length === n, i + 1);
    t = await text(page);
    oneAtATime &&= (await cards(page)) === i + 1;
    seen.push(plays[i].desc);
    seenScorers.add(plays[i].scorer);
    if (plays[i].by) seenScorers.add(plays[i].by);
    // Later plays must not be on the page: their description (unless an identical earlier one) and their scorer (unless already seen).
    for (let j = i + 1; j < plays.length; j++) {
      if (!seen.includes(plays[j].desc) && t.includes(plays[j].desc)) { allAbsent = false; console.log(`  leak: desc of play ${j + 1} visible after press ${i + 1}`); }
      if (plays[j].scorer && !seenScorers.has(plays[j].scorer) && !seen.some((d) => d.includes(plays[j].scorer)) && t.includes(plays[j].scorer)) { allAbsent = false; console.log(`  leak: scorer of play ${j + 1} visible after press ${i + 1}`); }
    }
    const top = page.locator('.pcard.play').first();
    const head = await top.locator('.pscore').innerText();
    const expect = `${gameFile.away} ${plays[i].a} – ${gameFile.home} ${plays[i].h}`;
    const total = plays[i].a + plays[i].h;
    scoreOk &&= head === expect && total >= lastTotal;
    lastTotal = total;
    // Cards where none of our starters changed have no subtotal line (they are collapsed), so only read it when present.
    const subEl = top.locator('.sub');
    const sub = (await subEl.count()) ? (await subEl.innerText()).replace(/\s+/g, ' ') : '';
    if (sub) timeline.push(sub);
    if (i === 2) await shot(page, '2-after-3-presses');
    if (i < plays.length - 1) ok(true, `press ${i + 1}: ${(await top.locator('.clock').innerText())} ${(await top.locator('.chip').innerText())} ${plays[i].scorer || plays[i].team} | ${sub || '(no change for our starters)'}`);
  }
  ok(oneAtATime, 'each press adds exactly one card');
  ok(allAbsent, 'later plays (description and scorer) never appeared early');
  ok(scoreOk, 'game score on each card matches and never goes down');
  ok(timeline.every((s) => /You ~[−\d.]+ . Opp ~[−\d.]+/.test(s)), 'every card shows "You ~x - Opp ~y" with the approximate marker');
  const nums = timeline.map((s) => s.match(/You ~(\S+)/)[1].replace('−', '-')).map(Number);
  ok(nums.every((v, i) => i === 0 || v >= nums[i - 1] - 3), `You subtotal progresses sensibly (${nums.join(', ')})`);
  ok(nums[nums.length - 1] > 30, 'You subtotal near the end is near Burrow\'s total');
  const firstCardRows = await page.locator('.pcard.play').last().locator('.prow').allInnerTexts();
  ok(true, `first card impact rows: ${firstCardRows.join(' / ').replace(/\n/g, ' ')}`);

  // Resume mid-way and at the last play.
  ok((await page.locator('#nextbtn').innerText()) === 'Finish game', 'after the last play the button becomes "Finish game"');
  const stored = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.includes(':live:'))));
  const allowed = Object.entries(stored).every(([k, v]) => (k.includes(':live:p:') ? /^\d+$/.test(v) : k.includes(':live:scoring:') ? !/[A-Za-z]{4,}/.test(v.replace(/passYd|passTD|rushYd|rushTD|recYd|recTD|fumLost|twoPt|fgS|fgM|fgL|stTD|"int"|"rec"|"xp"|"v"|"c"|"n"|"src"|"fit"|"default"/g, '')) : false));
  ok(allowed && Object.keys(stored).length >= 1, `localStorage live keys are only counters and coefficients (${Object.keys(stored).map((k) => k.replace('blindside:v1:', '')).join(', ')})`);
  await page.reload();
  await page.waitForSelector('.pcard.play', { timeout: 60000 });
  ok((await cards(page)) === plays.length, 'reload resumes exactly the plays already revealed');
  await page.locator('.refit').click();
  // The bottom bar is hidden while the game reloads; wait until it is back with the restored feed.
  await page.waitForFunction((n) => !document.getElementById('livebar').hidden && document.querySelectorAll('.pcard.play').length === n, plays.length, { timeout: 60000 });
  ok((await cards(page)) === plays.length, 'Recalculate league scoring refits and keeps the progress');
  ok((await page.locator('#nextbtn').innerText()) === 'Finish game', 'reload keeps the Finish button state');
  await page.evaluate(() => window.scrollTo(0, 0));

  // Finish.
  await page.locator('#nextbtn').click();
  await page.waitForSelector('.pcard.final');
  const finalSub = (await page.locator('.pcard.final .sub').innerText()).replace(/\s+/g, ' ');
  ok(/You 49\.48 . Opp 37\.70/.test(finalSub), `Finish shows Fleaflicker's exact numbers: "${finalSub}"`);
  const finalText = await page.locator('.pcard.final').innerText();
  ok(!finalText.includes('~'), 'the "~" marker is gone in the final card');
  ok(/Burrow\s*49\.48/.test(finalText.replace(/\n/g, ' ')), 'Joe Burrow final is 49.48');
  ok(/Brown\s*12\.1/.test(finalText.replace(/\n/g, ' ')) && /Chase\s*25\.6/.test(finalText.replace(/\n/g, ' ')), 'opponent players Brown 12.1 and Chase 25.6');
  ok((await page.locator('#nextbtn').isDisabled()) && (await page.locator('#nextbtn').innerText()) === 'Game finished', 'button shows the game is finished');
  await shot(page, '3-after-finish');
  await page.reload();
  await page.waitForSelector('.pcard.final', { timeout: 60000 });
  ok((await cards(page)) === plays.length, 'reload after finishing restores the finished game');

  // Reset (dialogs are auto-accepted).
  await page.locator('.resetbtn').click();
  ok((await page.locator('.pcard').count()) === 0 && (await page.locator('#nextbtn').innerText()) === 'Next scoring play', 'Reset game clears the feed');
  ok((await page.evaluate(() => Object.keys(localStorage).filter((k) => k.includes(':live:p:')).length)) === 0, 'Reset game removes the saved progress');
  await page.reload();
  await page.waitForSelector('#nextbtn', { timeout: 60000 });
  ok((await cards(page)) === 0, 'reload after reset starts clean');

  // Mid-game reload shows only what was stepped through.
  for (let i = 0; i < 3; i++) await page.locator('#nextbtn').click();
  await page.reload();
  await page.waitForSelector('.pcard.play', { timeout: 60000 });
  t = await text(page);
  ok((await cards(page)) === 3 && !t.includes(plays[3].desc), 'mid-game reload shows 3 cards and not the 4th play');
  ok(!(await page.locator('.pcard.enter').count()), 'reduced motion: no reveal animation class');

  // Service worker must not hold play data.
  await page.waitForFunction(() => navigator.serviceWorker?.controller || true);
  await page.evaluate(() => navigator.serviceWorker?.ready);
  await page.reload();
  await page.waitForSelector('.pcard.play', { timeout: 60000 });
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
  ok(cached.length > 0 && !cached.some((p) => p.includes('/data/') || p.includes('/api/')), `service worker caches hold the app shell only (${cached.length} entries, none under /data/ or /api/)`);
  ok(cached.includes('/live.js') && cached.includes('/live-core.js'), 'live page files are part of the app shell');

  // 320 px.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'game view: no horizontal overflow at 320px');
  await shot(page, '4-narrow-320');
  await page.locator('text=Change game').click();
  await page.waitForSelector('.game');
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'game list: no horizontal overflow at 320px');

  ok(consoleMsgs.length === 0, `no console output (${consoleMsgs.join(' | ')})`);
  await ctx.close();
}

/* ------------------------------------------------------------ animation when motion is allowed */
{
  const { ctx, page, consoleMsgs } = await newPage({ reduced: false });
  await page.goto(`${BASE}/live.html#l=219707&w=8&g=TEN@CIN`);
  await page.waitForSelector('#nextbtn', { timeout: 60000 });
  await page.locator('.resetbtn').click();
  await page.locator('#nextbtn').click();
  ok((await page.locator('.pcard.enter').count()) === 1, 'with motion allowed the new card has the reveal animation');
  ok(consoleMsgs.length === 0, 'no console output (motion run)');
  await ctx.close();
}

/* ------------------------------------------------------------ all leagues */
{
  const second = { leagueId: '999999', season: 2026, leagueName: 'Second League', teamId: 1400091, teamName: 'Chase Spunk 2' };
  const { ctx, page, consoleMsgs } = await newPage({ leagues: [...LEAGUES, second] });
  // The second league is the same real league under another id, so we can exercise All leagues with real data.
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.searchParams.get('league_id') === '999999') {
      u.searchParams.set('league_id', '219707');
      // Node's fetch (not route.fetch) so this also works against a remote BASE behind an HTTP proxy.
      const r = await fetch(u.toString());
      return route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() });
    }
    return route.continue();
  });
  await page.goto(`${BASE}/live.html#w=8`);
  await page.waitForSelector('.game[data-game="TEN@CIN"]:not([disabled])', { timeout: 30000 });
  ok((await page.locator('.selpill select').first().inputValue()) === 'all', 'two leagues default to All leagues');
  ok((await page.locator('.game[data-game="TEN@CIN"] .lgline').count()) === 2, 'game list shows one You/Opp block per league');
  await page.locator('.game[data-game="TEN@CIN"]').click();
  await page.waitForSelector('#nextbtn', { timeout: 60000 });
  // Cards where none of our starters changed show no block at all, so press until the first card that has one.
  let presses = 1;
  await page.locator('#nextbtn').click();
  while (!(await page.locator('.pcard.play').first().locator('.impact').count()) && presses < plays.length) {
    await page.locator('#nextbtn').click();
    presses++;
  }
  ok((await page.locator('.pcard.play').first().locator('.impact').count()) === 2, `a card where our players change shows one block per league (after ${presses} press${presses === 1 ? '' : 'es'})`);
  ok(presses < plays.length, 'empty cards are collapsed: some cards show no block at all');
  // Press through to the end: the remaining cards, then the final card.
  // plays.length cards in total, then one more press to finish.
  for (let i = presses + 1; i <= plays.length + 1; i++) await page.locator('#nextbtn').click();
  await page.waitForSelector('.pcard.final');
  const subs = (await page.locator('.pcard.final .sub').allInnerTexts()).map((s) => s.replace(/\s+/g, ' '));
  ok(subs.length === 2 && subs.every((s) => /You 49\.48 . Opp 37\.70/.test(s)), `All leagues finish: exact numbers per league (${subs.join(' | ')})`);
  ok(consoleMsgs.length === 0, `no console output (all leagues: ${consoleMsgs.join(' | ')})`);
  await ctx.close();
}

/* ------------------------------------------------------------ main app link */
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/`);
  await page.waitForSelector('#matchup .mside', { timeout: 30000 });
  await page.locator('#btn-settings').click();
  const link = page.locator('a.sheetrow', { hasText: 'Live replay (beta)' });
  ok((await link.count()) === 1 && (await link.getAttribute('href')) === 'live.html', 'Settings sheet links to the live replay page');
  await ctx.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
