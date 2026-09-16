/**
 * Content script entry point.
 *
 * Runs on every page, so the first job is to be quiet: score the page locally,
 * with no network call at all, and only reach for the server when the page
 * really looks like a job posting. The card is never shown on a muted host.
 */

(async () => {
  const send = (type, payload) =>
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response?.error ?? 'No response from JobHelper'));
        } else {
          resolve(response.data);
        }
      });
    });

  const imports = {
    card: () => import(chrome.runtime.getURL('src/content/card.js')),
    autofill: () => import(chrome.runtime.getURL('src/content/autofill.js')),
  };

  /**
   * Local, cheap confidence that this is a job posting. Mirrors the server's
   * scorer, but runs without sending anything anywhere — the page only leaves
   * the browser once this clears the threshold.
   */
  function localScore() {
    let score = 0;
    const html = document.documentElement.innerHTML;
    const url = location.href;

    if (/"@type"\s*:\s*"?JobPosting/i.test(html)) score += 6;
    if (/\b(greenhouse|lever|workday|myworkdayjobs|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite)\b/i.test(url)) {
      score += 4;
    }
    if (/\/(jobs?|careers?|opening|position|apply)(\/|$|\?)/i.test(url)) score += 1;

    const text = (document.body?.innerText ?? '').toLowerCase().slice(0, 60_000);
    const signals = [
      'apply now', 'job description', 'responsibilities', 'qualifications',
      "what you'll do", 'minimum qualifications', 'preferred qualifications',
      'equal opportunity employer', 'submit application', 'years of experience',
    ];
    for (const s of signals) if (text.includes(s)) score += 1;

    return score;
  }

  let cardHandle = null;
  let analysis = null;

  /** Page questions, paired with whatever the answer bank already holds. */
  async function gatherQuestions() {
    const { findQuestions } = await imports.autofill();
    const found = findQuestions();
    if (found.length === 0) return [];

    try {
      const { matches } = await send('matchAnswers', { questions: found.map((q) => q.question) });
      return found.map((q, i) => ({
        ...q,
        answer: matches[i]?.answer ?? '',
        confident: Boolean(matches[i]?.confident),
        score: matches[i]?.score ?? 0,
        itemId: matches[i]?.item?.id,
      }));
    } catch {
      // A server that is down must not cost us the questions themselves.
      return found.map((q) => ({ ...q, answer: '', confident: false, score: 0 }));
    }
  }

  async function runAutofill() {
    const { fillForm } = await imports.autofill();
    const data = await send('autofillData');
    return fillForm(data.fields);
  }

  async function onAction(action, payload = {}) {
    if (action.startsWith('answer:')) {
      return send('answerQuestion', payload);
    }

    switch (action) {
      case 'render':
        return send('render', payload);

      case 'refine':
        return send('refine', { ...payload, job: analysis.job });

      case 'addVariant':
        return send('addVariant', payload);

      case 'autofill':
        return runAutofill();

      case 'insertAnswer': {
        const { insertAnswer } = await imports.autofill();
        return insertAnswer(payload.fieldId, payload.text);
      }

      case 'coverLetter':
        return send('coverLetter', { spec: payload.spec, job: analysis.job });

      case 'saveLetter':
        return send('saveLetter', { body: payload.body, job: analysis.job });

      case 'saveAnswer':
        return send('saveAnswer', payload);

      case 'trackStatus':
        return send('trackStatus', payload);

      case 'bundle':
        return send('bundle', {
          spec: payload.spec,
          resumeId: payload.spec.id,
          company: analysis.job.company ?? 'Unknown',
          role: analysis.job.title ?? 'Unknown role',
          url: location.href,
          source: new URL(location.href).hostname,
          status: 'applied',
          coverLetter: payload.coverLetter,
          answers: payload.answers,
        });

      case 'setBase': {
        await send('setSettings', { patch: { baseResumeId: payload.baseResumeId } });
        analysis = await send('analyze', pagePayload());
        cardHandle?.update(analysis);
        return analysis;
      }

      default:
        throw new Error(`Unknown card action "${action}"`);
    }
  }

  function pagePayload() {
    return {
      url: location.href,
      title: document.title,
      // Cap the payload: some boards ship enormous inlined bundles, and the
      // posting itself is never in them.
      html: document.documentElement.outerHTML.slice(0, 2_000_000),
    };
  }

  async function show({ force = false } = {}) {
    const settings = await send('getSettings');
    if (!force) {
      if (!settings.autoPrompt) return;
      if ((settings.mutedHosts ?? []).includes(location.hostname)) return;
      if (localScore() < settings.minScore) return;
    }

    analysis = await send('analyze', pagePayload());
    if (!analysis.isJobPosting && !force) return;

    const [resumes, questions, { createCard }] = await Promise.all([
      send('listResumes'),
      gatherQuestions(),
      imports.card(),
    ]);
    cardHandle = createCard({ analysis, resumes, settings, questions, onAction });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'show-card') {
      show({ force: true })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (message?.type === 'autofill') {
      runAutofill()
        .then((report) => sendResponse({ ok: true, data: report }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  });

  // Single-page job boards swap postings without a navigation, so re-check on
  // URL change rather than only at load.
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    (async () => {
      const { removeCard } = await imports.card();
      removeCard();
      cardHandle = null;
      show().catch(() => {});
    })();
  }).observe(document, { subtree: true, childList: true });

  show().catch((err) => {
    // A missing server must not spam every page the user opens.
    console.debug('[JobHelper]', err.message);
  });
})();
