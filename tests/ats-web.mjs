/**
 * Application forms from the systems the first twenty did not cover, and the
 * many ways they spell "send it".
 *
 * The suites beside this one walk the ATS platforms a startup uses —
 * Greenhouse, Lever, Ashby, Workable and their neighbours. Those are the ones
 * whose forms look like forms. The other half of the market is enterprise
 * software with a careers portal bolted to an HR suite: Oracle Recruiting
 * Cloud, Cornerstone, ADP, UKG, Dayforce, Paylocity, Paycom. Between them they
 * carry an enormous share of the jobs actually advertised, and every one of
 * them ends the application with a different control.
 *
 * ## Why the submit control is the interesting part
 *
 * Knowing an application went out is guesswork from outside a portal, and the
 * only evidence is the page: the form being submitted, or the button that
 * sends it being pressed. So the question this file exists to ask is whether
 * that guess survives contact with how these systems are actually built.
 *
 *   - `<button type="submit">`, which fires a submit event;
 *   - `<input type="submit">`, which also does, but is not a button element;
 *   - `<button type="button">` wired to fetch, which fires nothing at all;
 *   - `<a role="button">`, which is not in a form and never was;
 *   - a `<div role="button">`, same;
 *   - a button whose label lives in a nested span, so `textContent` has to
 *     read through children rather than off the element;
 *   - a form that submits and calls preventDefault, which is the ordinary
 *     single-page case.
 *
 * ## And the ones that must not count
 *
 * Saying an application was sent when it was not is worse than missing one:
 * it puts a job in the tracker as done and takes it off the list of things to
 * finish. So half of these pages hold a control that looks like a submission
 * and is not — Save draft, Submit a question, Apply filters — and the test
 * presses those too.
 */

const CHROME = `
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #fafafa; color: #222; }
  .hdr { background: #1f3a5f; color: #fff; padding: 20px 36px; }
  .hdr h1 { margin: 0; font-size: 21px; }
  .wrap { max-width: 760px; padding: 24px 36px 56px; }
  label { display: block; margin: 12px 0 4px; font-size: 13px; color: #555; }
  input, textarea, select { width: 380px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font: inherit; }
  textarea { min-height: 80px; }
  button, .btn { margin-top: 16px; padding: 9px 16px; background: #1f3a5f; color: #fff; border: 0; border-radius: 4px; font: inherit; display: inline-block; cursor: pointer; }
  .quiet { background: #eee; color: #333; }
`;

/**
 * The fields every one of these asks for.
 *
 * Deliberately the same everywhere: what varies between these fixtures is the
 * system's shape and the control that ends it, and a form that also differed
 * field by field would make a failure impossible to attribute.
 */
const FIELDS = `
      <label for="fn">First Name</label><input id="fn" name="first_name">
      <label for="ln">Last Name</label><input id="ln" name="last_name">
      <label for="em">Email</label><input id="em" name="email" type="email">
      <label for="rs">Resume/CV</label><input id="rs" name="resume" type="file">
      <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>
      <label for="q1">Why do you want to work here?</label><textarea id="q1" name="why_here"></textarea>`;

/** The words that make a page read as an application form rather than a page. */
const FORM_WORDS = `
    <p>Submit application below. Upload your resume, tell us about your work
       authorization, and say whether you require sponsorship. Equal opportunity
       employer.</p>`;

const page = (title, heading, body) => `<!doctype html>
<html><head><title>${title}</title><style>${CHROME}</style></head>
<body><div class="hdr"><h1>${heading}</h1></div><div class="wrap">${body}</div></body></html>`;

/**
 * One application form on one system.
 *
 * `sends` is the accessible name of the control that submits it, and `sent`
 * says whether pressing it should be taken as the application going out. The
 * pages carrying a `sent: false` control carry a real one too, so that the
 * negative is a button on an application form rather than a button on a page
 * that was never going to count anyway.
 */
const form = ({ name, path, query, company, title, inner, sends, sent = true, alsoOffers }) => ({
  name,
  path,
  /** The rest of the real address. The server matches on the path alone. */
  query,
  company,
  title,
  sends,
  sent,
  alsoOffers,
  html: page(`Apply — ${company}`, company, `<h2>${title}</h2>${FORM_WORDS}${inner}`),
});

/* ------------------------------------------------------------------ *
 * The enterprise HR suites                                            *
 * ------------------------------------------------------------------ */

/** Oracle Recruiting Cloud: a candidate-experience path under an HCM tenant. */
export const ORACLE = form({
  name: 'oracle-recruiting',
  path: '/hcmUI/CandidateExperience/en/sites/CX_1/job/18842/apply',
  company: 'Novena Health',
  title: 'Platform Engineer',
  sends: 'Submit',
  inner: `<form onsubmit="event.preventDefault(); document.title = 'Submitted';">
      ${FIELDS}
      <button type="submit">Submit</button>
    </form>`,
});

/** Cornerstone OnDemand: a requisition id, and an `input` rather than a button. */
export const CORNERSTONE = form({
  name: 'cornerstone',
  path: '/careers/JobDetail/platform-engineer/requisition/4821',
  company: 'Halewood Group',
  title: 'Platform Engineer',
  sends: 'Submit Application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <input type="submit" value="Submit Application">
    </form>`,
});

/** ADP Workforce Now: the recruitment module, and "Apply Now" as the send. */
export const ADP = form({
  name: 'adp-workforce-now',
  path: '/mascsr/default/mdf/recruitment/recruitment.html',
  query: '?cid=9f2&jobId=77120',
  company: 'Calder Logistics',
  title: 'Platform Engineer',
  sends: 'Apply Now',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Apply Now</button>
    </form>`,
});

/** UKG: a link styled as a button, outside the form entirely. */
export const UKG = form({
  name: 'ukg-pro',
  path: '/ta/6100.jobs',
  query: '?ApplyToJob=482991',
  company: 'Stonebridge Care',
  title: 'Platform Engineer',
  sends: 'Submit Application',
  inner: `<form>${FIELDS}</form>
    <a href="#sent" role="button" class="btn">Submit Application</a>`,
});

/** Dayforce: a div with a role, which is neither a button nor in a form. */
export const DAYFORCE = form({
  name: 'dayforce',
  path: '/CandidatePortal/en-US/meridian/Posting/View/30914',
  company: 'Meridian Foods',
  title: 'Platform Engineer',
  sends: 'Send Application',
  inner: `<form>${FIELDS}</form>
    <div role="button" tabindex="0" class="btn">Send Application</div>`,
});

/** Paylocity: a plain button with no type, which defaults to submit. */
export const PAYLOCITY = form({
  name: 'paylocity',
  path: '/Recruiting/Jobs/Details/2891044',
  company: 'Arden Windows',
  title: 'Platform Engineer',
  sends: 'Submit Resume',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button>Submit Resume</button>
    </form>`,
});

/** Paycom: the label sits in a nested span, not on the button itself. */
export const PAYCOM = form({
  name: 'paycom',
  path: '/v4/ats/index.php',
  query: '?/jobs/apply/30021',
  company: 'Fairhaven Retail',
  title: 'Platform Engineer',
  sends: 'Submit my application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit"><span class="ico"></span><span>Submit my application</span></button>
    </form>`,
});

/* ------------------------------------------------------------------ *
 * The newer platforms                                                 *
 * ------------------------------------------------------------------ */

/** Eightfold: a single-page portal that posts the form itself. */
export const EIGHTFOLD = form({
  name: 'eightfold',
  path: '/careers/job',
  query: '?id=1902884&source=careersite',
  company: 'Lumen Analytics',
  title: 'Platform Engineer',
  sends: 'Submit application',
  inner: `<form id="ef">${FIELDS}</form>
    <button type="button" onclick="document.title='Submitted'">Submit application</button>`,
});

/** Phenom: a careers site whose final step says "Complete application". */
export const PHENOM = form({
  name: 'phenom-people',
  path: '/us/en/job/PH88201/platform-engineer/apply',
  company: 'Brightwater Bank',
  title: 'Platform Engineer',
  sends: 'Complete application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Complete application</button>
    </form>`,
});

/** Avature: a long-standing enterprise system, wordier than most. */
export const AVATURE = form({
  name: 'avature',
  path: '/careers/JobDetail/Platform-Engineer/20918',
  company: 'Kestrel Aerospace',
  title: 'Platform Engineer',
  sends: 'Submit my application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit my application</button>
    </form>`,
});

/** Zoho Recruit: a portal application, submitted by an input. */
export const ZOHO = form({
  name: 'zoho-recruit',
  path: '/recruit/PortalApplication.na',
  query: '?digest=abc123&jobid=9911',
  company: 'Tarn Software',
  title: 'Platform Engineer',
  sends: 'Submit Application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <input type="submit" value="Submit Application">
    </form>`,
});

/** Personio: European, and says "Send application". */
export const PERSONIO = form({
  name: 'personio',
  path: '/job/1882043',
  company: 'Nordhaus GmbH',
  title: 'Platform Engineer',
  sends: 'Send application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Send application</button>
    </form>`,
});

/** Pinpoint: a smaller platform, conventional markup. */
export const PINPOINT = form({
  name: 'pinpoint',
  path: '/careers/908812/apply',
  company: 'Harbourline',
  title: 'Platform Engineer',
  sends: 'Submit application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit application</button>
    </form>`,
});

/** Comeet: the send is an anchor with the label in a child element. */
export const COMEET = form({
  name: 'comeet',
  path: '/jobs/quillon/A1.00A/platform-engineer/12.ABC',
  company: 'Quillon',
  title: 'Platform Engineer',
  sends: 'Submit Application',
  inner: `<form>${FIELDS}</form>
    <a href="#sent" role="button" class="btn"><span>Submit Application</span></a>`,
});

/** Bullhorn: a staffing system, and a bare "Submit". */
export const BULLHORN = form({
  name: 'bullhorn',
  path: '/careers/JobBoard/apply',
  query: '?id=40182',
  company: 'Ridgeway Staffing',
  title: 'Platform Engineer',
  sends: 'Submit',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit</button>
    </form>`,
});

/* ------------------------------------------------------------------ *
 * Controls that look like a submission and are not                    *
 * ------------------------------------------------------------------ */

/**
 * Each of these is a real application form — the kind of page where the
 * question "was this sent" is live — carrying a control that must not answer
 * it. Saying an application went out when it did not takes it off the list of
 * things to finish, which is worse than never noticing.
 */

/** Save and come back later, which every long form offers. */
export const SAVE_DRAFT = form({
  name: 'saves-a-draft',
  path: '/hcmUI/CandidateExperience/en/sites/CX_1/job/18843/apply',
  company: 'Ilminster Rail',
  title: 'Platform Engineer',
  sends: 'Save draft',
  sent: false,
  alsoOffers: 'Submit application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="button" class="quiet">Save draft</button>
      <button type="submit">Submit application</button>
    </form>`,
});

/** A question about the role, asked from the form itself. */
export const ASK_A_QUESTION = form({
  name: 'asks-a-question',
  path: '/careers/JobDetail/platform-engineer/requisition/4822',
  company: 'Wrenfield Media',
  title: 'Platform Engineer',
  sends: 'Submit a question',
  sent: false,
  alsoOffers: 'Submit application',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit application</button>
    </form>
    <h2>Questions about this role?</h2>
    <form onsubmit="event.preventDefault();">
      <label for="qq">Your question</label><input id="qq">
      <button type="submit">Submit a question</button>
    </form>`,
});

/** The filter panel that sits beside a form on a portal with a job list. */
export const APPLY_FILTERS = form({
  name: 'applies-filters',
  path: '/ta/6100.jobs/filters',
  query: '?ApplyToJob=482992',
  company: 'Colebrook Energy',
  title: 'Platform Engineer',
  sends: 'Apply filters',
  sent: false,
  alsoOffers: 'Submit Application',
  inner: `<aside>
      <label for="loc">Location</label><input id="loc">
      <button type="button" class="quiet">Apply filters</button>
    </aside>
    <form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit Application</button>
    </form>`,
});

/** A newsletter box, which is a form, and is submitted, and is not this. */
export const SUBSCRIBE = form({
  name: 'subscribes',
  path: '/Recruiting/Jobs/Details/2891045',
  company: 'Pewsey Foods',
  title: 'Platform Engineer',
  sends: 'Subscribe',
  sent: false,
  alsoOffers: 'Submit Resume',
  inner: `<form onsubmit="event.preventDefault();">
      ${FIELDS}
      <button type="submit">Submit Resume</button>
    </form>
    <h2>Job alerts</h2>
    <form onsubmit="event.preventDefault();">
      <label for="nl">Email me new roles</label><input id="nl" type="email">
      <button type="submit">Subscribe</button>
    </form>`,
});

/** Every form above, in the order the suite walks them. */
export const SENDS = [
  ORACLE,
  CORNERSTONE,
  ADP,
  UKG,
  DAYFORCE,
  PAYLOCITY,
  PAYCOM,
  EIGHTFOLD,
  PHENOM,
  AVATURE,
  ZOHO,
  PERSONIO,
  PINPOINT,
  COMEET,
  BULLHORN,
];

/** And the ones that must leave the tracker alone. */
export const DOES_NOT_SEND = [SAVE_DRAFT, ASK_A_QUESTION, APPLY_FILTERS, SUBSCRIBE];
