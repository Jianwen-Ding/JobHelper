/**
 * The drop listener in content.js, and what it may take.
 *
 * A chip's drag cannot carry its file, so content.js takes the drop itself
 * while `inTheAir` says a chip is being dragged. But `inTheAir` is only the
 * card's word: left set by a drag whose end never arrived, it cancelled the
 * person's own drag of a real file from the desktop and put the card's file
 * in its place. A chip's drag never carries `Files` (tests/probe-drag-drop.mjs)
 * and a desktop drag always does, so the listener has to look at the drag.
 *
 * Driven in an embedded application frame, where the worker arms the drop
 * with `jh-frame-dragging` exactly as it does for a real chip drag. No
 * ResumeM-M server is needed.
 *
 *   node tests/dropping.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveFixtures, findChromium, extensionWorker } from './fixtures.mjs';
import { EMBEDDED_APPLY, FRAME_DOCUMENTS } from './ats-web.mjs';
import { easyApply, AIM } from './linkedin-easy-apply.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const OURS = { name: 'Morgan-Testwell-Resume.pdf', base64: btoa('%PDF-1.4 ours'), type: 'application/pdf' };

/*
 * LinkedIn's Easy Apply resume step, with LinkedIn's own drag handling, in a
 * frame under a page holding a chip-shaped drag source: what a real pointer
 * does there is the question, so a real pointer does it. In a frame because
 * a frame's drop is armed through the worker, which needs no card and no
 * server; the listener that takes the drop is the same one the top document
 * runs. The step carries its contact section so the frame passes the
 * application-form guard a frame has to pass. See tests/linkedin-easy-apply.mjs.
 */
/*
 * And the variants the user's own page turned out to need: the step in a
 * closed shadow root, and — what the page actually had — no file input at all
 * until "Upload resume" is pressed, the input made then and clicked detached,
 * or put in, clicked and taken out. See tests/linkedin-easy-apply.mjs.
 */
const LI_OPTIONS = {
  plain: {},
  shadow: { shadow: true },
  closed: { closed: true },
  detached: { shadow: true, picker: 'detached' },
  transient: { shadow: true, picker: 'transient' },
};
const LINKEDIN = Object.keys(LI_OPTIONS).flatMap((v) => [
  {
    name: `linkedin-top-${v}`,
    path: `/li/top-${v}`,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Easy Apply</title></head>
<body style="margin:0;display:flex">
  <iframe src="/li/frame-${v}" title="Easy Apply" style="width:1000px;height:880px;border:0"></iframe>
  <div id="chip" draggable="true" style="margin:40px 10px;padding:8px 12px;background:#eef;border-radius:12px;height:20px">Morgan-Testwell-Resume.pdf</div>
  <script>
    // What the card's chip does at dragstart: a copy, and its name as text.
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', 'Morgan-Testwell-Resume.pdf');
    });
  </script>
</body></html>`,
  },
  {
    name: `linkedin-frame-${v}`,
    path: `/li/frame-${v}`,
    html: easyApply({ ...LI_OPTIONS[v], guard: true, contact: true }),
  },
]);

async function main() {
  const fixtures = await serveFixtures([EMBEDDED_APPLY, ...FRAME_DOCUMENTS, ...LINKEDIN]);
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-dropping-')), {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = await extensionWorker(context);
    // Nowhere to reach: the frame's drop listener needs no server.
    await worker.evaluate(() => chrome.storage.sync.set({ serverUrl: 'http://127.0.0.1:9', autoPrompt: false }));
    const page = await context.newPage();
    const url = fixtures.urlFor(EMBEDDED_APPLY);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const frameEl = await page.waitForSelector('iframe');
    const frame = await frameEl.contentFrame();
    await frame.waitForSelector('input[type=file]', { state: 'attached' });

    /** Arm the frame's drop, as the worker does when a chip is picked up. */
    const arm = async (files, url = fixtures.urlFor(EMBEDDED_APPLY)) => {
      for (let i = 0; i < 50; i++) {
        const answer = await worker.evaluate(
          async ([u, files]) => {
            const [tab] = await chrome.tabs.query({ url: u });
            if (!tab) return null;
            try {
              return await chrome.tabs.sendMessage(tab.id, { type: 'jh-frame-dragging', payload: { files } });
            } catch {
              return null;
            }
          },
          [url, files],
        );
        if (answer?.data?.watching === true) return true;
        await page.waitForTimeout(200);
      }
      return false;
    };

    /**
     * A drop on the upload box's label, carrying either a real file (a
     * desktop drag) or only text (a chip's drag, as Chromium delivers it).
     */
    const dropOnBox = (withFile) =>
      frame.evaluate(async (withFile) => {
        const box = document.querySelector('input[type=file]');
        const at = (box.id && document.querySelector(`label[for="${box.id}"]`)) || box;
        box.value = '';
        let pageSaw = null;
        const own = (e) => {
          pageSaw = { types: [...e.dataTransfer.types], files: [...e.dataTransfer.files].map((f) => f.name) };
        };
        document.addEventListener('drop', own);
        const carrier = new DataTransfer();
        if (withFile) carrier.items.add(new File(['%PDF-1.4 desk'], 'From-The-Desktop.pdf', { type: 'application/pdf' }));
        else carrier.setData('text/plain', 'Morgan-Testwell-Resume.pdf');
        const over = new DragEvent('dragover', { bubbles: true, cancelable: true, composed: true, dataTransfer: carrier });
        at.dispatchEvent(over);
        const drop = new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: carrier });
        at.dispatchEvent(drop);
        // `dropOnto` is loaded on demand; give it its turn.
        await new Promise((r) => setTimeout(r, 800));
        document.removeEventListener('drop', own);
        return {
          overCancelled: over.defaultPrevented,
          dropCancelled: drop.defaultPrevented,
          pageSaw,
          held: [...(box.files ?? [])].map((f) => f.name),
        };
      }, withFile);

    group('A chip let go of over the box: the drop is taken, as before');
    {
      check('the frame is armed', await arm([OURS]));
      const r = await dropOnBox(false);
      check('the drop is taken from the page', r.dropCancelled && r.pageSaw === null, JSON.stringify(r));
      check('and the chip\'s file goes in', r.held[0] === OURS.name, JSON.stringify(r.held));
    }

    group('A real file dragged in from the desktop while a stale chip drag is armed');
    {
      check('the frame is armed', await arm([OURS]));
      const r = await dropOnBox(true);
      check('the page gets its own drop', r.pageSaw?.files?.[0] === 'From-The-Desktop.pdf', JSON.stringify(r));
      check('neither dragover nor drop is cancelled by us', !r.overCancelled && !r.dropCancelled, JSON.stringify(r));
      check('and the chip\'s file is not put in instead', !r.held.includes(OURS.name), JSON.stringify(r.held));

      // And the stale arm is let go of: a plain drop afterwards is the page's.
      const after = await dropOnBox(false);
      check('the stale arm is cleared', !after.dropCancelled && !after.held.includes(OURS.name), JSON.stringify(after));
    }

    /*
     * LinkedIn's Easy Apply, at the resume step, with a real pointer.
     *
     * Reported as "doesn't really work", and it did not, for two reasons
     * stacked. LinkedIn refuses a drop anywhere but on its upload control
     * (`dropEffect = 'none'` from a `dragover` of its own, after ours), so
     * the browser never delivered the drop at all; and where it did arrive,
     * the list of earlier resumes read as fields and as drop areas, so the
     * file went nowhere or to a card with no drop handler. Let go of over the
     * Upload button, a previous resume's card, the section's empty space and
     * the footer — in the page, and with the modal in a shadow root.
     */
    for (const variant of ['plain', 'shadow']) {
      group(`LinkedIn Easy Apply (${variant}): a chip let go of over the resume step`);
      const top = await context.newPage();
      await top.setViewportSize({ width: 1240, height: 900 });
      const topUrl = fixtures.urlFor(LINKEDIN.find((f) => f.path === `/li/top-${variant}`));
      await top.goto(topUrl, { waitUntil: 'domcontentloaded' });
      const liFrame = await (await top.waitForSelector('iframe')).contentFrame();
      await liFrame.waitForFunction(() => Boolean(window.$ea?.('input[type=file]')));

      const letGoOver = async (aim) => {
        // A fresh step each time, so one drop's upload cannot answer for the next.
        await liFrame.goto(liFrame.url(), { waitUntil: 'load' });
        await liFrame.waitForFunction(() => Boolean(window.$ea?.('input[type=file]')));
        const armed = await arm([OURS], topUrl);
        const frameAt = await (await top.$('iframe')).boundingBox();
        const to = await liFrame.evaluate((sel) => {
          const r = window.$ea(sel).getBoundingClientRect();
          return { x: r.x + Math.min(r.width / 2, 40), y: r.y + Math.min(r.height / 2, 12) };
        }, AIM[aim]);
        const from = await top.locator('#chip').boundingBox();
        await top.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await top.mouse.down();
        const end = { x: frameAt.x + to.x, y: frameAt.y + to.y };
        for (let i = 1; i <= 14; i++) {
          await top.mouse.move(from.x + ((end.x - from.x) * i) / 14, from.y + ((end.y - from.y) * i) / 14);
          await top.waitForTimeout(25);
        }
        await top.mouse.up();
        // Long enough for `dropOnto`, LinkedIn's "upload" and its new card.
        await top.waitForTimeout(1200);
        return {
          armed,
          ...(await liFrame.evaluate(() => ({
            held: [...(window.$ea('#jobs-document-upload-file-input-upload-resume').files ?? [])].map((f) => f.name),
            uploads: window.linkedin.uploads.map((u) => u.name),
            selected: window.$ea('[data-list="resume"] [aria-checked="true"] .jobs-document-upload-redesign-card__file-name')?.textContent ?? null,
            complaint: window.$ea('.jobs-document-upload__error')?.textContent ?? null,
          }))),
        };
      };

      for (const [aim, words] of [
        ['button', 'the Upload resume button'],
        ['card', 'a resume uploaded before'],
        ['circle', 'the round selector of a resume uploaded before'],
        ['section', 'the empty space in the Resume section'],
      ]) {
        const r = await letGoOver(aim);
        check(`${words}: the resume goes into the resume box`, r.armed && r.held[0] === OURS.name, JSON.stringify(r));
        check(`${words}: and LinkedIn takes it and selects it`, r.uploads[0] === OURS.name && r.selected === OURS.name, JSON.stringify(r));
        check(`${words}: with no complaint from LinkedIn's own drop handler`, r.complaint === null, String(r.complaint));
      }
      {
        const r = await letGoOver('footer');
        check('the footer under Back and Next: nothing goes in', r.armed && r.held.length === 0 && r.uploads.length === 0, JSON.stringify(r));
      }
      await top.close();
    }

    /*
     * The same step as the user's own page has it, and in a closed root.
     *
     * Reported from a real LinkedIn job: the resume chip let go of on Upload
     * resume said "Nothing was attached. Jianwen-Ding-Resume.pdf had nowhere
     * to go — there is no upload box where you dropped it", and Attach files
     * failed too. A console probe found no file input anywhere — the button
     * makes one when pressed. Driven here with the extension loaded, so the
     * answer comes through the real picker.js in the page's world: a real
     * pointer drags the chip onto the button, then Attach files is asked of
     * the frame exactly as the worker asks it, then the person presses the
     * button themselves and must get the browser's own dialog.
     */
    await worker.evaluate(() => {
      self.__dropReports = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m?.type === 'droppedInFrame') self.__dropReports.push(m.payload?.report ?? null);
      });
    });
    for (const variant of ['closed', 'detached', 'transient']) {
      group(`LinkedIn Easy Apply (${variant}): the resume chip let go of on Upload resume, then Attach files`);
      const top = await context.newPage();
      await top.setViewportSize({ width: 1240, height: 900 });
      let choosers = 0;
      top.on('filechooser', () => {
        choosers += 1;
      });
      const topUrl = fixtures.urlFor(LINKEDIN.find((f) => f.path === `/li/top-${variant}`));
      await top.goto(topUrl, { waitUntil: 'domcontentloaded' });
      const liFrame = await (await top.waitForSelector('iframe')).contentFrame();
      const ready = () => liFrame.waitForFunction(() => Boolean(window.$ea?.('[data-upload="resume"]')));
      await ready();
      const readPage = () =>
        liFrame.evaluate(() => ({
          uploads: window.linkedin.uploads.map((u) => u.name),
          made: window.linkedin.made,
          selected: window.$ea('[data-list="resume"] [aria-checked="true"] .jobs-document-upload-redesign-card__file-name')?.textContent ?? null,
          complaint: window.$ea('.jobs-document-upload__error')?.textContent ?? null,
        }));
      const buttonAt = async () => {
        const frameAt = await (await top.$('iframe')).boundingBox();
        const r = await liFrame.evaluate((sel) => {
          // In view: a new card at the top of the list pushes the button down the modal's scroll.
          window.$ea(sel).scrollIntoView({ block: 'center' });
          const b = window.$ea(sel).getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }, AIM.button);
        return { x: frameAt.x + r.x, y: frameAt.y + r.y };
      };

      // The drag, with a real pointer.
      await worker.evaluate(() => {
        self.__dropReports = [];
      });
      const armed = await arm([OURS], topUrl);
      const from = await top.locator('#chip').boundingBox();
      const end = await buttonAt();
      await top.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await top.mouse.down();
      for (let i = 1; i <= 14; i++) {
        await top.mouse.move(from.x + ((end.x - from.x) * i) / 14, from.y + ((end.y - from.y) * i) / 14);
        await top.waitForTimeout(25);
      }
      await top.mouse.up();
      let report = null;
      for (let i = 0; i < 60 && !report; i++) {
        await top.waitForTimeout(100);
        report = await worker.evaluate(() => self.__dropReports[0] ?? null);
      }
      await top.waitForTimeout(400);
      const dropped = await readPage();
      check('the frame is armed', armed);
      check('the drop: LinkedIn’s change handler gets the resume and selects it', dropped.uploads.join() === OURS.name && dropped.selected === OURS.name, JSON.stringify(dropped));
      check(
        'the drop: the card is told it was attached',
        report?.placed?.length === 1 && report.placed[0].name === OURS.name && report.placed[0].sure !== false && (report.unplaced ?? []).length === 0,
        JSON.stringify(report),
      );
      check('the drop: no complaint from LinkedIn', dropped.complaint === null, String(dropped.complaint));

      // Attach files, as the worker asks a frame for it.
      await liFrame.goto(liFrame.url(), { waitUntil: 'load' });
      await ready();
      const attached = await worker.evaluate(async ([u, files]) => {
        const [tab] = await chrome.tabs.query({ url: u });
        const key = `frames:${tab.id}`;
        const ids = (await (chrome.storage.session ?? chrome.storage.local).get(key))[key] ?? [];
        for (const frameId of ids) {
          try {
            const reply = await chrome.tabs.sendMessage(tab.id, { type: 'jh-frame-attach', payload: { files } }, { frameId });
            if (reply?.data?.placed?.length || reply?.data?.unplaced?.length) return reply.data;
          } catch {
            // A frame that has gone.
          }
        }
        return null;
      }, [topUrl, [OURS]]);
      await top.waitForTimeout(400);
      const pressed = await readPage();
      check('Attach files: LinkedIn’s change handler gets the resume and selects it', pressed.uploads.join() === OURS.name && pressed.selected === OURS.name, JSON.stringify(pressed));
      check(
        'Attach files: reported as attached',
        attached?.placed?.length === 1 && attached.placed[0].sure !== false && (attached.unplaced ?? []).length === 0,
        JSON.stringify(attached),
      );

      // And the person's own press afterwards: the browser's dialog, nothing of ours.
      const was = choosers;
      const at = await buttonAt();
      await top.mouse.click(at.x, at.y);
      for (let i = 0; i < 30 && choosers === was; i++) await top.waitForTimeout(100);
      await top.waitForTimeout(400);
      const after = await readPage();
      check(
        'a press of the person’s own afterwards opens the real dialog, and nothing goes in',
        choosers > was && after.uploads.length === pressed.uploads.length,
        JSON.stringify({ opened: choosers > was, after }),
      );
      await top.close();
    }
  } finally {
    await context.close();
    fixtures.close?.();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
