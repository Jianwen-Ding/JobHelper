/**
 * The service worker, against a store that misbehaves on purpose.
 *
 * Everything the card shows about the store comes through here, and the
 * failures worth catching are the ones where the sentence is wrong rather
 * than absent: a stop reported as the store talking nonsense, a hang with no
 * deadline, an application filed into the wrong save with a 200 back. None of
 * those can be reached against a healthy server, so the store is a fake whose
 * behaviour per route is switchable at run time.
 *
 * The extension is loaded unpacked and driven through its own message router,
 * which is the interface the card actually uses.
 *
 *   node tests/worker.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { OPEN_SHADOW_FLAG, findChromium } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
  }
};
const group = (name) => console.log(`\n${name}`);

/**
 * A store that answers like ResumeM-M, and can be told to answer badly.
 *
 * `routes[path]` picks the behaviour: `silent` accepts the socket and never
 * writes, `stall-body` sends the status line and half the JSON and then stops.
 * Those two are the shapes a wedged server actually takes, and the second is
 * the one the worker used to get wrong — a reply is "received" the moment its
 * status line arrives, so both the Stop button and the ceiling fire *after*
 * the request looked successful.
 */
function fakeStore() {
  const state = { save: 'work', routes: {}, hits: [], open: [], strict: true, role: 'Platform Engineer' };
  const readBody = (req) =>
    new Promise((done) => {
      const parts = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => done(Buffer.concat(parts).toString()));
    });

  const server = http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const raw = await readBody(req);
    // The query as well: `/api/autofill` carries the resume's choices in it.
    const query = new URLSearchParams(req.url.split('?')[1] ?? '');
    state.hits.push({
      url,
      query,
      method: req.method,
      project: req.headers['x-rmm-project'] ?? null,
      // Whether the pairing header was there at all, empty or not: see "The pairing header".
      pair: 'x-rmm-pair' in req.headers ? req.headers['x-rmm-pair'] : null,
      body: raw,
    });

    const mode = state.routes[url] ?? 'ok';
    if (mode === 'silent') {
      state.open.push(res);
      return;
    }
    /*
     * The store looking at a company and a role and saying that is not a job.
     * Named, because the extension treats a refusal differently from a store
     * that is not running: see `holdASpace`.
     */
    if (mode === 'not-a-job') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'not-a-job', error: 'does not read like a job, so no space was opened for it.' }));
      return;
    }
    // A store that is up and failing, which reads to the card as one that is down.
    if (mode === 'broken') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'broken on purpose' }));
      return;
    }
    if (mode === 'stall-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"isJobPosting":true,');
      state.open.push(res);
      return;
    }

    /*
     * The store refusing this extension until it pairs, as ResumeM-M's guard
     * does: every route but the pairing one, and /health saying so. See
     * "Pairing from a card, one exchange for every tab".
     */
    if (state.pairing) {
      const token = req.headers['x-rmm-pair'];
      const paired = Boolean(state.pairing.token) && token === state.pairing.token;
      if (url === '/api/extension/pair') {
        state.pairing.exchanges += 1;
        await new Promise((r) => setTimeout(r, state.pairing.delay ?? 0));
        const code = String(JSON.parse(raw || '{}').code ?? '').toUpperCase().replace(/[\s-]/g, '');
        res.writeHead(code === state.pairing.code ? 200 : 400, { 'content-type': 'application/json' });
        if (code !== state.pairing.code) {
          res.end(JSON.stringify({ kind: 'bad-code', triesLeft: 4, error: 'That is not the code ResumeM-M is showing. 4 tries left.' }));
          return;
        }
        state.pairing.code = null;
        state.pairing.token = `token-${'x'.repeat(40)}`;
        res.end(JSON.stringify({ ok: true, token: state.pairing.token, origin: req.headers.origin ?? null }));
        return;
      }
      if (!paired && url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'resumem-m', projectOpen: true, paired: false }));
        return;
      }
      if (!paired && url.startsWith('/api')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kind: 'not-paired', error: 'This browser extension is not paired with ResumeM-M.' }));
        return;
      }
    }

    // The store's own guard, as `src/server/index.ts` writes it.
    if (state.strict && url.startsWith('/api')) {
      const meant = req.headers['x-rmm-project'];
      if (typeof meant === 'string' && meant && meant !== state.save) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ kind: 'other-save', save: state.save, error: 'written against another save' }));
        return;
      }
    }

    const send = (obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (url === '/health') {
      return send({ ok: true, projectOpen: true, project: state.save, ai: { enabled: true, configured: true, command: 'fake' } });
    }
    if (url === '/api/extension/analyze') {
      let page = {};
      try {
        page = JSON.parse(raw);
      } catch {
        /* the body is only used for the company name */
      }
      const reply = () =>
        send({
          isJobPosting: true,
          kind: 'posting',
          save: state.save,
          // `company` set on the state is a page the analysis could not name.
          job: {
            company: state.company ?? page.company ?? 'Helios',
            title: state.role,
            // The requisition the store cut off the title, when the test says there is one.
            ...(state.requisition ? { requisition: state.requisition } : {}),
            description: 'A job.',
            keywords: [],
          },
          // Built from the base that was asked for, and said to be, as the
          // store does — so a proposal can be told apart by where it came from.
          spec: { id: 'job-fake', tier: 'temporary', copiedFrom: page.baseResumeId ?? 'newgrad' },
          baseResumeId: page.baseResumeId ?? 'newgrad',
          // An AI pass comes back as a decision; see `isDecision` in card.js.
          ...(page.tailor === 'ai' ? { tailor: 'ai', aiUsed: true } : {}),
        });
      // An AI pass held open until the test lets it answer, which is the
      // minutes a real one takes.
      if (page.tailor === 'ai' && state.heldAi) {
        state.heldAi.push(reply);
        return;
      }
      return reply();
    }
    /*
     * The answer bank's matcher, whose grading is the whole point of the
     * route. `matchAnswer` scores every question in the bank and marks the
     * near-identical ones `confident`; a loose match is something for
     * somebody to read, not something to tick a radio button with. The fake
     * returns one of each so the worker's filtering has something to do.
     */
    if (url === '/api/answers/match') {
      let asked = [];
      try {
        asked = JSON.parse(raw).questions ?? [];
      } catch {
        /* the body is only read for the questions */
      }
      return send({
        bankSize: 4,
        matches: asked.map((question) => ({
          question,
          score: 0.9,
          confident: !/loosely/i.test(question),
          answer: /nothing in the bank/i.test(question) ? undefined : `answer to ${question}`,
        })),
      });
    }
    // A stage refused as (maybe) sent, when the test says so: ResumeM-M's 409.
    if (url === '/api/applications/bundle' && state.refuseStage) {
      const body = JSON.parse(raw || '{}');
      if (!body.evenIfSent) return send(state.refuseStage, 409);
    }
    if (url === '/api/applications/bundle') return send({ ok: true, id: 'app-1', folder: '/tmp/x' });
    // The writes the card makes outside filing: the answer bank, a letter, a
    // tracker row's status, a kept phrasing, the AI switch.
    // The store's letter id, only when the test has said what it is: a store
    // from before the route answers 404, and the worker works it out itself.
    if (url === '/api/letters/id' && state.letterId) {
      return send({ id: state.letterId, ...(state.letterFor ? { applicationId: state.letterFor } : {}) });
    }
    // A store from before that route: 404 for it, and a list of its letters.
    if (url === '/api/letters/id' && state.oldLetters) return send({ error: 'no route' }, 404);
    if (url === '/api/letters' && req.method === 'GET') return send(state.oldLetters ?? []);
    if (
      url === '/api/answers/save' ||
      url === '/api/config' ||
      /^\/api\/letters\/[^/]+$/.test(url) ||
      /^\/api\/applications\/[^/]+\/status$/.test(url) ||
      /^\/api\/entries\/[^/]+\/bullets\/[^/]+\/variants$/.test(url)
    ) {
      return send({ ok: true });
    }
    if (url === '/api/workspace') return send({ ok: true, id: 'ws-1', url: '/workspace/ws-1' });
    // A bare list, which is what ResumeM-M's `/api/resumes` answers and what
    // the card's picker reads.
    if (url === '/api/resumes') {
      return send([
        { id: 'newgrad', label: 'New grad', base: true },
        { id: 'intern', label: 'Summer intern', base: true },
      ]);
    }
    return send({ error: `no route ${url}` }, 404);
  });

  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      state.sentTo = (p) => state.hits.filter((h) => h.url === p);
      state.close = () => {
        for (const r of state.open) {
          try {
            r.destroy();
          } catch {
            /* already gone */
          }
        }
        server.close();
      };
      ready(state);
    });
  });
}

/** The pairing token the extension keeps for a store, read from one of its pages. */
const pairingTokenIn = (page, base) =>
  page.evaluate(async (s) => (await chrome.storage.local.get('rmmPairing')).rmmPairing?.[new URL(s).origin] ?? null, base);

/** One message to the worker, from a page inside the extension. */
const ask = (page, type, payload = {}) =>
  page.evaluate(
    ([t, p]) =>
      new Promise((done) => {
        const began = Date.now();
        chrome.runtime.sendMessage({ type: t, payload: p }, (reply) =>
          done({ reply, ms: Date.now() - began, lastError: chrome.runtime.lastError?.message ?? null }),
        );
      }),
    [type, payload],
  );

async function main() {
  const store = await fakeStore();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-worker-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1200, height: 800 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
    /*
     * West of Greenwich, whatever the machine running this is set to, so an
     * evening is a day behind UTC — which is where a letter id built from the
     * UTC date stops agreeing with the store's. See "The letter's id".
     */
    env: { ...process.env, TZ: 'America/Los_Angeles' },
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    for (let i = 0; i < 100; i++) {
      const ready = await worker.evaluate(() => Boolean(globalThis.chrome?.tabs?.query)).catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const extensionId = new URL(worker.url()).host;
    const driver = await context.newPage();
    await driver.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await driver.evaluate((s) => chrome.storage.sync.set({ serverUrl: s, autoPrompt: false }), store.base);
    // The card left open for reading here; see `openCardForTests`.
    await driver.evaluate((key) => chrome.storage.local.set({ [key]: true }), OPEN_SHADOW_FLAG);

    const lastSaveFor = (p) => store.sentTo(p).slice(-1)[0]?.project ?? '(none)';

    /* ---------------------------------------------------------------- *
     * Which save an application is filed into                           *
     * ---------------------------------------------------------------- */

    /*
     * The save each proposal came from travels with the writes that follow
     * it, and it lived in two places: a map on the worker and the trail in
     * session storage. The note on `saveOf` says "the map is the fast path
     * and the trail is the true one", and `saveFor` read them the other way
     * round — so nothing ever invalidated the map.
     *
     * Read a posting with one save open, switch save in the editor, read a
     * different posting in the same tab — a fresh application by the
     * extension's own rules — and the second was filed into the first's save,
     * with the header saying so and the store's guard therefore unable to
     * help. It disappears when the worker is stopped, so the same sequence
     * behaves correctly after half a minute of idling and wrongly when it
     * does not.
     */
    group('Which save an application is filed into');
    {
      store.save = 'work';
      await ask(driver, 'analyze', { url: 'http://a.example/jobs/1', title: 'Helios', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'bundle', { company: 'Helios' });
      check('the first application goes to the save it was built in', lastSaveFor('/api/applications/bundle') === 'work', lastSaveFor('/api/applications/bundle'));

      // The editor is pointed elsewhere, and a different job is read.
      store.save = 'personal';
      await ask(driver, 'analyze', { url: 'http://b.example/jobs/2', title: 'Vega', html: '<p>two</p>', company: 'Vega' });
      const bundled = await ask(driver, 'bundle', { company: 'Vega' });
      check(
        'and a new application in the same tab goes to the new one',
        lastSaveFor('/api/applications/bundle') === 'personal',
        lastSaveFor('/api/applications/bundle'),
      );
      check('so the store takes it rather than refusing it', bundled.reply?.ok === true, JSON.stringify(bundled.reply).slice(0, 120));
    }

    /*
     * A stage the store held because the application may already have gone
     * out (409 `already-sent` with `maybe`): handed to the card as that, with
     * which application, so it asks rather than marking anything sent; and
     * asked again with `evenIfSent`, it goes through. A plain `already-sent`
     * is still just that.
     */
    group('A stage held as maybe sent');
    {
      store.save = 'work';
      await ask(driver, 'analyze', { url: 'http://m.example/jobs/9', title: 'Stripe', html: '<p>nine</p>', company: 'Stripe' });
      const application = { id: 'stripe-1', url: 'https://www.linkedin.com/jobs/view/4462047454/', appliedAt: '2026-09-24T15:00:00.000Z', status: 'applied' };
      store.refuseStage = { kind: 'already-sent', maybe: true, error: 'You may have applied to this already', application: { ...application, company: 'Stripe' } };
      const held = await ask(driver, 'stage', { company: 'Stripe' });
      check(
        'is handed back as maybe sent, naming the application',
        held.reply?.data?.alreadySent === true && held.reply?.data?.maybe === true && held.reply?.data?.application?.id === 'stripe-1' &&
          held.reply?.data?.application?.url === application.url,
        JSON.stringify(held.reply).slice(0, 300),
      );
      const again = await ask(driver, 'stage', { company: 'Stripe', evenIfSent: true });
      check('and told it is another job, goes through', again.reply?.ok === true && !again.reply?.data?.alreadySent, JSON.stringify(again.reply).slice(0, 200));
      store.refuseStage = { kind: 'already-sent', error: 'already sent', application };
      const sure = await ask(driver, 'stage', { company: 'Stripe' });
      check('while a sure one is still only already sent', sure.reply?.data?.alreadySent === true && !sure.reply?.data?.maybe, JSON.stringify(sure.reply).slice(0, 200));
      store.refuseStage = undefined;
    }

    /*
     * "Start a new application here" removes the trail. The map was left
     * holding the save that application came from, and `saveFor` falls back
     * to the map when the trail has nothing — so the next application in the
     * tab inherited a binding from one the user had explicitly forgotten.
     */
    group('Starting fresh forgets the save too');
    {
      store.save = 'work';
      await ask(driver, 'analyze', { url: 'http://c.example/jobs/3', title: 'Helios', html: '<p>three</p>', company: 'Helios' });
      await ask(driver, 'clearTrail', {});

      store.save = 'personal';
      await ask(driver, 'analyze', { url: 'http://d.example/jobs/4', title: 'Vega', html: '<p>four</p>', company: 'Vega' });
      await ask(driver, 'bundle', { company: 'Vega' });
      check(
        'the application after a fresh start goes to the save open now',
        lastSaveFor('/api/applications/bundle') === 'personal',
        lastSaveFor('/api/applications/bundle'),
      );
    }

    /* ---------------------------------------------------------------- *
     * Every write says which save it means                              *
     * ---------------------------------------------------------------- */

    /*
     * Filing and `/extension/sent` sent the save header; the answer bank,
     * "Save to store", a tracker row's status, a kept phrasing and the AI
     * switch did not. The store only refuses a header it disagrees with, so
     * after the editor switched saves those writes went into the other save
     * with a 200 — an answer for a work application in the personal bank.
     */
    group('Every write says which save it means');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://saves.example/jobs/1', title: 'Helios', html: '<p>one</p>', company: 'Helios' });
      const writes = [
        ['rememberChoice', { question: 'Will you relocate?', answer: 'Yes' }, '/api/answers/save'],
        ['rememberTyped', { answers: [{ question: 'Notice period?', answer: 'Two weeks' }] }, '/api/answers/save'],
        ['saveAnswer', { question: 'Why us?', answer: 'Helios builds what I use.', label: 'Helios' }, '/api/answers/save'],
        ['saveLetter', { body: 'Dear Helios,', job: { company: 'Helios', title: 'Platform Engineer' } }, null],
        ['trackStatus', { id: 'app-1', status: 'withdrawn' }, '/api/applications/app-1/status'],
        ['addVariant', { entryId: 'e1', bulletId: 'b1', variant: { text: 'Built it.' } }, '/api/entries/e1/bullets/b1/variants'],
        ['setAiEnabled', { enabled: true }, '/api/config'],
      ];
      for (const [type, payload, route] of writes) {
        const before = store.hits.length;
        const r = await ask(driver, type, payload);
        const hit = store.hits.slice(before).find((h) => (route ? h.url === route : h.method === 'PUT' && h.url.startsWith('/api/letters/')));
        check(`${type} names the save it was built in`, hit?.project === 'work', `${hit ? (hit.project ?? 'no save header') : 'no request'} ${JSON.stringify(r.reply).slice(0, 80)}`);
      }

      // The editor is pointed at another save; the application is still work's.
      store.save = 'personal';
      const before = store.hits.length;
      const refused = await ask(driver, 'saveAnswer', { question: 'Why us?', answer: 'Helios again.', label: 'Helios' });
      const hit = store.hits.slice(before).find((h) => h.url === '/api/answers/save');
      check('after a switch, an answer is refused rather than put in the other save', hit?.project === 'work' && refused.reply?.ok !== true, JSON.stringify(refused.reply).slice(0, 160));

      // No save known at all: the write goes as it always did, unheadered.
      await ask(driver, 'clearTrail', {});
      const before2 = store.hits.length;
      const plain = await ask(driver, 'rememberChoice', { question: 'Will you relocate?', answer: 'Yes' });
      const hit2 = store.hits.slice(before2).find((h) => h.url === '/api/answers/save');
      check('with no save known, it is sent without one and taken', hit2 && hit2.project === null && plain.reply?.data?.ok === true, `${hit2?.project} ${JSON.stringify(plain.reply).slice(0, 120)}`);
    }

    /*
     * The letter's id, as a ResumeM-M too old to be asked makes it.
     *
     * The id was the employer cut at 30 and the role at 40, with "letter" for
     * a missing employer; the store files the same letter with both cut at
     * 30, the missing one left out. So the letter saved here and the one
     * filed with the application were two rows. And dated as that store
     * dates it, by the day in UTC: worked out here by the local day, in an
     * evening west of Greenwich it was another day from the letter it was
     * meant to find.
     */
    group('The letter’s id');
    {
      const sw = context.serviceWorkers()[0] ?? worker;
      // 19:00 on 1 March in Los Angeles, which is already 2 March in UTC.
      await sw.evaluate(() => {
        const Real = Date;
        const at = Real.parse('2026-03-02T03:00:00Z');
        globalThis.__jhRealDate = Real;
        globalThis.Date = class extends Real {
          constructor(...a) {
            super(...(a.length ? a : [at]));
          }
          static now() {
            return at;
          }
        };
      });
      const lettersSaved = async (job) => {
        const before = store.hits.length;
        await ask(driver, 'saveLetter', { body: 'Dear team,', job });
        const hit = store.hits.slice(before).find((h) => h.method === 'PUT' && h.url.startsWith('/api/letters/'));
        return hit ? decodeURIComponent(hit.url.slice('/api/letters/'.length)) : null;
      };
      try {
        const long = await lettersSaved({
          company: 'Acme Corporation International Holdings',
          title: 'Senior Staff Software Engineer, Machine Learning Platform',
        });
        check(
          'it is dated the UTC day that store files by, with employer and role each cut to 30',
          long === '2026-03-02-acme-corporation-international-senior-staff-software-engineer',
          String(long),
        );
        const noCompany = await lettersSaved({ title: 'Platform Engineer' });
        check('a missing employer is left out, not called "letter"', noCompany === '2026-03-02-platform-engineer', String(noCompany));
        /*
         * Employers named in other scripts. Slugged to ASCII they were all
         * the bare date, so a second letter that day replaced the first.
         * The server's rule, letter for letter: NFKC, lowercase, runs of
         * anything but a letter or a digit become "-", ends trimmed, each
         * part cut to 30.
         */
        const scripts = [];
        for (const company of ['株式会社ソニー', 'Яндекс', 'شركة أرامكو', 'אלביט מערכות', 'ＡＣＭＥ Ｇｍｂｈ']) {
          scripts.push(await lettersSaved({ company }));
        }
        check(
          'employers in any script keep their names in the id',
          JSON.stringify(scripts) ===
            JSON.stringify([
              '2026-03-02-株式会社ソニー',
              '2026-03-02-яндекс',
              '2026-03-02-شركة-أرامكو',
              '2026-03-02-אלביט-מערכות',
              '2026-03-02-acme-gmbh',
            ]),
          JSON.stringify(scripts),
        );
        check('so two of them on one day are two letters', new Set(scripts).size === scripts.length, JSON.stringify(scripts));
        // Those were a store too old to say; one that can is asked.
        store.letterId = '2026-03-01-helios-platform-engineer';
        const told = await lettersSaved({ company: 'Helios', title: 'Platform Engineer' });
        const asked = store.sentTo('/api/letters/id').at(-1);
        check('a store that names the id is asked, and its id is used', told === store.letterId, String(told));
        check(
          'asked with the employer and the role',
          asked?.query.get('company') === 'Helios' && asked?.query.get('role') === 'Platform Engineer',
          asked ? asked.query.toString() : 'not asked',
        );
        /*
         * By the name alone, the store answered with the name another
         * application's letter was filed under — a second job with the same
         * title on the same day — and this wrote over it. So it is asked
         * with the application the card has and the page's address, and the
         * application the store found goes with the save, for the store to
         * refuse a save that lands on another's letter.
         */
        store.letterId = '2026-03-01-helios-platform-engineer-2';
        store.letterFor = 'app-helios-2';
        const before = store.hits.length;
        await ask(driver, 'saveLetter', {
          body: 'Dear Helios,',
          applicationId: 'app-helios-2',
          job: { company: 'Helios', title: 'Platform Engineer', url: 'https://jobs.example.com/helios/2222' },
        });
        const which = store.sentTo('/api/letters/id').at(-1);
        check(
          'asked with the application and the address it is for',
          which?.query.get('applicationId') === 'app-helios-2' && which?.query.get('url') === 'https://jobs.example.com/helios/2222',
          which ? which.query.toString() : 'not asked',
        );
        const put = store.hits.slice(before).find((h) => h.method === 'PUT' && h.url.startsWith('/api/letters/'));
        let sent = {};
        try {
          sent = JSON.parse(put?.body ?? '{}');
        } catch {
          /* checked below */
        }
        check(
          'saved under the name the store gave, linked to the application it found',
          put?.url === '/api/letters/2026-03-01-helios-platform-engineer-2' && sent.applicationId === 'app-helios-2',
          `${put?.url} ${put?.body}`,
        );

        /*
         * A store too old to name the id replaces a letter whole on a PUT.
         * Measured against one: the letter filed with the application — its
         * link, its tags, its date and its text — was replaced by the card's
         * draft. So what is under the id is looked at in the list first.
         */
        store.letterId = undefined;
        store.letterFor = undefined;
        const savedOld = async () => {
          const at = store.hits.length;
          await ask(driver, 'saveLetter', {
            body: 'Dear Acme, a re-save from the card.',
            applicationId: 'app-acme',
            job: { company: 'Acme', title: 'Software Engineer Intern', url: 'https://acme.example/jobs/1' },
          });
          const hit = store.hits.slice(at).find((h) => h.method === 'PUT' && h.url.startsWith('/api/letters/'));
          let said = {};
          try {
            said = JSON.parse(hit?.body ?? '{}');
          } catch {
            /* checked below */
          }
          return { url: hit ? decodeURIComponent(hit.url) : null, said, listed: store.hits.slice(at).some((h) => h.url === '/api/letters') };
        };
        const filedId = '2026-03-02-acme-software-engineer-intern';
        store.oldLetters = [
          { id: filedId, title: 'Software Engineer Intern — Acme', applicationId: 'app-acme', tags: ['swe'], voice: false, createdAt: '2026-03-01T10:00:00.000Z', body: 'The letter that was sent.' },
          { id: `${filedId}-2`, title: 'Another', createdAt: '2026-03-01T11:00:00.000Z', body: 'Another.' },
        ];
        const beside = await savedOld();
        check('a store too old to name the id is looked at before it is written to', beside.listed, JSON.stringify(beside));
        check(
          'a letter filed with an application is left alone, and this goes onto the next name no application has',
          beside.url === `/api/letters/${filedId}-2` &&
            beside.said.applicationId === undefined &&
            beside.said.createdAt === '2026-03-01T11:00:00.000Z' &&
            beside.said.body === 'Dear Acme, a re-save from the card.',
          `${beside.url} ${JSON.stringify(beside.said)}`,
        );

        /*
         * Saved again, it goes onto the letter it made the first time. It
         * skipped every name that was taken, its own `-2` among them, and
         * each "Save to store" for a sent application made another letter.
         */
        store.oldLetters = [
          { id: filedId, title: 'Software Engineer Intern — Acme', applicationId: 'app-acme', createdAt: '2026-03-01T10:00:00.000Z', body: 'The letter that was sent.' },
          { id: `${filedId}-2`, title: 'Software Engineer Intern — Acme', createdAt: '2026-03-02T08:00:00.000Z', body: 'Dear Acme, a re-save from the card.' },
          { id: `${filedId}-3`, title: 'Another application', applicationId: 'app-other', body: 'Another one sent.' },
        ];
        const again = await savedOld();
        check(
          'saved again for a sent application, it goes onto its own letter from before, not a new one',
          again.url === `/api/letters/${filedId}-2` && again.said.createdAt === '2026-03-02T08:00:00.000Z',
          `${again.url} ${JSON.stringify(again.said)}`,
        );
        store.oldLetters = [
          { id: filedId, applicationId: 'app-acme', body: 'The letter that was sent.' },
          { id: `${filedId}-2`, applicationId: 'app-other', body: 'Another one sent.' },
        ];
        const past = await savedOld();
        check('and past every letter an application has', past.url === `/api/letters/${filedId}-3`, String(past.url));

        store.oldLetters = [{ id: filedId, title: 'Saved before', tags: ['mine'], voice: true, createdAt: '2026-01-05T09:00:00.000Z', body: 'Older draft.' }];
        const over = await savedOld();
        check(
          'one belonging to no application is saved over, keeping its tags, voice and date',
          over.url === `/api/letters/${filedId}` &&
            JSON.stringify(over.said.tags) === '["mine"]' &&
            over.said.voice === true &&
            over.said.createdAt === '2026-01-05T09:00:00.000Z' &&
            over.said.body === 'Dear Acme, a re-save from the card.',
          `${over.url} ${JSON.stringify(over.said)}`,
        );

        store.oldLetters = [];
        const fresh = await savedOld();
        check('and with nothing there, it is saved under the id that store would give it', fresh.url === `/api/letters/${filedId}`, String(fresh.url));
      } finally {
        store.letterId = undefined;
        store.letterFor = undefined;
        store.oldLetters = undefined;
        await sw.evaluate(() => {
          if (globalThis.__jhRealDate) globalThis.Date = globalThis.__jhRealDate;
        }).catch(() => undefined);
      }
    }

    /* ---------------------------------------------------------------- *
     * One board, several jobs                                           *
     * ---------------------------------------------------------------- */

    /*
     * A board that keeps every posting at one address — Indeed's results
     * pane, any single-page board — leaves the url saying "same page" when
     * the pane has been swapped to a different job. Reading the second one as
     * the first is how a cover letter comes out addressed to one company and
     * written from another, and it is the failure the whole trail exists to
     * prevent.
     *
     * The url cannot settle it there, so the role does, and a role title is
     * thin evidence: the answer is "unsure", and unsure branches. Branching
     * is the safe guess of the two, because a split can be put back and a
     * merge cannot — once the second job's pages and the first job's letter
     * are one application, nothing can tell them apart again.
     */
    group('One board showing several jobs');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: 'http://board.example/jobs?q=engineer', title: 'Engineer', html: '<p>one</p>', company: 'Helios' });
      // Something written, so the branch has something to be careful with.
      await ask(driver, 'saveWork', { work: { letter: 'Dear Helios, I have wanted this for years.' } });

      store.role = 'Data Scientist';
      const second = await ask(driver, 'analyze', { url: 'http://board.example/jobs?q=data', title: 'Data', html: '<p>two</p>', company: 'Helios' });
      const trail = second.reply?.data?.trail;
      check('the second job does not join the first', (trail?.pages ?? []).length === 1, `${trail?.pages?.length} pages`);
      check('and the card is told a new application was started', trail?.branchedFrom?.role === 'Platform Engineer', JSON.stringify(trail?.branchedFrom));
      check('the letter does not come with it', trail?.holdingWriting === false, JSON.stringify(trail?.holdingWriting));

      // "That was the same job after all."
      const back = await ask(driver, 'keepTogether', {});
      check('putting it back joins the two pages', (back.reply?.data?.pages ?? []).length === 2, `${back.reply?.data?.pages?.length} pages`);
      check('and the letter comes back with them', back.reply?.data?.holdingWriting === true, JSON.stringify(back.reply?.data));
      // Both halves: the merge happened *and* the chip is gone. Without the
      // first, "no chip" is what a call that failed outright also looks like.
      check(
        'and the card stops asking',
        back.reply?.ok === true && back.reply?.data?.branchedFrom === undefined,
        JSON.stringify(back.reply).slice(0, 80),
      );
    }

    /*
     * Branching is only half of it. The other half is what happens to the
     * letter the branch left behind, and it was going straight to the new job
     * one message later.
     *
     * `remember` parks the work it is about to replace under the address of
     * every page it belonged to, so that going back to that page finds it.
     * On a board that never changes its address, the page the new job is on
     * *is* that page — so `takeWork`, sent by the content script immediately
     * after the analysis, rescued the previous job's letter into the job that
     * had just branched away from it, and the card announced it as
     * "Recovered what you had written before this tab closed."
     *
     * Measured before it was fixed, on one url with two roles: the Data
     * Scientist page was handed `LETTER-FOR-PLATFORM-ENGINEER`, and going
     * back to the Platform Engineer page was handed the Data Scientist's. The
     * branch was undone on the spot, both ways, and every job on the board
     * came up holding the last one's writing.
     *
     * Two parts to the fix and both are checked below: a park knows which job
     * it belongs to and is refused to any other, and one address holds more
     * than one of them so the second job's park does not overwrite the
     * first's.
     */
    group('Going back to the job before it, on a board with one address');
    {
      const BOARD = 'http://board.example/all';
      const letterOn = (reply) => reply?.data?.work?.letter ?? null;
      store.save = 'work';
      await ask(driver, 'clearTrail', {});

      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { letter: 'FOR-THE-PLATFORM-ENGINEER' } });

      // The pane is swapped to another job. Same address, same employer.
      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>two</p>', company: 'Helios' });
      const atSecond = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Board' } });
      check('the new job is not handed the last one’s letter', letterOn(atSecond.reply) === null, JSON.stringify(atSecond.reply?.data));
      await ask(driver, 'saveWork', { work: { letter: 'FOR-THE-DATA-SCIENTIST' } });

      // And back to the first, which is the click this whole branch is for.
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>three</p>', company: 'Helios' });
      const atFirst = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Board' } });
      check('going back finds its own letter', letterOn(atFirst.reply) === 'FOR-THE-PLATFORM-ENGINEER', JSON.stringify(atFirst.reply?.data?.work));
      /*
       * And says so as what it is. "Before this tab closed" is the sentence
       * for a tab that closed; this tab never went anywhere, and telling
       * somebody their tab closed when it did not reads as the extension
       * having lost track of them.
       */
      check('and says it is this job’s, not a closed tab’s', atFirst.reply?.data?.recovered === 'job', JSON.stringify(atFirst.reply?.data?.recovered));

      // The second job's letter was not spent on the first: it is still there.
      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>four</p>', company: 'Helios' });
      const back = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Board' } });
      check('and the other job’s letter is still waiting for it', letterOn(back.reply) === 'FOR-THE-DATA-SCIENTIST', JSON.stringify(back.reply?.data?.work));
      store.role = 'Platform Engineer';
    }

    /*
     * A rescue nothing could check against the page says whose it was.
     *
     * `pickParked` refuses a park naming a plainly different job, but only
     * when the page gives it a job to compare with. On a page the analysis
     * cannot name it hands back the newest park at the address, which on a
     * board keeping every posting at one url may be another job's letter —
     * and the card said only "Recovered what you had written before this tab
     * closed", with nothing to notice a wrong hand-off by.
     *
     * The park is written as a closed tab leaves one: named, from a tab that
     * no longer exists.
     */
    group('Drafting one answer tells the store the box’s limit');
    {
      store.save = 'work';
      await ask(driver, 'answerQuestion', { question: 'Why us?', force: true, limit: 280 });
      const hit = store.sentTo('/api/ai/answer').slice(-1)[0];
      const body = JSON.parse(hit?.body || '{}');
      check('the limit goes with the question', body.limit === 280 && body.question === 'Why us?', hit?.body ?? '(not sent)');
    }

    /*
     * The card's resume is a proposal the store has not been given, so its id
     * names nothing there. These asked with `spec.extends ?? spec.id`, and a
     * proposal carries no `extends` since resumes stopped inheriting: the
     * proposal's own id went, and the store answered "No resume named …".
     */
    group('Writing from the card sends the proposal, and a resume the store has');
    {
      store.save = 'work';
      const spec = { id: 'job-fake', label: 'Helios', tier: 'temporary', copiedFrom: 'newgrad', sections: [] };
      const job = { title: 'Engineer', company: 'Helios', description: 'A job.' };
      await ask(driver, 'coverLetter', { spec, job });
      await ask(driver, 'writeApplication', { spec, job, letter: { required: true, body: '' }, questions: [] });
      await ask(driver, 'refine', { spec, job, feedback: 'More Kafka.' });
      await ask(driver, 'renderLetter', { body: 'Dear Helios,', spec });
      // One answer drafted on its own goes beside the same resume, so the
      // store can show it as what the reader already has.
      await ask(driver, 'answerQuestion', { question: 'Why us?', force: true, spec, job });
      /*
       * A redraft told what to change carries the draft and the words about
       * it; a plain draft asks exactly what it always asked.
       */
      await ask(driver, 'answerQuestion', { question: 'Why us?', force: true, spec, job, draft: 'My first go.', feedback: ' Shorter. ' });
      const redraft = JSON.parse(store.sentTo('/api/ai/answer').slice(-1)[0]?.body || '{}');
      check('a redraft of an answer carries the draft and what to change', redraft.draft === 'My first go.' && redraft.feedback === 'Shorter.', JSON.stringify(redraft));
      await ask(driver, 'coverLetter', { spec, job, draft: 'Dear Helios,', feedback: 'Open with the posting.' });
      const letterRedraft = JSON.parse(store.sentTo('/api/ai/cover-letter').slice(-1)[0]?.body || '{}');
      check('and so does a redraft of the letter', letterRedraft.draft === 'Dear Helios,' && letterRedraft.feedback === 'Open with the posting.', JSON.stringify(letterRedraft));
      await ask(driver, 'coverLetter', { spec, job, draft: '   ', feedback: '' });
      const plain = JSON.parse(store.sentTo('/api/ai/cover-letter').slice(-1)[0]?.body || '{}');
      check('while a plain draft sends neither', !('draft' in plain) && !('feedback' in plain), JSON.stringify(Object.keys(plain)));
      for (const route of ['/api/ai/cover-letter', '/api/extension/write', '/api/ai/tailor', '/api/render/letter', '/api/ai/answer']) {
        const body = JSON.parse(store.sentTo(route).slice(-1)[0]?.body || '{}');
        check(
          `${route} names the resume it was copied from, and carries the copy`,
          body.resumeId === 'newgrad' && body.spec?.id === 'job-fake',
          JSON.stringify({ resumeId: body.resumeId, spec: body.spec?.id }),
        );
      }
    }

    group('A rescue onto a page nobody could name says which job it was for');
    {
      const BOARD = 'http://board.example/unnamed';
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-SOMEONE' }, save: 'work', job: { role: 'Platform Engineer', company: 'Helios' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${BOARD}`],
      );
      store.role = '';
      store.company = '';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>unnamed</p>' });
      const got = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Board' } });
      store.company = undefined;
      check('the letter is still rescued', got.reply?.data?.work?.letter === 'FOR-SOMEONE', JSON.stringify(got.reply?.data?.work));
      check(
        'and named as the job it was written for',
        got.reply?.data?.recoveredFor === 'Platform Engineer at Helios',
        JSON.stringify(got.reply?.data?.recoveredFor),
      );

      // Where the page is named and matched, its heading already says it.
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-HELIOS' }, save: 'work', job: { role: 'Platform Engineer', company: 'Helios' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${BOARD}`],
      );
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: BOARD, title: 'Board', html: '<p>named</p>' });
      const matched = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Board' } });
      check(
        'not where the page itself was matched to it',
        matched.reply?.data?.work?.letter === 'FOR-HELIOS' && matched.reply?.data?.recoveredFor === undefined,
        JSON.stringify(matched.reply?.data),
      );
    }

    /*
     * Another job's letter at the same address is never handed over as this
     * job's.
     *
     * A board that keeps every posting at one address — Indeed's results
     * pane — parks each job's writing under that address. `sameJob` read two
     * roles at one employer as one job unless they had no word in common, so
     * the letter for "Data Engineer Intern" came back into the card for
     * "Software Engineer Intern", the Summer 2026 letter into the Summer 2027
     * posting and the intern letter into the new grad one — each with no word
     * on the card that it was written for another job. Now only the same
     * title is the same job; any other title is named on the way in.
     */
    group('Another job at the same employer and address is left parked for its own tab');
    {
      const BOARD = 'https://www.indeed.com/q-software-intern-jobs.html';
      const cases = [
        ['another role', { role: 'Data Engineer Intern', company: 'Coinbase' }, 'Software Engineer Intern', undefined],
        ['another season', { role: 'Software Engineer Intern (Summer 2026)', company: 'Coinbase' }, 'Software Engineer Intern (Summer 2027)', undefined],
        ['intern against new grad', { role: 'Software Engineer Intern', company: 'Coinbase' }, 'Software Engineer, New Grad', undefined],
        ['another requisition under the same title', { role: 'Software Engineer Intern', company: 'Coinbase', requisition: 'R-1001' }, 'Software Engineer Intern', 'R-2002'],
      ];
      store.save = 'work';
      for (const [what, parkedJob, role, requisition] of cases) {
        await ask(driver, 'clearTrail', {});
        await driver.evaluate(
          ([key, job]) =>
            chrome.storage.session.set({
              [key]: { parked: [{ work: { letter: `FOR ${job.role}` }, save: 'work', job, tab: 987654, at: Date.now() }], at: Date.now() },
            }),
          [`jh-orphan:${BOARD}`, parkedJob],
        );
        store.role = role;
        store.company = 'Coinbase';
        store.requisition = requisition;
        await ask(driver, 'analyze', { url: BOARD, title: role, html: '<p>posting</p>', company: 'Coinbase' });
        const got = await ask(driver, 'takeWork', { page: { url: BOARD, title: role } });
        const data = got.reply?.data ?? {};
        check(`${what}: its letter is not handed to this page`, !data.work, JSON.stringify({ letter: data.work?.letter, recoveredFor: data.recoveredFor }));
        const still = await driver.evaluate(
          (key) => chrome.storage.session.get(key).then((got) => (got[key]?.parked ?? []).map((p) => p.work?.letter)),
          `jh-orphan:${BOARD}`,
        );
        check(`${what}: and it is still parked for its own tab`, still.includes(`FOR ${parkedJob.role}`), JSON.stringify(still));
      }

      /*
       * A park that names no role — a tab closed before its page was read —
       * is still offered on the loose reading, which is the rescue this is
       * for, and says whose it was.
       */
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: { parked: [{ work: { letter: 'FOR-UNNAMED' }, save: 'work', job: { role: null, company: 'Coinbase' }, tab: 987654, at: Date.now() }], at: Date.now() },
          }),
        [`jh-orphan:${BOARD}`],
      );
      store.role = 'Software Engineer Intern';
      store.requisition = undefined;
      await ask(driver, 'analyze', { url: BOARD, title: 'Software Engineer Intern', html: '<p>posting</p>', company: 'Coinbase' });
      const unnamed = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Software Engineer Intern' } });
      check(
        'a park that names no role is still rescued, and says whose it was',
        unnamed.reply?.data?.work?.letter === 'FOR-UNNAMED' && unnamed.reply?.data?.recoveredFor === 'Coinbase',
        JSON.stringify(unnamed.reply?.data),
      );

      // The same title, the same requisition: this job's own, said as nothing more.
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-THIS-ONE' }, save: 'work', job: { role: 'Software Engineer Intern', company: 'Coinbase', requisition: 'R-1001' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${BOARD}`],
      );
      store.role = 'Software Engineer Intern';
      store.requisition = 'R-1001';
      await ask(driver, 'analyze', { url: BOARD, title: 'Software Engineer Intern', html: '<p>posting</p>', company: 'Coinbase' });
      const same = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Software Engineer Intern' } });
      check(
        'while this job\'s own letter comes back unlabelled',
        same.reply?.data?.work?.letter === 'FOR-THIS-ONE' && same.reply?.data?.recoveredFor === undefined,
        JSON.stringify(same.reply?.data),
      );

      // And another employer's is never taken at all.
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-RAMP' }, save: 'work', job: { role: 'Software Engineer Intern', company: 'Ramp' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${BOARD}`],
      );
      store.requisition = undefined;
      await ask(driver, 'analyze', { url: BOARD, title: 'Software Engineer Intern', html: '<p>posting</p>', company: 'Coinbase' });
      const other = await ask(driver, 'takeWork', { page: { url: BOARD, title: 'Software Engineer Intern' } });
      check('and another employer\'s letter is left where it is', !other.reply?.data?.work, JSON.stringify(other.reply?.data));
      store.company = undefined;
      store.role = 'Platform Engineer';
      await ask(driver, 'clearTrail', {});
    }

    /*
     * One employer written two ways is still one job to put writing back into.
     *
     * A park is named after the application's last page, and a posting's
     * JSON-LD carries the legal name where the form says the short one. The
     * names were compared exactly, so coming back to the posting as "Helios,
     * Inc." read the park named "Helios" as another employer's and refused
     * it: the letter stayed parked and the card came up empty on the job it
     * was written for.
     */
    group('Coming back to a job whose employer is written another way');
    {
      const WHERE = 'http://careers.helios.example/jobs/platform-engineer';
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-HELIOS-AGAIN' }, save: 'work', job: { role: 'Platform Engineer', company: 'Helios' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${WHERE}`],
      );
      store.role = 'Platform Engineer';
      // What the analysis reads off the posting, whatever the page sent.
      store.company = 'Helios, Inc.';
      await ask(driver, 'analyze', { url: WHERE, title: 'Platform Engineer', html: '<p>posting</p>', company: 'Helios, Inc.' });
      const got = await ask(driver, 'takeWork', { page: { url: WHERE, title: 'Platform Engineer' } });
      check('its letter comes back', got.reply?.data?.work?.letter === 'FOR-HELIOS-AGAIN', JSON.stringify(got.reply?.data));

      // And another employer's is still refused, however it is written.
      await ask(driver, 'clearTrail', {});
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'FOR-ALTAIR' }, save: 'work', job: { role: 'Platform Engineer', company: 'Altair' }, tab: 987654, at: Date.now() }],
              at: Date.now(),
            },
          }),
        [`jh-orphan:${WHERE}`],
      );
      await ask(driver, 'analyze', { url: WHERE, title: 'Platform Engineer', html: '<p>posting</p>', company: 'Helios, Inc.' });
      const other = await ask(driver, 'takeWork', { page: { url: WHERE, title: 'Platform Engineer' } });
      store.company = undefined;
      check('while another employer’s is not', other.reply?.data?.work?.letter !== 'FOR-ALTAIR', JSON.stringify(other.reply?.data));
    }

    /*
     * One job, its title written two ways: by the employer's form, where the
     * trail ended, and by LinkedIn's posting. `titleKey` alone read each pair
     * below as two jobs, so the letter came back to neither another tab nor
     * this one. Real pairs from a tracker.
     */
    group('A letter comes back when LinkedIn and the form spell the title differently');
    {
      const WHERE = 'https://www.linkedin.com/jobs/view/4999999999/';
      const PAIRS = [
        ['the work mode on one side', 'CrowdStrike', 'Software Engineer – Sensor, Sensor Performance and Stability (Hybrid)', 'Software Engineer – Sensor, Sensor Performance and Stability'],
        ['the season and year in either order', 'Careers Americas', 'Software Engineer Intern, 2027 Summer U.S.', 'Software Engineer Intern, Summer 2027 U.S.'],
        ['a gender tag on one side', 'Müller & Söhne GmbH', 'Werkstudent Softwareentwicklung (m/w/d)', 'Werkstudent Softwareentwicklung'],
        ['a French gender tag written two ways', 'Société Générale', 'Stagiaire Ingénieur Logiciel F/H', 'Stagiaire Ingénieur Logiciel (H/F)'],
        ['the employer’s spelling of a dash and an apostrophe', 'Intel', 'Software Engineering - Intern, Bachelor’s', "Software Engineering Intern, Bachelor's"],
      ];
      const thisTab = await driver.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      store.save = 'work';
      for (const [what, company, parkedRole, role] of PAIRS) {
        for (const [whose, tab] of [['a closed tab’s', 987654], ['this tab’s own', thisTab]]) {
          await ask(driver, 'clearTrail', {});
          await driver.evaluate(
            ([key, job, tab]) =>
              chrome.storage.session.set({ [key]: { parked: [{ work: { letter: 'THE-LETTER' }, save: 'work', job, tab, at: Date.now() }], at: Date.now() } }),
            [`jh-orphan:${WHERE}`, { company, role: parkedRole }, tab],
          );
          store.role = role;
          store.company = company;
          await ask(driver, 'analyze', { url: WHERE, title: role, html: '<p>posting</p>', company });
          const got = await ask(driver, 'takeWork', { page: { url: WHERE, title: role } });
          check(`${what}: ${whose} letter comes back`, got.reply?.data?.work?.letter === 'THE-LETTER', JSON.stringify(got.reply?.data ?? null));
        }
      }

      /*
       * This tab's own, under a title `sameTitle` does not know, comes back
       * too — said as whose it was — while another tab's under it stays
       * parked for that tab. Two seasons are still two jobs to any tab but
       * this one's.
       */
      for (const [whose, tab, back] of [['this tab’s own', thisTab, true], ['a closed tab’s', 987654, false]]) {
        await ask(driver, 'clearTrail', {});
        await driver.evaluate(
          ([key, tab]) =>
            chrome.storage.session.set({
              [key]: { parked: [{ work: { letter: 'OWN-LETTER' }, save: 'work', job: { company: 'Figma', role: 'Software Engineer Intern, Platform' }, tab, at: Date.now() }], at: Date.now() },
            }),
          [`jh-orphan:${WHERE}`, tab],
        );
        store.role = 'Software Engineer Intern - Platform Team';
        store.company = 'Figma';
        await ask(driver, 'analyze', { url: WHERE, title: store.role, html: '<p>posting</p>', company: 'Figma' });
        const got = await ask(driver, 'takeWork', { page: { url: WHERE, title: store.role } });
        check(
          `under a title written another way, ${whose} letter ${back ? 'comes back, named' : 'is left for its tab'}`,
          back
            ? got.reply?.data?.work?.letter === 'OWN-LETTER' && got.reply?.data?.recoveredFor === 'Software Engineer Intern, Platform at Figma'
            : got.reply?.data?.work?.letter !== 'OWN-LETTER',
          JSON.stringify(got.reply?.data ?? null),
        );
      }
      store.role = 'Platform Engineer';
      store.company = undefined;
    }

    /*
     * Round 24: two live postings that differ in how the job is worked, and a
     * season on one side only.
     *
     * The work mode came off both titles before they were compared, so
     * "Software Engineer - Remote" and "Software Engineer - Hybrid" — two
     * postings one employer runs side by side — were one job, and the remote
     * one's letter was handed to the hybrid one's card. And "Software
     * Engineer Intern" against "… (Summer 2027)" was the same job for any
     * tab's park, where it is the next intake's as often as not: only this
     * tab's own, which went from the board to the form and back, may read
     * them as one. The suffixes come off in either order, so "(Remote)
     * (Summer 2027)" and "(Summer 2027) (Remote)" behave alike.
     */
    group('Two work modes are two jobs, and a season on one side is the same job only for this tab');
    {
      const WHERE = 'https://www.linkedin.com/jobs/view/4888888888/';
      const thisTab = await driver.evaluate(async () => (await chrome.tabs.getCurrent()).id);
      const CASES = [
        ['two work modes, from a closed tab', 'Software Engineer - Remote', 'Software Engineer - Hybrid', 987654, false],
        // This tab's own still comes back, as `pickParked` gives a tab its own whatever the page is
        // called — but named as the other job's, because to `sameJob` it is not this one.
        ['two work modes, from this tab', 'Software Engineer (Remote)', 'Software Engineer - Hybrid', 'this', 'named'],
        ['a work mode on one side only', 'Software Engineer - Remote', 'Software Engineer', 987654, true],
        ['a bracketed season on one side, from a closed tab', 'Software Engineer Intern', 'Software Engineer Intern (Summer 2027)', 987654, false],
        ['a bracketed season on one side, from this tab', 'Software Engineer Intern', 'Software Engineer Intern (Summer 2027)', 'this', true],
        ['a mode and a season in one order', 'Software Engineer Intern (Remote) (Summer 2027)', 'Software Engineer Intern (Summer 2027)', 987654, true],
        ['a mode and a season in the other order', 'Software Engineer Intern (Summer 2027) (Remote)', 'Software Engineer Intern (Summer 2027)', 987654, true],
        ['a mode, a season and nothing, from a closed tab', 'Software Engineer Intern (Remote) (Summer 2027)', 'Software Engineer Intern', 987654, false],
        ['a season and a mode and nothing, from a closed tab', 'Software Engineer Intern (Summer 2027) (Remote)', 'Software Engineer Intern', 987654, false],
      ];
      store.save = 'work';
      for (const [what, parkedRole, role, tab, back] of CASES) {
        await ask(driver, 'clearTrail', {});
        await driver.evaluate(
          ([key, job, tab]) =>
            chrome.storage.session.set({ [key]: { parked: [{ work: { letter: 'MODE-LETTER' }, save: 'work', job, tab, at: Date.now() }], at: Date.now() } }),
          [`jh-orphan:${WHERE}`, { company: 'Figma', role: parkedRole }, tab === 'this' ? thisTab : tab],
        );
        store.role = role;
        store.company = 'Figma';
        await ask(driver, 'analyze', { url: WHERE, title: role, html: '<p>posting</p>', company: 'Figma' });
        const got = await ask(driver, 'takeWork', { page: { url: WHERE, title: role } });
        const letter = got.reply?.data?.work?.letter;
        if (back === 'named') {
          check(
            `${what}: the letter comes back named as the other job's`,
            letter === 'MODE-LETTER' && got.reply?.data?.recoveredFor === `${parkedRole} at Figma`,
            JSON.stringify(got.reply?.data ?? null),
          );
        } else {
          check(`${what}: ${back ? 'the letter comes back' : 'the letter is left parked'}`, (letter === 'MODE-LETTER') === back, JSON.stringify(got.reply?.data ?? null));
        }
      }
      store.role = 'Platform Engineer';
      store.company = undefined;
    }

    /*
     * A rescue is not a rescue until the writing is somewhere other than a
     * message.
     *
     * The park used to be deleted first and the letter returned only in the
     * reply, so between the two there was exactly one copy of it — in flight.
     * The caller drops that reply whenever the pass has been superseded,
     * which on a single-page board is any url tick (`if (!current()) return;`
     * sits on the line after the send), and the `.catch` beside it does the
     * same when a navigation kills the response. The letter was then in
     * neither place and the next pass found nothing.
     *
     * Asked by claiming it and then asking again as a fresh pass would: the
     * park is gone, so the second answer can only come from the trail.
     */
    group('A rescued letter survives the reply being dropped');
    {
      const WHERE = 'http://board.example/durable';
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: WHERE, title: 'Board', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { letter: 'DURABLE-LETTER' } });

      // Another job in the same pane parks the first one's work.
      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: WHERE, title: 'Board', html: '<p>two</p>', company: 'Helios' });

      // Back to it: the rescue happens, and this reply is the one we pretend
      // never arrived.
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: WHERE, title: 'Board', html: '<p>three</p>', company: 'Helios' });
      const claimed = await ask(driver, 'takeWork', { page: { url: WHERE, title: 'Board' } });
      check('the rescue answers with the letter', claimed.reply?.data?.work?.letter === 'DURABLE-LETTER', JSON.stringify(claimed.reply?.data?.work));

      const again = await ask(driver, 'takeWork', { page: { url: WHERE, title: 'Board' } });
      check(
        'and asking again still finds it, with the park already spent',
        again.reply?.data?.work?.letter === 'DURABLE-LETTER',
        JSON.stringify(again.reply?.data?.work),
      );
      store.role = 'Platform Engineer';
    }

    /*
     * Claiming a park must not take another one with it.
     *
     * `parkWork` goes through the one-writer-at-a-time chain, and its own
     * comment says exactly why: read, modify, write is three turns, two tabs
     * closing on the same board address both read the same list, and the
     * second write lands on top of the first. `dropPark` — the other half of
     * the same read-modify-write, on the same key — did not. It was handed
     * the list `takeWork` had read several turns earlier, across a real
     * `await writeTrail`, and wrote it back minus the entry it claimed. A
     * park that arrived in that window was written and then erased: somebody
     * else's letter, gone, with no error anywhere and nothing to come back to.
     *
     * Driven as the race it is, at a spread of delays, because the window is
     * a few milliseconds wide and one guess at it proves nothing. The other
     * letter has to survive every one of them.
     */
    group('Claiming a park does not erase one that arrives meanwhile');
    {
      const WHERE = 'http://board.example/claimed';
      const other = await context.newPage();
      await other.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      const lost = [];
      const twice = [];
      let claims = 0;
      try {
        // Negative: the other tab's park starts first, and its path is the
        // longer of the two — a full sweep before the chain.
        for (let delay = -16; delay <= 8; delay++) {
          store.save = 'work';
          store.role = 'Platform Engineer';
          await ask(driver, 'clearTrail', {});
          await ask(other, 'clearTrail', {});
          await driver.evaluate((key) => chrome.storage.session.remove(key), `jh-orphan:${WHERE}`);
          // This tab's own letter, parked, waiting to be claimed.
          await ask(driver, 'analyze', { url: WHERE, title: 'Board', html: '<p>one</p>', company: 'Helios' });
          await ask(driver, 'saveWork', { work: { letter: 'MINE' } });
          await ask(driver, 'clearTrail', {});
          await ask(driver, 'analyze', { url: WHERE, title: 'Board', html: '<p>one</p>', company: 'Helios' });

          // Another tab, on another job at the same address, with a letter of
          // its own that it is about to park there. The company is set on the
          // store because that is what the analysis reads, whatever was sent.
          store.company = 'Altair';
          await ask(other, 'analyze', { url: WHERE, title: 'Board', html: '<p>two</p>', company: 'Altair' });
          store.company = undefined;
          await ask(other, 'saveWork', { work: { letter: `THEIRS-${delay}` } });

          const later = (ms, fn) => new Promise((r) => setTimeout(r, Math.max(0, ms))).then(fn);
          const [claimed] = await Promise.all([
            later(-delay, () => ask(driver, 'takeWork', { page: { url: WHERE, title: 'Board' } })),
            later(delay, () => ask(other, 'clearTrail', {})),
          ]);
          const left = await driver.evaluate(async (key) => {
            const held = (await chrome.storage.session.get(key))[key];
            return (held?.parked ?? []).map((p) => p.work?.letter);
          }, `jh-orphan:${WHERE}`);
          if (claimed.reply?.data?.work?.letter === 'MINE') claims++;
          if (!left.includes(`THEIRS-${delay}`)) lost.push({ delay, left });
          if (left.includes('MINE')) twice.push({ delay, left });
        }
      } finally {
        await other.close();
      }
      check('every claim really was made', claims === 25, `${claims} of 25`);
      check('the other tab’s letter survives the claim, at every delay', lost.length === 0, JSON.stringify(lost));
      /*
       * And the other half of the same stale write: a claim that lands after
       * the park has re-read the list is written back over, and the letter
       * just claimed is parked again, for another tab to claim a second time.
       */
      check('and the letter claimed is not left there to be claimed again', twice.length === 0, JSON.stringify(twice));
    }

    /*
     * A claim takes every copy of what it claims, not only the one it found.
     *
     * Forgetting an application parks its writing under every page of it, so
     * coming back to whichever page finds it. Claiming it took the copy at the
     * page it was claimed from and left the others: open the form in another
     * tab afterwards and it was handed the same letter as "recovered from a
     * tab that closed", while the tab that had claimed it was open and
     * holding it — one application, written in two places.
     */
    group('Claiming parked writing takes its copies at the other pages too');
    {
      const POSTING = 'http://careers.helios.example/jobs/sre';
      const FORM = 'http://careers.helios.example/jobs/sre/apply';
      store.save = 'work';
      store.role = 'Platform Engineer';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: POSTING, title: 'SRE', html: '<p>posting</p>' });
      await ask(driver, 'analyze', { url: FORM, title: 'SRE', html: '<p>form</p>' });
      await ask(driver, 'saveWork', { work: { letter: 'ONE-APPLICATION' } });
      await ask(driver, 'clearTrail', {});
      const parkedAtForm = await driver.evaluate(async (key) => Boolean((await chrome.storage.session.get(key))[key]), `jh-orphan:${FORM}`);

      await ask(driver, 'analyze', { url: POSTING, title: 'SRE', html: '<p>posting</p>' });
      const claimed = await ask(driver, 'takeWork', { page: { url: POSTING, title: 'SRE' } });

      const other = await context.newPage();
      await other.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await ask(other, 'analyze', { url: FORM, title: 'SRE', html: '<p>form</p>' });
      const again = await ask(other, 'takeWork', { page: { url: FORM, title: 'SRE' } });
      await ask(other, 'clearTrail', {});
      await other.close();

      check('it was parked at both pages', parkedAtForm === true, String(parkedAtForm));
      check('and claimed at the posting', claimed.reply?.data?.work?.letter === 'ONE-APPLICATION', JSON.stringify(claimed.reply?.data));
      check(
        'so another tab on the form is not handed it again',
        again.reply?.data?.work?.letter !== 'ONE-APPLICATION',
        JSON.stringify(again.reply?.data),
      );
    }

    /*
     * Parked work belongs to the tab that parked it, while that tab is open.
     *
     * Parks are keyed by address and an address is not an application: a
     * shared careers listing, an ATS login page, a board that keeps every
     * posting at one url. The rescue from a closed tab has to take a park
     * that is not its own, because a reopened tab has a new id. But a tab
     * that is still open and has only gone off to read another job is
     * coming back for it — and another tab opening that address took it
     * first, "recovered from a tab that closed", leaving nothing for the tab
     * that wrote it.
     */
    group('Another open tab’s parked letter stays with that tab');
    {
      const BOARD = 'http://board.example/shared-listing';
      const a = await context.newPage();
      const b = await context.newPage();
      await a.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await b.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      const letterOn = (reply) => reply?.data?.work?.letter ?? null;
      try {
        store.save = 'work';
        store.company = undefined;
        await driver.evaluate((key) => chrome.storage.session.remove(key), `jh-orphan:${BOARD}`);
        store.role = 'Platform Engineer';
        await ask(a, 'analyze', { url: BOARD, title: 'Board', html: '<p>one</p>', company: 'Helios' });
        await ask(a, 'saveWork', { work: { letter: 'WRITTEN-IN-TAB-A' } });
        // Tab A goes off to read another job, which parks its letter here.
        store.role = 'Data Scientist';
        await ask(a, 'analyze', { url: 'http://vega.example/jobs/ds', title: 'DS', html: '<p>two</p>', company: 'Vega' });

        // Tab B opens the same address on a page nobody can name.
        store.role = '';
        store.company = '';
        await ask(b, 'analyze', { url: BOARD, title: 'Board', html: '<p>unnamed</p>' });
        const unnamed = await ask(b, 'takeWork', { page: { url: BOARD, title: 'Board' } });
        store.company = undefined;
        check('a tab opening an address another open tab parked at is not handed its letter', letterOn(unnamed.reply) !== 'WRITTEN-IN-TAB-A', JSON.stringify(unnamed.reply?.data));

        // And on the same posting, named: a duplicate, not a closed tab.
        await ask(b, 'clearTrail', {});
        store.role = 'Platform Engineer';
        await ask(b, 'analyze', { url: BOARD, title: 'Board', html: '<p>one</p>', company: 'Helios' });
        const named = await ask(b, 'takeWork', { page: { url: BOARD, title: 'Board' } });
        check('nor when it is on the same job', letterOn(named.reply) !== 'WRITTEN-IN-TAB-A', JSON.stringify(named.reply?.data));

        // Tab A, back to its job, finds its own letter.
        await ask(a, 'analyze', { url: BOARD, title: 'Board', html: '<p>one</p>', company: 'Helios' });
        const back = await ask(a, 'takeWork', { page: { url: BOARD, title: 'Board' } });
        check('and the tab that wrote it finds it when it comes back', letterOn(back.reply) === 'WRITTEN-IN-TAB-A', JSON.stringify(back.reply?.data));
      } finally {
        store.company = undefined;
        store.role = 'Platform Engineer';
        await ask(a, 'clearTrail', {}).catch(() => undefined);
        await ask(b, 'clearTrail', {}).catch(() => undefined);
        await a.close();
        await b.close();
      }
    }

    /*
     * Two tabs on the same posting are two applications until somebody says
     * otherwise, and each one's park is its own.
     *
     * `parkWork` replaced whatever was parked at the address for the same
     * job, whoever parked it — which is right for one tab parking the same
     * job twice and wrong for two tabs. Both open on one posting, both
     * writing, both off to read something else: the second park wrote over
     * the first, and the first tab came back to the second tab's letter.
     */
    group('Two tabs on the same posting each come back to their own letter');
    {
      const SAME = 'http://careers.helios.example/jobs/platform-twice';
      const a = await context.newPage();
      const b = await context.newPage();
      await a.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await b.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      const letterOn = (reply) => reply?.data?.work?.letter ?? null;
      try {
        store.save = 'work';
        store.company = undefined;
        store.role = 'Platform Engineer';
        await driver.evaluate((key) => chrome.storage.session.remove(key), `jh-orphan:${SAME}`);
        await ask(a, 'analyze', { url: SAME, title: 'Platform', html: '<p>one</p>', company: 'Helios' });
        await ask(a, 'saveWork', { work: { letter: 'TAB-A-TO-HELIOS' } });
        await ask(b, 'analyze', { url: SAME, title: 'Platform', html: '<p>one</p>', company: 'Helios' });
        await ask(b, 'saveWork', { work: { letter: 'TAB-B-TO-HELIOS' } });

        // Each goes off to read another job.
        store.role = 'Data Scientist';
        await ask(a, 'analyze', { url: 'http://vega.example/jobs/a', title: 'A', html: '<p>a</p>', company: 'Vega' });
        await ask(b, 'analyze', { url: 'http://lyra.example/jobs/b', title: 'B', html: '<p>b</p>', company: 'Lyra' });

        // And each comes back.
        store.role = 'Platform Engineer';
        await ask(a, 'analyze', { url: SAME, title: 'Platform', html: '<p>one</p>', company: 'Helios' });
        const atA = await ask(a, 'takeWork', { page: { url: SAME, title: 'Platform' } });
        await ask(b, 'analyze', { url: SAME, title: 'Platform', html: '<p>one</p>', company: 'Helios' });
        const atB = await ask(b, 'takeWork', { page: { url: SAME, title: 'Platform' } });
        check('the first tab comes back to its own letter', letterOn(atA.reply) === 'TAB-A-TO-HELIOS', JSON.stringify(atA.reply?.data?.work));
        check('and the second to its own', letterOn(atB.reply) === 'TAB-B-TO-HELIOS', JSON.stringify(atB.reply?.data?.work));
      } finally {
        await ask(a, 'clearTrail', {}).catch(() => undefined);
        await ask(b, 'clearTrail', {}).catch(() => undefined);
        await a.close();
        await b.close();
      }
    }

    /*
     * "Same job — put it back" has to put it back where it can be seen.
     *
     * The merge wrote the letter into the trail and answered with a summary,
     * and a summary is booleans — `summarise` strips `work` deliberately, so
     * the popup never holds a copy of anybody's letter. Both callers did only
     * `setTrail`, so nothing reached the card: the panel grew to two pages,
     * the letter did not come back on screen, and two seconds later the
     * card's keeper saved its own empty work over the restored trail. The
     * button's tooltip promises "with everything you had written", and
     * pressing it was how you lost it.
     */
    group('Putting a branch back hands the writing over, not just the pages');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: 'http://board.example/two?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { letter: 'PUT-THIS-BACK' } });
      // Another tab's writing for another job, parked at the same address.
      await driver.evaluate(
        ([key]) =>
          chrome.storage.session.set({
            [key]: {
              parked: [{ work: { letter: 'SOMEONE-ELSES' }, save: 'work', job: { role: 'Designer', company: 'Altair' }, tab: 424242, at: Date.now() }],
              at: Date.now(),
            },
          }),
        ['jh-orphan:http://board.example/two?q=a'],
      );

      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: 'http://board.example/two?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
      const back = await ask(driver, 'keepTogether', {});
      check('the merge answers with the writing itself', back.reply?.data?.work?.letter === 'PUT-THIS-BACK', JSON.stringify(back.reply?.data?.work));
      check('and with the pages joined', (back.reply?.data?.pages ?? []).length === 2, `${back.reply?.data?.pages?.length} pages`);
      store.role = 'Platform Engineer';

      /*
       * And the copy the branch parked goes with it.
       *
       * Branching parks what it leaves under every page of the old
       * application, so a closed tab's rescue can find it — and the merge put
       * the writing back into this tab without taking those parks away. A
       * second tab opening the posting then rescued the same letter as
       * "recovered from a tab that closed", while the tab it came from was
       * still open and still holding it: one application, being written in
       * two places, each able to send.
       */
      const stillParked = await driver.evaluate(async (key) => {
        const held = (await chrome.storage.session.get(key))[key];
        return (held?.parked ?? []).map((p) => p.work?.letter);
      }, 'jh-orphan:http://board.example/two?q=a');
      check(
        'while another tab’s writing parked at the same address stays',
        JSON.stringify(stillParked) === JSON.stringify(['SOMEONE-ELSES']),
        JSON.stringify(stillParked),
      );
      const elsewhere = await context.newPage();
      await elsewhere.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await ask(elsewhere, 'analyze', { url: 'http://board.example/two?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
      const twice = await ask(elsewhere, 'takeWork', { page: { url: 'http://board.example/two?q=a', title: 'A' } });
      await ask(elsewhere, 'clearTrail', {});
      await elsewhere.close();
      check(
        'another tab on the same posting is not handed a second copy',
        twice.reply?.data?.work?.letter !== 'PUT-THIS-BACK',
        JSON.stringify(twice.reply?.data),
      );
    }

    /*
     * And with what was written *after* the branch, which is the half it used
     * to throw away.
     *
     * The merge took the stashed work whenever there was any, on the grounds
     * that "the branch is seconds old, so anything under `work` now is what
     * the card rebuilt on arrival". The staleness rule fifteen lines above it
     * accepts a stash for two hours and the chip stays up as long as the page
     * is open, so the ordinary shape is: the card branches, you keep writing,
     * then you press the button. Every sentence written after the branch went
     * — from a button whose tooltip promises "with everything you had
     * written", and with nothing having parked it, because parking happens in
     * `remember` and no `remember` ran in between.
     */
    group('Putting a branch back keeps what was written on both sides of it');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: 'http://board.example/both?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', {
        work: { letter: 'BEFORE-THE-BRANCH', answersByQuestion: { why: 'first answer', how: 'kept' } },
      });

      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: 'http://board.example/both?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
      // Written on the new page, before answering the chip.
      await ask(driver, 'saveWork', {
        work: { letter: 'AFTER-THE-BRANCH', answersByQuestion: { how: 'overwritten', extra: 'new answer' } },
      });

      const both = await ask(driver, 'keepTogether', {});
      const work = both.reply?.data?.work ?? {};
      check('the letter from before the branch is there', /BEFORE-THE-BRANCH/.test(work.letter ?? ''), work.letter ?? '');
      check('and so is the one written after it', /AFTER-THE-BRANCH/.test(work.letter ?? ''), work.letter ?? '');
      check(
        'an answer written after the branch survives',
        work.answersByQuestion?.extra === 'new answer',
        JSON.stringify(work.answersByQuestion),
      );
      /*
       * And the earlier answer wins where both answered the same question:
       * the one from before the branch is the one somebody chose for this
       * application, and the later one was typed for what looked like a
       * different job.
       */
      check(
        'and the earlier one wins where both answered the same question',
        work.answersByQuestion?.how === 'kept',
        JSON.stringify(work.answersByQuestion),
      );
      store.role = 'Platform Engineer';
    }

    /*
     * The common shape, which must not be turned into a duplicate. The keeper
     * saves every couple of seconds, so the copy on the new page is very
     * often a prefix of — or identical to — the one that was stashed.
     */
    group('Putting back a branch nobody wrote on since');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: 'http://board.example/same?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { letter: 'ONE COPY ONLY' } });
      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: 'http://board.example/same?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { letter: 'ONE COPY' } });

      const once = await ask(driver, 'keepTogether', {});
      const letter = once.reply?.data?.work?.letter ?? '';
      check('the letter is not doubled', (letter.match(/ONE COPY/g) ?? []).length === 1, JSON.stringify(letter));
      store.role = 'Platform Engineer';
    }

    /*
     * And refuses when there is no longer anything to put back, rather than
     * dropping the page on screen. `held.at` was written and never read, so a
     * branch left unanswered until the trail went stale merged the old pages
     * over an empty live one — the card on the new job, the toolbar naming
     * the old one.
     */
    group('Putting back a branch that is no longer there');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      const lonely = await ask(driver, 'keepTogether', {});
      check('says there is nothing being held', lonely.reply?.data?.gone === true, JSON.stringify(lonely.reply?.data));
      check('and does not claim to have merged anything', lonely.reply?.data?.ok !== true, JSON.stringify(lonely.reply?.data));

      /*
       * And the two ways the stash outlives what it was going to be merged
       * into. `held.at` was written and never read, and the chip lives in the
       * content script's memory for as long as the page is open — so a branch
       * left unanswered still offered "Same job — put it back" hours later,
       * by which time `readTrail` calls the live trail stale and answers with
       * no pages. The merge then kept the old pages and dropped the page
       * actually on screen: the card on job B, the toolbar naming job A.
       */
      const branchAgain = async () => {
        await ask(driver, 'clearTrail', {});
        store.role = 'Platform Engineer';
        await ask(driver, 'analyze', { url: 'http://board.example/three?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
        await ask(driver, 'saveWork', { work: { letter: 'STALE-BRANCH' } });
        store.role = 'Data Scientist';
        await ask(driver, 'analyze', { url: 'http://board.example/three?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
        store.role = 'Platform Engineer';
      };

      // "Start fresh" pressed in the popup while the chip is still up.
      await branchAgain();
      await ask(driver, 'clearTrail', {});
      const emptied = await ask(driver, 'keepTogether', {});
      check(
        'a trail that has been forgotten is not merged over',
        emptied.reply?.data?.gone === true,
        JSON.stringify(emptied.reply?.data).slice(0, 90),
      );

      // And the same chip pressed long after the stash went stale.
      await branchAgain();
      const aged = await driver.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const key = `jh-branched:${tab.id}`;
        const held = (await chrome.storage.session.get(key))[key];
        if (!held) return false;
        await chrome.storage.session.set({ [key]: { ...held, at: Date.now() - 3 * 60 * 60 * 1000 } });
        return true;
      });
      check('the stash really was aged', aged === true, String(aged));
      const old = await ask(driver, 'keepTogether', {});
      check(
        'and one older than the trail it belongs to is refused',
        old.reply?.data?.gone === true,
        JSON.stringify(old.reply?.data).slice(0, 90),
      );
    }

    /*
     * And the same role reworded is not a different job. A form page that
     * calls itself "Platform Engineer (Remote)" must not split the
     * application somebody is halfway through filling in.
     */
    group('The same job, described slightly differently');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      store.role = 'Platform Engineer';
      await ask(driver, 'analyze', { url: 'http://board.example/jobs?q=a', title: 'A', html: '<p>one</p>', company: 'Helios' });
      store.role = 'Senior Platform Engineer (Remote)';
      const next = await ask(driver, 'analyze', { url: 'http://board.example/jobs?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
      const trail = next.reply?.data?.trail;
      check('it stays one application', (trail?.pages ?? []).length === 2, `${trail?.pages?.length} pages`);
      check('and nothing is asked about it', trail?.branchedFrom === undefined, JSON.stringify(trail?.branchedFrom));
      store.role = 'Platform Engineer';
    }

    /*
     * Muting two sites at once, and neither of them going missing.
     *
     * `mutedHosts` is one array shared by the popup's button and every tab's
     * card, and both changed it the same way: read the settings, add a host,
     * write the whole array back. Two mutes close enough together and the
     * second read happens before the first write lands, so one of them is
     * dropped — a button that said Muted and did nothing, with no way to find
     * out except by meeting the site again.
     *
     * Sent together on purpose: the worker is one process, so the only thing
     * that can make this safe is the write chain inside it.
     */
    group('Two sites muted at the same moment');
    {
      await ask(driver, 'setSettings', { patch: { mutedHosts: [] } });
      const both = await driver.evaluate(
        () =>
          Promise.all(
            ['first.example', 'second.example'].map(
              (host) =>
                new Promise((done) =>
                  chrome.runtime.sendMessage({ type: 'muteHost', payload: { host, muted: true } }, done),
                ),
            ),
          ).then(() =>
            new Promise((done) =>
              chrome.runtime.sendMessage({ type: 'getSettings' }, (reply) => done(reply?.data?.mutedHosts ?? [])),
            ),
          ),
      );
      check('both are muted, not just the later one', both.length === 2, JSON.stringify(both));
      check('and each by name', both.includes('first.example') && both.includes('second.example'), JSON.stringify(both));

      // And unmuting is the same operation backwards.
      const left = await driver.evaluate(
        () =>
          new Promise((done) =>
            chrome.runtime.sendMessage(
              { type: 'muteHost', payload: { host: 'first.example', muted: false } },
              (reply) => done(reply?.data?.mutedHosts ?? []),
            ),
          ),
      );
      check('taking one off leaves the other', JSON.stringify(left) === JSON.stringify(['second.example']), JSON.stringify(left));
    }

    /*
     * A mute Chrome refused is not reported as a mute.
     *
     * `chrome.storage.sync` holds 8KB per item, and a long enough `mutedHosts`
     * is over it. The write chain swallowed the refusal so that one failure
     * would not jam every later change, and swallowed it from the caller too:
     * `muteHost` answered ok, and the popup said "Muted <host>." for a site
     * that was not muted.
     */
    group('A mute the synced settings have no room for');
    {
      const full = Array.from({ length: 229 }, (_, i) => `careers-${i}.example-job-board.com`);
      await ask(driver, 'setSettings', { patch: { mutedHosts: full } });
      const host = 'jobs.another-board-with-a-long-name.example.org';
      const refusedMute = await ask(driver, 'muteHost', { host, muted: true });
      check('the mute is answered as failed', refusedMute.reply?.ok === false, refusedMute.reply?.error ?? 'answered ok');
      check('in words, not Chrome’s', /no room for another muted site/.test(refusedMute.reply?.error ?? ''), refusedMute.reply?.error);
      const after = (await ask(driver, 'getSettings', {})).reply?.data?.mutedHosts ?? [];
      check('and the site is not muted', !after.includes(host) && after.length === full.length, `${after.length} hosts`);
      // The chain is not jammed by the refusal: the next change still lands.
      const freed = await ask(driver, 'muteHost', { host: full[0], muted: false });
      check('a later change still goes through', freed.reply?.ok === true && !freed.reply.data.mutedHosts.includes(full[0]), JSON.stringify(freed.reply?.error));
      await ask(driver, 'setSettings', { patch: { mutedHosts: [] } });

      /*
       * Chrome's limit on writes a minute says "quota" too. Any message
       * with the word in it was read as a full list, so an unmute refused by
       * that limit was told there was no room for another muted site.
       */
      const sw = context.serviceWorkers()[0] ?? worker;
      await sw.evaluate(() => {
        const sync = chrome.storage.sync;
        globalThis.__jhRealSyncSet = sync.set;
        sync.set = async () => {
          throw new Error('This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.');
        };
      });
      try {
        const limited = await ask(driver, 'muteHost', { host: full[1], muted: false });
        check('an unmute refused for writing too often is failed', limited.reply?.ok === false, JSON.stringify(limited.reply));
        check(
          'and not said to be out of room',
          !/no room/.test(limited.reply?.error ?? '') && /MAX_WRITE_OPERATIONS_PER_MINUTE/.test(limited.reply?.error ?? ''),
          limited.reply?.error,
        );
      } finally {
        await sw.evaluate(() => {
          chrome.storage.sync.set = globalThis.__jhRealSyncSet;
        });
      }
    }

    /* ---------------------------------------------------------------- *
     * Holding a space in the editor                                     *
     * ---------------------------------------------------------------- */

    /*
     * The card's keeper saves every two seconds, and each save asks the store
     * to open a Workspace row for the application. That push carries the
     * card's whole spec and the endpoint merges, so it has to happen once:
     * repeating it puts the card's older copy over whatever the person has
     * since rearranged in the editor.
     *
     * "Once" was a Set on the worker, and the worker is stopped whenever the
     * browser likes. So the guard held for as long as nothing interrupted it
     * and was gone the moment something did — which is the one case it was
     * written for, because being in the editor for half a minute is exactly
     * what stops the worker and exactly when there are edits to lose.
     *
     * It also keyed on the company and the role alone, so the same role
     * applied for out of a second save was taken for one already held and
     * never got a row there at all.
     */
    /*
     * And not for a posting somebody only read.
     *
     * `worthKeeping` is true of a spec alone, and the opening read of every
     * posting produces one — so the keeper, saving every couple of seconds,
     * filed a tracker row for every job anybody looked at. A space says work
     * has been done, so it takes something somebody did: a resume compiled,
     * files staged, a letter started, an answer written.
     *
     * What it does *not* take is the form having been filled in. A place to
     * write is wanted before the form is ever opened, so the space opens
     * early and carries `actedOnForm` to say which of the two it is — see
     * `holdASpace`, and the status the store gives it.
     */
    group('A posting that was only read opens nothing');
    {
      const spaces = () => store.sentTo('/api/workspace').length;
      const lastBody = () => JSON.parse(store.sentTo('/api/workspace').slice(-1)[0]?.body || '{}');
      // Its own company and role: `heldKey` is per save, company and role, so
      // borrowing another group's would reserve the key it is about to test.
      const solace = { id: 'job-read', generatedFor: { company: 'Solace', role: 'Reader' } };
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://g.example/jobs/read-only', title: 'Helios', html: '<p>read</p>', company: 'Helios' });

      const before = spaces();
      await ask(driver, 'saveWork', { work: { spec: solace } });
      await new Promise((r) => setTimeout(r, 600));
      check('reading a posting files no draft', spaces() === before, `${spaces() - before} opened`);

      // And the moment something is built, it does.
      await ask(driver, 'saveWork', { work: { spec: solace, render: { pages: 1 } } });
      for (let i = 0; i < 60 && spaces() === before; i++) await new Promise((r) => setTimeout(r, 50));
      check('and building one does', spaces() === before + 1, `${spaces() - before} opened`);

      /*
       * Carrying the fact that nothing has been put in the form yet. Without
       * this the store has only "a workspace was opened" to go on, which it
       * read as `applying` — and a built resume is not an application.
       */
      check('and says the form has not been touched', lastBody().actedOnForm === false, JSON.stringify(lastBody().actedOnForm));

      /*
       * And a second push once it has, which `heldKey` used to swallow: the
       * first hold was keyed on the pair alone, so the row stayed "Not
       * applied" through an application that was filled in and sent.
       */
      await ask(driver, 'saveWork', {
        work: { spec: solace, render: { pages: 1 }, actedOnForm: true },
      });
      for (let i = 0; i < 60 && spaces() === before + 1; i++) await new Promise((r) => setTimeout(r, 50));
      check('filling the form says so, once', spaces() === before + 2, `${spaces() - before} opened`);
      check('and that push carries it', lastBody().actedOnForm === true, JSON.stringify(lastBody().actedOnForm));

      // And not again on every keeper tick after that.
      await ask(driver, 'saveWork', {
        work: { spec: solace, render: { pages: 1 }, actedOnForm: true },
      });
      await new Promise((r) => setTimeout(r, 600));
      check('and says it only the once', spaces() === before + 2, `${spaces() - before} opened`);
    }

    /*
     * Which resume the form is being filled for.
     *
     * Somebody applying to internships and new-grad roles keeps two graduation
     * dates and picks between them per posting. `autofillData` asked the store
     * with no resume named, so the store answered from the default — May, on
     * every internship form, under a resume that says December. The tailored
     * resume's choices are on the trail; they go with the request.
     */
    group('Autofill is answered for the resume being sent');
    {
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://g.example/jobs/intern', title: 'Helios', html: '<p>intern</p>', company: 'Helios' });

      /*
       * The resume itself, not only its choices: a work-history section wants
       * the jobs it lists and the lines it prints, which the wordings alone
       * cannot say. POST, because the card's resume is a proposal the store
       * has not been given.
       */
      const hit = () => store.sentTo('/api/autofill').slice(-1)[0];
      const asked = () => JSON.parse(hit()?.body || '{}');

      await ask(driver, 'autofillData', {});
      check('with nothing built, it asks without a resume of its own', !asked().spec && hit()?.method === 'POST', hit()?.body ?? '(not sent)');

      await ask(driver, 'saveWork', {
        work: {
          spec: { id: 'job-intern', choices: { 'edu_neu.dates': 'v_dec2026' }, generatedFor: { company: 'Helios', role: 'Intern' } },
          render: { pages: 1 },
        },
      });
      await ask(driver, 'autofillData', {});
      const sent = asked();
      check(
        'once a resume is built, it goes with the request, choices and all',
        sent.spec?.id === 'job-intern' && sent.spec?.choices?.['edu_neu.dates'] === 'v_dec2026',
        JSON.stringify(sent),
      );
    }

    group('Holding a space in the editor');
    {
      /*
       * With a compiled resume on it, because that is what opens a space at
       * all: a spec alone is the card's opening read of a posting, and
       * reading a posting no longer files anything. See `madeSomething`.
       */
      const helios = {
        spec: { id: 'job-7', generatedFor: { company: 'Helios', role: 'Platform Engineer' } },
        render: { pages: 1 },
      };
      const spaces = () => store.sentTo('/api/workspace').length;
      /** Wait for the push, which is sent alongside the reply rather than before it. */
      const settle = async (want) => {
        for (let i = 0; i < 60 && spaces() < want; i++) await new Promise((r) => setTimeout(r, 50));
        // And a moment more, so a push that should not happen has time to.
        await new Promise((r) => setTimeout(r, 400));
        return spaces();
      };

      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://g.example/jobs/7', title: 'Helios', html: '<p>seven</p>', company: 'Helios' });
      const before = spaces();
      await ask(driver, 'saveWork', { work: helios });
      await settle(before + 1);
      await ask(driver, 'saveWork', { work: helios });
      const twice = await settle(before + 1);
      check('the keeper saving twice opens one space', twice === before + 1, `${twice - before} pushes`);
      check('into the save the application was built in', lastSaveFor('/api/workspace') === 'work', lastSaveFor('/api/workspace'));

      /*
       * And says that nobody asked for it.
       *
       * This row is opened off whatever the extractor made of the pages
       * somebody walked through, with no button pressed, so the store is
       * allowed to disbelieve the pair and refuse. It can only do that if it
       * can tell this write from `openWorkspace`, which is the card's button
       * and means whatever a person typed into it. The tracker had filled up
       * with `Indeed — Now Hiring: 300 Software Intern Jobs` and a role that
       * was two hundred characters of `preview.redd.it` image url; the guard
       * that stops those lives in the store and is inert without this flag.
       */
      const held = JSON.parse(store.sentTo('/api/workspace').slice(-1)[0]?.body || '{}');
      check('and says nobody asked for it, so the store may refuse it', held.auto === true, JSON.stringify(held).slice(0, 120));

      // The same role, out of a different save. A second application, and it
      // wants its own row — this is the part the company-and-role key lost.
      store.save = 'personal';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://h.example/jobs/8', title: 'Helios', html: '<p>eight</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: helios });
      const elsewhere = await settle(twice + 1);
      check('the same role out of another save opens its own', elsewhere === twice + 1, `${elsewhere - twice} pushes`);
      check('and that one goes to the other save', lastSaveFor('/api/workspace') === 'personal', lastSaveFor('/api/workspace'));

      /*
       * Now stop the worker the way Chrome's idle timer does, and let the
       * keeper's next tick wake it. Nothing about the application has
       * changed, so nothing should be pushed.
       */
      // A mark on the worker's own globals, so "restarted" is something this
      // test observes rather than something it hopes the protocol did.
      await (context.serviceWorkers()[0] ?? worker).evaluate(() => {
        globalThis.__jhStillTheSameWorker = true;
      });
      const cdp = await context.newCDPSession(driver);
      await cdp.send('ServiceWorker.enable').catch(() => undefined);
      await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));

      const woken = await ask(driver, 'saveWork', { work: helios });
      const after = await settle(elsewhere + 1);
      const fresh = await (context.serviceWorkers()[0] ?? worker)
        .evaluate(() => globalThis.__jhStillTheSameWorker !== true)
        .catch(() => false);
      check('the worker really was restarted, and lost its memory with it', fresh && woken.reply?.ok === true, JSON.stringify(woken.reply ?? woken.lastError).slice(0, 120));
      check('and a restarted worker does not push it again', after === elsewhere, `${after - elsewhere} pushes after the restart`);
    }

    /*
     * A refusal is not a retry.
     *
     * The key that stops this write happening twice is dropped whenever it
     * fails, because the usual failure is the store not running — and the
     * next application should go. A refusal is the other thing: the store has
     * read the company and the role and said it is not a job, and it will say
     * so again. Dropped anyway, that is one rejected POST per keeper tick,
     * every couple of seconds, for as long as the tab is open.
     */
    group('A pair the store says is not a job');
    {
      const pushes = () => store.sentTo('/api/workspace').length;
      const junk = {
        spec: { id: 'job-junk', generatedFor: { company: 'Indeed', role: 'Now Hiring: 300 Software Intern Jobs' } },
        render: { pages: 1 },
      };
      store.save = 'work';
      store.routes['/api/workspace'] = 'not-a-job';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://i.example/jobs/junk', title: 'Indeed', html: '<p>junk</p>', company: 'Indeed' });

      const before = pushes();
      await ask(driver, 'saveWork', { work: junk });
      for (let i = 0; i < 60 && pushes() === before; i++) await new Promise((r) => setTimeout(r, 50));
      const tried = pushes();
      check('it is asked about once', tried === before + 1, `${tried - before} pushes`);

      // And then left alone, however many times the keeper saves.
      await ask(driver, 'saveWork', { work: junk });
      await ask(driver, 'saveWork', { work: junk });
      await new Promise((r) => setTimeout(r, 800));
      check('and not asked about again', pushes() === tried, `${pushes() - tried} more`);

      /*
       * Where an outage is not left alone, which is the behaviour this must
       * not have broken: the store being down is nothing to do with this
       * application, and the next save should try again.
       */
      store.routes['/api/workspace'] = 'ok';
      const down = {
        spec: { id: 'job-down', generatedFor: { company: 'Solace', role: 'Reliability Engineer' } },
        render: { pages: 1 },
      };
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://j.example/jobs/down', title: 'Solace', html: '<p>down</p>', company: 'Solace' });
      store.strict = true;
      store.save = 'personal';
      // A write refused for a reason that is not about the pair at all: the
      // editor has moved to another save. That one is retried.
      await ask(driver, 'saveWork', { work: down });
      await new Promise((r) => setTimeout(r, 600));
      const refusedOnce = pushes();
      store.save = 'work';
      await ask(driver, 'saveWork', { work: down });
      for (let i = 0; i < 60 && pushes() === refusedOnce; i++) await new Promise((r) => setTimeout(r, 50));
      check('a refusal that is not about the pair is tried again', pushes() > refusedOnce, `${pushes() - refusedOnce} more`);
    }

    /* ---------------------------------------------------------------- *
     * A reply that arrives and then stops                               *
     * ---------------------------------------------------------------- */

    /*
     * A reply is "received" the moment its status line arrives; the body can
     * take as long as it likes after that. So both the Stop button and the
     * twenty-second ceiling fire inside `res.json()`, and both used to come
     * out as a parse failure: press Stop and the card put up a red strip
     * reading "ResumeM-M sent something that is not JSON (200)." about a run
     * the user had just cancelled.
     */
    group('A reply that arrives and then stops');
    {
      store.routes['/api/extension/analyze'] = 'stall-body';
      const running = ask(driver, 'analyze', { url: 'http://e.example/jobs/5', title: 'Helios', html: '<p>five</p>' });
      await new Promise((r) => setTimeout(r, 700));
      await ask(driver, 'cancelWork', {});
      const stopped = await running;

      const said = stopped.reply?.error ?? '';
      check('pressing Stop is reported as a stop', stopped.reply?.stopped === true || Boolean(stopped.reply?.fix?.stopped) || /stop/i.test(said), JSON.stringify(stopped.reply).slice(0, 160));
      check('and not as the store talking nonsense', !/not JSON/i.test(said), said || '(no error)');
      store.routes['/api/extension/analyze'] = 'ok';
    }

    /*
     * A compile that hangs. The preview compiles had the worker's ten-minute
     * deadline and no Stop: a wedged compile held the card's compile lane,
     * "Compiling…", for ten minutes with no way out short of closing it.
     */
    group('A preview compile that hangs can be stopped');
    for (const [route, type, payload] of [
      ['/api/render', 'render', { spec: { id: 'job-helios' } }],
      ['/api/render/letter', 'renderLetter', { body: 'Dear Helios,', spec: { id: 'job-helios' } }],
    ]) {
      store.routes[route] = 'silent';
      const before = store.hits.length;
      const began = Date.now();
      const running = ask(driver, type, payload);
      // Until the request is at the store, so the stop is of a compile in the air.
      for (let i = 0; i < 100 && !store.hits.slice(before).some((h) => h.url === route); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const told = await ask(driver, 'cancelWork', { what: [type] });
      const stopped = await Promise.race([running, new Promise((r) => setTimeout(() => r(null), 5000))]);
      check(`${type}: Stop lets go of it`, told.reply?.data?.stopped === 1, JSON.stringify(told.reply));
      check(
        `${type}: and it comes back as a stop, at once`,
        stopped !== null && stopped.reply?.ok === false && !/did not answer/i.test(stopped.reply?.error ?? '') && Date.now() - began < 5000,
        stopped ? JSON.stringify(stopped.reply).slice(0, 160) : 'still waiting after 5s',
      );
      store.routes[route] = 'ok';
      for (const res of store.open.splice(0)) res.destroy();
    }

    /*
     * And the same window without a Stop: a server that answers and then
     * wedges got the "not JSON" sentence twenty seconds later, with no button
     * on it, instead of the "did not answer" message that carries one.
     */
    group('A reply that arrives and then never finishes');
    {
      store.routes['/api/extension/analyze'] = 'stall-body';
      const wedged = await ask(driver, 'analyze', { url: 'http://f.example/jobs/6', title: 'Helios', html: '<p>six</p>' });
      const said = wedged.reply?.error ?? '';
      check('is reported as the store not answering', /did not answer/i.test(said), said || '(no error)');
      check('and comes with the way out', wedged.reply?.fix?.fix === 'start-server', JSON.stringify(wedged.reply?.fix ?? null));
      store.routes['/api/extension/analyze'] = 'ok';
    }

    /*
     * `pdfBytes` wants bytes rather than JSON, so it went round `serverFetch`
     * — and took its deadline with it. Against a server that accepts the
     * socket and never answers it never settled: measured at 75 seconds and
     * still waiting, with the card's preview pane a grey strip that never
     * asked again.
     */
    group('Fetching the PDF to draw on the page');
    {
      store.routes['/files/resume.pdf'] = 'silent';
      const got = await ask(driver, 'pdfBytes', { url: '/files/resume.pdf' });
      check('gives up rather than waiting for ever', got.ms < 40_000, `${got.ms}ms`);
      check('and says the store did not answer', /did not answer/i.test(got.reply?.error ?? ''), got.reply?.error ?? '(no error)');
      store.routes['/files/resume.pdf'] = 'ok';
    }

    /*
     * The bank lookup, which is the only place a stored answer becomes
     * something typed into somebody's application. What it lets through
     * matters more than what it fetches: a loose match is a suggestion for a
     * person to read, and putting one into a form is how an application comes
     * to say something its author did not say.
     */
    group('Looking up the answers given before');
    {
      const asked = [
        'Are you willing to relocate for this role?',
        'Something the store matched only loosely',
        'A question with nothing in the bank for it',
      ];
      const got = await ask(driver, 'rememberedAnswers', { questions: asked });
      const answers = got.reply?.data?.answers ?? [];
      check(
        'a confident match comes back with its question beside it',
        answers.length === 1 && answers[0].question === asked[0],
        JSON.stringify(answers),
      );
      check(
        'and its answer, which is what gets typed',
        answers[0]?.answer === `answer to ${asked[0]}`,
        answers[0]?.answer ?? '(none)',
      );
      check('a loose match is not offered', !answers.some((a) => /loosely/.test(a.question)), JSON.stringify(answers));
      check(
        'nor is a confident match with nothing to say',
        !answers.some((a) => /nothing in the bank/.test(a.question)),
        JSON.stringify(answers),
      );

      const before = store.sentTo('/api/answers/match').length;
      const none = await ask(driver, 'rememberedAnswers', { questions: [] });
      check(
        'a page with no questions does not ask the store at all',
        store.sentTo('/api/answers/match').length === before && none.reply?.data?.answers?.length === 0,
        `${store.sentTo('/api/answers/match').length - before} extra requests`,
      );

      /*
       * And a store that is not answering leaves the form exactly as it was.
       * This runs behind the Autofill button somebody already pressed, so a
       * throw here would take the whole fill down — every profile field
       * unfilled because the optional half could not reach the bank.
       */
      store.routes['/api/answers/match'] = 'silent';
      const wedged = await ask(driver, 'rememberedAnswers', { questions: ['Are you willing to relocate?'] });
      check(
        'a store that never answers gives back nothing rather than failing',
        Array.isArray(wedged.reply?.data?.answers) && wedged.reply.data.answers.length === 0,
        JSON.stringify(wedged.reply ?? null),
      );
      store.routes['/api/answers/match'] = 'ok';
    }

    /*
     * An AI pass overtaken by another press on the same page stays overtaken.
     *
     * Every build the card starts takes a number in the content script, and a
     * reply whose number is stale is handed to `landLate` — which was written
     * for a pass the page had moved on from, and lands it on the card if the
     * posting is the same one. On the same page it always is. So pressing Have
     * AI Tailor, then choosing another resume to start from while it read,
     * showed the new base's proposal and then — when the model answered — put
     * the AI's proposal from the *old* base over it, with "The AI finished
     * tailoring this posting" and its button lit. That is what would have
     * been built and sent: a resume from the base just turned away from.
     *
     * Through a real page and the real content script, because that is where
     * the number and `landLate` live; the store is the fake one above.
     */
    group('An AI pass overtaken on the same page does not land');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer`;
      await driver.evaluate(() => chrome.storage.sync.set({ useAi: true, baseResumeId: 'newgrad' }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const job = await context.newPage();
      let seen = {};
      try {
        await job.goto(where);
        await job.waitForTimeout(500);
        await driver.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          await chrome.tabs.sendMessage(tab.id, { type: 'show-card' });
        }, where);
        const card = job.locator('#jobhelper-card-host');
        const ai = card.locator('button.mode', { hasText: 'Have AI Tailor' });
        await ai.waitFor({ timeout: 15_000 });
        await job.waitForFunction(
          () => {
            const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
            const b = [...(root?.querySelectorAll('button.mode') ?? [])].find((x) => /Have AI Tailor/.test(x.textContent));
            return b && !b.disabled && root.querySelector('select option[value="intern"]');
          },
          null,
          { timeout: 15_000 },
        );

        store.heldAi = [];
        await ai.click();
        for (let i = 0; i < 100 && store.heldAi.length === 0; i++) await job.waitForTimeout(50);
        const asked = store.heldAi.length;

        // Another base, while the model reads.
        const before = store.sentTo('/api/extension/analyze').length;
        await card.locator('select').selectOption('intern');
        for (let i = 0; i < 100 && store.sentTo('/api/extension/analyze').length === before; i++) await job.waitForTimeout(50);
        await job.waitForTimeout(700);

        // And now the model answers, for the base that was turned away from.
        for (const reply of store.heldAi) reply();
        store.heldAi = null;
        await job.waitForTimeout(1200);

        seen = await job.evaluate(() => {
          const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return {
            lit: root?.querySelector('.mode.on')?.textContent?.trim() ?? null,
            said: [...(root?.querySelectorAll('.ok-note') ?? [])].map((n) => n.textContent).join(' | '),
          };
        });
        seen.asked = asked;
      } finally {
        store.heldAi = null;
        await job.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ useAi: false, baseResumeId: 'newgrad' }));
      }

      check('the AI really was reading when the base changed', seen.asked === 1, JSON.stringify(seen));
      check(
        'its answer for the old base is not put over the new one',
        typeof seen.lit === 'string' && !/AI/.test(seen.lit),
        JSON.stringify(seen),
      );
      check('nor announced as this posting’s', !/AI finished tailoring this posting/.test(seen.said ?? ''), JSON.stringify(seen));
    }

    /*
     * A page that failed to be read is not read again every second.
     *
     * The rescore tick in content.js runs on any DOM change for the first
     * minute, and only a verdict used to settle a page — so a read that
     * failed was retried on the next tick, and the next. On a results page
     * whose timestamps tick, with the store failing, the whole page was
     * copied and posted once a second: measured at twelve posts in twelve
     * seconds, 1.9 seconds of main thread, on a page of 22,500 elements.
     *
     * The page is one the card does not put itself up on early — a results
     * list names no role — so nothing on screen says anything is happening.
     */
    group('A page whose read failed is not re-read on every change');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        /*
         * Read because the board says what its results are, in the JobPosting
         * data boards put beside them. It used to be read for `/jobs/` in its
         * address, which is no longer reason enough to read a page unasked —
         * Jenkins puts every build log under `/job/` — and a page the chip asks
         * about is not read at all, failed or not.
         */
        res.end(`<!doctype html><title>Engineering jobs in Boston | Board</title>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"JobPosting","title":"Engineer"}]}</script>
          <h1>Search results</h1><div class="count">24 jobs found</div>
          <ul>${'<li>Engineer, full-time. Responsibilities and requirements inside. <time>1 day ago</time></li>'.repeat(24)}</ul>
          <script>let n = 0; setInterval(() => { document.querySelector('time').textContent = (++n) + ' seconds ago'; }, 100);</script>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/search?q=engineer`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.routes['/api/extension/analyze'] = 'broken';

      const page = await context.newPage();
      let reads = 0;
      try {
        const before = store.sentTo('/api/extension/analyze').length;
        await page.goto(where);
        await page.waitForTimeout(5000);
        reads = store.sentTo('/api/extension/analyze').length - before;
      } finally {
        delete store.routes['/api/extension/analyze'];
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('the page was read', reads >= 1, `${reads} reads`);
      check('once, rather than on every tick of the page', reads === 1, `${reads} reads in five seconds`);
    }

    /*
     * A page that swaps its whole root element once the posting has loaded.
     *
     * The rescore tick only looks again when its MutationObserver has seen
     * the page change, and the observer was attached to
     * `document.documentElement` — the element, not the document. A page that
     * builds the finished document off to one side and puts it in with
     * `document.replaceChild(next, document.documentElement)` leaves the
     * observer watching the old root, detached, where nothing ever changes
     * again. The shell was scored, found wanting, and the posting that
     * replaced it was never looked at: no card, on a page whose title names
     * the role and whose JSON-LD says JobPosting.
     */
    group('A page that replaces its root element is still watched');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Loading</title><p>Loading…</p>
          <script>
            setTimeout(() => {
              const next = document.createElement('html');
              next.innerHTML = '<head><title>Platform Engineer at Helios</title>' +
                '<script type="application/ld+json">{"@type":"JobPosting","title":"Platform Engineer"}<\\/script></head>' +
                '<body><h1>Platform Engineer</h1><p>Helios is hiring. Responsibilities: build the platform. ' +
                'Requirements: Go. Apply now to join our team.</p></body>';
              document.replaceChild(next, document.documentElement);
            }, 1500);
          </script>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/p/8f2a1b`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const page = await context.newPage();
      let seen = {};
      try {
        await page.goto(where);
        await page.waitForTimeout(6000);
        seen = await page.evaluate(() => ({
          title: document.title,
          card: Boolean(document.querySelector('#jobhelper-card-host')),
        }));
      } finally {
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('the page did replace its root', seen.title === 'Platform Engineer at Helios', JSON.stringify(seen));
      check('and the posting it became gets its card', seen.card === true, JSON.stringify(seen));
    }

    /*
     * A page that throws the card out, and the card that should come back.
     *
     * The card's host is a child of `<html>`, and a page that re-renders its
     * whole root — a framework whose hydration gives up and client-renders
     * the document, anything calling `replaceChildren` on it — takes the host
     * with it. The content script still held the handle, so every route back
     * short-circuited on a card that was no longer in the document: the tick
     * saw a card and stayed quiet, and the toolbar button's `putUpCard`
     * returned the detached handle and put up nothing. The letter and the
     * answers were still in it, on no screen at all.
     */
    group('A card the page throws out comes back, as it was');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const page = await context.newPage();
      let seen = {};
      try {
        await page.goto(where);
        await page.locator('#jobhelper-card-host .card').waitFor({ timeout: 15_000 });
        // Marked in the page's world, so the one that comes back can be told
        // from a fresh card built to replace it.
        seen.thrownOut = await page.evaluate(() => {
          const host = document.querySelector('#jobhelper-card-host');
          host.__before = true;
          document.documentElement.replaceChildren(document.head, document.body);
          return !host.isConnected;
        });
        await page.waitForTimeout(2500);
        seen.after = await page.evaluate(() => {
          const host = document.querySelector('#jobhelper-card-host');
          return { back: Boolean(host), same: host?.__before === true };
        });
      } finally {
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('the page really did throw the card out', seen.thrownOut === true, JSON.stringify(seen));
      check('and it is back on the page', seen.after?.back === true, JSON.stringify(seen));
      check('the same card, with whatever was in it', seen.after?.same === true, JSON.stringify(seen));
    }

    /*
     * The page cannot work the card, or read it.
     *
     * The card's root was open and it ran any click it was given, so a page
     * script could find "Autofill this form" through `host.shadowRoot`,
     * `.click()` it, and read the person's profile back out of its own
     * inputs — and read the resume and the letter off the card's text on the
     * way. A press here is "Build resume", because the store sees it: a
     * page's `.click()` must not reach the store, and Playwright's, which is
     * real input, must.
     */
    group('A page script cannot press the card, or see into it');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const seen = {};
      const page = await context.newPage();
      try {
        await page.goto(where);
        const build = page.locator('#jobhelper-card-host button', { hasText: /^Build resume$/ });
        await build.waitFor({ timeout: 15_000 });
        await page.waitForFunction(
          () => {
            const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
            return [...(root?.querySelectorAll('button') ?? [])].some((b) => /^Build resume$/.test(b.textContent.trim()) && !b.disabled);
          },
          null,
          { timeout: 15_000 },
        );
        const renders = () => store.sentTo('/api/render').length;
        const before = renders();
        // The page's own script, pressing the button the way any script can.
        seen.pressedByPage = await page.evaluate(() => {
          const root = document.querySelector('#jobhelper-card-host').shadowRoot;
          const button = [...root.querySelectorAll('button')].find((b) => /^Build resume$/.test(b.textContent.trim()));
          button.click();
          button.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
          button.focus();
          button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
          return button.textContent.trim();
        });
        await page.waitForTimeout(1500);
        seen.afterPage = renders() - before;
        /*
         * And the extension's files are not at an address a page can know:
         * at the fixed one, any page could fetch them and so tell that this
         * extension is installed, and which version.
         */
        seen.fetchedByPage = await page.evaluate(async (id) => {
          try {
            const res = await fetch(`chrome-extension://${id}/src/shared/sites.js`);
            return `fetched ${res.status}`;
          } catch (err) {
            return `refused: ${err.message}`;
          }
        }, extensionId);
        // And a person, pressing the same button.
        await build.click();
        for (let i = 0; i < 100 && renders() === before; i++) await page.waitForTimeout(50);
        seen.afterPerson = renders() - before;
      } finally {
        await page.close();
      }

      /*
       * And, as it is in use rather than under test, the root is closed: the
       * page finds the host and nothing under it.
       */
      await driver.evaluate((key) => chrome.storage.local.remove(key), OPEN_SHADOW_FLAG);
      const closed = await context.newPage();
      try {
        await closed.goto(where);
        await closed.waitForSelector('#jobhelper-card-host', { state: 'attached', timeout: 15_000 });
        // Long enough for the card to be drawn into the root it keeps to itself.
        await closed.waitForTimeout(1500);
        seen.closed = await closed.evaluate(() => {
          const host = document.querySelector('#jobhelper-card-host');
          return { host: Boolean(host), root: host?.shadowRoot ?? null, text: host?.textContent ?? '', drawn: host?.getBoundingClientRect().height ?? 0 };
        });
      } finally {
        await closed.close();
        site.close();
        await driver.evaluate((key) => chrome.storage.local.set({ [key]: true }), OPEN_SHADOW_FLAG);
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('the page could find the button (the root is open for this test)', seen.pressedByPage === 'Build resume', JSON.stringify(seen));
      check("a page script's .click(), click event and Enter do nothing", seen.afterPage === 0, JSON.stringify(seen));
      check('while a real press of the same button does', seen.afterPerson >= 1, JSON.stringify(seen));
      check("and a page cannot fetch the extension's files by its fixed address", /^refused/.test(seen.fetchedByPage ?? ''), String(seen.fetchedByPage));
      check(
        'in use, the card is on the page and its root is closed to it',
        seen.closed?.host === true && seen.closed.root === null && seen.closed.text === '',
        JSON.stringify(seen.closed),
      );
    }

    /*
     * The receipt watcher, only in a tab that is applying.
     *
     * It ran on every top-level page anybody opened, for a quarter of an
     * hour, re-reading the page's headings on every change of it, to find a
     * sentence that only means anything in a tab with an application in it.
     * Heard from here as the message it sends: a content script's messages
     * reach the extension's own pages as well as the worker.
     */
    /*
     * A tab that once held a job, and the next page opened in it.
     *
     * Looking at a posting with a form leaves work in the tab without anybody
     * writing a word: the card stages its files as soon as it knows what the
     * form wants, and the answer bank fills in the questions it recognises.
     * `openHere` took that for "something written", and "something written"
     * was enough on its own — so the next page in the tab, a chat client
     * typed into the address bar, was read whole and sent to be analysed,
     * past the score gate and without the chip, and so was every page after
     * it for the trail's two hours. And `applicationInTab` said yes to every
     * one of them, so each ran the receipt watcher over its every change for
     * a quarter of an hour, for a receipt the worker refuses anyway for being
     * on another site. Measured in the hunt's `carry.mjs`.
     *
     * Asked of the worker directly, because the answer is the whole of it:
     * the content script reads the page exactly when `open` and either of
     * `made` or `carriesOn` are true.
     */
    group('A tab that once held a job does not carry it onto every page after');
    {
      store.save = 'work';
      store.role = 'Platform Engineer';
      store.company = 'Streamly';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', {
        url: 'http://jobs.example/streamly/jobs/123',
        title: 'Platform Engineer at Streamly',
        html: '<h1>Platform Engineer</h1><form><input name="email"></form>',
        company: 'Streamly',
      });
      // What the card leaves behind on its own on a posting with a form.
      await ask(driver, 'saveWork', {
        work: {
          spec: { id: 'job-fake', generatedFor: { company: 'Streamly', role: 'Platform Engineer' } },
          staged: { currentDir: '/tmp/streamly' },
          answersByQuestion: { 'Why are you interested in this role?': 'answer to it' },
        },
      });
      const carried = (reply) => Boolean(reply?.open && (reply?.made || reply?.carriesOn));
      const chat = { url: 'http://chat.example/client/T1/C1', title: 'general - Workspace - Chat' };
      const atChat = (await ask(driver, 'openHere', { page: chat })).reply?.data;
      check('the trail is there to be carried', atChat?.open === true, JSON.stringify(atChat));
      check("an unrelated page next in the tab is not read on the application's account", !carried(atChat), JSON.stringify(atChat));

      // The ways an application really does carry on, which must still.
      const sentOn = (await ask(driver, 'openHere', {
        page: { url: 'https://acme.bytedance.example/n/c/8f2a1b', title: 'Apply', referrerHost: 'jobs.example' },
      })).reply?.data;
      check('a form on another site, reached from the posting, still is', carried(sentOn), JSON.stringify(sentOn));
      const ownSteps = (await ask(driver, 'openHere', {
        page: { url: 'http://jobs.example/streamly/jobs/123/apply', title: 'Apply' },
      })).reply?.data;
      check("and so is the next step down the posting's own address", carried(ownSteps), JSON.stringify(ownSteps));

      const watched = async (payload) => (await ask(driver, 'applicationInTab', payload)).reply?.data?.open;
      check('the chat client is not watched for a receipt', (await watched({ url: chat.url })) === false);
      check('a page on the posting\'s own site is', (await watched({ url: 'http://jobs.example/streamly/thanks' })) === true);
      check(
        'and so is a frame of another host inside it',
        (await watched({ url: 'https://boards.greenhouse.io/streamly/jobs/1', above: ['http://jobs.example'] })) === true,
      );
      await ask(driver, 'clearTrail', {});
      store.company = undefined;
    }

    group('Watching for a receipt only where there is an application');
    {
      const site = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        if (req.url.startsWith('/thanks')) {
          res.end('<!doctype html><title>Acme</title><h1>Thank you for applying</h1><p>We will be in touch.</p>');
          return;
        }
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const origin = `http://127.0.0.1:${site.address().port}`;
      await driver.evaluate(() => {
        window.heardTypes = [];
        chrome.runtime.onMessage.addListener((message) => {
          window.heardTypes.push(message?.type);
        });
      });
      const heard = () => driver.evaluate(() => window.heardTypes.splice(0));
      const seen = {};
      const stranger = await context.newPage();
      try {
        await heard();
        await stranger.goto(`${origin}/thanks`);
        await stranger.waitForTimeout(2000);
        seen.noApplication = await heard();
      } finally {
        await stranger.close();
      }
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;
      const applying = await context.newPage();
      try {
        await applying.goto(`${origin}/jobs/platform-engineer`);
        await applying.locator('#jobhelper-card-host .card').waitFor({ timeout: 15_000 });
        await heard();
        // The same document saying it, as Workday's dialog does.
        await applying.evaluate(() => {
          const said = document.createElement('h1');
          said.textContent = 'Thank you for applying';
          document.body.append(said);
        });
        await applying.waitForTimeout(2000);
        seen.applying = await heard();
      } finally {
        await applying.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }
      check(
        'a page that says "Thank you for applying" in a tab with no application is not watched',
        !seen.noApplication.includes('applicationSentHere'),
        JSON.stringify(seen.noApplication),
      );
      check('while one with a card on it is, and says so', seen.applying.includes('applicationSentHere'), JSON.stringify(seen.applying));
    }

    /*
     * A choice made once is remembered once.
     *
     * Every pass that finds an application form starts watching it for the
     * choices made on it — and threw away the function that stops watching.
     * A pass runs on every url change of a single-page form, on every press
     * of the toolbar button, on a return from the back / forward cache; each
     * one added another pair of document listeners. So a form walked through
     * three steps by `pushState` sent each answer to the store four times,
     * and every click on a radio ran a whole-document scan once per listener.
     */
    group('A choice made once is sent to the bank once');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Apply for Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1>
          <form>
            <label for="fn">First name</label><input id="fn" name="first_name">
            <label for="ln">Last name</label><input id="ln" name="last_name">
            <label for="em">Email</label><input id="em" type="email" name="email">
            <label for="cv">Resume</label><input id="cv" type="file">
            <label for="heard">How did you hear about this job?</label>
            <select id="heard"><option value="">Select…</option><option>LinkedIn</option><option>A friend</option></select>
            <button type="button">Next</button>
          </form>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer/apply`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const page = await context.newPage();
      let sent = null;
      try {
        await page.goto(where);
        await page.locator('#jobhelper-card-host .card').waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        // Three steps of a single-page form, each its own address.
        for (const step of [2, 3, 4]) {
          await page.evaluate((n) => history.pushState({}, '', `?step=${n}`), step);
          await page.waitForTimeout(2500);
        }
        const before = store.sentTo('/api/answers/save').length;
        await page.selectOption('#heard', 'LinkedIn');
        await page.waitForTimeout(1000);
        sent = store
          .sentTo('/api/answers/save')
          .slice(before)
          .map((h) => JSON.parse(h.body || '{}').answer);
      } finally {
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('the choice is remembered', (sent ?? []).includes('LinkedIn'), JSON.stringify(sent));
      check('once, however many times the page was looked at', sent?.length === 1, JSON.stringify(sent));
    }

    /*
     * A form that moves to its next step in place, and the card's list of
     * its questions.
     *
     * Questions were read once, when the card went up, and again only on a
     * url change. A form that draws step two where step one was — a React
     * step component, the url untouched — left the card listing step one's
     * question under "Application questions", with its answer box and its
     * Insert button, while the page asked something else. Insert has since
     * refused a box that asks another question, and says so; the list itself
     * went on naming the question that was gone, and step two's new one was
     * never offered at all.
     */
    group('A form that moves to its next step in place');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Apply for Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1>
          <form id="f">
            <label for="fn">First name</label><input id="fn" name="first_name">
            <label for="ln">Last name</label><input id="ln" name="last_name">
            <label for="em">Email</label><input id="em" type="email" name="email">
            <label for="cv">Resume</label><input id="cv" type="file">
            <label id="q-label" for="q-box">Why do you want to work at Helios?</label>
            <textarea id="q-box" name="step1_why"></textarea>
            <button type="button" id="next">Next</button>
          </form>
          <script>
            // Step two, drawn into step one's place: the same box under a new
            // label, and a second box that step one did not have.
            document.getElementById('next').addEventListener('click', () => {
              document.getElementById('q-label').textContent = 'Describe a time you failed.';
              document.getElementById('q-box').name = 'step2_failure';
              document.getElementById('next').insertAdjacentHTML('beforebegin',
                '<label for="q-two">What would you build first on our platform?</label>' +
                '<textarea id="q-two" name="step2_build"></textarea>');
            });
          </script>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer/apply`;
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const page = await context.newPage();
      const listed = () =>
        page
          .locator('#jobhelper-card-host .card .q .qt')
          .evaluateAll((els) => els.map((el) => el.firstChild?.textContent ?? ''))
          .catch(() => []);
      let before = [];
      let after = [];
      try {
        await page.goto(where);
        await page.locator('#jobhelper-card-host .card').waitFor({ timeout: 15_000 });
        await page.locator('#jobhelper-card-host .card .q').first().waitFor({ timeout: 15_000 });
        // A question the page never showed, typed in by hand. It is on no
        // step, so no step's reading may take it off the list.
        page.once('dialog', (d) => d.accept('What is your notice period?'));
        await page.locator('#jobhelper-card-host .card').getByRole('button', { name: '+ Question' }).click();
        await page.waitForTimeout(500);
        before = await listed();
        await page.click('#next');
        await page.waitForTimeout(4000);
        after = await listed();
      } finally {
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }

      check('step one’s question is listed first', before.includes('Why do you want to work at Helios?'), JSON.stringify(before));
      check(
        'after the step changes in place, the card lists step two’s questions',
        after.includes('Describe a time you failed.') && after.includes('What would you build first on our platform?'),
        JSON.stringify(after),
      );
      check('and not the question that has gone', !after.includes('Why do you want to work at Helios?'), JSON.stringify(after));
      check('while a question typed in by hand stays', after.includes('What is your notice period?'), JSON.stringify(after));
    }

    /*
     * "Back to it", from the page it would take you back to.
     *
     * The panel is there whenever the tab holds an application, which
     * includes the application's own form — and the button navigates the tab
     * to the trail's last page, which is then the page on screen. Measured:
     * pressed there, the form reloaded and what had been typed into the
     * employer's boxes was gone.
     */
    group('The popup on the page it would send you back to');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Apply for Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1>
          <form>
            <label for="fn">First name</label><input id="fn" name="first_name">
            <label for="ln">Last name</label><input id="ln" name="last_name">
            <label for="em">Email</label><input id="em" type="email" name="email">
            <label for="cv">Resume</label><input id="cv" type="file">
            <label for="why">Why do you want to work at Helios?</label><textarea id="why" name="why"></textarea>
          </form>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const page = await context.newPage();
      const popup = await context.newPage();
      let offered = null;
      let panel = false;
      let typed = null;
      try {
        await page.goto(`http://127.0.0.1:${site.address().port}/jobs/platform-engineer/apply`);
        await page.locator('#jobhelper-card-host .card').waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        await page.fill('#why', 'Typed into the form by hand.');

        // A real popup reports on the page beneath it; opened as a tab, it
        // has to be booted again with the page in front.
        await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
        await page.bringToFront();
        await popup.evaluate(() => location.reload());
        await popup.locator('#openApplication').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        panel = !(await popup.locator('#openApplication').isHidden());
        offered = await popup.locator('#backToApplication').isVisible();
        if (offered) {
          await popup.locator('#backToApplication').click().catch(() => undefined);
          await page.waitForTimeout(2000);
        }
        typed = await page.inputValue('#why').catch(() => null);
      } finally {
        await popup.close().catch(() => undefined);
        await page.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
      }
      check('the panel says which application this is', panel);
      check('without offering to go back to the page already on screen', offered === false, `offered: ${offered}`);
      check('and what was typed into the form is still there', typed === 'Typed into the form by hand.', JSON.stringify(typed));
    }

    /*
     * "Turn off", beside "AI on".
     *
     * It flipped ResumeM-M's own switch — the one the editor's AI answers to
     * as well — and left this extension's ticked, so the panel then read
     * "Switched off in ResumeM-M" in amber with a "Turn it on" button, as
     * though something were wrong, directly after being asked to turn it off.
     */
    group('Turning the AI off from the popup');
    {
      await driver.evaluate(() => chrome.storage.sync.set({ useAi: true }));
      const configBefore = store.sentTo('/api/config').length;
      const popup = await context.newPage();
      let before = null;
      let after = null;
      try {
        await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
        const read = () =>
          popup.evaluate(() => ({
            state: document.getElementById('aiState').textContent,
            fix: document.getElementById('aiFix').hidden ? null : document.getElementById('aiFix').textContent,
            ticked: document.getElementById('useAi').checked,
          }));
        await popup.waitForFunction(() => document.getElementById('aiState').textContent === 'AI on', null, { timeout: 10_000 }).catch(() => undefined);
        before = await read();
        await popup.locator('#aiFix').click();
        await popup.waitForTimeout(1500);
        after = await read();
      } finally {
        await popup.close().catch(() => undefined);
      }
      const useAi = (await driver.evaluate(() => chrome.storage.sync.get('useAi'))).useAi;
      check('the popup starts at "AI on", offering to turn it off', before?.state === 'AI on' && before?.fix === 'Turn off', JSON.stringify(before));
      check('turning it off leaves ResumeM-M’s own switch alone', store.sentTo('/api/config').length === configBefore, `${store.sentTo('/api/config').length - configBefore} PUTs`);
      check('and turns off this extension’s instead', useAi === false && after?.ticked === false, JSON.stringify({ useAi, after }));
      check('so the panel says it is off, not that something needs fixing', after?.state === 'AI off', JSON.stringify(after));
    }

    /*
     * The worker stopped while the AI is reading.
     *
     * Chrome stops an extension's worker when it likes — an update, memory
     * pressure, a crash — and a reply the card is waiting on goes with it.
     * Nothing hangs: the channel closes and the card's request fails. But
     * what it failed with was Chrome's own sentence, put on the card as it
     * was: "A listener indicated an asynchronous response by returning true,
     * but the message channel closed before a response was received".
     */
    group('The worker is stopped while the AI is reading');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer`;
      await driver.evaluate(() => chrome.storage.sync.set({ useAi: true, baseResumeId: 'newgrad' }));
      store.role = 'Platform Engineer';
      store.company = undefined;

      const job = await context.newPage();
      let seen = {};
      try {
        await job.goto(where);
        await job.waitForTimeout(500);
        await driver.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          await chrome.tabs.sendMessage(tab.id, { type: 'show-card' });
        }, where);
        const card = job.locator('#jobhelper-card-host');
        const ai = card.locator('button.mode', { hasText: 'Have AI Tailor' });
        await ai.waitFor({ timeout: 15_000 });
        await job.waitForFunction(
          () => {
            const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
            const b = [...(root?.querySelectorAll('button.mode') ?? [])].find((x) => /Have AI Tailor/.test(x.textContent));
            return b && !b.disabled;
          },
          null,
          { timeout: 15_000 },
        );

        store.heldAi = [];
        await ai.click();
        for (let i = 0; i < 100 && store.heldAi.length === 0; i++) await job.waitForTimeout(50);
        seen.asked = store.heldAi.length;

        // Marked, so the stop is proved rather than assumed.
        await context.serviceWorkers()[0].evaluate(() => {
          self.__sameWorker = true;
        });
        const cdp = await context.newCDPSession(job);
        await cdp.send('ServiceWorker.enable').catch(() => undefined);
        await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
        await job.waitForTimeout(2500);
        // Anything through the worker brings it back.
        await driver.evaluate(() => chrome.runtime.sendMessage({ type: 'getSettings' })).catch(() => undefined);
        seen.stopped = !(await (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')))
          .evaluate(() => Boolean(self.__sameWorker))
          .catch(() => false));
        seen.said = await job.evaluate(() => document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card')?.innerText ?? '');
      } finally {
        store.heldAi = null;
        await job.close();
        site.close();
        await driver.evaluate(() => chrome.storage.sync.set({ useAi: false, baseResumeId: 'newgrad' }));
      }

      check('the AI really was reading, and the worker really was stopped', seen.asked === 1 && seen.stopped === true, JSON.stringify({ asked: seen.asked, stopped: seen.stopped }));
      check('the card does not show Chrome’s own words for it', !/listener indicated|message channel closed/i.test(seen.said), seen.said.split('\n').slice(-1)[0]);
      check('it says what happened and that it can be run again', /stopped[^.]*before[^.]*finished[\s\S]*again/i.test(seen.said), seen.said.split('\n').slice(-1)[0]);
    }

    /*
     * The worker stopped while it was opening a space.
     *
     * The mark that says "this application has its space" is written before
     * the POST goes, so two keeper ticks cannot both send, and taken away
     * again if the POST fails. A worker that is stopped mid-POST runs neither
     * half of that: measured, the POST never answered, no row was opened, and
     * after the restart three more saves sent nothing — the mark said held.
     */
    group('The worker is stopped while it is opening a space');
    {
      const orion = {
        spec: { id: 'job-orion', generatedFor: { company: 'Orion', role: 'Site Reliability Engineer' } },
        render: { pages: 1 },
      };
      const spaces = () => store.sentTo('/api/workspace').length;
      store.save = 'work';
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://orion.example/jobs/1', title: 'Orion', html: '<p>orion</p>', company: 'Orion' });

      const before = spaces();
      store.routes['/api/workspace'] = 'silent';
      ask(driver, 'saveWork', { work: orion }).catch(() => undefined);
      for (let i = 0; i < 100 && spaces() === before; i++) await new Promise((r) => setTimeout(r, 50));
      const asked = spaces() - before;

      await (context.serviceWorkers()[0] ?? worker).evaluate(() => {
        globalThis.__jhStillTheSameWorker = true;
      });
      const cdp = await context.newCDPSession(driver);
      await cdp.send('ServiceWorker.enable').catch(() => undefined);
      await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1000));
      delete store.routes['/api/workspace'];

      const woken = await ask(driver, 'saveWork', { work: orion });
      for (let i = 0; i < 60 && spaces() < before + 2; i++) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 400));
      const fresh = await (context.serviceWorkers()[0] ?? worker)
        .evaluate(() => globalThis.__jhStillTheSameWorker !== true)
        .catch(() => false);
      const afterRetry = spaces();
      await ask(driver, 'saveWork', { work: orion });
      await new Promise((r) => setTimeout(r, 600));

      check('the POST went, and the worker was stopped under it', asked === 1 && fresh && woken.reply?.ok === true, JSON.stringify({ asked, fresh }));
      check('the space is asked for again once the worker is back', afterRetry === before + 2, `${afterRetry - before - 1} pushes after the restart`);
      check('and once only', spaces() === before + 2, `${spaces() - before} pushes in all`);
    }

    /*
     * The popup on a page no extension can run on.
     *
     * A new tab, chrome://anything, the extensions page: content scripts are
     * never allowed there, and Autofill and "Open on this page" both said
     * "JobHelper is not running on this page. Reload the tab and try again."
     * — advice that cannot work, however many times it is followed. No web
     * page is open here, so the popup falls back to its own tab, which is
     * exactly such a page.
     */
    group('The popup on a page no extension can run on');
    {
      const popup = await context.newPage();
      const said = {};
      try {
        await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
        await popup.waitForTimeout(1500);
        for (const [name, button] of [['autofill', '#autofill'], ['show', '#show']]) {
          await popup.locator(button).click();
          await popup.waitForTimeout(800);
          said[name] = (await popup.locator('#status').textContent().catch(() => '')) ?? '';
        }
      } finally {
        await popup.close().catch(() => undefined);
      }
      check('Autofill does not tell you to reload the tab', !/reload/i.test(said.autofill) && /does not run/i.test(said.autofill), said.autofill);
      check('nor does "Open on this page"', !/reload/i.test(said.show) && /does not run/i.test(said.show), said.show);
    }

    /*
     * Out to the editor for longer than the worker stays awake.
     *
     * "Edit in ResumeM-M" notes the tab, and coming back to it tells the card
     * the store may have changed under its proposal. The note was a Set in
     * the worker's memory, on the reasoning that a worker asleep long enough
     * to forget it means a trip too old to mention — but Chrome stops the
     * worker after half a minute without an event, and a tab left behind has
     * its timers throttled to about one a minute after five, so the card's
     * keeper stops keeping it awake. Adding a phrasing takes longer than
     * that. Measured with the worker stopped while the editor was open: back
     * on the posting, nothing said the match was out of date.
     */
    group('Back from the editor after the worker has been stopped');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = `http://127.0.0.1:${site.address().port}/jobs/platform-engineer`;
      store.role = 'Platform Engineer';
      store.company = undefined;

      const job = await context.newPage();
      let editor = null;
      let said = '';
      let stopped = false;
      try {
        await job.goto(where);
        await job.waitForTimeout(500);
        await driver.evaluate(async (url) => {
          const [tab] = await chrome.tabs.query({ url });
          await chrome.tabs.sendMessage(tab.id, { type: 'show-card' });
        }, where);
        const card = job.locator('#jobhelper-card-host');
        const edit = card.getByRole('button', { name: 'Edit in ResumeM-M' });
        await edit.waitFor({ timeout: 15_000 });
        await job.waitForTimeout(1000);

        const opened = context.waitForEvent('page');
        await edit.click();
        editor = await opened;
        await editor.waitForLoadState('domcontentloaded').catch(() => undefined);

        await (context.serviceWorkers()[0] ?? worker).evaluate(() => {
          globalThis.__jhStillTheSameWorker = true;
        });
        const cdp = await context.newCDPSession(editor);
        await cdp.send('ServiceWorker.enable').catch(() => undefined);
        await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
        await editor.waitForTimeout(1000);

        await job.bringToFront();
        await job
          .waitForFunction(
            () => /been editing the store/i.test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''),
            undefined,
            { timeout: 5_000, polling: 100 },
          )
          .catch(() => undefined);
        said = await job.evaluate(() => document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? '');
        stopped = await (context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')))
          .evaluate(() => globalThis.__jhStillTheSameWorker !== true)
          .catch(() => false);
      } finally {
        await editor?.close().catch(() => undefined);
        await job.close();
        site.close();
      }
      check('the worker really was stopped while the editor was open', stopped);
      check('and on coming back the card still says the match may be out of date', /been editing the store/i.test(said), said.slice(-160));
    }

    /*
     * What the toolbar says is waiting.
     *
     * The popup stopped saying "tailored" because any proposal at all counts
     * as holding a resume, and a proposal is now the resume exactly as it is
     * kept until somebody ticks something — see `showOpenApplication`. The
     * toolbar's tooltip is drawn from the same fact and went on saying it:
     * "1 page read, a tailored resume is ready", over a resume nothing had
     * touched.
     */
    group('The toolbar does not call an untouched resume tailored');
    {
      store.save = 'work';
      store.role = 'Platform Engineer';
      store.company = undefined;
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://tooltip.example/jobs/1', title: 'Helios', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', { work: { spec: { id: 'job-fake', tier: 'temporary', copiedFrom: 'newgrad' } } });
      const title = await driver.evaluate(async () => {
        const tab = await chrome.tabs.getCurrent();
        return chrome.action.getTitle({ tabId: tab.id });
      });
      check('the tooltip says the application is held', /1 page read/.test(title), title);
      check('without claiming the resume was tailored', !/tailored/i.test(title), title);
    }

    /*
     * And what it says once the trail has gone stale with nothing happening.
     *
     * A trail is current for two hours from its last write, and after that
     * `readTrail` answers with nothing: the letter cannot be carried to
     * another page or put back. The badge was only ever redrawn by a write or
     * a navigation, so a tab left on the company's About page over lunch went
     * on saying "your writing is being held" about writing nothing could
     * reach. The two hours are made to have passed by writing the letter with
     * the worker's clock set back to three seconds short of them.
     */
    group('The toolbar stops saying the writing is held when it is not');
    {
      await ask(driver, 'clearTrail', {});
      await ask(driver, 'analyze', { url: 'http://expiry.example/jobs/1', title: 'Helios', html: '<p>one</p>', company: 'Helios' });
      const sw = context.serviceWorkers()[0] ?? worker;
      await sw.evaluate(() => {
        globalThis.__jhRealNow = Date.now;
        Date.now = () => globalThis.__jhRealNow() - (2 * 60 * 60 * 1000 - 3000);
      });
      try {
        await ask(driver, 'saveWork', { work: { letter: 'Dear Helios, I would like to build your platform.' } });
      } finally {
        await sw.evaluate(() => {
          if (globalThis.__jhRealNow) Date.now = globalThis.__jhRealNow;
        }).catch(() => undefined);
      }
      const titleNow = () =>
        driver.evaluate(async () => chrome.action.getTitle({ tabId: (await chrome.tabs.getCurrent()).id }));
      const before = await titleNow();
      check('while the trail is current it says the writing is held', /writing is being held/.test(before), before);
      let after = before;
      for (let i = 0; i < 40 && /writing is being held/.test(after); i++) {
        await driver.waitForTimeout(250);
        after = await titleNow();
      }
      const held = await ask(driver, 'getTrail', {});
      check('the trail really is out of reach by now', (held.reply?.data?.pages ?? []).length === 0, JSON.stringify(held.reply?.data));
      check('and the tooltip no longer says the writing is held', !/writing is being held/.test(after), after);
    }

    /*
     * "Yes" on the card's "Did you just send your application to …?" is filed
     * under the tab's work, and only when the question was about that work.
     *
     * The question can be answered on a card that is not the one it was asked
     * on — a single-page board that moved on to the next posting — and "Yes"
     * then filed whichever job the tab was on now. So the answer says which
     * job it meant, and one that names a different job from the work is
     * refused; and a tab with no work is refused too, rather than filed under
     * whatever the page in front of it says it is. See `applicationSentHere`.
     */
    group('A send said on the card is filed only under the job it named');
    {
      store.save = 'work';
      const sent = () => store.sentTo('/api/extension/sent').length;
      await ask(driver, 'clearTrail', {});
      /*
       * And the page answering for itself when asked what it is, as a card's
       * page does — which says what it shows now, not what the question was
       * about. The automatic path may still ask it; this one must not.
       */
      await driver.evaluate(() => {
        if (window.__answersWhatItIs) return;
        window.__answersWhatItIs = true;
        chrome.runtime.onMessage.addListener((message, _sender, reply) => {
          if (message?.type !== 'jh-what-is-this') return false;
          reply({ ok: true, data: { company: 'Helios', role: 'Platform Engineer' } });
          return false;
        });
      });
      const nothing = await ask(driver, 'applicationSentHere', {
        confirmed: true, company: 'Helios', role: 'Platform Engineer', url: 'http://said.example/review', note: 'Said to be sent, on the card',
      });
      check('with no work in the tab it is refused', nothing.reply?.data?.ok === false && sent() === 0, JSON.stringify(nothing.reply));
      await ask(driver, 'analyze', { url: 'http://said.example/jobs/1', title: 'Helios', html: '<p>one</p>', company: 'Helios' });
      await ask(driver, 'saveWork', {
        work: { spec: { id: 'job-helios', generatedFor: { company: 'Helios', role: 'Platform Engineer' }, choices: {} } },
      });
      const before = sent();
      const other = await ask(driver, 'applicationSentHere', {
        confirmed: true, company: 'Quillon Haulage', role: 'Platform Engineer', url: 'http://said.example/review', note: 'Said to be sent, on the card',
      });
      check('a question about another employer is refused', other.reply?.data?.ok === false && sent() === before, JSON.stringify(other.reply));
      const role = await ask(driver, 'applicationSentHere', {
        confirmed: true, company: 'Helios', role: 'Data Scientist', url: 'http://said.example/review', note: 'Said to be sent, on the card',
      });
      check('and one about another role there', role.reply?.data?.ok === false && sent() === before, JSON.stringify(role.reply));
      await ask(driver, 'applicationSentHere', {
        confirmed: true, company: 'Helios, Inc.', role: 'Platform engineer', url: 'http://said.example/review', note: 'Said to be sent, on the card',
      });
      const filed = store.sentTo('/api/extension/sent').slice(before);
      const body = (() => {
        try {
          return JSON.parse(filed.at(-1)?.body ?? 'null');
        } catch {
          return null;
        }
      })();
      check(
        'the job it named is filed, under the work',
        filed.length === 1 && body?.company === 'Helios' && body?.role === 'Platform Engineer',
        JSON.stringify(body),
      );
    }

    /*
     * The pairing header, on every request to the store, empty while this
     * extension is not paired. Its absence is how ResumeM-M tells a JobHelper
     * from before pairing, which has nowhere to enter a code, and tells it to
     * update rather than to make one.
     */
    group('The pairing header');
    {
      const toStore = store.hits.filter((h) => h.url.startsWith('/api') || h.url === '/health');
      const without = toStore.filter((h) => h.pair === null);
      check(
        'every request this run made to the store carried it',
        toStore.length > 20 && without.length === 0,
        `${toStore.length} requests, ${without.length} without: ${[...new Set(without.map((h) => h.url))].slice(0, 5).join(', ')}`,
      );
      check('empty, since nothing here was ever paired', toStore.every((h) => h.pair === ''), [...new Set(toStore.map((h) => h.pair))].join(','));
    }

    /*
     * Pairing from a card, one exchange for every tab.
     *
     * A store that refuses this extension used to leave the card with a
     * sentence pointing at the popup. The code box is on the card now, and
     * on every card that was refused — so the same code can be pressed in
     * two places at once, and each exchange the store sees is one of the
     * extension's five tries. The worker holds one exchange: the second
     * press joins the first, and every tab's card hears it paired and
     * carries on, without asking again.
     *
     * Last, because it leaves the extension paired, and "The pairing header"
     * above is about one that never was.
     */
    group('Pairing from a card, one exchange for every tab');
    {
      const site = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Platform Engineer at Helios</title>
          <h1>Platform Engineer</h1><p>Helios is hiring a Platform Engineer. Responsibilities: build the
          platform. Requirements: Kubernetes, Go. Apply now to join our team.</p>`);
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const where = (n) => `http://127.0.0.1:${site.address().port}/jobs/platform-engineer-${n}`;
      store.role = 'Platform Engineer';
      store.company = undefined;
      store.pairing = { code: 'GOODCODE', token: null, exchanges: 0, delay: 1500 };
      await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: true }));
      const box = (page) => page.locator('#jobhelper-card-host input.pair-code');
      const build = (page) => page.locator('#jobhelper-card-host button', { hasText: /^Build resume$/ });
      const seen = {};
      const a = await context.newPage();
      const b = await context.newPage();
      try {
        await a.goto(where('a'));
        await b.goto(where('b'));
        await box(a).waitFor({ timeout: 15_000 });
        await box(b).waitFor({ timeout: 15_000 });
        seen.boxes = true;
        // A wrong code first, from tab A: the store's sentence, tries and all.
        await a.bringToFront();
        await box(a).fill('WRONG-ONE');
        await a.locator('#jobhelper-card-host button', { hasText: /^Pair$/ }).click();
        seen.wrong = await a
          .locator('#jobhelper-card-host .pair-said')
          .filter({ hasText: /tries left/ })
          .textContent({ timeout: 10_000 })
          .catch(() => null);
        const before = store.pairing.exchanges;
        // The right one, pressed on tab A's card and from the popup at once.
        await box(a).fill('good-code');
        await a.locator('#jobhelper-card-host button', { hasText: /^Pair$/ }).click();
        const fromPopup = await ask(driver, 'pair', { code: 'GOODCODE' });
        seen.popup = fromPopup.reply;
        seen.exchanges = store.pairing.exchanges - before;
        // Both cards carry on: the page read again, and the proposal up.
        await build(a).waitFor({ timeout: 15_000 });
        await build(b).waitFor({ timeout: 15_000 });
        seen.carriedOn = true;
        seen.boxesAfter = (await box(a).count()) + (await box(b).count());
        seen.token = await pairingTokenIn(driver, store.base);
      } catch (err) {
        seen.error = String(err?.message ?? err);
      } finally {
        await a.close();
        await b.close();
        site.close();
        store.pairing = null;
        await driver.evaluate(() => chrome.storage.sync.set({ autoPrompt: false }));
        await driver.evaluate(() => chrome.storage.local.remove('rmmPairing'));
      }
      check('both refused tabs put the code box on their cards', seen.boxes === true, JSON.stringify(seen));
      check('a wrong code on a card says how many tries are left', /4 tries left/.test(seen.wrong ?? ''), String(seen.wrong));
      check('the same code pressed on a card and in the popup at once is one exchange', seen.exchanges === 1, String(seen.exchanges));
      check('and both are told it paired', seen.popup?.ok === true && seen.popup.data?.paired === true, JSON.stringify(seen.popup));
      check('both tabs carry on to the proposal without asking again', seen.carriedOn === true && seen.boxesAfter === 0, JSON.stringify(seen));
      check('and the token is kept for the store', typeof seen.token === 'string' && seen.token.startsWith('token-'), String(seen.token));
    }
  } finally {
    await context.close();
    store.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
