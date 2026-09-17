/**
 * The whole suite, several at a time.
 *
 * Thirteen Playwright scripts chained with `&&` took ten minutes, and they
 * were serial for one reason: they share a ResumeM-M store. Each one builds
 * resumes and bundles into it, and several then check it was left as they
 * found it — so two running at once do not fail, they fail *each other*,
 * which is worse than slow.
 *
 * Give each one its own server over its own copy of the store and the reason
 * goes away. Everything else a suite touches is already private to it: the
 * fixture web server takes an OS-assigned port, and the browser profile is a
 * fresh mkdtemp.
 *
 * ## Running it
 *
 *   RMM_SERVERS=http://127.0.0.1:4788,http://127.0.0.1:4789 node tests/run.mjs
 *
 * One server is fine — it just runs one at a time, which is what the old
 * chain did. To start a pool, from a ResumeM-M checkout:
 *
 *   for p in 4788 4789 4790; do
 *     cp -r /path/to/store /tmp/store-$p
 *     node dist/src/cli.js serve --port $p --data /tmp/store-$p &
 *   done
 *
 * ## Choosing how many
 *
 * Headless Chromium is not cheap and this suite's assertions are about
 * timing — a card that appears, a letter that survives a navigation. Loading
 * the machine past its cores turns those into flakes, and a flaky suite is
 * not a faster one. So the default is one worker per two cores, capped by the
 * pool, and `JH_JOBS` overrides it.
 *
 *   node tests/run.mjs --only e2e,card     # just these
 *   JH_JOBS=1 node tests/run.mjs           # back to serial
 *
 * For the same reason, do not run anything else heavy alongside it. A full
 * ResumeM-M unit run at the same time — pdflatex and all — once turned a
 * passing suite into a thirty-second timeout on a card that renders in one,
 * and the failure looked like the product.
 */

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/**
 * Every suite, with a rough cost in seconds.
 *
 * The cost is only used to start the long ones first: with three workers and
 * a two-minute suite left until last, the wall clock is two minutes whatever
 * else finished early. They do not need to be exact, only ordered — but they
 * are kept roughly honest, because a number that is wrong by a factor of ten
 * schedules the wrong suite first and nobody notices.
 */
const SUITES = [
  { name: 'nav', file: 'navigation.mjs', cost: 125 },
  { name: 'ats-journey', file: 'ats-journey.mjs', cost: 75 },
  { name: 'adverse', file: 'adverse.mjs', cost: 53 },
  { name: 'carrying', file: 'carrying.mjs', cost: 45 },
  { name: 'quiet', file: 'quiet.mjs', cost: 35 },
  { name: 'e2e', file: 'e2e.mjs', cost: 21 },
  { name: 'journey', file: 'journey.mjs', cost: 18 },
  { name: 'roundtrip', file: 'roundtrip.mjs', cost: 12 },
  { name: 'joins', file: 'joins.mjs', cost: 12 },
  { name: 'card', file: 'card.mjs', cost: 6 },
  { name: 'ats-forms', file: 'ats-forms.mjs', cost: 6 },
  { name: 'autofill', file: 'autofill.mjs', cost: 2 },
  { name: 'ats', file: 'ats.mjs', cost: 1, nodeTest: true },
  { name: 'trail', file: 'trail.mjs', cost: 1, nodeTest: true },
];

const pool = (process.env.RMM_SERVERS ?? process.env.RMM_SERVER ?? 'http://127.0.0.1:4600')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const only = (() => {
  const at = process.argv.indexOf('--only');
  if (at < 0) return null;
  return new Set((process.argv[at + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
})();

const wanted = SUITES.filter((s) => !only || only.has(s.name)).sort((a, b) => b.cost - a.cost);
if (only) {
  for (const name of only) {
    if (!SUITES.some((s) => s.name === name)) {
      console.error(`No suite called "${name}". Known: ${SUITES.map((s) => s.name).join(', ')}`);
      process.exit(2);
    }
  }
}

const jobs = Math.max(
  1,
  Math.min(pool.length, wanted.length, Number(process.env.JH_JOBS) || Math.max(1, Math.floor(os.cpus().length / 2))),
);

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: 1, out: `${out}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

/**
 * The last line of a suite that says how it went.
 *
 * Two conventions in here: the Playwright scripts print "34/34 checks
 * passed", and the two `node --test` files print TAP. Rather than teach the
 * runner both, it reports the exit code and quotes whichever of those it can
 * find, so a suite that grows a third convention still shows up honestly.
 */
function summarise(out) {
  const checks = [...out.matchAll(/^(\d+)\/(\d+) checks passed$/gm)].pop();
  if (checks) return `${checks[1]}/${checks[2]} checks`;
  const pass = /^# pass (\d+)$/m.exec(out);
  const fail = /^# fail (\d+)$/m.exec(out);
  if (pass && fail) return `${pass[1]} pass, ${fail[1]} fail`;
  return '';
}

const clock = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * The two things this whole arrangement assumes, asked out loud.
 *
 * Running several suites at once is safe for exactly two reasons: every server
 * is running the same code, and no two of them are writing to the same store.
 * Neither was ever checked, and both turned out to be false.
 *
 * A server keeps serving whatever it loaded at start: `tsx` compiles once and
 * `dist/` is a snapshot, so a process left running from this morning answers
 * the way this morning's code did. A suite failed here for sixty seconds on a
 * feature that worked, because one server in its pool predated the feature and
 * quietly did the old thing instead.
 *
 * And the store: `rmm serve --data <folder>` accepted the flag and ignored it,
 * so three servers each given their own copy of a store were in fact three
 * servers writing to the one real save — the exact collision the pool exists
 * to avoid, and the user's actual data besides. `/health` says which folder it
 * opened, so this asks rather than assumes.
 *
 * One request each, before anything starts.
 */
async function poolAgrees() {
  const servers = await Promise.all(
    pool.map(async (server) => {
      try {
        const res = await fetch(`${server}/health?fresh`);
        const { build, ok, dataDir, stale } = await res.json();
        return { server, build: ok ? (build ?? 'unknown') : 'not ok', dataDir: dataDir ?? null, stale: stale === true };
      } catch (err) {
        return { server, build: `unreachable: ${(err && err.message) || err}`, dataDir: null, stale: false };
      }
    }),
  );

  const builds = [...new Set(servers.map((s) => s.build))];
  if (builds.length > 1 || /unreachable|not ok|unknown/.test(builds[0])) {
    return [
      'The servers in the pool are not all running the same build:',
      ...servers.map((s) => `  ${s.server}  ${s.build}`),
      '',
      'A server keeps serving whatever it loaded at start, so a leftover process',
      'answers the way its code did when it started. Restart them and try again.',
      // "unknown" is an older server that predates this check, which is itself
      // the situation the check exists for.
      builds.includes('unknown') ? 'One of them is too old to say which build it is, which is its own answer.' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /*
   * All of them stale together is the ordinary case: the code was edited while
   * they were running. Comparing them to each other cannot see it, because
   * they agree — with each other, and with nothing on disk.
   *
   * `JH_ALLOW_STALE=1` is for the case where the edit was a comment and you
   * know it. A check with no way past it gets deleted the first time it is
   * wrong, and then it is not there the time it is right.
   */
  const stale = servers.filter((s) => s.stale);
  if (stale.length && process.env.JH_ALLOW_STALE === '1') {
    console.log(`(${stale.length} of ${servers.length} servers are older than the code on disk; JH_ALLOW_STALE is set)\n`);
  } else if (servers.every((s) => s.stale)) {
    return [
      'Every server in the pool is older than the code on disk.',
      '',
      'They agree with each other and with nothing else, so a suite that fails',
      'here is failing against code nobody is looking at. Rebuild and restart',
      'them: npm run build, then rmm serve --port N --data /tmp/store-N.',
    ].join('\n');
  } else if (stale.length) {
    return [
      'Some of the servers are older than the code on disk:',
      ...servers.map((s) => `  ${s.server}  ${s.stale ? 'stale' : 'current'}`),
      '',
      'Restart them all against the same build and try again.',
    ].join('\n');
  }

  const shared = servers.filter((s, i) => s.dataDir && servers.findIndex((o) => o.dataDir === s.dataDir) !== i);
  if (shared.length) {
    return [
      'Two servers in the pool have the same save open:',
      ...servers.map((s) => `  ${s.server}  ${s.dataDir ?? 'not saying'}`),
      '',
      'Suites build resumes and bundles and then check the save was left as they',
      'found it, so two sharing one do not run slower — they fail each other.',
      'Give each server its own copy: rmm serve --port N --data /tmp/store-N.',
    ].join('\n');
  }
  return null;
}

async function main() {
  const started = Date.now();

  const disagreement = await poolAgrees();
  if (disagreement) {
    console.error(disagreement);
    process.exit(2);
  }

  // First, and alone. A syntax error makes every suite below fail
  // identically and none of them says why — see tests/parse.mjs.
  if (!only) {
    const parse = await run(process.execPath, ['tests/parse.mjs'], {});
    if (parse.code !== 0) {
      process.stdout.write(parse.out);
      console.error('\nSources do not parse; nothing else would have told you that.');
      process.exit(1);
    }
  }

  console.log(
    `${wanted.length} suites, ${jobs} at a time, across ${pool.length} server${pool.length === 1 ? '' : 's'}\n`,
  );

  const queue = [...wanted];
  const results = [];

  const worker = async (server) => {
    for (;;) {
      const suite = queue.shift();
      if (!suite) return;
      const at = Date.now();
      const args = suite.nodeTest ? ['--test', `tests/${suite.file}`] : [`tests/${suite.file}`];
      const { code, out } = await run(process.execPath, args, { RMM_SERVER: server });
      const ms = Date.now() - at;
      results.push({ suite, code, ms, out, server });
      // Whole, and in one piece: interleaving thirteen scripts' output line by
      // line makes a log nobody can read a failure out of.
      process.stdout.write(`\n${'='.repeat(64)}\n${suite.name}  (${clock(ms)}, ${server})\n${'='.repeat(64)}\n${out}`);
    }
  };

  await Promise.all(pool.slice(0, jobs).map(worker));

  const failed = results.filter((r) => r.code !== 0);
  console.log(`\n${'='.repeat(64)}\nSummary\n`);
  for (const r of [...results].sort((a, b) => b.ms - a.ms)) {
    const note = summarise(r.out);
    console.log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'}  ${r.suite.name.padEnd(14)} ${clock(r.ms).padStart(7)}  ${note}`);
  }
  console.log(
    `\n${results.length - failed.length}/${results.length} suites passed in ${clock(Date.now() - started)}` +
      ` (serial would be about ${clock(results.reduce((n, r) => n + r.ms, 0))})`,
  );
  process.exit(failed.length ? 1 : 0);
}

main();
