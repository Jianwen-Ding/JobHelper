/**
 * Logging an error to ResumeM-M's error log, from the extension.
 *
 * The worker keeps a record of what went wrong — calls to the store that
 * failed, actions and how they ended, errors the page's scripts forward —
 * and the popup's form sends an entry with that record, the description and
 * screenshots pasted or captured. When the store cannot be reached the entry
 * is kept in the browser and sent the next time it answers.
 *
 * Against a fake store, so the store can fail on purpose and be "down" and
 * "up" again on command; tests/error-log-e2e.mjs is the same against a real
 * ResumeM-M.
 *
 *   node tests/error-log.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
const PNG = `data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`;

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
async function waitFor(fn, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > until) return value;
    await sleep(100);
  }
}

/** A store that takes error-log entries, and can fail, or be gone, on command. */
function fakeStore() {
  const state = { down: false, refuse: null, broken: new Set(), entries: [], hits: [] };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (state.down) {
      req.socket.destroy();
      return;
    }
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString();
      state.hits.push({ method: req.method, url });
      const send = (obj, code = 200) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (state.broken.has(url)) return send({ error: 'broken on purpose' }, 500);
      if (url === '/api/error-log' && req.method === 'POST' && state.refuse) return send({ error: state.refuse }, 400);
      if (url === '/health') return send({ ok: true, projectOpen: true, ai: { enabled: false, configured: false, command: '' } });
      if (url === '/api/extension/pair') return send({ token: 'fake-token', origin: req.headers.origin });
      if (url === '/api/resumes') return send([{ id: 'newgrad', label: 'New grad', base: true }]);
      if (url === '/api/config') return send({ ai: { enabled: false, command: '' } });
      if (url === '/api/error-log' && req.method === 'POST') {
        state.entries.push(JSON.parse(raw));
        return send({ committed: true, message: 'Logged to the error log (not pushed yet).', entry: { id: `entries/x/${state.entries.length}` } }, 201);
      }
      return send({ error: `no route ${url}` }, 404);
    });
  });
  return new Promise((ready) =>
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      state.close = () => server.close();
      ready(state);
    }),
  );
}

const ask = (page, type, payload = {}) =>
  page.evaluate(([t, p]) => new Promise((done) => chrome.runtime.sendMessage({ type: t, payload: p }, done)), [type, payload]);

/** Paste an image into the page, as Ctrl+V with a screenshot on the clipboard does. */
const pasteImage = (page, selector) =>
  page.evaluate(
    ([sel, bytes]) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.querySelector(sel).dispatchEvent(event);
      return event.defaultPrevented;
    },
    [selector, PNG_BYTES],
  );

async function main() {
  const store = await fakeStore();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-error-log-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1000, height: 800 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    for (let i = 0; i < 100; i++) {
      if (await worker.evaluate(() => Boolean(globalThis.chrome?.tabs?.query)).catch(() => false)) break;
      await sleep(100);
    }
    const id = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${id}/src/popup/popup.html`;
    const driver = await context.newPage();
    await driver.goto(popupUrl);
    await driver.evaluate((s) => chrome.storage.sync.set({ serverUrl: s, autoPrompt: false }), store.base);

    group('What the worker keeps');
    {
      const paired = await ask(driver, 'pair', { code: 'ABCD-EFGH' });
      check('an action that works', paired?.ok === true, JSON.stringify(paired));
      store.broken.add('/api/resumes');
      const list = await ask(driver, 'listResumes');
      check('a call to the store that fails', list?.ok === false && /broken on purpose/.test(list.error), JSON.stringify(list));
      store.broken.delete('/api/resumes');
      await ask(driver, 'logEvents', { events: [{ kind: 'content-error', level: 'error', message: 'TypeError in the card, on purpose' }, { kind: 'card-error', message: '' }] });
      // And the worker's own: a promise nobody caught.
      await worker.evaluate(() => {
        Promise.reject(new Error('worker boom on purpose'));
      });
      await sleep(200);
    }

    group('The popup’s form');
    const popup = await context.newPage();
    await popup.goto(popupUrl);
    {
      check('hidden until asked for', await popup.isHidden('#errorLogForm'));
      await popup.click('#logError');
      check('opens from its button', await popup.isVisible('#errorLogForm'));
      check('with the description ready to type in', await popup.evaluate(() => document.activeElement?.id === 'errorDescription'));
      const prevented = await pasteImage(popup, '#errorDescription');
      check('a pasted screenshot is taken', prevented);
      await waitFor(() => popup.evaluate(() => document.querySelectorAll('#errorShots img').length === 1));
      const src = await popup.getAttribute('#errorShots img', 'src');
      check('and shown as a thumbnail', /^data:image\/png;base64,/.test(src ?? ''), src?.slice(0, 40));

      // "Capture this tab": the browser's own capture, answered here with a known image.
      await popup.evaluate((png) => {
        chrome.tabs.captureVisibleTab = async (windowId, options) => {
          window.capturedWith = { windowId, options };
          return png;
        };
      }, PNG);
      await popup.click('#captureTab');
      await waitFor(() => popup.evaluate(() => document.querySelectorAll('#errorShots img').length === 2));
      const captured = await popup.evaluate(() => window.capturedWith);
      check('Capture this tab adds the page as a second screenshot', captured?.options?.format === 'png' && typeof captured.windowId === 'number', JSON.stringify(captured));
      await popup.click('#errorShots figure:nth-child(2) button');
      check('and a screenshot can be removed again', (await popup.locator('#errorShots img').count()) === 1);

      await popup.fill('#errorDescription', 'Listing resumes failed in the popup');
      await popup.selectOption('#errorMinutes', '2');
      await popup.click('#saveErrorLog');
      await waitFor(async () => store.entries.length === 1);
      const [entry] = store.entries;
      check('the entry reaches the store', entry?.description === 'Listing resumes failed in the popup', JSON.stringify(entry?.description));
      check('with its window and its screenshot', entry?.minutes === 2 && entry?.screenshots?.length === 1 && entry.screenshots[0] === PNG);
      check('and the extension’s version and build', typeof entry?.extensionVersion === 'string' && /^[0-9a-f]{16}$|^unavailable$/.test(entry?.extensionBuild ?? ''), `${entry?.extensionVersion} ${entry?.extensionBuild}`);
      const said = (entry?.events ?? []).map((e) => `${e.kind}: ${e.message}`);
      check('the failed call is in its logs, by route', said.some((s) => /^server: GET \/api\/resumes → 500: broken on purpose$/.test(s)), said.join(' | '));
      check('so is the failed action, by name', said.some((s) => /^action: listResumes \(listResumes\) failed: broken on purpose/.test(s)));
      check('and the one that worked', said.some((s) => /^action: pair \(pair\) worked/.test(s)));
      check('and the error the page forwarded, not the empty one', said.some((s) => s === 'content-error: TypeError in the card, on purpose') && !said.some((s) => /^card-error/.test(s)));
      check('and the worker’s own uncaught error', said.includes('worker-error: Nobody caught: worker boom on purpose'));
      check('nothing a person typed: no pairing code in the logs', !JSON.stringify(entry?.events).includes('ABCD-EFGH'));
      check('every event says it is JobHelper’s', (entry?.events ?? []).every((e) => e.source === 'jobhelper'));
      const status = await popup.textContent('#errorLogSaid');
      check('the popup says it is logged', /Logged to ResumeM-M’s error log \(not pushed yet\)/.test(status ?? ''), status);
      check('and empties the form for the next one', (await popup.inputValue('#errorDescription')) === '' && (await popup.locator('#errorShots img').count()) === 0);

      /*
       * Round 26: what is taken out, said as ResumeM-M's dialog says it; an
       * email or a phone in the description said as it is typed, and kept.
       * And the two buttons, which wrapped to two lines each, on one line.
       */
      const hint = await popup.textContent('#errorLogHint');
      check(
        'the form says what is taken out, as ResumeM-M does',
        hint === 'Contact details and tokens are taken out of the automatic logs; tokens are also taken out of your description.',
        hint,
      );
      check('nothing to warn about in an empty box', await popup.isHidden('#errorLogContact'));
      await popup.fill('#errorDescription', 'Autofill put jane.doe@example.com in the phone box and 617-555-0134 in the email box');
      const contact = await popup.textContent('#errorLogContact');
      check(
        'an email and a phone in the description are warned about, and kept',
        (await popup.isVisible('#errorLogContact')) && contact === 'Your description has an email and a phone number in it — it will be kept as written.',
        contact,
      );
      await popup.fill('#errorDescription', 'Nothing personal here');
      check('and the warning goes with them', await popup.isHidden('#errorLogContact'));
      await popup.fill('#errorDescription', '');
      const lines = await popup.evaluate(() =>
        ['#captureTab', '#saveErrorLog'].map((sel) => {
          const button = document.querySelector(sel);
          const range = document.createRange();
          range.selectNodeContents(button);
          const tops = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
          return { sel, lines: tops.size, width: Math.round(button.getBoundingClientRect().width) };
        }),
      );
      check('each button’s label fits on one line', lines.every((b) => b.lines === 1), JSON.stringify(lines));
    }

    group('ResumeM-M out of reach');
    {
      const connected = await popup.textContent('#status');
      store.down = true;
      await popup.fill('#errorDescription', 'Logged while the store was down');
      await pasteImage(popup, '#errorDescription');
      await waitFor(() => popup.evaluate(() => document.querySelectorAll('#errorShots img').length === 1));
      await popup.click('#saveErrorLog');
      const said = await waitFor(async () => {
        const text = await popup.textContent('#errorLogSaid');
        return /kept in the browser/.test(text ?? '') && text;
      });
      check('the entry is kept in the browser, and the popup says so', Boolean(said), said);
      // Round 26: kept is not refused — said in the queue's amber, not in red.
      const tone = await popup.evaluate(() => {
        const said = document.querySelector('#errorLogSaid');
        return { className: said.className, color: getComputedStyle(said).color, queued: getComputedStyle(document.querySelector('#errorLogQueued')).color };
      });
      check('and says it in amber, as the queue line is, not in red', /\bwarn\b/.test(tone.className) && tone.color === tone.queued, JSON.stringify(tone));
      const queued = await popup.textContent('#errorLogQueued');
      check('and how many are waiting', /1 error-log entry is waiting/.test(queued ?? ''), queued);
      /*
       * Round 27: the connection line looks again. It went on saying
       * "Connected — 1 resume" in green beside "ResumeM-M could not take it
       * just now", two answers about the same server at once.
       */
      const status = await waitFor(async () => {
        const text = await popup.textContent('#status');
        return /not open|not running|could not|did not answer/i.test(text ?? '') && { text, className: await popup.getAttribute('#status', 'class') };
      });
      check(
        'and the connection line no longer says connected',
        /^Connected/.test(connected ?? '') && Boolean(status) && !/Connected/.test(status.text) && /\berr\b/.test(status.className ?? ''),
        `${connected} → ${JSON.stringify(status) || (await popup.textContent('#status'))}`,
      );
      const kept = await popup.evaluate(async () => (await chrome.storage.local.get('jh-error-log-queue'))['jh-error-log-queue']);
      check('in local storage, with its screenshot', kept?.length === 1 && kept[0].screenshots.length === 1);

      store.down = false;
      // Anything the store answers sends it: here the popup's own check.
      await ask(driver, 'ping');
      const arrived = await waitFor(async () => store.entries.find((e) => e.description === 'Logged while the store was down'));
      check('sent once the store answers again', Boolean(arrived));
      check('with its screenshot, and the time it was logged', arrived?.screenshots?.length === 1 && Date.parse(arrived.at) < Date.now());
      const left = await waitFor(async () => {
        const queue = await popup.evaluate(async () => (await chrome.storage.local.get('jh-error-log-queue'))['jh-error-log-queue']);
        return Array.isArray(queue) && queue.length === 0;
      });
      check('and no longer kept', Boolean(left));
      check('only once', store.entries.filter((e) => e.description === 'Logged while the store was down').length === 1);
    }

    /*
     * Round 26: an entry kept while ResumeM-M was out of reach, and refused
     * when it was sent, was let go of with nothing said. The popup says so,
     * and offers its words to copy before they go.
     */
    group('Refused on the way back');
    {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
      store.down = true;
      if (await popup.isHidden('#errorLogForm')) await popup.click('#logError');
      await popup.fill('#errorDescription', 'Kept, then refused');
      await popup.click('#saveErrorLog');
      await waitFor(async () => /kept in the browser/.test((await popup.textContent('#errorLogSaid')) ?? ''));
      store.down = false;
      store.refuse = 'Keep the description under 4,000 characters; put the rest in a screenshot.';
      await popup.reload();
      const said = await waitFor(async () => {
        const text = await popup.textContent('#errorLogRefused');
        return /refused/.test(text ?? '') && text;
      });
      check(
        'the popup says the entry was refused, and why',
        /^1 entry was refused by ResumeM-M: Keep the description under 4,000 characters/.test(said || ''),
        said,
      );
      check('and it is no longer waiting', !/waiting/.test((await popup.textContent('#errorLogQueued')) ?? ''));
      check('with the form shut, as the popup opens', await popup.isHidden('#errorLogForm'));
      await popup.click('#copyRefused');
      const copied = await waitFor(async () => {
        const text = await popup.evaluate(() => navigator.clipboard.readText()).catch(() => '');
        return /Kept, then refused/.test(text) && text;
      });
      check('Copy text puts what was written on the clipboard, with the reason', /^Kept, then refused\n[\s\S]*ResumeM-M refused it: Keep the description/.test(copied || ''), JSON.stringify(copied));
      const left = await waitFor(async () => {
        const kept = await popup.evaluate(async () => (await chrome.storage.local.get('jh-error-log-refused'))['jh-error-log-refused']);
        return Array.isArray(kept) && kept.length === 0;
      });
      /*
       * Round 27: and says so where it can be seen. It was said under the
       * form, which is shut when the popup opens on a refused entry.
       */
      const confirmed = await waitFor(() =>
        popup.evaluate(() => [...document.querySelectorAll('[role="status"]')].find((e) => e.offsetParent && e.getBoundingClientRect().height > 0 && /^Copied/.test(e.textContent))?.textContent),
      );
      check('the copy is confirmed where it can be seen', /^Copied the refused entry’s text/.test(confirmed ?? ''), confirmed);
      check('and once copied it is let go of', Boolean(left) && !/refused by ResumeM-M|Copy text|Dismiss/.test((await popup.textContent('#errorLogRefused')) ?? ''), await popup.textContent('#errorLogRefused'));
      store.refuse = null;
    }

    group('The keyboard shortcut');
    {
      const command = await driver.evaluate(() => chrome.runtime.getManifest().commands?.['log-error']);
      check('Alt+Shift+E is the error log’s command', command?.suggested_key?.default === 'Alt+Shift+E', JSON.stringify(command));
      const all = await driver.evaluate(() => chrome.commands.getAll());
      check('and the browser has it', all.some((c) => c.name === 'log-error'), JSON.stringify(all));
      const before = context.pages().length;
      const opened = await ask(driver, 'openErrorLog');
      check('the command opens the popup', opened?.ok === true, JSON.stringify(opened));
      const page = await waitFor(async () => context.pages().find((p, i) => i >= before - 1 && p.url().includes('popup.html') && p !== driver && p !== popup));
      if (page) {
        const open = await waitFor(() => page.isVisible('#errorLogForm'));
        check('on the form, ready to type in', Boolean(open) && (await page.evaluate(() => document.activeElement?.id === 'errorDescription')));
      } else {
        /*
         * `openPopup` worked: the action popup is not a page Playwright is
         * shown, but the note it opens on the form by is used up only by a
         * popup that read it.
         */
        const used = await waitFor(async () =>
          (await driver.evaluate(async () => (await chrome.storage.session.get('jh-open-error-log'))['jh-open-error-log'])) === undefined,
        );
        check('and the popup it opened read the note that puts it on the form', opened?.data?.opened === 'popup' && Boolean(used), JSON.stringify(opened?.data));
      }
      // The same note, read by a popup opened any other way.
      await driver.evaluate(() => chrome.storage.session.set({ 'jh-open-error-log': Date.now() }));
      const fresh = await context.newPage();
      await fresh.goto(popupUrl);
      check('a popup opened with the note waiting opens on the form', Boolean(await waitFor(() => fresh.isVisible('#errorLogForm'))));
      const cleared = await driver.evaluate(async () => (await chrome.storage.session.get('jh-open-error-log'))['jh-open-error-log']);
      check('and the note is used up', cleared === undefined);
      await fresh.close();
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
