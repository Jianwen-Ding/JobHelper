import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveBugReport, listBugReports, syncBugReport, clearBugReport } from '../src/shared/bug-reports.js';

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
