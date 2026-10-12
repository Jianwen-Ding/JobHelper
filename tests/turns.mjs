/**
 * The service worker's own bookkeeping, run in node against a mocked
 * `chrome.*` — the cases a real browser makes hard to time: two writes to one
 * tab's trail landing together, a reply arriving after its tab has closed, a
 * message from a page nobody has been shown yet.
 *
 * The mock storage takes a few milliseconds per call, which is what opens the
 * windows these were found through. The real worker module is loaded once,
 * so every test uses its own tab id.
 *
 *   node --test tests/turns.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function area(latency = 0) {
  const data = {};
  return {
    data,
    async get(keys) {
      await delay(latency);
      if (keys === null || keys === undefined) return structuredClone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
    },
    async set(obj) {
      await delay(latency);
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      await delay(latency);
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}
const listeners = {};
const on = (name) => ({ addListener: (f) => (listeners[name] = f) });
const openTabs = new Set();
const EXTENSION = 'chrome-extension://jobhelper-test/';
globalThis.chrome = {
  storage: { session: area(5), local: area(5), sync: area(1) },
  alarms: { onAlarm: on('alarm'), create: async () => {}, clear: async () => {} },
  action: { setBadgeText: async () => {}, setTitle: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    onActivated: on('activated'),
    onUpdated: on('updated'),
    onRemoved: on('removed'),
    query: async () => [...openTabs].map((id) => ({ id })),
    sendMessage: async () => null,
    create: async (o) => ({ id: 999, ...o }),
    update: async () => ({}),
    get: async (id) => ({ id }),
  },
  runtime: { id: 'jobhelper-test', onMessage: on('message'), onInstalled: on('installed'), getURL: (p) => `${EXTENSION}${p}`, getManifest: () => ({ version: '0' }) },
  windows: { get: async () => null, create: async () => ({ id: 5 }), update: async () => {} },
};
let store = async () => {
  throw new TypeError('refused');
};
globalThis.fetch = (...args) => store(...args);
await import('../src/background/service-worker.js');

const session = chrome.storage.session.data;
const send = (type, payload, tab, sender = {}) =>
  new Promise((done) => listeners.message({ type, payload }, { tab, url: 'https://boards.example/jobs/1', ...sender }, done));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const posting = 'https://boards.greenhouse.io/helios/jobs/123';
const seed = (tabId, extra = {}) => {
  openTabs.add(tabId);
  session[`trail:${tabId}`] = {
    pages: [{ url: posting, company: 'Helios', role: 'Platform Engineer', kind: 'posting' }],
    save: 'work',
    at: Date.now(),
    ...extra,
  };
};
const analyzed = (body) => ({
  isJobPosting: true,
  kind: 'posting',
  save: 'work',
  job: { company: 'Helios', title: 'Platform Engineer' },
  spec: { id: 'job-x' },
  ...body,
});

test('a save and an Apply press sent together both land', async () => {
  seed(1);
  const page = { url: posting, company: 'Helios', role: 'Platform Engineer' };
  const [saved, pressed] = await Promise.all([
    send('saveWork', { work: { letter: 'Dear Helios,' }, page }, { id: 1 }),
    send('expectContinuation', { to: `${posting}/apply`, from: posting }, { id: 1 }),
  ]);
  assert.equal(saved.data?.ok, true);
  assert.equal(pressed.data?.ok, true);
  const trail = session['trail:1'];
  assert.equal(trail.work?.letter, 'Dear Helios,', 'the save was written over by the press');
  assert.equal(trail.expecting?.to, `${posting}/apply`, 'the press was written over by the save');
});

test('a page landing while the keeper saves keeps both the page and the letter', async () => {
  store = async () => {
    await delay(10);
    return json(analyzed());
  };
  const page = { url: posting, company: 'Helios', role: 'Platform Engineer' };
  const apply = `${posting}/apply`;
  // At every offset across the analysis, because which of the two used to
  // be lost depended on exactly when the save arrived.
  const lost = [];
  await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      const tab = { id: 200 + i };
      seed(tab.id);
      await Promise.all([
        send('analyze', { url: apply, title: 'Apply — Platform Engineer', html: '<form></form>' }, tab),
        delay(10 + i * 2).then(() => send('saveWork', { work: { letter: 'KEEP-ME' }, page }, tab)),
      ]);
      const trail = session[`trail:${tab.id}`];
      if (trail.work?.letter !== 'KEEP-ME') lost.push(`${10 + i * 2}ms: letter`);
      if (trail.pages.map((p) => p.url).join() !== [posting, apply].join()) lost.push(`${10 + i * 2}ms: page`);
    }),
  );
  assert.deepEqual(lost, []);
});

test('a stage and a bundle sent back to back are both noted as this tab’s own', async () => {
  seed(3);
  let n = 0;
  store = async () => {
    const version = ++n;
    await delay(20);
    return json({ draft: { resumeId: 'job-x' }, resumeVersion: version });
  };
  const tab = { id: 3 };
  await Promise.all([
    send('stage', { spec: { id: 'job-x' }, basedOn: null }, tab),
    send('bundle', { spec: { id: 'job-x' }, basedOn: 1 }, tab),
  ]);
  assert.equal(session['filedCopies:3']?.length, 2, JSON.stringify(session['filedCopies:3']));
  const own = await send('ownWrite', { id: 'job-x', from: null, to: 2 }, tab);
  assert.equal(own.data?.own, true, 'the card took its own write for an edit made in ResumeM-M');
});

test('a reply that lands after its tab closed does not bring the trail back', async () => {
  openTabs.add(7);
  let release;
  store = async (url) => {
    if (String(url).endsWith('/api/extension/analyze')) {
      await new Promise((r) => (release = r));
      return json(analyzed());
    }
    throw new TypeError('refused');
  };
  const tab = { id: 7 };
  const pending = send('analyze', { url: posting, title: 'Platform Engineer', html: 'x'.repeat(50_000), tailor: 'ai' }, tab);
  await delay(30);
  openTabs.delete(7);
  await listeners.removed(7);
  await delay(30);
  release();
  await pending;
  const late = await send('saveWork', { work: { letter: 'from pagehide' } }, tab);
  await send('expectContinuation', { to: `${posting}/apply` }, tab);
  await delay(30);
  assert.equal(late.data?.ok, false, 'a save into a closed tab is not reported as kept');
  assert.equal(session['trail:7'], undefined, `trail:7 is back: ${JSON.stringify(session['trail:7'] ?? null).length} bytes`);
});

test('whatever a closed tab left under its id is swept with the orphans', async () => {
  // A tab that closed while the worker was not running: nothing told it.
  session['trail:41'] = { pages: [{ url: 'https://x.example/a' }], at: Date.now() };
  session['filedCopies:41'] = [{ id: 'a', basedOn: null, version: 1 }];
  session['frames:41'] = [3, 4];
  // And one still open, which must not be touched.
  seed(42);
  session['frames:42'] = [5];
  // Something that sweeps: a tab holding a letter closing.
  seed(43, { work: { letter: 'parked' } });
  openTabs.delete(43);
  await listeners.removed(43);
  await delay(50);
  assert.equal(session['trail:41'], undefined);
  assert.equal(session['filedCopies:41'], undefined);
  assert.equal(session['frames:41'], undefined);
  assert.ok(session['trail:42'], 'an open tab’s trail was swept');
  assert.deepEqual(session['frames:42'], [5]);
  assert.equal(session['trail:43'], undefined);
});

test('a prerendered page cannot write into the tab it will be shown in', async () => {
  seed(8, { work: { letter: 'ON-SCREEN' } });
  store = async () => json(analyzed({ job: { company: 'Streamly', title: 'Software Engineer Intern' } }));
  const before = structuredClone(session['trail:8']);
  const prerender = { documentLifecycle: 'prerender', url: 'https://streamly.example/jobs/9' };
  for (const [type, payload] of [
    ['getSettings', {}],
    ['analyze', { url: 'https://streamly.example/jobs/9', title: 'Intern', html: '<p>x</p>' }],
    ['saveWork', { work: { letter: 'PRERENDERED' } }],
    ['expectContinuation', { to: 'https://streamly.example/apply' }],
    ['clearTrail', {}],
  ]) {
    const reply = await send(type, payload, { id: 8 }, prerender);
    assert.equal(reply.ok, false, `${type} was accepted from a prerendered page`);
  }
  assert.deepEqual(session['trail:8'], before);
  // A frame announcing itself is still heard, or it would be missing once shown.
  const frame = await send('frameReady', {}, { id: 8 }, { ...prerender, frameId: 6 });
  assert.equal(frame.ok, true);
  assert.deepEqual(session['frames:8'], [6]);
  // And the same page, once shown, is an ordinary page again.
  const shown = await send('expectContinuation', { to: 'https://x.example' }, { id: 8 }, { documentLifecycle: 'active' });
  assert.equal(shown.ok, true);
});

test('settings and bug reports are only taken from the extension’s own pages', async () => {
  const page = await send('setSettings', { patch: { serverUrl: 'http://attacker.example' } }, { id: 9 });
  assert.equal(page.ok, false);
  assert.equal(chrome.storage.sync.data.serverUrl, undefined);
  for (const type of ['listBugReports', 'saveBugReport', 'clearBugReport', 'syncBugReport', 'panelFor']) {
    const reply = await send(type, {}, { id: 9 });
    assert.equal(reply.ok, false, `${type} was accepted from a web page`);
  }
  const popup = await send('setSettings', { patch: { autoPrompt: false } }, undefined, { url: `${EXTENSION}src/popup/popup.html` });
  assert.equal(popup.ok, true);
  assert.equal(popup.data.autoPrompt, false);
  const listed = await send('listBugReports', {}, undefined, { url: `${EXTENSION}src/reports/report.html` });
  assert.equal(listed.ok, true);
});

test('a message named after something every object has is not a message', async () => {
  for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const reply = await send(type, {}, { id: 10 });
    assert.equal(reply.ok, false, type);
    assert.match(reply.error, /Unknown message/);
  }
});

test('pdfBytes fetches from the store and nowhere else', async () => {
  const asked = [];
  store = async (url) => {
    asked.push(String(url));
    return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
  };
  const ok = await send('pdfBytes', { url: '/files/resume.pdf' }, { id: 11 });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.base64, 'JVBERg==');
  const full = await send('pdfBytes', { url: 'http://127.0.0.1:4600/files/resume.pdf' }, { id: 11 });
  assert.equal(full.ok, true);
  for (const url of ['http://127.0.0.1:9222/json', 'https://elsewhere.example/a.pdf', '//elsewhere.example/a.pdf', 'file:///etc/passwd']) {
    const reply = await send('pdfBytes', { url }, { id: 11 });
    assert.equal(reply.ok, false, `${url} was fetched`);
  }
  assert.deepEqual(asked, ['http://127.0.0.1:4600/files/resume.pdf', 'http://127.0.0.1:4600/files/resume.pdf']);
});

/*
 * One closed tab's letter, and two tabs loading pages of its application at
 * the same moment: two tabs reopened on one posting, or "Reopen closed
 * window" bringing back the posting and its form together. Both read the
 * parked list before either had dropped anything, both picked the same entry,
 * and both were handed the letter as recovered — every time, at every offset.
 * Exactly one may have it.
 */
test('a closed tab’s letter is recovered into one tab, not two loading together', async () => {
  const form = `${posting}/apply`;
  const onPosting = { url: posting, company: 'Helios', role: 'Platform Engineer', kind: 'posting' };
  const onForm = { url: form, company: 'Helios', role: 'Platform Engineer', kind: 'form' };
  const doubled = [];
  for (let i = 0; i < 8; i++) {
    const closed = 600 + i * 3;
    const [b, c] = [closed + 1, closed + 2];
    // The same address for both on even runs; the posting and the form on odd ones.
    const pageC = i % 2 ? onForm : onPosting;
    seed(closed, { pages: [onPosting, onForm], work: { letter: `LETTER-${i}` } });
    openTabs.delete(closed);
    await listeners.removed(closed);
    seed(b, { pages: [onPosting] });
    seed(c, { pages: [pageC] });
    const replies = await Promise.all([
      send('takeWork', { page: onPosting }, { id: b }),
      delay(i % 4).then(() => send('takeWork', { page: pageC }, { id: c })),
    ]);
    const got = replies.filter((r) => r.data?.work?.letter === `LETTER-${i}`);
    if (got.length !== 1) doubled.push(`run ${i}: ${JSON.stringify(replies.map((r) => r.data))}`);
    for (const r of replies) if (r.data?.work?.letter !== `LETTER-${i}`) assert.equal(r.data?.work, null);
    for (const t of [b, c]) openTabs.delete(t);
  }
  assert.deepEqual(doubled, []);
});

/*
 * And across a restart. The claim is what says an entry was taken, and a
 * worker stopped after one tab claimed it and before the copies under the
 * application's other pages were dropped wakes with those copies still
 * parked. Kept in memory, the claim would be gone with the worker, and the
 * next tab would be handed the letter again. Last in the file, because it
 * loads the worker a second time.
 */
test('a claim made before the worker restarted still holds after it', async () => {
  const form = `${posting}/apply`;
  const onPosting = { url: posting, company: 'Helios', role: 'Platform Engineer', kind: 'posting' };
  const onForm = { url: form, company: 'Helios', role: 'Platform Engineer', kind: 'form' };
  for (const key of Object.keys(session)) if (key.startsWith('jh-orphan:')) delete session[key];
  seed(700, { pages: [onPosting, onForm], work: { letter: 'ONLY-ONCE' } });
  openTabs.delete(700);
  await listeners.removed(700);
  const parked = Object.fromEntries(Object.entries(session).filter(([key]) => key.startsWith('jh-orphan:')));
  assert.equal(Object.keys(parked).length, 2, 'parked under the posting and the form');

  seed(701, { pages: [onPosting] });
  const first = await send('takeWork', { page: onPosting }, { id: 701 });
  assert.equal(first.data?.work?.letter, 'ONLY-ONCE');

  // Stopped before the drops landed: the copies are back where they were.
  Object.assign(session, structuredClone(parked));
  await import('../src/background/service-worker.js?restarted');
  seed(702, { pages: [onForm] });
  const second = await send('takeWork', { page: onForm }, { id: 702 });
  assert.equal(second.data?.work, null, `handed again after a restart: ${JSON.stringify(second.data)}`);
});
