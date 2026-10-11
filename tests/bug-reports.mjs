import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBugReport, listBugReports, syncBugReport, clearBugReport, imageKind, refused } from '../src/shared/bug-reports.js';

test('an offline report survives in local storage, retries once, and carries version/time/build', async () => {
  const values = {};
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.1.0' }), getURL: (path) => path },
    storage: { local: {
      get: async (key) => key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) },
      set: async (next) => Object.assign(values, structuredClone(next)),
      remove: async (key) => { delete values[key]; },
    } } };
  globalThis.fetch = async () => ({ text: async () => 'test extension source' });
  const before = Date.now();
  const report = await saveBugReport({ text: 'Save refused', screenshots: ['data:image/png;base64,iVBORw0KGgo='] }, async () => { throw new Error('Server offline'); });
  assert.equal(report.text, 'Save refused');
  assert.equal(report.version, '0.1.0');
  assert.match(report.extensionBuild, /^[a-f0-9]{16}$/);
  assert.ok(Date.parse(report.createdAt) >= before);
  assert.equal(report.syncError, 'Server offline');
  assert.deepEqual(await listBugReports(), [report]);
  await assert.rejects(clearBugReport(report.id));
  let calls = 0;
  const server = async (route, options) => {
    calls++;
    assert.equal(route, '/api/bug-reports');
    assert.equal(JSON.parse(options.body).id, report.id);
    return { id: report.id, directory: '/test/inbox/' + report.id };
  };
  const copied = await syncBugReport(report.id, server);
  assert.equal(copied.syncError, null);
  await syncBugReport(report.id, server);
  assert.equal(calls, 1);
  assert.deepEqual(await listBugReports(), [copied]);
  await assert.rejects(saveBugReport({ text: ' ' }, server));
  await assert.rejects(saveBugReport({ text: 'Bug', screenshots: ['not an image'] }, server));
  assert.equal(Object.keys(values).length, 1);
  await clearBugReport(report.id);
  assert.deepEqual(await listBugReports(), []);
});

/*
 * A report the server refuses can still be let go of.
 *
 * Measured before this: a JPEG whose file was named `.png` was stored as PNG,
 * refused by ResumeM-M's own check of the bytes with a 400, and kept with no
 * receipt — and clearing was refused without one. Two of those at full size
 * filled `storage.local`, and the third report failed to save at all.
 */
function localStore(limit = Infinity) {
  const values = {};
  globalThis.chrome = { runtime: { getManifest: () => ({ version: '0.1.0' }), getURL: (path) => path },
    storage: { local: {
      get: async (key) => key === null ? structuredClone(values) : (key in values ? { [key]: structuredClone(values[key]) } : {}),
      set: async (next) => {
        if (JSON.stringify({ ...values, ...next }).length > limit) throw new Error('QUOTA_BYTES quota exceeded');
        Object.assign(values, structuredClone(next));
      },
      remove: async (key) => { delete values[key]; },
    } } };
  globalThis.fetch = async () => ({ text: async () => 'test extension source' });
  return values;
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const WEBP = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IA==';

test('a screenshot whose bytes are not what its name says is refused before it is saved', async () => {
  const values = localStore();
  const server = async () => { throw new Error('should not be asked'); };
  await assert.rejects(saveBugReport({ text: 'Bug', screenshots: ['data:image/png;base64,/9j/4AAQSkZJRgABAQ=='] }, server), /not the PNG, JPEG or WebP/);
  await assert.rejects(saveBugReport({ text: 'Bug', screenshots: ['data:image/webp;base64,iVBORw0KGgoAAAANSUhEUg=='] }, server), /not the PNG, JPEG or WebP/);
  await assert.rejects(saveBugReport({ text: 'Bug', screenshots: ['data:image/png;base64,iVBORw0KGgo AAAA'] }, server));
  assert.equal(Object.keys(values).length, 0);
  assert.equal(imageKind(Uint8Array.from(atob('/9j/4AAQ'), (c) => c.charCodeAt(0))), 'jpeg');
  const accepted = await saveBugReport({ text: 'Bug', screenshots: [PNG, JPEG, WEBP] }, async () => ({ id: 'x', directory: '/inbox/x' }));
  assert.ok(accepted.receipt);
});

test('a report the server refuses is marked so, and can be deleted once asked', async () => {
  const values = localStore();
  const reject = async () => { const err = new Error('Use valid screenshots totaling at most 4 MB.'); err.status = 400; throw err; };
  const report = await saveBugReport({ text: 'Refused', screenshots: [PNG] }, reject);
  assert.equal(report.receipt, null);
  assert.equal(report.syncStatus, 400);
  assert.equal(refused(report), true);
  // Without being asked, still refused: this is the only copy.
  await assert.rejects(clearBugReport(report.id), /file inbox/);
  assert.equal(Object.keys(values).length, 1);
  const gone = await clearBugReport(report.id, { discard: true });
  assert.deepEqual(gone, { cleared: true, discarded: true });
  assert.deepEqual(await listBugReports(), []);
  // An old server without the endpoint is a refusal too; one not running is not.
  const old = await saveBugReport({ text: 'Old server' }, async () => { const err = new Error('404 Not Found'); err.status = 404; throw err; });
  assert.equal(refused(old), true);
  const offline = await saveBugReport({ text: 'Offline' }, async () => { throw new Error('ResumeM-M is not open.'); });
  assert.equal(refused(offline), false);
});

test('a full store says what to do about it', async () => {
  localStore(2000);
  await assert.rejects(saveBugReport({ text: 'x'.repeat(3000) }, async () => ({})), /storage for reports is full/);
});
