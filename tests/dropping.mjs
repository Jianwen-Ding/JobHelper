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

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const OURS = { name: 'Morgan-Testwell-Resume.pdf', base64: btoa('%PDF-1.4 ours'), type: 'application/pdf' };

async function main() {
  const fixtures = await serveFixtures([EMBEDDED_APPLY, ...FRAME_DOCUMENTS]);
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
    const arm = async (files) => {
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
