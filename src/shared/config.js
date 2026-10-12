/**
 * Settings shared by the popup, the service worker, and the content script.
 * The extension is a thin client: everything that knows about resumes lives in
 * the ResumeM-M server, which runs on the user's own machine.
 */

export const DEFAULTS = {
  /** Where ResumeM-M is listening. Loopback only — the server has no auth. */
  serverUrl: 'http://127.0.0.1:4600',
  /** Resume each tailored version is copied from. */
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
  /*
   * Without a fragment or a query, which nothing can be appended after.
   *
   * The address people have to hand is the editor's, from its address bar —
   * `http://127.0.0.1:4600/#resumes/newgrad` — and every request is this plus
   * `/api/…`, which put the path inside the fragment: measured, the request
   * for the resume list was built as
   * `http://127.0.0.1:4600/#resumes/newgrad/api/resumes`. A fragment is never
   * sent, so that is a request for the editor's own page, which answers with
   * HTML — and `serverFetch` reports "ResumeM-M sent something that is not
   * JSON (200)" about a server that is running. A query does the same with a
   * `?`. A path is still kept, for the reason above.
   */
  return full.replace(/[?#].*$/, '').replace(/\/+$/, '');
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

/*
 * Pairing with ResumeM-M.
 *
 * ResumeM-M used to answer every browser extension, so anything installed in
 * the browser could read the whole resume store. Now it answers an extension
 * only once it has been paired: the editor shows a short code, the popup
 * sends it back, and the server hands over a token that goes on every request
 * from then on.
 *
 * Kept in `chrome.storage.local`, not `sync`: the token is for the ResumeM-M on
 * this computer, and another computer signed in to the same browser profile
 * has its own. Kept per server address, so pointing the popup at a second
 * ResumeM-M does not send it the first one's token.
 */
export const PAIRING_KEY = 'rmmPairing';
export const PAIR_HEADER = 'X-RMM-Pair';

/** Where somebody pairs, and what to tell them. */
export const NOT_PAIRED_MESSAGE =
  'JobHelper is not paired with ResumeM-M yet. Open ResumeM-M → Save & Files → Pair JobHelper, ' +
  'and enter the code in JobHelper’s popup.';

const serverKey = (serverUrl) => {
  try {
    return new URL(normaliseServerUrl(serverUrl)).origin;
  } catch {
    return null;
  }
};

export async function pairingToken(serverUrl) {
  const key = serverKey(serverUrl);
  if (!key) return null;
  try {
    const { [PAIRING_KEY]: all } = await chrome.storage.local.get(PAIRING_KEY);
    return typeof all?.[key] === 'string' ? all[key] : null;
  } catch {
    return null;
  }
}

export async function rememberPairing(serverUrl, token) {
  const key = serverKey(serverUrl);
  if (!key) return;
  const { [PAIRING_KEY]: all } = await chrome.storage.local.get(PAIRING_KEY);
  const next = { ...(all ?? {}) };
  if (token) next[key] = token;
  else delete next[key];
  await chrome.storage.local.set({ [PAIRING_KEY]: next });
}

/** The header that says this is the paired JobHelper, when it is. */
export async function pairingHeaders(serverUrl) {
  const token = await pairingToken(serverUrl);
  return token ? { [PAIR_HEADER]: token } : {};
}
