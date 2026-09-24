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

  // `given` is for the cases that want the same body run with different data;
  // everything written before it takes one argument and ignores this.
  const inPage = (fn, given) => page.evaluate(
    async ([code, body, arg]) => {
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const { createCard, removeCard } = await import(url);
      removeCard();
      // eslint-disable-next-line no-new-func
      return new Function('createCard', 'given', `return (${body})(createCard, given)`)(createCard, arg);
    },
    [source, fn.toString(), given ?? null],
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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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

  /*
   * And the box scrolled where it was. The letter box is a fixed height and
   * a letter is longer than it, so writing the last paragraph means the box
   * is scrolled to its end. The caret came back after a repaint and the
   * scroll did not: the box showed the letter's first lines, and the line
   * being written was out of sight until the next keystroke dragged it back.
   */
  const letterScroll = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: true,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const box = root.querySelector('textarea[data-field="letter"]');
    if (!box) return { error: 'no letter box' };
    box.focus();
    box.value = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of a letter long enough to scroll its box.`).join('\n');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(box.value.length, box.value.length);
    box.scrollTop = box.scrollHeight;
    const was = box.scrollTop;

    handle.setQuestions([{ question: 'Tell us about a project you led.', answer: '', confident: false }]);

    const now = root.querySelector('textarea[data-field="letter"]');
    return { was, now: now.scrollTop, replaced: now !== box };
  });
  check(
    'a long letter stays scrolled to where it is being written',
    letterScroll.replaced === true && letterScroll.was > 0 && letterScroll.now === letterScroll.was,
    JSON.stringify(letterScroll),
  );

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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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

    // The AI is the run worth timing, and the only one that goes to the
    // server now — "Use Original" is a local revert and a recompile. Its
    // button is dead until the status read answers.
    await new Promise((r) => setTimeout(r, 100));
    const ai = [...root.querySelectorAll('button.mode')].find((b) => /Have AI Tailor/.test(b.textContent));
    if (!ai) return { error: 'no AI button' };
    ai.click();

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
          spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
          rationale: [],
        },
        resumes: [{ id: 'base', label: 'New grad', base: true }],
        settings: {},
        questions: [],
        needsCoverLetter: false,
        /*
         * Both long calls are held, because the two buttons no longer make
         * the same one: the AI goes to the server as `rebuild`, and "Use
         * Original" puts the suggestions back locally and recompiles. Holding
         * only `rebuild` left the second one's bar up for the length of an
         * immediate reply, which is not long enough to read.
         *
         * The AI button also stays disabled until the card has asked and been
         * told the AI is on, so the status read has to answer first.
         */
        onAction: async (action) =>
          action === 'rebuild' || action === 'render'
            ? held
            : action === 'aiStatus'
              ? { active: true, state: 'on' }
              : {},
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

  const unchanged = await labelFor('Use Original');
  const byAi = await labelFor('Have AI Tailor');
  /*
   * Two buttons, and the bar has to tell them apart. "Use Original" never
   * leaves the machine — it puts every suggestion back and recompiles — so a
   * bar saying "Choosing what to change…" over it would be describing work
   * nobody asked for and nothing is doing.
   */
  check(
    'asking for the original does not say it is choosing what to change',
    unchanged.label != null && !/choosing what to change|reading the posting/i.test(unchanged.label),
    JSON.stringify(unchanged),
  );
  check('it says it is compiling', /compil/i.test(unchanged.label ?? ''), JSON.stringify(unchanged));
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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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
    named(/Have AI Tailor/).click();
    await new Promise((r) => setTimeout(r, 200));

    const row = root.querySelector('.build-modes');
    const out = {
      // The bar is inside the row the buttons are in, not above them.
      barBesideButtons: Boolean(row?.querySelector('.progress')),
      barAtTopOfStep: Boolean(root.querySelector('.step > .progress, .step > div > .progress')),
      aiDisabled: named(/Reading the posting|Have AI Tailor/)?.disabled ?? null,
      unchangedLive: named(/Use Original/)?.disabled === false,
    };
    release({});
    await new Promise((r) => setTimeout(r, 150));
    return out;
  });

  check('the bar sits with the button that started it', aiHoldup.barBesideButtons === true, JSON.stringify(aiHoldup));
  check('and not at the top of the step, where a compile would put it', aiHoldup.barAtTopOfStep === false, JSON.stringify(aiHoldup));
  check('the AI button is the one that waits', aiHoldup.aiDisabled === true, JSON.stringify(aiHoldup));
  check('the other way to build stays live', aiHoldup.unchangedLive === true, JSON.stringify(aiHoldup));

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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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
    named(/Have AI Tailor/).click();
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
          spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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

  /*
   * A plan the server mostly refused, reported as a plan.
   *
   * Every id a model names is checked against the save and the ones that are
   * not there are dropped — that is where "the AI chooses between wordings and
   * never writes one" is actually enforced. What it dropped was computed and
   * thrown away before it reached here, so a run where the model invented
   * twelve of its fifteen choices arrived looking exactly like one where it
   * chose three, and the card said "chosen by the AI" over both. Which is the
   * one thing worth knowing about that run: it is the one worth asking again.
   */
  const mostlyRefused = await summaryFor({
    tailor: 'ai',
    aiUsed: true,
    rejected: ['choice b_ghost: no such bullet', 'choice b_pipeline: not a variant id'],
  });
  check(
    'a plan the save mostly refused says so',
    /2 things the AI asked for are not in your save/.test(mostlyRefused),
    mostlyRefused.slice(0, 160),
  );
  check(
    'and never by the ids it named, which are not for reading',
    !/b_ghost|b_pipeline|v_/.test(mostlyRefused),
    mostlyRefused.slice(0, 160),
  );

  const refusedOne = await summaryFor({ tailor: 'ai', aiUsed: true, rejected: ['choice b_ghost: no such bullet'] });
  check(
    'one of them is one thing, not 1 things',
    /One thing the AI asked for is not in your save/.test(refusedOne),
    refusedOne.slice(0, 160),
  );

  const refusedNothing = await summaryFor({ tailor: 'ai', aiUsed: true, rejected: [] });
  check(
    'and a run the save took whole says nothing about refusals',
    !/asked for/.test(refusedNothing),
    refusedNothing.slice(0, 160),
  );

  /*
   * And the same sentence on a run that landed in the background.
   *
   * An AI pass started on one page arrives minutes later, is filed rather
   * than shown (see `fileOffer`), and is put on screen by pressing its
   * button — a different path into `builtSummary` than the one above, which
   * reads the analysis the card opened with.
   *
   * It does not pin which side of `PROPOSAL_KEYS` the field sits on: both
   * halves reach `analysis` through an `Object.assign`, so moving it changes
   * nothing observable. It is in the proposal half because that is what it
   * describes — a keyword match has nothing to refuse — and because a
   * per-proposal field sitting in `aboutThePage` is a stale count waiting to
   * be shown over somebody else's run.
   */
  const refusedInTheBackground = await inPage(async (createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
        tailor: 'match',
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => (action === 'aiStatus' ? { active: true, state: 'on' } : {}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));

    // Filed, not shown: nobody pressed for it on this page.
    handle.update({
      spec: { id: 'job-acme', label: 'Acme', tier: 'temporary', choices: { b_testing: 'v_base' } },
      rationale: [],
      diff: [],
      tailor: 'ai',
      aiUsed: true,
      rejected: ['choice b_ghost: no such bullet', 'choice b_pipeline: not a variant id'],
    });
    await new Promise((r) => setTimeout(r, 120));

    // Now open it, which is a switch between filed proposals and no server.
    [...root.querySelectorAll('button.mode')].find((b) => /AI/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 200));
    return [...root.querySelectorAll('.hint')].map((n) => n.textContent).join(' | ');
  });

  check(
    'a refusal count survives being filed and opened later',
    /2 things the AI asked for are not in your save/.test(refusedInTheBackground),
    refusedInTheBackground.slice(0, 200),
  );

  const failedToStart = await summaryFor({
    tailor: 'match',
    aiUsed: false,
    aiFailed: 'spawn /usr/local/bin/claude ENOENT',
    aiFailedKind: 'not-installed',
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

  /*
   * And a run that was stopped for taking too long is not one that could not
   * be started. The sentence used to be the same for both, so it read:
   *
   *   The AI could not be started, so nothing was tailored. It said: AI
   *   command "codex" ran for longer than 180s and was stopped.
   *
   * — which argues with its own quotation, and the two halves point at
   * opposite fixes.
   */
  const timedOut = await summaryFor({
    tailor: 'match',
    aiUsed: false,
    aiFailed: 'AI command "codex" ran for longer than 180s and was stopped.',
    aiFailedKind: 'timeout',
  });
  check(
    'a model that was stopped for taking too long is not called one that would not start',
    /taking too long/i.test(timedOut) && !/could not be started/i.test(timedOut),
    timedOut.slice(0, 140),
  );
  check(
    'and it still passes on what the machine said, which is where the fix is',
    /180s/.test(timedOut),
    timedOut.slice(0, 140),
  );

  /*
   * A server too old to say which way it failed still gets a sentence that is
   * true of all three.
   */
  const unlabelled = await summaryFor({ tailor: 'match', aiUsed: false, aiFailed: 'something went wrong' });
  check(
    'and a failure that does not say which way is not called either one',
    /did not finish/i.test(unlabelled) && !/could not be started|taking too long/i.test(unlabelled),
    unlabelled.slice(0, 140),
  );

  const unusable = await summaryFor({ tailor: 'match', aiUsed: false, aiRaw: 'Sure! Here are some ideas.' });
  check(
    'a model that answered with prose is told apart from one that would not start',
    /nothing usable/i.test(unusable) && !/could not be started/i.test(unusable),
    unusable.slice(0, 120),
  );

  /*
   * And a proposal nobody has tailored says so by counting, not by
   * describing.
   *
   * This used to claim "wordings swapped by keyword match" over every match,
   * which on most stores is false: narrowing a skills group needs nothing but
   * the group, while swapping a wording needs a line that has a second
   * phrasing and an alternate that clearly beats the current one. Now that
   * the match is a list of offers that arrive switched off, the only honest
   * sentence is how many of them are on — and on arrival that is none.
   */
  const arrived = await summaryFor({
    tailor: 'match',
    aiUsed: false,
    spec: { id: 'job-acme', label: 'Acme', choices: { b1: 'v_b' } },
    rationale: [{ key: 'b1', from: 'v_a', to: 'v_b', toText: 'Built a Kafka pipeline', because: ['kafka'] }],
  });
  check(
    'a proposal with every suggestion off says the resume is untouched',
    /exactly as you keep it/i.test(arrived) && !/switched on/i.test(arrived),
    arrived.slice(0, 140),
  );

  /*
   * And one with a suggestion accepted counts it. The fixture puts the
   * swapped wording in `choices` *and* leaves it out of the rationale, which
   * is the shape of a change already in the base rather than one this
   * proposal is offering — so the count comes from what is ticked, not from
   * what was offered.
   */
  const withOne = await summaryFor({
    tailor: 'ai',
    aiUsed: true,
    spec: { id: 'job-acme', label: 'Acme', choices: { b1: 'v_b' } },
    rationale: [{ key: 'b1', from: 'v_a', to: 'v_b', toText: 'Built a Kafka pipeline', because: ['kafka'] }],
  });
  /*
   * Read off the provenance line, which is where this is stated now.
   *
   * The summary used to say it too — "…, with the changes the AI chose
   * below" — alongside the base's name twice over. Both duplicates came out
   * of it; `.from-what` is the line whose whole job is saying where the
   * changes came from, and it is in the same capture.
   */
  check(
    'and one the AI decided says the AI decided it',
    /chosen by the AI/i.test(withOne),
    withOne.slice(0, 140),
  );

  /*
   * And it does not say the base's name at all, let alone twice.
   *
   * The name is the selected option of the "Start from" picker a few pixels
   * above this line, and the old sentence printed it once at the front and
   * once in the middle — "Software Engineer Intern — Summer 2027, with the
   * changes the AI chose below. Your Software Engineer Intern — Summer 2027
   * is untouched — …" — which is most of why it read as long as it did.
   *
   * Checked on both readings, because they were two different sentences and
   * both of them opened with it.
   */
  for (const [what, text] of [['the AI decided', withOne], ['the match offered', arrived]]) {
    check(
      `the summary for one ${what} does not repeat the base's name back`,
      !/New grad resume/.test(text),
      text.slice(0, 140),
    );
  }

  const plainMatch = await summaryFor({ tailor: 'match', aiUsed: false });
  check(
    'a posting with no suggestions at all says so, and reports no failure',
    /exactly as you keep it/i.test(plainMatch) && !/could not be started|nothing usable/i.test(plainMatch),
    plainMatch.slice(0, 140),
  );

  /*
   * And a failure is about the run that failed, not the one after it.
   *
   * The server leaves out what did not happen — `aiFailed` and `aiRaw` are
   * undefined on a run with nothing to report, and JSON drops them — and the
   * card merged each proposal over the last. So an AI run that could not
   * start, followed by the match worked out again from another base, kept
   * the failure: "The AI could not be started, so nothing was tailored" over
   * a keyword list no AI had been asked about.
   */
  const failureAfterwards = await inPage(async (createCard) => {
    const base = (more) => ({
      isJobPosting: true,
      job: { title: 'Platform Engineer', company: 'Acme' },
      spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
      baseLabel: 'New grad resume',
      rationale: [],
      diff: [],
      tailor: 'match',
      aiUsed: false,
      ...more,
    });
    const handle = createCard({
      analysis: base({}),
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => (action === 'aiStatus' ? { active: true, state: 'on' } : {}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const hints = () => [...root.querySelectorAll('.hint')].map((n) => n.textContent).join(' | ');
    await new Promise((r) => setTimeout(r, 50));
    const out = {};
    for (const [what, failed] of [
      ['started', { aiFailed: 'spawn /usr/local/bin/claude ENOENT', aiFailedKind: 'not-installed' }],
      ['usable', { aiRaw: 'Sure! Here are some ideas.' }],
    ]) {
      handle.update(base(failed), { show: true });
      const during = hints();
      handle.update(base({ spec: { id: 'job-acme', label: 'Acme', extends: 'other' }, baseLabel: 'Other resume' }), {
        show: true,
      });
      out[what] = { during, after: hints() };
    }
    return out;
  });
  check(
    'a model that would not start is said on the run that failed',
    /could not be started/i.test(failureAfterwards.started.during),
    failureAfterwards.started.during.slice(0, 140),
  );
  check(
    'and not on the keyword match worked out after it',
    /exactly as you keep it/i.test(failureAfterwards.started.after) &&
      !/could not be started/i.test(failureAfterwards.started.after),
    failureAfterwards.started.after.slice(0, 140),
  );
  check(
    'nor is a model that answered with prose',
    /nothing usable/i.test(failureAfterwards.usable.during) &&
      !/nothing usable/i.test(failureAfterwards.usable.after),
    JSON.stringify(failureAfterwards.usable).slice(0, 240),
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

  const whileTailoring = await inPage(async (createCard) => {
    let release;
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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
      /*
       * `rebuild` is the tailoring pass. Held open, so the card is caught
       * mid-run rather than after it. The status read has to answer as well,
       * because the AI button — which is now the only one that starts a pass
       * — stays disabled until it does.
       */
      onAction: (action) =>
        action === 'rebuild'
          ? new Promise((r) => { release = r; })
          : Promise.resolve(action === 'aiStatus' ? { active: true, state: 'on' } : {}),
    });
    handle.setLetter?.('Dear Acme, I am writing about the Platform Engineer role.');
    await new Promise((r) => setTimeout(r, 100));

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);

    /*
     * Start the pass the way the card does — with the AI, which is the only
     * button that goes to the server now. "Use Original" is a local revert
     * and a recompile, and would not put the card in the state this is about.
     */
    [...root.querySelectorAll('button.mode')].find((b) => /Have AI Tailor/.test(b.textContent))?.click();

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
        const b = root.querySelector('.pick input');
        return b ? b.disabled : null;
      })(),
      // Filing waits for the two things it files.
      filing: named('Mark as applied'),
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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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
   * Taking one change out, and putting it back.
   *
   * "Undo all" threw away every swap and sent the base resume untouched,
   * which is the wrong size of answer to "that one is wrong". The match is
   * usually right about most of them and occasionally wrong about one — a
   * degree line swapped for one naming a concentration, say — and the one it
   * is wrong about is the one you notice.
   *
   * The first answer to that was a "Keep the original" link that removed the
   * row it was on, which decided the question permanently in the other
   * direction: the evidence disappeared at the moment of the decision, so
   * there was no comparing the two readings and no way back from a misclick
   * short of rebuilding the whole proposal. A box goes both ways and leaves
   * the row where it is.
   */
  console.log('\nTaking one change out, and putting it back');

  const undoing = await inPage(async (createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        /*
         * Both swaps are in `choices`, which is what the server sends: it
         * derives the spec and the rationale from one match result, so every
         * key the rationale names is a key the spec chose. Which box is
         * ticked is read off exactly this.
         */
        spec: {
          id: 'job-acme',
          label: 'Acme',
          choices: { b_pipeline: 'v_kafka', 'edu_neu.subtitle': 'v_systems' },
        },
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
    const boxes = () => [...root.querySelectorAll('.pick input')];
    const ticks = () => boxes().map((b) => b.checked);
    const text = () => root.querySelector('.changes')?.textContent ?? '';
    // Undoing recompiles, and the boxes are held while it does; a second
    // click landing on a disabled one would do nothing and pass for the
    // wrong reason.
    const settle = () => new Promise((r) => setTimeout(r, 60));

    // Shut by default, so this is the click that reveals the rows at all.
    const shutAtFirst = Boolean(root.querySelector('.changes.shut'));
    const hiddenAtFirst = root.querySelector('.change')?.checkVisibility?.() === false;
    root.querySelector('.fold-changes')?.click();

    const before = {
      rows: rows(),
      count: count(),
      offered: boxes().length,
      ticks: ticks(),
      struck: Boolean(root.querySelectorAll('.change')[1]?.classList.contains('off')),
      shutAtFirst,
      hiddenAtFirst,
    };

    // Turn on the second one — the degree line.
    boxes()[1].click();
    await settle();
    const after = {
      rows: rows(),
      count: count(),
      ticks: ticks(),
      // The row stays, and it still says what it would have said.
      stillNames: /Systems concentration/.test(text()),
      struck: Boolean(root.querySelectorAll('.change')[1]?.classList.contains('off')),
      choices: sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec?.choices ?? null,
    };

    // And off again, which is the thing the one-way link could not do.
    boxes()[1].click();
    await settle();
    return {
      before,
      after,
      back: {
        rows: rows(),
        count: count(),
        ticks: ticks(),
        choices: sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec?.choices ?? null,
      },
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
  check('every suggestion gets a box', undoing.before.offered === 2, JSON.stringify(undoing.before));
  /*
   * Off, over the resume as it is kept. The match is a list of offers now,
   * not a mode: arriving used to alter the document and leave "send what I
   * have" as the thing you undid.
   */
  check(
    'and they start switched off',
    JSON.stringify(undoing.before.ticks) === '[false,false]',
    JSON.stringify(undoing.before.ticks),
  );
  check('with the rows marked as not in the document', undoing.before.struck === true, JSON.stringify(undoing.before));
  check('and a count that says none are in', undoing.before.count === '0 of 2 changes', String(undoing.before.count));
  check(
    'ticking one leaves the row where it is',
    undoing.after.rows === undoing.before.rows,
    `${undoing.before.rows} → ${undoing.after.rows}`,
  );
  check('still naming what it swaps', undoing.after.stillNames === true);
  check('and marked as in the document now', undoing.after.struck === false, JSON.stringify(undoing.after));
  check(
    'and only that one goes on',
    JSON.stringify(undoing.after.ticks) === '[false,true]',
    JSON.stringify(undoing.after.ticks),
  );
  check('the count says how many are in', undoing.after.count === '1 of 2 changes', String(undoing.after.count));
  /*
   * The half that matters. Ticking the box on screen and compiling the
   * original anyway would be worse than not offering the box.
   */
  check(
    'the resume is recompiled with the suggested wording in it',
    undoing.after.choices?.['edu_neu.subtitle'] === 'v_systems',
    JSON.stringify(undoing.after.choices),
  );
  check(
    'and the one left alone is left alone',
    undoing.after.choices?.b_pipeline === 'v_base',
    JSON.stringify(undoing.after.choices),
  );
  /*
   * And back off again — the direction the one-way "Keep the original" link
   * had no answer for at all.
   */
  check(
    'unticking it takes the change out again',
    JSON.stringify(undoing.back.ticks) === '[false,false]',
    JSON.stringify(undoing.back.ticks),
  );
  check('and the count with it', undoing.back.count === '0 of 2 changes', String(undoing.back.count));
  check(
    'in the resume that is compiled, not only on the screen',
    undoing.back.choices?.['edu_neu.subtitle'] === 'v_plain',
    JSON.stringify(undoing.back.choices),
  );

  /*
   * The picker that names which resume this starts from, with no list yet.
   *
   * The list arrives on its own, after the card is up: `listResumes` in
   * content.js, fired and forgotten with a `.catch(() => undefined)` and a
   * guard that drops the reply if the page has moved on while it was in
   * flight. Either of those leaves it empty for good, and an empty `<select>`
   * renders as a chevron with nothing beside it — reported from a real card
   * that had already compiled a resume and knew perfectly well which one it
   * had started from.
   */
  console.log('\nThe picker before the resume list has arrived');

  const basePicker = await inPage(async (createCard) => {
    const asked = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme' },
        baseResumeId: 'new-grad',
        baseLabel: 'New grad resume',
        rationale: [],
        diff: [],
      },
      // The case itself: nothing has arrived.
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => {
        asked.push(action);
        if (action === 'render') return { pages: 1, fits: true };
        // And still nothing when asked again, so the fallback has to hold.
        if (action === 'listResumes') return [];
        return {};
      },
    });
    void handle;
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 80));
    const select = root.querySelector('select');
    return {
      options: [...(select?.options ?? [])].map((o) => o.textContent),
      value: select?.value ?? null,
      askedAgain: asked.filter((a) => a === 'listResumes').length,
    };
  });

  check(
    'it names the resume this starts from rather than nothing',
    basePicker.options.length === 1 && basePicker.options[0] === 'New grad resume',
    JSON.stringify(basePicker.options),
  );
  // And carries its id, so the control is not only legible but answerable.
  check('and carries that resume’s id', basePicker.value === 'new-grad', String(basePicker.value));
  /*
   * Asked again, once. The fetch is cheap and this is the one moment its
   * absence is visible; asking on every draw would ask for ever.
   */
  check('and the list is asked for again', basePicker.askedAgain === 1, `asked ${basePicker.askedAgain} times`);

  /*
   * The graduation date, which is not a suggestion and must not arrive as one.
   *
   * Everything above is the keyword match: it read the posting's vocabulary
   * and inferred, and agreeing with a guess should be a decision, so those
   * rows arrive off. A level row is a different thing. It comes from a tag
   * the applicant wrote on their own variant — "this ending is the one for
   * internships" — which is an answer they already gave to this exact
   * question, and the server marks it `instruction: true` to say so.
   *
   * Reported: an internship posting produced a resume still carrying the new
   * grad date, with the intern-tagged alternate sitting right there in the
   * store. The matcher had it right — measured against the store's own
   * education entry with the title "Software Engineering Intern, Summer
   * 2026", it returns `{edu_neu.dates: v_dec2026}` — and `withAllOff` wrote
   * `v_may2026` straight back over it one line later, because it could not
   * tell the two kinds of row apart. The whole point of reading the level is
   * that nobody remembers to switch the ending before hitting submit; a row
   * you have to notice and tick is the same thing as not remembering.
   */
  console.log('\nThe graduation date on an internship posting');

  const grad = await inPage(async (createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Software Engineering Intern, Summer 2026', company: 'Acme' },
        spec: {
          id: 'job-acme',
          label: 'Acme',
          choices: { b_pipeline: 'v_kafka', 'edu_neu.dates': 'v_dec2026' },
        },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [],
        rationale: [
          // A guess about words. Arrives off, as every one of them does.
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
          // An instruction the applicant left. Arrives on.
          {
            key: 'edu_neu.dates',
            from: 'v_may2026',
            to: 'v_dec2026',
            toText: 'Sep. 2022 -- Dec. 2026',
            because: ['intern'],
            instruction: true,
          },
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
    const settle = () => new Promise((r) => setTimeout(r, 60));
    root.querySelector('.fold-changes')?.click();
    const boxes = () => [...root.querySelectorAll('.pick input')];
    const lastSpec = () => sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec?.choices ?? null;

    /*
     * Nothing has been compiled yet on arrival, so the spec has to be read
     * through a recompile — and the one that provokes it is the *other* row,
     * the keyword guess. Turning that on and off again leaves it exactly as
     * it arrived, and every spec sent along the way has to still carry the
     * date.
     */
    const arrivedTicks = boxes().map((b) => b.checked);
    boxes()[0].click();
    await settle();
    const withKeywordOn = lastSpec();
    boxes()[0].click();
    await settle();
    const arrived = { ticks: arrivedTicks, choices: lastSpec(), withKeywordOn };

    // Off by hand, because it still has to be refusable.
    boxes()[1].click();
    await settle();
    const untickedByHand = { ticks: boxes().map((b) => b.checked), choices: lastSpec() };

    // And "Use Original" means the resume exactly as it is kept, this
    // included — the one control that promises nothing changed.
    boxes()[1].click();
    await settle();
    [...root.querySelectorAll('button')].find((b) => /Use Original/.test(b.textContent))?.click();
    await settle();
    await settle();
    return { arrived, untickedByHand, original: { choices: lastSpec() } };
  });

  check(
    'the date arrives already switched on',
    JSON.stringify(grad.arrived.ticks) === '[false,true]',
    JSON.stringify(grad.arrived.ticks),
  );
  /*
   * And in the resume that compiles, which is the half the person actually
   * sends. A ticked box over a spec still naming the old date would be worse
   * than no box at all.
   */
  check(
    'and is in the resume that is built, not only on the screen',
    grad.arrived.choices?.['edu_neu.dates'] === 'v_dec2026',
    JSON.stringify(grad.arrived.choices),
  );
  // The keyword row beside it is untouched: this is not "apply everything".
  // The keyword row beside it is untouched: this is not "apply everything".
  check(
    'while the keyword guess beside it is still off',
    grad.arrived.choices?.b_pipeline === 'v_base',
    JSON.stringify(grad.arrived.choices),
  );
  /*
   * And the date survives the keyword row being ticked. The two live in one
   * `choices` map, so a rebuild for one that dropped the other is the way
   * this comes back without anybody touching the date at all.
   */
  check(
    'and it survives the other row being ticked',
    grad.arrived.withKeywordOn?.['edu_neu.dates'] === 'v_dec2026'
      && grad.arrived.withKeywordOn?.b_pipeline === 'v_kafka',
    JSON.stringify(grad.arrived.withKeywordOn),
  );
  check(
    'it can still be refused',
    grad.untickedByHand.choices?.['edu_neu.dates'] === 'v_may2026',
    JSON.stringify(grad.untickedByHand.choices),
  );
  check(
    'and "Use Original" really does mean the resume as you keep it',
    grad.original.choices?.['edu_neu.dates'] === 'v_may2026',
    JSON.stringify(grad.original.choices),
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
  console.log('\nTaking a skills group out, and putting it back');

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
    const boxes = () => [...root.querySelectorAll('.pick input')];
    const ticks = () => boxes().map((b) => b.checked);
    const text = () => root.querySelector('.changes')?.textContent ?? '';

    root.querySelector('.fold-changes')?.click();
    const offered = boxes().length;
    const before = rows();

    // Between clicks, because a flip recompiles and the rest of the boxes
    // are held while it does — a second click landing on a disabled one
    // would do nothing and this would pass for the wrong reason.
    const settle = () => new Promise((r) => setTimeout(r, 60));

    // Guarded rather than assumed: without the fix there are no boxes on the
    // skills rows at all, and this has to report that rather than throw.
    const flip = async (at) => {
      const box = boxes()[at < 0 ? boxes().length + at : at];
      if (!box) return false;
      box.click();
      await settle();
      return true;
    };

    const startTicks = ticks();
    const specAt = (n) => sent.filter((c) => c.action === 'render').at(n)?.payload?.spec;
    const itemsOf = (spec) => (spec?.sections ?? []).find((x) => x.kind === 'skills')?.items;

    // The opening state, before any skills box is touched: the wording box
    // on and off again, so there is a compiled spec to read.
    await flip(0);
    const opening = itemsOf(specAt(-1)) ?? null;
    await flip(0);

    // On: the group whose base list was explicit.
    const clicked = await flip(1);
    const afterFirst = { rows: rows(), stillNames: /dropped Ruby/.test(text()), ticks: ticks(), clicked };
    // And the one where the base said nothing, which is the awkward case.
    await flip(-1);
    const on = specAt(-1);

    // Both off again — the direction the one-way link never had.
    await flip(1);
    await flip(-1);
    const off = specAt(-1);

    return {
      offered,
      before,
      startTicks,
      opening,
      afterFirst,
      after: rows(),
      // Narrowed, with both suggestions switched on.
      onLang: itemsOf(on)?.sk_lang ?? null,
      onTools: itemsOf(on)?.sk_tools ?? null,
      // And back to what the base asked for, with both switched off.
      items: itemsOf(off) ?? null,
      hasTools: itemsOf(off) ? Object.prototype.hasOwnProperty.call(itemsOf(off), 'sk_tools') : null,
      choices: off?.choices ?? null,
      backTicks: ticks(),
    };
  });

  check('a skills row gets a box, like every other row', skillUndo.offered === 3, JSON.stringify(skillUndo));
  check(
    'and starts off, like every other row',
    JSON.stringify(skillUndo.startTicks) === '[false,false,false]',
    JSON.stringify(skillUndo.startTicks),
  );
  check(
    'ticking one leaves the row, and the reasoning on it, in place',
    skillUndo.afterFirst.rows === skillUndo.before && skillUndo.afterFirst.stillNames === true,
    JSON.stringify(skillUndo.afterFirst),
  );
  check(
    'and puts only that one on',
    JSON.stringify(skillUndo.afterFirst.ticks) === '[false,true,false]',
    JSON.stringify(skillUndo.afterFirst.ticks),
  );
  /*
   * Switched on, the narrowing reaches the resume that is compiled — the
   * whole point of the box, and the half a screen reading cannot establish.
   */
  check(
    'switching them on narrows both groups in the compiled resume',
    JSON.stringify(skillUndo.onLang) === JSON.stringify(['s_py', 's_go'])
      && JSON.stringify(skillUndo.onTools) === JSON.stringify(['t_k8s']),
    JSON.stringify([skillUndo.onLang, skillUndo.onTools]),
  );
  /*
   * The half that matters, as with the wordings: taking the row off the screen
   * and compiling the narrowed group anyway would be worse than no button.
   */
  /*
   * Off, each group goes back to exactly what the base holds.
   *
   * Resumes no longer inherit: a group with no list prints every skill in it.
   * The card used to take the key out for a group the base had trimmed, on
   * the reading that "absent means inherited" — which put every skill the
   * base had turned off back on the page, starting with the opening state
   * where every suggestion is off. Only a group the base named nothing for
   * goes back to having no entry, because that is what the base holds.
   */
  check(
    'with nothing ticked, a trimmed group prints the base\'s list, not the whole group',
    JSON.stringify(skillUndo.opening?.sk_lang) === JSON.stringify(['s_py', 's_go', 's_rb', 's_php'])
      && !Object.prototype.hasOwnProperty.call(skillUndo.opening ?? {}, 'sk_tools'),
    JSON.stringify(skillUndo.opening),
  );
  check(
    'unticked again, the group the base named gets that list back',
    JSON.stringify(skillUndo.items?.sk_lang) === JSON.stringify(['s_py', 's_go', 's_rb', 's_php']),
    JSON.stringify(skillUndo.items),
  );
  check(
    'and the group it named nothing for has no entry of its own',
    skillUndo.hasTools === false,
    JSON.stringify(skillUndo.items),
  );
  check(
    'all three rows are still there and the wording suggestion is untouched',
    skillUndo.after === 3 && skillUndo.choices?.b_pipeline === 'v_base',
    JSON.stringify(skillUndo),
  );
  /*
   * And back. This is the whole reason for the box: a narrowed skills group
   * is the part of a match most likely to be wrong and the part you most want
   * to see both ways before deciding, and the link it replaces could only
   * ever be pressed once.
   */
  check(
    'and unticking them puts both groups back',
    JSON.stringify(skillUndo.backTicks) === '[false,false,false]',
    JSON.stringify(skillUndo.backTicks),
  );

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
   * And an answer the bank put in the box is not somebody writing.
   *
   * The box shows the stored answer until somebody types, and that stored
   * answer is what the run is handed as "before". The check compared it
   * against `state.answers[question] ?? ''` — empty until a key is pressed —
   * so every question the bank knew looked written-over. "Rewrite for this
   * role" on a stored answer changed nothing and said "You were writing while
   * that ran", and "Write all" threw away every draft for such questions.
   *
   * Two questions the bank knows, one run: the one nobody touches takes the
   * draft, and the one typed into while it ran keeps what was typed.
   */
  const bankRewrite = await inPage(async (createCard) => {
    let release;
    const held = new Promise((r) => (release = r));
    let ids = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [
        { question: 'Why us?', answer: 'Because of the mission.', confident: true },
        { question: 'Tell us about a project.', answer: 'I built a scheduler.', confident: false },
      ],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'answer:Why us?') return { executed: true, output: 'Rewritten for Acme.' };
        if (action === 'writeApplication') {
          ids = payload.questions.map((q) => q.id);
          return held;
        }
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const box = (q) => root.querySelector(`textarea[data-field="answer:${q}"]`);
    const said = () => root.textContent.match(/You were writing while that ran[^.]*\./)?.[0] ?? null;
    await new Promise((r) => setTimeout(r, 120));

    [...root.querySelectorAll('button')].find((b) => /Rewrite for this role/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 120));
    const one = { box: box('Why us?')?.value ?? null, said: said() };

    // The next run over both, with the second typed into while it is out.
    [...root.querySelectorAll('button')].find((b) => /Write all 2 answers/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 120));
    const typed = box('Tell us about a project.');
    typed.value = 'Mine, typed while it ran.';
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    release({ oneRun: true, answers: { [ids[0]]: 'All at once for Acme.', [ids[1]]: 'The run wrote this.' } });
    await new Promise((r) => setTimeout(r, 200));
    return {
      one,
      all: { why: box('Why us?')?.value ?? null, project: box('Tell us about a project.')?.value ?? null, said: said() },
    };
  });
  check(
    'rewriting a stored answer puts the rewrite in its box',
    bankRewrite.one.box === 'Rewritten for Acme.' && bankRewrite.one.said === null,
    JSON.stringify(bankRewrite.one),
  );
  check(
    'and one run over stored answers fills the ones nobody touched',
    bankRewrite.all.why === 'All at once for Acme.',
    JSON.stringify(bankRewrite.all),
  );
  check(
    'while one typed into as it ran still keeps what was typed, and says so',
    bankRewrite.all.project === 'Mine, typed while it ran.' && /kept\.$/.test(bankRewrite.all.said ?? ''),
    JSON.stringify(bankRewrite.all),
  );

  /*
   * An answer that names another employer is offered, not filled in — and
   * what is not in the box is not sent.
   *
   * The box worked that out; everything that sends an answer read the bank's
   * text directly. So on a Globex form the box stood empty behind "Start from
   * what you told Acme" while "Acme is why I applied" went into the folder
   * and the filed record of what was sent, and was carried to the next page
   * as an answer written for this application, where it was filled in.
   */
  const borrowedAnswer = await inPage(async (createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Globex' },
        spec: { id: 'job-globex', label: 'Globex' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [
        { question: 'Why do you want to work here?', answer: 'Acme is why I applied.', confident: true, namesAnother: 'Acme' },
      ],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'render' ? { pages: 1, fits: true } : action === 'stage' ? { currentDir: '/tmp/x' } : {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));
    await new Promise((r) => setTimeout(r, 50));
    const box = root.querySelector('textarea[data-field^="answer:"]')?.value ?? null;
    byText('Build resume')?.click();
    await new Promise((r) => setTimeout(r, 100));
    const before = {
      box,
      staged: sent.find((c) => c.action === 'stage')?.payload?.answers ?? null,
      carried: handle.takeWork().answersByQuestion,
    };
    // Taken, on purpose: now it is in the box, and it goes.
    byText('Start from what you told Acme')?.click();
    await new Promise((r) => setTimeout(r, 50));
    byText('Mark as applied')?.click();
    await new Promise((r) => setTimeout(r, 100));
    return { before, taken: sent.find((c) => c.action === 'bundle')?.payload?.answers ?? null };
  });
  check(
    'an answer offered from another employer is not in its box',
    borrowedAnswer.before.box === '',
    JSON.stringify(borrowedAnswer.before),
  );
  check(
    'nor in the folder',
    JSON.stringify(borrowedAnswer.before.staged) === '[]',
    JSON.stringify(borrowedAnswer.before),
  );
  check(
    'nor carried to the next page as though it were written for this one',
    JSON.stringify(borrowedAnswer.before.carried) === '{}',
    JSON.stringify(borrowedAnswer.before),
  );
  check(
    'and once taken, it is sent',
    borrowedAnswer.taken?.[0]?.answer === 'Acme is why I applied.',
    JSON.stringify(borrowedAnswer.taken),
  );

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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [{ id: 'base', label: 'New grad', base: true }],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        // The AI is slow; going back to the original is not — it is a local
        // revert and a recompile, and the compile answers at once.
        if (action === 'rebuild') {
          seen += 1;
          return payload.tailor === 'ai' ? slowAi : {};
        }
        if (action === 'render') {
          seen += 1;
          return { pages: 1, fits: true };
        }
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));
    const named = (re) => [...root.querySelectorAll('button.mode')].find((b) => re.test(b.textContent));

    named(/Have AI Tailor/).click();
    await new Promise((r) => setTimeout(r, 150));
    named(/Use Original/).click();
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
   * The AI asked for again on the next page is a rebuild like any other.
   *
   * `retailor` is what the content script calls when an application whose
   * resume the AI tailored arrives at its next page, and it is minutes long.
   * The build buttons stay live meanwhile, and each of them takes a number so
   * the newest press wins — but `retailor` took none. So pressing Keyword
   * match while it read, and getting the match back first, was undone when
   * the older AI reply arrived: it put the AI's proposal back on screen over
   * the one just asked for. And arriving first, it cleared the label of the
   * match still running.
   *
   * The content script hands the newest reply to `update` and returns the
   * superseded one without it; this harness does the same.
   */
  console.log('\nThe AI asked for again does not land on top of a newer press');

  const reRace = async (order) =>
    inPage(async (createCard, staleFirst) => {
      const job = { title: 'Platform Engineer', company: 'Acme' };
      const reading = (choice, more) => ({
        isJobPosting: true,
        job,
        spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: choice } },
        diff: [],
        rationale: [],
        ...more,
      });
      let releaseAi;
      let releaseMatch;
      let handle;
      handle = createCard({
        analysis: reading('v_base', { tailor: 'match', aiUsed: false }),
        resumes: [{ id: 'base', label: 'New grad', base: true }],
        settings: {},
        questions: [],
        needsCoverLetter: false,
        onAction: async (action, payload) => {
          if (action === 'aiStatus') return { active: true, state: 'on' };
          if (action === 'render') return { pages: 1, fits: true };
          if (action !== 'rebuild') return {};
          if (payload.tailor === 'ai') {
            return new Promise((r) => (releaseAi = () => r(reading('v_ai_again', { tailor: 'ai', aiUsed: true }))));
          }
          return new Promise((r) => {
            releaseMatch = () => {
              const next = reading('v_kafka', { tailor: 'match', aiUsed: false });
              handle.update(next);
              r(next);
            };
          });
        },
      });
      // What the page before handed over: the AI's proposal, on screen.
      handle.update(reading('v_ai', { tailor: 'ai', aiUsed: true }), { show: true });
      await new Promise((r) => setTimeout(r, 120));
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      const named = (re) => [...root.querySelectorAll('button.mode')].find((b) => re.test(b.textContent));

      handle.retailor('ai');
      await new Promise((r) => setTimeout(r, 50));
      named(/Keyword match/)?.click();
      await new Promise((r) => setTimeout(r, 50));
      const both = Boolean(releaseAi && releaseMatch);

      let labelWhileMatching = null;
      if (staleFirst) {
        releaseAi();
        await new Promise((r) => setTimeout(r, 80));
        // Any repaint: the list arriving is one that happens on its own.
        handle.setResumes([{ id: 'base', label: 'New grad', base: true }]);
        labelWhileMatching = named(/Keyword match|Matching on keywords/)?.textContent?.trim() ?? null;
        releaseMatch();
      } else {
        releaseMatch();
        await new Promise((r) => setTimeout(r, 80));
        releaseAi();
      }
      await new Promise((r) => setTimeout(r, 150));
      return {
        both,
        labelWhileMatching,
        lit: root.querySelector('.mode.on')?.textContent?.trim() ?? null,
      };
    }, order === 'stale-first');

  const staleLast = await reRace('stale-last');
  check('both really were in flight', staleLast.both === true, JSON.stringify(staleLast));
  check(
    'the match pressed while the AI read stays on screen when the AI answers after it',
    // The match arrives with every box off, so it is "Use Original" that is lit.
    typeof staleLast.lit === 'string' && !/AI/.test(staleLast.lit),
    JSON.stringify(staleLast),
  );
  const staleFirst = await reRace('stale-first');
  check(
    'and the AI answering first does not say the match has finished',
    staleFirst.labelWhileMatching === 'Matching on keywords…',
    JSON.stringify(staleFirst),
  );

  /*
   * Feedback answered about a resume that is no longer the one on screen.
   *
   * "Apply feedback" sends the spec that is up when it is pressed, and a model
   * reading it takes a while. "Use Original" is live for the whole of that —
   * it is a local revert in a different lane, deliberately — so the two
   * overlap, and what came back was merged into whatever `state.spec` had
   * become by then. Press both and the boxes just taken off come back on,
   * ticked by a model that was looking at the other document.
   */
  console.log('\nFeedback landing on a resume it was not about');

  const lateFeedback = await inPage(async (createCard) => {
    let release;
    const renders = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: {
          id: 'job-acme',
          label: 'Acme',
          tier: 'temporary',
          choices: { b_pipeline: 'v_kafka' },
        },
        // One taken suggestion, so "Use Original" has something to put back.
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
        ],
        diff: [{ kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' }],
        /*
         * A decision, not a list of offers — a model read the posting and
         * chose. That is the only arrival whose spec comes up with anything
         * taken (see `isDecision`), so it is the only one where "Use Original"
         * has work to do and the race is reachable at all.
         */
        tailor: 'ai',
        aiUsed: true,
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'render') {
          renders.push(payload?.spec?.choices?.b_pipeline ?? null);
          return { pages: 1, fits: true };
        }
        // Held open, so the revert lands while the model is still reading.
        if (action === 'refine') {
          return new Promise((r) => {
            release = () => r({ parsed: { choices: { b_pipeline: 'v_model' } } });
          });
        }
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 150));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    const mode = (re) => [...root.querySelectorAll('button.mode')].find((b) => re.test(b.textContent));

    const box = root.querySelector('textarea');
    box.value = 'lead with the distributed systems work';
    box.dispatchEvent(new Event('input', { bubbles: true }));

    byText('Apply feedback').click();
    await new Promise((r) => setTimeout(r, 100));
    const started = Boolean(release);
    mode(/Use Original/).click();
    await new Promise((r) => setTimeout(r, 250));

    // What the revert compiled, and everything the late reply compiles after it.
    const reverted = renders.slice();
    release();
    await new Promise((r) => setTimeout(r, 300));
    return {
      started,
      reverted,
      after: renders.slice(reverted.length),
      said: root.querySelector('.err')?.textContent ?? '',
    };
  });

  check('the feedback really was in flight', lateFeedback.started === true, JSON.stringify(lateFeedback));
  check(
    'the revert put the original wording back',
    lateFeedback.reverted.at(-1) === 'v_base',
    JSON.stringify(lateFeedback),
  );
  check(
    'and the late reply does not tick its choice onto the resume that replaced it',
    !lateFeedback.after.includes('v_model'),
    JSON.stringify(lateFeedback),
  );
  check(
    'it says so, rather than dropping the feedback silently',
    /different one now/.test(lateFeedback.said),
    JSON.stringify(lateFeedback),
  );

  console.log('\nApply feedback with nothing written in the box');

  /*
   * Every other box that only does something with text in it — Save to
   * store, Copy, See it typeset — disables while it is empty as well as
   * while busy. This one used to disable on busy alone, so an empty box left
   * the button live: pressing it ran the early-return branch and nothing on
   * screen said why nothing had happened.
   */
  const emptyFeedback = await inPage((createCard) => {
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    // Falls back to the first textarea so a version without the field name
    // still reports a clean failure below rather than throwing here.
    const box = root.querySelector('textarea[data-field="feedback"]') ?? root.querySelector('textarea');
    const button = byText('Apply feedback');
    const empty = button?.disabled;

    box.value = '  ';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const whitespaceOnly = button?.disabled;

    box.value = 'lead with the distributed systems work';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const withText = button?.disabled;

    return {
      found: root.querySelector('textarea[data-field="feedback"]') != null && Boolean(button),
      empty,
      whitespaceOnly,
      withText,
    };
  });

  check('the feedback box and its button are both there', emptyFeedback.found === true, JSON.stringify(emptyFeedback));
  check('empty, the button cannot be pressed', emptyFeedback.empty === true, JSON.stringify(emptyFeedback));
  check(
    'nor can it with only whitespace typed in',
    emptyFeedback.whitespaceOnly === true,
    JSON.stringify(emptyFeedback),
  );
  check('with real text, it is live again', emptyFeedback.withText === false, JSON.stringify(emptyFeedback));

  console.log('\nWriting feedback while the card repaints');

  /*
   * The letter box and the answer boxes are named so `draw` can find them
   * again after rebuilding the subtree — this is the one text box on the
   * card that was not, so an AI status arriving mid-sentence here threw
   * focus away for good instead of putting it back.
   */
  const feedbackTyping = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;

    // Falls back to the first textarea so a version without the field name
    // still reports a clean failure below rather than throwing here.
    const box = root.querySelector('textarea[data-field="feedback"]') ?? root.querySelector('textarea');
    box.focus();
    box.value = 'lead with the platform work';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.setSelectionRange(4, 4);

    // A real repaint, touching nothing about the feedback box itself.
    handle.setResumes([{ id: 'base', label: 'New grad', base: true }]);

    const active = root.activeElement;
    return {
      replaced: !box.isConnected,
      tag: active?.tagName ?? null,
      field: active?.dataset?.field ?? null,
      value: active?.value ?? null,
      caret: active?.selectionStart ?? null,
    };
  });

  check('the box really is rebuilt, so this is the case that mattered', feedbackTyping.replaced === true);
  check('the caret is still in a text box', feedbackTyping.tag === 'TEXTAREA', JSON.stringify(feedbackTyping));
  check('and in the feedback box specifically', feedbackTyping.field === 'feedback', String(feedbackTyping.field));
  check(
    'with what was typed still in it',
    feedbackTyping.value === 'lead with the platform work',
    String(feedbackTyping.value),
  );
  check('and the caret where it was, not at the end', feedbackTyping.caret === 4, String(feedbackTyping.caret));

  /*
   * Coming back from the builder having written something new.
   *
   * A wording added there is an *alternate*, and an alternate is only reached
   * by something choosing it. On an untailored proposal — which is now where
   * every application starts — rebuilding in the same mode can never use what
   * was just written: it rebuilds the resume exactly as it is kept, which is
   * what was already on screen. The sentence said "to use anything you added".
   */
  console.log('\nComing back from the builder');

  const cameBack = await inPage(
    new Function('createCard', `return (${(async (createCard, builtWith) => {
      const sent = [];
      const handle = createCard({
        analysis: {
          isJobPosting: true,
          job: { title: 'Platform Engineer', company: 'Acme' },
          spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
          rationale: [],
          diff: [],
          tailor: builtWith,
        },
        resumes: [],
        settings: {},
        questions: [],
        needsCoverLetter: false,
        onAction: async (action, payload) => {
          sent.push({ action, tailor: payload?.tailor });
          return action === 'aiStatus' ? { active: true, state: 'on' } : {};
        },
      });
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      await new Promise((r) => setTimeout(r, 80));
      handle.cameBack?.();
      // `cameBack` only fires where the card sent you to the builder.
      if (!root.querySelector('.hint.warn')) {
        root.querySelector('.to-builder')?.click();
        handle.cameBack?.();
      }
      await new Promise((r) => setTimeout(r, 80));
      const offer = [...root.querySelectorAll('.hint.warn button')][0];
      const label = offer?.textContent ?? null;
      offer?.click();
      await new Promise((r) => setTimeout(r, 200));
      return { label, asked: sent.filter((c) => c.action === 'rebuild').map((c) => c.tailor) };
    }).toString()})(createCard, ${JSON.stringify('none')})`),
  );

  check(
    'on an untailored proposal the offer names the thing that would pick it up',
    cameBack.label === 'Work out the suggestions again',
    JSON.stringify(cameBack),
  );
  check(
    'and asks for that, not for another copy of what was already shown',
    cameBack.asked.at(-1) === 'match',
    JSON.stringify(cameBack.asked),
  );

  const cameBackMatched = await inPage(
    new Function('createCard', `return (${(async (createCard, builtWith) => {
      const sent = [];
      const handle = createCard({
        analysis: {
          isJobPosting: true,
          job: { title: 'Platform Engineer', company: 'Acme' },
          spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
          rationale: [],
          diff: [],
          tailor: builtWith,
          // A run the model actually answered. `tailor: 'ai'` on its own is
          // what a *failed* one reports, and that is not a decision — it
          // falls through to the suggestions like anything else.
          aiUsed: builtWith === 'ai',
        },
        resumes: [],
        settings: {},
        questions: [],
        needsCoverLetter: false,
        onAction: async (action, payload) => {
          sent.push({ action, tailor: payload?.tailor });
          return action === 'aiStatus' ? { active: true, state: 'on' } : {};
        },
      });
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      await new Promise((r) => setTimeout(r, 80));
      handle.cameBack?.();
      if (!root.querySelector('.hint.warn')) {
        root.querySelector('.to-builder')?.click();
        handle.cameBack?.();
      }
      await new Promise((r) => setTimeout(r, 80));
      const offer = [...root.querySelectorAll('.hint.warn button')][0];
      const label = offer?.textContent ?? null;
      offer?.click();
      await new Promise((r) => setTimeout(r, 200));
      return { label, asked: sent.filter((c) => c.action === 'rebuild').map((c) => c.tailor) };
    }).toString()})(createCard, ${JSON.stringify('ai')})`),
  );

  /*
   * And on one that was already tailored it repeats what was asked for, rather
   * than quietly dropping you into a different mode.
   */
  check(
    'a tailored proposal is offered the same thing again',
    cameBackMatched.label === 'Build it again' && cameBackMatched.asked.at(-1) === 'ai',
    JSON.stringify(cameBackMatched),
  );

  /*
   * Questions a model must not answer for you.
   *
   * A salary expectation it invents is a number the applicant did not choose
   * and may be held to. The self-identification questions are voluntary by law
   * and about the person, so an answer written on their behalf is a lie told
   * in their name about something they were entitled to decline.
   *
   * Still shown, still typeable — hiding a question the form requires is the
   * worse failure. What goes is the offer to write it.
   */
  console.log('\nQuestions that are yours alone');

  const yours = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme', description: 'Kafka.' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [
        { question: 'Why us?', answer: '', confident: false },
        {
          question: 'What are your salary expectations for this role?',
          answer: '',
          confident: false,
          yours: 'A figure here is yours to choose.',
        },
      ],
      needsCoverLetter: true,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'aiStatus' ? { active: true, state: 'on' } : {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));

    const boxes = [...root.querySelectorAll('textarea[data-field^="answer:"]')].map((t) => t.dataset.field);
    const drafts = [...root.querySelectorAll('button')].filter((b) => /Draft an answer/.test(b.textContent)).length;
    const writeAll = [...root.querySelectorAll('button')].find((b) => /Write the letter and/.test(b.textContent));
    const label = writeAll?.textContent ?? null;
    writeAll?.click();
    await new Promise((r) => setTimeout(r, 250));

    return {
      boxes,
      drafts,
      label,
      said: /yours to choose/.test(root.textContent),
      handed: (sent.find((c) => c.action === 'writeApplication')?.payload?.questions ?? []).map((q) => q.question),
    };
  });

  check('the question is still shown, not hidden', yours.boxes.length === 2, JSON.stringify(yours.boxes));
  check('and says why it is yours', yours.said === true, JSON.stringify(yours));
  check(
    'but nothing offers to write it',
    yours.drafts === 1,
    `${yours.drafts} draft buttons for 2 questions`,
  );
  check(
    'the run is not handed it either',
    yours.handed.length === 1 && /Why us/.test(yours.handed[0] ?? ''),
    JSON.stringify(yours.handed),
  );
  check(
    'and the button does not promise to write it',
    /and 1 answer\b/.test(yours.label ?? ''),
    String(yours.label),
  );

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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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
      submitLabel: Boolean(byText('Mark as applied')),
      oldLabel: Boolean(byText('Prepare to submit')),
    }), 60));
  });

  /*
   * And a stage that was refused is tried again.
   *
   * `lastPrepared` is written before the call, so a second change arriving
   * while one is in flight does not start a second compile of the same
   * thing. It was not given back when the call failed — so a refusal counted
   * as done, and nothing re-staged until something else about the
   * application changed. The folder is what the upload dialog opens on; it is
   * worth nothing if it is a build behind and believes it is not.
   *
   * Reachable now that a stage can be refused on purpose: a name typed into
   * the rename menu that another document in this application already has.
   */
  const afterRefusal = await inPage((createCard) => {
    const sent = [];
    let refuse = true;
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        if (action === 'render') return { pages: 1, fits: true };
        if (action === 'stage') {
          // Refused only while there is a letter to refuse, the way a
          // clashing name is refused — the build's own stage goes through.
          if (refuse && payload?.coverLetter) {
            refuse = false;
            throw new Error('"Cover Letter" is already called Jianwen-Ding-Resume.pdf.');
          }
          return { currentDir: '/tmp/x', application: { id: 'app-1' } };
        }
        return {};
      },
    });

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);

    byText('Build resume').click();
    const letter = 'Three paragraphs in and the tab goes.';
    return new Promise((resolve) =>
      setTimeout(() => {
        // A letter arrives and its stage is refused.
        handle.restoreWork({ letter }, false);
        setTimeout(() => {
          const afterRefused = sent.filter((c) => c.action === 'stage').length;
          /*
           * And the same letter again — the same application, the same files,
           * nothing new to prepare. `prepareSoon` skips a state it has
           * already prepared, so the only thing that can start another stage
           * here is the refused one having been given back.
           */
          handle.restoreWork({ letter }, false);
          setTimeout(
            () =>
              resolve({
                stages: sent.filter((c) => c.action === 'stage').length,
                afterRefused,
              }),
            2600,
          );
        }, 2600);
      }, 2600),
    );
  });

  check(
    'a stage that was refused is tried again, not counted as done',
    afterRefusal.stages > afterRefusal.afterRefused,
    `${afterRefusal.afterRefused} by the refusal, ${afterRefusal.stages} in the end`,
  );

  /*
   * "Saved" has to be about the text that was saved.
   *
   * The request carries a snapshot of the box, which is right. The callback
   * that runs when it comes back read `state.letter` *again* — so a letter
   * typed on while the save was in flight was recorded as the saved one.
   * The button then says "Saved", disabled, under "Future drafts will start
   * from this one", about a paragraph the store has never seen; and the
   * mismatch check that would normally catch it compares against the wrong
   * baseline, so it never fires.
   */
  const savedLie = await inPage((createCard) => {
    let release;
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: true,
      onAction: async (action, payload) =>
        action === 'saveLetter'
          ? new Promise((r) => { release = () => r({ ok: true, sent: payload.body }); })
          : action === 'aiStatus'
            ? { active: true, state: 'on' }
            : {},
    });
    void handle;
    return (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));
      const box = root.querySelector('textarea[data-field="letter"]');
      if (!box) return { error: 'no letter box' };

      box.value = 'A';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));

      const save = byText('Save to store');
      if (!save) return { error: 'no save button' };
      save.click();
      await new Promise((r) => setTimeout(r, 40));

      // Still typing while the save is out.
      box.value = 'A and then some more.';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 40));

      release?.();
      await new Promise((r) => setTimeout(r, 120));

      const now = byText('Save to store') ?? byText('Saved');
      return {
        inTheBox: root.querySelector('textarea[data-field="letter"]')?.value ?? '',
        label: now?.textContent?.trim() ?? '(gone)',
        disabled: now?.disabled ?? null,
      };
    })();
  });

  check(
    'a letter typed on while the save was out is not called saved',
    savedLie.label === 'Save to store' && savedLie.disabled === false,
    `${savedLie.error ?? ''} button says "${savedLie.label}", disabled ${savedLie.disabled}, box holds "${savedLie.inTheBox}"`,
  );

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
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
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

  /*
   * And a box ticked after building reaches the folder, not only the preview.
   *
   * Only "Build resume" staged. Ticking a suggestion afterwards recompiled the
   * preview and left the folder with the build from before — which is the
   * file "Attach files" and the drag chips hand the form. The skills half had
   * a second way to miss: the check for "anything to prepare" read `choices`
   * and never `sections`, so a skills box ticked after a wording one looked
   * like no change at all.
   */
  const tickedAfterBuilding = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: {
          id: 'job-acme',
          label: 'Acme',
          choices: { b_pipeline: 'v_kafka' },
          sections: [{ kind: 'skills', groups: ['sk_lang'], items: { sk_lang: ['s_py', 's_go'] } }],
        },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [
          { kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' },
          { kind: 'removed', where: 'Languages', text: 'Languages: dropped Ruby, PHP — keeping Python, Go' },
        ],
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
        ],
        skillChanges: [
          { groupId: 'sk_lang', groupName: 'Languages', from: ['s_py', 's_go', 's_rb', 's_php'], to: ['s_py', 's_go'] },
        ],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload: JSON.parse(JSON.stringify(payload ?? {})) });
        if (action === 'render') return { pages: 1, fits: true };
        if (action === 'stage') return { currentDir: '/tmp/x', application: { id: 'app-1' } };
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const last = (action) => sent.filter((c) => c.action === action).at(-1)?.payload?.spec ?? null;
    const shape = (spec) => JSON.stringify([spec?.choices ?? null, spec?.sections ?? null]);

    byText('Build resume').click();
    await wait(100);
    root.querySelector('.fold-changes')?.click();
    // Past `prepareSoon`'s debounce each time.
    [...root.querySelectorAll('.pick input')][0]?.click();
    await wait(1600);
    const afterWording = { staged: shape(last('stage')), shown: shape(last('render')) };
    [...root.querySelectorAll('.pick input')][1]?.click();
    await wait(1600);
    return {
      afterWording,
      afterSkills: { staged: shape(last('stage')), shown: shape(last('render')) },
      stages: sent.filter((c) => c.action === 'stage').length,
    };
  });

  check(
    'a wording ticked after building reaches the folder',
    tickedAfterBuilding.afterWording.staged === tickedAfterBuilding.afterWording.shown,
    JSON.stringify(tickedAfterBuilding.afterWording),
  );
  check(
    'and so does a skills group ticked after it',
    tickedAfterBuilding.afterSkills.staged === tickedAfterBuilding.afterSkills.shown,
    JSON.stringify(tickedAfterBuilding.afterSkills),
  );

  console.log('\nA way out of a run that is taking too long');

  /*
   * Every long run on this card used to be one-way. A keyword match is a
   * second; a model reading a posting is minutes, and there was no exit from
   * it except waiting or closing the card — and closing the card takes the
   * letter and the answers with it. So: a Stop in the progress bar, and what
   * it has to be is a stop rather than a hidden spinner. The reply must not
   * land afterwards, the proposal already on screen must survive, and the
   * abandoned request must not be reported as a failure.
   */
  const stopped = await inPage((createCard) => {
    let release;
    let crossing = false;
    const seen = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
        // Arriving untailored, which is what landing on a posting now does.
        tailor: 'none',
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        seen.push([action, payload]);
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action === 'rebuild') {
          // Hangs, like the real one does, until the stop reaches it.
          return new Promise((resolve, reject) => {
            release = { resolve, reject };
          });
        }
        if (action === 'cancelWork') {
          /*
           * What the worker does when it catches the request: rejects it,
           * marked. `crossing` is the other case it really has — a reply that
           * was already on the wire when Stop was pressed, which no abort can
           * take back. The worker answers `{ stopped: 0 }` and the reply turns
           * up a moment later as if nothing had happened.
           */
          if (crossing) return { stopped: 0 };
          const err = new Error('Stopped.');
          err.jobhelper = { stopped: true };
          release?.reject(err);
          return { stopped: 1 };
        }
        return {};
      },
    });
    void handle;
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    const stop = () => root.querySelector('.progress-label .stop');
    // Carries the AI star, so match on the words rather than the whole label.
    const byAi = () => [...root.querySelectorAll('button')].find((b) => /Have AI Tailor/.test(b.textContent));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    return (async () => {
      // The status arrives out of band; the AI button is dead until it does.
      await wait(20);
      // The AI, which is the only run that goes to the server now — and the
      // one worth being able to walk away from.
      byAi().click();
      await wait(20);
      const offered = Boolean(stop());
      stop()?.click();
      await wait(40);
      const after = {
        offered,
        // The bar is gone, so the card is not still claiming to be working.
        barGone: !root.querySelector('.progress'),
        // And it did not call it a failure.
        errored: root.querySelector('.err')?.textContent ?? null,
        // The worker was actually asked to let go, and named the run rather
        // than asking for everything: the letter being written underneath is
        // in another lane and must survive a stop aimed at the resume.
        asked: seen.filter(([a]) => a === 'cancelWork').map(([, p]) => JSON.stringify(p?.what)),
      };

      /*
       * And the other half: a reply that was already on its way when Stop was
       * pressed. Aborting cannot catch a request that is mid-answer, so the
       * card has to drop it on arrival — otherwise the thing you just chose
       * not to have lands on top of the thing you kept.
       */
      crossing = true;
      byAi().click();
      await wait(20);
      const late = release;
      stop()?.click();
      await wait(20);
      /*
       * A reply the card would act on. `aiUsed` is what makes it a decision
       * rather than a fallback, and without it the card lands on the same
       * mode either way — which would make the check below pass whether or
       * not the reply was dropped.
       */
      late.resolve({
        spec: { id: 'job-acme-late', label: 'Late', tier: 'temporary' },
        diff: [],
        rationale: [],
        tailor: 'ai',
        aiUsed: true,
      });
      await wait(40);
      /*
       * Which mode is lit is the reading that can tell the difference. The
       * proposal itself is put into `state` by the content script, not here,
       * so a card driven directly cannot see the spec change and asserting on
       * it would pass whether or not the reply was dropped.
       */
      return { ...after, lateClaimed: root.querySelector('.mode.on')?.textContent?.trim() ?? null };
    })();
  });

  check('a run in flight offers a way out', stopped.offered === true);
  check('and pressing it clears the bar', stopped.barGone === true);
  check('without calling it a failure', stopped.errored === null, String(stopped.errored));
  check(
    'the worker is told which run to let go of, not all of them',
    stopped.asked?.[0] === '["rebuild"]',
    JSON.stringify(stopped.asked),
  );
  check(
    'a reply that crossed the stop is dropped, not applied late',
    stopped.lateClaimed === 'Use Original',
    String(stopped.lateClaimed),
  );

  console.log('\nDrafting does not lock what you already wrote');

  /*
   * A draft is a model run of minutes. It used to hold the same lane as Save
   * to store and See it typeset, so asking for one greyed out both — under a
   * box the user had already written in. That is the AI holding up work it is
   * not touching, one level down from the fault the lanes exist to prevent:
   * a run you started must never be able to stop you keeping what you have.
   *
   * Nothing is lost by letting them run together. Saving mid-draft saves the
   * text that was in the box, which is the text on screen.
   */
  const whileDrafting = await inPage(async (createCard) => {
    let release;
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', extends: 'base' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: '', confident: false }],
      needsCoverLetter: true,
      onAction: async (action) =>
        action === 'coverLetter'
          ? new Promise((r) => { release = r; })
          : action === 'aiStatus'
            ? { active: true, state: 'on' }
            : {},
    });
    void handle;
    await new Promise((r) => setTimeout(r, 100));

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));

    /*
     * Typed, not planted. There is no `setLetter` on the handle — an earlier
     * version of this wrote `handle.setLetter?.(…)`, which is a silent no-op,
     * so the box was empty and every control under it was disabled for the
     * ordinary reason rather than the one being tested.
     */
    const box = root.querySelector('textarea[data-field="letter"]');
    if (!box) return { error: 'no letter box' };
    box.value = 'Something I wrote myself.';
    box.dispatchEvent(new Event('input', { bubbles: true }));

    const draft = byText('Draft a letter');
    if (!draft) return { error: 'no draft button' };
    draft.click();
    await new Promise((r) => setTimeout(r, 120));

    const state = {
      // The run really is going; without this the rest proves nothing.
      drafting: Boolean(root.querySelector('.progress')),
      save: byText('Save to store')?.disabled ?? null,
      typeset: byText('See it typeset')?.disabled ?? null,
      copy: byText('^Copy$')?.disabled ?? null,
      /*
       * And the button that would start a second run does wait — that is the
       * real collision, and the lane still has to catch it.
       *
       * Not "Draft a letter": that offer is only shown over an empty box, so
       * once something is written it is not in the DOM at all and reading its
       * `disabled` gives `null` whatever the lanes do. The one-run write is
       * always there.
       */
      writeBoth: byText('Write the letter and')?.disabled ?? null,
    };
    release?.({ body: '' });
    return state;
  });

  check('the draft really is running', whileDrafting.drafting === true, JSON.stringify(whileDrafting));
  check(
    'what you wrote can still be saved while it runs',
    whileDrafting.save === false,
    JSON.stringify(whileDrafting),
  );
  check(
    'and still be typeset',
    whileDrafting.typeset === false,
    JSON.stringify(whileDrafting),
  );
  check('and still be copied', whileDrafting.copy === false, JSON.stringify(whileDrafting));
  check(
    'while a second run does wait, because that is the collision',
    whileDrafting.writeBoth === true,
    JSON.stringify(whileDrafting),
  );

  console.log('\nA redraw does not throw you back to the top');

  /*
   * `.body` is the scroller and it is destroyed and rebuilt on every redraw,
   * so every redraw put you back at the header — and the card redraws for
   * things that have nothing to do with where you are looking: a status read
   * landing, a compile finishing, a tailoring pass arriving minutes later,
   * opening any panel. Working on the questions at the bottom of a long card
   * meant being thrown to the top over and over.
   */
  const scrolled = await inPage(async (createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      // Enough of them that the card is longer than it is tall, which is the
      // only state in which any of this is observable.
      questions: Array.from({ length: 12 }, (_, i) => ({
        question: `Question number ${i + 1}?`,
        answer: '',
        confident: false,
      })),
      needsCoverLetter: true,
      onAction: async () => ({}),
    });
    await new Promise((r) => setTimeout(r, 80));

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const body = () => root.querySelector('.body');
    const room = body().scrollHeight - body().clientHeight;
    if (room < 50) return { error: `card is not scrollable (${room}px of room)` };

    body().scrollTop = Math.round(room / 2);
    const before = body().scrollTop;

    // A redraw with nothing to do with where the user is looking: one more
    // question arriving, which is what a form finishing its own render does.
    handle.setQuestions([
      ...Array.from({ length: 12 }, (_, i) => ({ question: `Question number ${i + 1}?`, answer: '', confident: false })),
      { question: 'One that turned up late?', answer: '', confident: false },
    ]);
    await new Promise((r) => setTimeout(r, 60));

    return { room, before, after: body().scrollTop, rebuilt: body() !== null };
  });

  check('the card really is long enough to scroll', !scrolled.error, String(scrolled.error ?? `${scrolled.room}px`));

  console.log('\nThe wording nobody is sending takes less room');

  /*
   * Both sides of a row were drawn at full length, so a suggestion that
   * rewrites four lines spent eight saying so — half of it a sentence nobody
   * had chosen, struck through, which is also the half that is hardest to
   * read. The one not in the document is clamped to two lines.
   *
   * Clamped rather than hidden: a row with one side missing cannot be
   * compared, and comparing is the only reason to open this list.
   */
  const clamped = await inPage(async (createCard) => {
    const long = 'Created system for adjusting bounding boxes of models to encompass animations, polling animations for large changes and storing bounding box offsets in frames in order to reduce initial 20-30 ms freeze to 2 ms overhead.';
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Engine Programmer', company: 'Storm Flag Games' },
        spec: { id: 'job-sfg', label: 'Storm Flag', choices: { b_bounds: 'v_short' } },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [{ kind: 'changed', where: 'Storm Flag Games', from: long, to: 'Created system for accurate bounding of animated models, optimized away 20ms load time freeze into 2ms cost.' }],
        rationale: [{ key: 'b_bounds', from: 'v_long', to: 'v_short', toText: 'Created system for accurate bounding of animated models, optimized away 20ms load time freeze into 2ms cost.', because: ['performance'] }],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => (action === 'render' ? { pages: 1, fits: true } : {}),
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    root.querySelector('.fold-changes')?.click();
    const row = () => root.querySelector('.change');
    const heightOf = (sel) => row()?.querySelector(sel)?.getBoundingClientRect().height ?? null;

    // Off, so the suggestion is the one nobody is sending.
    const off = { kept: heightOf('del'), offered: heightOf('ins'), aside: Boolean(row()?.querySelector('ins.aside')) };

    root.querySelector('.pick')?.click();
    await new Promise((r) => setTimeout(r, 80));
    // On, so it is the original that is the aside now.
    const on = { kept: heightOf('del'), offered: heightOf('ins'), aside: Boolean(row()?.querySelector('del.aside')) };
    return { off, on };
  });

  check(
    'the longer wording really is the one being clamped',
    clamped.off.offered !== null && clamped.off.kept !== null,
    JSON.stringify(clamped),
  );
  check(
    'switched off, the suggestion is the short one on screen',
    clamped.off.aside === true && clamped.off.offered < clamped.off.kept,
    JSON.stringify(clamped.off),
  );
  check(
    'and switched on, it is the original that shrinks instead',
    clamped.on.aside === true && clamped.on.kept < clamped.off.kept,
    JSON.stringify(clamped),
  );
  check('and it really was scrolled', scrolled.before > 0, String(scrolled.before));
  check(
    'a redraw leaves you where you were reading',
    scrolled.after === scrolled.before,
    `${scrolled.before} → ${scrolled.after}`,
  );

  console.log('\nAsking for the AI is not the same as getting it');

  /*
   * A run that never started, or came back with prose instead of choices,
   * falls through to the suggestions and changes nothing. The card used to
   * record the mode that was *asked for*, so the AI button lit up either way
   * and the card claimed a tailoring that had not happened.
   */
  const aiFailedRun = await inPage(async (createCard) => {
    /*
     * What the server sends when the command could not be started: the
     * keyword match's shape, with the reason attached.
     */
    const failed = {
      spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
      rationale: [],
      diff: [],
      tailor: 'match',
      aiUsed: false,
      aiFailed: 'spawn claude ENOENT',
      // Which way it failed, which the server sends alongside the reason: a
      // command that is not there and one that was stopped for taking too
      // long are not the same thing to be told. See `aiFailedKind`.
      aiFailedKind: 'not-installed',
    };
    let handle;
    handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action) => {
        if (action === 'aiStatus') return { active: true, state: 'on' };
        if (action !== 'rebuild') return {};
        /*
         * The content script hands every rebuild reply to `update` before
         * returning it, and that is what puts the reason on the analysis the
         * summary reads. Without it this harness would be asking the card
         * about a failure it was never told about.
         */
        handle.update(failed);
        return failed;
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    [...root.querySelectorAll('button.mode')].find((b) => /Have AI Tailor/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 150));
    return {
      lit: root.querySelector('.mode.on')?.textContent?.trim() ?? null,
      // Every `.hint` on the card: the first one is the "Start from" label
      // above the base picker, not the sentence this is about.
      said: [...root.querySelectorAll('.hint')].map((n) => n.textContent).join(' | '),
    };
  });

  check(
    'a run that never started does not light the AI button',
    aiFailedRun.lit === 'Use Original',
    String(aiFailedRun.lit),
  );
  check(
    'and the card says what actually happened',
    /could not be started/i.test(aiFailedRun.said),
    aiFailedRun.said.slice(0, 90),
  );

  console.log('\nChanging the base resume keeps the suggestions');

  /*
   * The suggestions belong to the pair (base, posting): change either and
   * they have to be worked out again. This asked for `state.builtWith`, which
   * is `none` on everything the AI has not touched — and `none` comes back
   * with no rationale and no skill changes at all, so choosing a different
   * resume emptied the list and left nothing to tick.
   */
  const rebased = await inPage(async (createCard) => {
    const sent = [];
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
      },
      resumes: [
        { id: 'base', label: 'New grad', base: true },
        { id: 'intern', label: 'Summer intern', base: true },
      ],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, tailor: payload?.tailor });
        return action === 'aiStatus' ? { active: true, state: 'on' } : {};
      },
    });
    void handle;
    await new Promise((r) => setTimeout(r, 100));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const picker = root.querySelector('select');
    if (!picker) return { error: 'no base picker' };
    picker.value = 'intern';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { asked: sent.filter((c) => c.action === 'setBase').map((c) => c.tailor) };
  });

  check(
    'choosing another resume works the suggestions out for it',
    rebased.asked?.[0] === 'match',
    JSON.stringify(rebased),
  );

  console.log('\nWhich resume to start from, ranked and marked');

  /*
   * The store fills up — a new grad one, a summer intern one, one built for a
   * posting last March — and the picker listed them in whatever order they
   * were written. So the first decision of every application was made from
   * labels alone, and the label is the one thing that does not say what is in
   * the document.
   *
   * The store works out how much of the posting each resume already uses and
   * says which, if any, is clearly ahead. Marking is deliberately rare: a
   * star that is always somewhere is one nobody reads.
   */
  const picker = await inPage(async (createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Helios' },
        spec: { id: 'job-helios', label: 'Helios', tier: 'temporary' },
        baseResumeId: 'newgrad',
        rationale: [],
        diff: [],
        // Written worst-first on purpose, so passing cannot be the order the
        // list arrived in.
        /*
         * Written worst-first, and with two pairs tied, so passing cannot be
         * the order the list arrived in and the tiebreak has something to
         * break. Two are marked: they are level at the top, and `recommend`
         * marks everything level rather than choosing between equals.
         */
        resumeFit: [
          { id: 'lab', hits: 0, because: [], share: 0 },
          { id: 'newgrad', hits: 1, because: ['Go'], share: 0.1 },
          { id: 'systems', hits: 4, because: ['Go', 'Kafka'], share: 0.4 },
          { id: 'platform', hits: 6, because: ['Kafka', 'Kubernetes', 'Go'], share: 0.6 },
          { id: 'streaming', hits: 6, because: ['Kafka', 'Kubernetes', 'Go'], share: 0.6 },
          { id: 'job-acme-role', hits: 0, because: [], share: 0 },
          { id: 'job-vega-old', hits: 5, because: ['Kafka'], share: 0.5 },
          { id: 'job-helios-old', hits: 2, because: ['Go'], share: 0.2 },
          // Level with the Helios one, which is what the tiebreak is for.
          { id: 'job-orion-old', hits: 2, because: ['Go'], share: 0.2 },
        ],
        recommended: ['platform', 'streaming'],
      },
      resumes: [
        { id: 'newgrad', label: 'New grad', base: true },
        { id: 'lab', label: 'Lab', base: true },
        { id: 'platform', label: 'Platform', base: true },
        { id: 'streaming', label: 'Streaming', base: true },
        { id: 'systems', label: 'Systems', base: true },
        { id: 'job-acme-role', label: 'Role — Acme', tier: 'temporary' },
        { id: 'job-vega-old', label: 'Platform Engineer — Vega', tier: 'temporary' },
        /*
         * Orion before Helios on purpose. `sort` is stable, so with these the
         * other way round the expected order falls out of the array order
         * and the tiebreak could be deleted without a single check noticing.
         */
        { id: 'job-orion-old', label: 'Platform Engineer — Orion', tier: 'temporary' },
        { id: 'job-helios-old', label: 'Platform Engineer — Helios', tier: 'temporary' },
      ],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    void handle;
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const groups = [...root.querySelectorAll('select optgroup')].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll('option')].map((o) => o.textContent),
    }));
    return { groups };
  });

  const ownGroup = picker.groups?.find((g) => /Bases|Your resumes/.test(g.label));
  const builtGroup = picker.groups?.find((g) => /Built for a posting/.test(g.label));

  /** The label of each option, with the star and the count taken off. */
  const named = (group) =>
    (group?.options ?? []).map((o) => o.replace(/^★ /, '').replace(/ — uses .*$/, ''));
  /** The score each option reports, in the order they are listed. */
  const scores = (group) =>
    (group?.options ?? []).map((o) => Number(/uses (\d+) word/.exec(o)?.[1] ?? 0));

  check('the list is still grouped by what the resumes are', Boolean(ownGroup && builtGroup), JSON.stringify(picker.groups));

  /*
   * The whole order, not the first row. A check on position 0 alone passes
   * against a list that is right at the top and arbitrary underneath, which
   * is most of the list.
   */
  check(
    'yours are listed best-fit first, the whole way down',
    JSON.stringify(named(ownGroup)) === JSON.stringify(['Platform', 'Streaming', 'Systems', 'New grad', 'Lab']),
    JSON.stringify(named(ownGroup)),
  );
  check(
    'and the scores they report fall from top to bottom',
    JSON.stringify(scores(ownGroup)) === JSON.stringify([6, 6, 4, 1, 0]),
    JSON.stringify(scores(ownGroup)),
  );
  /*
   * Both of the two that are level at the top are marked — `recommend`
   * refuses to choose between equals — and both sit above everything they
   * beat. A star is not a substitute for the ordering: the marked ones have
   * to be the highest-scoring ones, or the two say different things about
   * the same list.
   */
  check(
    'everything the store marked is marked, and nothing else',
    JSON.stringify((ownGroup?.options ?? []).map((o) => o.startsWith('★'))) === JSON.stringify([true, true, false, false, false]),
    JSON.stringify(ownGroup?.options),
  );
  check(
    'each says how much of the posting it uses, so the mark explains itself',
    /uses 6 words from this posting/.test(ownGroup?.options?.[0] ?? ''),
    String(ownGroup?.options?.[0]),
  );

  /*
   * Fit decides here too, and this company only breaks the ties.
   *
   * Vega scores 5 and Helios 2, so Vega leads even though Helios is the
   * employer being applied to — lifting Helios outright put a resume with
   * nothing to do with this posting above one written for exactly it. Where
   * the numbers *are* level, at 2 apiece, Helios beats Orion.
   */
  check(
    'the ones built for a posting are ranked by fit, not by employer',
    JSON.stringify(named(builtGroup)) === JSON.stringify([
      'Platform Engineer — Vega',
      'Platform Engineer — Helios',
      'Platform Engineer — Orion',
      'Role — Acme',
    ]),
    JSON.stringify(named(builtGroup)),
  );
  check(
    'with this employer winning only where the fit is the same',
    scores(builtGroup)[1] === scores(builtGroup)[2] && /Helios/.test(builtGroup?.options?.[1] ?? ''),
    JSON.stringify(builtGroup?.options),
  );
  /*
   * Nothing in the group the store did not mark. A star on a second-best
   * would read as "start here" about a resume the numbers do not support.
   */
  check(
    'nothing else is marked',
    (builtGroup?.options ?? []).every((o) => !o.startsWith('★')),
    JSON.stringify(builtGroup?.options),
  );

  /*
   * And a store the server could not rank — an older one, or a page that was
   * never analysed — keeps the order it had. A list that cannot be ranked is
   * still a list.
   */
  const unranked = await inPage(async (createCard) => {
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Helios' },
        spec: { id: 'job-helios', label: 'Helios', tier: 'temporary' },
        baseResumeId: 'newgrad',
        rationale: [],
        diff: [],
      },
      resumes: [
        { id: 'newgrad', label: 'New grad', base: true },
        { id: 'lab', label: 'Lab', base: true },
        { id: 'job-acme-role', label: 'Role — Acme', tier: 'temporary' },
      ],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    return [...root.querySelectorAll('select option')].map((o) => o.textContent);
  });

  check(
    'a store with no ranking keeps its order and its plain labels',
    JSON.stringify(unranked) === JSON.stringify(['New grad', 'Lab', 'Role — Acme']),
    JSON.stringify(unranked),
  );

  console.log('\nAdding to a skills group and cutting from it are two decisions');

  /*
   * A narrowed group is really two things: some items the posting names go
   * in, and some it never mentions come out. The diff already writes them as
   * two rows — "Frameworks: added Node.js, Express" and "Frameworks: dropped
   * Unity, SDL — keeping Node.js, Express" — and they shared one box, because
   * both resolve to the same group and the box was the group's. Ticking
   * either did both, which is not what either row says it would do.
   */
  const halves = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Engine Programmer', company: 'Storm Flag' },
        spec: {
          id: 'job-sfg',
          label: 'Storm Flag',
          sections: [{ kind: 'skills', entries: [], items: { sk_fw: ['f_node', 'f_express'] } }],
        },
        baseLabel: 'New grad resume',
        tailor: 'match',
        diff: [
          { kind: 'added', where: 'Frameworks', text: 'Frameworks: added Node.js, Express' },
          { kind: 'removed', where: 'Frameworks', text: 'Frameworks: dropped Unity, SDL — keeping Node.js, Express' },
        ],
        rationale: [],
        skillChanges: [
          {
            groupId: 'sk_fw',
            groupName: 'Frameworks',
            // The base listed the two the posting never mentions…
            from: ['f_unity', 'f_sdl'],
            // …and the match wants the two it does.
            to: ['f_node', 'f_express'],
          },
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
    await new Promise((r) => setTimeout(r, 80));

    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    root.querySelector('.fold-changes')?.click();
    const picks = () => [...root.querySelectorAll('.pick')];
    const ticks = () => [...root.querySelectorAll('.pick input')].map((b) => b.checked);
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const itemsNow = () => {
      const spec = sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec;
      const items = (spec?.sections ?? []).find((x) => x.kind === 'skills')?.items ?? {};
      return Object.prototype.hasOwnProperty.call(items, 'sk_fw') ? items.sk_fw : 'inherited';
    };

    const boxes = picks().length;
    const start = ticks();

    // The adding half only.
    picks()[0].click();
    await settle();
    const added = { ticks: ticks(), items: itemsNow() };

    // And the cutting half on top of it.
    picks()[1].click();
    await settle();
    const both = { ticks: ticks(), items: itemsNow() };

    // Now take the adding half back off, leaving only the cut.
    picks()[0].click();
    await settle();
    const cutOnly = { ticks: ticks(), items: itemsNow() };

    // And the cut off too: nothing ticked, which has to be the base's group.
    picks()[1].click();
    await settle();
    const neither = { ticks: ticks(), items: itemsNow() };

    return { boxes, start, added, both, cutOnly, neither };
  });

  check('each row gets its own box', halves.boxes === 2, String(halves.boxes));
  check(
    'and both start off, over the group the base has',
    JSON.stringify(halves.start) === JSON.stringify([false, false]),
    JSON.stringify(halves.start),
  );
  /*
   * The half that matters, and the thing that was impossible before: adding
   * what the posting names without also cutting what it does not.
   */
  check(
    'taking the additions alone leaves the cut untouched',
    JSON.stringify(halves.added.ticks) === JSON.stringify([true, false]),
    JSON.stringify(halves.added.ticks),
  );
  check(
    'and the group keeps what it had, plus what was added',
    JSON.stringify(halves.added.items) === JSON.stringify(['f_unity', 'f_sdl', 'f_node', 'f_express']),
    JSON.stringify(halves.added.items),
  );
  /*
   * Both on is the match's own list, verbatim rather than the same set
   * rebuilt — it chose an order as well as a set.
   */
  check(
    'both together are exactly what the match proposed',
    JSON.stringify(halves.both.items) === JSON.stringify(['f_node', 'f_express']),
    JSON.stringify(halves.both.items),
  );
  check(
    'and the cut alone drops what the posting never names, adding nothing',
    JSON.stringify(halves.cutOnly.ticks) === JSON.stringify([false, true])
      && JSON.stringify(halves.cutOnly.items) === JSON.stringify([]),
    JSON.stringify(halves.cutOnly),
  );
  /*
   * Both off is the base's own list, written back. Taking the key out instead
   * — "absent means inherited" — prints every skill in the group now that
   * nothing inherits, so unticking a suggestion added skills the base had
   * turned off.
   */
  check(
    'and with both off again the group is exactly the base\'s, not the whole group',
    JSON.stringify(halves.neither.ticks) === JSON.stringify([false, false])
      && JSON.stringify(halves.neither.items) === JSON.stringify(['f_unity', 'f_sdl']),
    JSON.stringify(halves.neither),
  );

  console.log('\nA proposal whose diff came back empty');

  /*
   * The match records what it swapped even where resolving the two resumes
   * to compare them did not work, so there is something to show — and these
   * rows used to be a different shape: `where` and `ba` straight under
   * `.change`, no body and no box. Survivable while `.change` stacked its
   * children; not once the box made it a flex row, which laid the heading
   * out as a squeezed column beside the text. And with no box they could not
   * be switched off while counting as on, so the card claimed changes the
   * spec had already reverted.
   */
  const noDiff = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Engine Programmer', company: 'Storm Flag' },
        spec: { id: 'job-sfg', label: 'Storm Flag', choices: { b_bounds: 'v_long' } },
        baseLabel: 'New grad resume',
        tailor: 'match',
        // Nothing the server could resolve into a document comparison…
        diff: [],
        // …but it still knows what it swapped.
        rationale: [
          {
            key: 'b_bounds',
            from: 'v_long',
            to: 'v_short',
            where: 'Storm Flag Games',
            fromText: 'Created system for adjusting bounding boxes of models to encompass animations.',
            toText: 'Created system for accurate bounding of animated models.',
            because: ['performance'],
          },
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
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    root.querySelector('.fold-changes')?.click();

    const row = () => root.querySelector('.change');
    const before = {
      rows: root.querySelectorAll('.change').length,
      // The shape: a body wrapping the heading and the text, as every other
      // row has. Side by side is what the missing wrapper looked like.
      bodied: Boolean(row()?.querySelector('.change-body .where') && row()?.querySelector('.change-body .ba')),
      boxes: root.querySelectorAll('.pick input').length,
      ticked: root.querySelector('.pick input')?.checked ?? null,
    };

    root.querySelector('.pick')?.click();
    await new Promise((r) => setTimeout(r, 60));
    return {
      before,
      ticked: root.querySelector('.pick input')?.checked ?? null,
      choices: sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec?.choices ?? null,
    };
  });

  check('the row is still shown', noDiff.before.rows === 1, JSON.stringify(noDiff.before));
  check(
    'in the same shape as every other row, not laid out sideways',
    noDiff.before.bodied === true,
    JSON.stringify(noDiff.before),
  );
  check('and it gets a box like the others', noDiff.before.boxes === 1, JSON.stringify(noDiff.before));
  check(
    'which starts off, because the spec has the original pinned',
    noDiff.before.ticked === false,
    JSON.stringify(noDiff.before),
  );
  check(
    'and ticking it reaches the resume that is compiled',
    noDiff.ticked === true && noDiff.choices?.b_bounds === 'v_short',
    JSON.stringify(noDiff),
  );

  console.log('\nA build that comes back with nothing says so');

  /*
   * `state.render = r` with `r` undefined left the fit box reading "Not
   * compiled yet." and the error strip empty, so pressing Build resume
   * looked like a button that does nothing at all, with nowhere to go next.
   */
  const emptyBuild = await inPage(async (createCard) => {
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        diff: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      // A worker that answers without answering.
      onAction: async (action) => (action === 'render' ? undefined : {}),
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    [...root.querySelectorAll('button')].find((b) => /Build resume/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 120));
    return {
      said: root.querySelector('.err')?.textContent ?? null,
      pressed: Boolean([...root.querySelectorAll('button')].find((b) => /Build resume|Recompile/.test(b.textContent))),
      stillWaiting: /Not compiled yet/.test(root.textContent ?? ''),
    };
  });

  check(
    'a compile that answers with nothing is reported, not swallowed',
    /no compiled resume/i.test(emptyBuild.said ?? ''),
    String(emptyBuild.said),
  );
  check(
    'and the card still says it has nothing to show',
    emptyBuild.stillWaiting === true,
    JSON.stringify(emptyBuild),
  );

  console.log('\nWhere a drafted letter would come from');

  /*
   * A model writing a cover letter is the part of this people are rightly
   * wariest of, and the answer to that wariness is the whole reason the
   * letter bank, the answer bank and the writing notes exist: it works from
   * their letters, their samples and their own account of how they write.
   * The card asked for a letter and never said where one would come from, so
   * the button read as "have a machine write this".
   */
  const askCard = (voice) => inPage((createCard, given) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
        voice: given ?? undefined,
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: '', confident: false }],
      needsCoverLetter: true,
      onAction: async () => ({}),
    });
    void handle;
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    return [...root.querySelectorAll('.voice-from')].map((n) => n.textContent);
  }, voice);

  const counted = await askCard({ letters: 9, answers: 4, samples: 2, notes: true });
  check('it is said beside the letter and beside the questions', counted.length === 2, JSON.stringify(counted));
  check(
    'and counts what it has of yours, rather than claiming it',
    /9 letters you have written/.test(counted[0] ?? '') && /4 answers you have written/.test(counted[1] ?? ''),
    JSON.stringify(counted),
  );
  check(
    'naming the samples and the notes too',
    /2 writing samples/.test(counted[0] ?? '') && /how you write/.test(counted[0] ?? ''),
    String(counted[0]),
  );

  /*
   * And the honest answer on a first application, which is the one most worth
   * showing: a letter written with nothing of yours to learn from is a
   * different offer and should look like one.
   */
  const empty = await askCard({ letters: 0, answers: 0, samples: 0, notes: false });
  check(
    'says so plainly when there is nothing of yours to learn from yet',
    /nothing of yours to learn it from yet/i.test(empty[0] ?? ''),
    String(empty[0]),
  );
  check('and does not claim otherwise', !/not from nothing/.test(empty[0] ?? ''), String(empty[0]));

  // An older server that does not send the counts says nothing, rather than
  // saying something wrong about a bank it never described.
  const silent = await askCard(undefined);
  check('and nothing at all when the save did not say', silent.length === 0, JSON.stringify(silent));

  /*
   * The chip that says an application was branched, and the same chip when
   * you have come back to the job you branched away from.
   *
   * The second one is why this exists. Go A, B, A on a board that shows every
   * job at one address: the third page branches away from B, correctly, and
   * the worker hands back the letter you had started for A. The chip then
   * said "This looks like a different job, so it is a new application" over
   * that job's own half-written letter, and offered "Same job — put it back"
   * — which would merge *B* into it. Somebody reading that sentence on the
   * job they had just returned to presses it, and the extension performs the
   * one merge the whole branch exists to prevent, on their instruction.
   */
  console.log('\nThe chip that says an application was branched');

  const branchChip = (how) => inPage((createCard, given) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Helios' },
        spec: { id: 'job-helios', label: 'Helios' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async () => ({}),
    });
    handle.setTrail({
      pages: [{ url: 'http://board.example/all', title: 'Board', role: 'Platform Engineer', company: 'Helios' }],
      branchedFrom: { role: 'Data Scientist', company: 'Helios' },
    });
    handle.restoreWork(given ? { letter: 'Half a letter.' } : null, given ?? undefined);
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const strip = root.querySelector('.branch');
    return {
      said: strip?.textContent ?? '',
      back: Boolean(strip?.classList.contains('back')),
      buttons: [...(strip?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    };
  }, how);

  const branched = await branchChip(null);
  check('a branch says what it did and names what it left', /new application/.test(branched.said) && /Data Scientist at Helios/.test(branched.said), branched.said);
  check('and offers to put it back', branched.buttons.includes('Same job — put it back'), JSON.stringify(branched.buttons));

  const returned = await branchChip('job');
  check('coming back does not call it a new application', !/new application/.test(returned.said), returned.said);
  check('it says the writing for this job is here', /what you had written for it is here/.test(returned.said), returned.said);
  check('and offers nothing to press', returned.buttons.length === 0, JSON.stringify(returned.buttons));
  check('and drops the warning colour', returned.back === true, String(returned.back));

  console.log('\nCounting the words of an answer');

  /*
   * Reported: "there should be a word count in the question side". The card
   * counted characters only, and only where the box carried a `maxlength` —
   * and the limits people are held to are the ones the question states in
   * words, which no box enforces: SpaceX asks for "150 words or less".
   */
  const wordCounts = await inPage((createCard) => {
    const handle = createCard({
      analysis: { isJobPosting: true, job: { title: 'Engineer', company: 'SpaceX' }, spec: { id: 'job-spacex' }, rationale: [] },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      isForm: true,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    handle.setQuestions([
      {
        question: 'Please provide a short description (150 words or less) of any hands-on technical project in which you participated.',
        fieldId: 'jh-q-1',
        answer: 'I built a rocket avionics board.',
        confident: false,
      },
      { question: 'What technical skills do you hope to use in this position?', fieldId: 'jh-q-2', answer: '', confident: false },
      { question: 'Tell us about yourself (no more than 200 words).', fieldId: 'jh-q-3', answer: '', confident: false },
    ]);
    const counts = () => [...root.querySelectorAll('.q .wordcount')].map((c) => ({ text: c.textContent, over: c.classList.contains('over') }));
    const before = counts();
    const box = root.querySelector('textarea[data-field^="answer:Please provide"]');
    box.value = Array.from({ length: 151 }, (_, i) => `word${i}`).join(' ');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: counts() };
  });
  check('an answer is counted against the limit its question states', wordCounts.before[0]?.text === '6 / 150 words', JSON.stringify(wordCounts.before[0]));
  check('and a question with no limit still shows how long the answer is', wordCounts.before[1]?.text === '0 words', JSON.stringify(wordCounts.before[1]));
  check('"no more than 200 words" is a limit too', wordCounts.before[2]?.text === '0 / 200 words', JSON.stringify(wordCounts.before[2]));
  check(
    'going over is said, as it is typed',
    /^151 \/ 150 words — 1 over/.test(wordCounts.after[0]?.text ?? '') && wordCounts.after[0]?.over === true,
    JSON.stringify(wordCounts.after[0]),
  );

  console.log('\nThe card on a later page of an application');

  /*
   * An application on any of the big systems runs to four or five pages, and
   * the card proposed a resume on every one of them — a panel of work
   * finished on page one, sitting over the form. So it reduces: the job line,
   * the two buttons this page can still use, and a way back.
   *
   * Every condition is driven separately below, because each of them is the
   * difference between a useful card and a card that has hidden the thing
   * somebody was about to press. Reducing too eagerly is the worse failure:
   * on the first form page the chips to drag are in the panel this takes
   * away.
   */
  const reducing = await inPage((createCard) => {
    const posting = { url: 'https://acme.test/jobs/1', kind: 'posting', title: 'Platform Engineer' };
    const form = (n) => ({ url: `https://acme.test/apply/${n}`, kind: 'application', title: `Step ${n}` });

    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      // Every case below is on a page with a form on it; the page without
      // one is its own check further down.
      isForm: true,
      // A folder with something in it, so the drag chips have files to be.
      onAction: async (what) =>
        what === 'attachmentFiles'
          ? { files: [{ name: 'Jianwen-Ding-Resume.pdf' }, { name: 'Jianwen-Ding-Cover-Letter.pdf' }] }
          : {},
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const read = () => ({
      small: Boolean(root.querySelector('.body.reduced')),
      why: root.querySelector('.reduced-why')?.textContent ?? '',
      buttons: [...root.querySelectorAll('.card button')].map((b) => b.textContent.trim()),
    });

    const seen = {};
    seen.firstPage = read();

    // Three pages, two of them forms — but nothing built yet, so the panel
    // proposing a resume is still the whole point of the card.
    handle.setTrail({ pages: [posting, form(1), form(2)] });
    seen.nothingBuilt = read();

    // And now with a resume built on the page before.
    handle.restoreWork({ render: { ok: true } });
    handle.setTrail({ pages: [posting, form(1), form(2)] });
    seen.built = read();

    // The same, with this page missing from the trail entirely.
    handle.setTrail({ pages: [posting, form(1)] });
    seen.unrecorded = read();

    /*
     * Back to the first form page, which is where the chips get dragged and
     * the one page reducing must never touch. "This page" is that form page,
     * so it is excluded from the walk and nothing earlier is a form.
     */
    handle.setTrail({ pages: [posting, { ...form(1), url: location.href }] });
    seen.firstForm = read();

    handle.setTrail({ pages: [posting, form(1), form(2)] });
    seen.againLater = read();

    /*
     * A later page that asks something. Workday's "Application Questions"
     * is the fourth page of five, well after the resume is built — and the
     * reduced card has no questions in it, so the three essay boxes on it
     * were nowhere on the card: "questions not scanned".
     */
    handle.setQuestions([{ question: 'What technical skills do you hope to use in this position?', fieldId: 'jh-q-1', answer: '', confident: false }]);
    seen.asks = { ...read(), questions: root.querySelectorAll('.q').length };
    handle.setQuestions([]);
    seen.askedNothing = read();

    // Somebody asks for the whole card back.
    root.querySelector('.body.reduced .link')?.click();
    seen.expanded = read();

    // And it stays back, however many more pages go by.
    handle.setTrail({ pages: [posting, form(1), form(2), form(3)] });
    seen.stillExpanded = read();

    /*
     * Back to reduced, and this time waiting for the folder to answer, so
     * the chips have had their chance to appear.
     */
    root.querySelector('.body .link')?.remove();
    seen.chips = null;

    /*
     * And across the navigation to the next page of the form, which is where
     * a preference like this is actually lost: the card is destroyed and
     * rebuilt, and only what `takeWork` hands over survives.
     */
    seen.carried = Boolean(handle.takeWork().showEverything);
    return seen;
  });

  check('the first page of an application gets the whole card', reducing.firstPage.small === false, JSON.stringify(reducing.firstPage.buttons));
  check(
    'and so does a later page with nothing built yet',
    reducing.nothingBuilt.small === false,
    JSON.stringify(reducing.nothingBuilt.buttons),
  );
  check('a later page with the documents built is reduced', reducing.built.small === true, reducing.built.why);
  check('and says why, in what has happened rather than what it did', /documents are built/.test(reducing.built.why), reducing.built.why);
  /*
   * The page the store never recorded, which is most of the later ones.
   *
   * A page reaches the trail only if it was judged a posting, and
   * `kind: 'application'` wants a form asking who you are — step four of a
   * Workday application is a voluntary-disclosure page with no name box on
   * it, so it is in no trail. The trail here holds the pages *behind* this
   * one and not this one, which is the ordinary case rather than an edge.
   */
  check(
    'a page the trail never recorded is still a later page',
    reducing.unrecorded.small === true,
    reducing.unrecorded.why,
  );
  /*
   * The two it keeps are the two that act on the form in front of it. The
   * ones it drops are the ones about a resume that is already built — and
   * dropping Mark as applied is the point being checked, because that is the
   * button whose absence would be a bug if the application were not finished.
   */
  check(
    'it keeps the two buttons this page can use',
    reducing.built.buttons.includes('Autofill this form') && reducing.built.buttons.includes('Attach files'),
    JSON.stringify(reducing.built.buttons),
  );
  check(
    'and drops the panel about a resume that is already built',
    !reducing.built.buttons.includes('Mark as applied') && !reducing.built.buttons.some((b) => /^Build/.test(b)),
    JSON.stringify(reducing.built.buttons),
  );
  check(
    'the first form page is never reduced, whatever is built',
    reducing.firstForm.small === false,
    JSON.stringify(reducing.firstForm.buttons),
  );
  check('and the page after it is again', reducing.againLater.small === true, reducing.againLater.why);
  check(
    'but not a page that asks questions: answering them is what is left to do there',
    reducing.asks.small === false && reducing.asks.questions === 1,
    JSON.stringify({ small: reducing.asks.small, questions: reducing.asks.questions }),
  );
  check('and it reduces again once there is nothing to answer', reducing.askedNothing.small === true, reducing.askedNothing.why);
  check('asking for everything brings it back', reducing.expanded.small === false, JSON.stringify(reducing.expanded.buttons));
  check(
    'and it stays back — a guess overruled once is not made again',
    reducing.stillExpanded.small === false,
    JSON.stringify(reducing.stillExpanded.buttons),
  );
  check('and travels to the next page of the form', reducing.carried === true, String(reducing.carried));

  /*
   * The other direction, which is the one that would be wrong: a page that
   * was never told anything must not switch the reducing off for the page
   * after it. Driven through `restoreWork`, because that is the half of the
   * pair a change to the carrying would touch.
   */
  const carriedOff = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      isForm: true,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    // Everything the page before had, except an opinion about the card's size.
    handle.restoreWork({ render: { ok: true } });
    handle.setTrail({
      pages: [
        { url: 'https://acme.test/jobs/1', kind: 'posting', title: 'Platform Engineer' },
        { url: 'https://acme.test/apply/1', kind: 'application', title: 'Step 1' },
        { url: 'https://acme.test/apply/2', kind: 'application', title: 'Step 2' },
      ],
    });
    const quiet = Boolean(root.querySelector('.body.reduced'));

    /*
     * And the same page told what the one before it decided. This is the
     * half `takeWork` exists for: the card is destroyed on every navigation,
     * so a preference that is not picked up here was never kept at all.
     */
    const told = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      isForm: true,
      onAction: async () => ({}),
    });
    const after = document.querySelector('#jobhelper-card-host').shadowRoot;
    told.restoreWork({ render: { ok: true }, showEverything: true });
    told.setTrail({
      pages: [
        { url: 'https://acme.test/jobs/1', kind: 'posting', title: 'Platform Engineer' },
        { url: 'https://acme.test/apply/1', kind: 'application', title: 'Step 1' },
        { url: 'https://acme.test/apply/2', kind: 'application', title: 'Step 2' },
      ],
    });
    return { quiet, told: Boolean(after.querySelector('.body.reduced')) };
  });
  check('a page that carried no opinion still reduces', carriedOff.quiet === true, String(carriedOff.quiet));

  /*
   * And back on the description page, which is the case that caught this.
   *
   * Going back to re-read the posting mid-application is ordinary — it is
   * where "Edit in ResumeM-M" and the change list are — and the trail by then
   * has form pages in it. Judged on the trail alone the card shrank there
   * too, and the two buttons it leaves do nothing on a page with no form on
   * it, so everything it kept was useless and everything it hid was the
   * point.
   */
  const descriptionPage = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      isForm: false,
      onAction: async () => ({}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    handle.restoreWork({ render: { ok: true } });
    handle.setTrail({
      pages: [
        { url: 'https://acme.test/jobs/1', kind: 'posting', title: 'Platform Engineer' },
        { url: 'https://acme.test/apply/1', kind: 'application', title: 'Step 1' },
        { url: 'https://acme.test/apply/2', kind: 'application', title: 'Step 2' },
      ],
    });
    return {
      small: Boolean(root.querySelector('.body.reduced')),
      hasEditor: [...root.querySelectorAll('.card button')].some((b) => /Edit in ResumeM-M/.test(b.textContent)),
    };
  });
  /*
   * And the files, which the reduced card has to keep.
   *
   * On plenty of systems the resume box is on page two — contact details
   * first, files after — so the page that reduces is often the page with
   * the upload on it. A reduced card without the chips takes the drag away
   * on exactly the page it was for.
   */
  const reducedChips = await inPage((createCard) => {
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      isForm: true,
      onAction: async (what) =>
        what === 'attachmentFiles'
          ? { files: [{ name: 'Jianwen-Ding-Resume.pdf' }, { name: 'Jianwen-Ding-Cover-Letter.pdf' }] }
          : {},
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    /*
     * A staged folder as well as a built resume: the whole card only draws
     * the chips inside the block that shows the folder path, so without one
     * the comparison below would be against a panel that has no chips for
     * its own reasons.
     */
    handle.restoreWork({ render: { ok: true }, staged: { currentDir: '/tmp/current' } });
    handle.setTrail({
      pages: [
        { url: 'https://acme.test/jobs/1', kind: 'posting', title: 'Platform Engineer' },
        { url: 'https://acme.test/apply/1', kind: 'application', title: 'Step 1' },
        { url: 'https://acme.test/apply/2', kind: 'application', title: 'Step 2' },
      ],
    });

    // The folder is asked for asynchronously and the card redraws when it
    // answers, so this waits for the chips rather than for a clock.
    return new Promise((done) => {
      const at = Date.now();
      const look = () => {
        const body = root.querySelector('.body.reduced');
        const chips = [...(body?.querySelectorAll('.files > *') ?? [])].map((c) => c.textContent.trim());
        if (chips.length > 0 || Date.now() - at > 3000) {
          const note = body?.querySelector('.drag-note')?.textContent ?? '';
          /*
           * And then the whole card, because the same function draws both
           * and a refactor that dropped them from the propose view would
           * otherwise pass on the strength of the reduced one.
           */
          root.querySelector('.body.reduced .link')?.click();
          const whole = root.querySelector('.body:not(.reduced)');
          done({
            small: Boolean(body),
            chips,
            note,
            wholeChips: [...(whole?.querySelectorAll('.files > *') ?? [])].map((c) => c.textContent.trim()),
          });
          return;
        }
        setTimeout(look, 50);
      };
      look();
    });
  });
  check('the reduced card is still the reduced card', reducedChips.small === true);
  check(
    'and it keeps the files to drag into this page',
    reducedChips.chips.some((c) => /Jianwen-Ding-Resume\.pdf/.test(c)),
    JSON.stringify(reducedChips.chips),
  );
  check('with the line saying what to do with them', /Drag any of these/.test(reducedChips.note), reducedChips.note);
  check(
    'and the whole card still has them too',
    reducedChips.wholeChips.some((c) => /Jianwen-Ding-Resume\.pdf/.test(c)),
    JSON.stringify(reducedChips.wholeChips),
  );

  check(
    'a page with no form on it keeps the whole card, however far in',
    descriptionPage.small === false,
    String(descriptionPage.small),
  );
  check('so going back to re-read the posting still offers the builder', descriptionPage.hasEditor === true);
  check(
    'and one told the page before wanted everything comes up whole',
    carriedOff.told === false,
    String(carriedOff.told),
  );

  console.log('\nAn answer box with a limit');

  /*
   * A script assigning a value is not held to `maxlength`, so an answer longer
   * than the box went into the form whole and was refused on submit. The
   * card counts against the box's limit while it can still be cut, and tells
   * every drafting run what the limit is.
   */
  const limits = await inPage(async (createCard) => {
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
        { question: 'Why us?', answer: 'Short one.', confident: true, fieldId: 'jh-1', limit: 40 },
        { question: 'Tell us about a project.', answer: '', confident: false, fieldId: 'jh-2' },
      ],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        if (action === 'aiStatus') return { active: true, state: 'on' };
        return {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    await new Promise((r) => setTimeout(r, 120));
    const counters = () => [...root.querySelectorAll('.q .count')];
    const before = counters().map((c) => ({ text: c.textContent, over: c.classList.contains('over') }));

    const box = root.querySelector('textarea[data-field="answer:Why us?"]');
    box.value = 'x'.repeat(52);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = counters().map((c) => ({ text: c.textContent, over: c.classList.contains('over') }));

    const draft = [...root.querySelectorAll('.q')][0].querySelector('button.ai, button[class*="ai"]') ??
      [...[...root.querySelectorAll('.q')][0].querySelectorAll('button')].find((b) => /Draft|Rewrite/.test(b.textContent));
    draft?.click();
    await new Promise((r) => setTimeout(r, 150));
    const both = [...root.querySelectorAll('button')].find((b) => /Write .*2 answers/.test(b.textContent));
    both?.click();
    await new Promise((r) => setTimeout(r, 150));
    return {
      before,
      after,
      one: sent.find((c) => c.action === 'answer:Why us?')?.payload ?? null,
      all: sent.find((c) => c.action === 'writeApplication')?.payload?.questions ?? null,
    };
  });
  check('a box with a limit is counted against it', limits.before.length === 1 && limits.before[0].text === '10 / 40' && !limits.before[0].over, JSON.stringify(limits.before));
  check(
    'and says so, in red, once an answer runs past it',
    limits.after.length === 1 && limits.after[0].over && /12 over/.test(limits.after[0].text),
    JSON.stringify(limits.after),
  );
  check('drafting one answer tells the run the limit', limits.one?.limit === 40, JSON.stringify(limits.one));
  check(
    'and so does writing them all at once, only for the box that has one',
    limits.all?.[0]?.limit === 40 && limits.all?.[1]?.limit === undefined,
    JSON.stringify(limits.all),
  );

  console.log('\nAn AI-tailored resume carried to the next page');

  /*
   * The next page reads the posting again, but only by keyword, so the AI's
   * resume arrived there with the match's rows and the match's verdict filed
   * under the AI's button. Measured: the AI button lit and the AI's resume on
   * screen, under "The AI returned nothing usable, so nothing was tailored"
   * and a keyword row headed "Chosen by the AI", counted "0 of 1 change".
   *
   * Driven as the content script drives it: one card's `takeWork`, handed to
   * the next card's `restoreWork` after that page's own reading has landed.
   */
  const carriedAi = await inPage(async (createCard) => {
    const job = { title: 'Platform Engineer', company: 'Acme' };
    const onAction = async (action) =>
      action === 'aiStatus' ? { active: true, state: 'on' } : action === 'render' ? { pages: 1, fits: true } : {};
    const first = createCard({
      analysis: {
        isJobPosting: true,
        job,
        spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: 'v_streams' } },
        baseLabel: 'New grad resume',
        tailor: 'ai',
        aiUsed: true,
        rejected: [],
        diff: [{ kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a streaming pipeline' }],
        rationale: [
          { key: 'b_pipeline', from: 'v_base', to: 'v_streams', toText: 'Built a streaming pipeline', because: ['streaming'] },
        ],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction,
    });
    await new Promise((r) => setTimeout(r, 50));
    const work = JSON.parse(JSON.stringify(first.takeWork()));

    // The form: its own opening read is the keyword match, over the same base.
    const next = createCard({
      analysis: null,
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction,
    });
    next.update({
      isJobPosting: true,
      job,
      spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: 'v_kafka' } },
      baseLabel: 'New grad resume',
      tailor: 'match',
      aiUsed: false,
      rejected: [],
      diff: [{ kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' }],
      rationale: [{ key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] }],
    });
    next.restoreWork(work);
    await new Promise((r) => setTimeout(r, 50));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    root.querySelector('.fold-changes')?.click();
    return {
      hints: [...root.querySelectorAll('.hint')].map((n) => n.textContent).join(' | '),
      rows: root.querySelector('.changes')?.textContent ?? '',
      ticks: [...root.querySelectorAll('.pick input')].map((b) => b.checked),
      count: root.querySelector('.diff-head .count')?.textContent ?? null,
    };
  });
  check(
    'the AI resume carried to the next page is not called untailored',
    !/nothing usable|nothing was tailored/.test(carriedAi.hints),
    carriedAi.hints.slice(0, 200),
  );
  check(
    'and its rows are the AI’s, not the keyword match’s',
    /streaming pipeline/.test(carriedAi.rows) && !/Kafka/.test(carriedAi.rows),
    carriedAi.rows.slice(0, 200),
  );
  check(
    'ticked, because they are what is in it',
    JSON.stringify(carriedAi.ticks) === '[true]' && carriedAi.count === '1 change',
    `${JSON.stringify(carriedAi.ticks)} ${carriedAi.count}`,
  );

  /*
   * And the preview carried with a resume that was not restored.
   *
   * A proposal somebody asked for — the AI run started on the posting,
   * landing on the form a moment before the carried work — keeps the screen,
   * and the carried spec is held back. Its compiled preview was not: the card
   * showed the page-before's build and enabled "Mark as applied" on the
   * strength of it, and pressing that filed the AI's spec, which nothing had
   * compiled.
   */
  const previewOfAnother = await inPage(async (createCard) => {
    const sent = [];
    const job = { title: 'Platform Engineer', company: 'Acme' };
    const handle = createCard({
      analysis: null,
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        return action === 'aiStatus' ? { active: true, state: 'on' } : action === 'render' ? { pages: 1, fits: true } : {};
      },
    });
    const reading = (choice, more) => ({
      isJobPosting: true,
      job,
      spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: choice } },
      diff: [],
      rationale: [],
      ...more,
    });
    handle.update(reading('v_kafka', { tailor: 'match', aiUsed: false }));
    handle.update(reading('v_ai', { tailor: 'ai', aiUsed: true }), { show: true });
    handle.restoreWork({
      spec: { id: 'job-acme', label: 'Acme', choices: { b_pipeline: 'v_base' } },
      builtWith: 'none',
      render: { absolutePdfUrl: 'http://127.0.0.1:1/out/page-before.pdf', pages: 1, fits: true },
    });
    await new Promise((r) => setTimeout(r, 50));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const mark = [...root.querySelectorAll('button')].find((b) => /Mark as applied/.test(b.textContent));
    const open = [...root.querySelectorAll('a')].find((a) => /Open full size/.test(a.textContent));
    const enabled = Boolean(mark && !mark.disabled);
    mark?.click();
    await new Promise((r) => setTimeout(r, 50));
    return {
      enabled,
      preview: open?.href ?? null,
      filed: sent.find((c) => c.action === 'bundle')?.payload?.spec?.choices ?? null,
    };
  });
  check(
    'a preview of the carried resume is not put over the proposal that kept the screen',
    previewOfAnother.preview === null,
    JSON.stringify(previewOfAnother),
  );
  check(
    'so nothing is filed that was never compiled',
    previewOfAnother.enabled === false && previewOfAnother.filed === null,
    JSON.stringify(previewOfAnother),
  );

  console.log('\nAn Insert that puts nothing in says so');

  /*
   * The form refuses a box that has gone, or that now asks step two's
   * question (`insertAnswer` in autofill.js). A button that then does nothing
   * reads as broken; the card says what happened, and stops saying it once an
   * Insert lands.
   */
  const refused = await inPage(async (createCard) => {
    let lands = false;
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' },
        rationale: [],
      },
      resumes: [],
      settings: {},
      questions: [{ question: 'Why us?', answer: 'Rockets.', confident: true, fieldId: 'jh-7' }],
      needsCoverLetter: false,
      onAction: async (action) => (action === 'insertAnswer' ? lands : {}),
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const press = async () => {
      [...root.querySelectorAll('button')].find((b) => b.textContent === 'Insert into form').click();
      await new Promise((r) => setTimeout(r, 50));
      return /Nothing was put in/.test(root.textContent);
    };
    const before = /Nothing was put in/.test(root.textContent);
    const afterMiss = await press();
    lands = true;
    const afterHit = await press();
    return { before, afterMiss, afterHit };
  });
  check('nothing is said before Insert is pressed', refused.before === false, JSON.stringify(refused));
  check('a refused Insert says nothing was put in', refused.afterMiss === true, JSON.stringify(refused));
  check('and one that lands clears it', refused.afterHit === false, JSON.stringify(refused));

  console.log('\nA skill added alone goes where the proposal puts it');

  /*
   * The list a group saves prints in its own order. Ticking only the adding
   * half appended the addition to the base's list, so Rust, which the
   * proposal puts between Python and Go, printed last.
   */
  const placed = await inPage(async (createCard) => {
    const sent = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Backend Engineer', company: 'Ferrous' },
        spec: {
          id: 'job-ferrous',
          label: 'Ferrous',
          sections: [{ kind: 'skills', entries: [], items: { sk_lang: ['s_py', 's_rust', 's_go'] } }],
        },
        baseLabel: 'New grad resume',
        tailor: 'ai',
        aiUsed: true,
        diff: [
          { kind: 'added', where: 'Languages', text: 'Languages: added Rust' },
          { kind: 'removed', where: 'Languages', text: 'Languages: dropped PHP — keeping Python, Rust, Go' },
        ],
        rationale: [],
        skillChanges: [
          { groupId: 'sk_lang', groupName: 'Languages', from: ['s_py', 's_go', 's_php'], to: ['s_py', 's_rust', 's_go'] },
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
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    root.querySelector('.fold-changes')?.click();
    const picks = () => [...root.querySelectorAll('.pick')];
    const settle = () => new Promise((r) => setTimeout(r, 60));
    const itemsNow = () => {
      const spec = sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec;
      return (spec?.sections ?? []).find((x) => x.kind === 'skills')?.items?.sk_lang ?? null;
    };
    // Everything off first, whatever the card started with.
    for (const [i, box] of [...root.querySelectorAll('.pick input')].entries()) {
      if (box.checked) {
        picks()[i].click();
        await settle();
      }
    }
    const adding = picks().findIndex((p) => /added Rust/.test(p.closest('.change')?.textContent ?? p.textContent));
    picks()[adding < 0 ? 0 : adding].click();
    await settle();
    return { items: itemsNow(), boxes: picks().length };
  });
  check(
    'the addition alone lands in its place, the kept skills around it',
    JSON.stringify(placed.items) === JSON.stringify(['s_py', 's_rust', 's_go', 's_php']),
    JSON.stringify(placed),
  );

  console.log('\nComing back from the builder with the copy edited there');

  /*
   * "Edit in ResumeM-M" opens the tailored copy itself. What was changed on
   * it there was then thrown away: the card still held the copy as it was,
   * and filing sends that whole — so "Mark as applied" wrote the card's old
   * skills back over the ones just chosen in the builder.
   */
  const edited = await inPage(async (createCard) => {
    const sent = [];
    const stored = {
      id: 'job-ferrous',
      label: 'Ferrous',
      tier: 'temporary',
      sections: [{ kind: 'skills', entries: [], groups: ['sk_lang'], items: { sk_lang: ['s_py', 's_go', 's_rust'] } }],
    };
    const handle = createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Backend Engineer', company: 'Ferrous' },
        spec: {
          id: 'job-ferrous',
          label: 'Ferrous',
          tier: 'temporary',
          sections: [{ kind: 'skills', entries: [], groups: ['sk_lang'], items: { sk_lang: ['s_py', 's_go'] } }],
        },
        baseLabel: 'New grad resume',
        tailor: 'none',
        diff: [],
        rationale: [],
        skillChanges: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        sent.push({ action, payload });
        if (action === 'render') return { pages: 1, fits: true };
        if (action === 'listResumes') return [stored];
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const to = [...root.querySelectorAll('button')].find((b) => /Edit in ResumeM-M/.test(b.textContent));
    if (!to) return { error: 'no Edit in ResumeM-M button' };
    to.click();
    await handle.cameBack();
    await new Promise((r) => setTimeout(r, 120));
    const spec = sent.filter((c) => c.action === 'render').at(-1)?.payload?.spec;
    return { items: (spec?.sections ?? []).find((x) => x.kind === 'skills')?.items?.sk_lang ?? null };
  });
  check(
    'the card takes up the copy as it was left in the builder',
    JSON.stringify(edited.items) === JSON.stringify(['s_py', 's_go', 's_rust']),
    JSON.stringify(edited),
  );

  console.log('\nOpening the builder before the copy is in the store');

  /*
   * The tailored copy is only written to the store when it is built or
   * filed. "Edit in ResumeM-M" opened it by id regardless, so before then the
   * builder was sent to a resume that did not exist, said it had been
   * removed, and stayed on whatever was open — often the base.
   */
  const opened = await inPage(async (createCard, given) => {
    const urls = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Backend Engineer', company: 'Ferrous' },
        spec: { id: 'job-ferrous', label: 'Ferrous', tier: 'temporary', copiedFrom: 'newgrad', sections: [] },
        baseLabel: 'New grad resume',
        tailor: 'none',
        diff: [],
        rationale: [],
        skillChanges: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        if (action === 'openTab') urls.push(payload.url);
        if (action === 'render') return { pages: 1, fits: true };
        if (action === 'listResumes') return given.stored.map((id) => ({ id }));
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    [...root.querySelectorAll('button')].find((b) => /Edit in ResumeM-M/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 120));
    return urls;
  }, { stored: ['newgrad'] });
  check('before it is built, the builder opens the resume it was made from', opened.at(-1) === '/#resumes/newgrad', JSON.stringify(opened));

  const openedCopy = await inPage(async (createCard, given) => {
    const urls = [];
    createCard({
      analysis: {
        isJobPosting: true,
        job: { title: 'Backend Engineer', company: 'Ferrous' },
        spec: { id: 'job-ferrous', label: 'Ferrous', tier: 'temporary', copiedFrom: 'newgrad', sections: [] },
        baseLabel: 'New grad resume',
        tailor: 'none',
        diff: [],
        rationale: [],
        skillChanges: [],
      },
      resumes: [],
      settings: {},
      questions: [],
      needsCoverLetter: false,
      onAction: async (action, payload) => {
        if (action === 'openTab') urls.push(payload.url);
        if (action === 'render') return { pages: 1, fits: true };
        if (action === 'listResumes') return given.stored.map((id) => ({ id }));
        return {};
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    [...root.querySelectorAll('button')].find((b) => /Edit in ResumeM-M/.test(b.textContent))?.click();
    await new Promise((r) => setTimeout(r, 120));
    return urls;
  }, { stored: ['newgrad', 'job-ferrous'] });
  check('and once it is in the store, the copy itself', openedCopy.at(-1) === '/#resumes/job-ferrous', JSON.stringify(openedCopy));

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
