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
 * a ten-minute suite left until last, the wall clock is ten minutes whatever
 * else finished early. These numbers do not need to be right, only ordered.
 */
const SUITES = [
  { name: 'ats-journey', file: 'ats-journey.mjs', cost: 300 },
  { name: 'journey', file: 'journey.mjs', cost: 200 },
  { name: 'ats-forms', file: 'ats-forms.mjs', cost: 180 },
  { name: 'e2e', file: 'e2e.mjs', cost: 150 },
  { name: 'carrying', file: 'carrying.mjs', cost: 120 },
  { name: 'roundtrip', file: 'roundtrip.mjs', cost: 60 },
  { name: 'quiet', file: 'quiet.mjs', cost: 120 },
  { name: 'adverse', file: 'adverse.mjs', cost: 100 },
  { name: 'nav', file: 'navigation.mjs', cost: 90 },
  { name: 'joins', file: 'joins.mjs', cost: 60 },
  { name: 'card', file: 'card.mjs', cost: 30 },
  { name: 'autofill', file: 'autofill.mjs', cost: 30 },
  { name: 'ats', file: 'ats.mjs', cost: 10, nodeTest: true },
  { name: 'trail', file: 'trail.mjs', cost: 5, nodeTest: true },
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

async function main() {
  const started = Date.now();

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
