/**
 * Did the person just send this application?
 *
 * Guesswork, from outside a portal, and the only evidence is the page: the
 * form being submitted, or the control that sends it being pressed. Worth
 * having because the tracker otherwise records what you remembered to tell it
 * and nobody tells it about the last step — by the time the form goes the tab
 * is already on a confirmation page and the application is behind you.
 *
 * Everything here is procedural, and deliberately: a wrong "yes" marks a job
 * as done and takes it off the list of things still to finish, which is worse
 * than missing one. Rules can be read, argued with and tested against three
 * dozen real pages in a minute; a judgement cannot.
 *
 * Shared because the form is as often in an iframe as on the page — iCIMS and
 * every embedded board — and the frame has to reach the same verdict the top
 * document would, from the same rules rather than from a second copy of them.
 */

/**
 * The words these systems end an application with.
 *
 * Widened against real ones rather than guessed at: Paylocity says "Submit
 * Resume", Phenom says "Complete application", ADP says "Apply Now", Personio
 * says "Send application", Paycom says "Submit my application". A verb and the
 * thing it acts on, close together, covers all of them — and leaves alone the
 * ones that share half the phrase: "Submit a question" has the verb and no
 * object, "Apply filters" has an object and no verb, "Save draft" and
 * "Subscribe" have neither.
 */
const SENDING =
  /\b(submit|send|complete|finish)\b[^.]{0,24}\b(application|apply|resume|cv|submission|submit)\b|^\s*(submit|apply now|send|finish)\s*$/i;

/**
 * And the words that take it back.
 *
 * "Complete application later" is the whole phrase and the opposite act,
 * offered near the end of every long form; "Apply to another role" and "Send
 * application by email" are the same trick. A label that says when or where
 * instead of now and here is not the button that ends this.
 */
const NOT_YET = /\b(later|reminder|another|different|instead|by email|via email|by post|draft)\b/i;

/** Whether a control's own words say it sends this application. */
export function looksLikeASend(label) {
  const said = (label ?? '').trim();
  return Boolean(said) && SENDING.test(said) && !NOT_YET.test(said);
}

/**
 * A link to somewhere else is a journey, not a send.
 *
 * Two of the systems tested here end the application with an anchor, so
 * anchors have to count — but the similar-jobs rail every portal carries is
 * also anchors, offering "Apply now" for a different role, and the small print
 * offers to take the application by email. Both say the right words and go
 * somewhere else. An anchor that stays on this page is a button wearing the
 * wrong element; one that leaves is a link.
 */
export function leavesThePage(link, here) {
  const href = link?.getAttribute?.('href') ?? '';
  if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return false;
  try {
    const to = new URL(link.href, here.href);
    return to.origin !== here.origin || to.pathname !== here.pathname;
  } catch {
    // An href this cannot parse — mailto:, tel:, a custom scheme — is not a
    // control on this form whatever else it is.
    return true;
  }
}

/**
 * Is this the application, or the other form on the page?
 *
 * An application page is rarely one form. There is a newsletter box, a
 * question box, a filter panel — all real forms, all submitted, none of them
 * the application. Listening for any submit at all marked an application as
 * sent when somebody signed up for job alerts underneath it.
 *
 * Used only when a script submitted the form itself and there is no button to
 * ask: an application asks for a file or for several fields, and a newsletter
 * asks for an address.
 */
export function looksLikeTheApplication(form) {
  if (!form || typeof form.querySelectorAll !== 'function') return false;
  if (form.querySelector('input[type=file]')) return true;
  const fields = [...form.querySelectorAll('input, select, textarea')].filter(
    (el) => !['hidden', 'submit', 'button', 'image', 'reset'].includes(el.type),
  );
  return fields.length >= 3;
}

/**
 * A control's name, in the order the browser itself would work it out.
 *
 * `aria-label` first, and that is the whole point: an author writes one
 * exactly when the visible content does not say what the control does. The
 * order here was value, then text, then aria-label — so a submit button whose
 * content is an arrow glyph answered "→", which is not a send by any rule,
 * and the application went out unrecorded. The one case the attribute exists
 * for was the one case it was never read in.
 *
 * Then `value`, which is how `input[type=submit]` carries its label, then the
 * text, then `title` as the last resort — the same precedence the accessible
 * name computation uses, for the same reason.
 */
export function nameOf(control) {
  const said =
    control?.getAttribute?.('aria-label') ||
    control?.value ||
    control?.textContent ||
    control?.getAttribute?.('title') ||
    '';
  return said.trim();
}

/**
 * A press on Submit that the browser is going to refuse anyway.
 *
 * The click listener exists because plenty of these systems call
 * `preventDefault` and post the form by hand, so waiting for a `submit` event
 * misses real sends. But a click is not a send, and constraint validation is
 * the case where the difference is stark: an empty required field means the
 * browser blocks the submission and fires no `submit` event at all — while the
 * capture-phase click listener has already run and latched.
 *
 * Measured, on a form with two empty required fields:
 *
 *   browser submit events fired : 0
 *   validation message shown    : "Please fill out this field."
 *   JobHelper recorded as sent  : ["Submit Application" was pressed…]
 *
 * The page says "Please fill out this field." and the application is still
 * sitting there; the card says "Recorded as sent.", the tracker moves the row
 * to applied, and `told` latches so the real submit afterwards does nothing.
 * Press Submit, read the validation error, come back tomorrow — and the job is
 * off the list of things still to do, unsent. This file's own header calls a
 * wrong "yes" the worst failure available, and this is one.
 *
 * Read per control rather than through `form.checkValidity()`, which dispatches
 * `invalid` events the page can see: asking a question must not be something
 * the page can notice, let alone act on.
 *
 * Only for controls that really would trigger native validation. A
 * `[role=button]` div has no form to validate, and a `type=button` inside one
 * submits by script if it submits at all — neither is the browser refusing
 * anything.
 */
function refusedByTheBrowser(button) {
  const submits =
    (button.tagName === 'BUTTON' || button.tagName === 'INPUT') && button.type === 'submit';
  if (!submits || button.formNoValidate) return false;
  const form = button.form ?? button.closest?.('form');
  if (!form || form.noValidate) return false;
  for (const control of form.elements ?? []) {
    if (control.willValidate && control.validity && !control.validity.valid) return true;
  }
  return false;
}

/**
 * Watch a document for its application being sent, and say so once.
 *
 * Both listeners are in capture phase: a handler that calls preventDefault and
 * posts the form by hand is the ordinary case on these systems rather than the
 * exception, and by the bubble phase it has already happened.
 *
 * Returns a function that stops watching.
 */
export function watchForSending(doc, tell) {
  let told = false;

  /*
   * Said once — but only a press that was actually taken as a send spends it.
   *
   * `told` used to be set before `tell` was called, and `tell` is where the
   * caller decides: the page has to be the application rather than the
   * description of it, and there has to be a company and a role to file it
   * under. A press it declines is not a send, so it must not be the one send
   * this watcher had to give.
   *
   * "Apply Now" is where those come apart, and this file already says why: it
   * ends the application on ADP and opens it on almost every description page
   * there is. Measured on a single-page board — press Apply Now, fill the
   * form it swaps in, press Submit Application:
   *
   *   before Apply Now   {"application":"applying","draft":"drafting"}
   *   after Apply Now    {"application":"applying","draft":"drafting"}
   *   after real Submit  {"application":"applying","draft":"drafting"}
   *
   * The same page with the opening button worded "See the application form"
   * ends `{"application":"applied","draft":"submitted"}`. The application went
   * out either way; only one of them was recorded, and the difference was a
   * button pressed several minutes earlier that nothing was filed for.
   *
   * A caller that says nothing still spends it, which is what the frames do.
   */
  const once = (how) => {
    if (told) return;
    told = tell(how) !== false;
  };

  const onSubmit = (event) => {
    const label = nameOf(event.submitter);
    if (label) {
      if (looksLikeASend(label)) once(`"${label.slice(0, 40)}" was pressed on the page`);
      return;
    }
    if (looksLikeTheApplication(event.target)) once('The form was submitted on the page');
  };

  const onClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const button = target.closest('button, input[type=submit], [role=button]');
    if (!button) return;
    const link = target.closest('a[href]');
    if (link && leavesThePage(link, doc.location ?? doc.defaultView?.location)) return;
    // A press the browser is about to refuse is not a send.
    if (refusedByTheBrowser(button)) return;
    const label = nameOf(button);
    if (looksLikeASend(label)) once(`"${label.slice(0, 40)}" was pressed on the page`);
  };

  doc.addEventListener('submit', onSubmit, true);
  doc.addEventListener('click', onClick, true);
  return () => {
    doc.removeEventListener('submit', onSubmit, true);
    doc.removeEventListener('click', onClick, true);
  };
}
