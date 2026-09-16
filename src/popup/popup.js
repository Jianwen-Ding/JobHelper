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
  $('useAi').onchange = () => save({ useAi: $('useAi').checked });

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
      setStatus(`Filled ${report.filled.length} field(s), skipped ${report.skipped.length}.`, 'ok');
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
    setStatus(`Connected — ${resumes.length} resume(s) in the store.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

boot().catch((err) => setStatus(err.message, 'err'));
