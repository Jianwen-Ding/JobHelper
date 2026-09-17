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

export const QUIET = [CAREERS_ARTICLE, SHOP, SIGN_IN, DOCS, SPA_SHELL, FORUM_THREAD, BLOG];

export const NAVIGATION = [
  CYGNUS_BOARD, CYGNUS_ROLE_A, CYGNUS_ROLE_B, FRAMED_ROLE, FRAMED_FORM, ADVERT_FRAME, ADVERT_CONTENT,
  EMBEDDED_BOARD, EMBEDDED_BOARD_FRAME, BLOG_WITH_FORM, BLOG_ENQUIRY_FRAME, LATE_RENDER,
  CROWDED_PAGE, CROWDED_PAGE_FORM,
  LEVER_ROLE, LEVER_FORM, ASHBY_ROLE, ASHBY_FORM, WORKDAY,
  OWN_SITE, ATS_FORM, NEW_TAB_ROLE, NEW_TAB_FORM, STEP_ONE, STEP_TWO, SPA_BOARD,
];

export const ALL = [STREAMLY, NORTHWIND, HELIOS_ROLE, HELIOS_FORM, ...QUIET, ...NAVIGATION];

/**
 * Serve every fixture from one origin. Returns the base url and a `urlFor`
 * helper so callers do not hard-code ports.
 */
export function serveFixtures(fixtures = ALL, { vars = {}, hostname = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // `{{NAME}}` lets one fixture link to another server's origin, which is
      // how the careers-site-to-ATS hand-off is modelled.
      res.end(Object.entries(vars).reduce((html, [k, v]) => html.split(`{{${k}}}`).join(v), match.html));
    });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://${hostname}:${server.address().port}`;
      resolve({
        base,
        urlFor: (f) => `${base}${f.path}`,
        close: () => server.close(),
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
export function serveSlowProxy(target, { slowRoute = /analyze/, ms = 4000 } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const forward = async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (slowRoute.test(req.url)) await new Promise((r) => setTimeout(r, ms));

        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'access-control-allow-origin': '*',
        });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      };
      forward().catch((err) => {
        res.writeHead(502);
        res.end(String(err));
      });
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
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
export async function pointExtensionAt(context, worker, server) {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
  await setup.evaluate((s) => chrome.storage.sync.set({ serverUrl: s }), server);
  await setup.close();
}
