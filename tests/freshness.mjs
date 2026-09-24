/**
 * Changing the resume in ResumeM-M, and coming back to a card that knows.
 *
 * The card builds a resume and keeps it — the copy, and the PDF compiled from
 * it — for as long as the posting is open, while everything that PDF prints
 * lives in the store. Edited there in a tab of its own, and the card went on
 * showing and attaching the version from before; only a trip through its own
 * "Edit in ResumeM-M" button was ever noticed. This changes the store behind
 * the card's back three ways and brings the tab back into view each time.
 *
 *   RMM_SERVER=http://127.0.0.1:4600 node tests/freshness.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanStore, findChromium, serveFixtures, requireOpenSave, pointExtensionAt } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const COMPANY = 'Quillon Systems';
const HOST = '#jobhelper-card-host';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const POSTING = {
  name: 'freshness-posting',
  path: '/careers/quillon/platform-engineer',
  company: COMPANY,
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Platform Engineer — ${COMPANY}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Platform Engineer",
"hiringOrganization":{"@type":"Organization","name":"${COMPANY}"},
"description":"<p>Build streaming infrastructure in Go and Python on Kubernetes. Distributed systems, Kafka, AWS. BS in Computer Science.</p>"}</script>
</head><body><h1>Platform Engineer</h1><p>${COMPANY} is hiring a Platform Engineer to build streaming infrastructure in Go and
Python on Kubernetes. Responsibilities include distributed systems and Kafka. Minimum qualifications: BS in Computer Science.</p>
<a href="/careers/quillon/platform-engineer/apply">Apply</a></body></html>`,
};

const api = (p, init) => fetch(`${SERVER}/api${p}`, init).then((r) => r.json());
const put = (p, body) =>
  api(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The copy this suite's posting was filed with, once it has been. */
async function theCopy(within = 30_000) {
  const until = Date.now() + within;
  for (;;) {
    const list = await api('/resumes');
    const found = (list.resumes ?? list).find((r) => /quillon/i.test(`${r.id} ${r.label ?? ''}`));
    if (found || Date.now() > until) return found ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  await requireOpenSave(SERVER);
  await cleanStore(SERVER, [COMPANY]).catch(() => undefined);
  const fixtures = await serveFixtures([POSTING]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-fresh-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  let profile = null;
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(POSTING), { waitUntil: 'domcontentloaded' });
    const card = page.locator(`${HOST} .card`);
    await card.locator('.role').waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Build resume' }).click({ timeout: 60_000 });
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
    const copy = await theCopy();
    check('building files a copy of its own in the store', Boolean(copy), copy?.id ?? '(none)');
    if (!copy) return;
    // Long enough for the card to note the store's copy, and past the
    // copy's own clock for the base check below.
    await page.waitForTimeout(2500);

    /** The tab coming back into view, as switching back to it does. */
    const backInView = async () => {
      await page.waitForTimeout(3200);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    };
    const says = (re, timeout = 30_000) =>
      page
        .waitForFunction((src) => new RegExp(src, 'i').test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''), re.source, { timeout, polling: 200 })
        .then(() => true)
        .catch(() => false);

    group('The copy itself, edited in ResumeM-M');
    {
      await put(`/resumes/${encodeURIComponent(copy.id)}`, { ...copy, label: `${copy.label} (edited)` });
      await backInView();
      check('the card takes the copy as it was left there, and says so', await says(/this copy was edited there/));
    }

    group('What the resume prints, changed in ResumeM-M');
    {
      const store = await api('/store');
      profile = store.profile;
      await put('/profile', { ...profile, phone: '555-0199' });
      await backInView();
      check('the card compiles it again, and says why', await says(/what the resume says changed there/));
    }

    group('The resume the copy was made from, changed in ResumeM-M');
    {
      const base = (await api('/resumes')).resumes?.find?.((r) => r.id === copy.copiedFrom) ??
        (await api('/resumes')).find?.((r) => r.id === copy.copiedFrom);
      check('the copy says which resume it was made from', Boolean(base), copy.copiedFrom ?? '(none)');
      if (base) {
        await put(`/resumes/${encodeURIComponent(base.id)}`, base);
        await backInView();
        check('the card says the copy is behind it', await says(/changed in ResumeM-M after this copy was made/));
        check(
          'and offers to build it again, rather than doing it',
          (await card.getByRole('button', { name: 'Build it again from there' }).count()) === 1,
        );
      }
    }
  } finally {
    if (profile) await put('/profile', profile).catch(() => undefined);
    await cleanStore(SERVER, [COMPANY]).catch(() => undefined);
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
