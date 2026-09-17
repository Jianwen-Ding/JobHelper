/**
 * Does every source file still parse as what Chrome will load it as?
 *
 * One second, first in the suite, because the alternative cost ten minutes.
 * `node --check` passes a file that `import()` rejects: it parses as a script,
 * and the extension's files are modules. That difference is not academic — a
 * backtick inside the CSS template literal (a comment saying `min-width`,
 * which reads perfectly well in a code review) closed the string early and
 * turned the rest of the stylesheet into JavaScript. Every Playwright suite
 * then failed the same way, twenty systems timing out at thirty seconds each
 * waiting for a card whose module had never evaluated, and none of them said
 * "syntax error".
 *
 * Parsing is all this does. A module that throws at import time because
 * `window` or `chrome` is missing has already told us what we asked.
 */
import { readdirSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = new URL('../src/', import.meta.url).pathname;

function everyScript(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...everyScript(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

let passed = 0;
let failed = 0;

for (const file of everyScript(ROOT).sort()) {
  const shown = path.relative(path.join(ROOT, '..'), file);
  try {
    await import(pathToFileURL(file).href);
    passed++;
    console.log(`  ok    ${shown}`);
  } catch (err) {
    // A module that parsed and then asked for a browser is a module that
    // parsed. Only a parse failure is this file's business.
    if (err instanceof SyntaxError) {
      failed++;
      console.log(`  FAIL  ${shown} — ${err.message}`);
    } else {
      passed++;
      console.log(`  ok    ${shown} (parsed; needs a browser to run)`);
    }
  }
}

console.log(`\n${passed}/${passed + failed} files parse`);
process.exit(failed ? 1 : 0);
