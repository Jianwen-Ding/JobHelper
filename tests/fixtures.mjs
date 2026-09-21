/**
 * Fake job postings used by the end-to-end suite and the screenshot harness.
 * Shared so both drive the extension against exactly the same pages.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = `
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #fafafa; color: #222; }
  .hdr { background: #16324f; color: #fff; padding: 22px 40px; }
  .hdr h1 { margin: 0 0 4px; font-size: 22px; }
  .wrap { max-width: 720px; padding: 26px 40px 60px; }
  h2 { margin-top: 26px; font-size: 17px; }
  label { display: block; margin: 14px 0 4px; font-size: 13px; color: #555; }
  input, textarea { width: 400px; padding: 8px; border: 1px solid #ccc; border-radius: 4px; font: inherit; }
  textarea { min-height: 90px; }
  button { margin-top: 18px; padding: 9px 16px; background: #16324f; color: #fff; border: 0; border-radius: 4px; font: inherit; }
`;

/** A Greenhouse-style posting with structured data and a full application form. */
export const STREAMLY = {
  name: 'streamly',
  path: '/streamly/jobs/123',
  company: 'Streamly',
  title: 'Software Engineer Intern, Data Platform',
  html: `<!doctype html>
<html><head><title>Software Engineer Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Software Engineer Intern, Data Platform",
 "hiringOrganization":{"@type":"Organization","name":"Streamly"},
 "jobLocation":{"@type":"Place","address":{"addressLocality":"Boston","addressRegion":"MA"}},
 "description":"<p>Join our Data Platform team working on Kafka-based streaming infrastructure, building distributed systems in Go and Python. You will maintain CI/CD pipelines with Docker and Kubernetes on AWS.</p><ul><li>Minimum qualifications: pursuing a BS in Computer Science</li><li>Experience with distributed systems and SQL</li></ul><p>Equal opportunity employer.</p>"}
</script>
<style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Streamly</h1><div>Software Engineer Intern, Data Platform · Boston, MA</div></div>
  <div class="wrap">
    <h2>About the role</h2>
    <p>Join our Data Platform team working on Kafka-based streaming infrastructure,
       building distributed systems in Go and Python. Responsibilities include
       maintaining CI/CD pipelines with Docker and Kubernetes on AWS.</p>
    <h2>Minimum qualifications</h2>
    <ul><li>Pursuing a BS in Computer Science</li><li>Experience with distributed systems and SQL</li></ul>
    <h2>Apply now</h2>
    <form>
      <label for="fn">First Name</label><input id="fn" name="first_name">
      <label for="ln">Last Name</label><input id="ln" name="last_name">
      <label for="em">Email</label><input id="em" name="email" type="email">
      <label for="ph">Phone</label><input id="ph" name="phone">
      <label for="li">LinkedIn Profile</label><input id="li" name="linkedin">
      <label for="sc">School</label><input id="sc" name="school">
      <label for="q1">Why are you interested in this role?</label>
      <textarea id="q1" name="why_interested"></textarea>
      <label for="q2">Describe a technical project you are proud of.</label>
      <textarea id="q2" name="proud_project"></textarea>
      <label for="cl">Cover Letter</label>
      <input id="cl" name="cover_letter" type="file">
      <button type="button">Submit Application</button>
    </form>
  </div>
</body></html>`,
};

/** A posting with no structured data, to exercise the heuristic path. */
export const NORTHWIND = {
  name: 'northwind',
  path: '/careers/backend-engineer',
  company: 'Northwind',
  title: 'Frontend Engineer, Web Platform',
  html: `<!doctype html>
<html><head><title>Frontend Engineer, Web Platform at Northwind</title>
<style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Northwind Careers</h1><div>Frontend Engineer, Web Platform</div></div>
  <div class="wrap">
    <h2>Job description</h2>
    <p>We are hiring a frontend engineer to work in React and TypeScript on our
       web platform. You will build accessible interfaces, improve performance,
       and work with our design system. Some Node.js work on the API layer.</p>
    <h2>Responsibilities</h2>
    <ul><li>Build and test React components</li><li>Improve page performance</li></ul>
    <h2>Minimum qualifications</h2>
    <ul><li>Two years of experience with modern JavaScript</li></ul>
    <p>Equal opportunity employer. Apply now.</p>
    <form>
      <label for="name">Full Name</label><input id="name" name="full_name">
      <label for="email2">Email</label><input id="email2" name="email">
      <label for="gh">GitHub</label><input id="gh" name="github">
      <button type="button">Submit Application</button>
    </form>
  </div>
</body></html>`,
};

/** Not a job posting. The extension must stay silent here. */
export const BLOG = {
  name: 'blog',
  path: '/posts/sourdough',
  html: `<!doctype html><html><head><title>Notes on sourdough</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Notes on sourdough</h1>
<p>A long post about bread, hydration ratios, and patience. Nothing here resembles a job.</p></div></body></html>`,
};


/*
 * One application across two pages, the ordinary shape: a description that
 * says what the job is and links to "Apply", and a form on its own page that
 * asks the questions and knows almost nothing about the role. Writing a cover
 * letter from the second page alone is the case this exists to test.
 */
export const HELIOS_ROLE = {
  name: 'helios-role',
  path: '/helios/roles/platform-engineer',
  company: 'Helios',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Helios</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Helios</h1><div>Platform Engineer · Remote</div></div>
  <div class="wrap">
    <h2>About the role</h2>
    <p>We are looking for a platform engineer to run our Kafka and Kubernetes
       estate. You will own the streaming infrastructure end to end, in Go and
       Python, and the CI/CD that ships it.</p>
    <h2>Minimum qualifications</h2>
    <ul><li>Experience with distributed systems</li><li>Years of experience with SQL and AWS</li></ul>
    <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>
    <p><a href="/helios/apply/platform-engineer">Apply now</a></p>
  </div>
</body></html>`,
};

export const HELIOS_FORM = {
  name: 'helios-form',
  path: '/helios/apply/platform-engineer',
  company: 'Helios',
  title: 'Apply — Helios',
  html: `<!doctype html>
<html><head><title>Apply — Helios</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Helios</h1><div>Submit application</div></div>
  <div class="wrap">
    <form>
      <label for="fn">First Name</label><input id="fn" name="first_name">
      <label for="ln">Last Name</label><input id="ln" name="last_name">
      <label for="em">Email</label><input id="em" name="email" type="email">
      <label for="rs">Resume</label><input id="rs" name="resume" type="file">
      <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>
      <label for="q1">Why do you want to work here?</label>
      <textarea id="q1" name="why_here"></textarea>
      <label for="q2">Will you now or in the future require sponsorship?</label>
      <input id="q2" name="sponsorship">
      <button type="button">Submit Application</button>
    </form>
  </div>
</body></html>`,
};


/* ------------------------------------------------------------------ *
 * How real systems move you from the description to the form          *
 * ------------------------------------------------------------------ */

const ROLE_BODY = `
    <h2>About the role</h2>
    <p>We are looking for a platform engineer to run our Kafka and Kubernetes
       estate. You will own the streaming infrastructure end to end, in Go and
       Python, and the CI/CD that ships it.</p>
    <h2>Minimum qualifications</h2>
    <ul><li>Experience with distributed systems</li><li>Years of experience with SQL and AWS</li></ul>
    <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>`;

const FORM_BODY = `
    <form>
      <label for="fn">First Name</label><input id="fn" name="first_name">
      <label for="ln">Last Name</label><input id="ln" name="last_name">
      <label for="em">Email</label><input id="em" name="email" type="email">
      <label for="rs">Resume</label><input id="rs" name="resume" type="file">
      <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>
      <label for="q1">Why do you want to work here?</label><textarea id="q1" name="why_here"></textarea>
      <button type="button">Submit Application</button>
    </form>`;

/**
 * A posting with no style of its own.
 *
 * For the Content-Security-Policy case, and only for it. Every other fixture
 * here carries an inline `<style>` block so the screenshots look like a real
 * page — and a policy that forbids inline style refuses that block, putting
 * "Refused to apply inline style" in the console before the extension has done
 * anything at all. A test that then checked the console for complaints would
 * be reading the fixture's and blaming the card.
 *
 * So this one is deliberately unstyled: under a strict policy, anything in the
 * console is ours.
 */
export const BARE_ROLE = {
  name: 'bare-role',
  path: '/andromeda/roles/platform-engineer',
  company: 'Andromeda',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Platform Engineer at Andromeda</title></head>
<body>
  <h1>Andromeda</h1><div>Platform Engineer</div>
  ${ROLE_BODY}
  ${FORM_BODY}
</body></html>`,
};

/**
 * A form asking something no stored profile can answer.
 *
 * A country dropdown that does not list the country you live in. Autofill
 * knows the field and has the answer, tries, finds no option that matches,
 * and correctly leaves it alone — which is a required field still empty, and
 * has to be said in a way that does not read as finished.
 *
 * Its own fixture rather than a line added to `FORM_BODY`, which half the
 * harnesses here count the fields of.
 */
const FORM_WITH_UNANSWERABLE = `
    <form>
      <label for="fn">First Name</label><input id="fn" name="first_name">
      <label for="ln">Last Name</label><input id="ln" name="last_name">
      <label for="em">Email</label><input id="em" name="email" type="email">
      <label for="rs">Resume</label><input id="rs" name="resume" type="file">
      <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>
      <label for="ctry">Country</label>
      <select id="ctry" name="address_country" required>
        <option value="">Select One</option>
        <option>Canada</option>
        <option>Mexico</option>
      </select>
      <label for="q1">Why do you want to work here?</label><textarea id="q1" name="why_here"></textarea>
      <button type="button">Submit Application</button>
    </form>`;

const page = (title, heading, body, extra = '') => `<!doctype html>
<html><head><title>${title}</title><style>${CHROME}</style></head>
<body><div class="hdr"><h1>${heading}</h1></div><div class="wrap">${body}</div>${extra}</body></html>`;

/**
 * Lever: the form is the same URL with /apply on the end. An ordinary link,
 * an ordinary navigation, same host.
 */
export const LEVER_ROLE = {
  name: 'lever-role',
  path: '/lever/vega/8f21',
  company: 'Vega',
  title: 'Platform Engineer',
  html: page(
    'Platform Engineer at Vega',
    'Vega',
    `${ROLE_BODY}<p><a href="/lever/vega/8f21/apply">Apply for this job</a></p>`,
  ),
};
export const LEVER_FORM = {
  name: 'lever-form',
  path: '/lever/vega/8f21/apply',
  html: page('Apply — Vega', 'Vega', FORM_BODY),
};

/**
 * Ashby: same shape, different suffix, and the link says only "Apply" — the
 * href is what has to be recognised.
 */
export const ASHBY_ROLE = {
  name: 'ashby-role',
  path: '/ashby/lyra/role-4c2',
  company: 'Lyra',
  title: 'Platform Engineer',
  html: page(
    'Platform Engineer at Lyra',
    'Lyra',
    `${ROLE_BODY}<p><a href="/ashby/lyra/role-4c2/application">Apply</a></p>`,
  ),
};
export const ASHBY_FORM = {
  name: 'ashby-form',
  path: '/ashby/lyra/role-4c2/application',
  html: page('Application — Lyra', 'Lyra', FORM_BODY),
};

/**
 * Workday and its kind: a single-page application. Clicking Apply changes the
 * url with history.pushState and swaps the DOM — there is no navigation at
 * all, so nothing re-injects and the card has to notice on its own.
 */
export const WORKDAY = {
  name: 'workday',
  path: '/workday/orion/job/platform-engineer',
  company: 'Orion',
  title: 'Platform Engineer',
  html: page(
    'Platform Engineer at Orion',
    'Orion',
    `<div id="view">${ROLE_BODY}<p><button id="apply" type="button">Apply</button></p></div>`,
    `<script>
       document.getElementById('apply').addEventListener('click', () => {
         history.pushState({}, '', '/workday/orion/job/platform-engineer/apply');
         document.title = 'Apply — Orion';
         document.getElementById('view').innerHTML = ${JSON.stringify(FORM_BODY)};
       });
     </script>`,
  ),
};

/**
 * A company's own careers page handing off to an applicant tracking system:
 * a different host, and the link carries rel="noreferrer", so by the time the
 * second page loads there is nothing on it that points back.
 */
export const OWN_SITE = {
  name: 'own-site',
  path: '/acme/careers/platform-engineer',
  company: 'Acme',
  title: 'Platform Engineer',
  html: page(
    'Platform Engineer at Acme',
    'Acme',
    `${ROLE_BODY}<p><a rel="noreferrer" id="apply" href="{{ATS}}">Apply now</a></p>`,
  ),
};
export const ATS_FORM = {
  name: 'ats-form',
  path: '/gh/acme/jobs/9910',
  html: page('Apply — Acme', 'Acme', FORM_BODY),
};

/** The same form, plus one question nothing stored can answer. */
export const ATS_FORM_UNANSWERABLE = {
  name: 'ats-form-unanswerable',
  path: '/gh/acme/jobs/9911',
  html: page('Apply — Acme', 'Acme', FORM_WITH_UNANSWERABLE),
};

/** An Apply button that opens the form in a new tab, as plenty do. */
export const NEW_TAB_ROLE = {
  name: 'new-tab-role',
  path: '/nova/roles/platform-engineer',
  company: 'Nova',
  title: 'Platform Engineer',
  html: page(
    'Platform Engineer at Nova',
    'Nova',
    `${ROLE_BODY}<p><a href="/nova/roles/platform-engineer/apply" target="_blank" rel="noreferrer">Apply now</a></p>`,
  ),
};
export const NEW_TAB_FORM = {
  name: 'new-tab-form',
  path: '/nova/roles/platform-engineer/apply',
  html: page('Apply — Nova', 'Nova', FORM_BODY),
};

/** A form in two steps, which must stay one application rather than two. */
export const STEP_ONE = {
  name: 'step-one',
  path: '/rigel/apply/details',
  company: 'Rigel',
  html: page(
    'Apply — Rigel',
    'Rigel',
    `${FORM_BODY}<p><a href="/rigel/apply/questions">Continue to apply</a></p>`,
  ),
};
export const STEP_TWO = {
  name: 'step-two',
  path: '/rigel/apply/questions',
  html: page(
    'Apply — Rigel',
    'Rigel',
    `<form><label for="q9">Why do you want to work here?</label><textarea id="q9"></textarea>
     <label for="q8">Will you now or in the future require sponsorship?</label><input id="q8">
     <button type="button">Submit Application</button></form>`,
  ),
};


/**
 * A single-page board where two postings live behind two links and neither is
 * a navigation. Switching quickly between them is how a slow analysis of the
 * first lands on the card built for the second.
 */
export const SPA_BOARD = {
  name: 'spa-board',
  // The two roles are siblings under /openings, which the trail rules already
  // refuse to join — so anything of one showing up while the other is on
  // screen is the race, not the merge.
  path: '/altair/openings/platform-engineer',
  company: 'Altair',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Altair</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Altair</h1><div id="sub">Platform Engineer</div></div>
  <div class="wrap">
    <p><button id="to-b" type="button">Open Data Scientist</button></p>
    <div id="view">${ROLE_BODY}</div>
  </div>
  <script>
    document.getElementById('to-b').addEventListener('click', () => {
      history.pushState({}, '', '/altair/openings/data-scientist');
      document.title = 'Data Scientist at Altair';
      document.getElementById('sub').textContent = 'Data Scientist';
      document.getElementById('view').innerHTML =
        '<h2>About the role</h2><p>We are looking for a data scientist to own ' +
        'our forecasting models. Responsibilities include building models in ' +
        'Python and SQL and shipping them to production.</p>' +
        '<h2>Minimum qualifications</h2>' +
        '<ul><li>Years of experience with statistics</li><li>Experience with SQL</li></ul>' +
        '<p>Equal opportunity employer. Full-time. Compensation is competitive.</p>';
    });
  </script>
</body></html>`,
};

/**
 * The form in an iframe, which is how iCIMS serves its whole application — and
 * embedded Greenhouse boards, and several SuccessFactors deployments.
 *
 * The outer page is the shape that matters: a heading, and an iframe. Every
 * question, the cover letter box and every field is inside the frame, so a
 * card that reads only the page it is sitting on finds a posting and no form
 * at all — and says so by offering nothing.
 */
export const FRAMED_ROLE = {
  name: 'framed-role',
  path: '/icims/orion/jobs/4021/platform-engineer/job',
  company: 'Orion',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Orion</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Orion</h1><div>Platform Engineer</div></div>
  <div class="wrap">
    ${ROLE_BODY}
    <h2>Apply now</h2>
    <iframe id="icims_content_iframe" title="Application form"
            src="/icims/orion/jobs/4021/platform-engineer/form"
            style="width:100%;height:520px;border:1px solid #ccc"></iframe>
  </div>
</body></html>`,
};

export const FRAMED_FORM = {
  name: 'framed-form',
  path: '/icims/orion/jobs/4021/platform-engineer/form',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Application</title><style>${CHROME}</style></head>
<body><div class="wrap"><form>
  <label for="fn">First Name</label><input id="fn" name="icims_firstname" type="text">
  <label for="ln">Last Name</label><input id="ln" name="icims_lastname" type="text">
  <label for="em">Email Address</label><input id="em" name="icims_email" type="email">
  <label for="ph">Primary Number</label><input id="ph" name="icims_phone" type="text">
  <label for="cl">Cover Letter</label><textarea id="cl" name="icims_coverletter"></textarea>
  <label for="q1">Why do you want to work here?</label><textarea id="q1" name="icims_q1"></textarea>
  <button type="button">Submit Application</button>
</form></div></body></html>`,
};

/**
 * A careers page that is a heading and an embedded board, which is how a great
 * many companies run theirs: Greenhouse and SuccessFactors both ship an embed,
 * and the page around it says almost nothing.
 *
 * Everything that makes a page look like a job — the description, the
 * qualifications, the form — is inside the frame. Scored on the page itself
 * there is nothing here at all, so the card never appears, and the tool is
 * simply absent on a page where somebody is about to apply.
 */
export const EMBEDDED_BOARD = {
  name: 'embedded-board',
  path: '/vireo/careers/platform-engineer',
  company: 'Vireo',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Vireo</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Vireo</h1></div>
  <div class="wrap">
    <iframe id="grnhse_iframe" title="Greenhouse Job Board"
            src="/vireo/embed/job_app?token=4012345"
            style="width:100%;height:600px;border:0"></iframe>
  </div>
</body></html>`,
};

export const EMBEDDED_BOARD_FRAME = {
  name: 'embedded-board-frame',
  path: '/vireo/embed/job_app',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Platform Engineer at Vireo</title><style>${CHROME}</style></head>
<body><div class="wrap">
  <h1>Platform Engineer</h1>
  ${ROLE_BODY}
  <h2>Apply now</h2>
  <form>
    <label for="fn">First Name</label><input id="fn" name="first_name">
    <label for="ln">Last Name</label><input id="ln" name="last_name">
    <label for="em">Email</label><input id="em" name="email" type="email">
    <label for="rs">Resume</label><input id="rs" name="resume" type="file">
    <label for="q1">Why do you want to work here?</label><textarea id="q1"></textarea>
    <button type="button">Submit Application</button>
  </form>
</div></body></html>`,
};

/**
 * A posting that is not in the page when the page loads.
 *
 * Workday, Ashby and most of the modern boards serve an empty shell and fetch
 * the posting afterwards. The content script runs once, at document idle, and
 * scores whatever is there — which on these is a loading spinner. Nothing about
 * the page changes afterwards except its contents, so there is no second look
 * and the card never appears at all.
 */
export const LATE_RENDER = {
  name: 'late-render',
  path: '/lyricus/careers/platform-engineer',
  company: 'Lyricus',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Lyricus</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Lyricus</h1></div>
  <div class="wrap"><div id="root">Loading…</div></div>
  <script>
    setTimeout(() => {
      document.title = 'Platform Engineer at Lyricus';
      document.getElementById('root').innerHTML =
        '<h1>Platform Engineer</h1>' + ${JSON.stringify(ROLE_BODY)} +
        '<form>' +
        '<label for="fn">First Name</label><input id="fn" name="first_name">' +
        '<label for="em">Email</label><input id="em" name="email" type="email">' +
        '<label for="q1">Why do you want to work here?</label><textarea id="q1"></textarea>' +
        '<button type="button">Submit Application</button></form>';
    }, 4000);
  </script>
</body></html>`,
};

/**
 * A posting buried in a page full of somebody else's frames.
 *
 * Running in all frames means a page with thirty embeds announces thirty
 * times and is asked thirty times on every scan. Only one of them is the
 * application, and finding it among the rest — without the rest costing
 * anything or contributing anything — is the thing to check.
 *
 * It is also the slowest page in the set to put a card on, and the budget has
 * been measured rather than guessed, so that the next person to look at the
 * number does not have to. Against the same store, card up:
 *
 *   0 adverts 112ms · 6 253ms · 12 298ms · 24 450ms · 48 813ms
 *
 * — linear in the frame count, at roughly 15ms a frame. Of the ~700ms the 48
 * adverts add, about 400ms remains with every piece of this extension's own
 * frame code removed: it is Chrome loading 48 iframes and injecting a content
 * script into each, which is the price of `all_frames`, and `all_frames` is
 * what reaches the form on iCIMS. Around 90ms is the two things a frame does
 * for itself at boot (watch for a send, decide whether it holds a form), and
 * around 200ms is the top document's own injection being queued behind the
 * frames' — `document_end` recovers part of that and costs a guess about
 * pages that render late.
 *
 * So there is no large win here, only a scattering of small ones with real
 * risk attached, and the measurement is recorded so that stays known. The
 * failure on frame-heavy pages that would actually matter is a frame that
 * never finishes at all, and that one is held down by its own case in
 * tests/navigation.mjs.
 */
export const CROWDED_PAGE = {
  name: 'crowded-page',
  path: '/mensa/roles/platform-engineer',
  company: 'Mensa Labs',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Mensa Labs</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Mensa Labs</h1><div>Platform Engineer</div></div>
  <div class="wrap">
    ${ROLE_BODY}
    ${Array.from(
      { length: 24 },
      (_, i) => `<iframe title="Advertisement ${i}" src="/promo/newsletter" width="200" height="90"></iframe>`,
    ).join('\n    ')}
    <h2>Apply now</h2>
    <iframe id="form" title="Application form" src="/mensa/roles/platform-engineer/form"
            style="width:100%;height:420px"></iframe>
    ${Array.from(
      { length: 24 },
      (_, i) => `<iframe title="Advertisement ${i + 24}" src="/promo/newsletter" width="200" height="90"></iframe>`,
    ).join('\n    ')}
  </div>
</body></html>`,
};

export const CROWDED_PAGE_FORM = {
  name: 'crowded-page-form',
  path: '/mensa/roles/platform-engineer/form',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Application</title><style>${CHROME}</style></head>
<body><div class="wrap"><form>
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="em">Email</label><input id="em" name="email" type="email">
  <label for="q1">What draws you to this team?</label><textarea id="q1"></textarea>
  <button type="button">Submit Application</button>
</form></div></body></html>`,
};

/**
 * Not a job, with a frame that collects the same details anyway.
 *
 * The other side of letting a frame speak up for a page that says nothing: a
 * frame is now able to make the card appear where the page alone never would.
 * An enquiry form embedded in an article asks for a name, an email, a phone
 * number and a town, which is four parts of a person and enough to be taken
 * for the top of an application.
 */
export const BLOG_WITH_FORM = {
  name: 'blog-with-form',
  path: '/notes/sourdough-and-patience',
  html: `<!doctype html>
<html><head><title>Notes on sourdough</title><style>${CHROME}</style></head>
<body><div class="wrap">
  <h1>Notes on sourdough</h1>
  <p>A long post about bread, hydration ratios, and patience. Nothing here
     resembles a job.</p>
  <iframe id="enquiry" title="Get in touch" src="/notes/enquiry"
          style="width:420px;height:320px"></iframe>
</div></body></html>`,
};

export const BLOG_ENQUIRY_FRAME = {
  name: 'blog-enquiry-frame',
  path: '/notes/enquiry',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Get in touch</title></head>
<body><form>
  <h3>Book a class</h3>
  <label for="a">Name</label><input id="a" name="name">
  <label for="b">Email</label><input id="b" name="email" type="email">
  <label for="c">Phone</label><input id="c" name="phone">
  <label for="d">Town</label><input id="d" name="town">
  <button type="button">Send</button>
</form></body></html>`,
};

/**
 * A posting with a third party's frame on it, which is every posting.
 *
 * Running in all frames is what reaches the application form on iCIMS. It also
 * puts the script inside every advert, newsletter box and embedded widget on
 * every page — and those have fields with the same names. An advert asking for
 * an email address is not an application form, and typing the user's address
 * into someone else's iframe is a different and worse kind of wrong than
 * failing to fill a field.
 */
export const ADVERT_FRAME = {
  name: 'advert-frame',
  path: '/vela/roles/platform-engineer',
  company: 'Vela',
  title: 'Platform Engineer',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Vela</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Vela</h1><div>Platform Engineer</div></div>
  <div class="wrap">
    ${ROLE_BODY}
    ${FORM_BODY}
    <iframe id="promo" title="Advertisement" src="/promo/newsletter"
            style="width:320px;height:260px"></iframe>
  </div>
</body></html>`,
};

export const ADVERT_CONTENT = {
  name: 'advert-content',
  path: '/promo/newsletter',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Sponsored</title></head>
<body><form>
  <h3>Hiring newsletter</h3>
  <label for="ad-em">Email</label><input id="ad-em" name="email" type="email">
  <label for="ad-nm">First Name</label><input id="ad-nm" name="first_name" type="text">
  <label for="ad-q">Tell us what you think of this advertisement.</label>
  <textarea id="ad-q" name="feedback"></textarea>
  <button type="button">Subscribe</button>
</form></body></html>`,
};

/**
 * A board: a listing page, and two jobs reached from it.
 *
 * The listing is job-shaped enough to be offered on and remembered, and its
 * address is a prefix of both postings — which is how one job's description
 * used to arrive in the other's application, by way of the page between them.
 */
export const CYGNUS_BOARD = {
  name: 'cygnus-board',
  path: '/cygnus/openings',
  company: 'Cygnus',
  html: page(
    'Open positions at Cygnus',
    'Cygnus',
    `<h2>Open positions</h2>
     <p>View all openings below. We are hiring across the company; every role is full-time.</p>
     <ul>
       <li><a id="role-a" href="/cygnus/openings/platform-engineer">Platform Engineer</a></li>
       <li><a id="role-b" href="/cygnus/openings/data-scientist">Data Scientist</a></li>
     </ul>`,
  ),
};

export const CYGNUS_ROLE_A = {
  name: 'cygnus-role-a',
  path: '/cygnus/openings/platform-engineer',
  company: 'Cygnus',
  title: 'Platform Engineer',
  html: page('Platform Engineer at Cygnus', 'Cygnus', ROLE_BODY),
};

export const CYGNUS_ROLE_B = {
  name: 'cygnus-role-b',
  path: '/cygnus/openings/data-scientist',
  company: 'Cygnus',
  title: 'Data Scientist',
  html: page(
    'Data Scientist at Cygnus',
    'Cygnus',
    `<h2>About the role</h2>
     <p>We are looking for a data scientist to own our forecasting models. You
        will build them in Python and SQL and ship them to production.</p>
     <h2>Minimum qualifications</h2>
     <ul><li>Years of experience with statistics</li><li>Experience with SQL</li></ul>
     <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>`,
  ),
};


/* ------------------------------------------------------------------ *
 * Pages that must stay quiet                                          *
 * ------------------------------------------------------------------ *
 *
 * The local score is deliberately generous — the cost of offering on a page
 * that turns out not to be a job is a card that gets dismissed, and the cost
 * of staying quiet on one that is, is the whole tool not being there. But
 * generous is not the same as indiscriminate, and these are the shapes that
 * actually turn up in a browsing session: prose about careers, a shop, a
 * sign-in wall, a documentation page full of the word "requirements", and —
 * the one that used to defeat it entirely — a single-page application whose
 * bundle mentions everything a posting does while the page itself shows a
 * spinner.
 */

/** A news piece *about* hiring. Every posting word, no posting. */
export const CAREERS_ARTICLE = {
  name: 'careers-article',
  path: '/news/tech-hiring-slowdown',
  html: `<!doctype html><html><head><title>The tech hiring slowdown, explained</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>The tech hiring slowdown, explained</h1>
<p>Companies that spent 2021 posting every open role they could think of are now quietly
closing requisitions. We spoke to nine recruiters about what changed.</p>
<h2>What the job descriptions stopped saying</h2>
<p>"Minimum qualifications" sections grew by a third. Postings that once said
"we are looking for" now say "you will need". The phrase "years of experience"
appeared in 71% of the listings we sampled, up from 44%.</p>
<h2>Responsibilities, and who carries them</h2>
<p>Hiring managers describe reviewing four hundred applications for one opening.
Benefits pages are unchanged; compensation bands are not.</p>
<p>An equal opportunity employer statement is now standard boilerplate.</p>
</div></body></html>`,
};

/** A shop. Full of buttons, none of them Apply. */
export const SHOP = {
  name: 'shop',
  path: '/store/desk-lamp',
  html: `<!doctype html><html><head><title>Anglepoise desk lamp — Lumen</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Anglepoise desk lamp</h1>
<p>Full-time companion for your desk. Requirements: one power socket.</p>
<label for="qty">Quantity</label><input id="qty" name="quantity" value="1">
<button type="button">Add to cart</button><button type="button">Checkout</button>
</div></body></html>`,
};

/** A sign-in wall. Two fields, one of them an email, and nothing behind it. */
export const SIGN_IN = {
  name: 'sign-in',
  path: '/account/login',
  html: `<!doctype html><html><head><title>Sign in</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Sign in to continue</h1>
<form><label for="e">Email</label><input id="e" name="email" type="email">
<label for="p">Password</label><input id="p" name="password" type="password">
<button type="submit">Sign in</button></form>
<p>Sign in to continue to your account.</p></div></body></html>`,
};

/** Documentation. "Requirements" and "qualifications" mean something else here. */
export const DOCS = {
  name: 'docs',
  path: '/docs/install/requirements',
  html: `<!doctype html><html><head><title>Requirements — Install</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Requirements</h1>
<p>Before you begin, check the minimum qualifications of your environment.</p>
<h2>Responsibilities of the operator</h2>
<p>Full-time processes need at least 2GB. Benefits of the new scheduler include
lower latency. Compensation for the extra memory is fewer restarts.</p>
</div></body></html>`,
};

/**
 * The one that used to defeat it: an application shell that shows a spinner
 * and never becomes a posting, whose bundle happens to mention every phrase a
 * posting uses. `document.body.textContent` includes script contents, so this
 * scored higher than most real postings while displaying nothing at all.
 */
/*
 * A single-page board where one posting's form asks for a cover letter and
 * the next one does not.
 *
 * `letterInFrame` is learnt from a frame scan and was never put back, so on a
 * board where a route change is the only kind of navigation there is, one
 * posting that wanted a letter made every posting after it in that tab demand
 * one — an unrequested draft, a Submit blocked for "missing a cover letter",
 * and `coverLetterRequired: true` handed to the editor.
 */
export const LETTER_SPA = {
  name: 'letter-spa',
  path: '/altair/roles/platform-engineer',
  company: 'Altair',
  html: `<!doctype html>
<html><head><title>Platform Engineer at Altair</title><style>${CHROME}</style></head>
<body>
  <div class="hdr"><h1>Altair</h1><div id="sub">Platform Engineer</div></div>
  <div class="wrap">
    <div id="view">${ROLE_BODY}</div>
    <iframe id="form" title="Application form" src="/altair/roles/platform-engineer/form"
            style="width:100%;height:420px;border:1px solid #ccc"></iframe>
    <p><button id="to-b" type="button">Open the data scientist role</button></p>
  </div>
  <script>
    document.getElementById('to-b').addEventListener('click', () => {
      history.pushState({}, '', '/altair/roles/data-scientist');
      document.title = 'Data Scientist at Altair';
      document.getElementById('sub').textContent = 'Data Scientist';
      document.getElementById('form').remove();
      document.getElementById('view').innerHTML =
        '<h2>About the role</h2><p>We are looking for a data scientist to own our ' +
        'forecasting models. Responsibilities include building models in Python and SQL ' +
        'and shipping them to production.</p><h2>Minimum qualifications</h2>' +
        '<ul><li>Years of experience with statistics</li><li>Experience with SQL</li></ul>' +
        '<p>Equal opportunity employer. Full-time. Compensation is competitive.</p>';
    });
  </script>
</body></html>`,
};

/** Its form — the one that really does want a letter. */
export const LETTER_SPA_FORM = {
  name: 'letter-spa-form',
  path: '/altair/roles/platform-engineer/form',
  html: `<!doctype html><html><head><title>Apply</title></head><body>
  <form>
    <label>First name <input name="first_name"></label>
    <label>Last name <input name="last_name"></label>
    <label>Email <input name="email" type="email"></label>
    <label>Cover letter <textarea name="cover_letter" rows="6"></textarea></label>
    <label>Resume <input type="file" name="resume"></label>
    <button type="submit">Submit Application</button>
  </form></body></html>`,
};

/** The second posting on its own, which is the control: it wants no letter. */
export const LETTER_SPA_PLAIN = {
  name: 'letter-spa-plain',
  path: '/altair/roles/data-scientist',
  company: 'Altair',
  html: `<!doctype html>
<html><head><title>Data Scientist at Altair</title><style>${CHROME}</style></head>
<body><div class="hdr"><h1>Altair</h1><div>Data Scientist</div></div>
<div class="wrap"><h2>About the role</h2><p>We are looking for a data scientist to own our
forecasting models. Responsibilities include building models in Python and SQL and shipping
them to production.</p><h2>Minimum qualifications</h2>
<ul><li>Years of experience with statistics</li><li>Experience with SQL</li></ul>
<p>Equal opportunity employer. Full-time. Compensation is competitive.</p></div>
</body></html>`,
};

export const SPA_SHELL = {
  name: 'spa-shell',
  path: '/app/dashboard',
  html: `<!doctype html><html><head><title>Dashboard</title><style>${CHROME}</style></head>
<body><div class="wrap"><div id="root">Loading…</div></div>
<script>
  // A bundle, as bundles are.
  const STRINGS = {
    apply: 'Apply now',
    jd: 'Job description',
    resp: 'Responsibilities',
    quals: 'Minimum qualifications',
    prefs: 'Preferred qualifications',
    eoe: 'Equal opportunity employer',
    submit: 'Submit application',
    years: 'years of experience',
    about: 'About the role',
    looking: 'we are looking for',
    reqs: 'Requirements',
    benefits: 'Benefits',
    comp: 'Compensation',
    band: 'salary range',
    ft: 'full-time',
    cover: 'cover letter',
    upload: 'upload your resume',
    auth: 'work authorization',
    why: 'why do you want',
  };
  setTimeout(() => { document.getElementById('root').textContent = 'Nothing to show.'; }, 300);
</script>
</body></html>`,
};

/** A forum thread that talks about applying without being a posting. */
export const FORUM_THREAD = {
  name: 'forum-thread',
  path: '/r/cscareers/comments/how-many-applications',
  html: `<!doctype html><html><head><title>How many applications did it take you?</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>How many applications did it take you?</h1>
<p>I have sent about 200. Most were full-time new grad roles. A few asked for a
cover letter, most wanted years of experience I do not have.</p>
<p>Replies: 43</p>
<label for="c">Add a comment</label><textarea id="c" name="comment"></textarea>
<button type="button">Reply</button></div></body></html>`,
};


/*
 * The near-misses that actually turn up, now that vocabulary alone is not
 * enough. Each of these clears one of the new tests and should still be
 * refused: a job board's own feed is on a board host, a confirmation page is
 * on an applicant tracking system, a salary page names a role, and a careers
 * landing page has somewhere to apply without having anything to apply to.
 */

/** A job board, showing you everything except a job. */
export const BOARD_FEED = {
  name: 'board-feed',
  path: '/linkedin/feed',
  html: `<!doctype html><html><head><title>Feed | LinkedIn</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Your feed</h1>
<p>Dana commented on a post about hiring. Sam is celebrating 3 years at Acme.</p>
<p>Someone you follow shared: "we are looking for people who care about compensation
transparency and benefits — full-time, remote".</p>
<label for="post">Start a post</label><textarea id="post"></textarea>
<button type="button">Post</button></div></body></html>`,
};

/** The page after you press submit. Nothing left to do here. */
export const THANK_YOU = {
  name: 'thank-you',
  path: '/greenhouse/acme/jobs/9001/confirmation',
  html: `<!doctype html><html><head><title>Application submitted — Acme</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Thanks — your application is in</h1>
<p>We have received your application for the Platform Engineer role. Our team
reviews every application; you will hear from us either way.</p>
<p>Acme is an equal opportunity employer.</p>
<p><a href="/greenhouse/acme/jobs">See other openings</a></p>
</div></body></html>`,
};

/** A salary page. Names a role, describes the work, cannot be applied to. */
export const SALARY_PAGE = {
  name: 'salary-page',
  path: '/salaries/software-engineer-at-acme',
  html: `<!doctype html><html><head><title>Software Engineer salaries at Acme</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Software Engineer salaries</h1>
<p>The median total compensation for a Software Engineer at Acme is reported by
412 people. Salary range by level, with years of experience:</p>
<ul><li>L3 — 0-2 years of experience</li><li>L4 — 3-5 years of experience</li></ul>
<h2>Benefits</h2><p>Reported benefits include full-time remote work.</p>
<p>Data is self-reported and not verified by Acme.</p>
</div></body></html>`,
};

/** A careers landing page with nothing open on it. */
export const CAREERS_LANDING = {
  name: 'careers-landing',
  path: '/vireo/careers',
  html: `<!doctype html><html><head><title>Careers at Vireo</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Careers at Vireo</h1>
<p>We are not hiring for any roles right now. We review every application we
receive and keep them on file, so it is still worth writing to us.</p>
<p><a href="/vireo/apply/general">Send a general application</a></p>
<h2>Benefits</h2><p>Full-time staff get the usual; compensation is reviewed yearly.</p>
</div></body></html>`,
};

/**
 * "Life at Vireo" — every hiring word there is, and nothing to apply to.
 *
 * The hardest kind of false positive, because it is written by the same
 * marketing team that writes the postings and reads like one on every signal
 * except the one that matters: there is no role and no form.
 */
export const LIFE_AT = {
  name: 'life-at',
  path: '/vireo/life',
  html: `<!doctype html><html><head><title>Life at Vireo — join our team</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Life at Vireo</h1>
<p>We are growing fast and we are always looking for talented people to join
our team. Here is what it is like to work here.</p>
<h2>What we look for</h2>
<ul><li>Ownership from day one</li><li>Bias to action</li><li>Strong communication skills</li></ul>
<h2>Benefits and compensation</h2>
<ul><li>Competitive salary and equity</li><li>Full-time remote or hybrid</li>
<li>Learning budget</li><li>Health, dental and vision</li></ul>
<h2>Our interview process</h2>
<p>A screen, a technical conversation, and a team day. We aim to give a
decision within a week of the final round.</p>
<p><a href="/vireo/careers">See open roles</a></p>
</div></body></html>`,
};

/**
 * A conference's call for speakers.
 *
 * A real form, with a name, an email, a bio and a long textarea asking what
 * you would talk about — which is the exact shape of an application form and
 * the exact shape of the question the autofill heuristic looks for. Filling
 * it in with somebody's cover letter would be a memorable way to fail.
 */
export const CALL_FOR_SPEAKERS = {
  name: 'call-for-speakers',
  path: '/confer/cfp',
  html: `<!doctype html><html><head><title>Call for speakers — Confer 2026</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Call for speakers</h1>
<p>Confer 2026 is open for proposals until March. We are looking for talks on
distributed systems, developer experience and anything you have built that
surprised you.</p>
<form>
<label>Your name <input name="name"></label>
<label>Email <input name="email" type="email"></label>
<label>Short bio <textarea name="bio"></textarea></label>
<label>What would you like to talk about, and why you? <textarea name="pitch"></textarea></label>
<label>Slides, if you have them <input type="file" name="slides"></label>
<button type="submit">Submit proposal</button>
</form>
</div></body></html>`,
};

/**
 * Contact us, with an attachment.
 *
 * Name, email, message and a file picker that says "attach your portfolio".
 * Every field an application form has, and not an application: offering here
 * would mean offering on a third of the web.
 */
export const CONTACT_FORM = {
  name: 'contact-form',
  path: '/studio/contact',
  html: `<!doctype html><html><head><title>Contact — Meridian Studio</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Get in touch</h1>
<p>Tell us about your project and we will come back to you within two working days.</p>
<form>
<label>Name <input name="name"></label>
<label>Email <input name="email" type="email"></label>
<label>Phone <input name="phone"></label>
<label>Company <input name="company"></label>
<label>How can we help? <textarea name="message"></textarea></label>
<label>Attach your portfolio <input type="file" name="portfolio"></label>
<button type="submit">Send</button>
</form>
</div></body></html>`,
};

/** A job-alert email, opened in webmail: five roles, five apply links, no posting. */
export const JOB_ALERT = {
  name: 'job-alert',
  path: '/mail/message/8812',
  html: `<!doctype html><html><head><title>Inbox — 5 new jobs matching "backend engineer"</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>5 new jobs matching your search</h1>
<ul>
<li><a href="/out?u=1">Backend Engineer — Helios Robotics</a> · Remote · Apply</li>
<li><a href="/out?u=2">Senior Backend Engineer — Vega Analytics</a> · Boston · Apply</li>
<li><a href="/out?u=3">Platform Engineer — Lyra Health</a> · Remote · Apply</li>
<li><a href="/out?u=4">Staff Engineer, Infrastructure — Cygnus</a> · NYC · Apply</li>
<li><a href="/out?u=5">Backend Engineer, Payments — Northwind</a> · Remote · Apply</li>
</ul>
<p>You are receiving this because you saved a search. Unsubscribe or change how
often we send these.</p>
</div></body></html>`,
};

/**
 * A recruiter's profile.
 *
 * Names four roles she is hiring for, in a title that ends with one. The
 * "names a role" rule is what decides most pages, and this is the page it is
 * most likely to get wrong.
 */
export const RECRUITER_PROFILE = {
  name: 'recruiter-profile',
  path: '/in/dana-okonkwo',
  html: `<!doctype html><html><head><title>Dana Okonkwo — Senior Technical Recruiter</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Dana Okonkwo</h1>
<p class="sub">Senior Technical Recruiter at Helios Robotics · Boston</p>
<h2>About</h2>
<p>I hire backend and platform engineers. Currently open on my desk: Backend
Engineer, Senior Backend Engineer, Platform Engineer, and Staff Engineer,
Infrastructure. Message me if you want a referral.</p>
<h2>Experience</h2>
<p>Senior Technical Recruiter, Helios Robotics — 2023 to now</p>
<p>Technical Recruiter, Vega Analytics — 2020 to 2023</p>
</div></body></html>`,
};

/**
 * A university course page.
 *
 * "Requirements", "Responsibilities", "Qualifications", twelve weeks of
 * distributed systems. Every heading a posting has, about a class.
 */
export const COURSE_PAGE = {
  name: 'course-page',
  path: '/courses/cs6650',
  html: `<!doctype html><html><head><title>CS 6650 — Building Scalable Distributed Systems</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>CS 6650 — Building Scalable Distributed Systems</h1>
<h2>Requirements</h2>
<p>CS 5800 or equivalent. Working knowledge of Java or Go.</p>
<h2>Responsibilities</h2>
<p>Four projects, a midterm, and a final systems build. Students are expected
to attend every lab.</p>
<h2>Qualifications</h2>
<p>Open to graduate students; undergraduates need instructor approval.</p>
<h2>Topics</h2>
<p>Consistency, replication, consensus, message queues, observability.</p>
</div></body></html>`,
};

/** A press release about hiring, which is news rather than a job. */
export const HIRING_NEWS = {
  name: 'hiring-news',
  path: '/press/2026-hiring',
  html: `<!doctype html><html><head><title>Helios Robotics to hire 500 engineers in 2026</title><style>${CHROME}</style></head>
<body><div class="wrap"><h1>Helios Robotics to hire 500 engineers in 2026</h1>
<p class="sub">Press release · Boston</p>
<p>Helios Robotics said today it will add 500 engineering roles over the next
year, most of them in backend, platform and hardware teams, following a
funding round that closed last month.</p>
<p>"We are looking for people who want to work on hard problems at scale,"
said the company's head of engineering. Compensation for the new roles will be
benchmarked against the Boston market, the company said.</p>
<p>Applications will open on the company's careers site in the spring.</p>
</div></body></html>`,
};


/*
 * A pull request, on the repository of a tool for job applications.
 *
 * Reported from life: the extension put a card up on
 * github.com/…/ResumeM-M/pull/16. It is the hardest false positive this
 * project can produce, because the page is genuinely full of the vocabulary
 * the detector scores on — the commit titles say "Apply", "application",
 * "cover letter" and "resume" over and over, since that is what the software
 * is about — and the page furniture is the shape of a form: a long textarea
 * for the comment box, a file picker for attachments, and a row of controls
 * labelled Reviewers, Assignees and Labels.
 *
 * Nothing on it is a job. There is no employer, no role being offered, and
 * nothing to submit an application to. Anyone who builds software for a living
 * is on a page like this several times a day, so offering here is not one
 * wasted card — it is the tool making itself unusable for its own author.
 */
export const CODE_REVIEW = {
  name: 'code-review',
  path: '/Jianwen-Ding/ResumeM-M/pull/16',
  html: `<!doctype html><html><head><title>Claude/hello 06h9rf by Jianwen-Ding · Pull Request #16 · Jianwen-Ding/ResumeM-M</title><style>${CHROME}</style></head>
<body><div class="wrap">
<h1>Claude/hello 06h9rf <span>#16</span></h1>
<div><span class="state">Merged</span> Jianwen-Ding merged 8 commits into <code>main</code> from <code>claude/hello-06h9rf</code></div>
<nav><a href="#conversation">Conversation 0</a><a href="#commits">Commits 8</a><a href="#files">Files changed 16</a></nav>
<div class="sidebar">
  <div><b>Reviewers</b> No reviews</div>
  <div><b>Assignees</b> No one assigned</div>
  <div><b>Labels</b> None yet</div>
  <div><b>Milestone</b> No milestone</div>
</div>
<h2 id="commits">Commits</h2>
<ul>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa1">Say, on the posting, that this one has been applied to before</a></li>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa2">Stop an application id being a path, and a rebuild being a deletion</a></li>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa3">Give the one-page rule somewhere to go when it is broken</a></li>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa4">Render cover letters through LaTeX, like the resume</a></li>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa5">Let the AI draft a cover letter and the application answers</a></li>
  <li><a href="/Jianwen-Ding/ResumeM-M/commit/aaa6">Search the letters and the answer bank, for the same reason as the tracker</a></li>
</ul>
<h2 id="files">Files changed</h2>
<ul>
  <li><a href="#d1">src/model/applications.ts</a> +192 −111</li>
  <li><a href="#d2">src/server/api.ts</a> +240 −38</li>
  <li><a href="#d3">web/app.js</a> +410 −22</li>
</ul>
<h2>Add a comment</h2>
<form>
  <label for="body">Comment</label>
  <textarea id="body" name="comment" rows="10" placeholder="Leave a comment"></textarea>
  <label for="att">Attach files by dragging and dropping, selecting or pasting them.</label>
  <input id="att" name="attachment" type="file">
  <button type="submit">Comment</button>
  <button type="button">Close pull request</button>
</form>
</div></body></html>`,
};


/*
 * The same pull request, on the Files changed tab.
 *
 * Worse than the conversation view, and the reason this is a separate fixture:
 * the diff being reviewed is the job-title detector itself. The page therefore
 * renders, as ordinary text, the detector's own vocabulary — "apply now",
 * "submit your application", "application form", "Apply — Helios", "Submit
 * application", "/helios/apply/platform-engineer" — in the quantities a word
 * list is written in. There is no more adversarial input available to this
 * project, and it is not contrived: it is a page its author reads every day.
 *
 * Lines are quoted from the real diff of Jianwen-Ding/ResumeM-M#16.
 */
export const CODE_REVIEW_DIFF = {
  name: 'code-review-diff',
  path: '/Jianwen-Ding/ResumeM-M/pull/16/files',
  html: `<!doctype html><html><head><title>Claude/hello 06h9rf by Jianwen-Ding · Pull Request #16 · Jianwen-Ding/ResumeM-M</title><style>${CHROME}</style></head>
<body><div class="wrap">
<h1>Claude/hello 06h9rf <span>#16</span></h1>
<nav><a href="#conversation">Conversation</a><a href="#files">Files changed 16</a></nav>
<div class="file"><h3>src/jobs/extract.ts</h3>
<pre class="diff">
@@ -297,6 +297,78 @@ const NOT_A_ROLE =
 /^(apply|apply now|apply here|apply (for|to)|application( form)?|job application|submit (your )?application|start (your )?application|careers?|jobs?|job (details?|description|posting|board)|candidate (portal|home|login)|requisition|vacanc(y|ies)|openings?|current openings|join us|work (with|for) us|home|welcome)$/i;
+/**
+ * The role, read out of the address, when the page itself never says it.
+ *
+ * This is for the link in the email that says "finish your application". It
+ * lands on the form rather than the description, with no posting read and no
+ * trail behind it, and a bare application form does not name the job. This one
+ * titles itself "Apply - Helios" and heads itself "Submit application", which
+ * is every such form there is.
+ *
+ * What that cost was not a label. Identity is the company and the role, so an
+ * application filed as "Unknown role" is a different job from the same job
+ * filed from its posting: opening the posting afterwards filed a second
+ * tracker row, and the card said nothing about having applied, on the one page
+ * where that was worth saying. One job, two rows, and the address had the
+ * answer in it the whole time: /helios/apply/platform-engineer.
+ */
+export function roleFromUrl(url) {
+  const words = segments.filter((seg) => ROLE_NOUN.test(seg) && !NOT_A_ROLE.test(seg));
+  return titleCase(words.join(' '));
+}
</pre></div>
<div class="file"><h3>src/server/api.ts</h3>
<pre class="diff">
+      const sent = alreadySent(data.applications, job.company, job.role);
+      res.json({ applied: sent ? { id: sent.id, at: sent.appliedAt, status: sent.status } : null });
</pre></div>
<h2>Review changes</h2>
<form>
  <label for="body">Leave a comment</label>
  <textarea id="body" name="comment" rows="10" placeholder="Leave a comment"></textarea>
  <input id="att" name="attachment" type="file">
  <button type="submit">Submit review</button>
</form>
</div></body></html>`,
};


/*
 * A coding-assistant chat, discussing this very tool.
 *
 * Reported from life, alongside the pull request, and the pair of them is what
 * finally named the problem: neither page is a job, and both are pages that
 * *talk about* job applications. The vocabulary really is there — cover
 * letter, application, resume, "why do you want to work here", Platform
 * Engineer, the names of employers — because that is the subject. And the
 * furniture really is form-shaped: one long textarea to type into, a file
 * picker for attachments, a submit button.
 *
 * Nothing in the word counting can tell this from an application form. What
 * can is that this page has no interest in who you are: there is no name field
 * and no email field, because the site already knows. Every application form
 * ever written asks for both.
 */
export const ASSISTANT_CHAT = {
  name: 'assistant-chat',
  path: '/code/session_01MAG',
  html: `<!doctype html><html><head><title>Claude Code</title><style>${CHROME}</style></head>
<body><div class="wrap">
<h1>Claude Code</h1>
<div class="thread">
  <div class="turn"><b>You</b><p>Can you draft a cover letter for the Platform Engineer posting at Helios?
  I want to reuse the answer I gave about why do you want to work here.</p></div>
  <div class="turn"><b>Claude</b><p>I have read the job description and the requirements. The posting asks
  for years of experience with distributed systems and lists responsibilities around build pipelines.
  Here is a draft that adapts your earlier application answer.</p></div>
  <div class="turn"><b>You</b><p>Also make the resume fit on one page, and attach the resume to the
  application form when you submit application materials.</p></div>
  <div class="turn"><b>Claude</b><p>Done. The resume compiles to one page and the cover letter is
  drafted. Your qualifications line up with what they are looking for.</p></div>
</div>
<form>
  <label for="composer">Reply to Claude</label>
  <textarea id="composer" name="prompt" rows="6" placeholder="Reply to Claude…"></textarea>
  <input id="upload" name="attachment" type="file">
  <button type="submit">Send</button>
</form>
</div></body></html>`,
};

export const QUIET = [CAREERS_ARTICLE, SHOP, SIGN_IN, DOCS, SPA_SHELL, FORUM_THREAD, BLOG,
  BOARD_FEED, THANK_YOU, SALARY_PAGE, CAREERS_LANDING,
  /*
   * The second batch, chosen for being harder than the first. Two of them
   * carry a real form with a file picker and a long textarea — the shape the
   * actionability gate exists to tell apart from an application — and three
   * are written in the vocabulary a posting is written in, by the people who
   * write postings.
   */
  LIFE_AT, CALL_FOR_SPEAKERS, CONTACT_FORM, JOB_ALERT, RECRUITER_PROFILE, COURSE_PAGE, HIRING_NEWS,
  /* Reported from life; see the notes on the fixtures. */
  CODE_REVIEW, CODE_REVIEW_DIFF, ASSISTANT_CHAT];

/**
 * A posting on a page the size of a real one.
 *
 * Every other fixture here is a few kilobytes, which is right for asking
 * whether something works and useless for asking how long it takes. A posting
 * on a modern board arrives inside a megabyte or two of application shell: a
 * bundle inlined into the markup, a few thousand nodes of chrome, and the
 * description somewhere in the middle. Reading that page is the most expensive
 * thing the extension does, and it does it on every page you visit.
 */
const FILLER_NODE = (i) =>
  `<div class="row" data-idx="${i}"><span class="k">field_${i}</span><span class="v">value ${i} ` +
  `lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod</span></div>`;

const BUNDLE = `
  window.__APP_STATE__ = ${JSON.stringify({
    strings: Array.from({ length: 400 }, (_, i) => `string_${i}_lorem_ipsum_dolor_sit_amet_${'x'.repeat(40)}`),
    routes: Array.from({ length: 200 }, (_, i) => ({ path: `/r/${i}`, chunk: `chunk-${i}-${'y'.repeat(60)}` })),
  })};
  function boot(){ /* ${'z'.repeat(20000)} */ }
`;

export const HEAVY_POSTING = {
  name: 'heavy-posting',
  path: '/lumen/careers/staff-platform-engineer',
  company: 'Lumen',
  title: 'Staff Platform Engineer',
  html: `<!doctype html>
<html><head><title>Staff Platform Engineer at Lumen</title><style>${CHROME}</style>
<script>${BUNDLE}</script></head>
<body>
  <div class="hdr"><h1>Lumen</h1></div>
  <nav>${Array.from({ length: 300 }, (_, i) => `<a href="/n/${i}">Nav item ${i}</a>`).join('')}</nav>
  <div class="wrap">
    <h1>Staff Platform Engineer</h1>
    ${ROLE_BODY}
    <p><a href="/lumen/apply/staff-platform-engineer">Apply now</a></p>
  </div>
  <aside>${Array.from({ length: 2500 }, (_, i) => FILLER_NODE(i)).join('')}</aside>
  <script>${BUNDLE}</script>
</body></html>`,
};


export const NAVIGATION = [
  CYGNUS_BOARD, CYGNUS_ROLE_A, CYGNUS_ROLE_B, FRAMED_ROLE, FRAMED_FORM, ADVERT_FRAME, ADVERT_CONTENT,
  EMBEDDED_BOARD, EMBEDDED_BOARD_FRAME, BLOG_WITH_FORM, BLOG_ENQUIRY_FRAME, LATE_RENDER,
  CROWDED_PAGE, CROWDED_PAGE_FORM,
  LEVER_ROLE, LEVER_FORM, ASHBY_ROLE, ASHBY_FORM, WORKDAY,
  OWN_SITE, ATS_FORM, ATS_FORM_UNANSWERABLE, NEW_TAB_ROLE, NEW_TAB_FORM, STEP_ONE, STEP_TWO, SPA_BOARD,
  LETTER_SPA, LETTER_SPA_FORM, LETTER_SPA_PLAIN,
];

export const ALL = [STREAMLY, NORTHWIND, HELIOS_ROLE, HELIOS_FORM, HEAVY_POSTING, ...QUIET, ...NAVIGATION];

/**
 * Serve every fixture from one origin. Returns the base url and a `urlFor`
 * helper so callers do not hard-code ports.
 *
 * `hold` names routes whose response is opened and then never finished. A
 * third-party frame that hangs is an ordinary fact of the pages this runs on —
 * a tracker, an advert, a chat widget whose host is having a bad day — and the
 * page's `load` event never fires while one is outstanding. Anything the
 * extension does at load time therefore never happens either, which is not a
 * timing question but a permanent one, and the only way to ask it is to hold a
 * response open on purpose.
 *
 * `headers` are added to every page served. The one that matters is
 * Content-Security-Policy: applicant tracking systems handle identity
 * documents and salary figures and ship some of the strictest policies on the
 * web, so "does the card draw under a policy that forbids inline style" is a
 * question about the systems this tool exists for rather than an exotic one.
 */
export function serveFixtures(
  fixtures = ALL,
  { vars = {}, hostname = '127.0.0.1', hold = null, headers = {} } = {},
) {
  return new Promise((resolve) => {
    /** Held responses, so closing the server does not leave sockets open. */
    const holding = [];
    const server = http.createServer((req, res) => {
      if (hold?.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // Enough to be a document, never enough to be a finished one.
        res.write('<!doctype html><html><body><p>Sponsored</p>');
        holding.push(res);
        return;
      }
      /*
       * Longest path wins. Matching on the first prefix served the role page
       * at the form's own address, because /lever/vega/8f21 is a prefix of
       * /lever/vega/8f21/apply — which is exactly the shape every one of
       * these systems uses.
       */
      const url = req.url.split('?')[0];
      const match = [...fixtures]
        .filter((f) => url === f.path || url.startsWith(`${f.path}/`) || url.startsWith(f.path))
        .sort((a, b) => b.path.length - a.path.length)[0];

      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body>Not found</body></html>');
        return;
      }
      // charset matters: an em dash in a page title came back as mojibake
      // without it, which looks like a bug in the extension rather than here.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      // `{{NAME}}` lets one fixture link to another server's origin, which is
      // how the careers-site-to-ATS hand-off is modelled.
      res.end(Object.entries(vars).reduce((html, [k, v]) => html.split(`{{${k}}}`).join(v), match.html));
    });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://${hostname}:${server.address().port}`;
      resolve({
        base,
        urlFor: (f) => `${base}${f.path}`,
        close: () => {
          for (const res of holding) {
            try {
              res.end();
            } catch {
              // Already gone with the page that asked for it.
            }
          }
          server.close();
        },
      });
    });
  });
}

/**
 * The real server, with one route made slow.
 *
 * Some of the extension's worst behaviour only appears while it is waiting: a
 * pass that takes longer than it takes the user to move on, and then lands
 * anyway. Against a local server every call returns in a couple of hundred
 * milliseconds, so that window never opens and the bug is invisible — while in
 * use it is the ordinary case, since analysis with the AI enabled takes
 * minutes. Putting a deliberate delay in front of one route makes it a fact
 * rather than a matter of timing luck.
 */
/**
 * `respondInstead(url, requestBody, lastReply)` lets a suite answer a slowed
 * route itself instead of forwarding it. Two things need that. A tailoring
 * pass with the AI on starts a real model on the server — minutes, a bill,
 * and an answer nobody can predict — which is not something a test should
 * cause; and the interesting replies here are the ones a healthy server never
 * sends. `lastReply` is the last body this proxy passed through for the same
 * route, so a stand-in can be the real shape with one field changed rather
 * than a hand-written imitation that drifts.
 */
export function serveSlowProxy(target, { slowRoute = /analyze/, ms = 4000, skip = 0, respondInstead } = {}) {
  let seen = 0;
  let lastReply = null;
  /*
   * Requests the client walked away from, by route.
   *
   * The Stop button's whole claim is that it lets go of the connection rather
   * than hiding the spinner, and the only place that is observable is the
   * other end of the socket. Counted here so a suite can say the browser
   * really did hang up, which no amount of reading the card can establish.
   */
  const dropped = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let answered = false;
      res.on('close', () => {
        if (!answered) dropped.push(req.url);
      });
      const forward = async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        // `skip` lets the first few through at full speed, which is how a
        // route the card needs *before* it can be clicked — the opening
        // analysis — can be slowed on the second call and not the first.
        if (slowRoute.test(req.url) && seen++ >= skip) await new Promise((r) => setTimeout(r, ms));

        /*
         * Gone before we got there, so there is nothing to ask for.
         *
         * A real proxy does not finish an errand for somebody who has walked
         * out, and here it matters twice: forwarding a request the browser
         * abandoned would run the work anyway — which for a tailoring pass
         * means starting a model — and the reply would go nowhere. The point
         * of the stop is that the work is not done.
         */
        /*
         * Gone before we got there, so there is nothing to ask for.
         *
         * A real proxy does not finish an errand for somebody who has walked
         * out, and here it matters twice: forwarding a request the browser
         * abandoned would run the work anyway — which for a tailoring pass
         * means starting a model — and the reply would go nowhere. The point
         * of the stop is that the work is not done.
         */
        if (res.writableEnded || res.destroyed) return;

        const standIn = respondInstead?.(req.url, Buffer.concat(chunks).toString(), lastReply);
        if (standIn) {
          answered = true;
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(JSON.stringify(standIn));
          return;
        }

        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
        // Nothing to answer if the client has already gone; writing to a
        // closed socket throws and would be reported as a 502 the browser is
        // not there to read.
        if (res.writableEnded || res.destroyed) return;
        answered = true;
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'access-control-allow-origin': '*',
        });
        const body = Buffer.from(await upstream.arrayBuffer());
        if (slowRoute.test(req.url) && /json/.test(upstream.headers.get('content-type') ?? '')) {
          try {
            lastReply = JSON.parse(body.toString());
          } catch {
            // Not something a stand-in could be built from; leave the last one.
          }
        }
        res.end(body);
      };
      forward().catch((err) => {
        if (res.writableEnded || res.destroyed) return;
        answered = true;
        res.writeHead(502);
        res.end(String(err));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        /** Routes the browser hung up on before an answer was written. */
        dropped,
        close: () => server.close(),
      }),
    );
  });
}

/** Point the extension at a different server, from a page that has `chrome`. */
export async function useServer(context, serverUrl) {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
  await page.evaluate((url) => chrome.storage.sync.set({ serverUrl: url }), serverUrl);
  await page.close();
}

/** Locate the Chromium this environment provides. */
export function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(
    (r) => r && fs.existsSync(r),
  );
  for (const root of roots) {
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chromium') || dir.includes('headless_shell')) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return ['/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
}

/**
 * Resume ids a test run is allowed to delete. Anything the extension generates
 * is prefixed `job-`, and the harness names its own fixtures `shot-`.
 *
 * This list is the whole safety mechanism: an earlier version deleted whatever
 * `resumeId` each application pointed at, which cheerfully removed the real
 * `newgrad` and `intern` resumes the moment a test tracked an application
 * against one.
 */
const DELETABLE_RESUME = /^(job|shot)-/;

/** Remove anything a run wrote to the store, so tests leave no trace. */
export async function cleanStore(server, companies) {
  const { applications, error } = await (await fetch(`${server}/api/applications`)).json();
  /*
   * A server with no save open answers every route with an error and no data,
   * and reading `.filter` off that produced "Cannot read properties of
   * undefined" at the end of a five-minute run — a stack trace in this file,
   * naming nothing about the server it was talking to. Say what is actually
   * wrong, in the one sentence that fixes it.
   */
  if (!Array.isArray(applications)) {
    throw new Error(
      `${server} would not list applications${error ? `: ${error}` : ''}. ` +
        'Open a save in ResumeM-M first, or point RMM_SERVER at one that has one.',
    );
  }
  for (const app of applications.filter((a) => companies.includes(a.company))) {
    await fetch(`${server}/api/applications/${encodeURIComponent(app.id)}`, { method: 'DELETE' });
    if (app.resumeId && DELETABLE_RESUME.test(app.resumeId)) {
      await fetch(`${server}/api/resumes/${encodeURIComponent(app.resumeId)}`, { method: 'DELETE' });
    }
  }

  // Workspace drafts outlive the applications they were opened for, so they
  // need clearing too — otherwise the next run photographs the last run's
  // leftovers and calls it the empty state.
  const drafts = await (await fetch(`${server}/api/workspace`)).json().catch(() => ({ drafts: [] }));
  for (const draft of drafts.drafts ?? []) {
    if (!companies.includes(draft.company)) continue;
    await fetch(`${server}/api/workspace/${encodeURIComponent(draft.id)}`, { method: 'DELETE' });
  }
}

/**
 * A reachable server is not a usable one: with no save open it answers every
 * route with an error and no data, and the run then failed minutes later
 * inside a fixture, reading a field off undefined. Health says which it is, so
 * check it here where the message can name the fix.
 */
export async function requireOpenSave(server) {
  let health;
  try {
    const res = await fetch(`${server}/health`);
    if (!res.ok) throw new Error(String(res.status));
    health = await res.json();
  } catch {
    console.error(`No ResumeM-M server at ${server}. Start one there with \`npm run serve\`.`);
    process.exit(2);
  }
  if (!health.projectOpen) {
    console.error(
      `${server} is running with no save open, so every request will fail. ` +
        'Open one in Save & Files, or start a scratch server:\n' +
        '  RMM_DATA=/tmp/rmm-test-store PORT=4788 npm run serve   (in the ResumeM-M checkout)\n' +
        '  RMM_SERVER=http://127.0.0.1:4788 npm test               (here)',
    );
    process.exit(2);
  }
  return health;
}

/**
 * Point the extension itself at the server this run is using.
 *
 * `RMM_SERVER` only ever reached the harness's own `fetch` calls; the extension
 * went on asking its default address. So a run against a scratch server tested
 * the extension against whatever happened to be on 4600 — and when that had no
 * save open, the card sat on "reading the posting" until the timeout, thirty
 * seconds later, saying nothing about which server had refused.
 */
/**
 * The extension's service worker, once it can actually be talked to.
 *
 * `context.serviceWorkers()[0]` hands back the worker target as soon as it
 * exists, which is not the same moment its extension APIs are bound. On a
 * loaded machine the gap is wide enough to fall into: a suite evaluated in it
 * and got `Cannot read properties of undefined (reading 'query')` from
 * `chrome.tabs.query` — inside an extension worker, where `chrome.tabs` is
 * never legitimately absent.
 *
 * So the wait is for the thing that is actually needed rather than for the
 * target to appear. Said plainly if it never arrives, because "chrome.tabs is
 * undefined" one call later is a sentence nobody can act on.
 */
export async function extensionWorker(context, { timeout = 60_000 } = {}) {
  const until = Date.now() + timeout;
  /*
   * Polled, not waited for once.
   *
   * `context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')`
   * reads the list once and then listens, and a worker that registers in the
   * gap between those two is in neither: the list was empty when it was read
   * and the event had already fired by the time anything was listening. The
   * wait then runs its whole timeout and fails with an empty log — which is
   * exactly how it failed, in three different suites, only ever when several
   * browsers were starting at once.
   *
   *   browserContext.waitForEvent: Timeout 30000ms exceeded
   *     while waiting for event "serviceworker"
   *   log: []
   *
   * Re-reading the list every few seconds closes the gap, and the budget is
   * generous because the thing being waited for is a browser starting on a
   * machine running fifteen others.
   */
  let worker = context.serviceWorkers()[0];
  while (!worker && Date.now() < until) {
    const left = Math.max(500, Math.min(5000, until - Date.now()));
    worker = await context
      .waitForEvent('serviceworker', { timeout: left })
      .catch(() => context.serviceWorkers()[0]);
  }
  if (!worker) {
    throw new Error(
      `The extension's service worker never started, after ${Math.round(timeout / 1000)}s. ` +
        'That is the browser, not this suite: nothing here can proceed without it.',
    );
  }
  for (;;) {
    const ready = await worker.evaluate(() => Boolean(globalThis.chrome?.tabs?.query)).catch(() => false);
    if (ready) return worker;
    if (Date.now() > until) {
      throw new Error(
        'The extension service worker is running but its APIs never appeared — ' +
          '`chrome.tabs` is still undefined after ' + Math.round(timeout / 1000) + 's. ' +
          'That is the browser starting the worker and not finishing, not anything this suite did.',
      );
    }
    await new Promise((go) => setTimeout(go, 100));
  }
}

export async function pointExtensionAt(context, worker, server) {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
  await setup.evaluate((s) => chrome.storage.sync.set({ serverUrl: s }), server);
  await setup.close();
}

/* ------------------------------------------------------------------ *
 * Three applications open at once                                     *
 * ------------------------------------------------------------------ *
 *
 * `tests/tabs.mjs` needs three postings that can be told apart by every
 * surface the card has: a different employer, a different job, and a
 * description that tailors to a different set of skills. Everything already
 * here that comes in a description-then-form pair — Helios, Vega, Lyra, Nova —
 * shares `ROLE_BODY` and the title "Platform Engineer", so a card showing one
 * tab's proposal in another tab's window would look exactly right. Three pairs
 * are added rather than the existing ones reused, because a test that cannot
 * distinguish its own fixtures cannot detect them being swapped.
 *
 * One skills group tells all three apart on its own. The store keeps Languages
 * as Python, SQL, TypeScript, Java, Go and C, and a keyword match against
 * these three descriptions narrows it three ways: Python and SQL for Harbour,
 * TypeScript for Marigold, Go for Kestrel. So "which posting is this proposal
 * for" is one word in one row — on the card, and in the resume that reaches
 * the store.
 *
 * Their forms name nobody. That is the ordinary case — a posting on a careers
 * site, an Apply link to an applicant tracking system, and a page there whose
 * address is a number — and it is the case that matters here: with nothing on
 * the form to read, who is being applied to can only come from the trail this
 * tab walked. So the company and the role on the form's card are a direct
 * reading of whether the tab kept its own trail, which they are not on
 * `HELIOS_FORM`, whose heading says "Helios" in so many words.
 */

/** Pricing models: Python, SQL and a warehouse. No Kafka, no React. */
export const HARBOUR_ROLE = {
  name: 'harbour-role',
  path: '/harbour/careers/data-scientist-pricing',
  company: 'Harbour Analytics',
  title: 'Data Scientist, Pricing',
  html: page(
    'Data Scientist, Pricing at Harbour Analytics',
    'Harbour Analytics',
    `<h2>About the role</h2>
     <p>We are looking for a data scientist to own our pricing and demand
        models. You will build them in Python and SQL against a PostgreSQL
        warehouse and ship them to production yourself.</p>
     <h2>Minimum qualifications</h2>
     <ul><li>Years of experience with statistics</li><li>Experience with SQL and PostgreSQL</li></ul>
     <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>
     <p><a href="/gh/j/4821">Apply now</a></p>`,
  ),
};

/** The form Harbour's Apply link goes to: an address and a number. */
export const HARBOUR_FORM = {
  name: 'harbour-form',
  path: '/gh/j/4821',
  html: page('Application', 'Application', FORM_BODY),
};

/** A design system: React, TypeScript, Node.js. No Kafka, no warehouse. */
export const MARIGOLD_ROLE = {
  name: 'marigold-role',
  path: '/marigold/jobs/design-systems',
  company: 'Marigold',
  title: 'Frontend Engineer, Design Systems',
  html: page(
    'Frontend Engineer, Design Systems at Marigold',
    'Marigold',
    `<h2>About the role</h2>
     <p>We are looking for a frontend engineer to own our design system. You
        will build accessible components in React and TypeScript, with some
        Node.js behind the tooling that ships them.</p>
     <h2>Minimum qualifications</h2>
     <ul><li>Two years of experience with modern JavaScript</li><li>Experience with React and TypeScript</li></ul>
     <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>
     <p><a href="/gh/j/9912">Apply for this job</a></p>`,
  ),
};

/** And Marigold's, at the same kind of address on the same host. */
export const MARIGOLD_FORM = {
  name: 'marigold-form',
  path: '/gh/j/9912',
  html: page('Application', 'Application', FORM_BODY),
};

/** A streaming estate: Kafka, Go, Kubernetes. No React, no warehouse. */
export const KESTREL_ROLE = {
  name: 'kestrel-role',
  path: '/kestrel/careers/streaming-infrastructure-engineer',
  company: 'Kestrel Freight',
  title: 'Streaming Infrastructure Engineer',
  html: page(
    'Streaming Infrastructure Engineer at Kestrel Freight',
    'Kestrel Freight',
    `<h2>About the role</h2>
     <p>We are looking for an engineer to run the Kafka estate our shipment
        tracking is built on. You will own the streaming infrastructure end to
        end, in Go, on Kubernetes, with the Docker and AWS plumbing that ships
        it.</p>
     <h2>Minimum qualifications</h2>
     <ul><li>Experience with distributed systems and Kafka</li><li>Years of experience with Go and Kubernetes</li></ul>
     <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>
     <p><a href="/gh/j/7730">Apply now</a></p>`,
  ),
};

/** And Kestrel's, the third numbered address on the same host. */
export const KESTREL_FORM = {
  name: 'kestrel-form',
  path: '/gh/j/7730',
  html: page('Application', 'Application', FORM_BODY),
};
