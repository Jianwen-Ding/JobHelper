/**
 * Putting a file into a form's upload box, from the card.
 *
 * The flat folder and the path beside it were the answer to "how do I attach
 * the resume this thing just built": point the portal's dialog at one place
 * and pick the file out of it. That is two clicks and a paste, every time,
 * and it is the same two clicks for the transcript that has not changed since
 * September.
 *
 * A content script can do better. `input.files` is settable from a
 * `DataTransfer`, so the file can go straight in — the page sees exactly what
 * it would have seen from the dialog, including the name, and the change
 * event it is listening for. Nothing about this bypasses a permission: the
 * bytes come from the user's own machine, through their own extension, into a
 * box they were about to fill in by hand.
 *
 * Two shapes to cover, and the second is why this is not four lines. Most
 * portals have a real `<input type="file">`, hidden behind a styled button or
 * not. Workday and several others have a drop zone that never had an input
 * until you use it, and listens for `drop`. The same `DataTransfer` serves
 * both.
 */

/**
 * Every root on the page, the shadow ones included.
 *
 * A plain `querySelectorAll` stops at a shadow boundary, and the gate on this
 * whole path — `looksLikeApplicationForm` in autofill.js — walks into them.
 * So a web-component form passed the gate on evidence from inside a shadow
 * root and then had every file refused for having no upload box, on the same
 * form where Autofill had just filled every text field. Measured: `{placed:
 * [], unplaced: [{why: "this page has no upload box the extension can
 * reach"}], boxes: 0}` against a host whose shadow root holds a labelled
 * resume input.
 */
function allRoots(root = document) {
  const roots = [root];
  for (const where of roots) {
    for (const el of where.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  return roots;
}

const deepAll = (selector, root = document) =>
  allRoots(root).flatMap((where) => [...where.querySelectorAll(selector)]);

/**
 * Whether the page has hidden this, as opposed to hiding the input itself.
 *
 * The ordinary way to build an upload control is a styled button and a file
 * input with `display:none` behind it, so refusing a hidden input throws away
 * almost every real target. What is worth refusing is a hidden *container*: a
 * closed modal, the "add another" prototype row, the mobile copy of a
 * responsive form. Those hold a complete, correctly labelled upload control
 * that nobody can see — and `boxFor` takes the first match in document order,
 * so the invisible one wins.
 *
 * Measured, with a `display:none` modal before the real box: `placed: [{where:
 * "decoy resume resume"}]`, `#decoy` holding the file and `#real` empty, under
 * a green "Attached Morgan-Testwell-Resume.pdf".
 */
function putAwayByThePage(input) {
  for (let el = input.parentElement; el; el = el.parentElement) {
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}

/** A file input that is actually on the page, hidden behind a button or not. */
function uploadBoxes(root = document) {
  return deepAll('input[type="file"]', root).filter((input) => {
    if (input.disabled) return false;
    /*
     * `isConnected` covers an input the page has detached, and
     * `putAwayByThePage` a container the page has hidden — see there.
     *
     * There used to be a third: `!input.closest('[hidden]')`, written for "an
     * input inside a hidden template". `closest` starts at the element
     * itself, so what it actually refused was every input carrying `hidden`
     * — and `<input type="file" hidden id="cv">` beside `<label for="cv">`
     * styled as the button is the *accessible* way to build an upload. It is
     * the same thing as the `display:none` the paragraph above exists to
     * allow, said in HTML instead of CSS. Measured on a form with one box of
     * each kind: one box found instead of two, the second file matched
     * nothing, went to whatever container looked like a drop area, and came
     * back reported as placed with the box still empty.
     *
     * Not replaced with an ancestors-only version, because there is nothing
     * left for it to do: `hidden` computes to `display: none`, so a container
     * carrying it is already refused by `putAwayByThePage` — and refused on
     * what the page actually renders, which is the better question. A page
     * that writes `[hidden] { display: block }` has un-hidden it, and the
     * attribute check would have gone on refusing a box somebody can see.
     */
    return input.isConnected && !putAwayByThePage(input);
  });
}

/**
 * A name or a label, flattened to the words in it.
 *
 * Two things were being matched raw that cannot be. Separators: `_` is a word
 * character, so `\bresume\b` cannot see `resume_streamly` — and a person's
 * own file is exactly where underscores come from, because `bundleFileName`
 * writes hyphens and everything the store made therefore read correctly. The
 * card has stripped `._-` to spaces since it was written, so the chip said
 * "resume" and Attach files said "no box here asks for it" about the same
 * file.
 *
 * And accents: `résumé` was in the list from the start and could never match,
 * because the closing `\b` after `é` wants a word character and `é` is not
 * one to an ASCII `\b`. A box labelled "Résumé" read as no kind at all.
 * Folding the diacritics away is simpler than teaching every pattern about
 * them, and it is what a reader does anyway.
 *
 * Exported because the card has to read a name the same way this does, or the
 * chip promises one thing and the placing does another.
 */
export function wordsOf(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[._-]+/g, ' ')
    .toLowerCase();
}

/**
 * An element's words as somebody reading it sees them.
 *
 * `textContent` joins text across element boundaries with nothing between,
 * and a framework renders no whitespace between elements — so a label and
 * the button after it read "cover letterattach", in which `\bcover
 * letter\b` finds nothing. Measured on two upload controls rendered that
 * way, labelled Resume and Cover Letter and named nothing else: both files
 * "no box here asks for it". Text from different nodes is kept apart here,
 * and a script's or stylesheet's is left out.
 */
function textOf(el) {
  if (!el) return '';
  const parts = [];
  const walk = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (!/^(SCRIPT|STYLE|NOSCRIPT)$/.test(n.parentElement?.tagName ?? '')) parts.push(n.nodeValue);
  }
  return parts.join(' ');
}

/**
 * What a box says about itself, without borrowing from its neighbours.
 *
 * Its own label, its name and id, whatever accessibility text it carries.
 * These belong to this control and nothing else.
 */
function namedBy(input) {
  /*
   * From this input's own root. A label inside a shadow root is not in the
   * document, and `document.querySelector` would miss it — or, worse, find a
   * different control's label that happens to share the id, since an id is
   * only unique within its own root.
   */
  const where = input.getRootNode?.() ?? document;
  const byFor = input.id ? where.querySelector?.(`label[for="${CSS.escape(input.id)}"]`) : null;
  const said = [
    input.name,
    input.id,
    input.getAttribute('aria-label'),
    input.getAttribute('data-qa'),
    input.getAttribute('data-automation-id'),
    byFor?.textContent,
    input.closest('label')?.textContent,
  ]
    .filter(Boolean)
    .join(' ');
  return wordsOf(said).replace(/\s+/g, ' ').trim();
}

/** Somewhere to type or choose, which a heading never holds. See `aroundIt`. */
const FIELDS = 'input:not([type="hidden"]), select, textarea';
/** And a choice drawn as a widget, which is a field all the same. */
const WIDGET_FIELDS = '[role="combobox"], [role="listbox"], [aria-haspopup="listbox"]';

/**
 * And the text around it, for the many controls that carry no label at all.
 *
 * Upload controls are routinely a heading, a line of help and a button —
 * "Resume/CV", then "Attach or drop files here" — with no label element
 * anywhere. Walking up and taking the text is the only way to read those.
 *
 * Bounded by the other boxes, which is the part that was wrong. Taking the
 * first ancestor under four hundred characters meant that on a form with
 * three upload controls in one `<form>`, every one of them "said" resume and
 * cover letter and transcript, because the ancestor it stopped at was the
 * form. Every box then looked equally right for every file and the matcher,
 * correctly, refused them all. An ancestor that holds another file input is
 * describing more than this one and is not this one's text.
 */
function aroundIt(input) {
  const clean = (text) => wordsOf(text).replace(/\s+/g, ' ').trim();

  let node = input;
  let holder = input.parentElement;
  let best = '';
  for (let up = 0; up < 4 && holder; up++, node = holder, holder = holder.parentElement) {
    /*
     * An ancestor holding another upload control is describing more than this
     * one, and its text is not this one's.
     *
     * Taking the first ancestor under four hundred characters meant that on a
     * form with three controls in one `<form>`, every one of them "said"
     * resume and cover letter and transcript. What is left at that point is
     * the heading immediately before the control, which is exactly how these
     * are built when they carry no label:
     *
     *     <h3>Transcript</h3>
     *     <button>Attach or drop files here</button>
     *     <input type="file" style="display:none">
     *
     * So the walk stops going up and looks back instead. Without this the two
     * controls on such a form are indistinguishable, and indistinguishable
     * means the transcript goes wherever the resume did not.
     */
    if (holder.querySelectorAll('input[type="file"]').length > 1) {
      /*
       * Gathered, not the first one. What sits immediately before the input
       * is the styled button — "Attach or drop files here" — which is short,
       * non-empty and says nothing, so stopping at it reads every control on
       * the page as identical. The heading is one or two siblings further
       * back. Bounded by the next control above, which is where this one's
       * description stops being this one's.
       */
      const said = [];
      let room = 200;
      for (let before = node.previousElementSibling; before && room > 0; before = before.previousElementSibling) {
        if (before.querySelector?.('input[type="file"]') || before.matches?.('input[type="file"]')) break;
        /*
         * A heading, not the page. Dropzone.js appends each zone's input to
         * the end of `<body>`, so what came "before" the first one was the
         * whole form — every heading on it — and a script's source. That
         * input said resume and cover letter both and took the resume, and
         * the input that belonged to the Cover Letter zone was it. Measured
         * against the real Dropzone 5 with that zone first: the resume held
         * by Cover Letter, reported "Attached". Code is not words, and
         * something holding fields of its own is a part of the form, which
         * a heading never is.
         */
        if (before.matches?.('script, style, template, noscript')) continue;
        if (before.matches?.(FIELDS) || before.querySelector?.(FIELDS)) break;
        /*
         * Nor a field drawn without a native control: BambooHR's Country is
         * a button opening a listbox, with only a hidden input behind it, so
         * the Resume box above "said" Country and the resume had nowhere to
         * go. See `WIDGET_FIELDS`.
         */
        if (before.matches?.(WIDGET_FIELDS) || before.querySelector?.(WIDGET_FIELDS)) break;
        const text = clean(textOf(before));
        if (!text) continue;
        said.unshift(text);
        room -= text.length;
      }
      /*
       * What this box's own holder said first, when it names a document: it
       * is this box's alone, which a look back past it never is.
       */
      if (best && kindOf(best) !== 'other') return best;
      if (said.length > 0) return said.join(' ');
      break;
    }
    const text = clean(textOf(holder));
    if (text && text.length < 400) best = text;
  }
  return best;
}

/** Everything that might say what this box wants, nearest first. */
function saysWhat(input) {
  return `${namedBy(input)} ${aroundIt(input)}`.trim();
}

/**
 * The part of the page that is this box's upload widget, as far as can be
 * told from outside it.
 *
 * Workday's is the case this is for: a drop zone holding a hidden input, and
 * the list of files it has taken drawn *beside* the zone, not in it — on
 * `change` it keeps the file, clears the input and writes a
 * `file-upload-successful` row a level up. Read off the input's parent, that
 * was an empty box and no name: judged refused, so the same file went to the
 * same box again through the several-files route and then the drop area,
 * and the widget listed the resume twice under "the drop area, not sure".
 *
 * Bounded the way `aroundIt` bounds its walk — four levels, and never an
 * ancestor holding another upload box — and tighter still, because what is
 * read here is a claim about *this* box: not the form or the page, and not a
 * region that has other fields in it. A name in the page's prose, or in the
 * next widget along, is not this box saying it has the file. Null when even
 * the parent is past those bounds, which means there is nothing to read.
 */
const OTHER_FIELDS = 'input:not([type="hidden"]):not([type="file"]), select, textarea';

/*
 * A choice among documents the site already has, which is not a field.
 *
 * LinkedIn's Easy Apply draws the Resume step as a list of the resumes
 * uploaded before — each a card with the file's name, the date it was last
 * used, a download button and a radio drawn as a circle — and the "Upload
 * resume" button with the real input under the list. Those radios are how the
 * widget says which upload goes with this application: they are part of the
 * upload control, not a question of the form's. Read as fields, they walled
 * the input off from everything above it, so a chip let go of anywhere on the
 * list — the biggest thing in the section and the obvious place to aim — was
 * "no upload box where you dropped it"; and every card has "upload" in its
 * class, so a drop on a card went to the card as a drop area and came back
 * "went to this form's drop area, which does not say whether it took it",
 * about a card that has no drop handler at all.
 *
 * Told by what the choice says: a radio or checkbox whose own option — the
 * nearest few ancestors that hold no other choice and no upload box — names a
 * file. "Yes" and "No" never do.
 */
const NAMES_A_FILE = /[^\s\\/]\.(pdf|docx?|odt|rtf|txt|pages)\b/i;

function optionOf(input) {
  if (!(input instanceof HTMLInputElement) || !/^(radio|checkbox)$/.test(input.type)) return null;
  const own = `${input.getAttribute('aria-label') ?? ''} ${input.labels ? [...input.labels].map(textOf).join(' ') : ''}`;
  if (NAMES_A_FILE.test(own)) return input.parentElement ?? input;
  for (let holder = input.parentElement, up = 0; holder && up < 4; holder = holder.parentElement, up++) {
    if (holder.matches?.('form, body, html, dialog, [role="dialog"]')) return null;
    if (holder.querySelector('input[type="file"]')) return null;
    if ([...holder.querySelectorAll('input[type="radio"], input[type="checkbox"]')].some((x) => x !== input)) return null;
    if (NAMES_A_FILE.test(`${holder.getAttribute('aria-label') ?? ''} ${textOf(holder)}`)) return holder;
  }
  return null;
}

const choosesADocument = (input) => Boolean(optionOf(input));

/** Whether a region has a field in it that is somewhere to type or choose. */
const holdsAField = (region) =>
  [...(region.querySelectorAll?.(OTHER_FIELDS) ?? [])].some((field) => !choosesADocument(field));

/*
 * The upload widget around a box, wider than `sectionOf`: the documents it
 * offers to choose between as well, which is where LinkedIn draws a new
 * upload. Bounded as the rest are — never the form, a dialog, a region with
 * a real field in it or another box.
 */
function widgetOf(box) {
  let widget = null;
  for (let holder = box.parentElement, up = 0; holder && up < 6; holder = holder.parentElement, up++) {
    if (holder.matches?.('form, body, html, dialog, [role="dialog"]')) break;
    if (holder.querySelectorAll('input[type="file"]').length > 1) break;
    if (holdsAField(holder)) break;
    widget = holder;
  }
  return widget;
}

/** How many times this file's name is shown, as a whole name, in `text`. */
function timesNamed(text, name) {
  let n = 0;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const rest = text.slice(at + name.length, at + name.length + 2);
    if (!/[\w.-]/.test(before) && !/^([\w-]|\.\w)/.test(rest)) n += 1;
  }
  return n;
}

function sectionOf(box) {
  let section = null;
  for (let holder = box.parentElement, up = 0; holder && up < 4; holder = holder.parentElement, up++) {
    if (holder.matches?.('form, body, html, dialog')) break;
    if (holder.querySelectorAll('input[type="file"]').length > 1) break;
    if (holder.querySelector(OTHER_FIELDS)) break;
    section = holder;
  }
  return section;
}

/**
 * Whether `text` names this file, as a whole name. "Resume.pdf" is inside
 * "Old-Resume.pdf", and that is a different file — but the full stop that
 * ends a sentence after the name is not part of it.
 */
function names(text, name) {
  if (!name) return false;
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const rest = text.slice(at + name.length, at + name.length + 2);
    if (!/[\w.-]/.test(before) && !/^([\w-]|\.\w)/.test(rest)) return true;
  }
  return false;
}

/**
 * Whether this box's widget already shows this file as one it holds.
 *
 * Pressing Attach files twice on a widget that keeps files in its own list
 * uploaded every one of them again, each time, and said "Attached" again:
 * the input is empty after every placement, so there was never anything to
 * replace. The list the widget draws is the only record there is. A name
 * shown as a refusal is not one it holds — see `shownIn`.
 */
function alreadyShown(box, name) {
  /*
   * Not the list of earlier uploads that LinkedIn draws beside its box: the
   * one selected there may well carry this name — the store reuses it from
   * one application to the next — and be last month's version, tailored for
   * somebody else. Uploading again is what puts this one in. See `widgetOf`.
   */
  const section = sectionOf(box);
  if (!section?.isConnected) return false;
  return readShown(section, name) === 'kept';
}

/*
 * And whether it is *this* file, where that can be told: a rebuilt resume
 * keeps its name. A Greenhouse-style chip draws the name and leaves the file
 * in the input, so a second press after rebuilding found the name shown,
 * said "already attached" and left version one in the box. Where the input
 * still holds a file of that name it is compared, size and then bytes, and
 * replaced unless it is the same — and when it is the same, left alone even
 * where no name is drawn: putting it in again re-fires the box's `change`,
 * which on Jobvite uploads it again. Only a widget that cleared its input — the
 * name drawn, nothing left to compare — is taken at its word, as `unchecked`.
 *
 * 'same', 'unchecked', or null for a box this file is not already in.
 */
async function alreadyHeld(box, file) {
  const held = [...(box.files ?? [])].find((f) => f.name === file.name);
  if (held) {
    if (held.size !== file.size) return null;
    try {
      const [x, y] = await Promise.all([held.arrayBuffer(), file.arrayBuffer()]);
      const a = new Uint8Array(x);
      const b = new Uint8Array(y);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return null;
      return 'same';
    } catch {
      return null;
    }
  }
  return alreadyShown(box, file.name) ? 'unchecked' : null;
}

/**
 * What each kind of file answers to.
 *
 * Ordered, and read in order: a box labelled "Resume or Cover Letter" takes
 * the resume, because that is what somebody uploading one file to it means.
 */
const WANTS = {
  resume: /\b(resume|cv|curriculum vitae|lebenslauf)\b/,
  letter: /\b(cover letter|covering letter|motivation letter|anschreiben|motivationsschreiben|bewerbungsschreiben|lettre de motivation)\b/,
  transcript: /\b(transcript|academic record|grade report|marksheet)\b/,
  portfolio: /\b(portfolio|work sample|writing sample|publication)\b/,
};

/**
 * What a box is for when it is not for a document at all.
 *
 * An application form routinely has an upload control that has nothing to do
 * with the documents: a profile photo, a headshot, a company logo, a scan of
 * an identity document. `aroundIt` reads the text near a control, and on a
 * form with one such control and a drop zone for the real resume, the photo
 * input's surroundings included the word "Resume" — so the resume went into
 * the avatar box and the report said, in green, "Attached
 * Morgan-Testwell-Resume.pdf". Measured: `#ph` holding the resume, zero drop
 * events at the zone.
 *
 * Read off the control's *own* name only. The text around it is the thing
 * that was wrong, and a box that calls itself a photo is not a box for a
 * resume however the form is laid out.
 */
const NOT_A_DOCUMENT = /\b(photo|photograph|headshot|avatar|picture|image|logo|selfie)\b/;

/**
 * And what a box will actually take, when it says.
 *
 * `accept=".doc,.docx"` on a box labelled "Resume (.doc or .docx only)" is
 * the form saying it will not have a PDF. Putting one in anyway is placed,
 * reported as attached, and refused by the portal at submit — after the
 * person has stopped checking.
 */
function willTake(input, file) {
  const accept = (input.getAttribute('accept') ?? '').trim();
  if (!accept) return true;
  const name = String(file?.name ?? '').toLowerCase();
  const type = String(file?.type ?? '').toLowerCase();
  return accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((want) => {
      if (want === '*/*') return true;
      if (want.startsWith('.')) return name.endsWith(want);
      if (want.endsWith('/*')) return type.startsWith(want.slice(0, -1));
      /*
       * "pdf,doc,docx": an extension without its dot. Not what the
       * specification allows, and the browser's own dialog ignores such a
       * token — so read as a MIME type it refused a PDF from a box that
       * would have taken one, with "this form only takes pdf,doc,docx
       * there". Read as what it plainly means instead.
       */
      if (!want.includes('/')) return name.endsWith(`.${want}`);
      return type === want;
    });
}

/**
 * Which of the kinds above a file is, from the name it will be uploaded as.
 *
 * The last kind named, not the first in `WANTS` order. The store writes the
 * kind at the end — `Name-Role-Cover-Letter.pdf` — and the role sits before
 * it, so a role of "Computer Vision (CV) Engineer" read both the resume and
 * the letter as resumes: the letter went in the resume box, or nowhere.
 * Whatever kind word comes last is the one that names the document.
 */
export function kindOf(name) {
  const text = wordsOf(name);
  let found = 'other';
  let end = -1;
  for (const [kind, pattern] of Object.entries(WANTS)) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const at = match.index + match[0].length;
      if (at > end) {
        end = at;
        found = kind;
      }
    }
  }
  return found;
}

/** Where a kind comes in `WANTS`: the resume first, anything unnamed last. */
function priorityOf(kind) {
  const at = Object.keys(WANTS).indexOf(kind);
  return at < 0 ? Object.keys(WANTS).length : at;
}

/** Files in the order they should be offered a box: see `attachFiles`. */
function byPriority(files) {
  return [...(files ?? [])]
    .map((spec, i) => ({ spec, i, rank: priorityOf(kindOf(spec?.name)) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ spec }) => spec);
}

/**
 * The box this file belongs in, or nothing.
 *
 * Deliberately refuses rather than guessing. Putting a transcript in the
 * resume box is worse than attaching nothing: the form looks filled in, and
 * the thing an employer opens first is the wrong document. So a file with no
 * box that asks for it is reported as unplaced and the person is told.
 */
function boxFor(kind, boxes, taken, file) {
  const pattern = WANTS[kind];
  if (!pattern) return null;

  const free = boxes.filter(
    (b) =>
      !taken.has(b) &&
      // A box that calls itself a photo is not this document's, whatever the
      // text around it says. See `NOT_A_DOCUMENT`.
      !NOT_A_DOCUMENT.test(namedBy(b)) &&
      // And a box that has said what it takes is taken at its word.
      willTake(b, file),
  );
  /*
   * A box about this and nothing else, before one that mentions two things.
   *
   * "Resume and cover letter (one PDF)" matches both patterns, and a form
   * that has it usually has a plainer cover-letter box further down. Taking
   * the first match in document order gave the shared box to the resume and
   * left the letter with nothing, while the box that was only ever the
   * letter's sat empty. So the unambiguous ones are offered first, and the
   * shared box is what is left for whichever kind still needs one — which,
   * because `WANTS` is ordered with the resume first, is the resume.
   */
  const only = free.filter((b) => {
    const text = saysWhat(b);
    return pattern.test(text) && !Object.entries(WANTS).some(([k, p]) => k !== kind && p.test(text));
  });
  return only[0] ?? free.find((b) => pattern.test(saysWhat(b))) ?? null;
}

/**
 * A real File, from bytes the worker fetched off the store.
 *
 * Throws on an empty one, which the caller reports rather than attaches. A
 * zero-byte body is what a file still being written looks like — the folder
 * is streamed to as each document is built — and nothing downstream noticed:
 * `atob('')` makes a `File` of size 0, `putIn` sees one file in the box and
 * says so, and the card says "Attached Morgan-Testwell-Resume.pdf" over an empty
 * PDF that an employer opens to nothing.
 */
function fileFrom({ name, base64, type }) {
  const binary = atob(base64);
  if (binary.length === 0) throw new Error('empty');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type: type || 'application/pdf' });
}

/**
 * Put one file in one box, the way a file dialog would.
 *
 * `input.files` is assignable from a `DataTransfer`'s `FileList` and from
 * nothing else — a plain array is silently ignored, which is the trap here.
 * Then the events: `input` and `change`, both bubbling, because a React form
 * listens for one and a plain one for the other, and a form that never hears
 * either shows the box still empty however correct `files` is.
 */
async function putIn(box, file, { alongside = false, ours } = {}) {
  const carrier = new DataTransfer();
  /*
   * What it is already holding, and whose it is.
   *
   * Replacing is what a one-item `DataTransfer` does, and on a box labelled
   * "resume, cover letter and transcript" that would leave only whichever
   * file happened to be last — so the second and third placements into one
   * box come through `alongside`.
   *
   * The first one still replaces, and that is deliberate: it is what keeps
   * pressing Attach files twice from stacking up two of everything. But it
   * replaced *everything*, including a file the person had attached
   * themselves through the portal's own dialog — which the card all but
   * invites, since it says "No transcript in the folder" and offers to add
   * one. Their transcript went, silently: nothing in `unplaced`, and a green
   * "Attached …-Resume.pdf and …-Cover-Letter.pdf" over a box that had held
   * three documents and now held two.
   *
   * So the first placement clears *our* files and keeps theirs. `ours` is
   * every name this run is placing, which is exactly the set a re-press needs
   * to clean up after itself.
   *
   * Only where the box takes several. A single-file input holding one of
   * theirs has no room to keep it, and handing two files to a non-`multiple`
   * input is not a thing a page would accept anyway.
   */
  /*
   * A box that takes one file is not given a second. Handing two to a
   * non-`multiple` input is accepted by the browser and refused by the form,
   * and the first one — the one somebody aimed at it — is what gets lost.
   * Callers check first so they can say why; this is the backstop.
   */
  if (alongside && !box.multiple) return false;
  const held = [...(box.files ?? [])];
  const had = alongside ? held : box.multiple ? held.filter((f) => !ours?.has(f.name)) : [];
  for (const already of had) carrier.items.add(already);
  carrier.items.add(file);
  try {
    box.files = carrier.files;
  } catch {
    // Some frameworks define `files` as a getter on the element. Nothing can
    // be done from here; the caller reports it as unplaced.
    return false;
  }
  if (box.files?.length !== had.length + 1) return false;
  // Where the widget would say it has the file, noted before it gets a vote.
  //
  // And the widget's whole section, for the ones that draw the list beside
  // the drop zone rather than in it. See `sectionOf`.
  const homes = [
    box.closest?.('label, [class*="upload" i], [class*="drop" i], [class*="file" i], [class*="attach" i]') ??
      box.parentElement,
    sectionOf(box),
  ].filter(Boolean);
  /*
   * And how often the name is already shown across the whole widget, the
   * list of earlier uploads included, so that a *new* one can be told from
   * an old one. LinkedIn takes the file, empties the box, and draws the
   * upload as a new card at the top of its list of resumes — outside both
   * places above. Read only there, that was "the page would not let that
   * box take a file" over a resume LinkedIn had just uploaded and selected.
   * Counted rather than looked for, because that list routinely already
   * holds a file of the same name from an earlier application.
   */
  const widget = widgetOf(box);
  const grew = widget ? { widget, before: timesNamed(textOf(widget), file.name) } : null;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  /*
   * And what is still true once the page has had its say.
   *
   * A `change` handler runs synchronously inside that dispatch, and two
   * ordinary things it does both undo what was just checked above: reject
   * the file by clearing the box — the client-side "too large" or
   * "wrong kind" check every upload widget has — or replace the input
   * outright to reset itself, which is how a form built to show a removable
   * chip instead of the native control works. Either way `box` is left
   * looking exactly as it did the instant before `dispatchEvent`, and
   * without this the caller had already decided "placed" on evidence from
   * before the page got a vote. Measured on a page that clears the input on
   * `change`: reported as attached, the box empty.
   */
  if (box.isConnected && [...(box.files ?? [])].some((f) => f.name === file.name)) return true;
  /*
   * Unless the widget took it for itself. Plenty of upload components read
   * the file on `change`, keep it in their own state, and clear the input
   * straight after so the same file can be chosen again — and then show it
   * as a chip with its name. An empty input there means kept, not refused;
   * the name appearing where the box was is the widget saying so.
   *
   * Unless it is saying no. A widget that refuses a file clears the box too,
   * and names the file while it explains: "Morgan-Testwell-Resume.pdf is larger
   * than the 1 MB limit", or Dropzone's preview drawn with the name and
   * marked `dz-error`. Read as a chip, that was "Attached" over an empty box
   * and a red message. A name inside something marked as an error or an
   * alert is a refusal.
   */
  return (await shownIn(homes, file.name, grew)) === 'kept';
}

/**
 * What a widget that took the file for itself goes on to say about it.
 *
 * Not always at once. Greenhouse's board takes the input away inside the
 * `change` handler, draws a progress bar while it sends the file to its own
 * storage, and only then writes the name — measured on Stripe's embed, 500ms
 * after the event, with nothing but `role="progressbar"` in the box until
 * then. Read synchronously that was an empty box and no name, reported as
 * "the page would not let that box take a file" over a form that went on to
 * show the file attached.
 *
 * So a moment's grace for any widget, and as long as an upload is visibly
 * running for one that says it is uploading — bounded, because an upload can
 * stall, and a stalled one has not been kept.
 */
const SHOWN_GRACE_MS = 1000;
const UPLOAD_WAIT_MS = 20_000;
const UPLOADING = '[role="progressbar"], progress, [aria-busy="true"], [class*="progress" i], [class*="uploading" i]';

/** One look at one place: see `shownIn`. */
function readShown(home, name) {
  if (!home.isConnected) return 'gone';
  const refusing = home.querySelectorAll('[role="alert"], [class*="error" i], [class*="invalid" i]');
  // `textOf`, not `textContent`: "Resume" in a label and the name in the
  // chip after it run together as "ResumeMorgan-…-Resume.pdf" otherwise.
  if ([...refusing].some((el) => names(textOf(el), name))) return 'refused';
  if (names(textOf(home), name)) return 'kept';
  return home.querySelector(UPLOADING) ? 'uploading' : 'nothing';
}

/*
 * Several places, read together: a refusal anywhere wins, then the name
 * anywhere, then an upload still running anywhere.
 */
async function shownIn(homes, name, grew = null) {
  const read = () => {
    const seen = homes.map((home) => readShown(home, name));
    // A new mention of it in the widget: kept, unless what mentions it is a refusal. See `putIn`.
    if (grew?.widget.isConnected) {
      if (readShown(grew.widget, name) === 'refused') seen.push('refused');
      else if (timesNamed(textOf(grew.widget), name) > grew.before) seen.push('kept');
    }
    for (const answer of ['refused', 'kept', 'uploading', 'nothing']) if (seen.includes(answer)) return answer;
    return 'gone';
  };
  const began = Date.now();
  for (;;) {
    const now = read();
    if (now === 'kept' || now === 'refused' || now === 'gone') return now;
    const waited = Date.now() - began;
    if (waited >= (now === 'uploading' ? UPLOAD_WAIT_MS : SHOWN_GRACE_MS)) return now;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * And for the drop zones that have no input until you use one.
 *
 * Workday's is the common case: a region with `ondrop` wired and a file input
 * that only exists once a file has been chosen. Dispatching the three events
 * a real drag produces, with the same `DataTransfer`, is what the page is
 * listening for.
 *
 * Then it waits to see whether anything came of it, because unlike
 * `input.files` there is nothing to read back: a drop is an event, and an
 * event that nobody handled looks exactly like one that worked. A page that
 * took the file ends up with an input holding it, which is something that can
 * be checked. A page that uploaded it straight over the network does not, so
 * the answer is "not sure" rather than "no" — and the caller says so rather
 * than claiming it landed.
 */
async function dropOn(zone, file) {
  const carrier = new DataTransfer();
  carrier.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) {
    zone.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: carrier }),
    );
  }
  const landed = () => uploadBoxes().some((b) => [...(b.files ?? [])].some((f) => f.name === file.name));
  for (let i = 0; i < 8; i++) {
    if (landed()) return 'sure';
    await new Promise((r) => setTimeout(r, 60));
  }
  return landed() ? 'sure' : 'unsure';
}

/**
 * The words that mean a region takes files, on their own rather than inside
 * another word.
 *
 * This was `/drag|drop|attach/` without boundaries, and `drop` is inside
 * `dropdown` — which is on some element of nearly every page on the web. So
 * an ordinary page with an account menu and no upload box anywhere reported
 * the resume as attached, having dispatched a drop event at a menu.
 * Measured: `{canAttach: true, placed: [{name: "…Resume.pdf", where: "the
 * drop area"}], boxes: 0}`. Telling somebody their resume is in the form when
 * it is nowhere is the worst thing this file can do — worse than refusing,
 * because they submit on the strength of it.
 */
const DROP_WORDS = /\b(drag|drop|dropzone|attach|upload)\b/i;

/** A region that behaves like a drop target, for a file with no box to go in. */
function dropZones(root = document) {
  /*
   * Not a card in a list of documents to choose between, nor the list. Every
   * one of LinkedIn's is classed `jobs-document-upload-redesign-card…`, and
   * none of them takes a drop: see `optionOf`.
   */
  const options = deepAll('input[type="radio"], input[type="checkbox"]', root).map(optionOf).filter(Boolean);
  const found = deepAll('div,section,label,form', root).filter((el) => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
    if (options.some((o) => o.contains(el) || el.contains(o)) && !el.querySelector('input[type="file"]')) return false;
    /*
     * `className` is not a string on an SVG element — it is an
     * `SVGAnimatedString`, which stringifies to `[object SVGAnimatedString]`
     * and matches nothing, quietly. `getAttribute` is the same answer for
     * every kind of element.
     */
    const named = [el.getAttribute('aria-label'), el.getAttribute('data-automation-id'), el.getAttribute('class')]
      .filter(Boolean)
      .join(' ');
    if (DROP_WORDS.test(named)) return true;
    /*
     * And its own words, for the zones that carry no class worth reading:
     * "Drag and drop your resume here, or browse". Short, because a page that
     * says "attach" somewhere in a paragraph of prose is not a drop target,
     * and `drag` or `drop` specifically — an "Attach" button is a trigger for
     * the file dialog, and dropping on it does nothing at all.
     */
    const text = (el.textContent ?? '').trim();
    return text.length < 120 && /\b(drag|drop)\b/i.test(text);
  });
  /*
   * Innermost first. A drop handler is usually on the zone itself and a drop
   * bubbles upwards, so the deepest match reaches every handler above it as
   * well; the outermost reaches only its own.
   */
  return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
}

/**
 * What a drop area is for: its own words, and the heading over it.
 *
 * Read off the zone's text alone, which on Workday is "Drag and drop files
 * here, Select files" — the "Resume/CV" is a heading outside it. So no zone
 * ever named a kind, and on a page with no input yet every file went to the
 * first zone in the document. Measured with a Cover Letter section above a
 * Resume/CV one: the resume and the letter both dropped on Cover Letter, and
 * both reported attached. The walk up stops where it would reach another
 * zone, as `aroundIt` stops at another box.
 */
function zoneSays(zone, zones) {
  const clean = (text) => wordsOf(text).replace(/\s+/g, ' ').trim();
  let said = clean(`${zone.getAttribute('aria-label') ?? ''} ${textOf(zone)}`);
  /*
   * Nor past a holder with other fields in it. Breezy's one "Upload Resume"
   * zone sits in a form with a Cover Letter text box, and four levels up was
   * that form: the zone "said" cover letter, and the letter was dropped on
   * the resume's zone in place of the resume. As `sectionOf` bounds a box.
   */
  const outside = (el) => !zone.contains(el);
  for (let holder = zone.parentElement, up = 0; holder && up < 4; holder = holder.parentElement, up++) {
    if (zones.some((z) => z !== zone && holder.contains(z))) break;
    if (holder.matches?.('form, body, html, dialog')) break;
    if ([...holder.querySelectorAll(`${OTHER_FIELDS}, input[type="file"]`)].some(outside)) break;
    const text = clean(textOf(holder));
    if (text && text.length < 400) said = text;
  }
  return said;
}

/**
 * Attach what the card has to whatever this page asks for.
 *
 * Reports rather than throws, and reports per file: a form with a resume box
 * and no transcript box is ordinary, and the answer to it is a sentence, not
 * a failure. The card shows what landed and what did not.
 *
 * @param {{name: string, base64: string, type?: string}[]} files
 */
/**
 * Which documents this form is asking for, from its own upload boxes.
 *
 * So the card can say "this one wants a transcript" beside the transcript,
 * rather than leaving somebody to read the form twice. Read from the boxes
 * and what is written around them — the same words `boxFor` places by, so
 * what the card promises and what an attach actually does cannot disagree.
 *
 * This document only. A form split across an embed is ordinary and its boxes
 * are not reachable from here, so the answer is "what I can see", never "what
 * there is": a kind found here is a kind the form definitely wants, and a
 * kind not found means nothing at all. The card treats it that way — it adds
 * a mark, and never takes a file away.
 */
export function documentsWanted() {
  const boxes = uploadBoxes();
  const kinds = new Set();
  let unnamed = 0;
  for (const box of boxes) {
    const said = saysWhat(box);
    if (NOT_A_DOCUMENT.test(namedBy(box))) continue;
    let named = false;
    for (const [kind, pattern] of Object.entries(WANTS)) {
      if (pattern.test(said)) {
        kinds.add(kind);
        named = true;
      }
    }
    if (!named) unnamed += 1;
  }
  // A box that names nothing takes whatever it is given — see `saysNothing`
  // — so it is not evidence about any one kind, and is counted rather than
  // guessed at.
  return { kinds: [...kinds], boxes: boxes.length, unnamed };
}

export async function attachFiles(files) {
  const boxes = uploadBoxes();
  const taken = new Set();
  const placed = [];
  const unplaced = [];
  /*
   * Every name this run is placing, and which boxes it has already written
   * to. Together they tell a file of ours from a file of theirs, and a first
   * placement into a box from a second. See `putIn`.
   */
  const ours = new Set((files ?? []).map((f) => f?.name).filter(Boolean));
  const written = new Set();
  /*
   * And which boxes each file has been handed to, kept or not.
   *
   * A box that took the file and drew it somewhere this could not see was
   * judged to have refused it, and every route below then tried again: the
   * several-files box was the same box, and the drop area was the zone
   * around it — so the widget listed the resume two or three times. A file
   * goes to a box once per press; a box that had it and said nothing is
   * answered for by the first try, not by a second.
   */
  let tried = new Set();
  const placeIn = async (box, file) => {
    tried.add(box);
    const ok = await putIn(box, file, { alongside: written.has(box), ours });
    if (ok) written.add(box);
    return ok;
  };
  /** Whether a drop area belongs to a box this file has already been handed to. */
  const triedAround = (zone) =>
    [...tried].some((box) => {
      const section = sectionOf(box);
      return zone.contains(box) || (section && (section.contains(zone) || zone.contains(section)));
    });

  /*
   * The resume first, then the letter, and so on down `WANTS`.
   *
   * The store lists files alphabetically, so "…-Cover-Letter.pdf" always came
   * before "…-Resume.pdf" — and on a form with one box that names nothing,
   * the fallback below gave that box to whichever file reached it first. The
   * letter went in, the resume was left out, every time. A lone box is the
   * resume's; the order here is what says so.
   */
  for (const spec of byPriority(files)) {
    let file;
    try {
      file = fileFrom(spec);
    } catch (err) {
      unplaced.push({
        name: spec?.name ?? 'a file',
        why: String(err?.message) === 'empty' ? 'it came back empty from the store' : 'it could not be read',
      });
      continue;
    }

    const kind = kindOf(spec.name);
    tried = new Set();
    /*
     * Already there: a box that would take this file is showing it. Said so,
     * and left alone — a second copy is not what a second press means. Only
     * a box this kind could go in (one that names it, or names nothing), and
     * only that box's own section, so a name in some other widget or in the
     * page's own text says nothing here. Asked as `boxFor` asks but of every
     * box, taken or not: one this file filled on an earlier press is exactly
     * the one to look in.
     */
    const homeFor = boxFor(kind, boxes, new Set(), file);
    const candidates = (
      homeFor
        ? [homeFor]
        : boxes.filter(
            (b) =>
              !NOT_A_DOCUMENT.test(namedBy(b)) &&
              willTake(b, file) &&
              (kindOf(saysWhat(b)) === 'other' || (b.multiple && WANTS[kind]?.test(saysWhat(b)))),
          )
    );
    let shownBy = null;
    let held = null;
    for (const b of candidates) {
      held = await alreadyHeld(b, file);
      if (held) {
        shownBy = b;
        break;
      }
    }
    if (shownBy) {
      // A one-file box with this in it has no room for anything else; a box
      // that takes several is added to from here on, not cleared.
      if (!shownBy.multiple) taken.add(shownBy);
      written.add(shownBy);
      placed.push({ name: spec.name, where: saysWhat(shownBy).slice(0, 60), already: true, ...(held === 'unchecked' ? { unchecked: true } : {}) });
      continue;
    }
    const box = boxFor(kind, boxes, taken, file);
    /*
     * A box was found for this file, which the reason at the bottom of this
     * loop needs to know even when `placeIn` fails: without it, a box that
     * took the file and then rejected it — see `putIn` — read no differently
     * from a form with no such box at all, and said so: "no box here asks
     * for it", about a box sitting right there under a label that named it.
     */
    let rejectedBy = null;
    if (box) {
      if (await placeIn(box, file)) {
        taken.add(box);
        placed.push({ name: spec.name, where: saysWhat(box).slice(0, 60) });
        continue;
      }
      rejectedBy = box;
    }

    /*
     * One box that says nothing is not ambiguous. One box that says Resume
     * is not this transcript's.
     *
     * Plenty of forms have exactly one upload control and no word anywhere
     * near it — the heading two divs up says "Application" and that is all,
     * and with one file to place there is nothing to get wrong. But this
     * asked only how *many* boxes there were, never what the one box said,
     * so on a form asking for a resume and nothing else the transcript took
     * the resume box whenever the store happened to list it first. Measured:
     * `placed: [{name: "Transcript.pdf", where: "the only upload box on the
     * page"}]`, `#rs` holding the transcript, the resume reported as having
     * nowhere to go — which is exactly the failure this file's header says it
     * exists to prevent, arriving through the fallback.
     *
     * So the fallback is for a box that asks for nothing in particular. A box
     * that named a kind has already been offered to that kind by `boxFor`.
     */
    const free = boxes.filter((b) => !taken.has(b));
    const saysNothing = free.length === 1 && kindOf(saysWhat(free[0])) === 'other' && !NOT_A_DOCUMENT.test(namedBy(free[0]));
    if (saysNothing && (files.length === 1 || boxes.length === 1) && willTake(free[0], file) && (await placeIn(free[0], file))) {
      taken.add(free[0]);
      placed.push({ name: spec.name, where: 'the only upload box on the page' });
      continue;
    }

    /*
     * A box that takes several, when it has said so and said what it wants.
     *
     * "Attach your resume, cover letter and transcript" over one `multiple`
     * input is an ordinary way to build the short version of a form, and
     * every file after the first came back "no box here asks for it" — on a
     * box that had named it. Added to what the box already holds rather than
     * replacing it, which is what `multiple` means.
     */
    const several = boxes.find(
      (b) =>
        b.multiple &&
        !tried.has(b) &&
        WANTS[kind]?.test(saysWhat(b)) &&
        willTake(b, file) &&
        !NOT_A_DOCUMENT.test(namedBy(b)),
    );
    if (several && (await placeIn(several, file))) {
      placed.push({ name: spec.name, where: saysWhat(several).slice(0, 60) });
      continue;
    }

    /*
     * The drop area, when there is no box for this file anywhere.
     *
     * Not only when the page has no box at all, which was the old test: a
     * form with one unrelated control — a profile photo — and a real drop
     * zone for the resume has `boxes.length === 1`, so the zone was never
     * tried and the resume went into the avatar box instead. But only when
     * the zone says it wants this kind, or there is no box on the page at
     * all: a zone beside a resume box is the resume's, and dropping a
     * transcript on it is the same wrong-document failure by another route.
     * With no box, still only a zone that names no other kind — see
     * `zoneSays`.
     */
    // Not the one around a box that has just refused this file: it has had
    // its say, and a drop there came back as "not sure" about a known no.
    //
    // Nor any drop area that is part of a box this file was already handed
    // to: the zone around it, or the list it draws beside it.
    //
    // Nor one holding a box this run has already filled — with another file:
    // that zone is the other file's, and a drop there replaces it.
    const filled = [...taken, ...written];
    const zones = dropZones().filter(
      (z) => !(rejectedBy && z.contains(rejectedBy)) && !triedAround(z) && !filled.some((b) => z.contains(b)),
    );
    const zone =
      zones.find((z) => WANTS[kind]?.test(zoneSays(z, zones))) ??
      (boxes.length === 0 ? zones.find((z) => kindOf(zoneSays(z, zones)) === 'other') : undefined);
    /*
     * Already there: a zone whose widget took the file on an earlier press
     * and then took its input away too (Workable, Rippling) shows the name
     * and nothing else — so a second press dropped it again. Only the name
     * to go by, so said as `unchecked`: see `alreadyHeld`.
     */
    const zoneShows = zone && [zone, sectionOf(zone)].some((home) => home && readShown(home, spec.name) === 'kept');
    if (zoneShows) {
      placed.push({ name: spec.name, where: 'the drop area', already: true, unchecked: true });
      continue;
    }
    if (zone) {
      /*
       * Said as what it is. A drop cannot be read back the way `input.files`
       * can, so "sure" means a box on the page is now holding this file and
       * "unsure" means the event was delivered and nothing visible came of
       * it — which is what a page that uploads over the network looks like,
       * and also what a page that ignored it looks like. The card words the
       * two differently; claiming both is how somebody submits a form with
       * no resume in it.
       */
      placed.push({ name: spec.name, where: 'the drop area', sure: (await dropOn(zone, file)) === 'sure' });
      continue;
    }

    /*
     * And why, in the words the person can act on.
     *
     * "No box here asks for it" is the right sentence for a form with no
     * transcript box, and the wrong one when the box is on screen in front of
     * them saying Resume — which is what a box asking for `.doc` produces.
     * Naming what the form will take turns a puzzle into a decision: they
     * export a Word copy, or upload it by hand from the folder.
     */
    const refusedType = boxes.find(
      (b) => WANTS[kind]?.test(saysWhat(b)) && !NOT_A_DOCUMENT.test(namedBy(b)) && !willTake(b, file),
    );
    unplaced.push({
      name: spec.name,
      why: rejectedBy
        ? 'this form took it and then would not keep it'
        : refusedType
          ? `this form only takes ${refusedType.getAttribute('accept')} there`
          : boxes.length === 0 && zones.length === 0
            ? 'this page has no upload box the extension can reach'
            : 'no box here asks for it',
    });
  }

  return { placed, unplaced, boxes: boxes.length };
}

/**
 * Put files where the pointer let go of them.
 *
 * The chips on the card are draggable and the drag never carried anything.
 * Measured on a bare page with no extension involved — a `<div>` whose
 * `dragstart` adds a real `File` to `event.dataTransfer`, dropped on a zone
 * that reads it back:
 *
 *   types:  ["text/plain"]      <- no "Files"
 *   files:  []
 *   items:  [{kind: "string", type: "text/plain"}]
 *
 * Chromium will not carry a script-made `File` in a drag a page starts, and
 * it is right not to: a drag can leave the browser, and a page that could put
 * files in one could write to the desktop. Dragging the same document out of
 * a file manager works because that drag is native and this one never can be.
 * So the bytes went into the carrier, the browser threw them away, and the
 * form saw a plain-text drag it ignored. The card said "Drag any of these
 * into the form" about something that has never once worked.
 *
 * What does work is for the extension to take the drop itself: the content
 * script cancels it, reads where the pointer was, and places the file the way
 * `attachFiles` places one. Nothing here is a trick the page can tell from a
 * dialog — the same `input.files` write and the same events.
 *
 * `target` is whatever was under the pointer, which is almost never the box:
 * it is the styled button in front of a hidden input, a label, the text
 * inside a drop zone. So it is walked outwards to the nearest thing that
 * takes files, and only then outwards to the page as a whole.
 */
/** A button that moves a form along, rather than one that belongs to a field. */
const MOVES_ON = /^(next|back|previous|continue|review|submit|submit application|apply|send|save and continue)$/i;
const movesOn = (button) =>
  MOVES_ON.test((button.value || textOf(button)).replace(/\s+/g, ' ').trim()) ||
  MOVES_ON.test((button.getAttribute('aria-label') ?? '').replace(/ to (the )?(next|previous) step$/i, '').trim());

export async function dropOnto(target, files) {
  const placed = [];
  const unplaced = [];
  const boxes = uploadBoxes();

  /*
   * What the pointer was over, in the order a person would mean it.
   *
   * The box under the pointer first, then a box inside what is under the
   * pointer — a drop on the panel around a single input means that input.
   * Only when neither is there is the drop read as a drop on a zone.
   */
  /*
   * Only as far as the upload widget the pointer is in.
   *
   * The walk used to run to `<body>`, and on a page with one upload box
   * every ancestor eventually "contains exactly one box" — so a chip let go
   * of anywhere at all went into that box. Measured: the cover letter
   * dropped on the "paste your cover letter" textarea replaced the resume
   * already in the resume box. So it stops at a text field (a drop there is
   * a drop on that field), at a region holding other fields, at a label for
   * something else, at a drop zone, and at the form itself.
   */
  const OTHER_FIELD = 'input:not([type="hidden"]):not([type="file"]), select, textarea';
  /*
   * A field, unless it is one of the upload widget's own choices between
   * documents — LinkedIn's list of earlier resumes, each with a radio. See
   * `optionOf`: a drop on that list is a drop on the resume's upload.
   */
  const aField = (el) => Boolean(el) && !choosesADocument(el);
  const near = (el) => {
    if (aField(el?.closest?.(OTHER_FIELD))) return null;
    if (el instanceof HTMLLabelElement && el.control && el.control.type !== 'file' && aField(el.control)) return null;
    for (let at = el; at; at = at.parentElement ?? at.getRootNode?.()?.host) {
      if (at instanceof HTMLInputElement && at.type === 'file' && boxes.includes(at)) return at;
      if (at instanceof HTMLLabelElement && at.control) {
        if (at.control.type === 'file') return boxes.includes(at.control) ? at.control : null;
        if (aField(at.control)) return null;
      }
      /*
       * The form, or the page: the whole of it is not one upload widget. Nor
       * a dialog — LinkedIn's Easy Apply is a `div[role=dialog]`, not a
       * `<dialog>` — nor anything holding a whole form, nor anything holding
       * the buttons that move the form along: the footer under Easy Apply's
       * step reaches, two levels up, a region with one upload box in it and
       * nothing else, and a chip let go of over Next is not a resume aimed at
       * the Resume section.
       */
      if (at.matches?.('form, body, html, dialog, [role="dialog"], [aria-modal="true"]')) return null;
      if (at.querySelector?.('form')) return null;
      if ([...(at.querySelectorAll?.('button, [role="button"], input[type="submit"]') ?? [])].some(movesOn)) return null;
      const inside = [...(at.querySelectorAll?.('input[type="file"]') ?? [])].filter((b) => boxes.includes(b));
      if (inside.length > 1) return null;
      // A region with other fields in it is a part of the form, not the box's.
      if ([...(at.querySelectorAll?.(OTHER_FIELD) ?? [])].some(aField)) return null;
      if (inside.length === 1) return inside[0];
      if (zones.includes(at)) return null;
    }
    return null;
  };

  const zones = dropZones();
  const box = target ? near(target) : null;
  /*
   * A drop area, when that is what the pointer was over — one the page has
   * marked as taking drops. Not just the nearest `<div>`: on a text field, or
   * a paragraph of the form, there is nothing to drop on and saying "placed,
   * not sure" about it would be a claim about nothing.
   */
  const zone = box || !target || target.closest?.(OTHER_FIELD) ? null : zones.find((z) => z.contains(target)) ?? null;
  /*
   * What the box is for, when it says one thing only. A file of another
   * known kind is refused rather than put there: "the letter in the resume
   * box" is the failure this file exists to prevent, however it was aimed.
   */
  const boxKinds = box ? Object.entries(WANTS).filter(([, p]) => p.test(saysWhat(box))).map(([k]) => k) : [];
  const boxKind = boxKinds.length === 1 ? boxKinds[0] : null;
  const KIND_WORDS = { resume: 'resume', letter: 'cover letter', transcript: 'transcript', portfolio: 'portfolio' };
  /*
   * The file the box asks for first, then the rest by `WANTS` order — so the
   * all-files chip let go of over a one-file resume box puts the resume in
   * it, not whichever the store listed first.
   */
  const ordered = byPriority(files).sort(
    (a, b) => Number(kindOf(b?.name) === boxKind) - Number(kindOf(a?.name) === boxKind),
  );
  const written = new Set();
  const ours = new Set((files ?? []).map((f) => f?.name).filter(Boolean));

  for (const spec of ordered) {
    let file;
    try {
      file = fileFrom(spec);
    } catch (err) {
      unplaced.push({
        name: spec?.name ?? 'a file',
        why: String(err?.message) === 'empty' ? 'it came back empty from the store' : 'it could not be read',
      });
      continue;
    }

    if (box) {
      // Named at its word, exactly as `boxFor` does: a box that says it takes
      // `.doc` is not a box a PDF goes in, however deliberately it was aimed at.
      if (!willTake(box, file)) {
        unplaced.push({ name: spec.name, why: `this form only takes ${box.getAttribute('accept')} there` });
        continue;
      }
      const kind = kindOf(spec.name);
      if (boxKind && kind !== 'other' && kind !== boxKind) {
        unplaced.push({ name: spec.name, why: `that box is for the ${KIND_WORDS[boxKind]}` });
        continue;
      }
      // The all-files chip over a box that takes one: the first file is
      // placed, and the rest are said, not crammed in beside it. See `putIn`.
      if (written.has(box) && !box.multiple) {
        unplaced.push({ name: spec.name, why: 'this box takes one file' });
        continue;
      }
      if (await putIn(box, file, { alongside: written.has(box), ours })) {
        written.add(box);
        placed.push({ name: spec.name, where: saysWhat(box).slice(0, 60) || 'the box you dropped it on' });
        continue;
      }
      unplaced.push({ name: spec.name, why: 'the page would not let that box take a file' });
      continue;
    }

    if (zone) {
      // A zone gives nothing back to read, so the answer is "not sure" and is
      // reported as such rather than claimed. See `dropOn`.
      const how = await dropOn(zone, file);
      placed.push({ name: spec.name, where: 'where you dropped it', sure: how === 'sure' });
      continue;
    }

    unplaced.push({ name: spec.name, why: 'there is no upload box where you dropped it' });
  }

  return { placed, unplaced, boxes: boxes.length };
}

/*
 * There was a `canAttach()` here, for hiding the button on a page with
 * nothing to attach to. Nothing ever called it, and it could not be called:
 * the answer it gives is about this document, and half the portals that
 * matter put the upload control in an embedded frame — where the top
 * document, correctly, sees no box and would have hidden the button that is
 * the only way to reach the frame. A gate that has to be wrong on the case it
 * exists for is not a gate.
 */
