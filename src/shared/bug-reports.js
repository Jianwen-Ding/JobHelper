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

/**
 * What an image's first bytes say it is: 'png', 'jpeg', 'webp' or null.
 *
 * The same test ResumeM-M makes (src/server/bug-reports.ts), made here first.
 * A file's type comes from its name, and a JPEG saved as `.png` — which is
 * what a lot of screenshot tools do — was stored here as PNG, refused by the
 * server with a 400, and kept in the browser for ever as a report that could
 * be neither sent nor cleared.
 */
export function imageKind(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length >= 8 && png.every((n, i) => b[i] === n)) return 'png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpeg';
  const ascii = (from, to) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return null;
}

/** The first bytes of a base64 data URL, without decoding the rest. */
function leadingBytes(base64) {
  try {
    const head = atob(base64.slice(0, 24));
    return Uint8Array.from(head, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

const SCREENSHOT = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** Whether a screenshot is what it says it is, as the server will judge it. */
export function screenshotIsValid(image) {
  const match = typeof image === 'string' && SCREENSHOT.exec(image);
  return Boolean(match) && imageKind(leadingBytes(match[2])) === match[1];
}

/**
 * Whether the server has turned this report down for good.
 *
 * A 4xx is the server reading the report and refusing it — its own check of
 * the screenshots, or a server from before this endpoint answering 404 — and
 * sending the same report again gets the same answer. Anything else (not
 * running, a 5xx) may yet go through.
 */
export const refused = (report) => typeof report?.syncStatus === 'number' && report.syncStatus >= 400 && report.syncStatus < 500;

export async function listBugReports() {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored).filter(([key]) => key.startsWith(PREFIX)).map(([, report]) => report)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Remove a report's browser copy.
 *
 * Only once the file inbox holds it, unless `discard` says the person has
 * been asked and wants it gone anyway. A report the server will never take
 * was otherwise kept for ever, and at up to 5.6MB each two of them fill the
 * whole of `storage.local` — after which nothing else can be saved either.
 */
export async function clearBugReport(id, { discard = false } = {}) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid report ID.');
  const key = PREFIX + id;
  const report = (await chrome.storage.local.get(key))[key];
  if (!report) return { cleared: true };
  if (!report.receipt && !discard) throw new Error('Copy this report to the file inbox before clearing its browser copy.');
  await chrome.storage.local.remove(key);
  return { cleared: true, discarded: !report.receipt };
}

export async function syncBugReport(id, serverFetch) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid report ID.');
  const key = PREFIX + id;
  const report = (await chrome.storage.local.get(key))[key];
  if (!report) throw new Error('That report is not in this browser.');
  if (report.receipt) return report;
  try {
    const receipt = await serverFetch('/api/bug-reports', { method: 'POST', body: JSON.stringify(report) });
    const kept = { ...report, receipt, syncError: null, syncStatus: null };
    await chrome.storage.local.set({ [key]: kept });
    return kept;
  } catch (error) {
    const kept = { ...report, syncError: error.message, syncStatus: typeof error?.status === 'number' ? error.status : null };
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
  if (!screenshots.every(screenshotIsValid)) {
    throw new Error('One of the screenshots is not the PNG, JPEG or WebP image its name says. Remove it and add it again.');
  }
  const report = { id: crypto.randomUUID(), text: text.trim(), screenshots, createdAt: new Date().toISOString(),
    version: chrome.runtime.getManifest().version, extensionBuild: await extensionBuild(), receipt: null };
  // First durable write succeeds even when ResumeM-M is unreachable.
  try {
    await chrome.storage.local.set({ [PREFIX + report.id]: report });
  } catch (error) {
    if (/quota/i.test(error?.message ?? '')) {
      throw new Error('Browser storage for reports is full. Delete reports below that were never copied to the inbox, then save again.');
    }
    throw error;
  }
  return syncBugReport(report.id, serverFetch);
}
