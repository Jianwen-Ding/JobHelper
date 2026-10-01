const PREFIX = 'bug-report:';
let fingerprint;
async function extensionBuild() {
  fingerprint ??= Promise.all(['src/content/card.js', 'src/background/service-worker.js', 'src/reports/report.js']
    .map(async (file) => (await fetch(chrome.runtime.getURL(file))).text()))
    .then(async (files) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(files.join('\n')));
      return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('').slice(0, 16);
    }).catch(() => 'unavailable');
  return fingerprint;
}

export async function listBugReports() {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored).filter(([key]) => key.startsWith(PREFIX)).map(([, report]) => report)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function clearBugReport(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid report ID.');
  const key = PREFIX + id;
  const report = (await chrome.storage.local.get(key))[key];
  if (!report?.receipt) throw new Error('Copy this report to the file inbox before clearing its browser copy.');
  await chrome.storage.local.remove(key);
  return { cleared: true };
}

export async function syncBugReport(id, serverFetch) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid report ID.');
  const key = PREFIX + id;
  const report = (await chrome.storage.local.get(key))[key];
  if (!report) throw new Error('That report is not in this browser.');
  if (report.receipt) return report;
  try {
    const receipt = await serverFetch('/api/bug-reports', { method: 'POST', body: JSON.stringify(report) });
    const kept = { ...report, receipt, syncError: null };
    await chrome.storage.local.set({ [key]: kept });
    return kept;
  } catch (error) {
    const kept = { ...report, syncError: error.message };
    await chrome.storage.local.set({ [key]: kept });
    return kept;
  }
}

export async function saveBugReport({ text, screenshots = [] }, serverFetch) {
  if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('Add notes describing the bug (up to 20,000 characters).');
  if (!Array.isArray(screenshots) || screenshots.length > 3
    || screenshots.some((image) => typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(image))
    || screenshots.reduce((size, image) => size + image.length, 0) > 4 * 1024 * 1024 * 4 / 3 + 300) {
    throw new Error('Add up to three screenshots totaling at most 4 MB.');
  }
  const report = { id: crypto.randomUUID(), text: text.trim(), screenshots, createdAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version, extensionBuild: await extensionBuild(), receipt: null };
  // First durable write succeeds even when ResumeM-M is unreachable.
  await chrome.storage.local.set({ [PREFIX + report.id]: report });
  return syncBugReport(report.id, serverFetch);
}
