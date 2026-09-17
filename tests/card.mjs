/**
 * The card itself, driven through its own API in a real browser.
 *
 * Everything else here drives the whole extension against a live server, which
 * is right for the flows and wrong for a question like "does the caret survive
 * a repaint" — that needs a repaint to happen at a moment of the test's
 * choosing, and none of the things that cause one in the wild can be summoned
 * on demand. `createCard` returns a handle whose methods are exactly those
 * events, so this calls them.
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


async function main() {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');

  const inPage = (fn) => page.evaluate(
    async ([code, body]) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const { createCard, removeCard } = await import(url);
      removeCard();
      // eslint-disable-next-line no-new-func
      return new Function('createCard', `return (${body})(createCard)`)(createCard);
    },
    [source, fn.toString()],
  );

  console.log('\nWriting while the card repaints');

  /*
   * The card rebuilds its whole subtree on every repaint, and it repaints when
   * the AI status arrives, when the resume list arrives, when the trail
   * arrives, and when a background tailoring pass lands minutes later. The
   * characters already typed survive — each one fires `oninput` — but the box
   * being typed into is destroyed, so focus goes to null and the *next*
   * keystroke goes nowhere until the user notices and clicks back.
   */
  const typing = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: '', confident: false }],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;

    const box = root.querySelector('textarea[data-field^="answer:"]');
    if (!box) return { error: 'no answer box' };
    box.focus();
    box.value = 'Half a sent';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(4, 4);

    // A second question arriving: a real repaint, touching nothing about focus.
    handle.setQuestions([
      { question: 'Why us?', answer: '', confident: false },
      { question: 'Tell us about a project.', answer: '', confident: false },
    ]);

    const active = root.activeElement;
    return {
      replaced: !box.isConnected,
      tag: active?.tagName ?? null,
      field: active?.dataset?.field ?? null,
      value: active?.value ?? null,
      caret: active?.selectionStart ?? null,
    };
  });

  check('the box really is rebuilt, so this is the case that mattered', typing.replaced === true);
  check('the caret is still in a text box', typing.tag === 'TEXTAREA', JSON.stringify(typing));
  check('and in the same one', typing.field === 'answer:Why us?', String(typing.field));
  check('with what was typed still in it', typing.value === 'Half a sent', String(typing.value));
  check('and the caret where it was, not at the end', typing.caret === 4, String(typing.caret));

  console.log('\nSaying how long the AI has been thinking');

  /*
   * An indeterminate bar animates whether or not anything is happening, so
   * after the first half-minute of an AI pass it stops being reassurance and
   * becomes the thing you are trying to decide about. The clock moves for a
   * real reason. It is held back for two seconds, because a keyword match
   * finishes in a third of one and a clock that flashes 0:00 is noise — and
   * it ticks in place, because redrawing the card once a second would take
   * the caret out of whatever box is being typed into, which is the bug the
   * block above exists for.
   */
  const timing = await inPage(async (createCard) => {
    let release;
    const held = new Promise((r) => (release = r));
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        rationale: [],
      },
      resumes: [{ id: 'base', label: 'New grad', base: true }],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => (action === 'rebuild' ? held : {}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;

    const match = [...root.querySelectorAll('button.mode')].find((b) => /Match by keyword/.test(b.textContent));
    if (!match) return { error: 'no match button' };
    match.click();

    const read = () => root.querySelector('.progress-label .elapsed')?.textContent ?? null;
    await new Promise((r) => setTimeout(r, 400));
    const early = read();
    const bar = Boolean(root.querySelector('.progress'));
    await new Promise((r) => setTimeout(r, 2800));
    const later = read();
    // And it stops when the work does, rather than counting forever.
    release({});
    await new Promise((r) => setTimeout(r, 1600));
    const after = Boolean(root.querySelector('.progress'));
    return { early, later, bar, after };
  });

  check('a bar goes up the moment the work starts', timing.bar === true, JSON.stringify(timing));
  check('with no clock on it yet, because most work is quicker than that', timing.early === '', String(timing.early));
  check('and a clock once it has been a while', /^\d+:\d\d$/.test(timing.later ?? ''), String(timing.later));
  check('which clears with the work rather than counting on', timing.after === false);

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
