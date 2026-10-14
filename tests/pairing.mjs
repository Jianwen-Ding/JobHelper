/**
 * Pairing with ResumeM-M, from the popup.
 *
 * ResumeM-M answers only the extension it has been paired with: it used to
 * answer every `chrome-extension://` origin, so any extension in the browser
 * could read the whole resume store. A JobHelper that is not paired — a fresh
 * install, or any install from before pairing — has to say so, everywhere it
 * would otherwise just fail, and the popup has to take the code.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/pairing.mjs
 *
 * Against a real ResumeM-M. It removes this extension's pairings from that
 * server on the way in, so do not point it at the one you use.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extensionWorker, findChromium, requireOpenSave } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = (process.env.RMM_SERVER ?? 'http://127.0.0.1:4600').replace(/\/$/, '');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));

/** The code the editor would show, asked for as the editor asks. */
async function makeCode() {
  const res = await fetch(`${SERVER}/api/extension/pairings/code`, { method: 'POST' });
  if (!res.ok) throw new Error(`${SERVER} would not make a pairing code (${res.status}). Is it a ResumeM-M with pairing?`);
  return (await res.json()).code;
}

async function forget(extensionId) {
  await fetch(`${SERVER}/api/extension/pairings/${extensionId}`, { method: 'DELETE' });
}

async function waitFor(fn, ms = 10_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > until) return value;
    await sleep(150);
  }
}

async function main() {
  await requireOpenSave(SERVER);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-pairing-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    // A clean slate on the server: this extension, never paired.
    await forget(id);
    await worker.evaluate((s) => chrome.storage.sync.set({ serverUrl: s, autoPrompt: false }), SERVER);
    const ask = (page, type, payload) =>
      page.evaluate(([t, p]) => new Promise((done) => chrome.runtime.sendMessage({ type: t, payload: p }, done)), [type, payload]);

    console.log('Not paired');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    const shown = await waitFor(() => popup.isVisible('#pairing'));
    check('the popup asks for the code', Boolean(shown));
    /*
     * Open, at the top, with the caret in it: the popup is where somebody
     * goes because something said "not paired", and the code is in their
     * clipboard by then.
     */
    const focused = await waitFor(() => popup.evaluate(() => document.activeElement?.id === 'pairCode' || undefined));
    check('with the caret in the code box, so the code can be pasted at once', Boolean(focused), await popup.evaluate(() => document.activeElement?.id));
    const getCode = await popup.textContent('#pairOpen');
    check('and "Get a code" beside it', getCode?.trim() === 'Get a code', getCode);
    const opened = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
    await popup.click('#pairOpen');
    const codeTab = await opened;
    check('which opens the editor at its pairing section, asking for a code', codeTab?.url() === `${SERVER}/#save/pair?make=1` || /#pair$/.test(codeTab?.url() ?? ''), codeTab?.url());
    await codeTab?.waitForSelector('#pair-code', { timeout: 15_000 }).catch(() => null);
    const madeThere = await codeTab?.textContent('#pair-code').catch(() => null);
    check('and shows a code made for it', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(madeThere ?? ''), madeThere);
    await codeTab?.close();
    const what = await popup.textContent('#pairingWhat');
    check('and says where the code is', /Save & Files → Pair JobHelper/.test(what ?? ''), what);
    const status = await popup.textContent('#status');
    check('the status line was told not paired, not "not running"', /not paired/.test(status ?? '') && !/not open|did not answer/.test(status ?? ''), status);
    // Said once, in the box: a red status line under it saying the same
    // thing in nearly the same words was the second time.
    check('and is not shown beside the box saying it again', !(await popup.isVisible('#status')), await popup.evaluate(() => document.querySelector('#status').hidden));
    const ai = await popup.textContent('#aiState');
    const aiHint = await popup.textContent('#aiHint');
    check('the AI panel does not claim no AI is set up', ai !== 'No AI set up' && /paired/.test(aiHint ?? ''), `${ai} / ${aiHint}`);

    // What the card would get, asking for anything from the store.
    const listed = await ask(popup, 'listResumes');
    check('a request from the worker fails as not paired', listed?.ok === false && /not paired/.test(listed.error ?? ''), listed?.error);
    check('with the way to the pairing page on it', listed?.fix?.fix === 'pair' && listed.fix.serverUrl === `${SERVER}/#pair`, JSON.stringify(listed?.fix));
    const stored = await worker.evaluate(() => chrome.storage.local.get('rmmPairing'));
    check('and holds no token', !stored.rmmPairing, JSON.stringify(stored));

    console.log('A wrong code');
    const code = await makeCode();
    const wrong = code.split('').reverse().join('') === code ? 'ZZZZZZZZ' : code.split('').reverse().join('');
    await popup.fill('#pairCode', wrong);
    await popup.click('#pairButton');
    const said = await waitFor(async () => (await popup.textContent('#pairSaid')) || undefined);
    check('is refused, saying how many tries are left', /tries left/.test(said ?? ''), said);
    check('and the box stays up', await popup.isVisible('#pairing'));

    /*
     * The address changed to a server that is not running. The box stayed up
     * with the last code's answer under it, asking for a code for the server
     * before — its "Open ResumeM-M" went there — beneath a status line that
     * said this one was not open.
     */
    console.log('The address changed to a server that is not running');
    const dead = await new Promise((done) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => done(`http://127.0.0.1:${port}`));
      });
    });
    await popup.fill('#serverUrl', dead);
    await popup.dispatchEvent('#serverUrl', 'change');
    const down = await waitFor(async () => {
      const text = await popup.textContent('#status');
      return /not open|did not answer/.test(text ?? '') ? text : undefined;
    });
    check('the popup says it is not running', Boolean(down), await popup.textContent('#status'));
    check('in the status line, shown again now the box is not saying anything', await popup.isVisible('#status'));
    check('the code box goes away', !(await popup.isVisible('#pairing')));
    check('and what the last code was told goes with it', (await popup.textContent('#pairSaid')) === '', await popup.textContent('#pairSaid'));
    await popup.fill('#serverUrl', SERVER);
    await popup.dispatchEvent('#serverUrl', 'change');
    check('back at the unpaired server, it asks again', Boolean(await waitFor(() => popup.isVisible('#pairing'))));

    console.log('The right code, read off the editor');
    const editor = await context.newPage();
    await editor.goto(`${SERVER}/#pair`);
    await editor.waitForSelector('#pair-make', { timeout: 15_000 });
    // The wrong guess above was against a code made over the API; the editor
    // shows it, and a new one replaces it.
    const before = await editor.textContent('#pair-code').catch(() => null);
    check('the editor shows the code that is waiting', before === `${code.slice(0, 4)}-${code.slice(4)}`, before);
    await editor.click('#pair-make');
    const shownCode = await waitFor(async () => {
      const text = await editor.textContent('#pair-code');
      return text && text !== before ? text : undefined;
    });
    check('and makes a new one when asked', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(shownCode ?? ''), shownCode);
    await popup.fill('#pairCode', (shownCode ?? '').toLowerCase());
    await popup.click('#pairButton');
    const connected = await waitFor(async () => /Connected/.test((await popup.textContent('#status')) ?? '') || undefined, 15_000);
    check('pairs, and the popup connects', Boolean(connected), await popup.textContent('#status'));
    check('the code box goes away', !(await popup.isVisible('#pairing')));
    const token = await worker.evaluate(async (s) => (await chrome.storage.local.get('rmmPairing')).rmmPairing?.[new URL(s).origin], SERVER);
    check('the token is kept for this server', typeof token === 'string' && token.length > 30);
    const after = await ask(popup, 'listResumes');
    check('the worker reads the store now', after?.ok === true && Array.isArray(after.data), after?.error);
    const used = await fetch(`${SERVER}/api/extension/pairings`).then((r) => r.json());
    check('the editor lists it', used.paired.some((p) => p.id === id) && used.code === null, JSON.stringify(used));

    const row = await waitFor(async () => {
      const text = await editor.textContent('#pair-list').catch(() => null);
      return text?.includes(id) ? text : undefined;
    });
    check('the editor lists it under Paired extensions, and the code is gone', Boolean(row) && !(await editor.isVisible('#pair-code')), row);

    console.log('Removed in the editor');
    await editor.click('#pair-list button');
    const gone = await waitFor(async () => !(await editor.isVisible('#pair-list')) || undefined);
    check('the Remove button takes it off the list', Boolean(gone));
    const refused = await ask(popup, 'listResumes');
    check('the worker is refused again, as not paired', refused?.ok === false && refused.fix?.fix === 'pair', refused?.error);
    await popup.reload();
    check('and the popup asks for a code again', Boolean(await waitFor(() => popup.isVisible('#pairing'))));

    console.log('The side panel');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${id}/src/panel/panel.html`);
    const panelSays = await waitFor(async () => {
      const text = await panel.textContent('body');
      return /not paired with ResumeM-M/.test(text ?? '') ? text : undefined;
    });
    check('says it is not paired, instead of showing nothing', Boolean(panelSays));
  } finally {
    await context.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
