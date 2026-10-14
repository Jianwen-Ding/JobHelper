/**
 * Logging an error from the popup into a real ResumeM-M's error log, end to
 * end: something fails, the person logs it with a pasted screenshot, and the
 * entry lands in the error log's own git repository — its words, its
 * screenshot, and the failure in its logs.jsonl, from both the extension's
 * side and the server's — as one commit.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/error-log-e2e.mjs
 *
 * Reads the error log off the disk where the server says it is, so it has
 * to run on the same machine as that server. Point it at a ResumeM-M whose
 * error log is a throwaway one (its HOME, or RMM_ERROR_LOG_DIR).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { extensionWorker, findChromium, requireOpenSave, useServer } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = (process.env.RMM_SERVER ?? 'http://127.0.0.1:4600').replace(/\/$/, '');
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1];

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((go) => setTimeout(go, ms));
async function waitFor(fn, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value || Date.now() > until) return value;
    await sleep(150);
  }
}

async function main() {
  await requireOpenSave(SERVER);
  // Asked as the editor asks: a local process, no browser headers.
  const status = await (await fetch(`${SERVER}/api/error-log/status`)).json();
  const dir = status.dir;
  console.log(`Error log at ${dir}`);
  const before = status.entries ?? 0;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-error-log-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    await useServer(context, SERVER);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
    const ask = (type, payload) =>
      popup.evaluate(([t, p]) => new Promise((done) => chrome.runtime.sendMessage({ type: t, payload: p }, done)), [type, payload]);

    console.log('Something fails');
    const missing = `no-such-application-${Date.now()}`;
    const refused = await ask('trackStatus', { id: missing, status: 'applied' });
    check('a tracker update for an application that does not exist is refused', refused?.ok === false, JSON.stringify(refused));

    console.log('It is logged from the popup');
    await popup.click('#logError');
    await popup.fill('#errorDescription', 'Marking an application applied did nothing');
    await popup.evaluate((bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'shot.png', { type: 'image/png' }));
      document.querySelector('#errorDescription').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG_BYTES);
    await waitFor(() => popup.evaluate(() => document.querySelectorAll('#errorShots img').length === 1));
    await popup.click('#saveErrorLog');
    const said = await waitFor(async () => {
      const text = await popup.textContent('#errorLogSaid');
      return /Logged to ResumeM-M’s error log|Not logged|kept in the browser/.test(text ?? '') && text;
    });
    check('the popup says it is logged', /Logged to ResumeM-M’s error log \(not pushed yet\)/.test(said ?? ''), said);

    console.log('It is in the error log');
    const listed = await (await fetch(`${SERVER}/api/error-log?limit=5`)).json();
    const entry = listed.entries?.find((e) => e.description === 'Marking an application applied did nothing');
    check('listed by the server, from JobHelper, with its screenshot', entry?.source === 'JobHelper' && entry.screenshots === 1, JSON.stringify(entry));
    check('one more entry than before', listed.entries?.length && (await (await fetch(`${SERVER}/api/error-log/status`)).json()).entries === before + 1);
    if (entry) {
      const folder = path.join(dir, entry.id);
      const files = fs.readdirSync(folder).sort();
      check('entry.md, logs.jsonl and the screenshot on disk', files.join(',') === 'entry.md,logs.jsonl,screenshot-1.png', files.join(','));
      const shot = fs.readFileSync(path.join(folder, 'screenshot-1.png'));
      check('the screenshot is the image that was pasted', shot.equals(Buffer.from(PNG_BYTES)));
      const md = fs.readFileSync(path.join(folder, 'entry.md'), 'utf8');
      check('entry.md says where it came from and the versions', /\*\*From:\*\* JobHelper/.test(md) && /JobHelper \d+\.\d+\.\d+/.test(md) && /server build \d+/.test(md));
      // The popup was open as a tab of its own here, with no web page behind it to name.
      check('and names no page, since there was none behind the popup', !/\*\*Page:\*\*/.test(md));
      const events = fs
        .readFileSync(path.join(folder, 'logs.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const route = `/api/applications/${missing}/status`;
      const server = events.find((e) => e.source === 'server' && e.kind === 'request' && e.message.includes(route));
      const extension = events.find((e) => e.source === 'jobhelper' && e.kind === 'server' && e.message.includes(route));
      const action = events.find((e) => e.source === 'jobhelper' && e.kind === 'action' && /trackStatus/.test(e.message));
      check('the failure is in logs.jsonl, as the server saw it', Boolean(server), server?.message);
      check('and as the extension saw it', Boolean(extension), extension?.message);
      check('and as the action that failed', Boolean(action), action?.message);
      check('in the order things happened', events.every((e, i) => i === 0 || events[i - 1].at <= e.at));
      const log = execFileSync('git', ['-C', dir, 'log', '--format=%s', '-5'], { encoding: 'utf8' });
      check('and committed, as "Log: …"', log.split('\n').includes('Log: Marking an application applied did nothing'), log.split('\n')[0]);
      const inCommit = execFileSync('git', ['-C', dir, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' });
      check('the commit holds that entry’s files', inCommit.includes(`${entry.id}/screenshot-1.png`) && inCommit.includes(`${entry.id}/logs.jsonl`));
      check('and nothing is left uncommitted', execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }) === '');
    }
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
