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

  /*
   * And it has to name the job you asked for.
   *
   * All three mode buttons call the same `rebuild`, so the bar read
   * "Choosing what to change…" to somebody who had just pressed "Use it
   * unchanged" and asked for nothing to be changed. The bar's only purpose is
   * telling you whether what you asked for is under way.
   */
  console.log('\nThe bar names the mode you pressed');

  const labelFor = (button) => inPage(
    new Function('createCard', `return (${(async (createCard, want) => {
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
        // The AI button stays disabled until the card has asked and been told
        // the AI is on, so the status read has to answer before it can be
        // pressed.
        onAction: async (action) =>
          action === 'rebuild' ? held : action === 'aiStatus' ? { active: true, state: 'on' } : {},
      });
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      await new Promise((r) => setTimeout(r, 100));
      const button = [...root.querySelectorAll('button.mode')].find((b) => new RegExp(want).test(b.textContent));
      if (!button) return { error: `no ${want} button` };
      button.click();
      await new Promise((r) => setTimeout(r, 300));
      const label = root.querySelector('.progress-label span')?.textContent ?? null;
      release({});
      return { label };
    }).toString()})(createCard, ${JSON.stringify(button)})`),
  );

  const unchanged = await labelFor('Use it unchanged');
  const byKeyword = await labelFor('Match by keyword');
  const byAi = await labelFor('Let the AI tailor it');
  check(
    'asking for it unchanged does not say it is choosing what to change',
    unchanged.label != null && !/choosing what to change/i.test(unchanged.label),
    JSON.stringify(unchanged),
  );
  check('it says it is copying it across', /copying/i.test(unchanged.label ?? ''), JSON.stringify(unchanged));
  check('a keyword match says so', /keyword/i.test(byKeyword.label ?? ''), JSON.stringify(byKeyword));
  check('and the AI says it is reading the posting', /reading the posting/i.test(byAi.label ?? ''), JSON.stringify(byAi));

  /*
   * Where the bar is, while the AI reads.
   *
   * Every step-one action shared one bar at the top of the step, so a model
   * reading the posting for three minutes looked exactly like a compile: same
   * bar, same place, under a heading that says "Resume". Whether the AI is
   * what you are waiting for should be answerable by looking at the AI button.
   */
  console.log('\nThe AI holds up the AI, and says so where it happened');

  const aiHoldup = await inPage(async (createCard) => {
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
      onAction: async (action) =>
        action === 'rebuild' ? held : action === 'aiStatus' ? { active: true, state: 'on' } : {},
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 100));

    const modes = () => [...root.querySelectorAll('button.mode')];
    const named = (re) => modes().find((b) => re.test(b.textContent));
    named(/Let the AI tailor it/).click();
    await new Promise((r) => setTimeout(r, 200));

    const row = root.querySelector('.build-modes');
    const out = {
      // The bar is inside the row the buttons are in, not above them.
      barBesideButtons: Boolean(row?.querySelector('.progress')),
      barAtTopOfStep: Boolean(root.querySelector('.step > .progress, .step > div > .progress')),
      aiDisabled: named(/Reading the posting|Let the AI tailor it/)?.disabled ?? null,
      unchangedLive: named(/Use it unchanged/)?.disabled === false,
      matchLive: named(/Match by keyword/)?.disabled === false,
    };
    release({});
    await new Promise((r) => setTimeout(r, 150));
    return out;
  });

  check('the bar sits with the button that started it', aiHoldup.barBesideButtons === true, JSON.stringify(aiHoldup));
  check('and not at the top of the step, where a compile would put it', aiHoldup.barAtTopOfStep === false, JSON.stringify(aiHoldup));
  check('the AI button is the one that waits', aiHoldup.aiDisabled === true, JSON.stringify(aiHoldup));
  check('the other two ways to build stay live', aiHoldup.unchangedLive && aiHoldup.matchLive, JSON.stringify(aiHoldup));

  /*
   * Building what is already there, while the AI reads the posting.
   *
   * Compiling shared a lane with the three rebuild modes, so an AI pass —
   * minutes of it — greyed out "Build resume" as well. The proposal on screen
   * is complete and compilable the whole time that runs; waiting for an offer
   * is not something anyone should have to do.
   */
  console.log('\nBuilding while the AI is still reading');

  const duringScan = await inPage(async (createCard) => {
    let releaseScan;
    const scan = new Promise((r) => (releaseScan = r));
    const calls = [];
    const handle = createCard({
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
      onAction: async (action, payload) => {
        calls.push(action);
        if (action === 'rebuild') return scan;
        if (action === 'render') return { pages: 1, absolutePdfUrl: 'about:blank', spec: payload.spec };
        if (action === 'aiStatus') return { active: true, state: 'on' };
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 100));

    const named = (re) => [...root.querySelectorAll('button')].find((b) => re.test(b.textContent));
    named(/Let the AI tailor it/).click();
    await new Promise((r) => setTimeout(r, 200));

    const build = named(/Build resume|Recompile|Compiling/);
    const buildable = Boolean(build) && !build.disabled;
    if (buildable) build.click();
    await new Promise((r) => setTimeout(r, 300));
    const compiled = calls.includes('render');

    releaseScan({});
    await new Promise((r) => setTimeout(r, 200));
    return { buildable, compiled, calls };
  });

  check(
    'the build button stays live while the AI reads the posting',
    duringScan.buildable === true,
    JSON.stringify(duringScan.calls),
  );
  check('and pressing it actually compiles', duringScan.compiled === true, JSON.stringify(duringScan.calls));

  /*
   * And the race that opens up once it can: the scan lands, swaps the
   * proposal and clears the preview, and then the compile of the *old* one
   * arrives. Showing that picture would mean a page, a page count and a fit
   * badge belonging to a resume nobody chose.
   */
  const raced = await inPage(async (createCard) => {
    let releaseRender;
    const held = new Promise((r) => (releaseRender = r));
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', choices: { b: 'old' } },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) =>
        action === 'render' ? held : action === 'aiStatus' ? { active: true, state: 'on' } : {},
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 100));
    [...root.querySelectorAll('button')].find((b) => /Build resume|Recompile/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 200));

    // The scan lands with a different proposal while that compile is in flight.
    handle.update({
      spec: { id: 'job-acme', label: 'Acme', choices: { b: 'new' } },
      rationale: [],
      diff: [],
      tailor: 'ai',
      aiUsed: true,
    });
    releaseRender({ pages: 3, absolutePdfUrl: 'about:blank' });
    await new Promise((r) => setTimeout(r, 400));

    return {
      // A preview on screen now could only be the one compiled from the spec
      // that has since been replaced.
      shown: Boolean(root.querySelector('canvas.pdf-page')) || /3 pages/.test(root.textContent),
      offersBuild: Boolean(
        [...root.querySelectorAll('button')].find((b) => /Build resume/.test(b.textContent)),
      ),
    };
  });

  check('a compile that lost its proposal is not shown as a picture of the new one', raced.shown === false, JSON.stringify(raced));
  check('and the card asks to be built again instead', raced.offersBuild === true, JSON.stringify(raced));

  /*
   * What the card says when the AI you asked for did not happen.
   *
   * Two ways that goes and they want different words. The model ran and came
   * back with something unusable — a bad minute, worth trying again. Or it
   * never started, which is nearly always the configured command not being on
   * the path the builder runs with, and trying again does the same thing until
   * the setting is fixed.
   *
   * Neither used to be said. The server reports `tailor: 'match'` for both,
   * the card read that as "what was done", and the branch meant to catch this
   * tested the same field — so it could not fire, and a run whose AI had
   * failed read exactly like an ordinary keyword match.
   */
  console.log('\nWhen the AI did not happen');

  const summaryFor = (extra) => inPage(
    new Function('createCard', `return (${((createCard, more) => {
      const handle = createCard({
        analysis: {
          isJobPosting: true,
          job: { title: 'Platform Engineer', company: 'Acme' },
          spec: { id: 'job-acme', label: 'Acme' },
          baseLabel: 'New grad resume',
          rationale: [],
          diff: [],
          ...more,
        },
        resumes: [],
        settings: {},
        questions: [],
        needsCoverLetter: false,
        onAction: async () => ({}),
      });
      void handle;
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      return [...root.querySelectorAll('.hint')].map((n) => n.textContent).join(' | ');
    }).toString()})(createCard, ${JSON.stringify(extra)})`),
  );

  const failedToStart = await summaryFor({
    tailor: 'match',
    aiUsed: false,
    aiFailed: 'spawn /usr/local/bin/claude ENOENT',
  });
  check(
    'a model that would not start is named as that, not as a keyword match',
    /could not be started/i.test(failedToStart),
    failedToStart.slice(0, 120),
  );
  check(
    'and what the machine said is passed on, because it is what you would fix',
    /ENOENT/.test(failedToStart),
    failedToStart.slice(0, 120),
  );

  const unusable = await summaryFor({ tailor: 'match', aiUsed: false, aiRaw: 'Sure! Here are some ideas.' });
  check(
    'a model that answered with prose is told apart from one that would not start',
    /nothing usable/i.test(unusable) && !/could not be started/i.test(unusable),
    unusable.slice(0, 120),
  );

  const plainMatch = await summaryFor({ tailor: 'match', aiUsed: false });
  check(
    'and a keyword match nobody asked the AI for still reads as one',
    /keyword match against phrasings/i.test(plainMatch) && !/could not be started|nothing usable/i.test(plainMatch),
    plainMatch.slice(0, 120),
  );

  /*
   * What is still usable while the AI reads the posting.
   *
   * A tailoring pass is a model reading a job posting: minutes, not seconds.
   * Every control on the card used to test one `busy` flag, so for the length
   * of that run you could not type in the cover letter it was not touching,
   * answer a question, open the builder, or even press Done to put the card
   * away. The work being slow is not a reason for the rest of the card to be
   * gone.
   */
  console.log('\nWhile the AI is reading the posting');

  const whileTailoring = await inPage((createCard) => {
    let release;
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        baseLabel: 'New grad resume',
        // One swapped wording, so there is a switch to try while the pass runs.
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
        ],
        diff: [{ kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' }],
        tailor: 'match',
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: '', confident: false }],
      needsCoverLetter: true,
      // `rebuild` is the tailoring pass. Held open, so the card is caught
      // mid-run rather than after it.
      onAction: (action) =>
        action === 'rebuild' ? new Promise((r) => { release = r; }) : Promise.resolve({}),
    });
    handle.setLetter?.('Dear Acme, I am writing about the Platform Engineer role.');

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);

    // Start the pass the way the card does.
    byText('Match by keyword')?.click();

    const named = (t) => {
      const b = byText(t);
      return b ? b.disabled : null;
    };
    const state = {
      /*
       * Building is deliberately *not* in that lane any more: the proposal on
       * screen is compilable the whole time a scan runs, and waiting for an
       * offer is not something anyone should have to do. Applying written
       * feedback is, because it rewrites the same choices the pass is about
       * to replace.
       */
      building: named('Build resume') ?? named('Recompile'),
      applyFeedback: named('Apply feedback'),
      // The switches on the proposal already in front of you. An AI pass is
      // minutes long and has nothing to do with them.
      keepOriginal: (() => {
        root.querySelector('.fold-changes')?.click();
        const b = root.querySelector('button.undo-one');
        return b ? b.disabled : null;
      })(),
      // Filing waits for the two things it files.
      filing: named('Submit'),
      // Different lanes entirely: none of these touch the resume.
      draftLetter: named('✦Draft a letter'),
      draftAnswer: named('✦Draft an answer'),
      fillForm: named('Autofill this form'),
      // And the two that wait for nothing at all.
      editInBuilder: named('Edit in ResumeM-M'),
      // The × in the header is what puts the card away in this state; `Done`
      // belongs to the panel after filing. Both are ungated now.
      dismiss: named('×'),
      spinner: Boolean(root.querySelector('.spinner')),
    };
    release?.({});
    return state;
  });

  check(
    'the work that is running still says so',
    whileTailoring.spinner === true,
    JSON.stringify(whileTailoring),
  );
  check(
    'written feedback waits, because it rewrites what the pass is replacing',
    whileTailoring.applyFeedback === true,
    JSON.stringify(whileTailoring),
  );
  check(
    'but the resume you already have can still be built',
    whileTailoring.building === false,
    JSON.stringify(whileTailoring),
  );
  check(
    'and the keyword swaps on it can still be switched back',
    whileTailoring.keepOriginal === false,
    JSON.stringify(whileTailoring),
  );
  check(
    'and so does filing, which waits for what it files',
    whileTailoring.filing === true,
    String(whileTailoring.filing),
  );
  check(
    'the letter can still be drafted, because the resume is not the letter',
    whileTailoring.draftLetter === false,
    String(whileTailoring.draftLetter),
  );
  check('an answer can still be drafted', whileTailoring.draftAnswer === false, String(whileTailoring.draftAnswer));
  check('and the form can still be filled', whileTailoring.fillForm === false, String(whileTailoring.fillForm));
  check(
    'the builder can still be opened',
    whileTailoring.editInBuilder === false,
    String(whileTailoring.editInBuilder),
  );
  check(
    'and the card can always be put away',
    whileTailoring.dismiss === false,
    String(whileTailoring.dismiss),
  );

  /*
   * Folding it out of the way.
   *
   * The card is 380px of fixed-position panel over the form you are filling
   * in, and the field you need is under it often enough that "get out of the
   * way" is an ordinary thing to want. The only way to do that was to close
   * it, which took the letter, the answers and the built resume with it.
   */
  console.log('\nFolding the card away');

  const folding = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: '', confident: false }],
      needsCoverLetter: true,
      onAction: async () => ({}),
    });

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const card = root.querySelector('.card');
    const fold = () => [...root.querySelectorAll('button')].find((b) => /Fold|Unfold/.test(b.getAttribute('aria-label') ?? ''));
    const height = () => Math.round(card.getBoundingClientRect().height);
    const buttons = () => root.querySelectorAll('button').length;

    // Something worth not losing: typed in, the way it would be.
    const answer = root.querySelector('textarea[data-field^="answer:"]');
    answer.value = 'Because the ingest work is the part I like.';
    answer.dispatchEvent(new Event('input', { bubbles: true }));
    const open = { height: height(), buttons: buttons() };

    fold().click();
    const folded = {
      height: height(),
      buttons: buttons(),
      title: root.querySelector('.folded-title')?.textContent ?? null,
      // Still reachable while folded: you must be able to give up on it too.
      canClose: Boolean([...root.querySelectorAll('button')].find((b) => b.textContent.trim() === '×')),
    };

    // A repaint — the shape every background pass ends in.
    handle.setQuestions([
      { question: 'Why us?', answer: '', confident: false },
      { question: 'Tell us about a project.', answer: '', confident: false },
    ]);
    const afterRepaint = { folded: card.classList.contains('folded'), height: height() };

    fold().click();
    const reopened = {
      height: height(),
      answer: root.querySelector('textarea[data-field^="answer:"]')?.value ?? null,
    };

    return { open, folded, afterRepaint, reopened };
  });

  check(
    'folding makes it much shorter than it was',
    folding.folded.height < folding.open.height / 2,
    `${folding.open.height}px open, ${folding.folded.height}px folded`,
  );
  check(
    'and takes the controls off the screen rather than only hiding the text',
    folding.folded.buttons < folding.open.buttons,
    `${folding.open.buttons} buttons open, ${folding.folded.buttons} folded`,
  );
  check(
    'while still saying what it is a header for',
    /Platform Engineer/.test(folding.folded.title ?? ''),
    String(folding.folded.title),
  );
  check('and still offering the way out', folding.folded.canClose === true);
  /*
   * The one that makes it usable. A tailoring pass landing mid-application
   * repaints the card, and a fold that did not survive that would spring open
   * over the box being typed in.
   */
  check(
    'a repaint does not unfold it',
    folding.afterRepaint.folded === true && folding.afterRepaint.height === folding.folded.height,
    JSON.stringify(folding.afterRepaint),
  );
  check(
    'unfolding brings it all back',
    folding.reopened.height >= folding.open.height,
    `${folding.reopened.height}px vs ${folding.open.height}px`,
  );
  check(
    'with what was typed still in it, which is what closing would have cost',
    /part I like/.test(folding.reopened.answer ?? ''),
    String(folding.reopened.answer).slice(0, 50),
  );

  /*
   * Putting one change back.
   *
   * "Undo all" threw away every swap and sent the base resume untouched,
   * which is the wrong size of answer to "that one is wrong". The match is
   * usually right about most of them and occasionally wrong about one — a
   * degree line swapped for one naming a concentration, say — and the one it
   * is wrong about is the one you notice.
   */
  console.log('\nKeeping the original wording of one change');

  const undoing = await inPage((createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: 'v_kafka' } },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [
          { kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' },
          { kind: 'changed', where: 'Northeastern', from: 'BS in Computer Science', to: 'BS in Computer Science, Systems concentration' },
        ],
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
          { key: 'edu_neu.subtitle', from: 'v_plain', to: 'v_systems', toText: 'BS in Computer Science, Systems concentration', because: ['systems'] },
        ],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'render' ? { pages: 1, fits: true } : {};
      },
    });
    void handle;

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const rows = () => root.querySelectorAll('.change').length;
    const count = () => root.querySelector('.diff-head .count')?.textContent ?? null;
    const undoButtons = () => [...root.querySelectorAll('.undo-one')];
    const text = () => root.querySelector('.changes')?.textContent ?? '';

    // Shut by default, so this is the click that reveals the rows at all.
    const shutAtFirst = Boolean(root.querySelector('.changes.shut'));
    const hiddenAtFirst = root.querySelector('.change')?.checkVisibility?.() === false;
    root.querySelector('.fold-changes')?.click();

    const before = { rows: rows(), count: count(), offered: undoButtons().length, shutAtFirst, hiddenAtFirst };

    // Put back the second one — the degree line.
    undoButtons()[1].click();
    return {
      before,
      after: { rows: rows(), count: count(), stillNames: /Systems concentration/.test(text()) },
      // What the resume is compiled from now, which is also what filing sends.
      recompiled: sent.filter((c) => c.action === 'render').map((c) => c.payload.spec.choices),
    };
  });

  /*
   * The rows are the most detailed thing on the card and they sat between the
   * resume and the build button, so the ordinary case — read the count, accept
   * it, build — meant scrolling past every line of reasoning. The count stays
   * out; the rows come out when one of them looks wrong.
   */
  check('the list of changes starts shut', undoing.before.shutAtFirst === true, JSON.stringify(undoing.before));
  check('and its rows really are out of the way', undoing.before.hiddenAtFirst === true, JSON.stringify(undoing.before));
  check('every proposed change offers to be put back', undoing.before.offered === 2, JSON.stringify(undoing.before));
  check(
    'putting one back takes that row off the list',
    undoing.after.rows === undoing.before.rows - 1,
    `${undoing.before.rows} → ${undoing.after.rows}`,
  );
  check('and the count agrees', undoing.after.count === '1 change', String(undoing.after.count));
  check('and it is the one that was asked for', undoing.after.stillNames === false);
  /*
   * The half that matters. Taking the row off the screen and sending the
   * swapped wording anyway would be worse than not offering the button.
   */
  check(
    'the resume is recompiled with the original wording pinned back',
    undoing.recompiled.at(-1)?.['edu_neu.subtitle'] === 'v_plain',
    JSON.stringify(undoing.recompiled.at(-1)),
  );
  check(
    'and the change that was not undone is left alone',
    undoing.recompiled.at(-1)?.b_pipeline === 'v_kafka',
    JSON.stringify(undoing.recompiled.at(-1)),
  );

  /*
   * And the skills rows, which had no way back at all.
   *
   * The button above tests for a `key` and a `from`, which is the shape of a
   * wording swap: one of several phrasings an entry holds, recorded in
   * `choices`. A narrowed skills group is a set of items under
   * `sections[skills].items` and has neither, so every skills row came up
   * without an undo — and those are the rows most likely to be wrong, four
   * groups cut at once off the same handful of keywords. The only answer on
   * offer was to throw the whole proposal away.
   */
  console.log('\nKeeping a skills group the way it was');

  const skillUndo = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: {
          id: 'job-acme',
          label: 'Acme',
          choices: { b_pipeline: 'v_kafka' },
          sections: [
            { kind: 'skills', groups: ['sk_lang', 'sk_tools'], items: { sk_lang: ['s_py', 's_go'], sk_tools: ['t_k8s'] } },
          ],
        },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [
          { kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' },
          { kind: 'removed', where: 'Languages', text: 'Languages: dropped Ruby, PHP — keeping Python, Go' },
          { kind: 'removed', where: 'Developer Tools', text: 'Developer Tools: dropped Docker — keeping Kubernetes' },
        ],
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
        ],
        skillChanges: [
          // The base named its own list for this one.
          { groupId: 'sk_lang', groupName: 'Languages', from: ['s_py', 's_go', 's_rb', 's_php'], to: ['s_py', 's_go'] },
          // And expressed no preference for this one, which prints them all.
          { groupId: 'sk_tools', groupName: 'Developer Tools', from: null, to: ['t_k8s'] },
        ],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'render' ? { pages: 1, fits: true } : {};
      },
    });

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const rows = () => root.querySelectorAll('.change').length;
    const undoButtons = () => [...root.querySelectorAll('.undo-one')];
    const text = () => root.querySelector('.changes')?.textContent ?? '';

    root.querySelector('.fold-changes')?.click();
    const offered = undoButtons().length;
    const before = rows();

    // Between the two, because undoing recompiles and the rest of the undo
    // buttons are held while it does — a second click landing on a disabled
    // button would do nothing and this would pass for the wrong reason.
    const settle = () => new Promise((r) => setTimeout(r, 50));

    // Guarded rather than assumed: without the fix there are no skills undo
    // buttons at all, and this has to report that rather than throw.
    const clickUndo = async (at) => {
      const button = undoButtons()[at < 0 ? undoButtons().length + at : at];
      if (!button) return false;
      button.click();
      await settle();
      return true;
    };

    // The group whose base list was explicit.
    const clicked = await clickUndo(1);
    const afterFirst = { rows: rows(), stillNames: /dropped Ruby/.test(text()), clicked };
    // And the one where the base said nothing.
    await clickUndo(-1);

    const last = sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec;
    const skills = (last?.sections ?? []).find((x) => x.kind === 'skills');
    return {
      offered,
      before,
      afterFirst,
      after: rows(),
      items: skills?.items ?? null,
      hasTools: skills ? Object.prototype.hasOwnProperty.call(skills.items ?? {}, 'sk_tools') : null,
      choices: last?.choices ?? null,
    };
  });

  check('a skills row offers to be put back, like every other row', skillUndo.offered === 3, JSON.stringify(skillUndo));
  check(
    'putting one back takes that row off the list',
    skillUndo.afterFirst.rows === skillUndo.before - 1 && skillUndo.afterFirst.stillNames === false,
    JSON.stringify(skillUndo.afterFirst),
  );
  /*
   * The half that matters, as with the wordings: taking the row off the screen
   * and compiling the narrowed group anyway would be worse than no button.
   */
  check(
    'the group the base named is compiled with its own list back',
    JSON.stringify(skillUndo.items?.sk_lang) === JSON.stringify(['s_py', 's_go', 's_rb', 's_php']),
    JSON.stringify(skillUndo.items),
  );
  /*
   * `null` from the base is an answer, not a gap: a group with no entry under
   * `items` prints all of its items, and the way to say that is to leave the
   * key out. Writing an empty list instead would print nothing.
   */
  check(
    'and the group it named nothing for goes back to having no entry at all',
    skillUndo.hasTools === false,
    JSON.stringify(skillUndo.items),
  );
  check('both rows are gone and the wording swap is untouched', skillUndo.after === 1 && skillUndo.choices?.b_pipeline === 'v_kafka', JSON.stringify(skillUndo));

  /*
   * The letter and the answers, written by one run.
   *
   * They used to be a run each — one for the letter, one per question — so a
   * form with three was four runs of a model, each reading the same posting
   * and the same corpus from scratch, and none able to see what the others
   * wrote. Which is how an application says two different things about why
   * you want the job.
   */
  console.log('\nOne run writes the letter and every answer');

  const oneRun = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme', description: 'Kafka and Go.' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [
        { question: 'Why us?', answer: '', confident: false },
        { question: 'Tell us about a project.', answer: '', confident: false },
      ],
      needsCoverLetter: true,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'writeApplication') {
          // Keyed by the ids the card minted for this round trip.
          const ids = payload.questions.map((q) => q.id);
          return {
            oneRun: true,
            letter: 'Dear Acme, I build streaming systems.',
            answers: { [ids[0]]: 'Because of the Kafka work.', [ids[1]]: 'I built a pipeline.' },
            priorLetters: [],
            aiUsed: true,
          };
        }
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));

    const button = [...root.querySelectorAll('button')].find((b) => /Write the letter and/.test(b.textContent));
    const label = button?.textContent ?? null;
    button?.click();
    await new Promise((r) => setTimeout(r, 300));

    const boxes = [...root.querySelectorAll('textarea')].map((t) => ({ field: t.dataset.field, value: t.value }));
    return {
      label,
      runs: sent.filter((c) => /writeApplication|coverLetter|^answer:/.test(c.action)).map((c) => c.action),
      asked: sent.find((c) => c.action === 'writeApplication')?.payload ?? null,
      boxes,
    };
  });

  check('one button offers to write all of it', /Write the letter and 2 answers/.test(oneRun.label ?? ''), String(oneRun.label));
  check(
    'and it is one run, not one per thing',
    oneRun.runs.length === 1 && oneRun.runs[0] === 'writeApplication',
    JSON.stringify(oneRun.runs),
  );
  check(
    'the run is told about the letter and every question',
    oneRun.asked?.letter?.required === true && (oneRun.asked?.questions ?? []).length === 2,
    JSON.stringify(oneRun.asked?.questions?.map((q) => q.id)),
  );
  check(
    'the letter it wrote lands in the letter box',
    oneRun.boxes.some((b) => b.field === 'letter' && /I build streaming systems/.test(b.value)),
    JSON.stringify(oneRun.boxes.map((b) => b.field)),
  );
  /*
   * Keyed back by question text, because that is the only key this card has —
   * the ids are minted for the round trip and thrown away.
   */
  check(
    'and each answer lands in its own box',
    oneRun.boxes.some((b) => b.field === 'answer:Why us?' && /Kafka work/.test(b.value)) &&
      oneRun.boxes.some((b) => b.field === 'answer:Tell us about a project.' && /built a pipeline/.test(b.value)),
    JSON.stringify(oneRun.boxes),
  );

  /*
   * What a run wrote over, and could not use.
   *
   * The answer box stays enabled while a run is writing — the obvious thing to
   * do with a wait of minutes is write it yourself — and what you type wins.
   * That was already true and already recorded, in a field nothing rendered,
   * so a discarded draft was discarded in silence. One run writing every
   * answer can discard several, which makes the silence worse.
   */
  console.log('\nWhat you typed beats what the run wrote, and it says so');

  const clash = await inPage(async (createCard) => {
    let release;
    const held = new Promise((r) => (release = r));
    let ids = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme', description: 'Kafka and Go.' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [
        { question: 'Why us?', answer: '', confident: false },
        { question: 'Tell us about a project.', answer: '', confident: false },
      ],
      needsCoverLetter: true,
      onAction: async (action, payload) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'writeApplication') {
          ids = payload.questions.map((q) => q.id);
          return held;
        }
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));
    [...root.querySelectorAll('button')].find((b) => /Write the letter and/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 200));

    // Typed into both boxes while the run was out.
    for (const box of root.querySelectorAll('textarea[data-field^="answer:"]')) {
      box.value = 'Mine, written by hand.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }

    release({
      oneRun: true,
      letter: 'Dear Acme.',
      answers: { [ids[0]]: 'The run wrote this.', [ids[1]]: 'And this.' },
      priorLetters: [],
      aiUsed: true,
    });
    await new Promise((r) => setTimeout(r, 300));

    return {
      boxes: [...root.querySelectorAll('textarea[data-field^="answer:"]')].map((t) => t.value),
      said: root.textContent.match(/You were writing while that ran[^.]*\./)?.[0] ?? null,
    };
  });

  check(
    'what you typed is still there, not the run\u2019s version',
    clash.boxes.length === 2 && clash.boxes.every((v) => /Mine, written by hand/.test(v)),
    JSON.stringify(clash.boxes),
  );
  check('and the card says so rather than dropping them in silence', Boolean(clash.said), String(clash.said));
  check('counting them, because one run can collide with several', /2 answers/.test(clash.said ?? ''), String(clash.said));

  /*
   * Two rebuilds really can be in flight now, so the bar has to belong to the
   * one still running. A set held one entry per name, so the fast one's
   * removal took the bar down while a model was still reading.
   */
  console.log('\nThe bar belongs to the work still going');

  const overlap = await inPage(async (createCard) => {
    let releaseAi;
    const slowAi = new Promise((r) => (releaseAi = r));
    let seen = 0;
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
      onAction: async (action, payload) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'rebuild') {
          seen += 1;
          // The AI is slow; the keyword match is not.
          return payload.tailor === 'ai' ? slowAi : {};
        }
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));
    const named = (re) => [...root.querySelectorAll('button.mode')].find((b) => re.test(b.textContent));

    named(/Let the AI tailor it/).click();
    await new Promise((r) => setTimeout(r, 150));
    named(/Match by keyword/).click();
    await new Promise((r) => setTimeout(r, 400));

    const during = { runs: seen, bar: Boolean(root.querySelector('.progress')) };
    releaseAi({});
    await new Promise((r) => setTimeout(r, 250));
    return { during, barAfter: Boolean(root.querySelector('.progress')) };
  });

  check('both really ran, so this is the overlap that mattered', overlap.during.runs === 2, JSON.stringify(overlap));
  check(
    'the bar stays up while the AI is still reading',
    overlap.during.bar === true,
    JSON.stringify(overlap),
  );
  check('and comes down when it finishes', overlap.barAfter === false, JSON.stringify(overlap));

  /*
   * Building puts the files where the upload dialog will be.
   *
   * The flat folder is a projection of the tracker, so nothing reached it
   * until an application existed, and the only thing that made one was the
   * submit button. That is the wrong moment: you press it *after* filling the
   * form, and the file dialog opens during. So building files the application
   * as `applying` — built, in the folder, not yet sent — and submitting moves
   * it on.
   *
   * The compile matters as much as the timing. "Build resume" renders through
   * the fast preview path, which is explicitly not what gets attached; the
   * staging call is a real compile, which is why it is a second request and
   * not a copy of the preview.
   */
  console.log('\nBuilding puts the files in place');

  const staging = await inPage((createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'render' ? { pages: 1, fits: true } : {};
      },
    });
    void handle;

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);

    byText('Build resume').click();
    return new Promise((resolve) => setTimeout(() => resolve({
      actions: sent.map((c) => c.action),
      staged: sent.find((c) => c.action === 'stage')?.payload ?? null,
      submitLabel: Boolean(byText('Submit')),
      oldLabel: Boolean(byText('Prepare to submit')),
    }), 60));
  });

  check('building still compiles the preview', staging.actions.includes('render'), JSON.stringify(staging.actions));
  check(
    'and puts the real files in the flat folder without being asked',
    staging.actions.includes('stage'),
    JSON.stringify(staging.actions),
  );
  check(
    'sending the resume it just built',
    staging.staged?.spec?.id === 'job-acme',
    JSON.stringify(staging.staged),
  );
  check('the filing button says what it does', staging.submitLabel === true && staging.oldLabel === false);

  /*
   * And the folder is reachable from the moment it has something in it.
   *
   * The path lived in the panel *after* filing, which is the one place it is
   * not needed: by then the upload has happened. An extension cannot set
   * where the file dialog opens — that is deliberately out of reach — so a
   * path you can paste into its location bar is what there is, and it has to
   * be there while the dialog is open.
   */
  const folderShown = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) =>
        action === 'render'
          ? { pages: 1, fits: true }
          : action === 'stage'
            ? { currentDir: '/Users/someone/resume/out/current', files: ['Someone-Resume.pdf'] }
            : {},
    });
    void handle;
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);

    const beforeBuilding = Boolean(root.querySelector('.staged .path'));
    byText('Build resume').click();
    return new Promise((resolve) => setTimeout(() => resolve({
      beforeBuilding,
      path: root.querySelector('.staged .path')?.textContent ?? null,
      canCopy: Boolean([...root.querySelectorAll('.staged button')].find((b) => /Copy folder path/.test(b.textContent))),
      // Filing has not happened: this is the point.
      filed: Boolean(root.querySelector('.done-box')),
    }), 60));
  });

  check('nothing claims a folder before there is one', folderShown.beforeBuilding === false);
  check(
    'and after building the folder to attach from is named',
    folderShown.path === '/Users/someone/resume/out/current',
    String(folderShown.path),
  );
  check('with a way to paste it into the dialog', folderShown.canCopy === true);
  check('all of it before anything is filed', folderShown.filed === false);

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
