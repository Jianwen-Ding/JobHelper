/**
 * The card's answers: what goes into a box from the bank, and what is sent.
 *
 * Two things the store cannot see from its side, driven through `createCard`
 * the way tests/card.mjs drives it.
 *
 * A question typed in by hand ("+ Question") was matched without saying who
 * is being applied to, and the bank's text went straight into the box whether
 * or not the store was sure of it — so on an Acme form, "Why do you want to
 * work here?" came back as the answer written for Globex, filled in, staged
 * and filed. A question read off the page has been offered rather than
 * filled in that case for a long time; this one was not.
 *
 * And the answers sent with the application were the current step's only: a
 * form that moves on in place, or a page at a time, left the first step's
 * answers out of the answers file by the time it was sent.
 *
 *   node tests/card-answers.mjs
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
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('about:blank');
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');

  const inPage = (fn, given) =>
    page.evaluate(
      async ([code, body, arg]) => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const { createCard, removeCard } = await import(url);
        removeCard();
        // eslint-disable-next-line no-new-func
        return new Function('createCard', 'given', `return (${body})(createCard, given)`)(createCard, arg);
      },
      [source, fn.toString(), given ?? null],
    );

  /*
   * One card on an Acme form, a question typed in by hand, and whatever the
   * bank's matcher is told to say about it. Everything the card then sends
   * is recorded.
   */
  const byHand = (createCard, hit) =>
    (async () => {
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
          if (action === 'matchAnswers') return { matches: [{ question: payload.questions[0], ...hit }] };
          if (action === 'render') return { pages: 1, fits: true };
          if (action === 'stage') return { currentDir: '/tmp/x' };
          return {};
        },
      });
      const root = document.querySelector('#jobhelper-card-host').shadowRoot;
      const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));
      const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
      await settle(30);
      window.prompt = () => 'Why do you want to work here?';
      const add = byText('\\+ Question');
      add?.click();
      await settle();
      const box = () => root.querySelector('textarea[data-field="answer:Why do you want to work here?"]')?.value ?? null;
      const before = {
        found: Boolean(add),
        asked: sent.find((c) => c.action === 'matchAnswers')?.payload ?? null,
        box: box(),
        offer: [...root.querySelectorAll('button')].map((b) => b.textContent).find((t) => /^Start from/.test(t)) ?? null,
        carried: handle.takeWork().answersByQuestion,
      };
      byText('Build resume')?.click();
      await settle(120);
      before.staged = sent.filter((c) => c.action === 'stage').at(-1)?.payload?.answers ?? null;
      // Taken, on purpose — and then it is this person's answer, and goes.
      byText('^Start from')?.click();
      await settle();
      byText('Save for next time')?.click();
      await settle();
      const taken = { box: box(), saved: sent.find((c) => c.action === 'saveAnswer')?.payload ?? null };
      return { before, taken };
    })();

  console.log('\nA question typed in by hand, matched to another employer’s answer');
  const globex = await inPage(byHand, {
    answer: 'I have admired Globex since my first internship.',
    score: 0.92,
    confident: false,
    namesAnother: 'Globex',
    item: { id: 'item-why' },
  });
  check('the + Question button is there to press', globex.before.found, JSON.stringify(globex.before));
  check(
    'the bank is told who is being applied to',
    globex.before.asked?.company === 'Acme',
    JSON.stringify(globex.before.asked),
  );
  check('the Globex answer is not put in the Acme box', globex.before.box === '', JSON.stringify(globex.before.box));
  check(
    'it is offered, named for who it was written for',
    globex.before.offer === 'Start from what you told Globex',
    String(globex.before.offer),
  );
  check(
    'nor is it staged as what Acme is sent',
    Array.isArray(globex.before.staged) && !globex.before.staged.some((a) => /Globex/.test(a.answer)),
    JSON.stringify(globex.before.staged),
  );
  check(
    'nor carried to the next page as though written for Acme',
    !Object.values(globex.before.carried ?? {}).some((a) => /Globex/.test(a)),
    JSON.stringify(globex.before.carried),
  );
  check('once taken it is in the box', /Globex/.test(globex.taken.box ?? ''), String(globex.taken.box));
  check(
    'and saving it goes back onto the row it came from',
    globex.taken.saved?.itemId === 'item-why',
    JSON.stringify(globex.taken.saved),
  );

  console.log('\nA question typed in by hand, with only a loose match');
  const loose = await inPage(byHand, {
    answer: 'Because the platform team builds things I use.',
    score: 0.55,
    confident: false,
    item: { id: 'item-loose' },
  });
  check('a loose match is not filled in', loose.before.box === '', JSON.stringify(loose.before.box));
  check(
    'it is offered instead',
    loose.before.offer === 'Start from your closest answer',
    String(loose.before.offer),
  );
  check(
    'and nothing is staged for it',
    Array.isArray(loose.before.staged) && loose.before.staged.length === 0,
    JSON.stringify(loose.before.staged),
  );

  console.log('\nA question typed in by hand, with a confident match');
  const sure = await inPage(byHand, {
    answer: 'Because Acme builds the tools I already rely on.',
    score: 0.97,
    confident: true,
    item: { id: 'item-sure' },
  });
  check('a confident match is filled in', sure.before.box === 'Because Acme builds the tools I already rely on.', String(sure.before.box));
  check('with nothing to offer beside it', sure.before.offer === null, String(sure.before.offer));
  check(
    'and is staged',
    sure.before.staged?.some((a) => a.question === 'Why do you want to work here?' && /Acme/.test(a.answer)),
    JSON.stringify(sure.before.staged),
  );

  /*
   * A form that moves to its next step in place: `setQuestions` is called
   * again with step two's questions, and step one's are gone from the list.
   * A typed answer survived in `state.answers`; one answered from the bank
   * and left as it stood lived only on its question, and went with it.
   */
  console.log('\nA form whose steps follow one another in place');
  const inPlace = await inPage(async (createCard) => {
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
        return action === 'render' ? { pages: 1, fits: true } : action === 'stage' ? { currentDir: '/tmp/x' } : {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));
    const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
    handle.setQuestions([
      { question: 'How did you hear about us?', fieldId: 'jh-q-1', answer: 'A friend who works there.', confident: true },
      { question: 'Why do you want to work here?', fieldId: 'jh-q-2', answer: 'Globex is why I applied.', confident: false, namesAnother: 'Globex' },
      { question: 'What is your notice period?', fieldId: 'jh-q-3', answer: '', confident: false },
    ]);
    await settle(30);
    const typed = root.querySelector('textarea[data-field="answer:What is your notice period?"]');
    typed.value = 'Two weeks.';
    typed.dispatchEvent(new Event('input', { bubbles: true }));
    // Step two.
    handle.setQuestions([{ question: 'Tell us about a project you led.', fieldId: 'jh-q-4', answer: 'The billing rewrite.', confident: true }]);
    await settle(30);
    byText('Build resume')?.click();
    await settle(120);
    return {
      staged: sent.filter((c) => c.action === 'stage').at(-1)?.payload?.answers ?? null,
      carried: handle.takeWork().answersByQuestion,
    };
  });
  const stagedQ = (inPlace.staged ?? []).map((a) => a.question);
  check(
    'the answers file still has step one’s bank answer',
    (inPlace.staged ?? []).some((a) => a.question === 'How did you hear about us?' && a.answer === 'A friend who works there.'),
    JSON.stringify(inPlace.staged),
  );
  check('and step one’s typed answer', stagedQ.includes('What is your notice period?'), JSON.stringify(stagedQ));
  check('and step two’s', stagedQ.includes('Tell us about a project you led.'), JSON.stringify(stagedQ));
  check(
    'but not an answer step one only offered, written for somebody else',
    !(inPlace.staged ?? []).some((a) => /Globex/.test(a.answer)),
    JSON.stringify(inPlace.staged),
  );
  check(
    'and the next page is handed all of them',
    inPlace.carried?.['How did you hear about us?'] === 'A friend who works there.' &&
      inPlace.carried?.['Tell us about a project you led.'] === 'The billing rewrite.' &&
      !('Why do you want to work here?' in (inPlace.carried ?? {})),
    JSON.stringify(inPlace.carried),
  );

  /*
   * A form a page at a time: what the last page's card handed over arrives
   * through `restoreWork`, and only a question asked again here was filled
   * from it. The rest was carried and never sent.
   */
  console.log('\nA form a page at a time');
  const pages = await inPage(async (createCard) => {
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
        return action === 'render' ? { pages: 1, fits: true } : action === 'stage' ? { currentDir: '/tmp/x' } : {};
      },
    });
    const root = document.querySelector('#jobhelper-card-host').shadowRoot;
    const byText = (t) => [...root.querySelectorAll('button')].find((b) => new RegExp(t).test(b.textContent));
    const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));
    handle.restoreWork({
      answersByQuestion: {
        'How did you hear about us?': 'A friend who works there.',
        'What is your notice period?': 'Two weeks.',
      },
    });
    handle.setQuestions([
      { question: 'Tell us about a project you led.', fieldId: 'jh-q-4', answer: 'The billing rewrite.', confident: true },
      { question: 'What is your notice period?', fieldId: 'jh-q-5', answer: '', confident: false },
    ]);
    await settle(30);
    // Asked again here, and emptied here: this page's say wins.
    const again = root.querySelector('textarea[data-field="answer:What is your notice period?"]');
    const carriedIn = again.value;
    again.value = '';
    again.dispatchEvent(new Event('input', { bubbles: true }));
    byText('Build resume')?.click();
    await settle(120);
    return {
      carriedIn,
      staged: sent.filter((c) => c.action === 'stage').at(-1)?.payload?.answers ?? null,
      carried: handle.takeWork().answersByQuestion,
    };
  });
  check('a question asked again is filled from the page before, as it was', pages.carriedIn === 'Two weeks.', pages.carriedIn);
  check(
    'the page before’s other answers are sent with this one’s',
    (pages.staged ?? []).some((a) => a.question === 'How did you hear about us?') &&
      (pages.staged ?? []).some((a) => a.question === 'Tell us about a project you led.'),
    JSON.stringify(pages.staged),
  );
  check(
    'and an answer emptied here is not sent from the page before',
    !(pages.staged ?? []).some((a) => a.question === 'What is your notice period?'),
    JSON.stringify(pages.staged),
  );
  check(
    'and the page after is handed the first page’s too',
    pages.carried?.['How did you hear about us?'] === 'A friend who works there.',
    JSON.stringify(pages.carried),
  );

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
