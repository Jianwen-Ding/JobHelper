/**
 * The bits of the harness that have logic of their own.
 *
 * Test infrastructure that decides something can be wrong in the same way
 * product code can, and when it is, it fails a suite that had nothing wrong
 * with it — which costs more than a product bug, because the first instinct is
 * to go looking in the product.
 *
 *   node --test tests/harness.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extensionWorker } from './fixtures.mjs';

/**
 * A stand-in for Playwright's context whose worker is present before its
 * extension APIs are, which is the state the real thing hands back on a
 * loaded machine.
 */
const contextWhereApisArriveAfter = (turnsUntilReady) => {
  let asked = 0;
  const worker = {
    async evaluate() {
      asked += 1;
      return asked > turnsUntilReady;
    },
  };
  return { context: { serviceWorkers: () => [worker] }, asked: () => asked };
};

describe('waiting for the extension service worker', () => {
  /*
   * The failure this exists for: `chrome.tabs.query` inside an extension
   * worker gave "Cannot read properties of undefined (reading 'query')" —
   * `chrome.tabs` is never legitimately absent there, so the worker had been
   * handed over before its APIs were bound.
   */
  it('waits for the APIs rather than for the worker to exist', async () => {
    const { context, asked } = contextWhereApisArriveAfter(3);
    const worker = await extensionWorker(context, { timeout: 5_000 });
    assert.ok(worker, 'a worker comes back');
    assert.ok(asked() > 1, `it asked more than once (asked ${asked()} times)`);
  });

  it('returns straight away when the APIs are already there', async () => {
    const { context, asked } = contextWhereApisArriveAfter(0);
    await extensionWorker(context, { timeout: 5_000 });
    assert.equal(asked(), 1);
  });

  /*
   * And says something actionable when they never arrive, rather than letting
   * the next line report an undefined property.
   */
  it('says what is wrong when they never arrive', async () => {
    const context = { serviceWorkers: () => [{ async evaluate() { return false; } }] };
    await assert.rejects(
      () => extensionWorker(context, { timeout: 300 }),
      /chrome\.tabs.*undefined|APIs never appeared/s,
    );
  });
});
