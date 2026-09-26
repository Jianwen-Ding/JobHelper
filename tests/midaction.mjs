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
      window.pressed = jh.root.querySelector('.file.liftable');
    });
    const chip = page.locator('#jobhelper-card-host .file.liftable').first();
    await chip.scrollIntoViewIfNeeded();
    const from = await chip.boundingBox();
    await page.mouse.move(from.x + 20, from.y + from.height / 2);
    await page.mouse.down();
    /*
     * Redrawn between the press and the drag, and again with the drag under
     * way — by store changes that leave the file as it is, a resume saved
     * there and then another. One that changes what the resume prints puts
     * the folder behind, and a drag started then is refused; see below.
     */
    await inPage(async () => {
      jh.s.resumes = [...jh.s.resumes, { id: 'added', label: 'Added resume', tier: 'extended' }];
      await jh.handle.storeChanged();
    });
    await page.mouse.move(from.x + 40, from.y + from.height / 2 + 10, { steps: 4 });
    await inPage(async () => {
      jh.s.resumes = [...jh.s.resumes, { id: 'added-2', label: 'Added again', tier: 'extended' }];
      await jh.handle.storeChanged();
    });
    await page.mouse.move(150, 140, { steps: 12 });
    const midway = await inPage(() => jh.s.sent.filter((c) => c.action === 'dragging').map((c) => c.payload.files.length));
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await inPage(() => ({
      drops: window.drops,
      told: jh.s.sent.filter((c) => c.action === 'dragging').map((c) => c.payload.files.length),
      redrew: !window.pressed.isConnected,
    }));
    check('the drag still lands where it was let go', after.drops === 1 && after.redrew, JSON.stringify(after));
    check('with the page told what is in the air all the way there', midway.length > 0 && midway.at(-1) > 0, JSON.stringify(midway));
    check('and told it is over when it is', after.told.at(-1) === 0, JSON.stringify(after.told));
  }

  /* ------------------------------------------------------------------ */
  console.log('\nA chip reached for while the folder is behind the store');
  {
    /*
     * The gap Attach files had, on the chips. A change in ResumeM-M is on
     * screen — "Updated from ResumeM-M" — while it is compiled, `prepareSoon`
     * waits, and the stage runs: seconds. The chips hold the folder's bytes
     * from before, fetched ahead because a drag cannot wait for them, so a
     * chip picked up then handed the page the file without the change.
     */
    await setUp();
    const behind = await inPage(async () => {
      await until(() => jh.s.sent.some((c) => c.action === 'attachmentFiles'));
      await wait(50);
      const start = jh.s.sent.length;
      /** Which builds the page has been handed as in the air, since `start`. */
      const handed = () =>
        jh.s.sent.slice(start).filter((c) => c.action === 'dragging').flatMap((c) => c.payload.files.map((f) => f.printed));
      const chip = () => jh.root.querySelector('.file.liftable:not(.all)');
      /** Reached for and picked up, the way a pointer does it. */
      const pickUp = () => {
        const it = chip();
        it.dispatchEvent(new PointerEvent('pointerenter'));
        it.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const drag = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
        it.dispatchEvent(drag);
        const out = {
          refused: drag.defaultPrevented,
          marked: it.classList.contains('warming'),
          said: jh.root.querySelector('.drag-note')?.textContent ?? '',
        };
        it.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        it.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return out;
      };

      const renderBack = jh.s.hold('render');
      const stageBack = jh.s.hold('stage');
      const before = jh.s.sent.filter((c) => c.action === 'render').length;
      jh.s.edit();
      const watching = jh.handle.storeChanged();
      await until(() => jh.s.sent.filter((c) => c.action === 'render').length > before);
      await wait(20);
      // While the change is being compiled.
      const compiling = pickUp();
      renderBack();
      await watching;
      await until(() => jh.s.sent.filter((c) => c.action === 'stage').length >= 2, 4000);
      await wait(20);
      // While the folder is being built again with it.
      const staging = pickUp();
      stageBack();
      await until(() => jh.s.folder.length >= 2 && chip() && !chip().classList.contains('warming'), 5000);
      await wait(50);
      // And once it has been.
      const caughtUp = pickUp();
      return {
        version: jh.s.version,
        compiling,
        staging,
        caughtUp,
        handed: handed(),
        folder: jh.s.folder.map((f) => f.printed),
        stages: jh.s.sent.filter((c) => c.action === 'stage').length,
      };
    });
    const now = `p${behind.version}`;
    check(
      'a chip picked up while the change is being built never hands the page the file from before it',
      behind.handed.every((p) => p === now),
      JSON.stringify(behind),
    );
    check(
      'it is refused, marked as updating, and says so',
      [behind.compiling, behind.staging].every((t) => t.refused && t.marked && /try that drag again/i.test(t.said)),
      JSON.stringify(behind),
    );
    check(
      'and once the folder has the change, it carries it',
      !behind.caughtUp.refused && !behind.caughtUp.marked && behind.handed.at(-1) === now && behind.folder.at(-1) === now,
      JSON.stringify(behind),
    );
    check('with the folder built once for the change, not once per refused drag', behind.stages === 2, JSON.stringify(behind));
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

    /*
     * And "Build it again from there", already showing when that resume goes.
     * It was offered because the base had changed since the copy was made;
     * deleted, there is nothing there to build from, and the store says
     * nothing more about it — so nothing took the offer down.
     */
    await setUp();
    const offer = await inPage(async () => {
      const shown = () => ({
        offered: Boolean(button(/Build it again from there/)),
        said: jh.root.querySelector('.hint.stale')?.textContent ?? '',
      });
      jh.s.base = { id: 'base', label: 'New grad resume', changed: true };
      await jh.handle.storeChanged();
      await wait(50);
      const changed = shown();
      // Deleted in ResumeM-M: gone from the list, and nothing to say about it.
      jh.s.resumes = [{ id: 'kept', label: 'Systems resume', tier: 'base' }];
      jh.s.base = null;
      await jh.handle.storeChanged();
      await wait(50);
      return { changed, deleted: shown() };
    });
    check('a base changed in ResumeM-M is offered to build again from', offer.changed.offered, JSON.stringify(offer));
    check(
      'and once it is deleted there, the offer goes, and the card says it was deleted',
      !offer.deleted.offered && /deleted/i.test(offer.deleted.said) && /New grad resume/.test(offer.deleted.said),
      JSON.stringify(offer),
    );
  }

  /* ------------------------------------------------------------------ */
  console.log('\nChips that must not stay greyed');
  {
    /*
     * Reported: the files to drag "get greyed out", and hovering one "just
     * shows a circle spinning". A chip is drawn faded with a busy cursor while
     * its bytes are being fetched or the folder is behind the screen, and it
     * has to come back — or say why it cannot — whatever the reason was.
     */
    const settle = async (ms = 6000) =>
      inPage(async (ms) => {
        const chips = () => [...jh.root.querySelectorAll('.file.liftable:not(.missing)')];
        await until(() => chips().length > 0 && chips().every((c) => !c.classList.contains('warming')), ms);
        return {
          chips: chips().length,
          grey: chips().filter((c) => c.classList.contains('warming')).length,
          said: [jh.root.querySelector('.drag-note')?.textContent ?? '', jh.root.querySelector('.error, .err')?.textContent ?? ''].join(' | '),
          stages: jh.s.sent.filter((c) => c.action === 'stage').length,
        };
      }, ms);

    // 1. The bank rewords an answer shown for a question, after the build.
    await setUp({ questions: [{ question: 'Why Acme?', answer: 'From the bank.', confident: true, fieldId: 'q1' }] });
    await settle();
    await inPage(async () => {
      jh.handle.setMatches([{ question: 'Why Acme?', answer: 'Reworded in ResumeM-M.', confident: true }]);
      await wait(50);
    });
    const reworded = await settle();
    check(
      'an answer the bank rewords after the build is staged, and the chips come back',
      reworded.grey === 0 && reworded.stages >= 2,
      JSON.stringify(reworded),
    );

    // 2. A restage that comes back with nothing.
    await setUp({ letter: true });
    await settle();
    const empty = await inPage(async () => {
      jh.s.fail.stage = 'null';
      const box = jh.root.querySelector('textarea[data-field="letter"]');
      box.value = 'Dear Acme,';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(50);
      return true;
    });
    void empty;
    // The empty one, and the retry after it.
    await inPage(async () => until(() => jh.s.sent.filter((c) => c.action === 'stage').length >= 3, 12000));
    const afterEmpty = await settle(8000);
    check(
      'a restage that comes back empty is tried again, and the chips come back',
      afterEmpty.grey === 0 && afterEmpty.stages >= 3,
      JSON.stringify(afterEmpty),
    );

    // 3. The files fetch failing once.
    await setUp({ built: false });
    await inPage(async () => {
      jh.s.fail.attachmentFiles = 'throw';
      button(/Build resume/).click();
      await until(() => jh.s.folder.length > 0);
      await wait(100);
      // Anything that redraws the card afterwards.
      jh.s.resumes = [...jh.s.resumes, { id: 'added', label: 'Added resume', tier: 'extended' }];
      await jh.handle.storeChanged();
    });
    const afterFetch = await settle();
    check('a files fetch that failed once is asked again, and the chips come back', afterFetch.grey === 0 && afterFetch.chips > 0, JSON.stringify(afterFetch));

    // 4. A restage that never answers: say so, rather than a spinner with no words.
    await setUp({ letter: true });
    await settle();
    const hung = await inPage(async () => {
      window.stageBack = jh.s.hold('stage');
      const box = jh.root.querySelector('textarea[data-field="letter"]');
      box.value = 'Dear Acme, a letter';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => jh.s.sent.filter((c) => c.action === 'stage').length >= 2, 4000);
      await wait(100);
      const chip = jh.root.querySelector('.file.liftable:not(.all):not(.missing)');
      return {
        grey: chip?.classList.contains('warming') ?? null,
        title: chip?.title ?? '',
        note: jh.root.querySelector('.drag-note')?.textContent ?? '',
      };
    });
    check(
      'while the files are being rebuilt, the panel says so in words, not only with a spinner',
      hung.grey === true && /up to date|rebuil/i.test(hung.note),
      JSON.stringify(hung),
    );
    await inPage(async () => window.stageBack());
    const released = await settle();
    check('and once the rebuild lands, the chips come back', released.grey === 0, JSON.stringify(released));
  }

  await browser.close();
  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
