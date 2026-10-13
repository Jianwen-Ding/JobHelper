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
/*
 * Bytes as Chrome counts them for `getBytesInUse`: each key and its value as
 * JSON. A `quota` makes `set` refuse, with Chrome's own words, a write that
 * would take the area past it — and leaves what was there, as Chrome does.
 */
const bytesOf = (data) => Object.entries(data).reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
function area(latency = 0) {
  const data = {};
  // Through a name rather than `this`: tests wrap `set` and call it unbound.
  const it = {
    data,
    quota: Infinity,
    bytesInUse: () => bytesOf(data),
    async get(keys) {
      await delay(latency);
      if (keys === null || keys === undefined) return structuredClone(data);
      if (typeof keys === 'string') keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
    },
    async set(obj) {
      await delay(latency);
      if (it.quota !== Infinity && bytesOf({ ...data, ...obj }) > it.quota) {
        throw new Error('Session storage quota bytes exceeded. Values were not stored.');
      }
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      await delay(latency);
      for (const k of [].concat(keys)) delete data[k];
    },
  };
  return it;
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

/*
 * A tab opened by Apply carries the opener's work, and in it the write of the
 * copy the work was built on — and the opener staged again as Apply was
 * pressed. The form page's card, refused over that stage, asks this tab
 * whether it is its own: it is, as much as the trail is, so the opener's
 * filings come over with the trail.
 */
test('a tab opened by Apply knows the opener’s filings of the copy as its own', async () => {
  seed(31);
  let n = 0;
  store = async () => {
    const version = `v${++n}`;
    return json({ draft: { resumeId: 'job-31' }, resumeVersion: version });
  };
  const opener = { id: 31 };
  await send('stage', { spec: { id: 'job-31' }, basedOn: null }, opener);
  await send('stage', { spec: { id: 'job-31', more: 1 }, basedOn: 'v1' }, opener);
  await send('expectContinuation', { to: `${posting}/apply`, from: posting }, opener);
  assert.equal(session['filedCopies:31']?.length, 2);

  openTabs.add(32);
  const child = { id: 32, openerTabId: 31 };
  const form = { url: `${posting}/apply`, company: 'Helios', role: 'Platform Engineer', kind: 'form' };
  await send('takeWork', { page: form }, child);
  assert.ok(session['trail:32']?.pages?.length, 'the tab did not inherit the opener’s trail');
  const own = await send('ownWrite', { id: 'job-31', from: 'v1', to: 'v2' }, child);
  assert.equal(own.data?.own, true, `the opener’s stage read as an edit made elsewhere: ${JSON.stringify(session['filedCopies:32'] ?? null)}`);

  // And once only: the opener's filings after that are its own.
  await send('stage', { spec: { id: 'job-31', more: 2 }, basedOn: 'v2' }, opener);
  const later = await send('ownWrite', { id: 'job-31', from: 'v2', to: 'v3' }, child);
  assert.equal(later.data?.own, false, 'a filing the opener made afterwards was taken as this tab’s');
});

/*
 * The card's save as Apply is pressed lands on the opener's trail, and the
 * tab Apply opened asks for its work at the same moment. Waiting on its own
 * trail's queue alone, it copied the opener's work from before the save:
 * the spec, but not the render just compiled, and the form drew no resume.
 * A slow write is what holds the save in the opener's queue long enough.
 */
test('a tab opened by Apply takes the work the opener was saving as Apply was pressed', async () => {
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async (o) => {
    await delay(30);
    return set(o);
  };
  try {
    const page = { url: posting, company: 'Helios', role: 'Platform Engineer' };
    seed(51, {
      work: { spec: { id: 'job-x' }, letter: 'Dear Helios,' },
      expecting: { to: `${posting}/apply`, from: posting, at: Date.now() },
    });
    openTabs.add(52);
    const work = { spec: { id: 'job-x' }, letter: 'Dear Helios,', render: { pdf: 'RENDERED' } };
    const [, taken] = await Promise.all([
      send('saveWork', { work, page }, { id: 51 }),
      send('takeWork', { page }, { id: 52, openerTabId: 51 }),
    ]);
    assert.equal(taken.data?.work?.render?.pdf, 'RENDERED', `the new tab took the work from before the save: ${JSON.stringify(taken)}`);
    assert.equal(session['trail:52']?.work?.render?.pdf, 'RENDERED');
  } finally {
    chrome.storage.session.set = set;
  }
});

test('a card saying its resume as its tab closes does not bring the tab’s keys back', async () => {
  // At every offset across the close, because whether the write landed
  // after the sweep depended on exactly when the message arrived.
  const back = [];
  for (let i = 0; i < 10; i++) {
    const tab = { id: 330 + i, url: posting };
    seed(tab.id);
    openTabs.delete(tab.id);
    const closing = listeners.removed(tab.id);
    await delay(i);
    const late = send('panelTarget', { copyId: 'c', company: 'Helios', role: 'Platform Engineer' }, tab);
    await Promise.all([closing, late]);
    await delay(30);
    if (`jh-panel:${tab.id}` in session) back.push(`${i}ms`);
  }
  assert.deepEqual(back, [], 'jh-panel was written back for a tab that had closed');
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
 * The tab that won the claim closed before the work could be written into it.
 * `changeTrail` writes nothing into a closed tab — and the parks were dropped
 * anyway, so the letter was in no tab and no park, and every tab that asked
 * after was told there was nothing. Kept parked, the next tab gets it.
 */
test('a closed tab’s letter is not lost when the tab that claimed it closes too', async () => {
  const onPosting = { url: posting, company: 'Helios', role: 'Platform Engineer', kind: 'posting' };
  for (const key of Object.keys(session)) if (key.startsWith('jh-orphan:')) delete session[key];
  seed(650, { work: { letter: 'CLAIMED-THEN-CLOSED' } });
  openTabs.delete(650);
  await listeners.removed(650);
  seed(651);
  seed(652);
  const ss = chrome.storage.session;
  const realSet = ss.set;
  let closing = null;
  // The moment the claim is written down, the tab that made it closes.
  ss.set = async (obj) => {
    const done = await realSet.call(ss, obj);
    if (!closing && Object.keys(obj).some((k) => k.startsWith('jh-claimed:'))) {
      openTabs.delete(651);
      closing = listeners.removed(651);
    }
    return done;
  };
  try {
    const won = await send('takeWork', { page: onPosting }, { id: 651 });
    await closing;
    assert.equal(won.data?.work, null);
  } finally {
    ss.set = realSet;
  }
  const next = await send('takeWork', { page: onPosting }, { id: 652 });
  assert.equal(next.data?.work?.letter, 'CLAIMED-THEN-CLOSED', `lost: ${JSON.stringify(next.data)}`);
  openTabs.delete(652);
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

/*
 * A worker stopped after the claim and before the work was written into the
 * tab that made it. The mark stayed, and stood against every tab, the one
 * that claimed included: it reloaded to nothing, and the park was swept a
 * day later with the letter in it. The tab that claimed gets it when it asks
 * again; any other, while that one is still open, does not.
 */
test('a claim cut off by a restart does not stand against the tab that made it', async () => {
  const onPosting = { url: posting, company: 'Helios', role: 'Platform Engineer', kind: 'posting' };
  for (const key of Object.keys(session)) if (key.startsWith('jh-orphan:') || key.startsWith('jh-claimed:')) delete session[key];
  seed(710, { work: { letter: 'CUT-OFF' } });
  openTabs.delete(710);
  await listeners.removed(710);
  seed(711);
  const ss = chrome.storage.session;
  const realSet = ss.set;
  // The trail write never finishes: the worker is stopped while it is out.
  ss.set = (obj) => ('trail:711' in obj ? new Promise(() => {}) : realSet.call(ss, obj));
  void send('takeWork', { page: onPosting }, { id: 711 });
  await delay(200);
  ss.set = realSet;
  assert.ok(Object.keys(session).some((k) => k.startsWith('jh-claimed:')), 'claimed before the stop');
  await import('../src/background/service-worker.js?restarted-again');
  const again = await send('takeWork', { page: onPosting }, { id: 711 });
  assert.equal(again.data?.work?.letter, 'CUT-OFF', `the claimant got nothing: ${JSON.stringify(again.data)}`);
  seed(712);
  const other = await send('takeWork', { page: onPosting }, { id: 712 });
  assert.equal(other.data?.work, null);
  openTabs.delete(711);
  openTabs.delete(712);

  // And once the tab that claimed has closed as well, the next tab gets it.
  for (const key of Object.keys(session)) if (key.startsWith('jh-orphan:') || key.startsWith('jh-claimed:')) delete session[key];
  seed(720, { work: { letter: 'CLAIMANT-GONE' } });
  openTabs.delete(720);
  await listeners.removed(720);
  seed(721);
  ss.set = (obj) => ('trail:721' in obj ? new Promise(() => {}) : realSet.call(ss, obj));
  void send('takeWork', { page: onPosting }, { id: 721 });
  await delay(200);
  ss.set = realSet;
  await import('../src/background/service-worker.js?restarted-thrice');
  const realGet = chrome.tabs.get;
  chrome.tabs.get = async (id) => {
    if (!openTabs.has(id)) throw new Error(`No tab with id: ${id}.`);
    return { id };
  };
  try {
    openTabs.delete(721);
    seed(722);
    const after = await send('takeWork', { page: onPosting }, { id: 722 });
    assert.equal(after.data?.work?.letter, 'CLAIMANT-GONE', `held for a closed tab: ${JSON.stringify(after.data)}`);
  } finally {
    chrome.tabs.get = realGet;
  }
});

/*
 * Session storage full, and the tab being applied in is the one writing.
 *
 * It used to be the one that paid: `writeTrail` went straight to lightening
 * its own trail, so with other tabs' postings filling the area the posting
 * you were applying to lost its text — the text the letter and the answers
 * are written from — while postings opened hours ago kept all of theirs.
 * Other tabs give up their page text first now, least recently written first,
 * and only their text.
 */
const words = 'streaming platform kafka distributed systems reliability ownership latency'.split(' ');
const bigPage = (n, kb) => {
  let out = '<html><body>';
  for (let i = 0; out.length < kb * 1024; i += 1) out += `<p>${n} ${i} ${words.map((w, k) => words[(k + i) % words.length]).join(' ')}</p>`;
  return `${out}</body></html>`;
};
const fullTrail = (tabId, at, kb, job = { url: `https://boards.example/other/${tabId}`, company: `Other${tabId}`, role: 'Engineer' }) => {
  openTabs.add(tabId);
  session[`trail:${tabId}`] = {
    pages: [{ ...job, kind: 'posting', html: bigPage(tabId, kb), at }],
    work: { letter: `LETTER-${tabId}`, answersByQuestion: { 'Why us?': `ANSWER-${tabId}` } },
    save: 'work',
    at,
  };
};

test('a full session storage takes other tabs’ page text before the posting being applied to', async () => {
  const ss = chrome.storage.session;
  store = async () => json(analyzed());
  const now = Date.now();
  fullTrail(801, now - 30 * 60_000, 200); // the oldest
  fullTrail(802, now - 20 * 60_000, 200);
  fullTrail(803, now - 10 * 60_000, 200); // the newest
  // Room for what is there and a little more: not for a fourth posting, until
  // one other tab's text goes.
  ss.quota = ss.bytesInUse() + 120 * 1024;
  try {
    openTabs.add(804);
    const html = bigPage(804, 200);
    const reply = await send('analyze', { url: `${posting}?tab=804`, title: 'Platform Engineer', html }, { id: 804 });
    const mine = session['trail:804'];
    assert.ok(mine, 'the trail was not stored at all');
    assert.ok(mine.pages[0].html.length > 150_000, `the posting lost its text: ${mine.pages[0].html.length} chars kept`);
    assert.equal(mine.textDropped, undefined);
    assert.equal(reply.data?.trail?.textDropped, undefined);

    // The oldest tab gave up its text, and nothing else.
    const oldest = session['trail:801'];
    assert.equal(oldest.pages[0].html, '', 'the least recently used tab still holds its text');
    assert.equal(oldest.pages[0].url, 'https://boards.example/other/801');
    assert.equal(oldest.work.letter, 'LETTER-801');
    assert.equal(oldest.work.answersByQuestion['Why us?'], 'ANSWER-801');
    assert.equal(oldest.at, now - 30 * 60_000, 'stripping it made it look recently used');
    // And the newest kept everything: one tab was enough.
    assert.ok(session['trail:803'].pages[0].html.length > 150_000, 'a newer tab was stripped before an older one');
    assert.ok(ss.bytesInUse() <= ss.quota);
  } finally {
    ss.quota = Infinity;
    for (const id of [801, 802, 803, 804]) {
      delete session[`trail:${id}`];
      openTabs.delete(id);
    }
  }
});

test('a posting that cannot be kept even then is said to be, on the card and the toolbar', async () => {
  const ss = chrome.storage.session;
  store = async () => json(analyzed());
  const titles = new Map();
  const realTitle = chrome.action.setTitle;
  chrome.action.setTitle = async ({ tabId, title }) => void titles.set(tabId, title);
  fullTrail(811, Date.now() - 60_000, 50);
  // Too small for this posting even with every other tab's text gone.
  ss.quota = ss.bytesInUse() + 100 * 1024;
  try {
    openTabs.add(812);
    const reply = await send('analyze', { url: `${posting}?tab=812`, title: 'Platform Engineer', html: bigPage(812, 300) }, { id: 812 });
    const mine = session['trail:812'];
    assert.ok(mine, 'the trail was not stored at all');
    assert.equal(mine.pages[0].html, '');
    assert.equal(mine.textDropped, true);
    assert.equal(reply.data?.trail?.textDropped, true, 'the card is not told');
    assert.match(titles.get(812) ?? '', /posting text could not be kept \(browser storage is full\)/);
    // The other tab's text went first all the same, and its letter stayed.
    assert.equal(session['trail:811'].pages[0].html, '');
    assert.equal(session['trail:811'].work.letter, 'LETTER-811');
  } finally {
    ss.quota = Infinity;
    chrome.action.setTitle = realTitle;
    for (const id of [811, 812]) {
      delete session[`trail:${id}`];
      openTabs.delete(id);
    }
  }
});

test('two tabs making room at once do not wait on each other for ever', async () => {
  const ss = chrome.storage.session;
  store = async () => json(analyzed());
  const now = Date.now();
  // Both tabs on Helios, so each new page joins its own application.
  const helios = (id) => ({ url: `${posting}?tab=${id}`, company: 'Helios', role: 'Platform Engineer' });
  fullTrail(821, now - 60_000, 150, helios(821));
  fullTrail(822, now - 50_000, 150, helios(822));
  ss.quota = ss.bytesInUse() + 20 * 1024;
  try {
    const both = Promise.all(
      [821, 822].map((id) =>
        send('analyze', { url: `${posting}/apply?tab=${id}`, title: 'Apply', html: bigPage(id + 100, 150) }, { id }),
      ),
    );
    const done = await Promise.race([both.then(() => true), delay(5_000).then(() => false)]);
    assert.equal(done, true, 'the two writes deadlocked');
    for (const id of [821, 822]) assert.ok(session[`trail:${id}`]?.work, `tab ${id} lost its work`);
  } finally {
    ss.quota = Infinity;
    for (const id of [821, 822]) {
      delete session[`trail:${id}`];
      openTabs.delete(id);
    }
  }
});

/*
 * A branch stash — what a tab left on an unsure verdict, kept for "Same job —
 * put it back" — holds a whole posting's markup, and making room went
 * straight to the live tabs' trails and never looked at it. A tab mid-
 * application in another window lost the posting its letter is written from,
 * and the stash kept all of its own. The sweep goes first now, and then the
 * stashes' markup, oldest first, and only then another tab's.
 */
test('a full session storage takes a branch stash’s page text before a live tab’s', async () => {
  const ss = chrome.storage.session;
  store = async () => json(analyzed());
  const now = Date.now();
  // A live tab, mid-application: its posting and a half-written letter.
  fullTrail(831, now - 2 * 60_000, 200);
  // A stash written a minute ago, holding a whole posting.
  seed(832, { at: now - 60_000 });
  session['jh-branched:832'] = {
    trail: {
      pages: [{ url: 'https://boards.example/old/832', company: 'Old', role: 'Engineer', kind: 'posting', html: bigPage(832, 200) }],
      work: { letter: 'LETTER-832' },
      save: 'work',
    },
    left: 'Old job',
    at: now - 60_000,
  };
  ss.quota = ss.bytesInUse() + 120 * 1024;
  try {
    openTabs.add(833);
    await send('analyze', { url: `${posting}?tab=833`, title: 'Platform Engineer', html: bigPage(833, 200) }, { id: 833 });
    assert.ok(session['trail:833'].pages[0].html.length > 150_000, 'the posting being applied to lost its text');
    assert.ok(session['trail:831'].pages[0].html.length > 150_000, 'a live tab was stripped while a stash kept its text');
    assert.equal(session['trail:831'].textDropped, undefined);

    const stash = session['jh-branched:832'];
    assert.equal(stash.trail.pages[0].html, '');
    assert.equal(stash.trail.pages[0].url, 'https://boards.example/old/832');
    assert.equal(stash.trail.work.letter, 'LETTER-832');
    assert.equal(stash.trail.textDropped, true);
    assert.equal(stash.at, now - 60_000, 'stripping it made it look newer');
    assert.ok(ss.bytesInUse() <= ss.quota);

    /*
     * And it still puts the application back: the pages, the letter, the
     * save — all but the posting's text, which the card is told is gone.
     */
    ss.quota = Infinity;
    const back = await send('keepTogether', {}, { id: 832 });
    assert.equal(back.data?.ok, true);
    assert.equal(back.data?.work?.letter, 'LETTER-832');
    const merged = session['trail:832'];
    assert.equal(merged.pages[0].url, 'https://boards.example/old/832');
    assert.equal(merged.textDropped, true, 'the card is not told the posting text went');
    assert.equal(session['jh-branched:832'], undefined);
  } finally {
    ss.quota = Infinity;
    for (const id of [831, 832, 833]) {
      delete session[`trail:${id}`];
      delete session[`jh-branched:${id}`];
      openTabs.delete(id);
    }
  }
});

test('a full session storage sweeps what closed tabs left before it strips an open one', async () => {
  const ss = chrome.storage.session;
  store = async () => json(analyzed());
  const now = Date.now();
  fullTrail(841, now - 2 * 60_000, 200);
  // Left under a tab that has closed: a worker stopped at the time never heard.
  fullTrail(842, now - 30 * 60_000, 200);
  openTabs.delete(842);
  ss.quota = ss.bytesInUse() + 120 * 1024;
  try {
    openTabs.add(843);
    await send('analyze', { url: `${posting}?tab=843`, title: 'Platform Engineer', html: bigPage(843, 200) }, { id: 843 });
    assert.ok(session['trail:843'].pages[0].html.length > 150_000, 'the posting being applied to lost its text');
    assert.equal(session['trail:842'], undefined, 'the closed tab’s trail is still there');
    assert.ok(session['trail:841'].pages[0].html.length > 150_000, 'an open tab was stripped before a closed one was swept');
  } finally {
    ss.quota = Infinity;
    for (const id of [841, 842, 843]) {
      delete session[`trail:${id}`];
      openTabs.delete(id);
    }
  }
});
