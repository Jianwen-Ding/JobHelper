/**
 * What the card says when the store is not there to be told.
 *
 * `applicationSent` catches an unreachable ResumeM-M and answers
 * `{ ok: false }` — "the store not running is not a reason to interrupt
 * somebody who has just sent an application". The content script does not
 * wait for that answer: the message is fired, its rejection is swallowed, and
 * the next line sets "Recorded as sent." whatever happened. The line after
 * that returns true, which spends the one send the document had.
 *
 *   node tests/probe-said-sent.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveFixtures, findChromium, pointExtensionAt, requireOpenSave, cleanStore } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const COMPANY = 'Larkspur';

/**
 * A proxy that forwards, until it is told to stop — then every request fails
 * the way a stopped ResumeM-M fails, without stopping the real one.
 */
function cuttableProxy(target) {
  let cut = false;
  return new Promise((done) => {
    const s = http.createServer(async (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        if (cut) {
          req.socket.destroy();
          return;
        }
        try {
          const up = await fetch(`${target}${req.url}`, {
            method: req.method,
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)),
            ),
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const out = Buffer.from(await up.arrayBuffer());
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
          res.end(out);
        } catch (e) {
          res.writeHead(502);
          res.end(String(e));
        }
      });
    });
    s.listen(0, '127.0.0.1', () =>
      done({
        base: `http://127.0.0.1:${s.address().port}`,
        cut: () => {
          cut = true;
        },
        close: () => s.close(),
      }),
    );
  });
}

const POSTING = {
  name: 'saidsent',
  path: '/larkspur/jobs/platform-engineer',
  company: COMPANY,
  html: `<!doctype html><html><head><title>Platform Engineer at Larkspur</title></head><body>
  <h1>Larkspur</h1><div>Platform Engineer</div>
  <h2>About the role</h2>
  <p>We are looking for a platform engineer to own our systems. Responsibilities
     include shipping to production.</p>
  <h2>Minimum qualifications</h2><ul><li>Years of experience with distributed systems</li></ul>
  <p>Equal opportunity employer. Full-time. Upload your resume to apply.</p>
  <h2>Application</h2>
  <form id="ap">
    <label>First name <input name="first_name"></label>
    <label>Last name <input name="last_name"></label>
    <label>Email <input name="email" type="email"></label>
    <label>Why do you want to work here? <textarea name="q1"></textarea></label>
    <label>Resume <input type="file" name="resume"></label>
    <button type="submit">Submit Application</button>
  </form>
  <script>document.getElementById('ap').addEventListener('submit', (e) => e.preventDefault());</script>
  </body></html>`,
};

const status = async () => {
  const r = await fetch(`${SERVER}/api/applications`).then((x) => x.json());
  const row = (r.applications ?? []).find((a) => (a.company ?? '').toLowerCase().includes(COMPANY.toLowerCase()));
  return row?.status ?? '(no row)';
};

await requireOpenSave(SERVER);
await cleanStore(SERVER, [COMPANY]).catch(() => undefined);
const fixtures = await serveFixtures([POSTING]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-said-'));
const context = await chromium.launchPersistentContext(dir, {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1280, height: 950 },
  args: ['--no-sandbox', `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const proxy = await cuttableProxy(SERVER);
  await pointExtensionAt(context, worker, proxy.base);

  const page = await context.newPage();
  await page.goto(fixtures.urlFor(POSTING), { waitUntil: 'domcontentloaded' });
  const card = page.locator(`${HOST} .card`);
  await card.locator('.role').waitFor({ timeout: 40_000 });
  await card.getByRole('button', { name: 'Build resume' }).click({ timeout: 30_000 });
  await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(3000);
  console.log('tracker before      :', await status());

  // The store goes away, exactly as closing ResumeM-M would look.
  proxy.cut();
  console.log('(the store is now unreachable)');

  await page.getByRole('button', { name: 'Submit Application', exact: true }).click({ timeout: 15_000 });
  await page.waitForTimeout(6000);

  const said = (await card.innerText()).split('\n').filter(Boolean).slice(-6).join(' | ');
  console.log('card says           :', JSON.stringify(said));
  console.log('claims it recorded  :', /recorded as sent/i.test(said));
  console.log('tracker after       :', await status(), '(applied means it really was recorded)');
} finally {
  await context.close();
  await fixtures.close();
  fs.rmSync(dir, { recursive: true, force: true });
  await cleanStore(SERVER, [COMPANY]).catch(() => undefined);
}
