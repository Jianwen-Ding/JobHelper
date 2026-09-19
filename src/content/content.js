/**
 * Content script entry point.
 *
 * Runs on every page, so the first job is to be quiet: score the page locally,
 * with no network call at all, and only reach for the server when the page
 * really looks like a job posting. The card is never shown on a muted host.
 */

(async () => {
  /* ------------------ Outliving the extension that started us ----------- */

  /*
   * A content script is not unloaded when its extension is reloaded, updated
   * or disabled. It goes on running in the page, with every `chrome.runtime`
   * call throwing "Extension context invalidated." — and it goes on running
   * its timers, so the throw repeats every second for as long as the tab is
   * open. That is what put a stream of uncaught errors into the console of an
   * ordinary page that has nothing to do with jobs.
   *
   * There is nothing to recover: this script belongs to an extension that no
   * longer exists, and the new one has already injected a fresh copy into
   * every page loaded since. So the only correct behaviour is to stop —
   * quietly, completely, and at the first sign.
   */
  let orphaned = false;
  const teardown = [];

  /** `chrome.runtime.id` is undefined once the context has gone. */
  function contextGone() {
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  class Orphaned extends Error {
    constructor() {
      super('JobHelper was reloaded; this copy has stopped.');
      this.name = 'Orphaned';
      // Nothing about this is worth showing: the page is fine, and a fresh
      // copy of the extension is already running everywhere it matters.
      this.quiet = true;
    }
  }

  function orphan() {
    if (orphaned) return;
    orphaned = true;
    for (const stop of teardown.splice(0)) {
      try {
        stop();
      } catch {
        // Tearing down is best effort by definition — half of what we are
        // holding belongs to an extension that has already gone.
      }
    }
  }

  /** Every timer this script starts, so orphaning can stop all of them. */
  const every = (ms, run) => {
    const id = setInterval(() => {
      if (orphaned || contextGone()) return orphan();
      Promise.resolve()
        .then(run)
        .catch((err) => quietly(err));
    }, ms);
    teardown.push(() => clearInterval(id));
    return id;
  };

  /** Swallow what the user cannot act on; log the rest once, at debug. */
  const quietly = (err) => {
    if (err?.quiet || orphaned) return;
    if (/context invalidated/i.test(err?.message ?? '')) return orphan();
    console.debug('[JobHelper]', err?.message ?? err);
  };

  const send = (type, payload) =>
    new Promise((resolve, reject) => {
      if (orphaned || contextGone()) {
        orphan();
        reject(new Orphaned());
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            const said = chrome.runtime.lastError.message ?? '';
            // Not "receiving end does not exist", which is an asleep service
            // worker and entirely normal; only the context actually going.
            if (/context invalidated/i.test(said)) {
              orphan();
              reject(new Orphaned());
              return;
            }
            reject(new Error(said));
          } else if (!response?.ok) {
            const failed = new Error(response?.error ?? 'No response from JobHelper');
            // What would put this right, when the worker knows.
            failed.jobhelper = response?.fix;
            reject(failed);
          } else {
            resolve(response.data);
          }
        });
      } catch (err) {
        // `sendMessage` throws synchronously once the context has gone.
        orphan();
        reject(new Orphaned());
        void err;
      }
    });

  /*
   * `chrome.runtime.getURL` throws the same way, and these are called from a
   * two-second timer — which is how one reload turned into an error every two
   * seconds for the life of the tab.
   */
  const fromExtension = (path) => {
    if (orphaned || contextGone()) {
      orphan();
      return Promise.reject(new Orphaned());
    }
    try {
      return import(chrome.runtime.getURL(path)).catch((err) => {
        if (contextGone()) {
          orphan();
          throw new Orphaned();
        }
        throw err;
      });
    } catch {
      orphan();
      return Promise.reject(new Orphaned());
    }
  };

  const imports = {
    card: () => fromExtension('src/content/card.js'),
    autofill: () => fromExtension('src/content/autofill.js'),
    trail: () => fromExtension('src/shared/trail.js'),
    sending: () => fromExtension('src/shared/sending.js'),
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
  /*
   * Evidence good enough to put the card up before the verdict comes back.
   *
   * Being on an applicant tracking system used to count, and it is not
   * evidence of anything: the page after you press submit is on one, so is a
   * board's own feed, so is a careers page with nothing open. On a
   * confirmation page the card therefore appeared at once and was withdrawn a
   * moment later — the flicker, on the one page where it is pure noise, and
   * on a slow machine it lingered long enough to read. The server's
   * classifier had already stopped believing the host for exactly this
   * reason; this side had not.
   *
   * Score cannot stand in for it. A confirmation page scores 7 and so does a
   * real application form; a real posting scores 5 and so do a salary page, a
   * careers landing page and a documentation page. There is no line to draw.
   *
   * What does separate them is whether the page is *about one role*, which is
   * the same question the server asks and can be asked here of the title
   * alone. "Platform Engineer at Helios" names a post. "Application submitted
   * — Acme" does not.
   */
  const ROLE_WORDS =
    /\b(engineer|developer|programmer|scientist|analyst|designer|manager|director|architect|administrator|consultant|specialist|technician|researcher|intern|internship|associate|coordinator|accountant|nurse|physician|teacher|professor|writer|editor|marketer|recruiter|counsel|attorney|paralegal|therapist|chef|driver|technologist|strategist|producer|operator|advisor|apprentice|fellow|lead|head of|officer|assistant|representative|agent)\b/i;
  const ENDS_WITH_ROLE = new RegExp(`${ROLE_WORDS.source}\\s*(?:\\b(?:i{1,3}|iv|v|\\d+)\\b\\s*)?$`, 'i');
  const LEADS_WITH_ROLE = /^(head|director|vp|vice president|chief|lead)\s+of\b/i;

  /** The page's own title for itself, before any "at Company" or " — Company". */
  function namesARole() {
    const heading = `${document.title ?? ''} ${document.querySelector('h1')?.textContent ?? ''}`;
    const named = heading.split(/\s+[–—|]\s+|\s+\bat\b\s+|,/)[0]?.trim() ?? '';
    return (
      named.split(/\s+/).length <= 8 &&
      (ENDS_WITH_ROLE.test(named) || LEADS_WITH_ROLE.test(named)) &&
      !/^(how|why|what|when|where|the|a|an|is|are|should|we|our|i|my|thanks|thank you)\b/i.test(named)
    );
  }

  function decisiveSignal() {
    for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (/"@type"\s*:\s*"?JobPosting/i.test(tag.textContent ?? '')) return true;
    }
    return namesARole();
  }

  /**
   * The words on the page, as a reader would see them.
   *
   * `document.body.textContent` includes the contents of every `<script>` tag,
   * and a modern board ships its posting inside one: a page showing nothing but
   * "Loading…" scored higher than most real postings, because its bundle
   * mentioned responsibilities, qualifications and "why do you want to work
   * here?". That is the false-positive machine — every single-page application
   * on the web carries text like that — and it also broke the pages it was
   * meant to help. The server strips scripts before classifying, so the two
   * disagreed: the extension judged a page worth reading, sent the stripped
   * version, and was told it was not a posting. That verdict then stood, and
   * the card never appeared when the posting actually arrived.
   *
   * A TreeWalker skipping those parents costs one pass over the text nodes,
   * against `innerText`, which forces a full layout for the same answer.
   */
  const UNREADABLE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS']);

  function readableText(limit = 60_000) {
    const root = document.body ?? document.documentElement;
    if (!root) return '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        UNREADABLE.has(node.parentNode?.nodeName ?? '') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let out = '';
    while (out.length < limit && walker.nextNode()) out += `${walker.currentNode.nodeValue} `;
    return out.toLowerCase().slice(0, limit);
  }

/**
   * Does this page ask who you are?
   *
   * The discriminator between a page that *is* an application and a page that
   * *talks about* applications — which turns out to be the whole false-positive
   * problem, and not the one I expected. A pull request on a repository about
   * job tooling, and a chat window discussing a cover letter, both carry the
   * vocabulary in quantity, and both have the furniture: one long textarea and
   * a file picker for attachments. Nothing separates them from an application
   * form by word count, because the words really are there.
   *
   * What separates them is that neither has any interest in your name. Every
   * application form ever written asks for it, usually beside an email address;
   * a comment box and a chat composer never do, because the site already knows
   * who you are. So the file-input signal — three points, the largest single
   * award here — is conditioned on an identity field being present.
   *
   * Structural rather than a list of hosts, deliberately. A blocklist of
   * github.com and the chat sites would fix the two cases reported and nothing
   * else, and would be wrong the moment somebody posts a job in a repository.
   */
  function asksWhoYouAre() {
    for (const field of document.querySelectorAll('input, textarea')) {
      const type = (field.getAttribute('type') ?? '').toLowerCase();
      if (type === 'email') return true;
      const how = `${field.name ?? ''} ${field.id ?? ''} ${field.getAttribute('placeholder') ?? ''} ` +
        `${field.getAttribute('aria-label') ?? ''} ${field.getAttribute('autocomplete') ?? ''}`;
      if (/\b(first|last|full|given|family)[\s_-]*name\b|\bname\b|\be-?mail\b/i.test(how)) return true;
    }
    // A label beside a field counts too: plenty of forms name nothing useful
    // on the input itself and put the words in a <label>.
    for (const label of document.querySelectorAll('label')) {
      if (!/^\s*(first |last |full |your )?(name|e-?mail)\b/i.test(label.textContent ?? '')) continue;
      const linked = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input');
      if (linked) return true;
    }
    return false;
  }

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

    const text = readableText();

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

    /*
     * A file input beside the word résumé is the clearest sign there is that a
     * form is in front of you, and it costs one selector.
     *
     * The test used to be `/\b(resum|cv)\b/i`, which matches neither "resume"
     * nor "resumes" nor "résumé": `\b` after "resum" wants a non-word
     * character and finds the "e". So the strongest single signal this scorer
     * has was dead for three years' worth of the only spellings anyone
     * actually writes, and fired on "cv" alone. Every real application form
     * that says "Upload your resume" was scoring three points lower than
     * intended, which on a form with little other vocabulary is the difference
     * between offering and staying quiet.
     *
     * A prefix rather than a whole word, so the plural and the accented
     * spelling both count. "Resuming" on a page that also has a file upload is
     * the price, and it is cheap: this adds three points, it does not decide
     * anything on its own, and the false-positive sweep is the check on it.
     */
    if (document.querySelector('input[type=file]') && /\bcv\b|résum|resum/i.test(text) && asksWhoYouAre()) score += 3;

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

  /** The settings as last read, so a second look can be decided without asking. */
  let lastSettings = null;

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
      const { matches } = await send('matchAnswers', {
        questions: found.map((q) => q.question),
        company: analysis?.job?.company,
      });
      return {
        wantsLetter,
        questions: found.map((q, i) => ({
          ...q,
          answer: matches[i]?.answer ?? '',
          confident: Boolean(matches[i]?.confident),
          score: matches[i]?.score ?? 0,
          itemId: matches[i]?.item?.id,
          // Whose name is in it, when that is not the company being applied to.
          namesAnother: matches[i]?.namesAnother,
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


  /**
   * What to call an application whose employer could not be read.
   *
   * "Unknown" is not an answer. It went into the Workspace list as the name
   * of the application, so a board that never says who is hiring — which is
   * most of the bare application forms on the web — produced an entry
   * reading "Unknown / Apply", sitting among the real ones, identifying
   * nothing. Two of those and you cannot tell them apart at all.
   *
   * The host is the one thing always known and always recognisable: you were
   * just there. It is a placeholder either way, but it is a true one, and it
   * is the one that tells you which application this is.
   */
  const whoIsHiring = () => {
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      return 'Unknown';
    }
  };

  /** Which rebuild is the current one; see `case 'rebuild'`. */
  let rebuildSeq = 0;

  async function onAction(action, payload = {}) {
    if (action.startsWith('answer:')) {
      // With the job, like every other drafting call. Without it the prompt
      // carried no company, role or description at all, so "Why do you want to
      // work here?" was answered about nothing in particular — while the same
      // question asked from the editor got the whole posting.
      return send('answerQuestion', { ...payload, job: analysis?.job });
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

      /*
       * Not named with the `answer:` prefix, which is claimed above for the
       * one-question-at-a-time route and would swallow this.
       */
      case 'writeApplication':
        return send('writeApplication', {
          spec: payload.spec,
          job: analysis.job,
          letter: payload.letter,
          questions: payload.questions,
        });

      case 'coverLetter':
        return send('coverLetter', { spec: payload.spec, job: analysis.job });

      /*
       * Let go of what is in the air. Straight through, because which requests
       * exist is the worker's business — this side knows only the name of the
       * button that was pressed.
       */
      case 'cancelWork':
        return send('cancelWork', { what: payload.what });

      /**
       * Hand the whole application to the editor: what the form asks for, the
       * resume already tailored, and the questions with whatever the bank
       * covers. Then open it, because the point is to go there and write.
       */
      case 'openWorkspace': {
        const { wantsCoverLetter } = await imports.autofill();
        const result = await send('openWorkspace', {
          company: analysis.job.company ?? whoIsHiring(),
          role: analysis.job.title ?? 'Unknown role',
          url: location.href,
          source: new URL(location.href).hostname,
          jobDescription: analysis.job.description ?? '',
          spec: payload.spec,
          // Including a letter box that is in a frame rather than this page.
          coverLetterRequired: wantsCoverLetter() || letterInFrame,
          /*
           * With what has already been written, not only what was asked.
           *
           * The button says it hands over "the posting, the resume, and the
           * questions", and it did exactly that: the answers and the letter
           * typed into the card stayed behind. The editor then filled the
           * boxes from the answer bank or left them empty, so following the
           * invitation to go and write there meant abandoning what was already
           * written — while the card on the other tab still held it.
           */
          coverLetter: payload.coverLetter ?? undefined,
          questions: (payload.questions ?? []).map((q) => ({
            question: q.question,
            required: q.required,
            answer: q.answer || undefined,
          })),
        });
        await send('openTab', { url: result.absoluteUrl });
        return result;
      }

      case 'saveLetter':
        return send('saveLetter', { body: payload.body, job: analysis.job });

      // Who it is addressed to comes from the page, as it does everywhere
      // else here — the card sends the words and the resume they are set to
      // match, not the company it half-remembers.
      case 'renderLetter':
        return send('renderLetter', {
          body: payload.body,
          resumeId: payload.resumeId,
          company: analysis.job?.company,
          role: analysis.job?.title,
        });


      case 'saveAnswer':
        return send('saveAnswer', payload);

      case 'trackStatus':
        return send('trackStatus', payload);

      /*
       * The same files, put where the upload dialog will be, without saying
       * they were sent.
       *
       * `applying` is exactly this state and has existed for it all along:
       * built, sitting in the flat folder, not yet gone. The difference from
       * `bundle` below is one word, and it is the whole difference between
       * "ready" and "sent".
       */
      case 'stage':
        return send('stage', {
          spec: payload.spec,
          resumeId: payload.spec.id,
          company: analysis.job.company ?? whoIsHiring(),
          role: analysis.job.title ?? 'Unknown role',
          url: location.href,
          source: new URL(location.href).hostname,
          status: 'applying',
          coverLetter: payload.coverLetter,
          answers: payload.answers,
        });

      case 'bundle':
        return send('bundle', {
          spec: payload.spec,
          resumeId: payload.spec.id,
          company: analysis.job.company ?? whoIsHiring(),
          role: analysis.job.title ?? 'Unknown role',
          url: location.href,
          source: new URL(location.href).hostname,
          /*
           * Pressing Submit is taken as submitting it.
           *
           * Strictly this is early: the files exist, the portal has not seen
           * them, and the upload still has to happen in the dialog this opens.
           * It was 'applying' for exactly that reason, and the step that moved
           * it on was a second button pressed afterwards — which is a button
           * pressed after the interesting part is over, on a tab that by then
           * shows a confirmation page. Nobody presses it, so the tracker
           * undercounted instead of overcounting, which is the worse of the
           * two: an application missing from the list is one you apply for
           * twice.
           *
           * So this is the main path and it files the application as sent. The
           * two ways of being wrong are both covered: "Not sent after all" in
           * the card puts it back, and the procedural watcher is the backstop
           * for an application never prepared here at all.
           */
          status: 'applied',
          coverLetter: payload.coverLetter,
          answers: payload.answers,
        });

      case 'setBase': {
        await send('setSettings', { patch: { baseResumeId: payload.baseResumeId } });
        analysis = await send('analyze', { ...(await applicationPayload()), ...tailoring(payload) });
        cardHandle?.update(analysis);
        return analysis;
      }

      /**
       * Rebuild the proposal from the base: unchanged, by keyword match, or
       * by asking the AI what to change. Same endpoint, one deliberate flag —
       * so the three paths cannot drift apart.
       */
      case 'rebuild': {
        /*
         * The newest press wins, and an older one lands nowhere.
         *
         * The build buttons no longer wait for each other — an AI pass is
         * minutes long and being unable to change your mind for the whole of
         * one is the scan holding the card. That freedom is only safe if the
         * slow reply cannot arrive afterwards and overwrite the fast one, and
         * this is where it would: `analysis` is the page's record of the
         * proposal and `update` is what puts it on screen. A superseded run
         * still finishes, still costs whatever it cost, and is then dropped.
         */
        const mine = ++rebuildSeq;
        const next = await send('analyze', { ...(await applicationPayload()), ...tailoring(payload) });
        if (mine !== rebuildSeq) return next;
        analysis = next;
        cardHandle?.update(analysis);
        return analysis;
      }

      case 'aiStatus':
        return send('aiStatus', {});

      /** Send the user to ResumeM-M, when that is what the card is offering. */
      case 'openTab':
        return send('openTab', { url: payload.url });

      // Turning ResumeM-M's own AI switch on, from the chip that reports it
      // being off. The switch that needs flipping should be under the hand
      // that is reaching for it.
      case 'setAiEnabled':
        return send('setAiEnabled', { enabled: Boolean(payload.enabled) });

      /** The pages of this application, and the two ways to correct them. */
      case 'forgetPage':
        return send('forgetPage', { url: payload.url });

      /*
       * "Start a new application here" — and `here` is this page, which the
       * worker cannot know on its own. Without it the trail emptied
       * completely, the badge went blank on the form the user was standing
       * on, and the next page began an application this one was not part of.
       */
      case 'clearTrail':
        return send('clearTrail', { keep: pageIdentity() });

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
   * Any frame on this page that holds an application form, as a page in its
   * own right.
   *
   * Part of this page however the browser files it — on a careers site that is
   * a heading and an embedded board it is the whole of the posting. Kept
   * separate rather than glued onto the page's own markup because the merge
   * takes the role and the company from the first page that knows them, and
   * the shell around the embed knows only the company name.
   *
   * Only frames already established to be applications answer, so nothing else
   * on the page is sent anywhere.
   */
  async function framePages() {
    const { frames } = await send('frameHtml', {}).catch(() => ({ frames: [] }));
    return (frames ?? [])
      .filter((f) => f.html)
      .map((f) => ({ url: f.url, title: f.title, html: f.html }));
  }

  /**
   * The same payload, plus every earlier page of this application.
   *
   * The description you read and the form you are filling in are usually two
   * pages on two hosts, and the questions are on the second one. Sending only
   * the page in front of you is why a cover letter written from an application
   * form had nothing to say.
   */
  /**
   * How much the card asked to have changed, in the form the worker wants.
   *
   * `useAi` is still accepted because the popup and older saved work speak it,
   * but everything the card sends now says `tailor` — the three-way choice
   * "leave it alone / match by keyword / let the AI decide" cannot be
   * expressed by a boolean, and the missing third of it was the one people
   * wanted most.
   */
  function tailoring(payload) {
    if (payload?.tailor) return { tailor: payload.tailor };
    if (typeof payload?.useAi === 'boolean') return { tailor: payload.useAi ? 'ai' : 'match' };
    return {};
  }

  async function applicationPayload() {
    const here = await pagePayloadIdle();
    // Which pages belong is settled before anything is read, from where this
    // page is and where it was reached from — never from the merged result,
    // which would then be deciding its own inputs.
    const trail = await send('trailPages', { page: pageIdentity() }).catch(() => ({ pages: [] }));

    const earlier = (trail.pages ?? []).filter((p) => p.url !== here.url && p.html);
    // Frames go between: after the pages actually walked to get here, which
    // know the role best, and before the shell they are embedded in, which
    // often knows only the company.
    const framed = await framePages();
    /*
     * `framed` is handed back as well as folded in. Remembering this page
     * needs exactly these two things — the page and the frames inside it —
     * and reading them a second time a moment later was both a duplicate walk
     * of every frame and a window: until the second read finished, this page
     * was not part of any application, so following Apply quickly enough
     * started a second one and lost the description you had just read.
     */
    return { ...here, framed, pages: [...earlier, ...framed, here] };
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
  async function show({ force = false, viaFrame = false } = {}) {
    const mine = supersede();
    const current = () => pass === mine;

    const settings = await send('getSettings');
    if (!current()) return;

    /*
     * Never on ResumeM-M itself.
     *
     * The editor is a page full of the exact words this tool looks for — a
     * resume, a cover letter, application questions, and more form fields
     * than most application forms have. So it offered: a card in the corner
     * of the builder proposing to tailor a resume for "jh-store", with the
     * save's own name read as the role and the editor's buttons scraped into
     * application questions.
     *
     * Told apart by address rather than by content, because by content it is
     * indistinguishable from what it is for, and always will be. The store's
     * own pages are the one place this tool has nothing to offer: everything
     * it would propose is already there, in the thing you are looking at.
     */
    try {
      if (settings.serverUrl && new URL(settings.serverUrl).origin === location.origin) return;
    } catch {
      // An unparseable server URL is the settings panel's problem to report,
      // not a reason to stop looking at ordinary pages.
    }

    // Kept so the re-score below can decide locally whether it is worth asking
    // again, rather than asking the worker once a second.
    lastSettings = settings;
    if (!force) {
      if (!settings.autoPrompt) return;
      if ((settings.mutedHosts ?? []).includes(location.hostname)) return;
      // A frame saying it holds an application is worth more than the score of
      // the page around it, which on those pages is a heading and an iframe.
      // Everything else still applies: a muted host stays muted, and a page
      // the server does not think is a posting still loses its card below.
      if (!viaFrame && localScore() < settings.minScore) return;
    }

    const [{ createCard, removeCard }, { wantsCoverLetter }] = await Promise.all([
      imports.card(),
      imports.autofill(),
    ]);
    if (!current()) return;

    /*
     * Whether to put the card up now or wait for the verdict.
     *
     * Showing it immediately is right when the page is certainly a posting: the
     * analysis takes seconds, and a card that says what it is doing beats a
     * page that sits there. It is wrong on everything else, because the local
     * score is deliberately generous — and a generous guess painted before the
     * server disagrees is a card that appears on an ordinary page and vanishes
     * a second later. Which is what people saw: a flicker in the corner of a
     * forum thread, with no way to tell what it had been.
     *
     * So the early card is for the two signals that are conclusive on their
     * own, and for `force`, where the user pressed the button and is owed an
     * immediate answer. Everything else waits — the wait is the analysis, and
     * nothing is lost by not announcing a guess during it.
     */
    const showNow = force || viaFrame || decisiveSignal();

    /*
     * And, failing that, once the wait becomes one you would notice.
     *
     * Holding the card back until the verdict is what stops it appearing on an
     * ordinary page and vanishing a second later. It also means that on a page
     * where the answer is slow — a busy machine, a store being read off a
     * network drive, a posting inside three frames — nothing at all happens
     * for as long as it takes, which reads as the extension being broken. The
     * whole point of the provisional card was that a card showing up late
     * looks like one that never came.
     *
     * So: nothing for the first moment, which covers every fast negative, and
     * after that the provisional card, because a wait long enough to notice is
     * a wait worth explaining. A slow page that then turns out not to be a
     * posting still takes its card away, and that is the right trade — it is
     * rare, and the alternative is silence exactly when the user is wondering.
     */
    // What the page asks for decides what the card offers. Asking the user
    // "does this need a cover letter?" is asking them to read the form on the
    // extension's behalf, when the form is right there to be read.
    const putUpCard = () => {
      if (cardHandle) return cardHandle;
      cardHandle = createCard({
        analysis: null,
        resumes: [],
        settings,
        questions: [],
        needsCoverLetter: wantsCoverLetter(),
        onAction,
      });
      return cardHandle;
    };
    /*
     * Early, or not at all.
     *
     * There used to be a second tier: any page above the local threshold got
     * a card after 700ms if the verdict had not arrived, on the reasoning
     * that a wait long enough to notice is a wait worth explaining, and that
     * a page which then turns out not to be a posting losing its card again
     * is rare.
     *
     * It is not rare. With the verdict slowed on purpose — a busy machine, a
     * store on a network drive — seven of the eleven pages in the quiet sweep
     * got a card and lost it: a careers article, documentation, a forum
     * thread, a board's own feed, a confirmation page, a salary page, a
     * careers page with nothing open. Every one of those is a page this tool
     * is supposed to stay off, and on a fast machine the flicker is over in
     * milliseconds, which is why it went unnoticed and then failed once,
     * under load, looking like noise.
     *
     * The tier earned nothing it did not already have. A page that names a
     * role or declares itself with structured data shows its card at once,
     * which is better than 700ms; a page that does neither is one we are only
     * guessing about, and the honest thing to do while guessing is nothing.
     */
    if (showNow) putUpCard();

    /*
     * The automatic pass is always the deterministic one. Tag matching takes
     * milliseconds; the AI takes seconds to minutes, and running it before the
     * user has even seen the posting's proposal is spending their time on a
     * guess they did not ask for. "Have AI Tailor" is a button.
     */
    let found;
    /** What this page was when it was read — reused below, not re-read. */
    let payload;
    // What the page was worth when it was read, not when the answer came back.
    // A board that serves a shell and fetches the posting fills in during the
    // analysis, so the two are different numbers — and recording the later one
    // told the tick below that a page far richer than the one actually judged
    // had already been ruled out. The card then never appeared at all.
    const judgedScore = localScore();
    try {
      payload = await applicationPayload();
      if (!current()) return;
      /*
       * Read the page, work out what the match would offer, and apply none
       * of it.
       *
       * This asked for `'none'` for a while, and before that for `'match'`.
       * `'match'` was wrong because it swapped wordings in the resume before
       * anyone had asked — arriving on a job advert altered the document, so
       * "send what I have" was the thing you undid. `'none'` was wrong in the
       * other direction: it meant the card could not say what the match
       * *would* do without a round trip and a wait.
       *
       * Asking for the match and applying nothing is both. The work is local,
       * free and measured at two seconds against the worst page set worth
       * having — no model, no LaTeX, no network past this call — and what
       * comes back is a list of offers the card shows with every box off. The
       * resume on screen is still the one you keep.
       */
      found = await send('analyze', { ...payload, tailor: 'match' });
    } catch (err) {
      /*
       * A server that is down is worth saying on a page that is certainly a
       * posting — that is the case where the user is waiting for this tool. On
       * a page we were only guessing about, it is not: putting an error in the
       * corner of a page that has nothing to do with jobs is the flicker again,
       * only louder.
       */
      if (current() && cardHandle) cardHandle.setStatus(err.message, err.jobhelper ?? null);
      else quietly(err);
      return;
    }
    if (!current()) return;
    analysis = found;

    if (!analysis.isJobPosting && !force) {
      removeCard();
      cardHandle = null;
      /*
       * Judged, and it stays judged until the url changes. Without this the
       * rescore tick below — which fires on any DOM change, and a busy page
       * makes those constantly — sent the whole page to be analysed again every
       * second, each round ending in the same answer.
       */
      ruledOut = { url: location.href, score: judgedScore };
      return;
    }
    putUpCard();
    cardHandle?.update(analysis);

    /*
     * The page is already part of an application by the time this line runs.
     *
     * It used to be told so by a second message, sent from here once the card
     * was up — and a page only belongs to an application once that message
     * lands. Following Apply in the meantime, which is exactly what you do on
     * a description page, started a fresh application on the form and lost
     * the description you had just read: the role reverted to whatever the
     * form calls itself, and the tracker took two rows for one job. A message
     * in flight when the tab navigates is never delivered, so no amount of
     * sending it sooner closes that window. `analyze` records the page in the
     * same round trip that read it, and hands back the trail it made.
     */
    if (analysis.trail) cardHandle?.setTrail(analysis.trail);

    /*
     * Whatever was built on the page before this one. Restored before the AI
     * is offered anything to do, so a resume that was already tailored is on
     * screen rather than being quietly rebuilt from scratch.
     */
    const carried = await send('takeWork', { page: pageIdentity() }).catch(() => ({ work: null }));
    if (!current()) return;
    /*
     * Always called, even with nothing to restore. "There was nothing
     * carried" is an answer the card is waiting for: until it has one it does
     * not know whether it is starting an application or continuing one, and
     * it holds the automatic cover-letter draft back until it does.
     */
    cardHandle?.restoreWork(carried?.work ?? null);
    // Say so when it came from a tab that was closed rather than from the
    // page before: finding your letter back without being told is its own
    // kind of unsettling.
    if (carried?.work && carried.recovered) {
      cardHandle?.setStatus('Recovered what you had written before this tab closed.');
    }
    /*
     * And only now may the keeper write.
     *
     * Between the card going up and this line, it holds the analysis and
     * nothing else: no letter, no answers, and a resume proposal that makes
     * `worthKeeping` true. The keeper runs every two seconds regardless, so
     * landing on a page of an application you had already written on was a
     * race — win it and your letter came back, lose it and the empty card was
     * saved over the letter before it was ever asked for.
     *
     * Losing it was silent and total: the letter was gone from storage, so
     * going back again did not help either. Set here rather than beside the
     * restore above because the answer "there was nothing to carry" arrives on
     * this line too, and a fresh application must not be frozen out of saving.
     */
    workRestored = true;

    /*
     * Whatever was asked for on the last page of this application, asked for
     * again here — and nothing at all if nothing was.
     *
     * Arriving at the form with more of the posting read than when the
     * proposal was made is exactly the moment to make it again, so following
     * Apply after asking the AI to tailor does put the new page in front of
     * it. The carried proposal stays on screen meanwhile, so nothing appears
     * to be lost while it thinks.
     *
     * `settings.useAi` used to be an alternative here, which meant the switch
     * being on started a model on every page of every posting you so much as
     * looked at. The switch says the AI is *available*; pressing something
     * says to use it. Only this application's own history counts now.
     */
    /*
     * The AI, and only the AI.
     *
     * A keyword match is deterministic: run again on the next page it lands on
     * much the same answer, and gets there by throwing away the compiled
     * resume and any wording you had switched back by hand. Not worth it. The
     * AI is the opposite — it reads, and the thing it reads is exactly what
     * grew when you followed Apply — so it is the one worth asking again.
     */
    if (carried?.work?.builtWith === 'ai') {
      const ai = await send('aiStatus', {}).catch(() => null);
      if (!current()) return;
      if (ai?.active) cardHandle?.retailor('ai');
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

    const noticed = (event) => {
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
      // Best effort by design: if this never arrives, the trail falls back to
      // the host and path rules and to `wasLinkedFrom`, which reads the same
      // link out of the page we came from with no race in it at all.
      send('expectContinuation', { to }).catch(() => undefined);
    };

    /*
     * On the press as well as on the click.
     *
     * The message has to reach the worker and be written to storage before the
     * page it was sent from is torn down. Measured, that takes 54 to 78
     * milliseconds — comfortable, until the machine is busy, and one run in
     * four of the full test suite was losing it.
     *
     * A person pressing a mouse button holds it down for something like a
     * tenth of a second before releasing, and the navigation starts on the
     * release. Listening on the press spends that entire gap on the write, for
     * free, and it is a gap far larger than the one being lost. Sending twice
     * costs nothing: the handler records the same intention either way, so the
     * second is a no-op with the same value.
     *
     * `click` stays, because a link followed by keyboard never presses a
     * pointer at all.
     */
    document.addEventListener('pointerdown', noticed, true);
    document.addEventListener('click', noticed, true);
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
  /** `keepWorkSafe`'s saver, so a route change can call it before tearing down. */
  let saveWorkNow = null;

  /**
   * False until this page's card has been offered whatever was carried to it.
   *
   * The keeper must not write before then — see where this is set, in `show`.
   * It starts false on every page load and goes false again on a route change,
   * because a single-page board's navigation is a new page in every sense that
   * matters here.
   */
  let workRestored = false;

  /**
   * Notice, roughly, that the application went out.
   *
   * The tracker recorded what you remembered to tell it, and nobody tells it
   * about the last step: by the time the form is submitted the tab is already
   * on a confirmation page and the application is behind you. So it showed
   * every application you had started and none of the ones you had finished,
   * which is the wrong half.
   *
   * The rules for what counts live in `shared/sending.js`, because the form is
   * as often inside an iframe as on the page and the frame has to reach the
   * same verdict from the same rules rather than from a second copy of them.
   */
  async function watchForSending() {
    const { watchForSending: watch } = await imports.sending();
    const stop = watch(document, (how) => {
      /*
       * Only on the page where an application is actually sent.
       *
       * "Apply Now" ends the application on ADP and opens it on almost every
       * description page there is — the same words for the opposite act. Taken
       * anywhere, it filed every posting you so much as opened as one you had
       * sent, which is the worst thing this could do: a job marked as done
       * comes off the list of things to finish.
       */
      if (analysis?.kind !== 'application') return;

      const named = analysis?.spec?.generatedFor;
      // Nothing to file it under. The card knows a posting by what the
      // analysis made of it, and without that this is just a form.
      if (!named?.company || !named?.role) return;

      send('applicationSent', {
        company: named.company,
        role: named.role,
        url: location.href,
        note: how,
      }).catch(() => undefined);
      cardHandle?.setStatus?.('Recorded as sent.');
    });
    teardown.push(stop);
  }

  function keepWorkSafe() {
    /*
     * `worthKeeping` is loaded once and kept, rather than awaited each time.
     *
     * `save` is registered on `pagehide`, and a continuation scheduled after an
     * await there runs while the page is already unloading — which a real
     * navigation is entitled to drop. The one save that matters most was the
     * one most likely not to happen. Loaded up front, the save on the way out
     * is synchronous up to the point the message leaves.
     */
    let worthKeeping = null;
    imports
      .trail()
      .then((m) => (worthKeeping = m.worthKeeping))
      .catch(() => undefined);

    const save = () => {
      // A card that has not yet been given what was carried to it has nothing
      // to say about this application, and saying it anyway overwrites the
      // letter it is about to be handed.
      if (!workRestored) return;

      const work = cardHandle?.takeWork?.();
      if (!work) return;

      // Nothing worth keeping is not worth sending. The worker refuses it too,
      // but a card with an empty state should not be asking in the first place.
      if (worthKeeping && !worthKeeping(work)) return;

      // The page is sent with it: a card left open on another posting must not
      // be able to write its work over this application's.
      send('saveWork', { work, page: pageIdentity() }).catch(() => undefined);
    };
    saveWorkNow = save;
    every(2000, save);
    // A navigation is exactly when this matters, and exactly when an interval
    // is least likely to have just run.
    const onHide = () => save();
    window.addEventListener('pagehide', onHide);
    // Coming back is the worker's news to break, not this listener's — see
    // the `jh-came-back` message. Leaving is all this one is for.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
    };
    document.addEventListener('visibilitychange', onVisibility);
    teardown.push(() => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
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
    /*
     * One exception to "a frame does nothing until asked": it watches for the
     * application in it being sent.
     *
     * The form is as often in an iframe as on the page — iCIMS above all, and
     * every careers page that embeds a board — and when it is, the button, the
     * click and the submit all happen in here. The top document sees none of
     * them, so every application sent through an embedded form went
     * unrecorded: the one case where the tracker most needed to hear.
     *
     * It reports the fact and nothing else. A frame has no analysis and no
     * card, so it cannot say which application this is; the service worker
     * knows, from the trail this tab has been building, and decides there.
     */
    imports
      .sending()
      .then(({ watchForSending }) =>
        watchForSending(document, (how) => {
          send('applicationSentHere', { note: how, url: location.href }).catch(() => undefined);
        }),
      )
      .catch(() => undefined);

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const answer = (work) =>
        work
          .then((data) => sendResponse({ ok: true, data }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));

      switch (message?.type) {
        case 'jh-frame-scan':
          answer(
            imports.autofill().then((autofill) => {
              const { findQuestions, isRequired, wantsCoverLetter, looksLikeApplicationForm } = autofill;
              if (!looksLikeApplicationForm()) return { questions: [], wantsLetter: false };
              return {
                questions: findQuestions().map((q) => ({ ...q, required: isRequired(q.fieldId) })),
                wantsLetter: wantsCoverLetter(),
              };
            }),
          );
          return true;

        case 'jh-frame-fill':
          answer(
            imports.autofill().then(({ fillForm, looksLikeApplicationForm }) =>
              // The one that must not be got wrong. Anything else on the page
              // gets nothing about the person using it.
              looksLikeApplicationForm() ? fillForm(message.payload?.fields ?? {}) : { filled: [], skipped: [] },
            ),
          );
          return true;

        /*
         * The frame's own markup, when the frame is an application. On the
         * pages this exists for it is the only place the posting is written
         * down, so without it the page is analysed as the empty shell it looks
         * like from outside.
         */
        case 'jh-frame-html':
          answer(
            Promise.all([imports.autofill(), imports.trail()]).then(
              ([{ looksLikeApplicationForm }, { trimForStorage }]) =>
                looksLikeApplicationForm()
                  ? {
                      url: location.href,
                      title: document.title,
                      html: trimForStorage(document.documentElement.outerHTML, 400_000),
                    }
                  : { html: '' },
            ),
          );
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

    /*
     * And, if this frame is an application, say that too — because the page
     * around it may have nothing to go on and may otherwise never offer.
     *
     * The count of form controls first, because this runs in every frame of
     * every page: adverts, embeds, tracking pixels. Almost none of them has
     * two form fields, and the ones that do are the only ones worth loading
     * the rest of the code to look at properly.
     */
    if (document.querySelectorAll('input, textarea, select').length >= 2) {
      imports
        .autofill()
        .then(({ looksLikeApplicationForm }) => {
          if (looksLikeApplicationForm()) send('applicationFrameHere', {}).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    return;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'show-card') {
      show({ force: true })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    /*
     * A frame on this page has found an application form in itself. If there
     * is already a card, it will pick the frame up on its own; if there is
     * not, this is the only notice there will ever be.
     */
    if (message?.type === 'jh-application-frame') {
      if (!cardHandle) show({ viaFrame: true }).catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'autofill') {
      runAutofill()
        .then((report) => sendResponse({ ok: true, data: report }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    /*
     * This tab is in front again, having sent someone to the builder.
     *
     * Said by the worker rather than worked out here from `visibilitychange`,
     * because the worker is the one that opened the other tab and therefore
     * knows this return is the end of that trip. It also catches the return
     * made by closing the builder, which is how people actually come back.
     */
    if (message?.type === 'jh-came-back') {
      try {
        cardHandle?.cameBack?.();
      } catch {
        // An orphaned card. Not worth an error on the page.
      }
      sendResponse({ ok: true });
      return false;
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
  /*
   * And a posting that is not in the page when the page is first read.
   *
   * Workday, Ashby and most of the modern boards serve an empty shell and
   * fetch the posting afterwards. The script runs once, at document idle, and
   * scored a loading spinner: nothing about the page changed afterwards except
   * its contents, so there was no second look and the card never appeared at
   * all — on the systems a great many applications go through.
   *
   * The observer only sets a flag; the work happens on the tick below, which
   * is what keeps this affordable on a board that rewrites its DOM constantly.
   * It runs while the page is young and no card has been offered, and then
   * stops: a page that has not turned into a posting within a minute of
   * loading is not going to.
   */
  const RESCORE_WINDOW_MS = 60_000;
  const loadedAt = Date.now();
  let pageChanged = false;
  const watcher = new MutationObserver(() => {
    pageChanged = true;
  });
  watcher.observe(document.documentElement, { childList: true, subtree: true });
  teardown.push(() => watcher.disconnect());

  /**
   * A url the server has already said is not a posting, and how much the page
   * was worth at the time.
   *
   * The score matters: Workday, Ashby and the rest serve an empty shell and
   * fetch the posting afterwards, so the first look is at a loading spinner
   * and the verdict on it is right. Remembering only the url meant that
   * verdict stood for the life of the page and the card never appeared. What
   * is worth a second look is a page that has gained something since.
   */
  let ruledOut = null;

  /** True while a look at this page is still running; see the tick below. */
  let looking = false;

  let lastUrl = location.href;
  every(1000, () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      /*
       * Save before anything else. On a single-page board this is the only
       * kind of navigation there is — `pagehide` never fires — and the card
       * was torn down here without a save, so up to two seconds of letter or
       * answer went with it.
       */
      saveWorkNow?.();

      // Saved, and now shut again until the next page's card has been offered
      // what that save just put away. Without this a route change kept the
      // open gate from the page before, which is the race this closes.
      workRestored = false;

      // Before the await, not after: the pass still running belongs to the url
      // that just went away, and it must stop being able to write to the card
      // from this instant rather than from whenever the import resolves.
      supersede();
      return (async () => {
        const { removeCard } = await imports.card();
        removeCard();
        cardHandle = null;
        await show().catch(quietly);
      })();
    }

    if (Date.now() - loadedAt > RESCORE_WINDOW_MS) {
      watcher.disconnect();
      return;
    }
    if (cardHandle || !pageChanged) return;
    pageChanged = false;
    if (ruledOut?.url === location.href && localScore() <= ruledOut.score) return;

    /*
     * One look at a time.
     *
     * Every look calls `supersede()`, which is what stops a pass belonging to a
     * page you have left from writing to the card. On a board that rewrites its
     * DOM constantly that turned into starvation: a look began each second,
     * cancelled the one before it, and none ever reached the end — so on the
     * boards that serve a shell and fetch the posting afterwards, the card
     * arrived late or never. It is the reading that is slow, and restarting it
     * every second is what made it slower.
     */
    if (looking) return;

    // Scored here rather than inside `show`, so that a page rewriting itself
    // every second does not send a message every second to be told no.
    if (lastSettings && localScore() < lastSettings.minScore) return;
    looking = true;
    return show().finally(() => {
      looking = false;
    });
  });

  watchForApplyClicks();
  keepWorkSafe();
  watchForSending().catch(() => undefined);

  // And once the card exists, orphaning takes it off the page: a card whose
  // buttons all throw is worse than no card.
  teardown.push(() => {
    imports.card().then(({ removeCard }) => removeCard()).catch(() => undefined);
    cardHandle = null;
  });

  // A missing server must not spam every page the user opens.
  show().catch(quietly);
})();
