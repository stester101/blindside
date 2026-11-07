// End-to-end check against the running server and the REAL Fleaflicker API.
// Usage: node scripts/e2e.mjs [baseUrl] [screenshotDir]
// Needs Playwright available (globally or locally).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.argv[2] || 'http://localhost:8787';
const SHOTS = process.argv[3] || null;
const failures = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures.push(msg);
};

const browser = await chromium.launch();
// Galaxy Z Flip 6 main screen is ~412 CSS px wide.
const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: SHOTS ? 2 : 1, isMobile: true, hasTouch: true });
// Record every text value that ever enters the DOM, to catch spoiler "flashes".
await ctx.addInitScript(() => {
  window.__seen = [];
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) window.__seen.push(n.textContent || '');
      if (m.type === 'characterData') window.__seen.push(m.target.data);
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
});
const page = await ctx.newPage();
const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(m.text()));
page.on('dialog', (d) => d.accept());
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

await page.goto(BASE);
await page.waitForSelector('.teambtn', { timeout: 20000 });
ok((await page.inputValue('#league-id')) === '219707', 'first launch pre-fills league 219707 and loads teams');
ok((await page.locator('.teambtn').count()) === 10, 'team picker lists 10 teams');
const pickerText = await page.locator('#app').innerText();
ok(!/\d+-\d+|\d+\.\d+/.test(pickerText.replace(/219707/g, '')), 'team picker shows no records or points');
await shot('1-setup');

await page.getByRole('button', { name: /Chase Spunk/ }).click();
const waitWeek = (w) =>
  page.waitForFunction((w) => document.querySelector('.weekbar select')?.value === w && document.querySelector('#matchup .mside') && document.querySelector('#games .game'), w, { timeout: 20000 });
await page.waitForSelector('#matchup .mside', { timeout: 20000 });
ok((await page.title()) === 'Blindside', 'title has no scores');
// Smart default: last week until it's finished, while none of this week's starters have kicked off.
const weekDefault = await page.locator('.weekbar select').inputValue();
ok(weekDefault === '8' || weekDefault === '9', `default week is last (unfinished) or current week (got ${weekDefault})`);
const pts = () => page.locator('#matchup .pts').allInnerTexts();

// Week 8 is complete: use it to verify reveal math against Fleaflicker's official totals.
await page.selectOption('.weekbar select', '8');
await waitWeek('8');
ok((await pts()).length === 0, 'no totals shown before any game ticked (no placeholder text)');
const cardText = await page.locator('#matchup').innerText();
ok(!/hidden|null|undefined/i.test(cardText), `matchup card has no placeholder/"Hidden"/null text (${cardText.replace(/\n/g, ' | ')})`);
ok((await page.locator('#matchup .mfoot').innerText()).includes('0 / 9'), 'progress shows 0 / 9 games revealed');
ok((await page.locator('.result').count()) === 0, 'no result banner while games remain');
await page.locator('.segbar .seg[data-tab=lineups]').click();
const hiddenTexts = await page.locator('.pl .p').allInnerTexts();
ok(hiddenTexts.every((t) => t === 'BYE'), `lineups show no player points (${hiddenTexts.join(',')})`);
await page.locator('.segbar .seg[data-tab=games]').click();
await waitWeek('8');
const seenBefore = await page.evaluate(() => window.__seen.join('\n'));
ok(!/\b\d{1,3}\.\d{1,2}\b/.test(seenBefore), 'no decimal numbers ever entered the DOM before ticking (no flash)');
const nGames = await page.locator('.game').count();
ok(nGames === 9, `week 8 shows 9 relevant NFL games (got ${nGames})`);
ok((await page.locator('.game .tbadge').count()) === 18, 'each game shows two team badges');
const leftTxt = await page.locator('#matchup .left').allInnerTexts();
ok(leftTxt[0] === '9 players left' && leftTxt[1] === '9 players left', `players left shown once per team (${leftTxt.join(' | ')})`);
await shot('2-hidden');

// Tick TEN @ CIN: my Burrow 49.48 (QB) and opp C. Brown 12.1 + J. Chase 25.6 played there.
await page.locator('.game', { hasText: 'TEN @ CIN' }).click();
const [m1, o1] = await pts();
ok(m1 === '49.48' && o1 === '37.70', `ticking TEN@CIN reveals only that game (me ${m1}, opp ${o1}; expected 49.48 / 37.70)`);
ok((await page.locator('#matchup .mfoot').innerText()).includes('1 / 9') && (await page.locator('#matchup .pct').innerText()) === '11%', 'progress 1 / 9, 11%');
await page.locator('.segbar .seg[data-tab=lineups]').click();
const revealed = await page.locator('.pl .p.rev').allInnerTexts();
ok(revealed.length === 3, `exactly 3 players revealed (got ${revealed.length}: ${revealed.join(',')})`);
await page.locator('.segbar .seg[data-tab=games]').click();
await waitWeek('8');
const left1 = await page.locator('#matchup .left').allInnerTexts();
ok(left1[0] === '8 players left' && left1[1] === '7 players left', `players left update after tick (${left1.join(' | ')})`);
const card = await page.locator('.game', { hasText: 'TEN @ CIN' }).innerText();
ok(/Burrow 49\.48/.test(card) && /Brown 12\.1/.test(card) && /Chase 25\.6/.test(card) && /Revealed/.test(card), 'watched game card shows each player\'s points and "Revealed"');
const other = await page.locator('.game', { hasText: 'CAR @ GB' }).innerText();
ok(!/\d+\.\d/.test(other) && /Hidden/.test(other), 'unwatched game card shows no points and says "Hidden"');
const order = await page.locator('.game .matchupname').allInnerTexts();
ok(order.indexOf('TEN @ CIN') === 2, `games stay in kickoff order after ticking (${order.join(', ')})`);
await page.click('#btn-hide');
ok((await page.locator('.game', { hasText: 'TEN @ CIN' }).count()) === 0 && (await page.locator('.game').count()) === 8, 'Hide watched hides ticked games');
await shot('3b-hide-watched');
await page.click('#btn-hide');
ok((await page.locator('.game').count()) === 9, 'Show watched brings them back');
const eye = page.locator('#btn-hide');
ok((await eye.locator('svg').count()) === 1 && (await eye.innerText()).trim() === '', 'hide-watched is an eye icon with no text');
const own = page.locator('a.own');
ok((await own.innerText()) === 'Make this my own' && (await own.getAttribute('download')) === 'blindside-make-your-own.md', '"Make this my own" download link at the bottom');
const md = await page.evaluate(async () => (await fetch('make-your-own.md')).text());
ok(md.includes('requestedGames') && md.includes('Access-Control-Allow-Origin') && !/\b\d{1,3}\.\d{2}\b/.test(md), 'build brief downloads with API notes and no scores');
await shot('3-one-game');

// Persisted across reload
await page.reload();
await page.waitForSelector('#matchup .mside');
await page.selectOption('.weekbar select', '8');
await waitWeek('8');
ok((await page.locator('.game[aria-pressed="true"]').count()) === 1, 'watched state persisted in localStorage');

await page.click('#btn-all');
const [m2, o2] = await pts();
ok(m2 === '128.98' && o2 === '105.72', `mark all → official totals 128.98 vs 105.72 (got ${m2} vs ${o2})`);
const res = await page.locator('.result').innerText();
ok(/win/i.test(res), `result unlocked: "${res}"`);
await shot('4-all-watched');

// Week 8 is now finished, so a fresh load defaults to the current week.
await page.reload();
await page.waitForSelector('#matchup .mside');
ok((await page.locator('.weekbar select').inputValue()) === '9', 'after finishing week 8, default week is the current week (9)');
ok((await page.locator('.game', { hasText: 'JAC @ BAL' }).count()) === 0, 'bench-only games (week 9 Thu JAC@BAL) not listed');
await shot('2-week-now');

await page.selectOption('.weekbar select', '8');
await waitWeek('8');
await page.click('#btn-reset');
ok((await pts()).length === 0, 'reset hides everything again');

// League view: every matchup, same watched set.
await page.locator('.segbar .seg[data-tab=league]').click();
await page.waitForSelector('#mlist .mcard', { timeout: 30000 });
ok((await page.locator('#mlist .mcard').count()) === 5, 'league view lists all 5 matchups');
ok((await page.locator('#mlist .pts').count()) === 0, 'league view shows no scores before ticking');
ok((await page.locator('#mlist .mcard').first().getAttribute('class')).includes('yours'), 'your matchup listed first');
await page.locator('.game', { hasText: 'TEN @ CIN' }).click();
const yours = await page.locator('#mlist .mcard.yours .pts').allInnerTexts();
ok(yours.join(',') === '37.70,49.48', `league view reveals TEN@CIN in your matchup (${yours.join(',')})`);
const leagueFits = await page.evaluate(() => {
  const w = window.innerWidth;
  return document.documentElement.scrollWidth <= w && [...document.querySelectorAll('#mlist .pts, #mlist .mcard')].every((el) => el.getBoundingClientRect().right <= w);
});
ok(leagueFits, 'league matchup cards and scores fit the screen width');
await page.evaluate(() => window.scrollTo(0, 0));
await shot('6-league');
await page.click('#btn-reset');
await page.locator('.segbar .seg[data-tab=games]').click();
await waitWeek('8');

// Second league (superflex)
await page.click('#btn-league');
await page.click('.addrow');
await page.fill('#league-id', '332885');
await page.click('text=Load teams');
await page.getByRole('button', { name: /Tester's Titans/ }).click();
await page.waitForSelector('#matchup .mside', { timeout: 20000 });
await page.click('#btn-league');
ok((await page.locator('.leaguerow').count()) === 2, 'two leagues saved in the league switcher');
await page.keyboard.press('Escape');
ok((await page.locator('.sheet').count()) === 0, 'sheet closes with Escape');
await page.click('#btn-settings');
ok((await page.locator('.sheet').getByText('Make this my own').count()) === 1 && (await page.locator('.sheet').getByText('Hide watched games').count()) === 1, 'settings sheet has its options');
await page.keyboard.press('Escape');
await page.selectOption('.weekbar select', '8');
await waitWeek('8');
await page.click('#btn-all');
const [m3, o3] = await pts();
ok(m3 === '102.20' && o3 === '148.40', `superflex totals 102.20 vs 148.40 (got ${m3} vs ${o3})`);
await page.click('#btn-reset');
await page.locator('.segbar .seg[data-tab=lineups]').click();
ok((await page.locator('.slot', { hasText: 'SFLX' }).count()) === 1, 'superflex slot shown');
await page.locator('.segbar .seg[data-tab=games]').click();
await waitWeek('8');
await shot('5-superflex');

// Narrow (cover-screen-ish) width: no horizontal overflow
await page.setViewportSize({ width: 320, height: 700 });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
ok(!overflow, 'no horizontal scroll at 320px');

ok(consoleMsgs.length === 0, `no console output (${consoleMsgs.length})`);
const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
ok(manifest.icons?.some((i) => i.sizes === '512x512'), 'manifest has 512px icon');
const swReg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
ok(swReg, 'service worker registered');

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);
