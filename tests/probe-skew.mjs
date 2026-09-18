/**
 * Version skew: what the user sees when the server does not have an endpoint
 * the extension calls (extension newer than server), and when the server
 * answers a shape the extension does not expect (server newer / older).
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELIOS_ROLE, findChromium, serveFixtures, useServer } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPSTREAM = 'http://127.0.0.1:4600';
const MISSING = (process.env.MISSING ?? '/api/applications/bundle').split(',');

/** The real server, with some routes answering like an older build: 404 HTML. */
function serveOld() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const go = async () => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const p = req.url.split('?')[0];
        if (MISSING.some((m) => p === m || p.startsWith(m + '/'))) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
          res.end(`<!DOCTYPE html><html><head><title>Error</title></head><body><pre>Cannot ${req.method} ${p}</pre></body></html>`);
          return;
        }
        const up = await fetch(`${UPSTREAM}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
        res.writeHead(up.status, {
          'content-type': up.headers.get('content-type') ?? 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(Buffer.from(await up.arrayBuffer()));
      };
      go().catch((e) => { res.writeHead(502); res.end(String(e)); });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

async function main() {
  const fixtures = await serveFixtures([HELIOS_ROLE]);
  const old = await serveOld();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-skew-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(), headless: true, viewport: { width: 1360, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await useServer(context, old.base);
    console.log('extension pointed at', old.base, ' missing:', MISSING.join(', '));

    const page = await context.newPage();
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await page.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await page.waitForFunction(
      () => !document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card.loading'),
      null, { timeout: 30_000 });
    const card = page.locator('#jobhelper-card-host .card');

    await card.getByRole('button', { name: 'Build resume' }).click();
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

    await card.getByRole('button', { name: 'Prepare to submit' }).click();
    await page.waitForTimeout(4000);
    console.log('\n--- what the card says when the endpoint is gone ---');
    console.log(await card.locator('.err').innerText().catch(() => '(no error box shown!)'));
    console.log('--- buttons offered:', await card.locator('.err button').allInnerTexts());
    console.log('--- still on the propose view?', (await card.locator('.done-box').count()) === 0);
    await page.screenshot({ path: '/tmp/claude-0/-home-user/5c309cd1-83cc-5f91-bbeb-3baa713b6f8d/scratchpad/skew.png' });
  } finally {
    await context.close();
    fixtures.close();
    old.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
