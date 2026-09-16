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

export const ALL = [STREAMLY, NORTHWIND, BLOG];

/**
 * Serve every fixture from one origin. Returns the base url and a `urlFor`
 * helper so callers do not hard-code ports.
 */
export function serveFixtures(fixtures = ALL) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const match = fixtures.find((f) => req.url.startsWith(f.path));
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>Not found</body></html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(match.html);
    });
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
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
