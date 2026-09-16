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

export const NAVIGATION = [
  LEVER_ROLE, LEVER_FORM, ASHBY_ROLE, ASHBY_FORM, WORKDAY,
  OWN_SITE, ATS_FORM, NEW_TAB_ROLE, NEW_TAB_FORM, STEP_ONE, STEP_TWO,
];

export const ALL = [STREAMLY, NORTHWIND, BLOG, HELIOS_ROLE, HELIOS_FORM, ...NAVIGATION];

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
  const { applications } = await (await fetch(`${server}/api/applications`)).json();
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
