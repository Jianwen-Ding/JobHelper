/** Ad-hoc probe: the cover-letter step when only a frame asked for one. */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMED_ROLE, STREAMLY, cleanStore, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const say = (l, v) => console.log(`  ${l}: ${JSON.stringify(v)}`);

const letterState = () =>
  ((card) => ({
    steps: [...card.querySelectorAll('.step-head .t')].map((n) => n.textContent),
    // The letter step's own editor, which only exists once a draft started.
    letterBox: Boolean(card.querySelector('textarea.tall')),
    drawn: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
  }))(document.querySelector('#jobhelper-card-host').shadowRoot.querySelector('.card'));

async function main() {
  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe2-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

    console.log('\nA. The letter box is asked for by the page itself (Streamly)');
    const a = await context.newPage();
    await a.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'load' });
    await a.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });
    await a.waitForTimeout(9000);
    say('card', await a.evaluate(letterState));
    await a.close();

    console.log('\nB. The letter box is only inside the frame (iCIMS shape)');
    const b = await context.newPage();
    await b.goto(fixtures.urlFor(FRAMED_ROLE), { waitUntil: 'load' });
    await b.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });
    await b.waitForTimeout(9000);
    say('card', await b.evaluate(letterState));
    await b.close();
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Streamly', 'Orion']);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
