/**
 * JobHelper's half of the error log, without a browser: the buffer the
 * worker keeps, and sending an entry — now, or later when ResumeM-M could
 * not be reached.
 *
 *   node --test tests/error-log-unit.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QUEUE_KEY,
  QUEUE_MAX,
  createLogBuffer,
  queuedErrorLogs,
  routeOf,
  saveErrorLog,
  sendQueuedErrorLogs,
  windowMinutes,
  worthKeeping,
} from '../src/shared/error-log.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const LYING = 'data:image/png;base64,/9j/4AAQSkZJRgABAQ==';

/** `chrome.storage.local`, in memory, refusing to hold more than `limit` characters. */
function storage(limit = Infinity) {
  const values = {};
  return {
    values,
    get: async (key) => (key in values ? { [key]: structuredClone(values[key]) } : {}),
    set: async (next) => {
      if (JSON.stringify({ ...values, ...next }).length > limit) throw new Error('QUOTA_BYTES quota exceeded');
      Object.assign(values, structuredClone(next));
    },
    remove: async (key) => {
      delete values[key];
    },
  };
}

const offline = () => {
  const err = new Error('ResumeM-M is not open. Start it, then try again.');
  err.jobhelper = { fix: 'start-server' };
  return err;
};
const refusedWith = (status, message) => Object.assign(new Error(message), { status });

test('the buffer keeps fifteen minutes or two thousand events, and outlives the worker in session storage', async () => {
  let clock = Date.parse('2026-10-14T12:00:00Z');
  const session = storage();
  const buffer = createLogBuffer({ storage: session, now: () => clock });
  for (let i = 0; i < 2100; i++) buffer.push({ kind: 'action', level: 'info', message: `n${i}` });
  assert.equal(buffer.size, 2000);
  assert.equal((await buffer.since(1))[0].message, 'n100');
  clock += 16 * 60_000;
  buffer.push({ kind: 'server', message: 'GET /api/resumes → 500: broken' });
  assert.deepEqual((await buffer.since(30)).map((e) => e.message), ['GET /api/resumes → 500: broken']);
  await new Promise((r) => setTimeout(r, 300));
  // A new worker, reading what the last one kept.
  const again = createLogBuffer({ storage: session, now: () => clock });
  again.push({ kind: 'worker-error', message: 'after the restart' });
  assert.deepEqual((await again.since(10)).map((e) => e.message), ['GET /api/resumes → 500: broken', 'after the restart']);
  assert.equal(routeOf('/api/autofill?resume=intern&token=x#y'), '/api/autofill');
  assert.deepEqual([windowMinutes('2'), windowMinutes(undefined), windowMinutes(45)], [2, 10, 30]);
});

test('an entry goes straight to ResumeM-M with the window of logs it asked for', async () => {
  const local = storage();
  const sent = [];
  const result = await saveErrorLog(
    { description: '  The card never showed  ', minutes: '2', screenshots: [PNG], page: { url: 'https://jobs.example/1', title: 'Engineer' } },
    {
      serverFetch: async (path, options) => {
        sent.push({ path, body: JSON.parse(options.body) });
        return { committed: true };
      },
      storage: local,
      events: async (minutes) => [{ at: new Date().toISOString(), kind: 'server', message: `window ${minutes}` }],
      versions: { extensionVersion: '0.1.1', extensionBuild: 'abc' },
    },
  );
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/error-log');
  assert.equal(sent[0].body.description, 'The card never showed');
  assert.equal(sent[0].body.minutes, 2);
  assert.deepEqual(sent[0].body.screenshots, [PNG]);
  assert.deepEqual(sent[0].body.page, { url: 'https://jobs.example/1', title: 'Engineer' });
  assert.equal(sent[0].body.events[0].message, 'window 2');
  assert.equal(sent[0].body.extensionVersion, '0.1.1');
  assert.equal(await queuedErrorLogs(local), 0);

  // Never sent at all: nothing to say, or a screenshot that is not its type.
  const never = async () => assert.fail('should not be sent');
  await assert.rejects(saveErrorLog({ description: ' ' }, { serverFetch: never, storage: local, events: async () => [] }), /what went wrong/);
  await assert.rejects(saveErrorLog({ description: 'x', screenshots: [LYING] }, { serverFetch: never, storage: local, events: async () => [] }), /not the PNG/);
});

test('one ResumeM-M cannot take is kept, said so, and sent the next time it answers', async () => {
  const local = storage();
  const events = async () => [];
  const down = async () => {
    throw offline();
  };
  const first = await saveErrorLog({ description: 'Autofill froze', screenshots: [PNG] }, { serverFetch: down, storage: local, events });
  assert.equal(first.sent, false);
  assert.equal(first.queued, 1);
  assert.match(first.why, /not open/);
  // Not paired yet is worth keeping too: pairing puts it right.
  const notPaired = Object.assign(new Error('not paired'), { status: 403, kind: 'not-paired' });
  const second = await saveErrorLog({ description: 'Second' }, { serverFetch: async () => { throw notPaired; }, storage: local, events });
  assert.equal(second.queued, 2);
  // A refusal of the entry itself is not.
  await assert.rejects(
    saveErrorLog({ description: 'Third' }, { serverFetch: async () => { throw refusedWith(400, 'bad entry'); }, storage: local, events }),
    /bad entry/,
  );
  assert.equal(worthKeeping(refusedWith(500, 'x')), true);
  assert.equal(worthKeeping(refusedWith(413, 'x')), false);

  // Still down: both stay.
  const still = await sendQueuedErrorLogs(down, local);
  assert.deepEqual([still.sent, still.queued], [0, 2]);
  assert.match(still.lastError, /not open/);

  const arrived = [];
  const up = async (path, options) => {
    arrived.push(JSON.parse(options.body));
    return { committed: true };
  };
  const done = await sendQueuedErrorLogs(up, local);
  assert.deepEqual([done.sent, done.queued], [2, 0]);
  assert.deepEqual(arrived.map((e) => e.description), ['Autofill froze', 'Second']);
  assert.deepEqual(arrived[0].screenshots, [PNG]);
  // When it was logged, not when it was sent.
  assert.ok(Date.parse(arrived[0].at) <= Date.parse(arrived[1].at));
});

test('the queue keeps the newest few, and keeps an entry without its screenshots when the browser is full', async () => {
  const local = storage();
  const down = async () => {
    throw offline();
  };
  for (let i = 0; i < QUEUE_MAX + 2; i++) {
    await saveErrorLog({ description: `n${i}` }, { serverFetch: down, storage: local, events: async () => [] });
  }
  assert.deepEqual(local.values[QUEUE_KEY].map((e) => e.description), ['n2', 'n3', 'n4', 'n5', 'n6']);

  const tight = storage(3000);
  const big = `data:image/png;base64,iVBORw0KGgo${'A'.repeat(4000)}`;
  const kept = await saveErrorLog({ description: 'Huge screenshot', screenshots: [big] }, { serverFetch: down, storage: tight, events: async () => [] });
  assert.equal(kept.screenshotsKept, false);
  const arrived = [];
  await sendQueuedErrorLogs(async (_p, o) => arrived.push(JSON.parse(o.body)), tight);
  assert.deepEqual(arrived[0].screenshots, []);
  assert.match(arrived[0].description, /1 screenshot could not be kept/);

  // One the server refuses on the way back is let go of, not sent for ever.
  await saveErrorLog({ description: 'Refused later' }, { serverFetch: down, storage: tight, events: async () => [] });
  const refused = await sendQueuedErrorLogs(async () => {
    throw refusedWith(400, 'not readable');
  }, tight);
  assert.deepEqual([refused.sent, refused.queued, refused.refused], [0, 0, ['not readable']]);
});
