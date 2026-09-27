/**
 * The ResumeM-M editor, beside the page.
 *
 * The browser's side panel, holding the real editor in a frame, on the resume
 * the card on this tab is working with:
 *
 *   - the copy made for this posting, once it is in the store;
 *   - until then the resume it is made from, said as such — the copy is only
 *     written when it is built or filed, and opening an id with nothing
 *     behind it leaves the editor on whatever it had open;
 *   - with no application on the tab, the resume every tailoring starts
 *     from, said as such too.
 *
 * It follows the tab: switch tabs, or switch resume on the card, and the
 * editor moves with it. It moves through the editor's own door (see
 * ResumeM-M's web/embed.js), which writes a pending edit first and refuses
 * to move while it cannot — so nothing typed is lost to a tab switch, and a
 * refusal is said rather than papered over.
 *
 * And it says so when it cannot show anything useful, rather than showing an
 * empty frame: ResumeM-M not running, a different save open from the one
 * this application was built in, the resume deleted in the meantime.
 *
 * Opened as a tab or a window instead of a panel, `?window=<id>` follows the
 * active tab of that window and `?tab=<id>` stays on one tab.
 */

import { getSettings } from '../shared/config.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const pinnedTab = params.has('tab') ? Number(params.get('tab')) : null;
const pinnedWindow = params.has('window') ? Number(params.get('window')) : null;
/** A window of its own (see `openPanelWindow`), which folding can shrink. */
const ownWindow = pinnedWindow !== null && pinnedTab === null;

const POLL_MS = 4000;
const PREFS_KEY = 'jh-panel-prefs';

const frame = $('#editor');

const model = {
  /** The window whose active tab this follows, when it follows one. */
  windowId: pinnedWindow,
  tabId: null,
  /** The service worker's answer for that tab. See `panelFor`. */
  info: null,
  serverUrl: null,
  health: null,
  down: false,
  resumes: [],
  revision: null,
  /** What should be on screen, worked out by `choose`. */
  plan: null,
  /** The origin the frame has loaded, or null before it has one. */
  loaded: null,
  /** The editor's last word about itself; null until it has said anything. */
  editor: null,
  /** The resume last asked of the editor, so a manual switch is not fought. */
  wanted: null,
  /** Pairs of (application save → open save) the person chose to edit anyway. */
  otherSaveOk: new Set(),
  prefs: { collapsed: false, view: 'edit', focus: false, window: null },
  refusedAt: 0,
  /** Copies this panel has seen in the store, so one that goes is known as deleted. */
  seenCopies: new Set(),
};

/* ------------------------------------------------------------------ *
 * Talking to the editor                                               *
 * ------------------------------------------------------------------ */

let seq = 0;
const waiting = new Map();

function post(message) {
  if (!model.loaded) return;
  try {
    frame.contentWindow?.postMessage(message, model.loaded);
  } catch {
    // The frame is between documents; the next state message catches up.
  }
}

/** Ask the editor something and wait for its answer, or for nothing. */
function ask(message, timeout = 4000) {
  const n = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(n);
      resolve(null);
    }, timeout);
    waiting.set(n, (reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
    post({ ...message, seq: n });
  });
}

window.addEventListener('message', (ev) => {
  if (ev.source !== frame.contentWindow || !model.loaded || ev.origin !== model.loaded) return;
  const m = ev.data;
  if (!m || typeof m !== 'object' || typeof m.rmm !== 'string') return;
  if (m.rmm === 'state') {
    const first = model.editor === null;
    model.editor = m;
    if (first) {
      // How it was left last time, in this browser.
      post({ rmm: 'view', view: model.prefs.view, focus: model.prefs.focus });
      reveal();
    } else if (m.view !== model.prefs.view || m.focus !== model.prefs.focus) {
      savePrefs({ view: m.view, focus: m.focus });
    }
    paint();
  } else if ((m.rmm === 'opened' || m.rmm === 'flushed') && waiting.has(m.seq)) {
    waiting.get(m.seq)(m);
    waiting.delete(m.seq);
  }
});

/** Have whatever is pending written, before the frame goes somewhere else. */
async function flushEditor(timeout = 3000) {
  if (!model.loaded || !model.editor) return true;
  const reply = await ask({ rmm: 'flush' }, timeout);
  return Boolean(reply?.ok);
}

/* ------------------------------------------------------------------ *
 * What to show                                                        *
 * ------------------------------------------------------------------ */

const origin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const basename = (dir) => String(dir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? String(dir ?? '');

async function getJson(url, timeout = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), cache: 'no-store' });
    if (!res.ok) return { failed: res.status };
    return await res.json();
  } catch {
    return null;
  }
}

async function worker(type, payload = {}) {
  try {
    const reply = await chrome.runtime.sendMessage({ type, payload });
    return reply?.ok ? reply.data : null;
  } catch {
    return null;
  }
}

async function currentTab() {
  if (pinnedTab !== null) return pinnedTab;
  const query = model.windowId !== null ? { active: true, windowId: model.windowId } : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query).catch(() => []);
  return tab?.id ?? null;
}

const labelOf = (id) => model.resumes.find((r) => r.id === id)?.label ?? null;

/**
 * Which resume this tab means, from the card's word and what the store has.
 *
 * Worked out afresh every time, against the list the store gives now: the
 * card's own list can be minutes old, and a copy it believes unbuilt may
 * have been built since, or deleted.
 */
function choose() {
  const info = model.info ?? {};
  const target = info.target;
  const held = new Set(model.resumes.map((r) => r.id));
  const job = target ? [target.role, target.company].filter(Boolean).join(' at ') : '';
  let plan;
  if (target?.copyId && held.has(target.copyId)) {
    model.seenCopies.add(target.copyId);
    plan = { id: target.copyId, why: 'copy', job };
  } else if (target?.baseId && held.has(target.baseId)) {
    // Seen in the store and gone from it since: deleted, not yet to be built.
    const deleted = Boolean(target.copyId) && model.seenCopies.has(target.copyId);
    plan = { id: target.baseId, why: deleted ? 'base-after-delete' : 'base-for-copy', job };
  } else if (target && (target.copyId || target.baseId)) {
    plan = { id: null, why: 'gone', job, gone: target.copyLabel ?? target.baseLabel ?? target.copyId ?? target.baseId };
  } else {
    const preferred = info.settings?.baseResumeId;
    const fallback =
      (held.has(preferred) && preferred) ||
      model.resumes.find((r) => r.tier === 'base')?.id ||
      model.resumes[0]?.id ||
      null;
    plan = { id: fallback, why: fallback ? 'no-application' : 'empty', preferred };
  }
  const meant = info.save;
  const open = model.health?.dataDir;
  if (meant && open && meant !== open && !model.otherSaveOk.has(`${meant}\u0000${open}`)) {
    plan.blocked = { meant, open };
  }
  model.plan = plan;
  return plan;
}

/* ------------------------------------------------------------------ *
 * Doing it                                                            *
 * ------------------------------------------------------------------ */

let refreshing = 0;

async function refresh() {
  const mine = ++refreshing;
  const tabId = await currentTab();
  const info = await worker('panelFor', { tabId });
  if (mine !== refreshing) return;
  model.tabId = tabId;
  model.info = info ?? { settings: await getSettings(), target: null };

  const serverUrl = model.info.settings.serverUrl;
  if (model.serverUrl && serverUrl !== model.serverUrl) await switchServer();
  if (mine !== refreshing) return;
  model.serverUrl = serverUrl;

  const health = await getJson(`${serverUrl}/health`, 2500);
  if (mine !== refreshing) return;
  if (!health || health.service !== 'resumem-m') {
    model.down = true;
    model.health = null;
    return paint();
  }
  model.down = false;
  model.health = health;
  if (!health.projectOpen) return paint();

  const [list, revision] = await Promise.all([
    getJson(`${serverUrl}/api/resumes`, 4000),
    getJson(`${serverUrl}/api/revision`, 2500),
  ]);
  if (mine !== refreshing) return;
  model.resumes = Array.isArray(list) ? list : (list?.resumes ?? []);
  model.revision = revision?.revision ?? model.revision;
  choose();
  paint();
  await navigate();
}

/** Put the editor on the planned resume, if it is not there and may go. */
async function navigate() {
  const plan = model.plan;
  if (!plan?.id || plan.blocked || model.down) return;
  const here = origin(model.serverUrl);
  // Not loaded, or loaded and not yet listening: point the frame there. A
  // message to an editor still starting up would go unheard.
  if (model.loaded !== here || !model.editor) {
    if (model.loaded === here && plan.id === model.wanted) return;
    model.loaded = here;
    model.editor = null;
    model.wanted = plan.id;
    frame.src = `${model.serverUrl}/#resumes/${encodeURIComponent(plan.id)}`;
    paint();
    return;
  }
  // Asked for already: if the editor is somewhere else now, somebody moved
  // it there, and a poll is not a reason to move it back.
  if (plan.id === model.wanted) return;
  model.wanted = plan.id;
  const reply = await ask({ rmm: 'open', id: plan.id }, 10_000);
  if (reply?.ok) return paint();
  // Refused. `wanted` is let go so the next pass asks again, and the reason
  // is said: an edit still saving is a wait, a resume the editor cannot find
  // is a reload.
  model.wanted = null;
  if (reply?.reason === 'missing') {
    model.loaded = null;
    model.editor = null;
    revealed = false;
    return refresh();
  }
  model.refusedAt = Date.now();
  paint();
  setTimeout(() => refresh().catch(() => undefined), 1500);
}

/** A different server address: finish with this editor before leaving it. */
async function switchServer() {
  if (model.loaded) await flushEditor();
  model.loaded = null;
  model.editor = null;
  model.wanted = null;
  model.resumes = [];
  model.revision = null;
  revealed = false;
  frame.removeAttribute('src');
}

/* ------------------------------------------------------------------ *
 * Drawing                                                             *
 * ------------------------------------------------------------------ */

let revealTimer = null;
let revealed = false;

/** Show the frame once the editor has said something, not before. */
function reveal() {
  clearTimeout(revealTimer);
  revealed = true;
  paint();
}

frame.addEventListener('load', () => {
  if (!model.loaded) return;
  // An editor too old to speak is shown anyway, a moment after it loads.
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    if (!revealed) reveal();
  }, 2500);
});

function message(title, text, { code = null, more = null, actions = [] } = {}) {
  $('#message-title').textContent = title;
  $('#message-text').textContent = text;
  $('#message-code').hidden = !code;
  $('#message-code').textContent = code ?? '';
  $('#message-more').hidden = !more;
  $('#message-more').textContent = more ?? '';
  $('#message-actions').replaceChildren(
    ...actions.map(([label, run, primary]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.onclick = run;
      return b;
    }),
  );
  $('#message').hidden = false;
}

function note(text, tone = '', action = null) {
  const el = $('#note');
  el.hidden = !text;
  el.className = `note ${tone}`.trim();
  el.replaceChildren(document.createTextNode(text ?? ''));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action[0];
    b.onclick = action[1];
    el.append(' ', b);
  }
}

const KIND = {
  copy: ['For this posting', 'copy'],
  'base-for-copy': ['Base', ''],
  'base-after-delete': ['Base', ''],
  'no-application': ['Base', ''],
};

function paint() {
  const plan = model.plan;
  const editor = model.editor;
  const onScreen = editor?.resumeId ?? null;
  $('#message').hidden = true;
  let cover = false;

  // The bar: the resume on screen, by name, and what it is to this tab.
  const shownLabel = (onScreen && (editor.label ?? labelOf(onScreen))) || (plan?.id && labelOf(plan.id)) || 'ResumeM-M';
  $('#label').textContent = shownLabel;
  $('#label').title = shownLabel;
  const kind = onScreen && plan?.id && onScreen !== plan.id ? null : KIND[plan?.why];
  $('#kind').hidden = !kind || model.down;
  if (kind) {
    $('#kind').textContent = kind[0];
    $('#kind').className = `kind ${kind[1]}`.trim();
  }
  const saving = editor?.save;
  $('#saving').hidden = !saving || saving === 'saved';
  $('#saving').className = `saving ${saving ?? ''}`.trim();
  $('#saving').textContent = saving === 'saving' ? 'Saving…' : saving === 'failed' ? 'Not saved' : saving === 'unsaved' ? 'Unsaved' : '';
  $('#newtab').disabled = model.down || !(onScreen || plan?.id);

  if (model.down) {
    if (model.loaded && revealed) {
      // The editor is on screen with what was typed in it; keep it, and say
      // that nothing will save until the server is back.
      note(
        `ResumeM-M stopped answering at ${model.serverUrl}. Changes made now will not save until it is running again.`,
        'bad',
      );
    } else {
      note('');
      cover = true;
      message(
        'ResumeM-M is not running',
        `Nothing answered at ${model.serverUrl}. Start it from the ResumeM-M folder:`,
        {
          code: 'npm run serve',
          more:
            'Or open the ResumeM-M app. This panel connects on its own once it answers. ' +
            'The address is set in JobHelper’s toolbar popup.',
          actions: [['Try again', () => refresh(), true]],
        },
      );
    }
  } else if (model.health && !model.health.projectOpen) {
    note('');
    cover = true;
    message('No save is open in ResumeM-M', 'Open or create a save in ResumeM-M’s Save & Files tab, then try again.', {
      actions: [['Try again', () => refresh(), true]],
    });
  } else if (plan?.blocked) {
    note('');
    cover = true;
    const { meant, open } = plan.blocked;
    message(
      'A different save is open',
      `ResumeM-M has “${basename(open)}” open, and this application was built in “${basename(meant)}”. ` +
        `Edits here would go into “${basename(open)}”.`,
      {
        more: `Open “${basename(meant)}” in ResumeM-M (Save & Files), or reload the posting to start the application again in the save that is open.`,
        actions: [
          ['Check again', () => refresh(), true],
          [
            'Edit anyway',
            () => {
              model.otherSaveOk.add(`${meant}\u0000${open}`);
              refresh();
            },
          ],
        ],
      },
    );
  } else if (plan?.why === 'gone') {
    note('');
    cover = true;
    const base = model.info?.settings?.baseResumeId;
    const other = labelOf(base) ? base : model.resumes[0]?.id;
    message(
      'That resume is no longer in the save',
      `The resume this tab was using${plan.gone ? ` (${plan.gone})` : ''} has been deleted in ResumeM-M.`,
      {
        more: 'Its version history still has it. The card can build the resume for this posting again.',
        actions: other ? [[`Open ${labelOf(other)}`, () => openInstead(other), true]] : [],
      },
    );
  } else if (onScreen && editor && editor.exists === false) {
    note('');
    cover = true;
    message('This resume was deleted', 'It is no longer in the save, so there is nothing here to edit.', {
      actions: plan?.id ? [[`Open ${labelOf(plan.id) ?? plan.id}`, () => openInstead(plan.id), true]] : [],
    });
  } else if (plan?.why === 'empty') {
    note('');
    cover = true;
    message('There are no resumes in this save yet', 'Add one in ResumeM-M, then try again.', {
      actions: [['Try again', () => refresh(), true]],
    });
  } else if (plan) {
    note(...contextNote(plan, onScreen));
  }

  drawPicker(cover ? null : onScreen);

  // Covered, the bar names what the message is about rather than whatever
  // the hidden editor last had open.
  if (cover) {
    const about = model.down ? 'ResumeM-M' : (plan?.gone ?? (plan?.id && labelOf(plan.id)) ?? 'ResumeM-M');
    $('#label').textContent = about;
    $('#label').title = about;
    $('#kind').hidden = true;
    $('#saving').hidden = true;
  }

  // The frame: shown once the editor has spoken, hidden (never removed)
  // while something covers it, so what is typed in it survives.
  const stage = $('#stage');
  const ready = Boolean(model.loaded) && revealed;
  stage.hidden = !model.loaded;
  stage.toggleAttribute('inert', cover || !ready);
  $('#loading').hidden = cover || ready || !model.loaded;
  $('#loading-text').textContent = 'Opening the editor…';
  document.body.classList.toggle('collapsed', model.prefs.collapsed);
  $('#folded').hidden = !model.prefs.collapsed;
  $('#fold').setAttribute('aria-expanded', String(!model.prefs.collapsed));
  $('#fold').title = model.prefs.collapsed ? 'Unfold the editor' : 'Fold the editor away. It stays as you left it.';
  $('#fold .sr').textContent = model.prefs.collapsed ? 'Unfold the editor' : 'Fold the editor';
}

/**
 * The resume picker in the bar, in place of the editor's own.
 *
 * The editor's picker is not drawn inside the panel (see ResumeM-M's
 * style.css, `.embedded`): it repeated the name this bar already shows, on a
 * row of its own. Switching resume from here goes through the same door as
 * following a tab — `openInstead` — so an edit still saving holds it.
 */
let pickerSaid = '';
const TIERS = [
  ['base', 'Bases'],
  ['extended', 'Kept'],
  ['temporary', 'Made for a posting'],
];
function drawPicker(onScreen) {
  const picker = $('#picker');
  const show = Boolean(onScreen) && model.resumes.some((r) => r.id === onScreen);
  picker.hidden = !show;
  $('#label').hidden = show;
  if (!show) return;
  const said = JSON.stringify(model.resumes.map((r) => [r.id, r.label, r.tier]));
  if (said !== pickerSaid) {
    pickerSaid = said;
    const option = (r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label ?? r.id;
      return o;
    };
    const groups = TIERS.map(([tier, label]) => [label, model.resumes.filter((r) => (r.tier ?? 'extended') === tier)]).filter(
      ([, list]) => list.length,
    );
    const known = new Set(TIERS.map(([t]) => t));
    const rest = model.resumes.filter((r) => r.tier && !known.has(r.tier));
    picker.replaceChildren(
      ...groups.map(([label, list]) => {
        const g = document.createElement('optgroup');
        g.label = label;
        g.append(...list.map(option));
        return g;
      }),
      ...rest.map(option),
    );
  }
  if (picker.value !== onScreen && document.activeElement !== picker) picker.value = onScreen;
  picker.title = `${picker.selectedOptions[0]?.textContent ?? ''} — switch the resume shown here`;
}

$('#picker').addEventListener('change', async (ev) => {
  const id = ev.target.value;
  /*
   * Not recorded as what the panel wants: that stays the tab's resume, so
   * the next look at the store does not move the editor back, and the note
   * under the bar offers the way back to the tab's.
   */
  await ask({ rmm: 'open', id }, 10_000);
  paint();
  // Refused (an edit still saving): the picker goes back to what is shown.
  if (model.editor?.resumeId && model.editor.resumeId !== id) ev.target.value = model.editor.resumeId;
  ev.target.blur();
});

/** The line under the bar: what this resume is to the tab beside it. */
function contextNote(plan, onScreen) {
  if (Date.now() - model.refusedAt < 1400) {
    return ['Your last change is still saving, so the editor stays where it is until it lands.', 'warn'];
  }
  if (onScreen && plan.id && onScreen !== plan.id) {
    return [
      `This tab is using ${labelOf(plan.id) ?? plan.id}.`,
      '',
      [
        'Show it',
        () => {
          model.wanted = null;
          navigate();
        },
      ],
    ];
  }
  // The bar already says it, by name and "For this posting".
  if (plan.why === 'copy') return ['', ''];
  if (plan.why === 'base-for-copy') {
    const base = labelOf(plan.id) ?? plan.id;
    return [`Copy for this posting not built yet — edits here change ${base} itself.`, 'warn'];
  }
  if (plan.why === 'base-after-delete') {
    const base = labelOf(plan.id) ?? plan.id;
    return [`Copy for this posting was deleted in ResumeM-M — showing ${base}, which it was made from.`, 'warn'];
  }
  if (plan.why === 'no-application') {
    const named = labelOf(plan.id) ?? plan.id;
    const note =
      plan.preferred && plan.preferred !== plan.id
        ? ` (JobHelper’s setting names “${plan.preferred}”, which is not in this save.)`
        : '';
    return [`No application on this tab. Showing ${named}, your base resume.${note}`, ''];
  }
  return ['', ''];
}

async function openInstead(id) {
  model.otherSaveOk.clear();
  if (!model.loaded || !model.editor) {
    model.loaded = null;
    model.plan = { id, why: 'no-application' };
    return navigate();
  }
  model.wanted = id;
  const reply = await ask({ rmm: 'open', id }, 10_000);
  if (!reply?.ok) model.wanted = null;
  paint();
}

/* ------------------------------------------------------------------ *
 * Folding, and remembering how it was left                            *
 * ------------------------------------------------------------------ */

async function loadPrefs() {
  const { [PREFS_KEY]: saved } = await chrome.storage.local.get(PREFS_KEY).catch(() => ({}));
  if (saved && typeof saved === 'object') {
    model.prefs = {
      collapsed: saved.collapsed === true,
      view: saved.view === 'preview' ? 'preview' : 'edit',
      focus: saved.focus === true,
      window: saved.window ?? null,
    };
  }
}

function savePrefs(patch) {
  model.prefs = { ...model.prefs, ...patch };
  chrome.storage.local.set({ [PREFS_KEY]: model.prefs }).catch(() => undefined);
}

let expandedHeight = null;

async function setCollapsed(collapsed) {
  if (collapsed === model.prefs.collapsed) return;
  if (ownWindow && chrome.windows?.getCurrent) {
    const win = await chrome.windows.getCurrent().catch(() => null);
    if (win && collapsed) {
      /*
       * A window of its own shrinks to its bar. The frame is held at the
       * height it had, so shrinking the window clips it rather than laying
       * the editor out again at no height — which would lose its scroll.
       */
      const main = $('#main');
      main.style.height = `${main.offsetHeight}px`;
      main.style.flex = 'none';
      expandedHeight = win.height;
      const chrome_ = Math.max(0, window.outerHeight - window.innerHeight);
      await chrome.windows.update(win.id, { height: Math.round(chrome_ + 40 + 34) }).catch(() => undefined);
    } else if (win && !collapsed) {
      await chrome.windows
        .update(win.id, { height: expandedHeight ?? model.prefs.window?.height ?? 820 })
        .catch(() => undefined);
      $('#main').style.height = '';
      $('#main').style.flex = '';
    }
  }
  savePrefs({ collapsed });
  paint();
}

$('#fold').addEventListener('click', () => setCollapsed(!model.prefs.collapsed));

$('#reload').addEventListener('click', async () => {
  await flushEditor();
  model.loaded = null;
  model.editor = null;
  model.wanted = null;
  revealed = false;
  refresh();
});

$('#newtab').addEventListener('click', async () => {
  const id = model.editor?.resumeId ?? model.plan?.id;
  if (!id || !model.serverUrl) return;
  // Written first, so the new tab opens on what this one had.
  await flushEditor(1500);
  chrome.tabs.create({ url: `${model.serverUrl}/#resumes/${encodeURIComponent(id)}` });
});

if (ownWindow) {
  let sizeTimer = null;
  window.addEventListener('resize', () => {
    if (model.prefs.collapsed) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      savePrefs({ window: { width: window.outerWidth, height: window.outerHeight } });
    }, 400);
  });
}

/* ------------------------------------------------------------------ *
 * Following the tab, and the store                                    *
 * ------------------------------------------------------------------ */

chrome.tabs.onActivated.addListener(({ windowId }) => {
  if (pinnedTab !== null) return;
  if (model.windowId !== null && windowId !== model.windowId) return;
  refresh();
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== model.tabId) return;
  if (change.url || change.status === 'complete') refresh();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.serverUrl || changes.baseResumeId)) refresh();
  if ((area === 'session' || area === 'local') && model.tabId !== null && changes[`jh-panel:${model.tabId}`]) refresh();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

/**
 * The store, watched: a resume deleted, the card building its copy, the
 * server going away or coming back. Only while the panel can be seen.
 */
async function poll() {
  if (document.visibilityState !== 'visible' || !model.serverUrl) return;
  const health = await getJson(`${model.serverUrl}/health`, 2500);
  const up = Boolean(health && health.service === 'resumem-m');
  if (!up) {
    if (!model.down) {
      model.down = true;
      paint();
    }
    return;
  }
  if (model.down || health.dataDir !== model.health?.dataDir || health.projectOpen !== model.health?.projectOpen) {
    return refresh();
  }
  const revision = (await getJson(`${model.serverUrl}/api/revision`, 2500))?.revision;
  if (!revision || revision === model.revision) return;
  model.revision = revision;
  const list = await getJson(`${model.serverUrl}/api/resumes`, 4000);
  if (Array.isArray(list)) model.resumes = list;
  post({ rmm: 'refresh' });
  choose();
  paint();
  navigate();
}

async function start() {
  if (pinnedTab === null && model.windowId === null && chrome.windows?.getCurrent) {
    model.windowId = (await chrome.windows.getCurrent().catch(() => null))?.id ?? null;
  }
  await loadPrefs();
  paint();
  await refresh();
  setInterval(() => poll().catch(() => undefined), POLL_MS);
}

start();
