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

import { MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES, OPEN_FORM_KEY, bytesIn } from '../shared/error-log.js';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

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

export function setupErrorLogForm({ send, activeTab }) {
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

  async function showQueued() {
    let state;
    try {
      state = await send('errorLogQueue');
    } catch {
      return;
    }
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
          'err',
        );
      }
      $('errorDescription').value = '';
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
