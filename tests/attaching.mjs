/**
 * Putting the files into the form, instead of telling you where they are.
 *
 * The flat folder and the path beside it were the answer to "how do I attach
 * what this built": point the dialog at one place and pick the file out. Two
 * clicks and a paste, every time, and the same two for a transcript that has
 * not changed since September.
 *
 * What is checked here is the part that can go quietly wrong. `input.files`
 * only accepts a `FileList` from a `DataTransfer` — hand it an array and the
 * assignment is silently ignored, the box stays empty, and the report says it
 * worked. And a file in the wrong box is worse than no file at all: a form
 * that looks filled in, with the transcript as the thing an employer opens
 * first. So every case below reads back what is actually in each box.
 *
 *   node tests/attaching.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><form>${body}</form></body></html>`;

/** Three boxes, each saying plainly what it wants. */
const LABELLED = page(`
  <label for="rs">Resume/CV</label><input id="rs" name="resume" type="file">
  <label for="cl">Cover Letter</label><input id="cl" name="cover" type="file">
  <label for="tr">Transcript</label><input id="tr" name="transcript" type="file">
`);

/** One box, no word anywhere near it — the commonest small form there is. */
const BARE = page(`<p>Application</p><input id="only" name="file" type="file">`);

/**
 * The shape every real portal uses: a styled button, and the input behind it
 * with `display:none`. A visibility test throws all of these away.
 */
const HIDDEN = page(`
  <div>
    <h3>Resume</h3>
    <button type="button">Attach or drop files here</button>
    <input id="rs" name="resume" type="file" style="display:none">
  </div>
`);

/** Only a resume box, and a transcript with nowhere to go. */
const RESUME_ONLY = page(`<label for="rs">Resume</label><input id="rs" name="resume" type="file">`);

/** A box whose label names both, and a plainer letter box further down. */
const SHARED = page(`
  <label for="both">Resume and cover letter (one PDF)</label><input id="both" name="both" type="file">
  <label for="cl">Cover letter</label><input id="cl" name="cover" type="file">
`);

/**
 * Two controls with no labels, told apart only by the heading above each —
 * and the transcript first, so taking the boxes in document order is wrong.
 * This is how Workday and Greenhouse build them.
 */
const HEADINGS = page(`
  <div class="fields">
    <h3>Transcript</h3>
    <button type="button">Attach or drop files here</button>
    <input id="a" type="file" style="display:none">
    <h3>Resume</h3>
    <button type="button">Attach or drop files here</button>
    <input id="b" type="file" style="display:none">
  </div>
`);

/** An ordinary page with an account menu, and no upload box anywhere. */
const MENU = `<!doctype html><html><head><meta charset="utf-8"><title>Careers</title></head>
<body>
  <div class="dropdown"><button type="button">Account</button><ul><li>Sign out</li></ul></div>
  <h1>Platform Engineer</h1><p>Apply on our portal.</p>
</body></html>`;

/** Workday's shape: a region that listens for a drop, and no input at all. */
const DROPZONE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><form>
  <div class="upload-area" aria-label="Drop files to attach"><p>Drag and drop your resume here</p></div>
</form></body></html>`;

/** The same, on a page that does what Workday does with what it catches. */
const DROPZONE_REAL = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><form>
  <div id="zone" class="upload-area"><p>Drag and drop your resume here</p></div>
  <script>
    document.getElementById('zone').addEventListener('drop', (e) => {
      e.preventDefault();
      const made = document.createElement('input');
      made.type = 'file'; made.id = 'made'; made.name = 'resume';
      made.files = e.dataTransfer.files;
      document.querySelector('form').append(made);
    });
  </script>
</form></body></html>`;

const PAGES = {
  '/menu': MENU,
  '/dropzone': DROPZONE,
  '/dropzone-real': DROPZONE_REAL,
  '/headings': HEADINGS,
  '/labelled': LABELLED,
  '/bare': BARE,
  '/hidden': HIDDEN,
  '/resume-only': RESUME_ONLY,
  '/shared': SHARED,
};

/** A little PDF, as the worker would hand it over. */
const filed = (name) => ({
  name,
  type: 'application/pdf',
  base64: Buffer.from(`%PDF-1.7\n${name}\n`).toString('base64'),
});

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/content/attach.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/attach.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGES[url] ?? BARE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  try {
    const p = await browser.newPage();

    /** Attach these files on that page, and read back what is in every box. */
    const run = async (where, files) => {
      await p.goto(`${base}${where}`, { waitUntil: 'domcontentloaded' });
      return p.evaluate(
        async ({ b, list }) => {
          const m = await import(`${b}/attach.js`);
          // Recorded as the page would see them: a form's own handler reads
          // `event.target.files`, so a box that never fired is a box that did
          // not happen as far as the page is concerned.
          const heard = [];
          for (const input of document.querySelectorAll('input[type=file]')) {
            input.addEventListener('change', (e) => heard.push(e.target.id));
          }
          const report = await m.attachFiles(list);
          const inBoxes = {};
          for (const input of document.querySelectorAll('input[type=file]')) {
            inBoxes[input.id] = [...(input.files ?? [])].map((f) => f.name);
          }
          return { report, inBoxes, heard };
        },
        { b: base, list: files },
      );
    };

    /* ---------------------------------------------------------------- */

    group('Three boxes that say what they want');
    {
      const { report, inBoxes, heard } = await run('/labelled', [
        filed('Jianwen-Ding-Resume.pdf'),
        filed('Jianwen-Ding-Cover-Letter.pdf'),
        filed('Transcript.pdf'),
      ]);
      check('the resume goes in the resume box', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.rs));
      check('the letter goes in the letter box', inBoxes.cl?.[0] === 'Jianwen-Ding-Cover-Letter.pdf', JSON.stringify(inBoxes.cl));
      check('the transcript goes in the transcript box', inBoxes.tr?.[0] === 'Transcript.pdf', JSON.stringify(inBoxes.tr));
      check('all three are reported as placed', report.placed.length === 3, `${report.placed.length} placed`);
      /*
       * The events are the half that is easy to leave out. A form listens for
       * `change`; without it `input.files` is right and the page has no idea.
       */
      check('and the form heard about each one', heard.length === 3, heard.join(', '));
    }

    group('One box and no words');
    {
      const { report, inBoxes } = await run('/bare', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the one file goes in the one box', inBoxes.only?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.only));
      check('and says where it went', report.placed[0]?.where?.includes('only upload box'), report.placed[0]?.where ?? '');
    }

    group('A box behind a styled button, which is how they are all built');
    {
      const { inBoxes } = await run('/hidden', [filed('Jianwen-Ding-Resume.pdf')]);
      check('display:none is not a reason to skip it', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.rs));
    }

    /*
     * The case that must refuse. A form asking only for a resume is saying it
     * does not want a transcript, and putting one in the resume box is worse
     * than attaching nothing: the form looks complete and the first thing an
     * employer opens is the wrong document.
     */
    group('A file with nowhere to go');
    {
      const { report, inBoxes } = await run('/resume-only', [
        filed('Jianwen-Ding-Resume.pdf'),
        filed('Transcript.pdf'),
      ]);
      check('the resume still lands', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.rs));
      check('the transcript is not put somewhere it does not belong', report.placed.length === 1, JSON.stringify(report.placed));
      check('and is named as having nowhere to go', report.unplaced[0]?.name === 'Transcript.pdf', JSON.stringify(report.unplaced));
    }

    group('A box that names both, with a plainer one below it');
    {
      const { inBoxes } = await run('/shared', [
        filed('Jianwen-Ding-Resume.pdf'),
        filed('Jianwen-Ding-Cover-Letter.pdf'),
      ]);
      check('the resume takes the shared box', inBoxes.both?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.both));
      check('and the letter takes the one that is only its own', inBoxes.cl?.[0] === 'Jianwen-Ding-Cover-Letter.pdf', JSON.stringify(inBoxes.cl));
    }

    /*
     * The case the ancestor bound exists for. Both controls are in one div, so
     * an ancestor's text says "transcript resume" for each of them — and with
     * the transcript's box first, a matcher that falls back to document order
     * puts the resume where the transcript belongs and the transcript where
     * the resume belongs. Two wrong documents, and a form that looks right.
     */
    group('Two unlabelled boxes, told apart by the heading above each');
    {
      const { inBoxes } = await run('/headings', [filed('Jianwen-Ding-Resume.pdf'), filed('Transcript.pdf')]);
      check('the resume goes under the Resume heading', inBoxes.b?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and the transcript under the Transcript one', inBoxes.a?.[0] === 'Transcript.pdf', JSON.stringify(inBoxes));
    }

    /*
     * The page with no upload box at all, which is most of the web.
     *
     * The drop-zone fallback matched `/drag|drop|attach/` with no word
     * boundaries, and `drop` is inside `dropdown` — which is on some element
     * of nearly every page there is. So an ordinary page with an account menu
     * reported the resume as attached, having dispatched a drop event at a
     * menu. Measured before the fix: `{placed: [{name: "…Resume.pdf", where:
     * "the drop area"}], boxes: 0}`.
     *
     * Telling somebody their resume is in the form when it is nowhere is the
     * worst thing this file can do. It is worse than refusing, because they
     * press Submit on the strength of it.
     */
    group('A page with a menu on it and nowhere to put anything');
    {
      const { report } = await run('/menu', [filed('Jianwen-Ding-Resume.pdf')]);
      check('a dropdown is not a drop area', report.placed.length === 0, JSON.stringify(report.placed));
      check('and the file is named as having nowhere to go', report.unplaced[0]?.name === 'Jianwen-Ding-Resume.pdf', JSON.stringify(report.unplaced));
    }

    /*
     * And the real one, which must still work. Workday's is a region with a
     * drop handler and no input until a file has been chosen — so there is
     * nothing to read back afterwards, and a drop that was ignored looks
     * exactly like one that was taken and uploaded over the network. The
     * honest answer is "not sure", said as that.
     */
    group('A drop area with no input behind it');
    {
      const { report } = await run('/dropzone', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the file is offered to it', report.placed[0]?.where === 'the drop area', JSON.stringify(report.placed));
      check(
        'and it is not claimed as attached, because nothing can say it was',
        report.placed[0]?.sure === false,
        JSON.stringify(report.placed[0]),
      );
    }

    /*
     * The same zone, on a page that does what Workday does: takes the drop
     * and puts the file into an input. That *can* be read back, so it is not
     * hedged.
     */
    group('A drop area that really takes the file');
    {
      const { report, inBoxes } = await run('/dropzone-real', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the page ends up holding it', inBoxes.made?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and it is reported as certain', report.placed[0]?.sure === true, JSON.stringify(report.placed[0]));
    }

    group('Reading a name for what kind of document it is');
    {
      const kinds = await p.evaluate(async ({ b }) => {
        const m = await import(`${b}/attach.js`);
        return [
          'Jianwen-Ding-Resume.pdf',
          'Jianwen Ding CV.pdf',
          'Jianwen-Ding-Cover-Letter.pdf',
          'Transcript.pdf',
          'UVA Academic Record.pdf',
          'Portfolio.pdf',
          'something-else.pdf',
        ].map((n) => [n, m.kindOf(n)]);
      }, { b: base });
      const want = ['resume', 'resume', 'letter', 'transcript', 'transcript', 'portfolio', 'other'];
      const got = kinds.map(([, k]) => k);
      check('each name reads as what it is', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(kinds));
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
