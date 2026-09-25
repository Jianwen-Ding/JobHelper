/**
 * The store changing while the card is in the middle of something.
 *
 * The card follows ResumeM-M live now: content.js asks `/api/revision` every
 * four seconds, and when it moves calls `storeChanged` and then `setMatches`.
 * The card's own work writes to the store too — staging files the copy,
 * Mark as applied files it again, Save for next time writes the bank — so the
 * revision moves while somebody is typing, dragging, waiting on a compile or
 * on the AI. Those moments cannot be summoned from a real page on demand, so
 * this drives the card through its own handle, as tests/card.mjs does, over a
 * small store kept in the page: every call the card makes goes to it, any of
 * them can be held open, and the store can be changed between any two steps.
 * `storeChanged` is then called exactly as the watcher calls it.
 *
 *   node tests/midaction.mjs
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

/*
 * A store, in the page, that answers the card the way ResumeM-M and the
 * worker do in the parts that matter here:
 *
 *   render   prints what the store says *when the compile starts*
 *   stage    writes the copy first, then builds (the slow part), then answers
 *   bundle   the same, filed as applied
 *   fresh    what the copy would print now, and the copy the store holds
 *
 * `hold(action)` makes the next call of that action wait for `release()`;
 * `edit()` is somebody changing what the resume prints in ResumeM-M.
 */
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
  s.onAction = async (action, payload) => {
    s.sent.push({ action, payload: payload && JSON.parse(JSON.stringify(payload)) });
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
          base: null,
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
        return { files: [{ name: 'Jane-Resume.pdf', base64: 'JVBERi0xLjQK', type: 'application/pdf' }] };
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

  /*
   * A fresh card over a fresh store, left on `window` so that a test can
   * step outside `evaluate` — a real mouse drag has to — and come back to it.
   */
  const setUp = (opts = {}) =>
    page.evaluate(
      async ([code, store, analysis, opts]) => {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        const { createCard, removeCard } = await import(url);
        removeCard();
        document.querySelector('#zone')?.remove();
        // eslint-disable-next-line no-eval
        const s = (0, eval)(store);
        s.resumes = opts.resumes ?? [
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
        /** Until `test` holds, or give up after `ms`. */
        window.until = async (test, ms = 5000) => {
          for (const end = Date.now() + ms; Date.now() < end; await window.wait(20)) if (test()) return true;
          return false;
        };
        window.button = (re) => [...jh.root.querySelectorAll('button')].find((b) => re.test(b.textContent));
        window.note = () => jh.root.querySelector('.ok-note')?.textContent ?? '';
        window.ticks = () => [...jh.root.querySelectorAll('.pick input')].map((b) => b.checked);
        window.renders = () => jh.s.sent.filter((c) => c.action === 'render');
        // Built, and staged, the way pressing Build resume leaves a card.
        if (opts.built !== false) {
          button(/Build resume/).click();
          await until(() => jh.s.folder.length > 0);
          await wait(50);
        }
        jh.root.querySelector('.fold-changes')?.click();
        return true;
      },
      [source, STORE, ANALYSIS, opts],
    );
  const inPage = (fn, arg) => page.evaluate(fn, arg);

  /* ------------------------------------------------------------------ */
  console.log('\nWriting when a store change arrives');
  {
    await setUp({
      letter: true,
      questions: [
        { question: 'Why Acme?', answer: '', confident: false, fieldId: 'q1' },
        { question: 'Tell us about a project.', answer: 'From the bank.', confident: true, fieldId: 'q2' },
      ],
    });
    const letter = await inPage(async () => {
      const box = jh.root.querySelector('textarea[data-field="letter"]');
      box.focus();
      box.value = 'Dear Acme, I have kept streaming pipelines running';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.setSelectionRange(10, 10);
      // Somebody rewords a bullet in ResumeM-M; the watcher sees it.
      jh.s.edit();
      await jh.handle.storeChanged();
      await until(() => /Updated from ResumeM-M/.test(note()));
      await wait(50);
      const now = jh.root.activeElement;
      return {
        rebuilt: !box.isConnected,
        said: note(),
        field: now?.dataset?.field ?? null,
        value: now?.value ?? null,
        caret: now?.selectionStart ?? null,
      };
    });
    check('a change that recompiles really does redraw under the letter box', letter.rebuilt && /Updated from ResumeM-M/.test(letter.said), JSON.stringify(letter));
    check('and the letter box keeps focus, text and caret', letter.field === 'letter' && letter.value === 'Dear Acme, I have kept streaming pipelines running' && letter.caret === 10, JSON.stringify(letter));

    const answer = await inPage(async () => {
      const box = jh.root.querySelector('textarea[data-field="answer:Why Acme?"]');
      box.focus();
      box.value = 'Because the pipeline';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.setSelectionRange(7, 7);
      // The bank answers both questions differently now.
      jh.s.edit();
      await jh.handle.storeChanged();
      jh.handle.setMatches([
        { question: 'Why Acme?', answer: 'Written in ResumeM-M.', confident: true },
        { question: 'Tell us about a project.', answer: 'Reworded in ResumeM-M.', confident: true },
      ]);
      await wait(50);
      const now = jh.root.activeElement;
      return {
        field: now?.dataset?.field ?? null,
        value: now?.value ?? null,
        caret: now?.selectionStart ?? null,
        other: jh.root.querySelector('textarea[data-field="answer:Tell us about a project."]')?.value ?? null,
      };
    });
    check('an answer box keeps focus, what was typed and the caret', answer.field === 'answer:Why Acme?' && answer.value === 'Because the pipeline' && answer.caret === 7, JSON.stringify(answer));
    check('while the untouched one takes the bank\'s new answer', answer.other === 'Reworded in ResumeM-M.', JSON.stringify(answer));

    /*
     * The rename box on a file chip is text being typed too, and the one box
     * on the card `draw` has no name for. Opened, half a name typed, and the
     * card's own staging moving the revision a moment later — every build
     * stages — shut the menu and threw the name away.
     */
    const rename = await inPage(async () => {
      await until(() => jh.root.querySelector('.file.liftable'));
      const chip = jh.root.querySelector('.file.liftable');
      chip.querySelector('.rename .open-file').click();
      [...chip.querySelectorAll('.rename-menu button')].find((b) => /Rename/.test(b.textContent)).click();
      const box = chip.querySelector('.rename-box');
      box.value = 'Jane-Acme-Res';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.setSelectionRange(9, 9);
      jh.s.edit();
      await jh.handle.storeChanged();
      await until(() => !jh.s.holds.render && renders().length > 0);
      await wait(50);
      const now = jh.root.activeElement;
      const shown = jh.root.querySelector('.file.liftable .rename-box');
      const out = {
        rebuilt: !box.isConnected,
        open: Boolean(shown && !shown.classList.contains('hidden') && !shown.closest('.rename-menu')?.classList.contains('hidden')),
        value: shown?.value ?? null,
        focused: now === shown,
        caret: now === shown ? shown.selectionStart : null,
      };
      // And finished there: Enter names the file what was typed.
      const stages = jh.s.sent.filter((c) => c.action === 'stage').length;
      shown?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await until(() => jh.s.sent.filter((c) => c.action === 'stage').length > stages, 3000);
      out.named = jh.s.sent.filter((c) => c.action === 'stage').at(-1)?.payload?.naming?.custom?.Resume ?? null;
      out.shutAfter = jh.root.querySelector('.file.liftable .rename-menu')?.classList.contains('hidden') ?? null;
      return out;
    });
    check(
      'a name half typed into a file chip\'s rename box stays open, typed and focused',
      rename.rebuilt && rename.open && rename.value === 'Jane-Acme-Res' && rename.focused && rename.caret === 9,
      JSON.stringify(rename),
    );
    check('and Enter there still names the file, and shuts the menu', rename.named === 'Jane-Acme-Res' && rename.shutAfter === true, JSON.stringify(rename));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nA chip being dragged when the card redraws');
  {
    await setUp();
    await inPage(async () => {
      await until(() => jh.root.querySelector('.file.liftable:not(.warming)'));
      const zone = document.createElement('div');
      zone.id = 'zone';
      zone.style.cssText = 'position:fixed;left:40px;top:40px;width:300px;height:200px;border:1px solid #000';
      document.body.append(zone);
      window.drops = 0;
      zone.addEventListener('dragover', (e) => e.preventDefault());
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        window.drops += 1;
      });
      jh.s.sent.length = 0;
    });
    const chip = page.locator('#jobhelper-card-host .file.liftable').first();
    await chip.scrollIntoViewIfNeeded();
    const from = await chip.boundingBox();
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    // Redrawn between the press and the drag, and again with the drag under way.
    await inPage(async () => {
      jh.s.edit();
      await jh.handle.storeChanged();
    });
    await page.mouse.move(from.x + 40, from.y + from.height / 2 + 10, { steps: 4 });
    await inPage(async () => {
      jh.s.edit();
      await jh.handle.storeChanged();
    });
    await page.mouse.move(150, 140, { steps: 12 });
    const midway = await inPage(() => jh.s.sent.filter((c) => c.action === 'dragging').map((c) => c.payload.files.length));
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await inPage(() => ({
      drops: window.drops,
      told: jh.s.sent.filter((c) => c.action === 'dragging').map((c) => c.payload.files.length),
      redrew: /Updated from ResumeM-M/.test(note()),
    }));
    check('the drag still lands where it was let go', after.drops === 1 && after.redrew, JSON.stringify(after));
    check('with the page told what is in the air all the way there', midway.length > 0 && midway.at(-1) > 0, JSON.stringify(midway));
    check('and told it is over when it is', after.told.at(-1) === 0, JSON.stringify(after.told));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nA rebuild or a compile under way when the store moves');
  {
    await setUp();
    const racing = await inPage(async () => {
      jh.s.nextProposal = () => ({
        isJobPosting: true,
        job: { title: 'Platform Engineer', company: 'Acme' },
        spec: { id: 'job-acme', label: 'Acme', tier: 'temporary', copiedFrom: 'base', choices: { b_pipeline: 'v_rebuilt' } },
        baseResumeId: 'base',
        tailor: 'match',
        diff: [],
        rationale: [{ key: 'b_pipeline', from: 'v_base', to: 'v_rebuilt', toText: 'Rebuilt', because: ['kafka'] }],
      });
      /*
       * The watcher's read out when Keyword match is pressed, so it comes back
       * to a card that is rebuilding and compiles the proposal from before —
       * and that compile comes back after the rebuild has landed.
       */
      const freshBack = jh.s.hold('fresh');
      const rebuildBack = jh.s.hold('rebuild');
      jh.s.edit();
      const watching = jh.handle.storeChanged();
      await wait(30);
      const matching = jh.handle.retailor('match');
      await wait(30);
      const renderBack = jh.s.hold('render');
      const before = renders().length;
      freshBack();
      const compiled = await until(() => renders().length > before, 1000);
      rebuildBack();
      await matching;
      await wait(30);
      renderBack();
      await watching;
      await wait(100);
      return {
        compiled,
        started: renders().slice(before).map((r) => r.payload.spec?.choices?.b_pipeline ?? null),
        // Nothing compiled of the proposal on screen, so nothing to show yet.
        button: button(/Build resume|Recompile/)?.textContent ?? null,
        fit: Boolean(jh.root.querySelector('.fit.ok, .fit.bad')),
      };
    });
    check(
      'a compile the watcher started for the old proposal does not land over the rebuild pressed meanwhile',
      racing.button === 'Build resume' && !racing.fit,
      JSON.stringify(racing),
    );

    /*
     * And a change the watcher saw while the card could not look. `checkFresh`
     * stands aside while a compile or a rebuild is out, which is right — but
     * the watcher had already moved past that revision, so nothing asked
     * again: the compile landed printing the store as it was before, and the
     * card went on showing it.
     */
    await setUp();
    const heldCompile = await inPage(async () => {
      // A box ticked: its compile reads the store, then takes its time.
      const back = jh.s.hold('render');
      jh.root.querySelectorAll('.pick input')[0].click();
      await wait(30);
      // ResumeM-M changes while it is out, and the watcher sees it.
      jh.s.edit();
      await jh.handle.storeChanged();
      back();
      await until(() => !jh.s.holds.render && renders().length >= 2);
      await wait(300);
      return { compiles: renders().length, said: note() };
    });
    check(
      'a change that arrived during a compile is not lost when the compile ends',
      heldCompile.compiles >= 3 && /Updated from ResumeM-M/.test(heldCompile.said),
      JSON.stringify(heldCompile),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log('\nStaging and filing while a recompile is going');
  {
    await setUp();
    const filing = await inPage(async () => {
      const back = jh.s.hold('render');
      const before = renders().length;
      jh.s.edit();
      const watching = jh.handle.storeChanged();
      await until(() => renders().length > before);
      const whileCompiling = button(/Mark as applied/)?.disabled ?? null;
      back();
      await watching;
      await until(() => jh.s.folder.length >= 2, 5000);
      await wait(50);
      return {
        whileCompiling,
        folder: jh.s.folder.map((f) => `${f.as}:${f.printed}`),
        version: jh.s.version,
      };
    });
    check('Mark as applied waits for a recompile the store started', filing.whileCompiling === true, JSON.stringify(filing));
    check('and the folder is built again from the store as it now is', filing.folder.at(-1) === `stage:p${filing.version}`, JSON.stringify(filing));

    await setUp();
    const overlap = await inPage(async () => {
      // A stage under way — built from the store as it was — when it changes.
      const stageBack = jh.s.hold('stage');
      jh.root.querySelectorAll('.pick input')[0].click();
      await until(() => jh.s.sent.filter((c) => c.action === 'stage').length >= 2, 4000);
      jh.s.edit();
      await jh.handle.storeChanged();
      await wait(50);
      stageBack();
      await until(() => jh.s.folder.length >= 3, 5000);
      await wait(1500);
      return { folder: jh.s.folder.map((f) => `${f.as}:${f.printed}`), version: jh.s.version, said: note() };
    });
    check('a stage that was under way when the store moved is followed by one that has the change', overlap.folder.at(-1) === `stage:p${overlap.version}`, JSON.stringify(overlap));

    /*
     * And Attach files pressed in that stretch. The card has said "Updated
     * from ResumeM-M" and the preview is being compiled with the change —
     * and the folder Attach takes from is not rebuilt until the compile
     * ends and the stage after it has run. Pressed then, the form got the
     * file from before the change.
     */
    await setUp();
    const attach = await inPage(async () => {
      const back = jh.s.hold('render');
      const before = renders().length;
      jh.s.edit();
      const watching = jh.handle.storeChanged();
      await until(() => renders().length > before);
      button(/^Attach files$/).click();
      await wait(100);
      back();
      await watching;
      await until(() => jh.s.sent.some((c) => c.action === 'attachFiles'), 5000);
      await wait(1500);
      return {
        version: jh.s.version,
        folderThen: jh.s.attached,
        folderNow: jh.s.folder.at(-1)?.printed ?? null,
        stages: jh.s.sent.filter((c) => c.action === 'stage').length,
      };
    });
    check(
      'Attach files pressed while the store\'s change is being built attaches the file with the change in it',
      attach.folderThen === `p${attach.version}`,
      JSON.stringify(attach),
    );
    check('and the folder is not built twice over for it', attach.stages === 2 && attach.folderNow === `p${attach.version}`, JSON.stringify(attach));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe card\'s own writes, coming back through the watcher');
  {
    await setUp();
    const own = await inPage(async () => {
      // Staging after a tick, held where the store has the copy but the card
      // has not heard back — the build is the slow part.
      const stageBack = jh.s.hold('stage');
      jh.root.querySelectorAll('.pick input')[0].click();
      await until(() => jh.s.sent.filter((c) => c.action === 'stage').length >= 2, 4000);
      await wait(30);
      // The watcher sees its own write, with nothing else changed.
      await jh.handle.storeChanged();
      await wait(50);
      const plain = note();
      // And the other box, ticked while the same stage is still out.
      jh.root.querySelectorAll('.pick input')[1].click();
      await until(() => !jh.s.holds.render);
      await wait(50);
      await jh.handle.storeChanged();
      await wait(50);
      const said = note();
      const ticksNow = ticks();
      stageBack();
      await wait(1600);
      return { plain, said, ticksNow, ticksAfter: ticks(), lastRender: renders().at(-1)?.payload?.spec?.choices ?? null };
    });
    check('the card\'s own staging is not reported as an update from ResumeM-M', !/Updated from ResumeM-M/.test(own.plain), own.plain);
    check(
      'nor when a box was ticked while it was out',
      !/Updated from ResumeM-M/.test(own.said),
      own.said,
    );
    check(
      'and that tick is kept',
      JSON.stringify(own.ticksNow) === '[true,true]' && JSON.stringify(own.ticksAfter) === '[true,true]',
      JSON.stringify(own),
    );

    await setUp();
    const filed = await inPage(async () => {
      const back = jh.s.hold('bundle');
      button(/Mark as applied/).click();
      await wait(30);
      await jh.handle.storeChanged();
      await wait(50);
      back();
      await wait(100);
      await jh.handle.storeChanged();
      await wait(50);
      return { said: note(), renders: renders().length };
    });
    check('nor is filing it as applied', !/Updated from ResumeM-M/.test(filed.said) && filed.renders === 1, JSON.stringify(filed));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nThe resume in the picker, deleted in ResumeM-M');
  {
    await setUp();
    const gone = await inPage(async () => {
      jh.s.resumes = [{ id: 'kept', label: 'Systems resume', tier: 'base' }, { id: 'other', label: 'Data resume', tier: 'base' }];
      await jh.handle.storeChanged();
      await wait(50);
      const select = jh.root.querySelector('select[title="Which resume to start from"]');
      const shown = select.options[select.selectedIndex];
      return {
        shown: shown ? { value: shown.value, text: shown.textContent } : null,
        offered: [...select.options].map((o) => o.value),
      };
    });
    /*
     * The first option is what a `<select>` shows when none is selected — so
     * with the base gone from the list, the picker said the card had started
     * from whichever resume sorted first. And since that one read as chosen
     * already, choosing it did nothing: no `change`, no switch.
     */
    check(
      'the picker does not claim the card started from a different resume',
      gone.shown?.value === 'base' && /deleted/i.test(gone.shown?.text ?? ''),
      JSON.stringify(gone),
    );
    check(
      'and still offers every resume the store has, so any of them can be chosen',
      ['kept', 'other'].every((id) => gone.offered.includes(id)),
      JSON.stringify(gone),
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
