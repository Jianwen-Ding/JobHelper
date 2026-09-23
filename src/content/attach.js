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
 * a green "Attached Jianwen-Ding-Resume.pdf".
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
        const text = clean(before.textContent);
        if (!text) continue;
        said.unshift(text);
        room -= text.length;
      }
      if (said.length > 0) return said.join(' ');
      break;
    }
    const text = clean(holder.textContent);
    if (text && text.length < 400) best = text;
  }
  return best;
}

/** Everything that might say what this box wants, nearest first. */
function saysWhat(input) {
  return `${namedBy(input)} ${aroundIt(input)}`.trim();
}

/**
 * What each kind of file answers to.
 *
 * Ordered, and read in order: a box labelled "Resume or Cover Letter" takes
 * the resume, because that is what somebody uploading one file to it means.
 */
const WANTS = {
  resume: /\b(resume|cv|curriculum vitae)\b/,
  letter: /\b(cover letter|covering letter|motivation letter)\b/,
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
 * Jianwen-Ding-Resume.pdf". Measured: `#ph` holding the resume, zero drop
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

/** Which of the kinds above a file is, from the name it will be uploaded as. */
export function kindOf(name) {
  const text = wordsOf(name);
  for (const [kind, pattern] of Object.entries(WANTS)) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
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
 * says so, and the card says "Attached Jianwen-Ding-Resume.pdf" over an empty
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
function putIn(box, file, { alongside = false, ours } = {}) {
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
  const home =
    box.closest?.('label, [class*="upload" i], [class*="drop" i], [class*="file" i], [class*="attach" i]') ??
    box.parentElement;
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
   * and names the file while it explains: "Jianwen-Ding-Resume.pdf is larger
   * than the 1 MB limit", or Dropzone's preview drawn with the name and
   * marked `dz-error`. Read as a chip, that was "Attached" over an empty box
   * and a red message. A name inside something marked as an error or an
   * alert is a refusal.
   */
  if (!home?.isConnected) return false;
  const refusing = home.querySelectorAll('[role="alert"], [class*="error" i], [class*="invalid" i]');
  if ([...refusing].some((el) => (el.textContent ?? '').includes(file.name))) return false;
  return (home.textContent ?? '').includes(file.name);
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
  const found = deepAll('div,section,label,form', root).filter((el) => {
    if (!el.isConnected || el.closest('[hidden]')) return false;
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
  let said = clean(`${zone.getAttribute('aria-label') ?? ''} ${zone.textContent ?? ''}`);
  for (let holder = zone.parentElement, up = 0; holder && up < 4; holder = holder.parentElement, up++) {
    if (zones.some((z) => z !== zone && holder.contains(z))) break;
    const text = clean(holder.textContent);
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
  const placeIn = (box, file) => {
    const ok = putIn(box, file, { alongside: written.has(box), ours });
    if (ok) written.add(box);
    return ok;
  };

  for (const spec of files ?? []) {
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
      if (placeIn(box, file)) {
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
    if (saysNothing && (files.length === 1 || boxes.length === 1) && willTake(free[0], file) && placeIn(free[0], file)) {
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
        WANTS[kind]?.test(saysWhat(b)) &&
        willTake(b, file) &&
        !NOT_A_DOCUMENT.test(namedBy(b)),
    );
    if (several && placeIn(several, file)) {
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
    const zones = dropZones().filter((z) => !(rejectedBy && z.contains(rejectedBy)));
    const zone =
      zones.find((z) => WANTS[kind]?.test(zoneSays(z, zones))) ??
      (boxes.length === 0 ? zones.find((z) => kindOf(zoneSays(z, zones)) === 'other') : undefined);
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
  const near = (el) => {
    for (let at = el; at; at = at.parentElement ?? at.getRootNode?.()?.host) {
      if (at instanceof HTMLInputElement && at.type === 'file' && boxes.includes(at)) return at;
      const inside = [...(at.querySelectorAll?.('input[type="file"]') ?? [])].filter((b) => boxes.includes(b));
      if (inside.length === 1) return inside[0];
      if (inside.length > 1) return null;
    }
    return null;
  };

  const box = target ? near(target) : null;
  const zone = box ? null : target?.closest?.('div,section,label,form') ?? null;
  const written = new Set();
  const ours = new Set((files ?? []).map((f) => f?.name).filter(Boolean));

  for (const spec of files ?? []) {
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
      if (putIn(box, file, { alongside: written.has(box), ours })) {
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
