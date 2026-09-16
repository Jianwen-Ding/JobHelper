/**
 * Settings shared by the popup, the service worker, and the content script.
 * The extension is a thin client: everything that knows about resumes lives in
 * the ResumeM-M server, which runs on the user's own machine.
 */

export const DEFAULTS = {
  /** Where ResumeM-M is listening. Loopback only — the server has no auth. */
  serverUrl: 'http://127.0.0.1:4600',
  /** Resume the tailored version inherits from. */
  baseResumeId: 'newgrad',
  /**
   * Send the posting to the configured AI CLI as well as the local tag match.
   * Off by default: the deterministic match is free, instant, and usually right.
   */
  useAi: false,
  /** Show the card automatically, or wait to be asked from the toolbar. */
  autoPrompt: true,
  /**
   * Minimum local confidence before the card appears. The content script scores
   * a page cheaply before any network call, so ordinary browsing stays quiet.
   */
  minScore: 4,
  /** Hosts the user has told us to stay quiet on. */
  mutedHosts: [],
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}
