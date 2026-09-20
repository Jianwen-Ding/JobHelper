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
   *
   * Off by default. The local match is free and instant, but it is no longer
   * applied on its own: it arrives as a list of suggestions with every box
   * off, so the resume is the one you keep until you say otherwise. The AI is
   * the only thing that decides anything, and only when asked.
   */
  useAi: false,
  /** Show the card automatically, or wait to be asked from the toolbar. */
  autoPrompt: true,
  /**
   * Minimum local confidence before the card appears. The content script scores
   * a page cheaply before any network call, so ordinary browsing stays quiet.
   *
   * Deliberately low, and matched to the server's own floor. Being missed on a
   * page you were about to apply from costs more than a card you dismiss: an
   * application form describes nothing and used to score nothing, which is how
   * the tool managed to be absent at the exact moment it was wanted.
   */
  minScore: 3,
  /** Hosts the user has told us to stay quiet on. */
  mutedHosts: [],
};

/**
 * The server address, as something that can actually be fetched and opened.
 *
 * The box in the popup took whatever was typed and stored it verbatim, and
 * three ordinary slips each turned into a problem that pointed somewhere
 * else:
 *
 *   - `localhost:4600`, with no scheme, is what half of everyone types. It
 *     was stored as-is, every fetch failed, and the popup blamed the server:
 *     "ResumeM-M is not open. Start it, then try again." The server was open.
 *     The one instruction on screen could not work.
 *   - Clearing the box stored `""`. `chrome.storage.sync.get(DEFAULTS)`
 *     returns a stored value whenever the key is present, so `""` beats the
 *     default for ever — while the greyed-out placeholder reads exactly as
 *     though the default were in force.
 *   - And `""` reached `chrome.tabs.create`, so "Open editor" opened
 *     `chrome-error://chromewebdata/` rather than saying anything at all.
 *
 * Normalised on the way out rather than on the way in, because that repairs
 * the value somebody has already stored — no migration to run, and the worker
 * and the content script get the same answer as the popup.
 */
export function normaliseServerUrl(value) {
  const said = String(value ?? '').trim();
  if (!said) return DEFAULTS.serverUrl;
  // Loopback with no auth is what this talks to, so http is the right guess
  // for an address that did not say.
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(said) ? said : `http://${said}`;
  try {
    /*
     * And a scheme this can actually be fetched from.
     *
     * The test above only asks whether *a* scheme is there, so `ftp://…`,
     * `file:///etc/passwd`, `chrome://settings` and `ws://…` were all stored
     * as the server address. Every fetch then failed and the popup blamed a
     * server that was running — the same wrong diagnosis a missing scheme used
     * to produce — and worse, both buttons offering to fix it call
     * `chrome.tabs.create`, which rejects such a URL: "Open editor" became a
     * silent no-op, and the one in the status line closed the popup on its way
     * to doing nothing.
     */
    const { protocol } = new URL(full);
    if (protocol !== 'http:' && protocol !== 'https:') return DEFAULTS.serverUrl;
  } catch {
    // Not an address at all even with a scheme in front of it. The default is
    // somewhere real, which is worth more here than honouring a typo: every
    // caller of this fetches it or opens it in a tab.
    return DEFAULTS.serverUrl;
  }
  return full.replace(/\/+$/, '');
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const settings = { ...DEFAULTS, ...stored };
  return { ...settings, serverUrl: normaliseServerUrl(settings.serverUrl) };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
  return getSettings();
}
