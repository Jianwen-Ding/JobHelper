/**
 * Back, with the back/forward cache actually on.
 *
 * Every other suite launches Chromium the way Playwright does by default,
 * which passes `--disable-back-forward-cache` — so `goBack()` is a reload,
 * the content script runs from the top, the trail is re-established, and
 * everything is correct. Real Chrome restores the document whole and runs
 * nothing. This launches with the flag left off, which is the only way to
 * see the difference.
 *
 *   node tests/probe-bfcache-trail.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELIOS_ROLE,
  STREAMLY,
  cleanStore,
  findChromium,
  serveFixtures,
  requireOpenSave,
  pointExtensionAt,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const cardOf = (page) => page.locator(`${HOST} .card`);

let bad = 0;
const check = (what, ok, detail = '') => {
  if (!ok) bad++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function settled(page) {
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
  await page.locator(`${HOST} .card:not(.loading)`).waitFor({ timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
}

const trailOf = (worker, url) =>
  worker.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    if (!tab) return null;
    const key = `trail:${tab.id}`;
    const stored = (await (chrome.storage.session ?? chrome.storage.local).get(key))[key];
    return { pages: (stored?.pages ?? []).map((p) => p.url), save: stored?.save ?? null };
  }, url);

try {
  await requireOpenSave(SERVER);
} catch {
  process.exit(2);
}
await cleanStore(SERVER, ['Helios Robotics', 'Streamly']);

const fixtures = await serveFixtures([HELIOS_ROLE, STREAMLY]);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-bfc-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1280, height: 900 },
  args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  // The whole point.
  ignoreDefaultArgs: ['--disable-back-forward-cache'],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await pointExtensionAt(context, worker, SERVER);

  const page = await context.newPage();
  const first = fixtures.urlFor(HELIOS_ROLE);
  await page.goto(first, { waitUntil: 'domcontentloaded' });
  await settled(page);
  const roleBefore = (await cardOf(page).locator('.role').textContent())?.trim() ?? '';

  // Off to a different posting in the same tab, then back.
  await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
  await settled(page);
  const moved = await trailOf(worker, page.url());

  await page.goBack({ waitUntil: 'commit' }).catch(() => undefined);
  await page.waitForTimeout(6000);

  const restored = await page.evaluate(() => window.location.href);
  const persisted = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type ?? '?');
  console.log(`\nback to     : ${restored}`);
  console.log(`nav type    : ${persisted}  (a restore re-runs nothing, so this is the first visit's entry)`);
  console.log(`trail on B  : ${JSON.stringify(moved?.pages ?? [])}`);

  const after = await trailOf(worker, restored);
  console.log(`trail now   : ${JSON.stringify(after?.pages ?? [])}\n`);

  check(
    'the trail belongs to the page you are looking at again',
    (after?.pages ?? []).some((u) => u === first),
    JSON.stringify(after?.pages ?? []),
  );
  check(
    'and not to the posting you went to in between',
    !(after?.pages ?? []).some((u) => u.includes(STREAMLY.path)),
    JSON.stringify(after?.pages ?? []),
  );
  check('the card is still the one for this posting', /platform engineer/i.test(roleBefore), roleBefore);
} finally {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  await fixtures.close?.();
}
console.log(bad === 0 ? '\nall correct' : `\n${bad} wrong`);
process.exit(bad === 0 ? 0 : 1);
