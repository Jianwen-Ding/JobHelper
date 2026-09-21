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

/** A file input that is actually on the page, hidden behind a button or not. */
function uploadBoxes(root = document) {
  return [...root.querySelectorAll('input[type="file"]')].filter((input) => {
    if (input.disabled) return false;
    /*
     * Not `offsetParent`, which is null for every one of these.
     *
     * The ordinary way to build an upload control is a styled button and a
     * file input with `display:none` behind it, so a visibility test throws
     * away almost every real target. What is worth refusing is an input the
     * page has detached or put inside a hidden template — `isConnected`
     * covers the first and `closest('[hidden]')` the second.
     */
    return input.isConnected && !input.closest('[hidden]');
  });
}

/**
 * What a box says about itself, without borrowing from its neighbours.
 *
 * Its own label, its name and id, whatever accessibility text it carries.
 * These belong to this control and nothing else.
 */
function namedBy(input) {
  const byFor = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
  return [
    input.name,
    input.id,
    input.getAttribute('aria-label'),
    input.getAttribute('data-qa'),
    input.getAttribute('data-automation-id'),
    byFor?.textContent,
    input.closest('label')?.textContent,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
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
  const clean = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

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
  resume: /\b(resume|resumé|résumé|cv|curriculum vitae)\b/,
  letter: /\b(cover[\s_-]?letter|covering[\s_-]?letter|motivation[\s_-]?letter)\b/,
  transcript: /\b(transcript|academic record|grade report|marksheet)\b/,
  portfolio: /\b(portfolio|work sample|writing sample|publication)\b/,
};

/** Which of the kinds above a file is, from the name it will be uploaded as. */
export function kindOf(name) {
  const text = String(name ?? '').toLowerCase();
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
function boxFor(kind, boxes, taken) {
  const pattern = WANTS[kind];
  if (!pattern) return null;

  const free = boxes.filter((b) => !taken.has(b));
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

/** A real File, from bytes the worker fetched off the store. */
function fileFrom({ name, base64, type }) {
  const binary = atob(base64);
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
function putIn(box, file) {
  const carrier = new DataTransfer();
  carrier.items.add(file);
  try {
    box.files = carrier.files;
  } catch {
    // Some frameworks define `files` as a getter on the element. Nothing can
    // be done from here; the caller reports it as unplaced.
    return false;
  }
  if (box.files?.length !== 1) return false;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/**
 * And for the drop zones that have no input until you use one.
 *
 * Workday's is the common case: a region with `ondrop` wired and a file input
 * that only exists once a file has been chosen. Dispatching the three events
 * a real drag produces, with the same `DataTransfer`, is what the page is
 * listening for.
 */
function dropOn(zone, file) {
  const carrier = new DataTransfer();
  carrier.items.add(file);
  for (const type of ['dragenter', 'dragover', 'drop']) {
    zone.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: carrier }),
    );
  }
  return true;
}

/** A region that behaves like a drop target, for a file with no box to go in. */
function dropZones(root = document) {
  const said = /drag|drop|attach/i;
  return [...root.querySelectorAll('div,section,label,form')].filter(
    (el) => el.isConnected && said.test(el.getAttribute('aria-label') ?? '') || said.test(el.className ?? ''),
  );
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
export function attachFiles(files) {
  const boxes = uploadBoxes();
  const taken = new Set();
  const placed = [];
  const unplaced = [];

  for (const spec of files ?? []) {
    let file;
    try {
      file = fileFrom(spec);
    } catch {
      unplaced.push({ name: spec?.name ?? 'a file', why: 'it could not be read' });
      continue;
    }

    const kind = kindOf(spec.name);
    const box = boxFor(kind, boxes, taken);
    if (box && putIn(box, file)) {
      taken.add(box);
      placed.push({ name: spec.name, where: saysWhat(box).slice(0, 60) });
      continue;
    }

    /*
     * One unlabelled box is not ambiguous.
     *
     * Plenty of forms have exactly one upload control and no word anywhere
     * near it — the heading two divs up says "Application" and that is all.
     * With one file to place and one box free, there is nothing to get wrong.
     * With more than one of either, guessing is how a transcript ends up
     * where the resume should be, so it does not.
     */
    const free = boxes.filter((b) => !taken.has(b));
    if (free.length === 1 && (files.length === 1 || boxes.length === 1) && putIn(free[0], file)) {
      taken.add(free[0]);
      placed.push({ name: spec.name, where: 'the only upload box on the page' });
      continue;
    }

    const zone = dropZones()[0];
    if (boxes.length === 0 && zone && dropOn(zone, file)) {
      placed.push({ name: spec.name, where: 'the drop area' });
      continue;
    }

    unplaced.push({
      name: spec.name,
      why: boxes.length === 0 ? 'this page has no upload box the extension can reach' : 'no box here asks for it',
    });
  }

  return { placed, unplaced, boxes: boxes.length };
}

/** Whether it is worth offering at all: is there anything to attach to? */
export function canAttach() {
  return uploadBoxes().length > 0 || dropZones().length > 0;
}
