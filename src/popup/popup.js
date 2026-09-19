const $ = (id) => document.getElementById(id);

const send = (type, payload) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!response?.ok) reject(new Error(response?.error ?? 'No response'));
      else resolve(response.data);
    });
  });

function setStatus(text, kind = '') {
  const s = $('status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

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
    const [behind] = await chrome.tabs.query({ currentWindow: true, url: ['http://*/*', 'https://*/*'] });
    return behind ?? tab;
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
  $('backToApplication').onclick = async () => {
    if (!last?.url) return;
    await chrome.tabs.update(tab.id, { url: last.url });
    window.close();
  };

  $('dropApplication').onclick = async () => {
    await send('clearTrail', { tabId: tab.id });
    panel.hidden = true;
    setStatus('Forgotten. The next job page starts a new application.', 'ok');
  };
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
  fix.onclick = async () => {
    if (status.state === 'unconfigured') {
      const { serverUrl } = await send('getSettings');
      chrome.tabs.create({ url: `${serverUrl.replace(/\/$/, '')}/#voice` });
      window.close();
      return;
    }
    fix.disabled = true;
    try {
      await send('setAiEnabled', { enabled: status.state !== 'on' });
      // Turning the server's on is only half of it if this side is still off.
      if (status.state === 'server-off' && !$('useAi').checked) {
        $('useAi').checked = true;
        await send('setSettings', { patch: { useAi: true } });
      }
      await showAiState();
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      fix.disabled = false;
    }
  };
}

async function boot() {
  const settings = await send('getSettings');
  $('serverUrl').value = settings.serverUrl;
  $('autoPrompt').checked = settings.autoPrompt;
  $('useAi').checked = settings.useAi;

  const save = async (patch) => {
    await send('setSettings', { patch });
  };

  $('serverUrl').onchange = async () => {
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
  };
  $('autoPrompt').onchange = () => save({ autoPrompt: $('autoPrompt').checked });
  $('useAi').onchange = async () => {
    await save({ useAi: $('useAi').checked });
    showAiState();
  };
  showAiState();
  showOpenApplication().catch(() => undefined);

  $('baseResumeId').onchange = () => save({ baseResumeId: $('baseResumeId').value });

  $('show').onclick = async () => {
    try {
      await tellContentScript('show-card');
      window.close();
    } catch (err) {
      setStatus(err.message, 'err');
    }
  };

  $('autofill').onclick = async () => {
    try {
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
    } catch (err) {
      setStatus(err.message, 'err');
    }
  };

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
  $('mute').onclick = async () => {
    const host = hostOf((await activeTab())?.url);
    if (!host) {
      setStatus('This page does not belong to a site that can be muted.', 'warn');
      return;
    }
    const muted = new Set((await send('getSettings')).mutedHosts ?? []);
    const wasMuted = muted.has(host);
    if (wasMuted) muted.delete(host);
    else muted.add(host);
    await save({ mutedHosts: [...muted] });
    await drawMute();
    setStatus(wasMuted ? `${host} is no longer muted — reload the page.` : `Muted ${host}.`, 'ok');
  };

  $('openApp').onclick = async () => {
    const current = await send('getSettings');
    chrome.tabs.create({ url: current.serverUrl });
  };

  check();
  // The mute button's own state, which does not depend on the store being
  // reachable: a muted site stays muted whether or not ResumeM-M answers.
  drawMute().catch(() => undefined);
}

async function check() {
  try {
    await send('ping');
    const resumes = await send('listResumes');
    const settings = await send('getSettings');

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
    setStatus(err.message, 'err');
  }
}

boot().catch((err) => setStatus(err.message, 'err'));
