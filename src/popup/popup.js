const $ = (id) => document.getElementById(id);

const send = (type, payload) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) {
        /*
         * With the button that fixes it, which used to be dropped here.
         *
         * `serverFetch` goes to deliberate trouble to mark the two failures
         * somebody can actually do something about — no save open, server not
         * running — and the content script turns that mark into a one-click
         * "Open a save in ResumeM-M" on the card. This threw the mark away and
         * kept only the sentence, so the same failure that offers a button on
         * a job page offered nothing at all in the window people open
         * *because* they are checking the connection.
         */
        const err = new Error(response?.error ?? 'No response');
        if (response?.fix) err.jobhelper = response.fix;
        reject(err);
      } else resolve(response.data);
    });
  });

function setStatus(text, kind = '', fix) {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;

  /*
   * And the way out, when the failure came with one.
   *
   * Two of these are things the user can act on in one press — no save open,
   * the server not running — and the card on a job page has offered that
   * button for a while. This window is where somebody goes *because* they are
   * checking the connection, and it was the one place the same failure was a
   * dead end.
   */
  if (fix?.serverUrl) {
    const button = document.createElement('button');
    button.className = 'ai-fix';
    button.textContent = fix.fix === 'open-save' ? 'Open a save in ResumeM-M' : 'Open ResumeM-M';
    button.onclick = () => {
      chrome.tabs.create({ url: fix.serverUrl });
      window.close();
    };
    s.append(document.createElement('br'), button);
  }
}

/** Report a failure, carrying whatever it knows about how to get past it. */
const failed = (err) => setStatus(err.message, 'err', err.jobhelper);

/**
 * A control that does something, and says so when it cannot.
 *
 * Every button and box in this window goes through `send`, and `send` rejects
 * for two ordinary reasons: the reply says `ok: false`, or the messaging
 * channel is gone because the extension was reloaded while this window was
 * open — which is exactly what happens while the extension is being worked
 * on, and how the popup gets looked at as a tab.
 *
 * An `async` handler assigned straight to `onclick` turns either of those into
 * an unhandled rejection. The handler stops where it was, and because the
 * status line is only written on the *last* line of most of these, nothing on
 * screen changes at all. Press "Mute this site" and it is not muted, with no
 * error and no mark on the button; tick "Let it use the AI" and the box stays
 * ticked over a setting that was never saved — a window whose whole job is
 * telling you the state of things, lying about it.
 *
 * Two of these were wrapped by hand and the rest were not, which is the usual
 * end of "remember to catch it here": the ones somebody happened to be
 * thinking about are covered and the other seven are not. So it is one
 * wrapper, and a handler that does not use it is visible as one.
 */
const acts = (fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (err) {
    failed(err);
  }
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  /*
   * Never this extension's own pages.
   *
   * A popup is not a tab, so the active tab is the page behind it and this
   * costs nothing in ordinary use. But popup.html opens perfectly well as a
   * tab of its own — which is how it is looked at while being worked on, and
   * how a harness reaches it — and then the active tab is the popup, so
   * "mute this site" offered to mute the extension. Whatever the popup is
   * acting on, it is never itself.
   */
  if (tab?.url?.startsWith('chrome-extension://')) {
    /*
     * The one you were last on, not the one furthest left.
     *
     * `chrome.tabs.query` hands its results back in tab-strip order, so taking
     * the first of them picks the leftmost page in the window — which has
     * nothing to do with "the page behind the popup". With two job pages open
     * and the right-hand one in front, Autofill typed the user's name, email
     * and phone into the *other* site's form in a background tab, and the
     * popup reported "Filled 4 fields." over a form that was still empty.
     * Mute silenced a host the user was not on, and the open-application panel
     * described somebody else's posting.
     *
     * `lastAccessed` is the browser's own answer to "which of these were you
     * just looking at". Where it is missing, the tab next to this one is a
     * better guess than the first in the strip: the popup opens beside the
     * page it was opened from.
     */
    const open = await chrome.tabs.query({ currentWindow: true, url: ['http://*/*', 'https://*/*'] });
    if (open.length === 0) return tab;
    const recent = open.filter((t) => typeof t.lastAccessed === 'number');
    if (recent.length > 0) {
      return recent.reduce((best, t) => (t.lastAccessed > best.lastAccessed ? t : best));
    }
    const mine = typeof tab.index === 'number' ? tab.index : 0;
    return open.reduce((best, t) => (Math.abs(t.index - mine) < Math.abs(best.index - mine) ? t : best));
  }
  return tab;
}

/**
 * Say which way the mute button goes, for the site in front of you.
 *
 * Drawn from the settings rather than remembered, so a host muted in another
 * window — or in a previous sitting — is reported as muted here.
 */
async function drawMute() {
  const button = $('mute');
  if (!button) return;
  const host = hostOf((await activeTab())?.url);
  const muted = host && ((await send('getSettings')).mutedHosts ?? []).includes(host);
  button.textContent = muted ? 'Show here again' : 'Mute this site';
  button.title = muted
    ? `JobHelper is muted on ${host}. This turns it back on.`
    : host
      ? `Never offer on ${host}.`
      : 'Never offer on this site.';
}

/** The host a page belongs to, or nothing when it does not have one. */
function hostOf(url) {
  try {
    const { protocol, hostname } = new URL(url ?? '');
    return /^https?:$/.test(protocol) && hostname ? hostname : null;
  } catch {
    return null;
  }
}

/** Ask the content script to do something, reporting clearly if it is absent. */
async function tellContentScript(type) {
  const tab = await activeTab();
  if (!tab?.id) return;

  /*
   * Two different failures, and only one of them is "not running here".
   *
   * `sendMessage` rejects when there is no content script to receive it — a
   * chrome:// page, a page loaded before the extension, a tab that has not
   * finished loading. Reloading genuinely fixes that one.
   *
   * A content script that answers `{ok: false, error}` is running and telling
   * us exactly what went wrong. That sentence used to be thrown a line above
   * a bare `catch` inside the same `try`, so it was caught by the handler
   * meant for the other failure and replaced with a diagnosis of a problem
   * the user did not have: press Autofill with no name in your profile and
   * the popup said JobHelper was not running and to reload the tab. Reloading
   * changes nothing, the message never changes, and the one sentence that
   * said what to do — "Your profile has no name or email in it yet" — was
   * the thing discarded.
   */
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    throw new Error('JobHelper is not running on this page. Reload the tab and try again.');
  }
  if (!response?.ok) throw new Error(response?.error ?? 'That did not work, and the page did not say why.');
  return response.data;
}

/**
 * Say what application this tab is in the middle of.
 *
 * The toolbar badge is a number, and a number on its own invites exactly one
 * question. This is the answer to it: whose application, how much of it has
 * been read, and whether anything you typed is being held. Then the two things
 * you would want having asked — go back to where you were writing, or say this
 * is finished and stop carrying it.
 */
async function showOpenApplication() {
  const panel = $('openApplication');
  const tab = await activeTab();
  if (!tab?.id) return;

  let trail;
  try {
    trail = await send('getTrail', { tabId: tab.id });
  } catch {
    // The worker is not answering. That is the connection line's news to
    // break, not this panel's, and a wrong panel is worse than none.
    panel.hidden = true;
    return;
  }

  const pages = trail?.pages ?? [];
  if (pages.length === 0) {
    panel.hidden = true;
    return;
  }

  const named = pages.map((p) => p.company).filter(Boolean).pop();
  const role = pages.map((p) => p.role).filter(Boolean).pop();
  // The role first, then who it is with: "Helios" alone is not enough to come
  // back to an hour later, and says nothing at all when two of their jobs are
  // open in two tabs.
  const who = named ?? pages.map((p) => p.title).filter(Boolean).pop() ?? 'An application';
  $('openWho').textContent = role && named ? `${role} — ${named}` : who;

  const n = pages.length;
  const what = [`Written from ${n} ${n === 1 ? 'page' : 'pages'} of this application`];
  // The reassurance is the point of the whole panel, so it is said in the
  // words someone worried would use — and only about what is actually there.
  if (trail.holdingWriting) what.push('your writing is being held, and comes back when you return');
  /*
   * "Tailored" is a claim, and this cannot make it. `holdingResume` is true
   * of any proposal at all, and a proposal is now the resume exactly as it is
   * kept until somebody ticks something — so on every ordinary application
   * this line said the AI had been at work when nothing had.
   */
  else if (trail.holdingResume) what.push('the resume for it is ready and waiting');
  $('openWhat').textContent = `${what.join(' — ')}.`;
  panel.hidden = false;

  // Back to the last page of it, which is where you were when you wandered
  // off. Same tab, because the application is the tab.
  const last = pages[pages.length - 1];
  /*
   * Not offered from the page it would go back to.
   *
   * The panel shows on the application's own pages too, and the last of them
   * is usually the form. Pressed there, "going back" is a reload: measured,
   * the form came back empty, everything typed into the employer's boxes
   * gone, from a button promising the opposite.
   */
  const bare = (url) => String(url ?? '').split('#')[0];
  $('backToApplication').hidden = !last?.url || bare(last.url) === bare(tab.url);
  $('backToApplication').onclick = acts(async () => {
    if (!last?.url) return;
    await chrome.tabs.update(tab.id, { url: last.url });
    window.close();
  });

  $('dropApplication').onclick = acts(async () => {
    await send('clearTrail', { tabId: tab.id });
    panel.hidden = true;
    setStatus('Forgotten. The next job page starts a new application.', 'ok');
  });
}

/**
 * Say whether an AI is actually in play, and offer the thing that changes it.
 *
 * Two switches have to agree: this extension's `useAi`, and `ai.enabled` on the
 * ResumeM-M server. Either one off means nothing is sent to an AI. The failure
 * that got reported was ticking the box here while the server's switch was off
 * — nothing happened, and the only clue was a line of small print naming a tab
 * in another window. So each state now carries the button that fixes it.
 */
const AI_STATE = {
  on: {
    text: 'AI on',
    className: 'ai on',
    hint: 'Your AI command will be asked to tailor resumes and draft letters.',
    fix: 'Turn off',
  },
  off: {
    text: 'AI off',
    className: 'ai off',
    /*
     * What the off state actually gets you, which is not nothing.
     *
     * It said "tag matching is instant and free, and usually right" — a
     * sentence about an automatic decision that no longer happens. The match
     * is a list of suggestions now: worked out on arrival, applied to
     * nothing, and taken one box at a time.
     */
    hint: 'Off by default. Keyword suggestions are still worked out — free and instant — and you pick the ones you want.',
  },
  'server-off': {
    text: 'Switched off in ResumeM-M',
    className: 'ai warn',
    hint: 'ResumeM-M has its own AI switch, and it is off — so nothing is sent to an AI yet.',
    fix: 'Turn it on',
  },
  unconfigured: {
    text: 'No AI set up',
    className: 'ai off',
    hint: 'ResumeM-M has no AI command configured. Set one up and this switch starts working.',
    fix: 'Set one up',
  },
  offline: {
    text: 'AI unknown',
    className: 'ai off',
    /*
     * Two ways to get here and the sentence has to be true of both: the
     * server is not there at all, or it is there and answered something that
     * was not its settings — starting up, restarting, a proxy in front of it.
     * "Not reachable" was a claim about the first that was simply false in
     * the second, said directly above a status line reporting the real
     * problem.
     */
    hint: 'ResumeM-M did not say what its AI setting is, so this could not be read.',
  },
};

async function showAiState() {
  let status;
  try {
    status = await send('aiStatus');
  } catch {
    status = { state: 'offline' };
  }

  const shape = AI_STATE[status.state] ?? AI_STATE.off;
  $('aiState').textContent = shape.text;
  $('aiState').className = shape.className;
  $('aiHint').textContent = shape.hint;
  $('aiCommand').textContent = status.state === 'unconfigured' || !status.command ? '' : `Runs: ${status.command}`;

  // The checkbox only governs this extension. When the thing standing in the
  // way is on the other side, the button beside it reaches across.
  const fix = $('aiFix');
  fix.hidden = !shape.fix;
  if (!shape.fix) return;

  fix.textContent = shape.fix;
  fix.onclick = acts(async () => {
    if (status.state === 'unconfigured') {
      const { serverUrl } = await send('getSettings');
      chrome.tabs.create({ url: `${serverUrl.replace(/\/$/, '')}/#voice` });
      window.close();
      return;
    }
    fix.disabled = true;
    try {
      /*
       * Off is this extension's own switch, not ResumeM-M's.
       *
       * It flipped the server's, which the editor's AI answers to as well,
       * and left the box here ticked — so the panel then read "Switched off in
       * ResumeM-M" in amber with a "Turn it on" button, as though something
       * had gone wrong, straight after being asked to turn it off. Unticking
       * the box is what the box beside this button already does.
       */
      if (status.state === 'on') {
        $('useAi').checked = false;
        await send('setSettings', { patch: { useAi: false } });
        await showAiState();
        return;
      }
      await send('setAiEnabled', { enabled: true });
      // Turning the server's on is only half of it if this side is still off.
      if (status.state === 'server-off' && !$('useAi').checked) {
        $('useAi').checked = true;
        await send('setSettings', { patch: { useAi: true } });
      }
      await showAiState();
    } catch (err) {
      failed(err);
    } finally {
      fix.disabled = false;
    }
  });
}

async function boot() {
  const settings = await send('getSettings');
  $('serverUrl').value = settings.serverUrl;
  $('autoPrompt').checked = settings.autoPrompt;
  $('useAi').checked = settings.useAi;

  const save = async (patch) => {
    await send('setSettings', { patch });
  };

  $('serverUrl').onchange = acts(async () => {
    /*
     * And put back what is actually in force, which is not always what was
     * typed: `localhost:4600` gains the scheme it needs, an emptied box goes
     * back to the default rather than storing nothing. Showing the typed text
     * while using something else is the disagreement this whole window keeps
     * getting wrong — see `normaliseServerUrl`.
     */
    const after = await send('setSettings', { patch: { serverUrl: $('serverUrl').value.trim() } });
    $('serverUrl').value = after.serverUrl;
    check();
  });
  $('autoPrompt').onchange = acts(() => save({ autoPrompt: $('autoPrompt').checked }));
  $('useAi').onchange = acts(async () => {
    await save({ useAi: $('useAi').checked });
    showAiState();
  });
  showAiState();
  showOpenApplication().catch(() => undefined);

  $('baseResumeId').onchange = acts(() => save({ baseResumeId: $('baseResumeId').value }));

  $('show').onclick = acts(async () => {
    await tellContentScript('show-card');
    window.close();
  });

  $('autofill').onclick = acts(async () => {
    const report = await tellContentScript('autofill');
    const f = report.filled.length;
    const parts = [`Filled ${f} ${f === 1 ? 'field' : 'fields'}`];

    /*
     * Skipped is not one thing. A field left alone because it already had an
     * answer is finished; one skipped because nothing in the list matched, or
     * because it is a widget nothing can drive, is a required field still
     * empty. Reporting both as "already filled" told someone their country
     * dropdown was done when it was blank — which is the difference between
     * done and done wrong, and the reason the reasons are recorded at all.
     */
    const byReason = new Map();
    for (const s of report.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    const done = byReason.get('already filled') ?? 0;
    const yours = report.skipped.length - done;
    if (done) parts.push(`left ${done} already filled`);
    if (yours) parts.push(`${yours} still need${yours === 1 ? 's' : ''} you`);

    setStatus(`${parts.join(', ')}.`, yours ? 'warn' : 'ok');
  });

  /*
   * Muting, and unmuting, from the same button.
   *
   * It was one-way. One click, no warning on it, and the card never came back
   * on that host — there was no list of muted sites anywhere, no toggle, and
   * nothing in the popup that even said this one was muted. The way back was
   * editing `chrome.storage.sync` by hand, which is not a thing anybody is
   * going to find. Mute a job board while reading it, come back next week, and
   * the tool is simply broken there for reasons you cannot see.
   *
   * So the button says which way it goes, and it is drawn from the settings
   * every time the popup opens rather than remembered here.
   */
  $('mute').onclick = acts(async () => {
    const host = hostOf((await activeTab())?.url);
    if (!host) {
      setStatus('This page does not belong to a site that can be muted.', 'warn');
      return;
    }
    const wasMuted = ((await send('getSettings')).mutedHosts ?? []).includes(host);
    // Through the worker, which serialises it: this list is shared with every
    // tab's card and a read here plus a write there loses one of the two.
    await send('muteHost', { host, muted: !wasMuted });
    await drawMute();
    setStatus(wasMuted ? `${host} is no longer muted — reload the page.` : `Muted ${host}.`, 'ok');
  });

  $('openApp').onclick = acts(async () => {
    const current = await send('getSettings');
    chrome.tabs.create({ url: current.serverUrl });
  });

  check();
  // The mute button's own state, which does not depend on the store being
  // reachable: a muted site stays muted whether or not ResumeM-M answers.
  drawMute().catch(() => undefined);
}

/**
 * Which look at the server is the current one.
 *
 * `check` runs on boot and again on every address change, and a fetch against
 * an address that swallows packets takes twenty seconds to give up. Point the
 * box at a dead server, then at a live one: the second look answers in
 * milliseconds and says "Connected — 13 resumes", and then the first one's
 * failure lands on top of it, blanks the picker to "— not connected —" and
 * reports the live server as down. The function's own note is about the same
 * disagreement in the other direction.
 */
let looking = 0;

async function check() {
  const mine = ++looking;
  const current = () => mine === looking;
  /*
   * Say so while it is being asked.
   *
   * `check` runs on boot and again on every address change, and until it
   * answers the window kept whatever the last server said. Pointed at an
   * address that swallows packets, the popup reported "Connected — 13 resumes
   * in the store" about a server it was no longer talking to, for the twenty
   * seconds the fetch took to give up.
   */
  setStatus('Checking…');
  try {
    await send('ping');
    const resumes = await send('listResumes');
    const settings = await send('getSettings');
    if (!current()) return;

    // Labels only. The id is how the store files a resume, not how its owner
    // thinks of it, and the picker is the owner's view. Pinned bases come
    // first from the server, and are grouped so that ordering has a reason.
    const option = (r) => {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.label;
      o.selected = r.id === settings.baseResumeId;
      return o;
    };
    const pinned = resumes.filter((r) => r.base);
    const picker = $('baseResumeId');

    if (pinned.length > 0 && pinned.length < resumes.length) {
      const group = (label, list) => {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const r of list) g.append(option(r));
        return g;
      };
      picker.replaceChildren(
        group('Bases', pinned),
        group('Everything else', resumes.filter((r) => !r.base)),
      );
    } else {
      picker.replaceChildren(...resumes.map(option));
    }
    /*
     * A stored choice naming a resume this save does not have.
     *
     * Nothing gets `selected`, so the browser quietly selects the first
     * option — and because that is not a change the user made, no `change`
     * event fires and nothing is written back. The picker then read
     * confidently as one resume while every page's card failed with
     * `No resume "newgrad"`, naming an id its owner had never typed and
     * pointing at a picker that looked correctly set.
     *
     * Not repaired silently either: which resume to start from is the user's
     * choice, and picking a different one on their behalf is how the card
     * ends up built from something they did not ask for. Said plainly, and
     * they choose.
     */
    const n = resumes.length;
    const stale = resumes.length > 0 && !resumes.some((r) => r.id === settings.baseResumeId);
    if (stale) {
      // And nothing valid left looking chosen, which is the half of this the
      // status line cannot fix: a picker reading "Software Engineer 2025" is
      // a claim, and it was not true.
      const placeholder = document.createElement('option');
      placeholder.textContent = '— pick a resume —';
      placeholder.disabled = true;
      placeholder.selected = true;
      picker.prepend(placeholder);
      setStatus(
        `Connected, but the resume this was set to is not in this save any more — pick one to start from.`,
        'err',
      );
    } else {
      setStatus(`Connected — ${n} ${n === 1 ? 'resume' : 'resumes'} in the store.`, 'ok');
    }
  } catch (err) {
    // Nothing from a look that has been overtaken: the address it was asking
    // about is not the one in the box any more.
    if (!current()) return;
    failed(err);
    /*
     * And nothing left on screen describing the server that did not answer.
     *
     * The picker kept the previous server's resumes, so the window said "not
     * open" over a list of thirteen — and choosing one of them writes a
     * `baseResumeId` the new save may well not have, which is precisely the
     * stale-base trap the block above exists to catch.
     */
    const picker = $('baseResumeId');
    const nothing = document.createElement('option');
    nothing.textContent = '— not connected —';
    nothing.disabled = true;
    nothing.selected = true;
    picker.replaceChildren(nothing);
  } finally {
    /*
     * The AI panel describes the same server, so it is read at the same time.
     * It was painted once at boot and never again, so changing the address
     * left it asserting "AI on — your AI command will be asked to tailor
     * resumes" directly under a status line saying the server was not running.
     */
    // Not from a look that has been overtaken either: the panel describes a
    // server this call is no longer the current question about.
    if (current()) await showAiState();
  }
}

boot().catch((err) => failed(err));
