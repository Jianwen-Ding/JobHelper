/** PROBE: what spec does the card actually post when it stages? */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HELIOS_ROLE, findChromium, pointExtensionAt, serveFixtures, useServer } from './fixtures.mjs';

const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4601';

function logProxy(target) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      (async () => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks);
        if (/bundle|stage|analyze/.test(req.url) && body.length) {
          try {
            const j = JSON.parse(body.toString());
            if (j.spec) console.log(`>> ${req.url} spec.sections =`, JSON.stringify(j.spec.sections));
          } catch { /* not json */ }
        }
        const up = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        });
        const buf = Buffer.from(await up.arrayBuffer());
        if (/analyze/.test(req.url)) {
          try { console.log('<< analyze skillChanges =', JSON.stringify(JSON.parse(buf.toString()).skillChanges)); } catch {}
        }
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json', 'access-control-allow-origin': '*' });
        res.end(buf);
      })().catch((e) => { res.writeHead(502); res.end(String(e)); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

async function main() {
  const fixtures = await serveFixtures();
  const proxy = await logProxy(SERVER);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-spec-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: findChromium(), headless: true, viewport: { width: 1280, height: 950 },
    args: ['--no-sandbox', `--disable-extensions-except=${process.cwd()}`, `--load-extension=${process.cwd()}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);
    await useServer(context, proxy.base);
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    const card = page.locator('#jobhelper-card-host .card');
    await page.locator('#jobhelper-card-host .card:not(.loading)').waitFor({ timeout: 60_000 });
    await card.locator('.change').first().waitFor({ timeout: 60_000 });

    // Mirror the e2e walk: undo-all, then match again, then the skills undo.
    await card.locator('.diff-head button.undo-all').click();
    await card.locator('.no-change').waitFor({ timeout: 60_000 });
    await card.locator('button.mode', { hasText: 'Match by keyword' }).click();
    await card.locator('.change').first().waitFor({ timeout: 60_000 });

    const row = card.locator('.change').filter({ hasText: /dropped/ }).first();
    console.log('row where =', await row.locator('.where').innerText());
    console.log('undo buttons on that row =', await row.locator('button.undo-one').count());
    await row.locator('button.undo-one').click();
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    console.log('--- undone; now building ---');
    await card.getByRole('button', { name: /^(Build resume|Recompile)$/ }).click();
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(6000);
  } finally { await useServer(context, SERVER).catch(() => {}); proxy.close(); await context.close(); process.exit(0); }
}
main();
