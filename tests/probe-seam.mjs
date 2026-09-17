/**
 * Seam probe: drives the extension through the whole journey against the live
 * ResumeM-M server and inspects the *result*, not just the status codes.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELIOS_ROLE, HELIOS_FORM, cleanStore, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const log = (...a) => console.log(...a);

function cardOf(page) {
  return page.locator('#jobhelper-card-host .card');
}

async function main() {
  const fixtures = await serveFixtures([HELIOS_ROLE, HELIOS_FORM]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await page.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await page.waitForFunction(
      () => !document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card.loading'),
      null,
      { timeout: 30_000 },
    );
    // Walk to the form, which is where the questions are.
    await page.click('a[href*="/helios/apply/"]');
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await page.waitForTimeout(4000);

    const card = cardOf(page);
    log('\n== card on the form ==');
    log('role :', await card.locator('.role').textContent());
    log('AI   :', await card.locator('.ai').textContent().catch(() => '(none)'));

    /* --- 1. Draft an answer with the AI switched off --- */
    log('\n== [1] "Draft an answer" with AI off ==');
    const qs = card.locator('.q');
    const n = await qs.count();
    log('questions on the card:', n);
    const target = qs.first();
    log('question:', (await target.locator('.qt').innerText()).slice(0, 70));
    const draftBtn = target.getByRole('button', { name: /Draft an answer|Rewrite for this role/ });
    await draftBtn.click();
    await page.waitForTimeout(6000);
    const answer = await target.locator('textarea').inputValue();
    log('answer length:', answer.length);
    log('answer starts:', JSON.stringify(answer.slice(0, 160)));
    log('LOOKS LIKE A PROMPT:', /You are helping with a resume|Follow these rules exactly|## How this person writes/.test(answer));
    const errShown = await card.locator('.err').count();
    log('error box shown:', errShown);

    /* --- 2. autofill wording --- */
    log('\n== [2] autofill report wording ==');
    await card.getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForTimeout(3000);
    log('card says   :', await card.locator('.ok-note').innerText().catch(() => '(none)'));
    const fieldState = await page.evaluate(() => ({
      first: document.querySelector('#fn')?.value,
      email: document.querySelector('#em')?.value,
      sponsorship: document.querySelector('#q2') ? document.querySelector('#q2').value : '(n/a)',
    }));
    log('form fields :', JSON.stringify(fieldState));

    /* --- 3. build + bundle, then look at the tracker and out/current --- */
    log('\n== [3] build resume, bundle ==');
    await card.getByRole('button', { name: 'Build resume' }).click();
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
    log('fit:', await card.locator('.fit.ok, .fit.bad').innerText());

    const before = await (await fetch(`${SERVER}/api/applications`)).json();
    log('tracker rows before bundle:', before.applications.filter((a) => a.company === 'Helios').length);

    await card.getByRole('button', { name: 'Save application folder' }).click();
    await card.locator('.done-box').waitFor({ timeout: 120_000 });
    log('done box:\n' + (await card.locator('.done-box').innerText()));

    const after = await (await fetch(`${SERVER}/api/applications`)).json();
    const app = after.applications.find((a) => a.company === 'Helios');
    log('tracked:', JSON.stringify({ id: app?.id, status: app?.status, appliedAt: app?.appliedAt, resumeId: app?.resumeId, answers: app?.answers?.length, history: app?.history?.map((h) => h.status) }));
    log('current folder:', JSON.stringify(after.current));

    /* --- 4. "Mark as submitted" --- */
    log('\n== [4] Mark as submitted ==');
    await card.getByRole('button', { name: 'Mark as submitted' }).click();
    await page.waitForTimeout(3000);
    const after2 = await (await fetch(`${SERVER}/api/applications`)).json();
    const app2 = after2.applications.find((a) => a.company === 'Helios');
    log('after mark:', JSON.stringify({ status: app2?.status, history: app2?.history?.map((h) => `${h.status}:${h.note}`) }));
    log('current after mark:', JSON.stringify(after2.current));

    log('\npage errors:', errors.join(' | ') || 'none');
    await page.close();
  } finally {
    log('\n== cleanup ==');
    await cleanStore(SERVER, ['Helios']).catch((e) => log('cleanup failed', e.message));
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
