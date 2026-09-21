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
import { findChromium } from './fixtures.mjs';

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
    state.hits.push({ url, method: req.method, project: req.headers['x-rmm-project'] ?? null });

    const mode = state.routes[url] ?? 'ok';
    if (mode === 'silent') {
      state.open.push(res);
      return;
    }
    if (mode === 'stall-body') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"isJobPosting":true,');
      state.open.push(res);
      return;
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
      return send({
        isJobPosting: true,
        kind: 'posting',
        save: state.save,
        job: { company: page.company ?? 'Helios', title: state.role, description: 'A job.', keywords: [] },
        spec: { id: 'job-fake', extends: 'newgrad' },
      });
    }
    if (url === '/api/applications/bundle') return send({ ok: true, id: 'app-1', folder: '/tmp/x' });
    if (url === '/api/workspace') return send({ ok: true, id: 'ws-1', url: '/workspace/ws-1' });
    if (url === '/api/resumes') return send({ resumes: [{ id: 'newgrad', label: 'New grad' }] });
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

      store.role = 'Data Scientist';
      await ask(driver, 'analyze', { url: 'http://board.example/two?q=b', title: 'B', html: '<p>two</p>', company: 'Helios' });
      const back = await ask(driver, 'keepTogether', {});
      check('the merge answers with the writing itself', back.reply?.data?.work?.letter === 'PUT-THIS-BACK', JSON.stringify(back.reply?.data?.work));
      check('and with the pages joined', (back.reply?.data?.pages ?? []).length === 2, `${back.reply?.data?.pages?.length} pages`);
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
    group('Holding a space in the editor');
    {
      const helios = { spec: { id: 'job-7', generatedFor: { company: 'Helios', role: 'Platform Engineer' } } };
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
