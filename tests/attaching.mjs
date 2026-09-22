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
/*
 * The two ways a page puts a file input behind something, and the one way it
 * puts one out of reach.
 *
 * `display:none` with a button in front is the familiar one. The `hidden`
 * attribute with a `<label for>` styled as the button is the same idea said
 * in HTML rather than CSS, and it is the accessible way to build it — the
 * label's click opens the native dialog. Both are ordinary; neither is a
 * reason to refuse the box.
 *
 * The third is not: a complete, correctly labelled upload control inside a
 * container the page has hidden — a closed modal, an "add another" prototype
 * row. Nobody can see it, and taking it is how a file lands somewhere the
 * form will never submit.
 */
const HIDDEN = page(`
  <div hidden>
    <label for="tpl">Resume</label>
    <input id="tpl" name="resume_template" type="file">
  </div>
  <div>
    <h3>Resume</h3>
    <button type="button">Attach or drop files here</button>
    <input id="rs" name="resume" type="file" style="display:none">
  </div>
  <div>
    <label for="cl" class="button">Upload cover letter</label>
    <input id="cl" name="cover_letter" type="file" hidden>
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

/**
 * Workday as it is actually built, which is the one somebody hit.
 *
 * Reported against an Adobe application, which is Workday. Its upload is not
 * a labelled input and not a bare region either: a `data-automation-id` drop
 * zone several divs deep, a "Select files" button inside it that is what the
 * pointer is actually over, and a file input that does not exist until a file
 * has been chosen — created by the drop handler, exactly as below. Nothing in
 * this file had that shape: `/dropzone-real` has the handler but the pointer
 * lands straight on the zone.
 */
const WORKDAY = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><div data-automation-id="applicationPage">
  <div data-automation-id="quickApplyResume">
    <h4>Resume/CV</h4>
    <div id="zone" data-automation-id="file-upload-drop-zone">
      <div class="inner">
        <p>Drag and drop files here</p>
        <button id="pick" type="button" data-automation-id="select-files">Select files</button>
      </div>
    </div>
  </div>
  <script>
    document.getElementById('zone').addEventListener('drop', (e) => {
      e.preventDefault();
      const made = document.createElement('input');
      made.type = 'file'; made.id = 'made'; made.name = 'resume';
      made.files = e.dataTransfer.files;
      document.body.append(made);
    });
  </script>
</div></body></html>`;

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

/**
 * One box, and it says Resume. The transcript must not take it just for
 * being first in the list — which is whatever order the store lists them in.
 */
const RESUME_ONLY_LABELLED = page(`<label for="rs">Resume</label><input id="rs" name="resume" type="file">`);

/**
 * A profile photo box and a real drop zone for the resume. The form's text
 * says "Resume" near both, and only one of them is a document's.
 */
const PHOTO_AND_ZONE = page(`
  <label for="ph">Profile photo</label><input id="ph" name="photo" type="file" accept="image/*">
  <h3>Resume</h3>
  <div data-automation-id="file-upload"><p>Drag and drop your resume here</p></div>
`);

/** A closed modal holding a complete, correctly labelled upload control. */
const DECOY = page(`
  <div class="modal" style="display:none"><label for="decoy">Resume</label><input id="decoy" type="file"></div>
  <label for="real">Resume</label><input id="real" type="file">
`);

/** A form that has said, in the markup, that it will not have a PDF. */
const DOC_ONLY = page(
  `<label for="rs">Resume (.doc or .docx only)</label><input id="rs" type="file" accept=".doc,.docx">`,
);

/** The short version of a form: one box, asking for all three. */
const ALL_IN_ONE = page(
  `<label for="all">Attach your resume, cover letter and transcript</label><input id="all" type="file" multiple>`,
);

/** A form built as a web component, which is how a modern one is built. */
const SHADOW = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head>
<body><div id="host"></div><script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<label for="rs">Resume</label><input id="rs" type="file">';
</script></body></html>`;

const PAGES = {
  '/resume-only-labelled': RESUME_ONLY_LABELLED,
  '/photo-and-zone': PHOTO_AND_ZONE,
  '/decoy': DECOY,
  '/doc-only': DOC_ONLY,
  '/all-in-one': ALL_IN_ONE,
  '/shadow': SHADOW,
  '/menu': MENU,
  '/dropzone': DROPZONE,
  '/dropzone-real': DROPZONE_REAL,
  '/workday': WORKDAY,
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
          /*
           * Read back through the shadow roots as well. A form built as a web
           * component keeps its boxes out of the document, and a readback
           * that cannot see them cannot tell "placed correctly" from "placed
           * nowhere".
           */
          const inBoxes = {};
          const walk = (root) => {
            for (const input of root.querySelectorAll('input[type=file]')) {
              inBoxes[input.id] = [...(input.files ?? [])].map((f) => f.name);
            }
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
          };
          walk(document);
          return { report, inBoxes, heard };
        },
        { b: base, list: files },
      );
    };

    /**
     * The same, with a file the person put in the box themselves first.
     *
     * A `multiple` box is the one place their own attachment and ours share a
     * control, so it is the only place ours can delete theirs.
     */
    const runOver = async (where, files, mine) => {
      await p.goto(`${base}${where}`, { waitUntil: 'domcontentloaded' });
      return p.evaluate(
        async ({ b, list, seed }) => {
          const box = document.querySelector('input[type=file][multiple]');
          const carrier = new DataTransfer();
          carrier.items.add(new File([new Uint8Array([1, 2, 3])], seed, { type: 'application/pdf' }));
          box.files = carrier.files;

          const m = await import(`${b}/attach.js`);
          const report = await m.attachFiles(list);
          return { report, inBox: [...(box.files ?? [])].map((f) => f.name) };
        },
        { b: base, list: files, seed: mine },
      );
    };

    /* ---------------------------------------------------------------- */

    /* ---------------------------------------------------------------- *
     * What this form is asking for                                       *
     * ---------------------------------------------------------------- */
    /*
     * The card draws one liftable chip per built file and says which of them
     * this form actually wants — so "drag the transcript in" is a thing you
     * can be told rather than a thing you work out by reading the form
     * twice. The reading is `documentsWanted`, and it has to be read off the
     * same words `boxFor` places by, or the card promises one thing and the
     * attach does another.
     */
    const asked = (where) =>
      p.goto(`${base}${where}`, { waitUntil: 'domcontentloaded' }).then(() =>
        p.evaluate(async (b) => (await import(`${b}/attach.js`)).documentsWanted(), base),
      );

    group('Which documents the form in front of you asks for');
    {
      const three = await asked('/labelled');
      check(
        'three labelled boxes name all three',
        ['resume', 'letter', 'transcript'].every((k) => three.kinds.includes(k)),
        JSON.stringify(three.kinds),
      );

      const one = await asked('/resume-only');
      check('a form that wants only a resume says only that', one.kinds.join() === 'resume', JSON.stringify(one.kinds));
      check('and does not invent a transcript', !one.kinds.includes('transcript'));

      /*
       * A box that says nothing is not evidence about any one kind — it takes
       * whatever it is given, which `saysNothing` relies on. Counted rather
       * than guessed at, so the card can tell "this form wants no transcript"
       * from "this form has not said".
       */
      const bare = await asked('/bare');
      check('an unnamed box names no kind', bare.kinds.length === 0, JSON.stringify(bare.kinds));
      check('and is counted, so silence is not read as a no', bare.unnamed === 1, `${bare.unnamed} unnamed`);

      /*
       * And a photo box is not a document box. The card marking "this form
       * asks for it" beside a resume because the page wants a headshot would
       * be the same wrong-document mistake `boxFor` refuses to make.
       */
      const photo = await asked('/photo-and-zone');
      check('a photo box is not asking for any of these', !photo.kinds.includes('resume'), JSON.stringify(photo.kinds));
    }

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
      const { inBoxes, report } = await run('/hidden', [
        filed('Jianwen-Ding-Resume.pdf'),
        filed('Jianwen-Ding-Cover-Letter.pdf'),
      ]);
      check('display:none is not a reason to skip it', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.rs));
      /*
       * Nor the attribute that means the same thing. This was refused, and
       * the refusal was invisible: `closest('[hidden]')` starts at the
       * element itself, so the check written for a hidden *template* threw
       * away every box built the accessible way. On a form with one of each,
       * the letter matched nothing, went to whatever container looked like a
       * drop area, and came back reported as placed with the box still empty.
       */
      check(
        'and nor is the attribute that means the same thing',
        inBoxes.cl?.[0] === 'Jianwen-Ding-Cover-Letter.pdf',
        JSON.stringify(inBoxes.cl),
      );
      /*
       * And the container case still refused — from *in front of* the real
       * box, which is the only arrangement where the refusal does any work.
       * Behind it the visible box wins on document order anyway, and a check
       * written that way goes green over a refusal that has been deleted.
       */
      check(
        'while a control inside a hidden container is still left alone',
        (inBoxes.tpl ?? []).length === 0,
        JSON.stringify(inBoxes.tpl),
      );
      // And both are reported as having gone into a box, rather than as
      // having been handed to something that might not have taken them.
      check(
        'both are reported as landing somewhere definite',
        report.placed.length === 2 && report.placed.every((pl) => pl.sure !== false),
        JSON.stringify(report.placed),
      );
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

    /* ---------------------------------------------------------------- *
     * The six ways a file ended up in the wrong place, or nowhere        *
     * ---------------------------------------------------------------- */

    /*
     * The fallback asked how many boxes there were, never what the one box
     * said. So on a form asking for a resume and nothing else, the transcript
     * took the resume box whenever the store happened to list it first — and
     * the store's order is not something the person chose. Measured before
     * the fix: `#rs` holding `Transcript.pdf`, the resume reported as having
     * nowhere to go.
     */
    group('One box, and it says Resume');
    {
      const { report, inBoxes } = await run('/resume-only-labelled', [
        filed('Transcript.pdf'),
        filed('Jianwen-Ding-Resume.pdf'),
      ]);
      check('the resume takes it, whatever order they came in', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and the transcript does not', report.unplaced[0]?.name === 'Transcript.pdf', JSON.stringify(report.unplaced));
    }

    /*
     * A profile-photo box and a real drop zone for the resume. `aroundIt`
     * reads the text near a control, and the word "Resume" was near both — so
     * the resume went into the avatar box and the presence of that one box
     * meant the drop zone was never tried. Measured: `#ph` holding the
     * resume, zero drop events at the zone, under a green "Attached".
     */
    group('An upload box that is for a photograph');
    {
      const { report, inBoxes } = await run('/photo-and-zone', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the resume does not go in the photo box', (inBoxes.ph ?? []).length === 0, JSON.stringify(inBoxes));
      check('and the drop area is tried instead', report.placed[0]?.where === 'the drop area', JSON.stringify(report.placed));
    }

    /*
     * A closed modal holds a complete, correctly labelled upload control, and
     * `boxFor` took the first match in document order. The person sees an
     * empty box and a note saying the file is attached.
     */
    group('A hidden copy of the form, in front of the real one');
    {
      const { inBoxes } = await run('/decoy', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the file goes in the box that is on screen', inBoxes.real?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and not in the one the page has hidden', (inBoxes.decoy ?? []).length === 0, JSON.stringify(inBoxes));
    }

    /*
     * The form has said in the markup that it will not have a PDF. Putting
     * one in anyway is placed, reported as attached, and refused by the
     * portal at submit — after the person has stopped checking.
     */
    group('A box that has said what it will take');
    {
      const { report, inBoxes } = await run('/doc-only', [filed('Jianwen-Ding-Resume.pdf')]);
      check('a PDF is not forced into a .doc box', (inBoxes.rs ?? []).length === 0, JSON.stringify(inBoxes));
      check(
        'and the reason names what the form wants',
        /\.doc/.test(report.unplaced[0]?.why ?? ''),
        report.unplaced[0]?.why ?? '',
      );
    }

    /*
     * One `multiple` box asking for all three, which is how the short version
     * of a form is built. Every file after the first came back "no box here
     * asks for it" — on a box that had named it.
     */
    group('One box that asks for all three');
    {
      const { report, inBoxes } = await run('/all-in-one', [
        filed('Jianwen-Ding-Resume.pdf'),
        filed('Jianwen-Ding-Cover-Letter.pdf'),
        filed('Transcript.pdf'),
      ]);
      check('all three go in', (inBoxes.all ?? []).length === 3, JSON.stringify(inBoxes));
      check('in the order they were given', inBoxes.all?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and none is reported as homeless', report.unplaced.length === 0, JSON.stringify(report.unplaced));
    }

    /*
     * A transcript the person attached by hand, on the box we are about to use.
     *
     * The card says so itself when the folder has no transcript — "No
     * transcript in the folder", and an "Add one" button — so doing it through
     * the portal's own dialog is the obvious move. Then pressing Attach files
     * put the resume in through `boxFor`, which replaces rather than adds,
     * and the transcript was gone. Silently: the card printed a green
     * "Attached …-Resume.pdf and …-Cover-Letter.pdf", nothing was in
     * `unplaced`, and the box that had held three documents held two.
     *
     * `putIn`'s own comment already knew replacing was wrong on a box like
     * this — "on a box labelled 'resume, cover letter and transcript' that
     * would leave only whichever file happened to be last" — and the first
     * call site passed no `alongside` at all.
     */
    group('A file the person attached themselves, in the box we are filling');
    {
      const { report, inBox } = await runOver(
        '/all-in-one',
        [filed('Jianwen-Ding-Resume.pdf'), filed('Jianwen-Ding-Cover-Letter.pdf')],
        'My-Transcript.pdf',
      );
      check('what they attached is still there', inBox.includes('My-Transcript.pdf'), JSON.stringify(inBox));
      check('and ours went in beside it', inBox.length === 3, JSON.stringify(inBox));
      check('with nothing reported as homeless', report.unplaced.length === 0, JSON.stringify(report.unplaced));
    }

    /*
     * And pressing it twice does not stack up two of everything. The replace
     * on the first file is what keeps a re-press clean, so sparing their file
     * must not spare ours.
     */
    group('Attach files pressed twice over their own file');
    {
      const twice = await p.evaluate(
        async ({ b, list, seed }) => {
          const box = document.querySelector('input[type=file][multiple]');
          const carrier = new DataTransfer();
          carrier.items.add(new File([new Uint8Array([1])], seed, { type: 'application/pdf' }));
          box.files = carrier.files;
          const m = await import(`${b}/attach.js`);
          await m.attachFiles(list);
          await m.attachFiles(list);
          return [...(box.files ?? [])].map((f) => f.name);
        },
        {
          b: base,
          list: [filed('Jianwen-Ding-Resume.pdf'), filed('Jianwen-Ding-Cover-Letter.pdf')],
          seed: 'My-Transcript.pdf',
        },
      );
      check('still three files, not five', twice.length === 3, JSON.stringify(twice));
      check('and theirs is one of them', twice.includes('My-Transcript.pdf'), JSON.stringify(twice));
    }

    /*
     * A form built as a web component. `looksLikeApplicationForm` — the gate
     * on this whole path — walks into shadow roots, so the frame passes the
     * gate and then every file was refused for having no upload box, on the
     * same form where Autofill had just filled every text field.
     */
    group('A form built out of web components');
    {
      const { report, inBoxes } = await run('/shadow', [filed('Jianwen-Ding-Resume.pdf')]);
      check('a box inside a shadow root is still a box', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes));
      check('and it is reported as placed', report.placed.length === 1, JSON.stringify(report));
    }

    /*
     * A zero-byte body is what a file still being written looks like — the
     * folder is streamed to as each document is built. Nothing noticed:
     * `atob('')` makes a File of size 0, the box holds one file, and the card
     * said "Attached Jianwen-Ding-Resume.pdf" over an empty PDF.
     */
    group('A file that comes back empty');
    {
      const { report, inBoxes } = await run('/resume-only-labelled', [
        { name: 'Jianwen-Ding-Resume.pdf', type: 'application/pdf', base64: '' },
      ]);
      check('nothing is put in the box', (inBoxes.rs ?? []).length === 0, JSON.stringify(inBoxes));
      check('and it is reported as empty, not as attached', /empty/.test(report.unplaced[0]?.why ?? ''), report.unplaced[0]?.why ?? '');
    }

    /* ---------------------------------------------------------------- *
     * Letting go of a chip over the form                                 *
     * ---------------------------------------------------------------- */
    /*
     * The drag never carried anything, and nothing here could have known.
     *
     * The chips on the card are draggable; their `dragstart` puts a real
     * `File` into `event.dataTransfer`; and Chromium throws it away before
     * the drop, because a drag can leave the browser and a page that could
     * put files into one could write to the desktop. Measured on a bare page
     * with no extension involved — drop side: `types: ["text/plain"]`,
     * `files: []`, no file item at all. See tests/probe-drag-drop.mjs.
     *
     * The test that was here asked what the chip *hands over*, inside
     * `dragstart`, where the file is genuinely present. It passed for months
     * over a feature that has never once put a file in a form.
     *
     * So the extension takes the drop itself, and `dropOnto` is what places
     * the file. What it has to get right is the aim: what is under the
     * pointer is almost never the box — it is the styled button in front of a
     * hidden input, a label, the words inside a drop zone.
     */
    const dropAt = async (where, selector, files) => {
      await p.goto(`${base}${where}`, { waitUntil: 'domcontentloaded' });
      return p.evaluate(
        async ({ b, sel, list }) => {
          const m = await import(`${b}/attach.js`);
          const heard = [];
          for (const input of document.querySelectorAll('input[type=file]')) {
            input.addEventListener('change', (e) => heard.push(e.target.id));
          }
          const report = await m.dropOnto(document.querySelector(sel), list);
          const inBoxes = {};
          for (const input of document.querySelectorAll('input[type=file]')) {
            inBoxes[input.id] = [...(input.files ?? [])].map((f) => f.name);
          }
          return { report, inBoxes, heard };
        },
        { b: base, sel: selector, list: files },
      );
    };

    group('A chip let go of straight onto an upload box');
    {
      const { report, inBoxes, heard } = await dropAt('/labelled', '#tr', [filed('Transcript.pdf')]);
      check('it goes in the box it was dropped on', inBoxes.tr?.[0] === 'Transcript.pdf', JSON.stringify(inBoxes.tr));
      check('and nowhere else', (inBoxes.rs?.length ?? 0) === 0 && (inBoxes.cl?.length ?? 0) === 0, JSON.stringify(inBoxes));
      check('reported as placed', report.placed.length === 1, JSON.stringify(report));
      // The half that is easy to leave out: a form listens for `change`.
      check('and the form heard about it', heard.join() === 'tr', heard.join(', '));
    }

    /*
     * Aimed at the button, which is what there is to aim at. Every real
     * portal hides the input behind one, so a drop that only accepts a direct
     * hit on an `<input type=file>` would never once land.
     */
    group('A chip let go of over the button in front of a hidden box');
    {
      const { inBoxes, report } = await dropAt('/hidden', 'button', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the hidden input behind it takes the file', inBoxes.rs?.[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(inBoxes.rs));
      check('and it is reported as placed', report.placed.length === 1, JSON.stringify(report.placed));
    }

    group('A chip let go of on a drop zone that has no input at all');
    {
      const { report } = await dropAt('/dropzone-real', '#zone p', [filed('Jianwen-Ding-Resume.pdf')]);
      check('the zone is given the drop', report.placed.length === 1, JSON.stringify(report));
      /*
       * A zone gives nothing back to read, so what it did cannot be claimed.
       * This one does what Workday does — makes an input and keeps the file —
       * so it can be, and the report has to be able to tell the two apart.
       */
      const landed = await p.evaluate(() => [...(document.getElementById('made')?.files ?? [])].map((f) => f.name));
      check('and the page kept the file', landed[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(landed));
      check('so it is not hedged', report.placed[0]?.sure !== false, JSON.stringify(report.placed));
    }

    /*
     * And a box is taken at its word even when it was aimed at deliberately.
     * "I dropped it there" is not more reliable than the form saying what it
     * will take — a `.doc`-only box given a PDF rejects it on submit, and the
     * card would have said it went in.
     */
    /*
     * Workday, aimed at the button inside the zone — which is what a pointer
     * lands on, because the button is the only thing in there worth aiming
     * at. Reported against an Adobe application, which is Workday.
     *
     * Everything the drop has to get right is different here from
     * `/dropzone-real`: the pointer is on a `<button>`, the zone is two
     * ancestors up and is not a `<form>`, and there is no upload box anywhere
     * on the page until the drop creates one.
     */
    group('Workday: a chip let go of on the button inside the drop zone');
    {
      const { report } = await dropAt('/workday', '#pick', [filed('Jianwen-Ding-Resume.pdf')]);
      const landed = await p.evaluate(() => [...(document.getElementById('made')?.files ?? [])].map((f) => f.name));
      check('the zone gets the drop, from a press on the button inside it', landed[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(landed));
      check('and it is reported as placed', report.placed.length === 1, JSON.stringify(report));
      check('with nothing left homeless', report.unplaced.length === 0, JSON.stringify(report.unplaced));
    }

    /* And on the words inside it, which is the other half of that target. */
    group('Workday: let go of on the words rather than the button');
    {
      const { report } = await dropAt('/workday', '#zone p', [filed('Jianwen-Ding-Resume.pdf')]);
      const landed = await p.evaluate(() => [...(document.getElementById('made')?.files ?? [])].map((f) => f.name));
      check('the zone still gets it', landed[0] === 'Jianwen-Ding-Resume.pdf', JSON.stringify(landed));
      check('and it is reported as placed', report.placed.length === 1, JSON.stringify(report.placed));
    }

    group('A chip let go of on a box that will not take it');
    {
      const { report, inBoxes } = await dropAt('/doc-only', '#rs', [filed('Jianwen-Ding-Resume.pdf')]);
      check('nothing goes in', (inBoxes.rs?.length ?? 0) === 0, JSON.stringify(inBoxes.rs));
      check('and it says what the form will take', /\.doc/.test(report.unplaced[0]?.why ?? ''), report.unplaced[0]?.why ?? '');
    }

    group('A chip let go of somewhere that takes nothing');
    {
      const { report } = await dropAt('/menu', 'body', [filed('Jianwen-Ding-Resume.pdf')]);
      check('nothing is claimed', report.placed.length === 0, JSON.stringify(report.placed));
      check(
        'and it says so rather than going quiet',
        /no upload box where you dropped it/.test(report.unplaced[0]?.why ?? ''),
        report.unplaced[0]?.why ?? '',
      );
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
          /*
           * Underscores, which are the shape a person's own file arrives in.
           * `bundleFileName` writes hyphens, so everything the store made read
           * correctly — and `_` is a word character, so `\bresume\b` could
           * not see `resume_streamly` at all. The card strips `._-` to spaces
           * before matching and this did not, so the chip said "resume" and
           * pressing Attach files said "no box here asks for it" about the
           * same file. That is drag and Attach placing different things.
           */
          'Resume_Streamly.pdf',
          'Academic_Transcript.pdf',
          'Jianwen_Ding_Cover_Letter.pdf',
          // And the accented spellings, which were in the list and could never
          // match: the closing `\b` after `é` needs a word character, and a
          // full stop is not one.
          'résumé.pdf',
          'resumé.pdf',
        ].map((n) => [n, m.kindOf(n)]);
      }, { b: base });
      const want = [
        'resume', 'resume', 'letter', 'transcript', 'transcript', 'portfolio', 'other',
        'resume', 'transcript', 'letter', 'resume', 'resume',
      ];
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
