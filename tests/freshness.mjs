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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanStore, findChromium, serveFixtures, requireOpenSave, pointExtensionAt } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const COMPANY = 'Tamsin Freshworks';
const HOST = '#jobhelper-card-host';
/** The variation this suite saves while the card is open, and takes away after. */
const ADDED = 'freshness-added-variation';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const POSTING = {
  name: 'freshness-posting',
  path: '/careers/tamsin/platform-engineer',
  company: COMPANY,
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Platform Engineer — ${COMPANY}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Platform Engineer",
"hiringOrganization":{"@type":"Organization","name":"${COMPANY}"},
"description":"<p>Build streaming infrastructure in Go and Python on Kubernetes. Distributed systems, Kafka, AWS. BS in Computer Science.</p>"}</script>
</head><body><h1>Platform Engineer</h1><p>${COMPANY} is hiring a Platform Engineer to build streaming infrastructure in Go and
Python on Kubernetes. Responsibilities include distributed systems and Kafka. Minimum qualifications: BS in Computer Science.</p>
<a href="/careers/tamsin/platform-engineer/apply">Apply</a></body></html>`,
};

/** Two questions no other suite asks, so the bank holds nothing for either until this saves it. */
const ASKED = 'Describe a streaming pipeline you have kept running in production.';
const TYPED = 'Which technical decision of yours would you now make differently?';
const FORM = {
  name: 'freshness-form',
  path: '/careers/tamsin/stream-engineer',
  company: COMPANY,
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Stream Engineer — ${COMPANY}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Stream Engineer",
"hiringOrganization":{"@type":"Organization","name":"${COMPANY}"},
"description":"<p>Run streaming pipelines in Go on Kubernetes. Kafka, AWS.</p>"}</script>
</head><body><h1>Stream Engineer</h1><p>${COMPANY} is hiring a Stream Engineer to run streaming pipelines in Go on Kubernetes.</p>
<h2>Apply for this job</h2><form>
<label for="fn">First Name</label><input id="fn" name="first_name">
<label for="em">Email</label><input id="em" name="email" type="email">
<label for="q1">${ASKED}</label><textarea id="q1" name="q1"></textarea>
<label for="q2">${TYPED}</label><textarea id="q2" name="q2"></textarea>
</form></body></html>`,
};

/** A third posting, for a card of its own that the AI tailors. */
const AI_POSTING = {
  name: 'freshness-ai-posting',
  path: '/careers/tamsin/streaming-engineer',
  company: COMPANY,
  html: `<!doctype html><html><head><meta charset="utf-8"><title>Streaming Engineer — ${COMPANY}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"Streaming Engineer",
"hiringOrganization":{"@type":"Organization","name":"${COMPANY}"},
"description":"<p>Keep Kafka streaming pipelines running in Go and Python on Kubernetes and AWS.</p>"}</script>
</head><body><h1>Streaming Engineer</h1><p>${COMPANY} is hiring a Streaming Engineer to keep Kafka pipelines running in Go
and Python on Kubernetes and AWS. BS in Computer Science.</p></body></html>`,
};

const api = (p, init) => fetch(`${SERVER}/api${p}`, init).then((r) => r.json());
const put = (p, body) =>
  api(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** This suite's two questions, taken out of the answer bank. */
async function takeOutOfBank() {
  const bank = (await api('/store')).answers ?? [];
  const kept = bank.filter((a) => a.question !== ASKED && a.question !== TYPED);
  if (kept.length !== bank.length) await put('/answers', kept);
}

/** The copy this suite's posting was filed with, once it has been. */
async function theCopy(within = 30_000) {
  const until = Date.now() + within;
  for (;;) {
    const list = await api('/resumes');
    const found = (list.resumes ?? list).find((r) => /tamsin/i.test(`${r.id} ${r.label ?? ''}`));
    if (found || Date.now() > until) return found ?? null;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * A fingerprint of the resume in the upload folder for this suite's
 * application — the file Attach files would put in the form — or null.
 */
async function folderResume() {
  const apps = await api('/applications');
  const app = (apps.applications ?? apps).find((a) => /tamsin/i.test(a.company ?? ''));
  if (!app) return null;
  const list = await api(`/attachments?application=${encodeURIComponent(app.id)}`);
  const resume = (list.attachments ?? []).find((a) => !a.standing && /resume/i.test(a.name));
  if (!resume) return null;
  const bytes = Buffer.from(await (await fetch(`${SERVER}${resume.url}`)).arrayBuffer());
  return createHash('sha1').update(bytes).digest('hex');
}

async function main() {
  await requireOpenSave(SERVER);
  await cleanStore(SERVER, [COMPANY]).catch(() => undefined);
  const fixtures = await serveFixtures([POSTING, FORM, AI_POSTING]);
  await takeOutOfBank();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-fresh-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  let profile = null;
  /** The store's AI settings before this suite switched its stand-in on. */
  let configWas = null;
  const aiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-fresh-ai-'));
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
      // Settled first: the copy taken just above re-stages on its own, and a
      // folder still changing from that is not this change reaching it.
      let before = await folderResume();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(3000);
        const now = await folderResume();
        if (now === before) break;
        before = now;
      }
      await put('/profile', { ...profile, phone: '555-0199' });
      await backInView();
      check('the card compiles it again, and says why', await says(/what the resume says changed there/));
      /*
       * And the upload folder follows it. The preview is not what goes to
       * the employer: Attach files and the drag chips hand over the resume
       * staged in the folder, and that was left as it was — the old phone
       * number, the very file staged before the change.
       */
      let after = before;
      for (const until = Date.now() + 60_000; Date.now() < until && after === before; ) {
        await page.waitForTimeout(1000);
        after = await folderResume();
      }
      check(
        'and the resume in the upload folder is built again with it',
        Boolean(before) && Boolean(after) && after !== before,
        `${before?.slice(0, 8) ?? '(none)'} → ${after?.slice(0, 8) ?? '(none)'}`,
      );
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

        /*
         * Pressed, it builds the copy "the same way as before" — and before,
         * on this card, was the keyword list. The list is what the card is
         * for; a rebuild that comes back without it has built a different
         * thing from the one it said it would.
         */
        const offered = async () => {
          const said = (await card.locator('.diff-head .count').first().textContent({ timeout: 5_000 }).catch(() => '')) ?? '';
          return Number(said.match(/(\d+) changes?$/)?.[1] ?? 0);
        };
        const listBefore = await offered();
        await card.getByRole('button', { name: 'Build it again from there' }).click();
        // The old build's badge goes when the new proposal lands, and the
        // new one's arrives with its compile.
        await card.locator('.fit.ok, .fit.bad').waitFor({ state: 'detached', timeout: 30_000 }).catch(() => undefined);
        await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
        const listAfter = await offered();
        check(
          'and building it again keeps the keyword suggestions it was showing',
          listBefore > 0 && listAfter === listBefore,
          `${listBefore} before, ${listAfter} after`,
        );

        /*
         * And the next change to that resume is news too. Building again
         * brings the copy up to date with the base as it was then; it is not
         * a promise never to hear about the base again.
         */
        await page.waitForTimeout(2500);
        const baseNow = (await api('/resumes')).resumes?.find?.((r) => r.id === base.id) ??
          (await api('/resumes')).find?.((r) => r.id === base.id);
        await put(`/resumes/${encodeURIComponent(base.id)}`, baseNow ?? base);
        await backInView();
        check(
          'and a later change to it is said again',
          await says(/changed in ResumeM-M after this copy was made/, 15_000),
        );
      }
    }

    /*
     * And without leaving the tab at all. Reported: "when you add a variation
     * in ResumeM-M it should automatically reflect in JobHelper" — the card's
     * picker was filled once, when the card went up, so a variation saved in
     * the editor was not there until it was put up again. Nothing here brings
     * the tab back into view; the card has to notice on its own.
     */
    group('A change in ResumeM-M while the card is open, with no trip away from it');
    {
      const base = (await api('/resumes')).find?.((r) => r.id === copy.copiedFrom) ??
        (await api('/resumes')).resumes?.find?.((r) => r.id === copy.copiedFrom);
      await fetch(`${SERVER}/api/resumes/${ADDED}?create=1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...base, id: ADDED, label: 'Freshly added variation', tier: 'extended', copiedFrom: base.id }),
      });
      const listed = await page
        .waitForFunction(
          () => [...(document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelectorAll('select[title="Which resume to start from"] option') ?? [])]
            .some((o) => o.textContent.includes('Freshly added variation')),
          undefined,
          { timeout: 20_000, polling: 250 },
        )
        .then(() => true)
        .catch(() => false);
      check('a variation saved there appears in the card\'s picker on its own', listed);

      await put('/profile', { ...profile, phone: '555-0142' });
      check('and a change to what the resume prints is compiled again on its own', await says(/what the resume says changed there/, 20_000));
    }

    /*
     * And the answers. A form's questions are matched against the bank once,
     * when the card reads them, so an answer written in ResumeM-M's Letters &
     * Answers while the form was open never reached its empty box. Written
     * there for both questions, after one has been typed into by hand: the
     * untouched one takes it, and what was typed stays.
     */
    group('An answer written in ResumeM-M while a form is open');
    {
      const form = await context.newPage();
      await form.goto(fixtures.urlFor(FORM), { waitUntil: 'domcontentloaded' });
      const box = (question) =>
        form.locator(`${HOST} .q`, { has: form.locator('.qt', { hasText: question }) }).locator('textarea');
      await box(ASKED).waitFor({ timeout: 30_000 }).catch(() => undefined);
      check('the card lists the form\'s question with nothing in it yet', (await box(ASKED).inputValue().catch(() => '(not listed)')) === '');
      await box(TYPED).fill('Typed on the card, by hand.');
      const WRITTEN = 'Kept a Kafka-to-S3 pipeline under a minute of lag through two region moves.';
      for (const [question, answer] of [[ASKED, WRITTEN], [TYPED, 'Written in ResumeM-M instead.']]) {
        await fetch(`${SERVER}/api/answers/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, answer, label: 'Saved' }),
        });
      }
      const arrived = await form
        .waitForFunction(
          ([host, question, text]) =>
            [...(document.querySelector(host)?.shadowRoot?.querySelectorAll('.q') ?? [])]
              .find((q) => q.querySelector('.qt')?.textContent.includes(question))
              ?.querySelector('textarea')?.value === text,
          [HOST, ASKED, WRITTEN],
          { timeout: 20_000, polling: 250 },
        )
        .then(() => true)
        .catch(() => false);
      check('an empty question takes the answer on its own', arrived, await box(ASKED).inputValue().catch(() => '(not listed)'));
      check(
        'and one already typed into keeps what was typed',
        (await box(TYPED).inputValue().catch(() => '')) === 'Typed on the card, by hand.',
        await box(TYPED).inputValue().catch(() => '(not listed)'),
      );
      await form.close();
    }

    /*
     * And the base edited while the AI was reading the posting. A run takes
     * minutes, and the copy it made was dated when it finished — so an edit
     * made during it looked older than the copy, and the card said nothing,
     * although the copy was made from the base as it was before. On a card of
     * its own: the first one has been told about this base already.
     *
     * The AI is a stand-in: a local script that says when it has started —
     * by then the store has read the base — takes a few seconds, and answers
     * with a plan that changes nothing. Nothing leaves this machine.
     */
    group('The resume the copy was made from, changed while the AI was reading the posting');
    {
      const started = path.join(aiDir, 'started');
      const fake = path.join(aiDir, 'slow-ai.cjs');
      fs.writeFileSync(
        fake,
        [
          '#!/usr/bin/env node',
          `require('node:fs').writeFileSync(${JSON.stringify(started)}, String(Date.now()));`,
          "setTimeout(() => process.stdout.write(JSON.stringify({ choices: {}, reasoning: 'Took its time.' })), 6000);",
          '',
        ].join('\n'),
      );
      fs.chmodSync(fake, 0o755);
      configWas = await api('/config');
      await put('/config', { ai: { ...configWas.ai, enabled: true, command: fake, args: ['{promptText}'], timeoutMs: 60_000 } });
      // And the extension's own switch, the other half of the card's AI being on.
      const settings = await context.newPage();
      await settings.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
      await settings.evaluate(() => chrome.storage.sync.set({ useAi: true }));
      await settings.close();

      const tab = await context.newPage();
      await tab.goto(fixtures.urlFor(AI_POSTING), { waitUntil: 'domcontentloaded' });
      const aiCard = tab.locator(`${HOST} .card`);
      await aiCard.locator('.role').waitFor({ timeout: 30_000 });
      const aiButton = aiCard.locator('button.mode', { hasText: 'Have AI Tailor' });
      for (const until = Date.now() + 30_000; Date.now() < until; await tab.waitForTimeout(250)) {
        if (await aiButton.isEnabled().catch(() => false)) break;
      }
      await aiButton.click();
      for (const until = Date.now() + 30_000; !fs.existsSync(started) && Date.now() < until; ) await tab.waitForTimeout(100);
      const ran = fs.existsSync(started);
      // Past the store's second of slack, and well before the run ends.
      await tab.waitForTimeout(2500);
      const list = await api('/resumes');
      const base = (list.resumes ?? list).find((r) => r.id === copy.copiedFrom);
      await put(`/resumes/${encodeURIComponent(base.id)}`, base);
      await aiCard.locator('button.mode.on', { hasText: 'AI tailoring' }).waitFor({ timeout: 60_000 }).catch(() => undefined);
      const landed = (await aiCard.locator('button.mode.on', { hasText: 'AI tailoring' }).count()) === 1;
      await aiCard.getByRole('button', { name: 'Build resume' }).click({ timeout: 60_000 });
      await aiCard.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
      await tab.waitForTimeout(3200);
      await tab.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const said = await tab
        .waitForFunction(
          () => /changed in ResumeM-M after this copy was made/.test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''),
          undefined,
          { timeout: 15_000, polling: 200 },
        )
        .then(() => true)
        .catch(() => false);
      check(
        'an edit made to it while the AI read the posting is said once the AI\'s copy is built',
        ran && landed && said,
        JSON.stringify({ ran, landed, said, base: base?.id }),
      );
      await tab.close();
    }
  } finally {
    if (configWas) await put('/config', { ai: configWas.ai }).catch(() => undefined);
    fs.rmSync(aiDir, { recursive: true, force: true });
    await takeOutOfBank().catch(() => undefined);
    await fetch(`${SERVER}/api/resumes/${ADDED}`, { method: 'DELETE' }).catch(() => undefined);
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
