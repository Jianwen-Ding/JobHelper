/**
 * Every form a round of review has said is, or is not, a job application,
 * kept as a test.
 *
 * `looksLikeJobApplication` decides whether the card may read a page on its
 * own say-so, and its patterns were moved a round at a time: "cvs?" became
 * "cv" for the pharmacy, "application" came off the verb's words and went
 * back on, and each time something an earlier round had settled moved with
 * it. The forms from every round's tests, lists and reports are in one
 * corpus, the disagreements decided once, and all of it is asked here.
 *
 * Served the way `ats-forms.mjs` serves its fixtures — on 127.0.0.1, so no
 * hiring system's host vouches for any of them — and asked in Chromium,
 * because the answer depends on what is drawn where.
 *
 *   node tests/corpus-jobforms.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// Stored in pieces where a value is shaped like a secret; see corpus-links.mjs.
const joined = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.parts)
    ? v.parts.join('')
    : Array.isArray(v)
      ? v.map(joined)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, joined(x)]))
        : v;

const { cases } = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/corpus-jobforms.json'), 'utf8'));
const shell = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body><form>${body}</form></body></html>`;

async function main() {
  const autofill = fs.readFileSync(path.join(root, 'src/content/autofill.js'), 'utf8');
  const shared = fs.readFileSync(path.join(root, 'src/shared/remembering.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/autofill.js' || url === '/shared/remembering.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(url === '/autofill.js' ? autofill : shared);
    }
    const c = cases.find((x) => `/case/${x.id}` === url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(c ? shell(joined(c.input).body) : '<html><body>?</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  try {
    check('the corpus is settled: every case is a job or is not', cases.every((c) => typeof c.expect === 'boolean'));
    const page = await browser.newPage();
    for (const c of cases) {
      await page.goto(`${base}/case/${c.id}`, { waitUntil: 'load' });
      const got = await page.evaluate(async (b) => {
        const m = await import(`${b}/autofill.js`);
        return m.looksLikeJobApplication?.() ?? '(no such test)';
      }, base);
      const said = c.sources.map((s) => `${s.round} [${s.basis}]`).join(', ');
      const { name } = joined(c.input);
      if (c.todo && got !== c.expect) console.log(`  todo  ${c.id} ${name} — ${c.todo}`);
      else check(`${c.id} ${name} ${c.expect ? 'is' : 'is not'} a job application`, got === c.expect, got === c.expect ? '' : `got ${JSON.stringify(got)}; ${said}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
