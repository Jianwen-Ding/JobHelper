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
  return tab;
}

/** Ask the content script to do something, reporting clearly if it is absent. */
async function tellContentScript(type) {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type });
    if (!response?.ok) throw new Error(response?.error ?? 'Failed');
    return response.data;
  } catch {
    throw new Error('JobHelper is not running on this page. Reload the tab and try again.');
  }
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
    hint: 'Off by default — tag matching is instant and free, and usually right.',
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
    hint: 'ResumeM-M is not reachable, so its AI setting could not be read.',
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
    await save({ serverUrl: $('serverUrl').value.trim() });
    check();
  };
  $('autoPrompt').onchange = () => save({ autoPrompt: $('autoPrompt').checked });
  $('useAi').onchange = async () => {
    await save({ useAi: $('useAi').checked });
    showAiState();
  };
  showAiState();

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

  $('mute').onclick = async () => {
    const tab = await activeTab();
    if (!tab?.url) return;
    const host = new URL(tab.url).hostname;
    const current = await send('getSettings');
    await save({ mutedHosts: [...new Set([...(current.mutedHosts ?? []), host])] });
    setStatus(`Muted ${host}.`, 'ok');
  };

  $('openApp').onclick = async () => {
    const current = await send('getSettings');
    chrome.tabs.create({ url: current.serverUrl });
  };

  check();
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
    const n = resumes.length;
    setStatus(`Connected — ${n} ${n === 1 ? 'resume' : 'resumes'} in the store.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

boot().catch((err) => setStatus(err.message, 'err'));
