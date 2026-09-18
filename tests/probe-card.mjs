/**
 * Ad-hoc probe: the on-page card, in the states that are hard to reach against
 * a fast local server.
 *
 *   node tests/probe-card.mjs [only]
 *
 * `only` is one of: stale, error, lockout.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPA_BOARD, STREAMLY, cleanStore, findChromium, serveFixtures, useServer } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const only = process.argv[2];

const say = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);
const HOST = '#jobhelper-card-host';
const cardOf = (page) => page.locator(`${HOST} .card`);

/** A proxy in front of ResumeM-M that can delay or break individual routes. */
function proxy(target, { delay = {}, breaks = [] } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);

        if (breaks.some((re) => re.test(req.url))) {
          res.writeHead(500, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify({ error: 'The store could not be read.' }));
          return;
        }
        for (const [pattern, ms] of Object.entries(delay)) {
          if (new RegExp(pattern).test(req.url)) await new Promise((r) => setTimeout(r, ms));
        }
        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      })().catch((err) => {
        res.writeHead(502);
        res.end(String(err));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    );
  });
}

const roleNow = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('#jobhelper-card-host');
    const card = host?.shadowRoot?.querySelector('.card');
    return {
      role: card?.querySelector('.role')?.textContent?.trim() ?? '',
      co: card?.querySelector('.co')?.textContent?.trim() ?? '',
      url: location.pathname,
    };
  });

async function main() {
  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    /* ---------------------------------------------------------------- *
     * 1. A rebuild started on one posting, landing on another's card.
     * ---------------------------------------------------------------- */
    if (!only || only === 'stale') {
      console.log('\n1. Rebuild in flight while the single-page board switches posting');
      const slow = await proxy(SERVER, { delay: { 'extension/analyze': 6000 } });
      await useServer(context, slow.base);
      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(SPA_BOARD), { waitUntil: 'domcontentloaded' });
        await page.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });
        await page.waitForTimeout(1500);
        say('settled on', await roleNow(page));

        // The user asks for a rebuild, then changes their mind and opens the
        // other posting before it comes back.
        await cardOf(page).getByRole('button', { name: /Match it myself/ }).click();
        await page.waitForTimeout(400);
        await page.click('#to-b');

        const seen = [];
        let snapshot = null;
        for (let i = 0; i < 160; i++) {
          const now = await roleNow(page);
          const key = `${now.url} :: ${now.role}`;
          if (now.role && seen[seen.length - 1] !== key) {
            seen.push(key);
            // The moment the abandoned pass writes the old posting onto the
            // new page's card, take a full picture of what is on offer.
            if (seen.length === 3) {
              snapshot = await page.evaluate(() => {
                const card = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card');
                return {
                  url: location.pathname,
                  loading: card?.classList.contains('loading'),
                  role: card?.querySelector('.role')?.textContent?.trim(),
                  changes: [...(card?.querySelectorAll('.change ins') ?? [])].map((n) => n.textContent.slice(0, 70)),
                  fileButton: [...(card?.querySelectorAll('button') ?? [])]
                    .filter((b) => /Submit|Autofill/.test(b.textContent))
                    .map((b) => ({ label: b.textContent.trim(), disabled: b.disabled })),
                };
              });
            }
          }
          await page.waitForTimeout(100);
        }
        say('what the card claimed, in order', seen);
        say('the card, at the moment it went stale', snapshot);
        const afterSwitch = seen.filter((s) => s.startsWith('/altair/openings/data-scientist'));
        say(
          'STALE: the data-scientist page ever showed the platform-engineer analysis',
          afterSwitch.some((s) => /Platform Engineer/i.test(s)),
        );
        await page.close();
      } finally {
        await useServer(context, SERVER);
        slow.close();
      }
    }

    /* ---------------------------------------------------------------- *
     * 2. The analysis fails with an error the worker cannot suggest a fix for.
     * ---------------------------------------------------------------- */
    if (!only || only === 'error') {
      console.log('\n2. The first analysis fails');
      const broken = await proxy(SERVER, { breaks: [/extension\/analyze/] });
      await useServer(context, broken.base);
      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
        await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
        await page.waitForTimeout(6000);

        say('card state', await page.evaluate(() => {
          const card = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card');
          return {
            stillLoading: card?.classList.contains('loading'),
            error: card?.querySelector('.err')?.textContent?.trim() ?? null,
            progressBars: card?.querySelectorAll('.progress').length,
            progressLabel: card?.querySelector('.progress-label')?.textContent ?? null,
            wayOut: [...(card?.querySelectorAll('.err-actions button') ?? [])].map((b) => b.textContent),
            buttons: [...(card?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
          };
        }));

        // And it stays that way: nothing re-tries, however long you wait.
        await page.waitForTimeout(8000);
        say('ten seconds later, still loading', await page.evaluate(() =>
          document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card')?.classList.contains('loading'),
        ));
        await page.close();
      } finally {
        await useServer(context, SERVER);
        broken.close();
      }
    }

    /* ---------------------------------------------------------------- *
     * 3. The card drafts a letter nobody asked for, and freezes while it does.
     * ---------------------------------------------------------------- */
    if (!only || only === 'lockout') {
      console.log('\n3. Every button greyed out while the unasked-for letter drafts');
      const slow = await proxy(SERVER, { delay: { 'ai/cover-letter': 12000 } });
      await useServer(context, slow.base);
      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
        await page.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });
        await page.waitForTimeout(2500);

        say('while the letter drafts', await page.evaluate(() => {
          const card = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card');
          return {
            busyLabel: card?.querySelector('.progress-label')?.textContent ?? null,
            enabled: [...(card?.querySelectorAll('button') ?? [])]
              .filter((b) => !b.disabled)
              .map((b) => b.textContent.trim()),
            disabled: [...(card?.querySelectorAll('button') ?? [])]
              .filter((b) => b.disabled)
              .map((b) => b.textContent.trim()),
          };
        }));

        // Type into the card's feedback box while the draft is still out.
        const feedback = cardOf(page).locator('textarea').first();
        await feedback.click();
        await feedback.type('lead with the distributed', { delay: 30 });
        say('focus before the draft lands', await page.evaluate(() => {
          const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          const el = root?.activeElement;
          return { tag: el?.tagName ?? null, caret: el?.selectionStart ?? null, value: el?.value ?? null };
        }));

        await page.waitForTimeout(13_000);
        say('focus after the draft lands', await page.evaluate(() => {
          const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          const el = root?.activeElement;
          return {
            tag: el?.tagName ?? null,
            caret: el?.selectionStart ?? null,
            outerActive: document.activeElement?.tagName ?? null,
            feedbackValue: root?.querySelector('.card textarea')?.value ?? null,
          };
        }));
        await page.close();
      } finally {
        await useServer(context, SERVER);
        slow.close();
      }
    }
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Streamly', 'Altair']);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
