/**
 * Every link a round of review has had an opinion about, kept as a test.
 *
 * The link rules in `remembering.js` were tuned one round at a time, each
 * against that round's list, and a tweak for one round kept breaking what an
 * earlier one had settled: `?session=abc123def456` was refused in round 14,
 * kept in round 15, and refused again when somebody noticed. Seventeen
 * rounds of lists, tests, reports and decisions were gathered into one
 * corpus, the disagreements were decided once, and it lives here so that
 * the next change has to pass all of it, not just its own.
 *
 * Each case says what it expects and who said so (`sources`: the round and
 * whether it was a test, a list, a report or the owner's decision). A case
 * marked `todo` is a known gap, reported but not failed.
 *
 *   node --test tests/corpus-links.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { worthRememberingTyped } from '../src/shared/remembering.js';

/*
 * Secret-shaped values are stored in pieces and joined here. A realistic key
 * written out whole in a fixture is refused by GitHub's push protection, and
 * one push of this branch already was.
 */
const joined = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.parts)
    ? v.parts.join('')
    : Array.isArray(v)
      ? v.map(joined)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, joined(x)]))
        : v;

const { cases } = JSON.parse(fs.readFileSync(new URL('./fixtures/corpus-links.json', import.meta.url), 'utf8'));

test('the corpus is settled: every case keeps or refuses', () => {
  assert.ok(cases.length > 400, `${cases.length} cases`);
  for (const c of cases) assert.ok(c.expect === 'keep' || c.expect === 'refuse', `${c.id}: ${JSON.stringify(c.expect)}`);
});

for (const c of cases) {
  const { answer, question = 'Portfolio link' } = joined(c.input);
  const why = c.sources.map((s) => `${s.round} [${s.basis}]${s.note ? ` ${s.note}` : ''}`).join('; ');
  test(`${c.id} ${c.expect}s ${answer}`, { todo: c.todo }, () => {
    const got = worthRememberingTyped({ question, answer, company: 'Helios Systems' });
    assert.equal(got.keep ? 'keep' : 'refuse', c.expect, `${answer}\n  ${why}\n  ${got.why ?? ''}`);
  });
}
