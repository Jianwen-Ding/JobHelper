/**
 * Pages the extension must not offer on.
 *
 * The local score is deliberately generous, and that is the right trade: the
 * cost of a card on a page that turns out not to be a job is a dismissal, and
 * the cost of silence on one that is, is the whole tool not being there when it
 * was needed. Generous is not indiscriminate, though, and this is the half of
 * the trade that nothing was measuring.
 *
 * Every page here is one you would actually have open. Each is given longer
 * than the extension's own rescore window would need, so "it appeared a moment
 * later" counts as a failure rather than as a pass that got lucky on timing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  HELIOS_ROLE,
  QUIET,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
  serveSlowProxy,
  useServer,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

/** Long enough for the analysis, and past the window in which a page is re-judged. */
const WATCH_MS = 6000;

/**
 * How many pages to watch at once.
 *
 * Watched one after another, eighteen pages at six seconds each came to three
 * minutes, twice — two thirds of the whole suite's wall clock for a check that
 * is six seconds of waiting repeated thirty-six times. Watched together it is
 * six seconds for all of them.
 *
 * Six at a time rather than all eighteen because this also runs beside two
 * other suites on the same machine, and a browser with nineteen tabs loading
 * at once is measuring the machine rather than the extension. It is not a
 * weaker test for being concurrent: load is what made the flicker this file
 * exists for visible in the first place.
 */
const AT_ONCE = 6;

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Watch a batch of pages at once, and say what each of them did.
 *
 * A generator of promises rather than one big promise, so the batches run one
 * after another — the point is to overlap the waiting, not to open eighteen
 * tabs. Each page is watched rather than sampled once: a card that appears and
 * then removes itself is still a card that appeared, and that flicker is the
 * thing people actually complained about.
 */
function* sweep(context, fixtures, list, watchMs) {
  for (let at = 0; at < list.length; at += AT_ONCE) {
    const batch = list.slice(at, at + AT_ONCE);
    yield Promise.all(
      batch.map(async (fixture) => {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 120)));
        await page.goto(fixtures.urlFor(fixture), { waitUntil: 'domcontentloaded' });

        let everAppeared = false;
        const until = Date.now() + watchMs;
        while (Date.now() < until && !everAppeared) {
          everAppeared = (await page.locator('#jobhelper-card-host').count()) > 0;
          if (!everAppeared) await page.waitForTimeout(250);
        }
        await page.close();
        return { fixture, everAppeared, errors };
      }),
    );
  }
}

async function main() {
  await requireOpenSave(SERVER);
  // The control posting is served alongside, so it is reached the same way.
  const fixtures = await serveFixtures([...QUIET, HELIOS_ROLE]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-quiet-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    console.log('\nPages that are not job postings');
    for (const results of sweep(context, fixtures, QUIET, WATCH_MS)) {
      for (const { fixture, everAppeared, errors } of await results) {
        check(`stays quiet on ${fixture.name}`, !everAppeared);
        check(`and breaks nothing on ${fixture.name}`, errors.length === 0, errors.join('; '));
      }
    }

    /*
     * And the control, which is the half that was missing.
     *
     * "No card appeared" proves nothing on its own: a content script that
     * failed to inject, a service worker that never woke, a store that was
     * unreachable — every one of those produces eighteen quiet pages and a
     * green run. So a page that *must* get a card is watched under exactly the
     * same conditions, and this file only means something when it passes.
     */
    console.log('\nAnd a posting, to prove the extension was awake for all that');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      let appeared = false;
      const until = Date.now() + 25_000;
      while (Date.now() < until && !appeared) {
        appeared = (await page.locator('#jobhelper-card-host .card .role').count()) > 0;
        if (!appeared) await page.waitForTimeout(250);
      }
      check('a real posting still gets a card', appeared);
      await page.close();
    }

    /* ------------------------------------------------------------------ *
     * The same pages, with the store answering slowly                     *
     * ------------------------------------------------------------------ */

    /*
     * Quiet on a fast machine is not the same as quiet.
     *
     * The card can go up before the verdict arrives — that is deliberate, so
     * a slow answer does not read as the extension being broken. Which pages
     * get that early card is therefore a second rule, and it was wrong: being
     * on an applicant tracking system counted as proof, so the page after you
     * press submit got a card at once and lost it a moment later.
     *
     * On an idle machine the answer comes back in milliseconds and the flicker
     * is invisible, which is why the sweep above passed and passed and then
     * failed once, under load, looking like noise. Slowing the verdict down on
     * purpose makes the early card certain, so this asks the real question
     * every run rather than one run in ten.
     */
    console.log('\nAnd still quiet when the store is slow to answer');
    const slow = await serveSlowProxy(SERVER, { slowRoute: /analyze/, ms: 5000 });
    try {
      await useServer(context, slow.base);
      for (const results of sweep(context, fixtures, QUIET, 4000)) {
        for (const { fixture, everAppeared, errors } of await results) {
          check(`no early card on ${fixture.name}`, !everAppeared);
          check(`and nothing thrown on ${fixture.name}`, errors.length === 0, errors.join('; '));
        }
      }
    } finally {
      await useServer(context, SERVER);
      slow.close();
    }
  } finally {
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
