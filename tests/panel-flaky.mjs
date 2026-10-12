/**
 * The panel over a store that fails one request.
 *
 * `refresh()` read a failed `/api/resumes` — a timeout, a 503 while the
 * store was busy — as an empty list, and told the person the copy they were
 * editing "has been deleted in ResumeM-M". One slow answer, and a wrong and
 * alarming sentence. `poll()` already kept the list it had; this is that
 * failure, from the other door.
 *
 * Over a small fake server of its own, so it needs no ResumeM-M.
 *
 *   node tests/panel-flaky.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extensionWorker, findChromium } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

async function main() {
  let failResumes = false;
  // For the poll: a revision that moves, a copy that arrives with it, and a
  // number of /api/resumes requests to fail before answering again.
  let revision = 1;
  let arrived = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(o));
    };
    if (req.url.startsWith('/health')) return json({ service: 'resumem-m', projectOpen: true, dataDir: '/save' });
    if (req.url.startsWith('/api/revision')) return json({ revision });
    if (req.url.startsWith('/api/resumes')) {
      if (failNext > 0) {
        failNext--;
        return json({ error: 'busy' }, 503);
      }
      return failResumes
        ? json({ error: 'busy' }, 503)
        : json([
            { id: 'base', label: 'Base', tier: 'base' },
            { id: 'job-x', label: 'Copy for X', tier: 'temporary' },
            ...arrived,
          ]);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    // The editor, as far as the panel hears from it: which resume is open.
    // Without it the panel has nothing on screen and draws no picker.
    if (req.url === '/') {
      return res.end(`<!doctype html><title>Editor</title><script>
        let open = decodeURIComponent(location.hash.split('/')[1] || '');
        const say = () => parent.postMessage({ rmm: 'state', resumeId: open, label: null, save: 'saved', view: 'edit', focus: false, exists: true }, '*');
        addEventListener('message', (e) => {
          const m = e.data || {};
          if (m.rmm === 'open') { open = m.id; parent.postMessage({ rmm: 'opened', seq: m.seq, ok: true }, '*'); say(); }
          if (m.rmm === 'flush') parent.postMessage({ rmm: 'flushed', seq: m.seq, ok: true }, '*');
        });
        say();
      </script>`);
    }
    res.end('<!doctype html><title>Posting</title><h1>A posting</h1>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const S = `http://127.0.0.1:${server.address().port}`;

  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-panel-flaky-')), {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = await extensionWorker(context);
    await worker.evaluate((u) => chrome.storage.sync.set({ serverUrl: u, autoPrompt: false }), S);
    const extId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`${S}/posting`);
    const tab = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0], `${S}/posting`);
    // The tab has a copy, as a card that has built one leaves it.
    await worker.evaluate(
      ([id, u]) =>
        chrome.storage.session.set({
          [`jh-panel:${id}`]: {
            copyId: 'job-x',
            copyLabel: 'Copy for X',
            baseId: 'base',
            baseLabel: 'Base',
            url: u,
            save: '/save',
            at: Date.now(),
          },
        }),
      [tab.id, `${S}/posting`],
    );
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/src/panel/panel.html?tab=${tab.id}`);
    const said = () =>
      panel.evaluate(() => {
        const box = document.querySelector('#message');
        return box?.hidden ? '' : `${document.querySelector('#message-title')?.textContent ?? ''} ${document.querySelector('#message-text')?.textContent ?? ''}`.trim();
      });

    group('The store answering');
    await panel.waitForTimeout(2500);
    {
      const text = await said();
      check('nothing is said about the copy', !/deleted|no longer/i.test(text), text);
    }

    group('One /api/resumes request failing during a refresh');
    failResumes = true;
    // Coming back to the panel runs `refresh()`.
    await panel.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await panel.waitForTimeout(1500);
    {
      const text = await said();
      check('the copy is not said to be deleted', !/deleted|no longer/i.test(text), text);
    }

    group('And the store answering again');
    failResumes = false;
    await panel.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await panel.waitForTimeout(1500);
    {
      const text = await said();
      check('still nothing said', !/deleted|no longer/i.test(text), text);
    }

    /*
     * The same failure, from the poll. It took the new revision before asking
     * for the list, and kept the old list when that one request failed — so
     * it believed itself up to date and never asked again, and a copy made in
     * the store stayed missing from the picker until the store changed again.
     */
    group('One /api/resumes request failing during a poll');
    await panel.bringToFront();
    const options = () => panel.evaluate(() => [...document.querySelectorAll('#picker option')].map((o) => o.textContent));
    check('the picker is drawn, from the list as it was', (await options()).includes('Copy for X'), JSON.stringify(await options()));
    arrived = [{ id: 'job-y', label: 'Copy for Y', tier: 'temporary' }];
    revision = 2;
    failNext = 1;
    // The poll runs every four seconds: one to fail, one to ask again.
    await panel.waitForTimeout(10_000);
    {
      const listed = await options();
      check('the request that failed was not the last one asked', failNext === 0, `${failNext} left to fail`);
      check('the new copy is in the picker after all', listed.includes('Copy for Y'), JSON.stringify(listed));
    }
  } finally {
    await context.close();
    server.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
