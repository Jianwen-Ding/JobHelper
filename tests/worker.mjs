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
  const state = { save: 'work', routes: {}, hits: [], open: [], strict: true };
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
        job: { company: page.company ?? 'Helios', title: 'Platform Engineer', description: 'A job.', keywords: [] },
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
