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
    trail: () => import(chrome.runtime.getURL('src/shared/trail.js')),
  };

  /**
   * Local, cheap confidence that this page has anything to do with applying
   * for a job. Mirrors the server's classifier, but runs without sending
   * anything anywhere — the page only leaves the browser once this clears the
   * threshold.
   *
   * Deliberately generous. The cost of offering on a page that turns out not
   * to be a job is a card in the corner that gets dismissed; the cost of
   * staying quiet on one that is, is the whole tool not being there when it
   * was needed. An application form is the case that used to be missed
   * entirely: it describes nothing, so it scored nothing, and it is exactly
   * the page where the questions live.
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
    if (/\b(greenhouse|lever|workday|myworkdayjobs|ashby|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|jazzhr|successfactors|brassring)\b/i.test(url)) {
      score += 4;
    }
    if (/\b(indeed|linkedin|glassdoor|monster|ziprecruiter|dice|wellfound|otta|builtin|simplyhired|seek)\b/i.test(url)) {
      score += 3;
    }
    if (/\/(jobs?|careers?|opening|openings|position|positions|vacanc(y|ies)|apply|application|hiring|req|requisition)(\/|$|[?#])/i.test(url)) {
      score += 2;
    }

    // `textContent`, not `innerText`: the latter forces a full layout to work
    // out what is visible, which is a lot to pay for a keyword count.
    const text = (document.body?.textContent ?? '').toLowerCase().slice(0, 60_000);

    const described = [
      'apply now', 'job description', 'responsibilities', 'qualifications',
      "what you'll do", 'what you will do', 'minimum qualifications', 'preferred qualifications',
      'equal opportunity employer', 'submit application', 'years of experience',
      'about the role', 'we are looking for', "we're looking for", 'join our team',
      'requirements', 'benefits', 'compensation', 'salary range',
      'full-time', 'part-time', 'internship', 'new grad', 'employment type', 'requisition',
    ].filter((w) => text.includes(w)).length;
    if (described) score += Math.min(described, 5);

    const formish = [
      'upload your resume', 'attach your resume', 'attach resume', 'upload resume', 'upload cv',
      'cover letter', 'work authorization', 'require sponsorship',
      'voluntary self-identification', 'submit application', 'why do you want',
    ].filter((w) => text.includes(w)).length;
    if (formish) score += Math.min(formish, 4);

    // A file input beside the word résumé is the clearest sign there is that a
    // form is in front of you, and it costs one selector.
    if (document.querySelector('input[type=file]') && /\b(resum|cv)\b/i.test(text)) score += 3;

    const listish = [
      'open positions', 'open roles', 'all jobs', 'job openings', 'search jobs',
      'results found', 'jobs found', 'view all openings',
    ].filter((w) => text.includes(w)).length;
    if (listish) score += Math.min(listish, 3);

    // A hiring thread on a forum is a job page in the sense that matters.
    if (/\b(news\.ycombinator|reddit|lobste\.rs|discourse|forum|stackexchange|blind)\b/i.test(url)
        && /\b(hiring|who is hiring|looking for)\b/.test(text)) {
      score += 3;
    }

    const against = ['add to cart', 'checkout', 'page not found', 'sign in to continue']
      .filter((w) => text.includes(w)).length;
    if (against) score -= Math.min(against * 2, 6);

    return score;
  }

  let cardHandle = null;
  let analysis = null;

  /**
   * Which pass owns the card.
   *
   * A pass is long: the analysis alone can take seconds, and on a single-page
   * board the url can change three times while one is still in flight. Every
   * piece of that pass then lands on whatever card happens to exist — a card
   * built for a different posting — and the page it was reading gets recorded
   * as part of the new application. Nothing about it looks wrong: the card
   * shows a role, the trail shows pages, and both belong to the job you left.
   *
   * So each pass takes a number, and anything superseded drops what it was
   * carrying instead of writing it somewhere it no longer belongs.
   */
  let pass = 0;
  const supersede = () => ++pass;

  /**
   * Whether a form in a sub-frame asked for a cover letter.
   *
   * Remembered because it is learnt from the scan, well after the card has
   * gone up, and it is wanted again later — when the application is handed to
   * the editor, which needs to know whether a letter is part of it.
   */
  let letterInFrame = false;

  /** The questions on this page, wherever on it they are. */
  async function findEverywhere() {
    const { findQuestions, isRequired } = await imports.autofill();
    const here = findQuestions().map((q) => ({ ...q, required: isRequired(q.fieldId) }));

    const { frames } = await send('scanFrames', {}).catch(() => ({ frames: [] }));
    const elsewhere = frames.flatMap((frame) =>
      (frame.questions ?? []).map((q) => ({ ...q, fieldId: inFrameId(frame.frameId, q.fieldId) })),
    );
    letterInFrame = letterInFrame || frames.some((f) => f.wantsLetter);
    return { questions: [...here, ...elsewhere], wantsLetter: letterInFrame };
  }

  /** Page questions, paired with whatever the answer bank already holds. */
  async function gatherQuestions() {
    const { questions: found, wantsLetter } = await findEverywhere();
    if (found.length === 0) return { questions: [], wantsLetter };

    try {
      const { matches } = await send('matchAnswers', { questions: found.map((q) => q.question) });
      return {
        wantsLetter,
        questions: found.map((q, i) => ({
          ...q,
          answer: matches[i]?.answer ?? '',
          confident: Boolean(matches[i]?.confident),
          score: matches[i]?.score ?? 0,
          itemId: matches[i]?.item?.id,
        })),
      };
    } catch {
      // A server that is down must not cost us the questions themselves.
      return { wantsLetter, questions: found.map((q) => ({ ...q, answer: '', confident: false, score: 0 })) };
    }
  }

  /**
   * Fill this document, then every sub-frame, and report the lot as one.
   *
   * The form is frequently not in the page the card is sitting on: iCIMS
   * serves its whole application in an iframe, and so do embedded Greenhouse
   * boards. Filling only the top document meant the button said it had done
   * the form and nothing in the form had changed.
   */
  async function runAutofill() {
    const { fillForm } = await imports.autofill();
    const data = await send('autofillData');
    const here = fillForm(data.fields);

    const { frames } = await send('fillFrames', { fields: data.fields }).catch(() => ({ frames: [] }));
    return {
      filled: [...here.filled, ...frames.flatMap((f) => f.filled ?? [])],
      skipped: [...here.skipped, ...frames.flatMap((f) => f.skipped ?? [])],
    };
  }

  /**
   * A field's address, when it may not be in this document.
   *
   * The card only ever holds a string, so the frame it lives in travels inside
   * the id. The top document is left bare, which keeps every existing stored
   * answer and every field found here exactly as it was.
   */
  const IN_FRAME_ID = /^f(\d+)~(.+)$/;
  const inFrameId = (frameId, fieldId) => `f${frameId}~${fieldId}`;

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
        const inFrame = IN_FRAME_ID.exec(payload.fieldId ?? '');
        if (inFrame) {
          return send('insertInFrame', {
            frameId: Number(inFrame[1]),
            fieldId: inFrame[2],
            text: payload.text,
          });
        }
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
          // Including a letter box that is in a frame rather than this page.
          coverLetterRequired: wantsCoverLetter() || letterInFrame,
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
        analysis = await send('analyze', { ...(await applicationPayload()), useAi: Boolean(payload.useAi) });
        cardHandle?.update(analysis);
        return analysis;
      }

      /**
       * Rebuild the proposal from the base, either by tag matching or by
       * asking the AI what to change. Same endpoint, one deliberate flag —
       * so the two paths cannot drift apart.
       */
      case 'rebuild': {
        analysis = await send('analyze', { ...(await applicationPayload()), useAi: Boolean(payload.useAi) });
        cardHandle?.update(analysis);
        return analysis;
      }

      case 'aiStatus':
        return send('aiStatus', {});

      // Turning ResumeM-M's own AI switch on, from the chip that reports it
      // being off. The switch that needs flipping should be under the hand
      // that is reaching for it.
      case 'setAiEnabled':
        return send('setAiEnabled', { enabled: Boolean(payload.enabled) });

      /** The pages of this application, and the two ways to correct them. */
      case 'forgetPage':
        return send('forgetPage', { url: payload.url });

      case 'clearTrail':
        return send('clearTrail', {});

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
      const take = () => pagePayload().then(resolve);
      if (typeof requestIdleCallback === 'function') requestIdleCallback(take, { timeout: 1500 });
      else setTimeout(take, 0);
    });
  }

  /**
   * The page, cut down to the part a posting could be in.
   *
   * What gets sent is script bundles, analytics payloads and state dumps —
   * measured at 4.6MB for one page of a board that inlines its bundle, versus
   * 9KB once the markup that cannot hold a job description is dropped. And
   * every one of those megabytes is serialised twice: once to cross into the
   * service worker, once again into the request body. The server strips the
   * same tags on arrival, so nothing is lost by doing it here, where it is
   * the difference between a page that stutters and one that does not.
   */
  async function pagePayload() {
    const { trimForStorage } = await imports.trail();
    return {
      url: location.href,
      title: document.title,
      html: trimForStorage(document.documentElement.outerHTML, 2_000_000),
    };
  }

  /**
   * The same payload, plus every earlier page of this application.
   *
   * The description you read and the form you are filling in are usually two
   * pages on two hosts, and the questions are on the second one. Sending only
   * the page in front of you is why a cover letter written from an application
   * form had nothing to say.
   */
  async function applicationPayload() {
    const here = await pagePayloadIdle();
    // Which pages belong is settled before anything is read, from where this
    // page is and where it was reached from — never from the merged result,
    // which would then be deciding its own inputs.
    const trail = await send('trailPages', { page: pageIdentity() }).catch(() => ({ pages: [] }));

    const earlier = (trail.pages ?? []).filter((p) => p.url !== here.url && p.html);
    return { ...here, pages: [...earlier, here] };
  }

  /** Who this page is, as far as belonging to an application goes. */
  function pageIdentity() {
    let referrerHost;
    try {
      referrerHost = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : undefined;
    } catch {
      referrerHost = undefined;
    }
    return { url: location.href, title: document.title, referrerHost };
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
    const mine = supersede();
    const current = () => pass === mine;

    const settings = await send('getSettings');
    if (!current()) return;
    if (!force) {
      if (!settings.autoPrompt) return;
      if ((settings.mutedHosts ?? []).includes(location.hostname)) return;
      if (localScore() < settings.minScore) return;
    }

    const [{ createCard, removeCard }, { wantsCoverLetter }] = await Promise.all([
      imports.card(),
      imports.autofill(),
    ]);
    if (!current()) return;

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
    let found;
    try {
      const payload = await applicationPayload();
      if (!current()) return;
      found = await send('analyze', { ...payload, useAi: false });
    } catch (err) {
      if (current()) cardHandle?.setStatus(err.message);
      return;
    }
    if (!current()) return;
    analysis = found;

    if (!analysis.isJobPosting && !force) {
      removeCard();
      cardHandle = null;
      return;
    }
    cardHandle?.update(analysis);

    /*
     * Whatever was built on the page before this one. Restored before the AI
     * is offered anything to do, so a resume that was already tailored is on
     * screen rather than being quietly rebuilt from scratch.
     */
    const carried = await send('takeWork', { page: pageIdentity() }).catch(() => ({ work: null }));
    if (!current()) return;
    if (carried?.work) cardHandle?.restoreWork(carried.work);

    // Taken once, and already trimmed: the same page is both what was just
    // analysed and what the next page will be written from.
    const trimmed = await pagePayload();
    if (!current()) return;

    /*
     * This page is now part of an application. Remembering it is what lets the
     * next page — usually the form, on a different host — be written from the
     * description you read here rather than from the form's own empty prose.
     */
    send('rememberPage', {
      page: {
        ...pageIdentity(),
        company: analysis.job?.company,
        kind: analysis.kind,
        html: trimmed.html.slice(0, 400_000),
      },
    })
      .then((trail) => current() && cardHandle?.setTrail(trail))
      .catch(() => undefined);

    /*
     * If the user asked for AI tailoring, it runs now — after the
     * deterministic proposal is on screen, with the card's progress bar
     * showing. Never before: waiting minutes at a blank page for a guess
     * nobody has seen yet is the behaviour this replaced.
     */
    /*
     * Also when the last page was tailored by the AI, whatever the global
     * setting says: arriving at the form with more of the posting read than
     * when the AI last looked is exactly the moment to look again. The carried
     * proposal stays on screen meanwhile, so nothing appears to be lost while
     * it thinks.
     */
    if (settings.useAi || carried?.work?.builtWith === 'ai') {
      const ai = await send('aiStatus', {}).catch(() => null);
      if (!current()) return;
      if (ai?.active) cardHandle?.tailorWithAi();
    }

    // The rest arrives in its own time, each piece landing as it is ready.
    send('listResumes')
      .then((resumes) => current() && cardHandle?.setResumes(resumes))
      .catch(() => undefined);
    gatherQuestions()
      .then(({ questions, wantsLetter }) => {
        if (!current()) return;
        cardHandle?.setQuestions(questions);
        // A form served in a frame could not be read when the card went up.
        cardHandle?.setNeedsCoverLetter(wantsLetter);
      })
      .catch(() => undefined);
  }

  /* ---------------- Keeping the work across a navigation ---------------- */

  /**
   * A link that plainly means "apply", clicked.
   *
   * The referrer is the usual way one page knows it came from another, and it
   * is absent often enough to be unreliable: rel="noreferrer", a strict
   * referrer policy, and every Apply button that opens a new tab. The click
   * itself is better evidence and it is available earlier, so it is what gets
   * recorded. Capture phase, because a board's own handler may well cancel the
   * event and route the page itself.
   */
  function watchForApplyClicks() {
    const MEANS_APPLY = /\b(apply|application|start (your )?application|submit (your )?application|continue to apply)\b/i;

    document.addEventListener(
      'click',
      (event) => {
        const link = event.target?.closest?.('a[href], button');
        if (!link) return;

        const href = link.getAttribute?.('href') ?? '';
        const label = (link.textContent ?? '').trim().slice(0, 80);
        if (!MEANS_APPLY.test(href) && !MEANS_APPLY.test(label)) return;

        let to = href;
        try {
          to = new URL(href, location.href).href;
        } catch {
          to = location.href; // a button, or a href this page will resolve itself
        }
        // Best effort by design: if this never arrives, the trail falls back
        // to the host and path rules, which are right most of the time.
        send('expectContinuation', { to }).catch(() => undefined);
      },
      true,
    );
  }

  /**
   * Keep what has been done here, so the next page of this application starts
   * where this one left off rather than from nothing.
   *
   * On an interval rather than on every change: the card has no change events
   * to subscribe to, saving is cheap, and the worst case of being a second
   * stale is losing the last keystroke of an answer — against the previous
   * behaviour, which was losing all of it.
   */
  function keepWorkSafe() {
    const save = async () => {
      const work = cardHandle?.takeWork?.();
      if (!work) return;

      // Nothing worth keeping is not worth sending. The worker refuses it too,
      // but a card with an empty state should not be asking in the first place.
      const { worthKeeping } = await imports.trail();
      if (!worthKeeping(work)) return;

      // The page is sent with it: a card left open on another posting must not
      // be able to write its work over this application's.
      send('saveWork', { work, page: pageIdentity() }).catch(() => undefined);
    };
    setInterval(save, 2000);
    // A navigation is exactly when this matters, and exactly when an interval
    // is least likely to have just run.
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') save();
    });
  }

  /* ------------------------ Frames other than this one ------------------ */

  /**
   * In a sub-frame, do nothing until asked.
   *
   * The script runs in every frame now, because on several systems — iCIMS
   * above all — the application form is served in an iframe and the page you
   * are looking at contains nothing but the iframe. But a frame is not a page:
   * it gets no card, analyses nothing, sends no page anywhere and remembers no
   * trail. It reads and fills the form it holds, when the top document asks,
   * and that is the whole of it.
   *
   * Which matters most for the frames that are not application forms. Every
   * advert and embed on every page now runs this too, and for all of them this
   * is where it stops.
   */
  if (window.top !== window) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const answer = (work) =>
        work
          .then((data) => sendResponse({ ok: true, data }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));

      switch (message?.type) {
        case 'jh-frame-scan':
          answer(
            imports.autofill().then(({ findQuestions, isRequired, wantsCoverLetter }) => ({
              questions: findQuestions().map((q) => ({ ...q, required: isRequired(q.fieldId) })),
              wantsLetter: wantsCoverLetter(),
            })),
          );
          return true;

        case 'jh-frame-fill':
          answer(imports.autofill().then(({ fillForm }) => fillForm(message.payload?.fields ?? {})));
          return true;

        case 'jh-frame-insert':
          answer(
            imports
              .autofill()
              .then(({ insertAnswer }) => insertAnswer(message.payload?.fieldId, message.payload?.text)),
          );
          return true;

        default:
          return false;
      }
    });

    // Say so once, so the top document can be told which frames to ask.
    send('frameReady', {}).catch(() => undefined);
    return;
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
    // Before the await, not after: the pass still running belongs to the url
    // that just went away, and it must stop being able to write to the card
    // from this instant rather than from whenever the import resolves.
    supersede();
    (async () => {
      const { removeCard } = await imports.card();
      removeCard();
      cardHandle = null;
      show().catch(() => {});
    })();
  }, 1000);

  watchForApplyClicks();
  keepWorkSafe();

  show().catch((err) => {
    // A missing server must not spam every page the user opens.
    console.debug('[JobHelper]', err.message);
  });
})();
