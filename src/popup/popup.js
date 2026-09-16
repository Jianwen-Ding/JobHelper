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
 * Say whether an AI is actually in play. Ticking the box here does nothing if
 * ResumeM-M has its own AI switched off, and silently doing nothing is the
 * worst of the three possible states — so name it.
 */
const AI_STATE = {
  on: ['AI on', 'ai on', 'Your configured AI CLI will be asked to tailor and to draft.'],
  off: ['AI off', 'ai off', 'Off by default — tag matching is instant and free, and usually right.'],
  'server-off': [
    'AI off in ResumeM-M',
    'ai warn',
    'ResumeM-M has its AI switched off, so this does nothing yet. Turn it on under Voice & AI.',
  ],
  offline: ['AI unknown', 'ai off', 'ResumeM-M is not reachable, so its AI setting could not be read.'],
};

async function showAiState() {
  let status;
  try {
    status = await send('aiStatus');
  } catch {
    status = { state: 'offline' };
  }
  const [text, className, hint] = AI_STATE[status.state] ?? AI_STATE.off;
  $('aiState').textContent = text;
  $('aiState').className = className;
  $('aiHint').textContent = hint;
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
      if (report.skipped.length) parts.push(`left ${report.skipped.length} already filled`);
      setStatus(`${parts.join(', ')}.`, 'ok');
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

    $('baseResumeId').replaceChildren(
      ...resumes.map((r) => {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = `${r.label} (${r.id})`;
        o.selected = r.id === settings.baseResumeId;
        return o;
      }),
    );
    const n = resumes.length;
    setStatus(`Connected — ${n} ${n === 1 ? 'resume' : 'resumes'} in the store.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

boot().catch((err) => setStatus(err.message, 'err'));
