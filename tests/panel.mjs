/**
 * The resume editor beside the page: the side panel, driven for real.
 *
 * The panel is opened the way a person opens it — "Open beside" on the card —
 * and then driven through a second connection to the same browser, because a
 * side panel is not one of Playwright's pages but is a page target on the
 * DevTools protocol. The same panel page is also opened as a window of its
 * own (`?window=` / `?tab=`) to see it at other widths, which a side panel's
 * width cannot be set to from here.
 *
 * Requires a ResumeM-M server with a save open; RMM_SERVER says where. Two
 * more ports are used: RMM_OTHER_PORT (default 4931) for a second server
 * started here over a copy of the save, to be the "different save", and
 * RMM_DEAD_PORT (default 4939), which must have nothing listening.
 *
 *   RMM_SERVER=http://127.0.0.1:4930 node tests/panel.mjs
 *
 * The second server's copy of the save goes under JH_TMP (the system's temp
 * folder by default) and is removed afterwards.
 *
 * JH_SHOTS=<dir> takes a screenshot of every state at 320, 400, 500 and 1000
 * pixels wide into that directory. Nothing is written without it.
 */

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOG,
  HARBOUR_ROLE,
  MARIGOLD_ROLE,
  cleanStore,
  extensionWorker,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const OTHER_PORT = Number(process.env.RMM_OTHER_PORT ?? 4931);
const DEAD = `http://127.0.0.1:${process.env.RMM_DEAD_PORT ?? 4939}`;
const SHOTS = process.env.JH_SHOTS ?? null;
const WIDTHS = [320, 400, 500, 1000];
const MINE = [HARBOUR_ROLE.company, MARIGOLD_ROLE.company];

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail = '') {
  ok ? passed++ : failed++;
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const group = (name) => console.log(`\n${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` answers truthy, or give up and answer what it last said. */
async function until(fn, { timeout = 15_000, every = 250 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch {
      last = undefined;
    }
    if (last || Date.now() > end) return last;
    await sleep(every);
  }
}

const getJson = async (url, init) => (await fetch(url, init)).json();

async function main() {
  const health = await requireOpenSave(SERVER);
  await cleanStore(SERVER, MINE);
  const fixtures = await serveFixtures([HARBOUR_ROLE, MARIGOLD_ROLE, BLOG]);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-panel-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [
      '--no-sandbox',
      '--remote-debugging-port=0',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });

  /** Console errors and page errors, from every page and frame here. */
  const errors = [];
  const watch = (page, name) => {
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // Expected in the states under test: a server that is down, and the
      // frame an http page is refused.
      if (/ERR_CONNECTION_REFUSED|Refused to frame|Failed to load resource/.test(text)) return;
      errors.push(`${name}: ${text}`);
    });
  };

  let other = null;
  let otherDir = null;
  let cdp = null;
  const restoreEntries = [];

  try {
    const worker = await extensionWorker(context);
    await pointExtensionAt(context, worker, SERVER);
    const extId = new URL(worker.url()).host;
    const panelUrl = `chrome-extension://${extId}/src/panel/panel.html`;
    const setServer = (url) => worker.evaluate((u) => chrome.storage.sync.set({ serverUrl: u }), url);

    /* ---------------- Framing ---------------- */

    group('Who may frame the editor');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(BLOG));
      await page.evaluate((src) => {
        const f = document.createElement('iframe');
        f.src = `${src}/#resumes/newgrad`;
        f.width = 400;
        f.height = 300;
        document.body.append(f);
      }, SERVER);
      await sleep(2500);
      const child = page.frames().find((f) => f !== page.mainFrame());
      const where = await child?.evaluate(() => location.href).catch(() => 'unreachable');
      check(
        'an ordinary http page is refused the editor in a frame',
        Boolean(child) && !String(where).startsWith(SERVER),
        String(where),
      );
      await page.close();
    }

    /* ---------------- Opening it from the card ---------------- */

    group('Opening it from the card');
    const harbour = await context.newPage();
    watch(harbour, 'harbour');
    await harbour.goto(fixtures.urlFor(HARBOUR_ROLE), { waitUntil: 'domcontentloaded' });
    const cardReady = (page) =>
      page.waitForFunction(
        () => {
          const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return root?.querySelector('.card') && !root.querySelector('.card.loading') && root.querySelector('.to-panel');
        },
        null,
        { timeout: 40_000 },
      );
    await cardReady(harbour);
    const harbourTab = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0], fixtures.urlFor(HARBOUR_ROLE));
    const windowId = harbourTab.windowId;

    const card = harbour.locator('#jobhelper-card-host .card');
    const beside = card.locator('.to-panel');
    const builderLink = card.locator('.to-builder');
    check('the card offers "Open beside"', (await beside.count()) === 1);
    check(
      'on the same line as "Edit in ResumeM-M", so the card grows by nothing',
      (await beside.evaluate((b) => b.parentElement === b.closest('.card').querySelector('.to-builder')?.parentElement)) &&
        Math.abs((await beside.boundingBox()).y - (await builderLink.boundingBox()).y) < 4,
    );

    const target = await until(() =>
      worker.evaluate((id) => chrome.storage.session.get(`jh-panel:${id}`).then((r) => r[`jh-panel:${id}`]), harbourTab.id),
    );
    check('the card has told the panel which resume it is working with', Boolean(target?.baseId && target?.copyId), JSON.stringify(target ?? null));

    await beside.click();
    const port = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    // The side panel is the page with no query: the window it falls back to
    // when the panel will not open carries `?window=`.
    const side = await until(() => cdp.contexts().flatMap((c) => c.pages()).find((p) => p.url() === panelUrl), {
      timeout: 10_000,
    });
    check('pressing it opens the browser’s side panel', Boolean(side), side ? side.url() : 'no panel page');
    if (!side) throw new Error('No side panel to drive');
    watch(side, 'side panel');
    const sideShot = async (name) => {
      if (SHOTS) await side.screenshot({ path: path.join(SHOTS, `side-${name}.png`) });
    };

    const editorOf = (page) => page.frames().find((f) => f.url().startsWith(SERVER) || f.url().startsWith(`http://127.0.0.1:${OTHER_PORT}`));
    const onScreen = async (page) => {
      const f = editorOf(page);
      return f ? f.evaluate(() => (document.querySelector('#resume-select')?.value ?? null)).catch(() => null) : null;
    };
    const barLabel = (page) => page.locator('#label').textContent();
    const noteText = async (page) => ((await page.locator('#note').isVisible()) ? page.locator('#note').textContent() : '');

    const shown = await until(async () => (await onScreen(side)) === target.baseId);
    check(
      'before the copy is built it shows the resume the card starts from',
      Boolean(shown),
      `${await onScreen(side)} vs ${target.baseId}`,
    );
    check(
      'and says so, naming it',
      /not built yet/.test(await noteText(side)) && (await noteText(side)).includes(target.baseLabel ?? target.baseId),
      await noteText(side),
    );
    check('the bar names the resume on screen', (await barLabel(side)) === (target.baseLabel ?? target.baseId), await barLabel(side));
    await sideShot('base-before-copy');
    check(
      'the loading spinner is gone once the editor is up',
      !(await side.locator('#loading').isVisible()) && (await side.locator('#stage').isVisible()),
    );
    check(
      'the side panel frames the editor from the server, and it loads',
      Boolean(await editorOf(side)?.evaluate(() => Boolean(document.querySelector('#resume-select'))).catch(() => false)),
    );

    {
      const opened = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
      await builderLink.click();
      const tab = await opened;
      await tab?.waitForLoadState('domcontentloaded').catch(() => undefined);
      check('"Edit in ResumeM-M" still opens the editor in a tab', Boolean(tab?.url().startsWith(`${SERVER}/#resumes/`)), tab?.url());
      await tab?.close();
      await harbour.bringToFront();
    }

    /* ---------------- The copy, built on the card ---------------- */

    group('The copy, once the card builds it');
    await card.locator('button.primary', { hasText: /Build resume|Recompile/ }).first().click();
    const copyStored = await until(async () => (await getJson(`${SERVER}/api/resumes`)).some((r) => r.id === target.copyId), {
      timeout: 60_000,
    });
    check('building on the card puts the copy in the store', Boolean(copyStored));
    const onCopy = await until(async () => (await onScreen(side)) === target.copyId, { timeout: 15_000 });
    check('the panel moves onto the copy by itself', Boolean(onCopy), String(await onScreen(side)));
    check('and marks it as the one for this posting', (await side.locator('#kind').textContent()) === 'For this posting');
    await sideShot('copy');

    /* ---------------- An edit in the panel reaches the card ---------------- */

    group('An edit in the panel reaches the card');
    {
      const editor = editorOf(side);
      const before = (await getJson(`${SERVER}/api/resumes`)).find((r) => r.id === target.copyId);
      // Wait for the card to have compiled what it built, so there is a
      // preview to be brought up to date.
      await until(() => harbour.evaluate(() => /Recompile/.test(document.querySelector('#jobhelper-card-host').shadowRoot.textContent)), {
        timeout: 60_000,
      });
      const box = editor.locator('#editor .entry[data-drag-id] .bullet input[type=checkbox]').first();
      await box.click();
      const saved = await until(async () => {
        const now = (await getJson(`${SERVER}/api/resumes`)).find((r) => r.id === target.copyId);
        return JSON.stringify(now) !== JSON.stringify(before);
      });
      check('switching a line off in the panel saves the copy', Boolean(saved));
      const told = await until(
        () =>
          harbour.evaluate(() =>
            /Updated from ResumeM-M/.test(document.querySelector('#jobhelper-card-host').shadowRoot.textContent),
          ),
        { timeout: 30_000 },
      );
      check('the card takes the change without a reload, and says so', Boolean(told));
    }

    /* ---------------- Following the tab ---------------- */

    group('Following the tab');
    const newTab = async (url) => {
      const opened = context.waitForEvent('page');
      await worker.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId, active: true }), { url, windowId });
      return opened;
    };
    const marigold = await newTab(fixtures.urlFor(MARIGOLD_ROLE));
    watch(marigold, 'marigold');
    await cardReady(marigold);
    const marigoldTab = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0], fixtures.urlFor(MARIGOLD_ROLE));
    const marigoldTarget = await until(() =>
      worker.evaluate((id) => chrome.storage.session.get(`jh-panel:${id}`).then((r) => r[`jh-panel:${id}`]), marigoldTab.id),
    );
    const followed = await until(async () => (await onScreen(side)) === marigoldTarget?.baseId && /not built yet/.test(await noteText(side)));
    check('another posting in front: the panel shows that one’s resume', Boolean(followed), `${await onScreen(side)}`);
    await sideShot('other-posting');

    {
      // Another resume chosen on the card: the panel goes with it.
      const picker = marigold.locator('#jobhelper-card-host select[title="Which resume to start from"]');
      const other = (await picker.locator('option').evaluateAll((os) => os.map((o) => o.value))).find(
        (v) => v && v !== marigoldTarget.baseId,
      );
      await picker.selectOption(other);
      const switched = await until(async () => (await onScreen(side)) === other, { timeout: 30_000 });
      check('a different resume picked on the card shows in the panel', Boolean(switched), `${other} vs ${await onScreen(side)}`);
      marigoldTarget.baseId = other;
    }

    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), harbourTab.id);
    const back = await until(async () => (await onScreen(side)) === target.copyId);
    check('and back again: the copy it was on before', Boolean(back), `${await onScreen(side)}`);

    /* ---------------- Nothing lost to a tab switch ---------------- */

    group('Nothing typed is lost to a tab switch');
    {
      const editor = editorOf(side);
      const store = await getJson(`${SERVER}/api/store`);
      const resume = (await getJson(`${SERVER}/api/resumes`)).find((r) => r.id === target.copyId);
      const line = editor.locator('#editor .entry[data-drag-id] .bullet .text.editable').first();
      const entryId = await line.evaluate((n) => n.closest('.entry[data-drag-id]').dataset.dragId);
      const original = store.entries.find((e) => e.id === entryId);
      restoreEntries.push(original);
      await line.dblclick();
      await editor.locator('#editor .editable.editing').waitFor({ timeout: 5000 });
      await side.keyboard.press('Control+End');
      await side.keyboard.type(' — typed beside the posting');
      // Mid-sentence, the other tab comes to the front.
      await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), marigoldTab.id);
      const moved = await until(async () => (await onScreen(side)) === marigoldTarget.baseId);
      check('the panel still follows the tab', Boolean(moved));
      const kept = await until(async () => {
        const now = await getJson(`${SERVER}/api/store`);
        return JSON.stringify(now.entries.find((e) => e.id === entryId)).includes('typed beside the posting');
      });
      check('the half-typed line was saved before it moved', Boolean(kept));
      void resume;

      // And a switch while a toggle's save is still waiting to go out.
      await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), harbourTab.id);
      await until(async () => (await onScreen(side)) === target.copyId);
      const before = JSON.stringify((await getJson(`${SERVER}/api/resumes`)).find((r) => r.id === target.copyId));
      await editorOf(side).locator('#editor .entry[data-drag-id] .bullet input[type=checkbox]').nth(1).click();
      await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), marigoldTab.id);
      await until(async () => (await onScreen(side)) === marigoldTarget.baseId);
      const landed = await until(async () =>
        JSON.stringify((await getJson(`${SERVER}/api/resumes`)).find((r) => r.id === target.copyId)) !== before,
      );
      check('a switched line waiting on its save was written before the move', Boolean(landed));
      await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), harbourTab.id);
      await until(async () => (await onScreen(side)) === target.copyId);
    }

    /* ---------------- Folding ---------------- */

    group('Folding it away and back');
    {
      const editor = editorOf(side);
      const line = editor.locator('#editor .entry[data-drag-id] .bullet .text.editable').nth(2);
      const entryId = await line.evaluate((n) => n.closest('.entry[data-drag-id]').dataset.dragId);
      const store = await getJson(`${SERVER}/api/store`);
      if (!restoreEntries.some((e) => e.id === entryId)) restoreEntries.push(store.entries.find((e) => e.id === entryId));
      await line.dblclick();
      await side.keyboard.press('Control+End');
      await side.keyboard.type(' — still being written');
      /*
       * Where the line sits on screen, measured after the typing (getting to
       * it scrolls the editor). On screen rather than `scrollY`: the line's
       * save redraws the page and the browser's scroll anchoring moves
       * `scrollY` to keep the line still, which is the thing a person sees.
       */
      const where = () =>
        editor.evaluate(() => {
          const lines = [...document.querySelectorAll('#editor .entry[data-drag-id] .bullet .text.editable')];
          return { top: Math.round(lines[2].getBoundingClientRect().top), y: Math.round(window.scrollY) };
        });
      const scrolled = await where();
      check('(the editor is scrolled some way down)', scrolled.y > 200, JSON.stringify(scrolled));

      await side.locator('#fold').click();
      await sleep(400);
      check('folded: the editor is out of sight', !(await side.locator('#main').isVisible()) && (await side.locator('#folded').isVisible()));
      check('and the bar still names the resume', (await barLabel(side)) === target.copyLabel, await barLabel(side));
      check('the control says it will unfold', (await side.locator('#fold').getAttribute('aria-expanded')) === 'false');
      await sideShot('folded');
      await side.locator('#fold').click();
      await sleep(400);
      check('unfolded: the same resume', (await onScreen(side)) === target.copyId);
      await sleep(1500);
      const after = await where();
      check('at the same place in it', Math.abs(after.top - scrolled.top) < 4, `${JSON.stringify(scrolled)} → ${JSON.stringify(after)}`);
      const text = await editor.evaluate(() => document.querySelector('#editor').textContent.includes('still being written'));
      check('with the line being written still there', text);
      await sideShot('unfolded');
      const saved = await until(async () =>
        JSON.stringify((await getJson(`${SERVER}/api/store`)).entries.find((e) => e.id === entryId)).includes('still being written'),
      );
      check('and it reaches the save', Boolean(saved));

      // Folded, and reopened: it comes back folded.
      await side.locator('#fold').click();
      const prefs = await until(() => worker.evaluate(() => chrome.storage.local.get('jh-panel-prefs').then((r) => r['jh-panel-prefs'])));
      check('folding is remembered in this browser', prefs?.collapsed === true);
      await side.reload();
      await sleep(1500);
      check('and a reopened panel starts folded', (await side.locator('#fold').getAttribute('aria-expanded')) === 'false');
      await side.locator('#fold').click();
      await until(async () => (await onScreen(side)) === target.copyId);
    }

    /* ---------------- A window of its own, at every width ---------------- */

    const windowed = async (query) => {
      const opened = context.waitForEvent('page');
      await worker.evaluate((url) => chrome.windows.create({ url, type: 'popup', width: 420, height: 900 }), `${panelUrl}?${query}`);
      const page = await opened;
      watch(page, `window ${query}`);
      return page;
    };
    const wide = await windowed(`tab=${harbourTab.id}`);
    const hscroll = async (page) => {
      const panel = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const inner = await editorOf(page)
        ?.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        .catch(() => 0);
      return Math.max(panel, inner ?? 0);
    };
    /** Every width, a picture of each if asked for, and no sideways scroll at any. */
    const atWidths = async (page, name, prep = async () => {}) => {
      const over = [];
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await sleep(700);
        await prep(page, width);
        const h = await hscroll(page);
        if (h > 1) over.push(`${width}px by ${h}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `panel-${name}-${width}.png`) });
      }
      check(`${name}: nothing scrolls sideways at ${WIDTHS.join(', ')}px`, over.length === 0, over.join('; '));
    };

    group('At every width');
    await until(async () => (await onScreen(wide)) === target.copyId);
    await atWidths(wide, 'copy');
    {
      const ed = () => editorOf(wide);
      await atWidths(wide, 'preview', async () => {
        await ed().evaluate(() => document.querySelector('#narrow-view [data-view=preview]').click());
        await sleep(900);
      });
      const drawn = await ed().evaluate(() => {
        const page = document.querySelector('#preview-pane .pdf-page');
        const pane = document.querySelector('#preview-pane');
        return page ? { page: page.getBoundingClientRect().width, pane: pane.clientWidth, ratio: page.getBoundingClientRect().height / page.getBoundingClientRect().width } : null;
      });
      check(
        'the preview is drawn for the width it is shown at, in proportion',
        Boolean(drawn) && drawn.page <= drawn.pane && Math.abs(drawn.ratio - 11 / 8.5) < 0.05,
        JSON.stringify(drawn),
      );
      // By script: at 1000px, the last width, the switch is not on screen.
      await ed().evaluate(() => document.querySelector('#narrow-view [data-view=edit]').click());
      await atWidths(wide, 'focus', async () => {
        await ed().evaluate(() => document.querySelector('#btn-focus[aria-pressed=false]')?.click());
        await sleep(300);
      });
      await ed().evaluate(() => document.querySelector('#btn-focus[aria-pressed=true]')?.click());
      await atWidths(wide, 'more', async () => {
        await ed().evaluate(() => document.querySelector('#btn-more[aria-expanded=false]')?.click());
        await sleep(200);
      });
      await ed().evaluate(() => document.querySelector('#btn-more[aria-expanded=true]')?.click());
      const dialogFits = () =>
        ed().evaluate(() => {
          const r = document.querySelector('.modal-body').getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5;
        });
      const misfits = [];
      for (const [name, button] of [['dialog-add-entry', '#btn-add-entry'], ['dialog-save-as', '#btn-save-as'], ['dialog-rename', '#btn-rename-resume']]) {
        const close = () =>
          ed().evaluate(() => {
            if (!document.querySelector('#modal').classList.contains('hidden')) document.querySelector('#modal-cancel').click();
          });
        await atWidths(wide, name, async (_page, width) => {
          await close();
          await ed().evaluate((b) => document.querySelector(b).click(), button);
          await sleep(300);
          if (!(await dialogFits())) misfits.push(`${name} at ${width}`);
        });
        await close();
      }
      check('every dialog fits inside the panel at every width', misfits.length === 0, misfits.join('; '));
      await atWidths(wide, 'folded', async (page) => {
        if ((await page.locator('#fold').getAttribute('aria-expanded')) === 'true') await page.locator('#fold').click();
        await sleep(250);
      });
      await wide.locator('#fold').click();
      await sleep(300);
      await atWidths(wide, 'unfolded-again');
      check('unfolded again after a round of widths: still the copy', (await onScreen(wide)) === target.copyId);
    }

    /* ---------------- Working in it, at a panel's width ---------------- */

    group('Working in it at a panel’s width');
    {
      const ed = () => editorOf(wide);
      const shotAt = async (name, widths = [320, 400]) => {
        const over = [];
        for (const width of widths) {
          await wide.setViewportSize({ width, height: 900 });
          await sleep(500);
          const h = await hscroll(wide);
          if (h > 1) over.push(`${width}px by ${h}`);
          if (SHOTS) await wide.screenshot({ path: path.join(SHOTS, `panel-work-${name}-${width}.png`) });
        }
        return over;
      };
      const problems = [];
      const note = async (name, run) => {
        await run();
        const over = await shotAt(name);
        if (over.length) problems.push(`${name}: ${over.join(', ')}`);
      };
      await ed().evaluate(() => window.scrollTo(0, 0));
      await note('bullet-off', async () => {
        await ed().locator('#editor .entry[data-drag-id] .bullet input[type=checkbox]').first().click();
        await sleep(600);
      });
      await note('undo', async () => {
        await ed().locator('#btn-undo').click();
        await sleep(800);
      });
      await note('redo', async () => {
        await ed().locator('#btn-redo').click();
        await sleep(800);
      });
      await note('editing-a-line', async () => {
        await ed().locator('#editor .entry[data-drag-id] .bullet .text.editable').first().dblclick();
        await sleep(300);
      });
      await ed().evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await note('next-phrasing', async () => {
        const step = ed().locator('#editor .stepper .step').last();
        if (await step.count()) await step.click();
        await sleep(800);
      });
      await note('drag-reorder', async () => {
        const grips = ed().locator('#editor .entry[data-drag-id] .bullet [draggable=true]');
        if ((await grips.count()) > 1) await grips.nth(1).dragTo(grips.nth(0)).catch(() => undefined);
        await sleep(800);
      });
      {
        // Far down the page: switching a line off, or stepping its wording,
        // must leave it where it was on screen.
        await wide.setViewportSize({ width: 400, height: 900 });
        await sleep(400);
        const topOf = (sel) =>
          ed().evaluate((q) => Math.round([...document.querySelectorAll(q)].at(-1).getBoundingClientRect().top), sel);
        const moved = [];
        for (const sel of ['#editor .bullet input[type=checkbox]', '#editor .stepper .step']) {
          const target = ed().locator(sel).last();
          await target.scrollIntoViewIfNeeded();
          const y = await ed().evaluate(() => window.scrollY);
          const before = await topOf(sel);
          await target.click();
          await sleep(1200);
          const after = await topOf(sel);
          if (Math.abs(after - before) > 60) moved.push(`${sel}: ${before} → ${after} (scrolled ${y})`);
          await target.click();
          await sleep(800);
        }
        check('a line switched or stepped far down the page stays where it was', moved.length === 0, moved.join('; '));
      }
      await note('long-master', async () => {
        await ed().locator('#resume-select').selectOption('__master__');
        await sleep(1200);
        await ed().evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
        await sleep(300);
      });
      await ed().locator('#resume-select').selectOption(target.copyId);
      await sleep(1000);
      await note('ai-activity', async () => {
        await ed().locator('#ai-peek-chip').click();
        await sleep(600);
      });
      await ed().evaluate(() => document.querySelector('#modal-cancel')?.click());
      for (const tab of ['save', 'workspace', 'applications', 'letters', 'history', 'voice']) {
        await note(`tab-${tab}`, async () => {
          await ed().evaluate((t) => document.querySelector(`#tabs button[data-tab="${t}"]`).click(), tab);
          await sleep(1200);
        });
      }
      await ed().evaluate(() => document.querySelector('#tabs button[data-tab="resumes"]').click());
      await wide.setViewportSize({ width: 400, height: 900 });
      await sleep(800);
      check('toggling, undoing, editing, stepping phrasings, reordering, the master and every tab: no sideways scroll at 320 and 400px', problems.length === 0, problems.join('; '));
    }

    /* ---------------- No application on the tab ---------------- */

    group('A tab with no application');
    const blog = await newTab(fixtures.urlFor(BLOG));
    await blog.waitForLoadState('domcontentloaded');
    const baseId = (await worker.evaluate(() => chrome.storage.sync.get({ baseResumeId: 'newgrad' }))).baseResumeId;
    const plain = await until(async () => /No application on this tab/.test(await noteText(side)));
    check('says there is no application here', Boolean(plain), await noteText(side));
    check('and shows the resume JobHelper starts from', (await until(async () => (await onScreen(side)) === baseId)) === true, `${await onScreen(side)}`);
    {
      const blogTab = await worker.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0], fixtures.urlFor(BLOG));
      const page = await windowed(`tab=${blogTab.id}`);
      await until(async () => (await onScreen(page)) === baseId);
      await atWidths(page, 'no-application');
      await page.close();
    }
    await worker.evaluate((id) => chrome.tabs.update(id, { active: true }), harbourTab.id);
    await until(async () => (await onScreen(side)) === target.copyId);

    /* ---------------- The server address changes, to one that is down ---------------- */

    group('ResumeM-M not running');
    await setServer(DEAD);
    const down = await until(async () => (await side.locator('#message').isVisible()) && /not running/.test(await side.locator('#message').textContent()));
    check('a server that does not answer is said, with how to start it', Boolean(down) && /npm run serve/.test(await side.locator('#message').textContent()));
    check('and no empty frame is shown', !(await side.locator('#stage').isVisible()) || (await side.locator('#stage').getAttribute('inert')) !== null);
    await sideShot('server-down');
    await atWidths(wide, 'server-down');
    await setServer(SERVER);
    const up = await until(async () => (await onScreen(side)) === target.copyId && !(await side.locator('#message').isVisible()));
    check('pointed back at a running one, the editor comes back on the same resume', Boolean(up));

    /* ---------------- A different save ---------------- */

    group('A different save open');
    otherDir = fs.mkdtempSync(path.join(process.env.JH_TMP ?? os.tmpdir(), 'jh-panel-save-'));
    // Not its output folder, which the running server writes into as this
    // copies — a preview going away mid-copy failed the whole run once.
    const outDir = path.join(health.dataDir, 'out');
    fs.cpSync(health.dataDir, otherDir, { recursive: true, filter: (src) => src !== outDir && !src.startsWith(`${outDir}${path.sep}`) });
    const rmm = process.env.RMM_CHECKOUT ?? path.resolve(extensionRoot, '..', 'ResumeM-M');
    other = spawn(process.execPath, [path.join(rmm, 'dist/src/cli.js'), 'serve', '--port', String(OTHER_PORT), '--data', otherDir], {
      cwd: rmm,
      stdio: 'ignore',
      env: { ...process.env },
    });
    const OTHER = `http://127.0.0.1:${OTHER_PORT}`;
    await until(() => fetch(`${OTHER}/health`).then((r) => r.ok), { timeout: 20_000 });
    await setServer(OTHER);
    const refused = await until(async () => /different save/i.test((await side.locator('#message').textContent()) ?? '') && (await side.locator('#message').isVisible()));
    check('the address changed to a server with another save: said, not edited', Boolean(refused), await side.locator('#message').textContent());
    await atWidths(wide, 'other-save');
    await side.locator('#message button', { hasText: 'Edit anyway' }).click();
    const anyway = await until(async () => editorOf(side)?.url().startsWith(OTHER) && (await onScreen(side)) === target.copyId);
    check('"Edit anyway" opens the editor from that server', Boolean(anyway), editorOf(side)?.url());

    group('The server stopping while the editor is open');
    other.kill();
    other = null;
    const stopped = await until(async () => /stopped answering/.test(await noteText(side)), { timeout: 15_000 });
    check('said, over the editor, which is kept with what is in it', Boolean(stopped) && (await side.locator('#stage').isVisible()));
    await sideShot('server-stopped');
    await setServer(SERVER);
    await until(async () => (await onScreen(side)) === target.copyId && editorOf(side)?.url().startsWith(SERVER));

    /* ---------------- Deleted in the meantime ---------------- */

    group('The resume deleted in the meantime');
    await fetch(`${SERVER}/api/resumes/${encodeURIComponent(target.copyId)}`, { method: 'DELETE' });
    const fellBack = await until(async () => (await onScreen(side)) === target.baseId && /deleted/.test(await noteText(side)));
    check('the copy deleted: says so, and shows the resume it was made from', Boolean(fellBack), await noteText(side));
    await atWidths(wide, 'copy-deleted');
    await worker.evaluate(
      ({ id }) =>
        chrome.storage.session.get(`jh-panel:${id}`).then((r) =>
          chrome.storage.session.set({ [`jh-panel:${id}`]: { ...r[`jh-panel:${id}`], baseId: 'shot-gone', baseLabel: 'A resume that went' } }),
        ),
      { id: harbourTab.id },
    );
    const gone = await until(async () => /no longer in the save/.test((await side.locator('#message').textContent()) ?? '') && (await side.locator('#message').isVisible()));
    check('neither the copy nor its base left: said, with a way on', Boolean(gone) && (await side.locator('#message button').count()) > 0);
    await atWidths(wide, 'gone');

    group('Opening it from the toolbar popup');
    {
      // A window of its own, so its side panel is a new one.
      const made = await worker.evaluate((url) => chrome.windows.create({ url, type: 'normal' }), fixtures.urlFor(BLOG));
      // Asked of the browser each time: a connection made earlier is not told
      // about a side panel opened after it.
      const session = await context.newCDPSession(harbour);
      const panels = async () =>
        (await session.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && t.url === panelUrl).length;
      const before = await panels();
      await worker.evaluate(({ url, windowId }) => chrome.tabs.create({ url, windowId }), {
        url: `chrome-extension://${extId}/src/popup/popup.html`,
        windowId: made.id,
      });
      // Found by address: the new window's own page opens around the same time.
      const popup = await until(() => context.pages().find((p) => p.url().includes('/src/popup/popup.html')));
      await popup.waitForLoadState('domcontentloaded');
      await sleep(500);
      const button = popup.locator('#openBeside');
      check('the popup offers the editor beside the page', await button.isVisible());
      await button.click();
      const more = await until(async () => (await panels()) > before, { timeout: 10_000 });
      const said = popup.isClosed() ? 'popup closed itself' : await popup.locator('#status').textContent().catch(() => '');
      check('and pressing it opens the side panel in that window', Boolean(more), `${before} → ${await panels()}; ${said}`);
    }

    group('Where the side panel will not open');
    {
      // Asked with no click behind it, which the side panel refuses: the
      // same page opens as a small window instead, following that window.
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/src/popup/popup.html`);
      // Playwright's evaluate counts as a click; that lasts five seconds.
      const unasked = () =>
        page.evaluate(async () => {
          await new Promise((r) => setTimeout(r, 6000));
          return chrome.runtime.sendMessage({ type: 'openPanel', payload: {} });
        });
      const reply = await unasked();
      check('it falls back to a window of its own', reply?.ok && reply.data?.opened === 'window', JSON.stringify(reply));
      const fallback = await until(() => context.pages().find((p) => p.url().startsWith(`${panelUrl}?window=`)));
      check('holding the same panel', Boolean(fallback), fallback?.url());
      const again = await unasked();
      check('and asked again, the same window comes forward rather than a second', again?.data?.id === reply?.data?.id);
      await page.close();
    }

    group('Nothing went wrong on the way');
    check('no page errors or console errors in the panel, the editor or the pages', errors.length === 0, errors.slice(0, 6).join(' | '));
  } finally {
    for (const entry of restoreEntries.filter(Boolean)) {
      await fetch(`${SERVER}/api/entries/${encodeURIComponent(entry.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      }).catch(() => undefined);
    }
    other?.kill();
    if (otherDir) fs.rmSync(otherDir, { recursive: true, force: true });
    await cdp?.close().catch(() => undefined);
    await context.close();
    fixtures.close();
    await cleanStore(SERVER, MINE).catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log(`Failed: ${failures.join('; ')}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
