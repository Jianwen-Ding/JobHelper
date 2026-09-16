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
    const url = location.href;

    // Deliberately not `documentElement.innerHTML`: serialising a few
    // megabytes of DOM to regex-test it is the most expensive thing this
    // script could do, and it runs on every page you visit. The JSON-LD blocks
    // are the only part that matters, and they can be read directly.
    for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (/"@type"\s*:\s*"?JobPosting/i.test(tag.textContent ?? '')) {
        score += 6;
        break;
      }
    }
    if (/\b(greenhouse|lever|workday|myworkdayjobs|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite)\b/i.test(url)) {
      score += 4;
    }
    if (/\/(jobs?|careers?|opening|position|apply)(\/|$|\?)/i.test(url)) score += 1;

    // `textContent`, not `innerText`: the latter forces a full layout to work
    // out what is visible, which is a lot to pay for a keyword count.
    const text = (document.body?.textContent ?? '').toLowerCase().slice(0, 60_000);
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
    const { findQuestions, isRequired } = await imports.autofill();
    const found = findQuestions().map((q) => ({ ...q, required: isRequired(q.fieldId) }));
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

      /** For a question typed in by hand, when the page did not expose it. */
      case 'matchAnswers':
        return send('matchAnswers', payload);

      /** The compiled resume, as bytes, so the card can show it in place. */
      case 'pdfBytes':
        return send('pdfBytes', payload);

      case 'autofill':
        return runAutofill();

      case 'insertAnswer': {
        const { insertAnswer } = await imports.autofill();
        return insertAnswer(payload.fieldId, payload.text);
      }

      case 'coverLetter':
        return send('coverLetter', { spec: payload.spec, job: analysis.job });

      /**
       * Hand the whole application to the editor: what the form asks for, the
       * resume already tailored, and the questions with whatever the bank
       * covers. Then open it, because the point is to go there and write.
       */
      case 'openWorkspace': {
        const { wantsCoverLetter } = await imports.autofill();
        const result = await send('openWorkspace', {
          company: analysis.job.company ?? 'Unknown',
          role: analysis.job.title ?? 'Unknown role',
          url: location.href,
          source: new URL(location.href).hostname,
          jobDescription: analysis.job.description ?? '',
          spec: payload.spec,
          coverLetterRequired: wantsCoverLetter(),
          questions: (payload.questions ?? []).map((q) => ({ question: q.question, required: q.required })),
        });
        await send('openTab', { url: result.absoluteUrl });
        return result;
      }

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
        analysis = await send('analyze', { ...pagePayload(), useAi: Boolean(payload.useAi) });
        cardHandle?.update(analysis);
        return analysis;
      }

      /**
       * Rebuild the proposal from the base, either by tag matching or by
       * asking the AI what to change. Same endpoint, one deliberate flag —
       * so the two paths cannot drift apart.
       */
      case 'rebuild': {
        analysis = await send('analyze', { ...pagePayload(), useAi: Boolean(payload.useAi) });
        cardHandle?.update(analysis);
        return analysis;
      }

      case 'aiStatus':
        return send('aiStatus', {});

      default:
        throw new Error(`Unknown card action "${action}"`);
    }
  }

  /**
   * The same payload, taken when the browser is idle. Serialising a few
   * megabytes of DOM is the one genuinely expensive thing this script does,
   * and doing it during load is what a user feels as a stutter.
   */
  function pagePayloadIdle() {
    return new Promise((resolve) => {
      const take = () => resolve(pagePayload());
      if (typeof requestIdleCallback === 'function') requestIdleCallback(take, { timeout: 1500 });
      else setTimeout(take, 0);
    });
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

  /**
   * Put the card up, then fill it in.
   *
   * This used to await everything — the analysis, the resume list, the
   * questions — before anything appeared, so a slow server (or the AI, which
   * can take minutes) meant a page that sat there looking stuck. Nothing about
   * that wait belonged in front of the first paint: the local score already
   * decided this is a posting worth offering, so the card goes up on that,
   * shows what it is doing, and each answer lands as it arrives.
   */
  async function show({ force = false } = {}) {
    const settings = await send('getSettings');
    if (!force) {
      if (!settings.autoPrompt) return;
      if ((settings.mutedHosts ?? []).includes(location.hostname)) return;
      if (localScore() < settings.minScore) return;
    }

    const [{ createCard, removeCard }, { wantsCoverLetter }] = await Promise.all([
      imports.card(),
      imports.autofill(),
    ]);

    // What the page asks for decides what the card offers. Asking the user
    // "does this need a cover letter?" is asking them to read the form on the
    // extension's behalf, when the form is right there to be read.
    cardHandle = createCard({
      analysis: null,
      resumes: [],
      settings,
      questions: [],
      needsCoverLetter: wantsCoverLetter(),
      onAction,
    });

    /*
     * The automatic pass is always the deterministic one. Tag matching takes
     * milliseconds; the AI takes seconds to minutes, and running it before the
     * user has even seen the posting's proposal is spending their time on a
     * guess they did not ask for. "Let the AI tailor it" is a button.
     */
    try {
      analysis = await send('analyze', { ...(await pagePayloadIdle()), useAi: false });
    } catch (err) {
      cardHandle?.setStatus(err.message);
      return;
    }

    if (!analysis.isJobPosting && !force) {
      removeCard();
      cardHandle = null;
      return;
    }
    cardHandle?.update(analysis);

    /*
     * If the user asked for AI tailoring, it runs now — after the
     * deterministic proposal is on screen, with the card's progress bar
     * showing. Never before: waiting minutes at a blank page for a guess
     * nobody has seen yet is the behaviour this replaced.
     */
    if (settings.useAi) {
      const ai = await send('aiStatus', {}).catch(() => null);
      if (ai?.active) cardHandle?.tailorWithAi();
    }

    // The rest arrives in its own time, each piece landing as it is ready.
    send('listResumes')
      .then((resumes) => cardHandle?.setResumes(resumes))
      .catch(() => undefined);
    gatherQuestions()
      .then((questions) => cardHandle?.setQuestions(questions))
      .catch(() => undefined);
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

  /*
   * Single-page job boards swap postings without a navigation, so the card has
   * to notice the url changing. This used to be a MutationObserver over the
   * whole document, which wakes on every DOM change a busy board makes — an
   * enormous number of callbacks to answer one question. Checking the url on a
   * slow interval costs nothing and answers it exactly as well.
   */
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    (async () => {
      const { removeCard } = await imports.card();
      removeCard();
      cardHandle = null;
      show().catch(() => {});
    })();
  }, 1000);

  show().catch((err) => {
    // A missing server must not spam every page the user opens.
    console.debug('[JobHelper]', err.message);
  });
})();
