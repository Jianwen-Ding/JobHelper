/**
 * The popup's "Log an error" form, for ResumeM-M's error log.
 *
 * What went wrong in a line or two, screenshots — pasted, dropped, chosen,
 * or captured from the tab in front of you — and how far back the automatic
 * logs go. The service worker adds its own record of those minutes (see
 * shared/error-log.js) and sends the lot to ResumeM-M; when ResumeM-M cannot
 * be reached the entry is kept in the browser and sent the next time it
 * answers, and this says so.
 *
 * Opened by its button, or by the keyboard command (Alt+Shift+E), which the
 * worker answers by opening this popup with a note in session storage — or,
 * where the popup cannot be opened for it, this page in a window of its own
 * at `#log-error`.
 */

import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES, OPEN_FORM_KEY, SCRUB_HINT, bytesIn, refusedText } from '../shared/error-log.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const EMAIL_IN = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[A-Za-z]{2,}/;
const PHONE_IN = /(?<![\w])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w])/;

/** "an email", "a phone number", both, or '' — as ResumeM-M's own dialog says it. */
export function contactIn(text) {
  return [EMAIL_IN.test(text) && 'an email', PHONE_IN.test(text) && 'a phone number'].filter(Boolean).join(' and ');
}

/** The same small builder as the card's: a tag, its properties, its children. */
function h(tag, props = {}, kids = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (/^(aria|data)-/.test(key)) {
      if (value != null && value !== false) node.setAttribute(key, String(value));
    } else node[key] = value;
  }
  for (const kid of [].concat(kids)) if (kid != null && kid !== false) node.append(kid);
  return node;
}

/** A file as a data URL. */
function asDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('The image could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * `onUnreachable` is told when an entry could not be sent because ResumeM-M did
 * not answer, so the window's connection line can look again: it went on saying
 * "Connected — 13 resumes" in green beside the amber "ResumeM-M could not take
 * it just now", two answers about the same server at once.
 */
export function setupErrorLogForm({ send, activeTab, onUnreachable = () => {} }) {
  const $ = (id) => document.getElementById(id);
  const form = $('errorLogForm');
  if (!form) return null;
  let shots = [];
  let busy = false;

  const say = (text, kind = '') => {
    $('errorLogSaid').textContent = text;
    $('errorLogSaid').className = `said ${kind}`;
  };

  function drawShots() {
    $('errorShots').replaceChildren(
      ...shots.map((dataUrl, i) =>
        h('figure', {}, [
          h('img', { src: dataUrl, alt: `Screenshot ${i + 1}` }),
          h('button', {
            textContent: 'Remove',
            'aria-label': `Remove screenshot ${i + 1}`,
            onclick: () => {
              shots.splice(i, 1);
              drawShots();
            },
          }),
        ]),
      ),
    );
  }

  /** One more screenshot, unless it would be one too many or too much. */
  function addShot(dataUrl) {
    if (shots.length >= MAX_SCREENSHOTS) {
      say(`${MAX_SCREENSHOTS} screenshots is the most one entry takes.`, 'err');
      return false;
    }
    if (shots.reduce((n, s) => n + bytesIn(s), 0) + bytesIn(dataUrl) > MAX_SCREENSHOT_BYTES) {
      say('That one would take the screenshots past 8 MB together, so it was left out.', 'err');
      return false;
    }
    shots.push(dataUrl);
    say('');
    drawShots();
    return true;
  }

  async function addFiles(files) {
    for (const file of files) {
      if (!IMAGE_TYPES.includes(file.type)) {
        say(`${file.name || 'That file'} is not a PNG, JPEG or WebP image, so it was left out.`, 'err');
        continue;
      }
      try {
        if (!addShot(await asDataUrl(file))) break;
      } catch (err) {
        say(err.message, 'err');
      }
    }
  }

  function open() {
    form.hidden = false;
    $('errorDescription').focus();
  }

  /*
   * Entries ResumeM-M read and refused, when the queue was sent. Said, with
   * their words to copy, and let go of only once the person has them or says
   * so — the queue dropped them with nothing said.
   */
  function showRefused(entries) {
    const box = $('errorLogRefused');
    if (!box) return;
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) {
      box.replaceChildren();
      return;
    }
    const reasons = [...new Set(list.map((e) => e.reason).filter(Boolean))].join('; ');
    const text = list.map(refusedText).join('\n\n---\n\n');
    const ids = list.map((e) => e.id);
    const note = h('div', { className: 'refused-said', role: 'status' });
    const dismiss = async () => {
      await send('dismissRefusedErrorLogs', { ids }).catch(() => undefined);
      box.replaceChildren();
    };
    box.replaceChildren(
      h('div', {
        textContent: `${list.length} ${list.length === 1 ? 'entry was' : 'entries were'} refused by ResumeM-M: ${reasons}`,
      }),
      h('div', { className: 'row' }, [
        h('button', {
          id: 'copyRefused',
          textContent: 'Copy text',
          title: 'Copy what you wrote, to keep it somewhere else',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(text);
            } catch {
              // No clipboard here: the words, selected, for Ctrl+C.
              const area = h('textarea', { readOnly: true, value: text, rows: 4, 'aria-label': 'The refused entries' });
              note.replaceChildren(area);
              area.select();
              return;
            }
            await dismiss();
            /*
             * Said where the button was. `say` writes under the form, and the
             * form is shut when the popup opens on a refused entry — so the
             * copy went through with nothing seen to say it had.
             */
            box.replaceChildren(
              h('div', {
                className: 'refused-said copied',
                role: 'status',
                textContent: `Copied the refused ${list.length === 1 ? 'entry’s' : 'entries’'} text — it is on the clipboard.`,
              }),
            );
          },
        }),
        h('button', { id: 'dismissRefused', textContent: 'Dismiss', onclick: () => dismiss() }),
      ]),
      note,
    );
  }

  async function showQueued() {
    let state;
    try {
      state = await send('errorLogQueue');
    } catch {
      return;
    }
    showRefused(state.refusedEntries);
    $('errorLogQueued').textContent = state.queued
      ? `${state.queued} error-log ${state.queued === 1 ? 'entry is' : 'entries are'} waiting in the browser for ResumeM-M, and will be sent the next time it answers.`
      : state.sent
        ? `Sent ${state.sent} error-log ${state.sent === 1 ? 'entry' : 'entries'} that ${state.sent === 1 ? 'was' : 'were'} waiting.`
        : '';
  }

  async function save() {
    if (busy) return;
    const description = $('errorDescription').value.trim();
    if (!description) {
      say('Say in a few words what went wrong first.', 'err');
      $('errorDescription').focus();
      return;
    }
    busy = true;
    $('saveErrorLog').disabled = true;
    say('Saving…');
    try {
      const tab = await activeTab().catch(() => null);
      const page = tab?.url && /^https?:/i.test(tab.url) ? { url: tab.url, title: tab.title ?? '' } : null;
      const result = await send('saveErrorLog', { description, minutes: Number($('errorMinutes').value) || 10, screenshots: shots, page });
      if (result.sent) {
        say('Logged to ResumeM-M’s error log (not pushed yet).', 'ok');
      } else {
        say(
          `ResumeM-M could not take it just now (${result.why}) — so it is kept in the browser, and will be sent the next time ResumeM-M answers.` +
            (result.screenshotsKept === false ? ' The browser had no room for its screenshots, so they were left out.' : ''),
          // Kept, not refused: said in the queue's amber, red being for what will not go at all.
          'warn',
        );
        try {
          onUnreachable(result);
        } catch {
          // The connection line is the window's; the entry is kept either way.
        }
      }
      $('errorDescription').value = '';
      if ($('errorLogContact')) $('errorLogContact').hidden = true;
      shots = [];
      drawShots();
      await showQueued();
    } catch (err) {
      say(`Not logged: ${err.message}`, 'err');
    } finally {
      busy = false;
      $('saveErrorLog').disabled = false;
    }
  }

  /*
   * The description is kept as written (it is the person's own), so an email
   * or a phone in it stays: said as it is typed, and not in the way of saving.
   */
  const hint = $('errorLogHint');
  if (hint) hint.textContent = SCRUB_HINT;
  $('errorDescription').addEventListener('input', () => {
    const what = contactIn($('errorDescription').value);
    const warn = $('errorLogContact');
    if (!warn) return;
    warn.hidden = !what;
    warn.textContent = what ? `Your description has ${what} in it — it will be kept as written.` : '';
  });

  $('logError').onclick = () => (form.hidden ? open() : (form.hidden = true));
  $('saveErrorLog').onclick = () => save();
  $('errorDescription').onkeydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };
  const zone = $('errorPaste');
  zone.onclick = () => $('errorFile').click();
  zone.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      $('errorFile').click();
    }
  };
  $('errorFile').onchange = () => {
    addFiles([...$('errorFile').files]);
    $('errorFile').value = '';
  };
  zone.ondragover = (event) => {
    event.preventDefault();
    zone.classList.add('over');
  };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = (event) => {
    event.preventDefault();
    zone.classList.remove('over');
    addFiles([...(event.dataTransfer?.files ?? [])]);
  };
  // Anywhere in the popup while the form is open: the description has the focus.
  document.addEventListener('paste', (event) => {
    if (form.hidden) return;
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind !== 'string' && /^image\//.test(item.type))
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  });

  /*
   * The tab in front of you, as it is. `captureVisibleTab` takes the window's
   * visible tab, so the window is the page's, not this popup's; the browser
   * allows it for the page the popup or the shortcut was opened over.
   */
  $('captureTab').onclick = async () => {
    try {
      const tab = await activeTab();
      if (!tab?.windowId && tab?.windowId !== 0) throw new Error('There is no page in front of the popup to capture.');
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      if (addShot(dataUrl)) say('Captured the page.', 'ok');
    } catch (err) {
      say(`The page could not be captured: ${err?.message ?? err}. Take a screenshot and paste it instead.`, 'err');
    }
  };

  // Opened for the keyboard command: by its note in session storage, or by the address.
  (async () => {
    let asked = location.hash === '#log-error';
    try {
      const { [OPEN_FORM_KEY]: at } = await chrome.storage.session.get(OPEN_FORM_KEY);
      if (typeof at === 'number' && Date.now() - at < 60_000) asked = true;
      if (at !== undefined) await chrome.storage.session.remove(OPEN_FORM_KEY);
    } catch {
      // No session storage to read: the address still says.
    }
    if (asked) open();
  })();
  showQueued();

  return { open, save };
}
