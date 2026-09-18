/**
 * Drawing a resume on a page that does not trust blobs.
 *
 * pdf.js starts its worker one of two ways. Where `workerSrc` is the page's
 * own origin it calls `new Worker(workerSrc)`; where it is not, it fetches the
 * script into a Blob and starts the worker from `blob:`. From a content script
 * it is never the page's origin — `workerSrc` is `chrome-extension://` and the
 * page is whatever site you are on — so every posting page took the blob
 * route, and a page whose `worker-src` does not list `blob:` refuses it:
 *
 *   Refused to create a worker from 'blob:https://github.com/…' because it
 *   violates the following Content Security Policy directive: "worker-src
 *   github.githubassets.com …". The action has been blocked.
 *
 * Nothing broke. pdf.js caught it, set up its fake worker, and the resume drew
 * — measured at one page and one canvas either way. What it cost was a
 * violation reported to the site every time, which reads as this extension
 * being broken, on a product whose whole manner is to be quiet.
 *
 * The policy below is GitHub's, copied from the report. A content script
 * cannot have a real worker here at all — Chrome refuses one started from an
 * extension URL as cross-origin, which `the extension cannot start a worker of
 * its own either` checks — so the main thread is where this runs. This suite
 * is about how it gets there: quietly, and still drawing.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/** GitHub's own, as it appeared in the report. */
const STRICT =
  'worker-src github.githubassets.com github.com/assets-cdn/worker/ github.com/assets/ gist.github.com/assets-cdn/worker/';

function servePage(csp) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(csp ? { 'Content-Security-Policy': csp } : {}),
      });
      res.end('<!doctype html><title>Careers</title><h1>Platform Engineer</h1><div id="box"></div>');
    });
    s.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${s.address().port}/`, close: () => s.close() }));
  });
}

/**
 * A real compiled resume would mean a server, a store and a tailoring pass for
 * a question that is about one `new Worker` call. One page of valid PDF is
 * enough to make pdf.js do everything this is watching.
 */
const ONE_PAGE_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj',
    'trailer<</Size 4/Root 1 0 R>>',
    '%%EOF',
    '',
  ].join('\n'),
  'utf8',
).toString('base64');

/** Draw the PDF through the extension's own pdfview.js, in the isolated world. */
async function drawIn(context, worker, url) {
  return worker.evaluate(
    async ([tabUrl, base64]) => {
      const [tab] = await chrome.tabs.query({ url: `${tabUrl}*` });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        args: [base64],
        func: async (bytes) => {
          const violations = [];
          document.addEventListener('securitypolicyviolation', (e) =>
            violations.push(`${e.violatedDirective} ${e.blockedURI}`),
          );
          let pages = 0;
          let error = '';
          try {
            const { drawPdf } = await import(chrome.runtime.getURL('src/content/pdfview.js'));
            pages = await drawPdf(document.getElementById('box'), bytes, { width: 300 });
          } catch (e) {
            error = e.message;
          }
          // Violations are reported a turn after the call that caused them.
          await new Promise((r) => setTimeout(r, 300));
          return { pages, error, violations, canvases: document.querySelectorAll('#box canvas').length };
        },
      });
      return result;
    },
    [url, ONE_PAGE_PDF],
  );
}

async function main() {
  const strict = await servePage(STRICT);
  const open = await servePage(null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-csp-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));

    console.log('\nA page that forbids blob workers');
    const page = await context.newPage();
    const refusals = [];
    page.on('console', (m) => {
      if (/Refused to create a worker/i.test(m.text())) refusals.push(m.text());
    });
    await page.goto(strict.base, { waitUntil: 'domcontentloaded' });

    const drawn = await drawIn(context, worker, strict.base);
    check('the resume is drawn', drawn.pages === 1 && drawn.canvases === 1, drawn.error || `${drawn.canvases} canvas`);
    check('nothing is refused by the page policy', drawn.violations.length === 0, drawn.violations.join('; '));
    check('and the page is told of no violation', refusals.length === 0, refusals[0]?.slice(0, 90) ?? '');

    console.log('\nA page with no policy of its own');
    const plain = await context.newPage();
    await plain.goto(open.base, { waitUntil: 'domcontentloaded' });
    const also = await drawIn(context, worker, open.base);
    check('draws the same way', also.pages === 1 && also.canvases === 1, also.error || `${also.canvases} canvas`);
    check('and is just as quiet', also.violations.length === 0, also.violations.join('; '));

    console.log('\nWhy there is no worker to have');
    const tried = await worker.evaluate(async ([tabUrl]) => {
      const [tab] = await chrome.tabs.query({ url: `${tabUrl}*` });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => {
          try {
            const w = new Worker(chrome.runtime.getURL('vendor/pdf.worker.min.mjs'), { type: 'module' });
            w.terminate();
            return 'started';
          } catch (e) {
            return e.message;
          }
        },
      });
      return result;
    }, [strict.base]);
    check(
      'the extension cannot start a worker of its own either',
      /cannot be accessed from origin/i.test(tried),
      tried.slice(0, 80),
    );
  } finally {
    await context.close();
    strict.close();
    open.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
