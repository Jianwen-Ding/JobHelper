/**
 * The service worker owns every call to the ResumeM-M server. Content scripts
 * run in the page's origin, so routing requests through here keeps loopback
 * traffic out of the page's reach and gives one place to report a server that
 * is not running.
 */

import { DEFAULTS, getSettings } from '../shared/config.js';

async function serverFetch(path, options = {}) {
  const { serverUrl } = await getSettings();
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    });
  } catch (cause) {
    throw new Error(
      `Can't reach ResumeM-M at ${serverUrl}. Start it with \`npm run serve\` in the ResumeM-M folder.`,
      { cause },
    );
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/** Message handlers, one per action the content script or popup can request. */
const handlers = {
  async ping() {
    const { serverUrl } = await getSettings();
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
    return res.json();
  },

  /**
   * Whether AI is actually in play, which two switches decide: this extension's
   * `useAi`, and `ai.enabled` on the ResumeM-M server. Either one off means
   * nothing is sent to an AI — and the case where they disagree is the one
   * worth naming, since flipping the extension's switch alone does nothing.
   */
  async aiStatus() {
    const { useAi, serverUrl } = await getSettings();
    let server;
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
      server = await res.json();
    } catch {
      return { active: false, useAi, reachable: false, serverEnabled: false, state: 'offline' };
    }

    // Older servers do not report it; treat unknown as off rather than
    // claiming an AI is running when we cannot tell.
    const serverEnabled = Boolean(server?.ai?.enabled);
    const state = !useAi ? 'off' : serverEnabled ? 'on' : 'server-off';
    return {
      active: state === 'on',
      state,
      useAi,
      reachable: true,
      serverEnabled,
      command: server?.ai?.command,
    };
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    await chrome.storage.sync.set(patch);
    return getSettings();
  },

  async listResumes() {
    return serverFetch('/api/resumes');
  },

  /**
   * Analyse a page and get back a proposed tailored resume spec.
   *
   * `useAi` may be passed per call, which is how the card offers "build from
   * the base" and "let the AI decide what to change" as two deliberate
   * choices rather than one hidden setting. Omitted, it falls back to the
   * stored preference.
   */
  async analyze({ url, title, html, useAi }) {
    const settings = await getSettings();
    return serverFetch('/api/extension/analyze', {
      method: 'POST',
      body: JSON.stringify({
        url,
        title,
        html,
        baseResumeId: settings.baseResumeId,
        useAi: typeof useAi === 'boolean' ? useAi : settings.useAi,
      }),
    });
  },

  /** Compile a proposed spec so the user can look at it before committing. */
  async render({ spec }) {
    const result = await serverFetch('/api/render', {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absolutePdfUrl: `${serverUrl.replace(/\/$/, '')}${result.pdfUrl}` };
  },

  /**
   * Re-tailor with the user's own words folded in. Feedback goes to the AI
   * path because a sentence of intent is exactly what tag matching cannot use.
   */
  async refine({ spec, feedback, job }) {
    return serverFetch('/api/ai/tailor', {
      method: 'POST',
      body: JSON.stringify({
        resumeId: spec.extends ?? spec.id,
        job: { ...job, jobDescription: `${job.jobDescription}\n\n## The applicant's instructions\n${feedback}` },
      }),
    });
  },

  /** Save a phrasing the user accepted from a suggestion. */
  async addVariant({ entryId, bulletId, variant }) {
    return serverFetch(`/api/entries/${encodeURIComponent(entryId)}/bullets/${encodeURIComponent(bulletId)}/variants`, {
      method: 'POST',
      body: JSON.stringify({ ...variant, suggested: true }),
    });
  },

  /** Write the application folder and record it in the tracker. */
  async bundle(payload) {
    return serverFetch('/api/applications/bundle', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /**
   * Fetch a compiled PDF as bytes, so the card can draw it on the page it is
   * sitting on. The fetch has to happen here: a job board served over https
   * cannot pull http://127.0.0.1 itself, and the whole point is not to send
   * the user to another tab to look at their own resume.
   */
  async pdfBytes({ url }) {
    const { serverUrl } = await getSettings();
    const absolute = url.startsWith('http') ? url : `${serverUrl.replace(/\/$/, '')}${url}`;
    const res = await fetch(absolute);
    if (!res.ok) throw new Error(`Could not load the PDF (${res.status})`);

    // Messaging is JSON, so the bytes travel as base64. A one-page resume is
    // ~30KB, which is nothing; chunked to keep the argument list sane.
    const buffer = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 8192) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    }
    return { base64: btoa(binary) };
  },

  async autofillData() {
    return serverFetch('/api/autofill');
  },

  /** Pair page questions with whatever the answer bank already holds. */
  async matchAnswers({ questions }) {
    return serverFetch('/api/answers/match', {
      method: 'POST',
      body: JSON.stringify({ questions }),
    });
  },

  /** Answer one question, reusing a stored answer unless asked to redraft. */
  async answerQuestion({ question, force }) {
    return serverFetch('/api/ai/answer', {
      method: 'POST',
      body: JSON.stringify({ question, force }),
    });
  },

  async saveAnswer({ question, answer, itemId }) {
    return serverFetch('/api/answers/save', {
      method: 'POST',
      body: JSON.stringify({ question, answer, itemId }),
    });
  },

  /**
   * Draft a cover letter. The server returns the relevant previous letters
   * whether or not the AI runs, so there is always something to start from.
   */
  async coverLetter({ spec, job }) {
    return serverFetch('/api/ai/cover-letter', {
      method: 'POST',
      body: JSON.stringify({
        resumeId: spec.extends ?? spec.id,
        job: {
          jobTitle: job.title,
          company: job.company,
          jobDescription: job.description ?? '',
          url: job.url,
        },
      }),
    });
  },

  async saveLetter({ body, job }) {
    const id = `${new Date().toISOString().slice(0, 10)}-${(job.company ?? 'letter')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)}`;
    return serverFetch(`/api/letters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id,
        title: `${job.title ?? 'Role'} — ${job.company ?? 'Unknown'}`,
        company: job.company,
        role: job.title,
        createdAt: new Date().toISOString(),
        body,
      }),
    });
  },

  /**
   * Hand the application over to ResumeM-M and return a link straight to it.
   * A browser sidebar is fine for picking a resume and wrong for writing three
   * paragraphs; this is the door between the two.
   */
  async openWorkspace(payload) {
    const result = await serverFetch('/api/workspace', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absoluteUrl: `${serverUrl.replace(/\/$/, '')}${result.url}` };
  },

  /** Open the editor in a new tab, focused on this draft. */
  async openTab({ url }) {
    const tab = await chrome.tabs.create({ url });
    return { id: tab.id };
  },

  async trackStatus({ id, status, note }) {
    return serverFetch(`/api/applications/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, note }),
    });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message "${message?.type}"` });
    return false;
  }
  handler(message.payload ?? {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  // Keeps the message channel open for the async response above.
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults so the popup has something to show on first open.
  const current = await chrome.storage.sync.get(null);
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([k]) => !(k in current)),
  );
  if (Object.keys(missing).length > 0) await chrome.storage.sync.set(missing);
});
