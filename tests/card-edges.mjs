/**
 * Five things the card got wrong, each reproduced and then put right.
 *
 *   - A pointer that passed over a chip while its files were being fetched
 *     again left the page armed: `pointerleave` disarmed first, and the
 *     fetch landing afterwards armed it, for a drop nobody was making.
 *   - A page's keyboard shortcut saw the card's host as the target of a key
 *     typed into an answer box, so "/" in "CI/CD" went to the page's search.
 *   - Opening the folder, copying its path, attaching the files or
 *     autofilling after "Mark as applied" counted as working on the card
 *     again, so the next store change rebuilt the files that were sent.
 *   - The AI's letter, written over a letter already started, was "offered
 *     rather than used" with no way to take it.
 *   - "CV" in a job title made both files resumes on the card.
 *
 * Over the in-page store tests/midaction.mjs uses, with an `override` hook.
 *
 *   node tests/card-edges.mjs
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

const STORE = `(() => {
  const s = { version: 1, copy: null, folder: [], sent: [], holds: {}, resumes: null };
  s.hold = (action) => {
    let release;
    const gate = new Promise((r) => (release = r));
    s.holds[action] = gate;
    return release;
  };
  const gated = async (action) => {
    const gate = s.holds[action];
    if (gate) {
      delete s.holds[action];
      await gate;
    }
  };
  s.edit = () => { s.version += 1; };
  // \`s.fail[action] = 'null' | 'throw'\` makes the next call of that action come back empty or fail.
  s.fail = {};
  s.onAction = async (action, payload) => {
    s.sent.push({ action, payload: payload && JSON.parse(JSON.stringify(payload)) });
    const failing = s.fail[action];
    if (failing) {
      delete s.fail[action];
      if (failing === 'throw') throw new Error('The store did not answer');
      return null;
    }
    // \`s.override[action]\` answers that action instead, every time.
    if (s.override?.[action]) return s.override[action](payload);
    switch (action) {
      case 'render': {
        const printed = 'p' + s.version;
        await gated(action);
        return { pages: 1, fits: true, printed, spec: payload.spec };
      }
      case 'stage':
      case 'bundle': {
        s.copy = JSON.parse(JSON.stringify(payload.spec));
        const built = { printed: 'p' + s.version, choices: payload.spec?.choices ?? null, as: action };
        await gated(action);
        s.folder.push(built);
        return { currentDir: '/tmp/upload', application: { id: 'app-acme' }, files: ['Jane-Resume.pdf'] };
      }
      case 'fresh':
        await gated(action);
        return {
          printed: 'p' + s.version,
          stored: s.copy,
          storedPrint: s.copy ? JSON.stringify(s.copy) : null,
          // What the store says of the resume the copy was made from: null
          // when it has nothing to say, as it has once that resume is deleted.
          base: s.base ?? null,
        };
      case 'rebuild': {
        await gated(action);
        const next = s.nextProposal?.(payload) ?? null;
        if (next) s.handle.update(next);
        return next;
      }
      case 'setBase':
        return null;
      case 'listResumes':
        return s.resumes ?? [];
      case 'attachFiles': {
        // What the folder holds when the files are taken from it.
        const from = s.folder.at(-1);
        s.attached = from?.printed ?? null;
        return { placed: [{ name: 'Jane-Resume.pdf', printed: from?.printed ?? null }], unplaced: [] };
      }
      case 'attachmentFiles':
        // The folder's file, and which build of the store it holds.
        return {
          files: [
            { name: 'Jane-Resume.pdf', base64: 'JVBERi0xLjQK', type: 'application/pdf', printed: s.folder.at(-1)?.printed ?? null },
          ],
        };
      case 'aiStatus':
        return { active: true, state: 'on' };
      default:
        return {};
    }
  };
  return s;
})()`;

/** A posting with two wordings to switch, the shape tests/card.mjs uses. */
const ANALYSIS = {
  isJobPosting: true,
  job: { title: 'Platform Engineer', company: 'Acme' },
  spec: { id: 'job-acme', label: 'Acme', tier: 'temporary', copiedFrom: 'base', choices: {} },
  baseResumeId: 'base',
  baseLabel: 'New grad resume',
  currentDir: '/tmp/upload',
  tailor: 'match',
  diff: [
    { kind: 'changed', where: 'Acme Co.', from: 'Built a pipeline', to: 'Built a Kafka pipeline' },
    { kind: 'changed', where: 'Northeastern', from: 'BS in Computer Science', to: 'BS in Computer Science, Systems concentration' },
  ],
  rationale: [
    { key: 'b_pipeline', from: 'v_base', to: 'v_kafka', toText: 'Built a Kafka pipeline', because: ['kafka'] },
    { key: 'edu_neu.subtitle', from: 'v_plain', to: 'v_systems', toText: 'BS in Computer Science, Systems concentration', because: ['systems'] },
  ],
};

async function main() {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto('about:blank');
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');

  /**
   * A fresh card over a fresh store, as tests/midaction.mjs sets one up.
   * `opts.override` is the source of an object of answers that replace the
   * store's own from the start — a function cannot cross into the page.
   */
  const setUp = (opts = {}) =>
    page.evaluate(
      async ([code, store, analysis, opts]) => {
        // A harness, not a page: the card takes untrusted presses here. See `HARNESS` in card.js.
        globalThis.__JOBHELPER_HARNESS__ = true;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const { createCard, removeCard } = await import(url);
        removeCard();
        // eslint-disable-next-line no-eval
        const s = (0, eval)(store);
        // eslint-disable-next-line no-eval
        if (opts.override) s.override = (0, eval)(`(${opts.override})`);
        s.resumes = [
          { id: 'base', label: 'New grad resume', tier: 'base' },
          { id: 'kept', label: 'Systems resume', tier: 'base' },
        ];
        const handle = createCard({
          analysis: JSON.parse(JSON.stringify(analysis)),
          resumes: s.resumes,
          settings: {},
          questions: opts.questions ?? [],
          needsCoverLetter: Boolean(opts.letter),
          onAction: s.onAction,
        });
        s.handle = handle;
        window.jh = { s, handle, root: document.querySelector('#jobhelper-card-host').shadowRoot };
        window.wait = (ms) => new Promise((r) => setTimeout(r, ms));
        window.until = async (test, ms = 5000) => {
          for (const end = Date.now() + ms; Date.now() < end; await window.wait(20)) if (test()) return true;
          return false;
        };
        window.button = (re) => [...jh.root.querySelectorAll('button')].find((b) => re.test(b.textContent));
        button(/Build resume/).click();
        await until(() => jh.s.folder.length > 0);
        await wait(50);
        jh.root.querySelector('.fold-changes')?.click();
        return true;
      },
      [source, STORE, ANALYSIS, opts],
    );
  const inPage = (fn, arg) => page.evaluate(fn, arg);

  /* ------------------------------------------------------------------ */
  console.log('\nA chip reached for while its files are fetched again');
  {
    /*
     * The files are fetched again after any stage; this one takes 400ms, as
     * over a real worker. `reach(stay)`: the pointer arrives during that
     * fetch, and either stays on the chip or leaves 20ms later.
     */
    const reach = (stay) =>
      inPage(async (stay) => {
        const chip = () => jh.root.querySelector('.file.liftable:not(.all):not(.missing)');
        await until(() => chip(), 3000);
        const plain = { files: [{ name: 'Jane-Resume.pdf', base64: 'JVBERi0xLjQK', type: 'application/pdf' }] };
        jh.s.override = { attachmentFiles: async () => (await wait(400), plain) };
        const stages = jh.s.sent.filter((c) => c.action === 'stage').length;
        const fetches = jh.s.sent.filter((c) => c.action === 'attachmentFiles').length;
        jh.s.edit();
        await jh.handle.storeChanged();
        await until(() => jh.s.sent.filter((c) => c.action === 'stage').length > stages, 5000);
        await until(() => jh.s.sent.filter((c) => c.action === 'attachmentFiles').length > fetches && chip(), 3000);
        await wait(30);
        const c = chip();
        c.dispatchEvent(new PointerEvent('pointerenter'));
        await wait(20);
        if (!stay) c.dispatchEvent(new PointerEvent('pointerleave'));
        await wait(800);
        const told = jh.s.sent.filter((x) => x.action === 'dragging').map((x) => x.payload.files.length);
        if (stay) c.dispatchEvent(new PointerEvent('pointerleave'));
        await wait(50);
        const after = jh.s.sent.filter((x) => x.action === 'dragging').map((x) => x.payload.files.length);
        return { told, after };
      }, stay);

    await setUp({});
    const passing = await reach(false);
    check(
      'a pointer that passed over the chip leaves the page disarmed once the files arrive',
      passing.told.length > 0 && passing.told.at(-1) === 0,
      JSON.stringify(passing.told),
    );
    await setUp({});
    const staying = await reach(true);
    check(
      'a pointer still on the chip when the files arrive arms the page',
      staying.told.at(-1) > 0,
      JSON.stringify(staying.told),
    );
    check('and leaving it then disarms', staying.after.at(-1) === 0, JSON.stringify(staying.after));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nTyping in the card, on a page with keyboard shortcuts');
  {
    const keys = await browser.newPage();
    await keys.setContent(`<input id="search"><script>
      // A page shortcut, written the usual way: ignore keys typed into a text box.
      window.heard = [];
      document.addEventListener('keydown', (e) => {
        const t = e.target;
        window.heard.push(e.key);
        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        if (e.key === '/') { e.preventDefault(); document.getElementById('search').focus(); }
      });
    </script>`);
    await keys.evaluate(async (code) => {
      // A harness, not a page: the card takes untrusted presses here. See `HARNESS` in card.js.
      globalThis.__JOBHELPER_HARNESS__ = true;
      const { createCard } = await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      createCard({
        analysis: { isJobPosting: true, job: { title: 'Platform Engineer', company: 'Acme' }, spec: { id: 'job-acme', label: 'Acme', tier: 'temporary' }, rationale: [] },
        resumes: [],
        settings: {},
        questions: [{ question: 'Why us?', answer: '', confident: false }],
        needsCoverLetter: false,
        onAction: async () => ({}),
      });
      // Something in the card listening for keys, as its own Enter and Escape handlers do.
      window.cardHeard = [];
      document.querySelector('#jobhelper-card-host').shadowRoot.addEventListener('keydown', (e) => window.cardHeard.push(e.key));
    }, source);
    const box = keys.locator('#jobhelper-card-host textarea[data-field="answer:Why us?"]');
    await box.click();
    await keys.keyboard.type('I/O and CI/CD work');
    const typed = await keys.evaluate(() => ({
      search: document.getElementById('search').value,
      heard: window.heard.length,
      cardHeard: window.cardHeard.join(''),
    }));
    check('a "/" typed into an answer box stays in it', (await box.inputValue()) === 'I/O and CI/CD work', await box.inputValue());
    check('and nothing reaches the page’s search box', typed.search === '', JSON.stringify(typed));
    check('the page does not hear keys typed into the card', typed.heard === 0, JSON.stringify(typed));
    check('the card itself still hears them', typed.cardHeard === 'I/O and CI/CD work', typed.cardHeard);
    // Out of the card, the page's shortcut is the page's.
    await keys.evaluate(() => document.activeElement?.blur());
    await keys.keyboard.press('/');
    const outside = await keys.evaluate(() => document.activeElement?.id ?? null);
    check('with focus outside the card, the page’s "/" still works', outside === 'search', String(outside));
    await keys.close();
  }

  /* ------------------------------------------------------------------ */
  console.log('\nUsing the files after Mark as applied');
  {
    /** Sent, then `press` on the done view, then a store change. */
    const afterSent = (press, edit) =>
      inPage(
        async ([press, edit]) => {
          button(/Mark as applied/).click();
          await until(() => /Saved\. These files/.test(jh.root.textContent));
          await wait(100);
          // Filing folds the card out of the way; the chevron brings the panel back.
          jh.root.querySelector('button[aria-label^="Unfold"]')?.click();
          await wait(100);
          if (press) {
            const b = button(new RegExp(press));
            if (!b) return { missing: press, labels: [...jh.root.querySelectorAll('button')].map((x) => x.textContent.trim()) };
            b.click();
            await wait(300);
          }
          if (edit) {
            const box = jh.root.querySelector('.rename-box');
            if (!box) return { missing: 'rename box' };
            box.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const before = jh.s.sent.length;
          jh.s.edit();
          await jh.handle.storeChanged();
          await wait(2500);
          const stages = jh.s.sent.slice(before).filter((c) => c.action === 'stage');
          return { stages: stages.length, evenIfSent: stages.map((c) => c.payload.evenIfSent ?? false) };
        },
        [press, edit],
      );
    for (const press of ['Open the folder', 'Copy folder path', 'Attach files', 'Autofill this form']) {
      await setUp({ override: `{ autofill: async () => ({ filled: [{ key: 'first_name', value: 'Jane' }], skipped: [] }) }` });
      const r = await afterSent(press, false);
      check(`pressing ${press} does not rebuild the sent files on a store change`, r.stages === 0, JSON.stringify(r));
    }
    await setUp({});
    const edited = await afterSent(null, true);
    check(
      'an edit on the card after the send still rebuilds them, saying so',
      edited.stages > 0 && edited.evenIfSent.every(Boolean),
      JSON.stringify(edited),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe AI’s letter, over a letter already started');
  {
    await setUp({
      letter: true,
      questions: [
        { question: 'Why Acme?', answer: '', confident: false, fieldId: 'q1' },
        { question: 'Tell us about a project.', answer: '', confident: false, fieldId: 'q2' },
      ],
      override: `{ writeApplication: async () => ({ oneRun: true, letter: 'Dear Acme, the AI draft.', answers: { q1: 'A1', q2: 'A2' }, priorLetters: [] }) }`,
    });
    const r = await inPage(async () => {
      const letter = () => jh.root.querySelector('textarea[data-field="letter"]');
      await until(() => button(/Write the letter/) && !button(/Write the letter/).disabled, 3000);
      letter().value = 'Dear Acme, my own opening line.';
      letter().dispatchEvent(new Event('input', { bubbles: true }));
      button(/Write the letter/).click();
      await until(() => jh.s.sent.some((c) => c.action === 'writeApplication') && button(/Write the letter/) && !/Writing/.test(button(/Write the letter/).textContent), 3000);
      await wait(200);
      const kept = letter().value;
      const offer = button(/Replace with the draft/);
      if (!offer) return { kept, offer: null };
      offer.click();
      await wait(100);
      const taken = letter().value;
      button(/Put back what you had/)?.click();
      await wait(100);
      return { kept, offer: offer.textContent, taken, putBack: letter().value };
    });
    check('what was typed is kept when the draft arrives', r.kept === 'Dear Acme, my own opening line.', r.kept);
    check('the draft is offered over it', Boolean(r.offer), JSON.stringify(r));
    check('taking it puts the draft in the box', r.taken === 'Dear Acme, the AI draft.', String(r.taken));
    check('and what it replaced can be put back', r.putBack === 'Dear Acme, my own opening line.', String(r.putBack));
  }

  /* ------------------------------------------------------------------ */
  console.log('\n"CV" in the job title');
  {
    await setUp({
      override: `{
        wantedDocuments: async () => ({ kinds: ['resume', 'letter'] }),
        attachmentFiles: async () => ({ files: [
          { name: 'Jane-Computer-Vision-CV-Engineer-Resume.pdf', base64: 'JVBERi0xLjQK', type: 'application/pdf' },
          { name: 'Jane-Computer-Vision-CV-Engineer-Cover-Letter.pdf', base64: 'JVBERi0xLjQK', type: 'application/pdf' },
        ] }),
      }`,
    });
    const r = await inPage(async () => {
      await until(() => jh.root.querySelectorAll('.file.liftable:not(.all)').length >= 2, 3000);
      await wait(100);
      return {
        missing: [...jh.root.querySelectorAll('.file.missing')].map((c) => c.dataset.kind),
        asked: [...jh.root.querySelectorAll('.file.liftable:not(.all):not(.missing)')]
          .filter((c) => c.querySelector('.asked-mark'))
          .map((c) => c.querySelector('.what').textContent),
      };
    });
    check('the letter is not reported missing', r.missing.length === 0, JSON.stringify(r));
    check('both files are what the form asks for', r.asked.length === 2, JSON.stringify(r));
  }

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
