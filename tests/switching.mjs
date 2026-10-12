/**
 * A board that swaps the posting in place, with the last one's card still busy.
 *
 * LinkedIn's job search shows the selected posting beside the list, at
 * `/jobs/search-results/?currentJobId=…`; clicking the next job changes that
 * number with `pushState` and nothing else. The content script notices on its
 * one-second tick and puts up a fresh card — but the card for the job just
 * left had a stage queued (`prepareSoon`'s wait, after a box was ticked), and
 * taking it off the page did not stop it. The stage went out with that job's
 * tailored resume, and the content script filed it under the page as it now
 * was: the next job's address and, once its analysis had landed, its company.
 * Measured in a real store: "Apply: AV — Associate Software Engineer" filed
 * with `job-visa-sw-engineer`, a second after Visa's own.
 *
 * Driven through the card's own handle over a store kept in the page, as
 * tests/midaction.mjs does, on a page served at a board-shaped address so the
 * url can move the way the board moves it. Each stage records the address it
 * left from, which is what the content script files it under.
 *
 *   node tests/switching.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { findChromium } from './fixtures.mjs';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const BOARD = 'https://board.example/jobs/search-results/';
const at = (job) => `${BOARD}?currentJobId=${job}&keywords=C%2B%2B`;

/*
 * The parts of the worker and ResumeM-M the card talks to while staging. A
 * stage is recorded with the address the page is at when it is sent — the
 * one `content.js` puts on the application.
 */
const STORE = `(() => {
  const s = { sent: [], copy: null, folder: [] };
  s.onAction = async (action, payload) => {
    s.sent.push({ action, href: location.href, specId: payload?.spec?.id ?? null });
    switch (action) {
      case 'render':
        return { pages: 1, fits: true, printed: 'p1', spec: payload.spec };
      case 'stage':
      case 'bundle':
        s.copy = JSON.parse(JSON.stringify(payload.spec));
        s.folder.push(payload.spec.id);
        return { currentDir: '/tmp/upload', application: { id: 'app' }, files: ['Jane-Resume.pdf'] };
      case 'fresh':
        return { printed: 'p1', stored: s.copy, storedPrint: s.copy ? JSON.stringify(s.copy) : null, base: null };
      case 'listResumes':
        return [];
      default:
        return {};
    }
  };
  return s;
})()`;

const posting = (company, title, id) => ({
  isJobPosting: true,
  job: { title, company },
  spec: { id, label: company, tier: 'temporary', copiedFrom: 'base', choices: {} },
  baseResumeId: 'base',
  baseLabel: 'New grad resume',
  currentDir: '/tmp/upload',
  tailor: 'match',
  diff: [{ kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' }],
  rationale: [{ key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] }],
});
const VISA = posting('Visa', 'SW Engineer', 'job-visa-sw-engineer');
const AV = posting('AV', 'Associate Software Engineer', 'job-av-associate-software-engineer');

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.route('https://board.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Jobs</title><body><main>Search results</main></body>' }),
  );
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');

  /*
   * A fresh page at the first posting, a card on it built and staged the way
   * pressing Build resume leaves one, and a wording ticked — so a stage is
   * queued, `prepareSoon`'s 1.2 seconds away.
   */
  const builtAndTicked = async () => {
    await page.goto(at(4401));
    return page.evaluate(
      async ([code, store, analysis]) => {
        // A harness, not a page: the card takes untrusted presses here. See `HARNESS` in card.js.
        globalThis.__JOBHELPER_HARNESS__ = true;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const mod = await import(url);
        const s = (0, eval)(store);
        const handle = mod.createCard({ analysis, resumes: [], settings: {}, questions: [], onAction: s.onAction });
        const root = document.querySelector('#jobhelper-card-host').shadowRoot;
        window.jh = { mod, s, handle, root };
        window.wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.until = async (test, ms = 5000) => {
          for (const end = Date.now() + ms; Date.now() < end; await window.wait(20)) if (test()) return true;
          return false;
        };
        window.stages = () => jh.s.sent.filter((c) => c.action === 'stage');
        [...root.querySelectorAll('button')].find((b) => /Build resume/.test(b.textContent)).click();
        if (!(await until(() => jh.s.folder.length > 0))) return { built: false };
        await wait(100);
        root.querySelector('.fold-changes')?.click();
        const before = stages().length;
        const renders = jh.s.sent.filter((c) => c.action === 'render').length;
        root.querySelector('.pick input').click();
        // The compile the tick starts lands first; the stage waits on after it.
        await until(() => jh.s.sent.filter((c) => c.action === 'render').length > renders);
        await wait(50);
        return { built: true, before, queued: stages().length === before };
      },
      [source, STORE, VISA],
    );
  };

  /* ------------------------------------------------------------------ */
  console.log('\nThe card stays on its own posting');
  {
    const set = await builtAndTicked();
    const out = await page.evaluate(async (before) => {
      await until(() => stages().length > before, 4000);
      return stages().slice(before);
    }, set.before);
    check('built and staged, with a stage queued by the tick', set.built && set.queued, JSON.stringify(set));
    check(
      'the queued stage goes, for this posting at this address',
      out.length >= 1 && out.every((c) => c.specId === VISA.spec.id && /currentJobId=4401/.test(c.href)),
      JSON.stringify(out),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe next job clicked before the tick has noticed');
  {
    const set = await builtAndTicked();
    const out = await page.evaluate(async ([before, next]) => {
      // The board swaps the posting: the address moves, nothing reloads, and
      // the content script has not yet taken this card down.
      history.pushState({}, '', next);
      await wait(2500);
      return stages().slice(before);
    }, [set.before, at(4476387574)]);
    check('built and staged, with a stage queued by the tick', set.built && set.queued, JSON.stringify(set));
    check(
      "the last posting's queued stage is not filed under the next posting's address",
      out.length === 0,
      JSON.stringify(out),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log("\nThe next job's card up, the last one's still counting down");
  {
    const set = await builtAndTicked();
    const out = await page.evaluate(
      async ([before, next, av]) => {
        history.pushState({}, '', next);
        // What `startOver` does a tick later: the old card off, a new one up.
        jh.mod.removeCard();
        jh.mod.createCard({ analysis: av, resumes: [], settings: {}, questions: [], onAction: jh.s.onAction });
        await wait(2500);
        return stages().slice(before);
      },
      [set.before, at(4476387574), AV],
    );
    check('built and staged, with a stage queued by the tick', set.built && set.queued, JSON.stringify(set));
    check(
      "no stage carries the last posting's resume once the next posting's card is up",
      out.every((c) => c.specId !== VISA.spec.id),
      JSON.stringify(out),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe card replaced on the same address');
  {
    // A board that swaps the job and changes only the title: `startOver`
    // runs from `plainlyAnotherRole`, and the address never moves.
    const set = await builtAndTicked();
    const out = await page.evaluate(
      async ([before, av]) => {
        jh.mod.createCard({ analysis: av, resumes: [], settings: {}, questions: [], onAction: jh.s.onAction });
        await wait(2500);
        return stages().slice(before);
      },
      [set.before, AV],
    );
    check('built and staged, with a stage queued by the tick', set.built && set.queued, JSON.stringify(set));
    check("a replaced card's queued stage does not go out", out.every((c) => c.specId !== VISA.spec.id), JSON.stringify(out));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe card put away with ×, on the same posting');
  {
    const set = await builtAndTicked();
    const out = await page.evaluate(async (before) => {
      jh.root.querySelector('button[title="Not now"]').click();
      await until(() => stages().length > before, 4000);
      return stages().slice(before);
    }, set.before);
    check('built and staged, with a stage queued by the tick', set.built && set.queued, JSON.stringify(set));
    check(
      'the change made just before closing still reaches the folder',
      out.length >= 1 && out.every((c) => c.specId === VISA.spec.id && /currentJobId=4401/.test(c.href)),
      JSON.stringify(out),
    );
  }

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
