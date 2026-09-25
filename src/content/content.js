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
            /*
             * The worker stopped with this request still in it — Chrome
             * stops it when it likes: an update, memory pressure, a crash —
             * and the reply went with it. Measured with an AI pass held open
             * and the worker stopped: the card put Chrome's own sentence up
             * as it came, "A listener indicated an asynchronous response by
             * returning true, but the message channel closed before a
             * response was received", which says nothing anybody can use.
             */
            if (/message (channel|port) closed/i.test(said)) {
              reject(
                new Error(
                  'The browser stopped JobHelper’s background worker before this finished, so its answer was lost. Try it again.',
                ),
              );
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
    ask: () => fromExtension('src/content/ask.js'),
    sites: () => fromExtension('src/shared/sites.js'),
    autofill: () => fromExtension('src/content/autofill.js'),
    attach: () => fromExtension('src/content/attach.js'),
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

  /*
   * The systems a job page is actually served from.
   *
   * Lifted out of the scorer because the gate below asks the same question for
   * a different reason. Being on one of these is not evidence that *this* page
   * is a posting — the page after you press submit is on one, so is a board's
   * own feed — which is why it is worth four points rather than a decision.
   * What it is evidence of is that the page is part of a hiring system at all,
   * and that is the question the chip exists to ask.
   */
  /*
   * Oracle Recruiting Cloud by its path rather than its host: every tenant is
   * `<pod>.fa.<dc>.oraclecloud.com`, which also serves the rest of Oracle's
   * cloud, and only the candidate side lives under `/CandidateExperience/`.
   */
  const ON_A_TRACKER =
    /\b(greenhouse|lever|workday|myworkdayjobs|ashby|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|jazzhr|successfactors|brassring|candidateexperience)\b/i;
  const ON_A_BOARD = /\b(indeed|linkedin|glassdoor|monster|ziprecruiter|dice|wellfound|otta|builtin|simplyhired|seek)\b/i;

  /*
   * And a path that says, in the site's own words, that this is the hiring
   * part of it.
   *
   * A whole segment, so `/r/cscareers/comments/...` is not a careers page and
   * `/blog/why-we-are-hiring` is not a posting. Like the two above this is not
   * evidence that the page is a posting — a careers landing page with nothing
   * open matches it, and so does a board's search results — only that
   * somebody put it where jobs go. Which is the question the chip asks, and
   * the answer is on the address.
   */
  const IN_A_JOBS_AREA =
    /\/(jobs?|careers?|opening|openings|position|positions|vacanc(y|ies)|apply|application|hiring|req|requisition)(\/|$|[?#])/i;

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
    if (ON_A_TRACKER.test(url)) {
      score += 4;
    }
    if (ON_A_BOARD.test(url)) {
      score += 3;
    }
    if (IN_A_JOBS_AREA.test(url)) {
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
  /*
   * Whether this page's card was put away by hand.
   *
   * "Not now" has to mean not now — not "until the next DOM change puts it
   * straight back" — and it also has to have a way out. Keeping it apart from
   * `cardHandle` is what lets both be true: the automatic routes read it and
   * stay quiet, the toolbar button clears it, and a new url starts over.
   *
   * It was neither: the × removed the element and left `cardHandle` pointing
   * at it, so every route back short-circuited on a node that was no longer
   * in the document, and the button did nothing for the life of the page.
   */
  let dismissed = false;
  let analysis = null;

  /** Stops the one watcher of choices made on this page's form; see `show`. */
  let stopChoices = null;

  /**
   * And the one of what is typed into its short boxes, with what it has
   * heard: the answers to keep, by question, until the application is sent or
   * the form is left — see `keepTyped` — and the questions the person said
   * not to keep. `typedProfile` is the profile as the last Autofill had it,
   * which is what says a box is the profile's rather than the person's.
   */
  let typedWatch = null;
  const typedToKeep = new Map();
  const typedNotKept = new Set();
  let typedProfile = null;

  /** Who this page is applying to, for the rules that refuse naming them. */
  const companyHere = () => analysis?.spec?.generatedFor?.company || analysis?.job?.company || '';

  /** The card's list of what will be kept, drawn again from `typedToKeep`. */
  const showTypedToKeep = () =>
    cardHandle?.setToKeep?.([...typedToKeep].map(([question, { answer }]) => ({ question, answer })));

  /**
   * Put what was typed on this form into the bank, now.
   *
   * Called when the application is sent and when the form is left — its
   * `pagehide`, and a route change on a board that never unloads — and not
   * as each box is typed in, so the answer kept is the one the person ended
   * on, and one they have said not to keep never leaves the page. One message
   * for all of them: `pagehide` is the moment a page is least able to wait,
   * and the worker saves them one after another from there.
   */
  const keepTyped = () => {
    typedWatch?.take();
    if (typedToKeep.size === 0) return;
    const answers = [...typedToKeep].map(([question, { answer, itemId }]) => ({ question, answer, itemId }));
    typedToKeep.clear();
    send('rememberTyped', { answers }).catch(() => undefined);
    showTypedToKeep();
  };

  /** Stops the watcher that re-reads the form's questions; see `watchQuestions`. */
  let stopQuestions = null;

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
   * The pass whose analysis `analysis` actually holds.
   *
   * Between a look starting and its verdict arriving, `analysis` is still the
   * *previous* page's — and on a board that swaps postings without a
   * navigation, the card on screen is already the provisional one for the new
   * job, drawn from its title. So for those few seconds the card says one
   * posting and `analysis` says another, and anything that asks "is this
   * reply about what is in front of me?" by reading `analysis` gets the wrong
   * answer with nothing looking wrong. `landLate` is exactly that question.
   */
  let analysed = 0;
  const analysisIsCurrent = () => analysed === pass;

  /** The settings as last read, so a second look can be decided without asking. */
  let lastSettings = null;

  /**
   * The url the chip has already been put up for.
   *
   * The rescore tick runs every second while the page is still settling, and
   * without this a board that rewrites its DOM would tear the chip down and
   * build it again under the cursor each time — including out from under a
   * click. Answering it leaves this set, so "no" and "not now" both mean not
   * again on this page, which is the only reading of them that is not
   * infuriating.
   */
  let askedFor = null;

  /**
   * Add or take this host off the list the popup's button calls "Mute this
   * site", which is the one place a person can see it and undo it.
   */
  async function setMuted(muted) {
    // One message, because the list is shared with the popup and reading it
    // here to write it back there is how one of two mutes goes missing. See
    // `muteHost` in the worker.
    lastSettings = await send('muteHost', { host: location.hostname, muted });
  }

  /**
   * Whether a form in a sub-frame asked for a cover letter.
   *
   * Remembered because it is learnt from the scan, well after the card has
   * gone up, and it is wanted again later — when the application is handed to
   * the editor, which needs to know whether a letter is part of it.
   */
  let letterInFrame = false;

  /** Stopping and restarting the one-send-per-document watcher on this page. */
  let stopSending = null;
  let stopReceipt = null;
  let restartSending = null;

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
   * Read the questions again when the form moves on without the url moving.
   *
   * They were read once, when the card went up, and again only on a url
   * change. A form that draws its next step where the last one was — a React
   * step component, the url untouched — left the card listing step one's
   * question, its answer box and its Insert button, while the page asked
   * something else; and step two's own questions were never offered at all.
   * Measured in tests/worker.mjs: after Next, the card still listed "Why do
   * you want to work at Helios?" over a page asking "Describe a time you
   * failed." and a second question step one did not have.
   *
   * The observer only sets a flag, as the rescore watcher's does, and the
   * reading happens on a slow tick — and only for a form, only while its card
   * is up. What is compared is the questions as the page asks them, counters
   * folded out the way `insertAnswer` folds them, so a "(473 characters
   * remaining)" ticking as somebody types is not a new step. Only this
   * document is looked at on the tick; when it has moved on, the whole
   * reading runs again, frames included, with the bank matched afresh.
   */
  function watchQuestions(findQuestions, current, onChanged) {
    const asked = () =>
      findQuestions()
        .map((q) => q.question.replace(/\d+/g, '#').toLowerCase())
        .join('\n');
    let readAs = asked();
    let changed = false;
    const observer = new MutationObserver(() => {
      changed = true;
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    const tick = setInterval(() => {
      if (!changed || !cardHandle || dismissed || !current()) return;
      changed = false;
      onChanged?.();
      const now = asked();
      if (now === readAs) return;
      readAs = now;
      gatherQuestions()
        .then(({ questions, wantsLetter }) => {
          if (!current()) return;
          cardHandle?.setQuestions(questions);
          cardHandle?.setNeedsCoverLetter(wantsLetter);
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      observer.disconnect();
      clearInterval(tick);
    };
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
    const data = await send('autofillData');
    // What is the profile's to fill, for what is typed afterwards. See `typedBox`.
    typedProfile = data.fields ?? null;
    // The jobs on the resume being sent, for a form's work-history blocks.
    const history = Array.isArray(data.history) ? data.history : [];
    // And its schools, for an Education section that adds a block per school.
    const education = Array.isArray(data.education) ? data.education : [];
    const here = await fillThisDocument(data.fields, history, education);

    const { frames } = await send('fillFrames', { fields: data.fields, history, education }).catch(() => ({ frames: [] }));
    return {
      filled: [...here.filled, ...frames.flatMap((f) => f.filled ?? [])],
      skipped: [...here.skipped, ...frames.flatMap((f) => f.skipped ?? [])],
    };
  }

  /**
   * Fill the form in *this* document, from the profile and from the answers
   * this person has given before.
   *
   * The bank lookup happens per document rather than once at the top, because
   * the questions are per document: an iCIMS application is in a frame and
   * the page around it has none of it. Each frame asks about its own
   * questions and gets back its own answers, which also keeps the round trip
   * small — a page with six frames does not send six copies of one list.
   *
   * The matching is the store's. See `rememberedAnswers` in the worker: the
   * question travels there and comes back echoed, so the only comparison here
   * is string equality. Every failure path ends in an empty list, which is
   * the behaviour this had before the bank existed.
   */
  async function fillThisDocument(fields, history = [], education = []) {
    const { fillForm, fillComboboxes, fillEducation, choiceQuestions, typedQuestions } = await imports.autofill();
    const company = companyHere();
    // And the short boxes typed into last time. See `typedQuestions`.
    const questions = [...choiceQuestions(), ...typedQuestions(fields, company)];
    const remembered = questions.length
      ? await send('rememberedAnswers', { questions })
          .then((r) => r?.answers ?? [])
          .catch(() => [])
      : [];
    // And then the widgets `fillForm` could only name. See `fillComboboxes`:
    // exact options only, and seen to have taken, or put back as they were.
    // The history too, for the job months a form asks as lists. See `fillJobMonths`.
    const report = await fillComboboxes(fields, fillForm(fields, { remembered, history, company }), { history });
    // Last, the resume's other schools, one "Add another" at a time. See
    // `fillEducation`: a resume with one gets only its dates, in the first block.
    return fillEducation(education, fields, report);
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
  /*
   * The names an application is filed under, the same on every path.
   *
   * The store settles them when it builds the resume — the page's employer,
   * or its own tidied reading of the address ("careers.activision.com" is
   * Activision) — and writes them on the copy as `generatedFor`; the keeper
   * opens the workspace under those and a send is recorded under them. Staging,
   * building and "Write these in ResumeM-M" used the page's own reading with
   * the hostname behind it, so on a Phenom apply page, titled "Apply" and
   * naming nobody, the tracker got a row reading "careers.activision.com /
   * Unknown role" beside the one the workspace had opened. One application
   * is one pair of names, whichever button filed it.
   */
  const filedAs = () => {
    const settled = analysis?.spec?.generatedFor;
    return {
      company: settled?.company || analysis?.job?.company || whoIsHiring(),
      role: settled?.role || analysis?.job?.title || 'Unknown role',
    };
  };

  const whoIsHiring = () => {
    try {
      return new URL(location.href).hostname.replace(/^www\./, '');
    } catch {
      return 'Unknown';
    }
  };

  /**
   * Which proposal is the current one, on two axes at once.
   *
   * `rebuildSeq` answers "has another build started since this one" and
   * `pass` answers "is this still the page that asked". Both are needed and
   * neither is enough:
   *
   *   Only the sequence, and a build begun on one posting lands on the next.
   *   A route change on a single-page board bumps `pass` and removes the
   *   card, but the number an in-flight build is holding still matches — so
   *   when the reply finally arrives it writes a different company's proposal
   *   onto the card in front of you, and the files are built from it.
   *
   *   Only the pass, and two builds on one page race: the slower reply
   *   arrives last and wins, which is the wrong one by definition.
   *
   * `setBase` had neither, so both failures applied to it — and it is the
   * one people press repeatedly, because trying two bases against a posting
   * is what the picker is for.
   */
  let rebuildSeq = 0;
  const startProposal = () => ({ build: ++rebuildSeq, on: pass });
  const stillWanted = (token) => token.build === rebuildSeq && token.on === pass;

  /*
   * Overtaken by another press on this page, rather than by the page moving on.
   *
   * The two used to go the same way — to `landLate`, which was written for the
   * second and lands a reply on the card whenever the posting is the same one.
   * On the same page it always is, so the newest press did not win: press
   * Have AI Tailor, choose another resume to start from while it reads, and
   * the new base's proposal went up and was then covered by the AI's answer
   * for the base just turned away from — lit, and announced as "The AI
   * finished tailoring this posting". Measured in tests/worker.mjs. The card
   * drops the same reply by its own number (see `rebuildAs`); this is the
   * half that reached the screen anyway.
   */
  const overtakenHere = (token) => token.on === pass && token.build !== rebuildSeq;

  /**
   * A proposal that finished after the card had moved on.
   *
   * `stillWanted` is right about what it refuses — a pass belonging to a page
   * you have left must not write to the card in front of you. What was wrong
   * was the other half: the reply was dropped where it stood, in silence.
   *
   * A keyword match costs a second, and losing one costs nothing. An AI pass
   * is minutes — measured at 178 seconds for one posting — and the thing that
   * supersedes it is usually not a different job at all: `startOver` fires on
   * any change to the url, and a single-page board ticks its url while you
   * wait. So three minutes of a model's work, and of somebody's patience,
   * ended with the card saying nothing and showing the proposal from before
   * the run. "I don't know what it even did" is the accurate description of
   * that, and it is the only thing the card left room to think.
   *
   * Kept instead. If the posting on screen is the same one the run was for,
   * it lands and says so. If it is not, it is said out loud and dropped —
   * which is an answer, and the silence was not.
   */
  let lateProposal = null;
  /** Older than this and nobody is still waiting for it. */
  const LATE_PROPOSAL_MS = 10 * 60 * 1000;

  /*
   * The trail's employer key, held once the trail module has loaded — see
   * `plainlyAnotherRole` below, which is loaded the same way for the same
   * reason: `sameJob` is asked synchronously.
   *
   * The company used to be compared exactly, and one posting writes its
   * employer two ways: the JSON-LD carries "Acme, Inc.", the title says
   * "Acme". Measured by lifting `sameJob` out of this file: an AI result for
   * "Acme, Inc." against a card reading "Acme" came back false, so three
   * minutes of a model's work on this very posting was announced as "not
   * this posting, so it was not used" and dropped. The key is `employerKey`,
   * which leaves a trailing legal form out and nothing else; until the module
   * has loaded the comparison is the exact one it always was.
   */
  let employerKey = null;

  /*
   * And the title by the trail's `titleKey`, held the same way. Compared
   * exactly, "Platform engineer" from one reading and "Platform Engineer"
   * from another were two postings, and the finished run was dropped as "not
   * this posting". Only case, spacing and punctuation are let go; a title that
   * differs by a word — "Senior Platform Engineer" — is still another job.
   */
  let titleKey = null;

  /** Two analyses about the same opening, by what they say it is. */
  const sameJob = (a, b) =>
    Boolean(a?.job && b?.job) &&
    (employerKey
      ? employerKey(a.job.company) === employerKey(b.job.company)
      : (a.job.company ?? '') === (b.job.company ?? '')) &&
    (titleKey ? titleKey(a.job.title) === titleKey(b.job.title) : (a.job.title ?? '') === (b.job.title ?? ''));

  /** Whether a model actually chose something, as the card reads it. */
  const wasDecided = (a) => a?.tailor === 'ai' && a?.aiUsed;

  const nameOf = (a) => [a?.job?.title, a?.job?.company].filter(Boolean).join(' at ') || 'that posting';

  /**
   * Put a finished-too-late proposal somewhere, rather than nowhere.
   *
   * Straight onto the card when the card is showing the same posting, which
   * is the ordinary case; otherwise held for the next card to collect in
   * `takeLateProposal`, because the pass that superseded this one may still
   * be reading the page.
   */
  function landLate(result) {
    // Only against an analysis that belongs to the page on screen; see
    // `analysed`. Otherwise this is held and `takeLateProposal` decides once
    // the look in flight has landed.
    if (cardHandle && analysisIsCurrent() && sameJob(result, analysis)) {
      analysis = Object.assign(analysis ?? {}, result);
      cardHandle.update(result, { show: true });
      if (wasDecided(result)) cardHandle.say('The AI finished tailoring this posting. Its changes are below.');
      return result;
    }
    lateProposal = { at: Date.now(), result };
    return result;
  }

  /** And the collection, once a new card has its own analysis. */
  function takeLateProposal() {
    const late = lateProposal;
    lateProposal = null;
    if (!late || Date.now() - late.at > LATE_PROPOSAL_MS) return;

    if (!sameJob(late.result, analysis)) {
      if (wasDecided(late.result)) {
        cardHandle?.say(`The AI finished tailoring ${nameOf(late.result)}, which is not this posting, so it was not used.`);
      }
      return;
    }
    analysis = Object.assign(analysis ?? {}, late.result);
    cardHandle?.update(late.result, { show: true });
    if (wasDecided(late.result)) cardHandle?.say('The AI finished tailoring this posting. Its changes are below.');
  }

  /*
   * The files a chip on the card is being dragged with, while it is in the air.
   *
   * The drag itself cannot carry them. Chromium will not put a script-made
   * `File` into a drag a page starts — measured on a bare page with no
   * extension involved: at the drop, `types` is `["text/plain"]`, `files` is
   * empty and there is no file item at all. It is right not to; a drag can
   * leave the browser, and a page that could put files in one could write to
   * the desktop. So the card's chips have never actually dropped anything into
   * a form, while saying "Drag any of these into the form" the whole time.
   *
   * The extension can do what the drag cannot. The card says what is in the
   * air, the listeners below allow the drop and then cancel it, and the file
   * goes into the box under the pointer through the same `input.files` write
   * that Attach files uses. Nothing here is a trick the page can tell from its
   * own file dialog.
   */
  let inTheAir = null;
  let watchingDrops = false;

  function watchForDrops() {
    if (watchingDrops) return;
    watchingDrops = true;
    /*
     * Capture, and `preventDefault` on `dragover` — without it the browser
     * refuses the drop and there is no `drop` event to take. Capture so a page
     * that cancels the drag on its own handlers cannot get there first.
     */
    document.addEventListener(
      'dragover',
      (event) => {
        if (!inTheAir) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      },
      true,
    );
    document.addEventListener(
      'drop',
      (event) => {
        const files = inTheAir;
        if (!files) return;
        /*
         * Stopped as well as cancelled: the page's own drop handler would
         * otherwise run on a drag carrying nothing and report "that file could
         * not be read" about a file that is about to go in correctly.
         */
        const target = event.composedPath?.()?.[0] ?? event.target;
        /*
         * A chip let go of over the card itself is a drag abandoned, not a
         * drop on a form. Without this the card is the nearest thing that
         * looks like a drop zone and the file would be dispatched at our own
         * panel.
         */
        if (target?.getRootNode?.()?.host?.id === 'jobhelper-card-host') {
          inTheAir = null;
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        inTheAir = null;
        /*
         * Said wherever the card is, which is not always here.
         *
         * A frame that took the drop has no card to tell — the card is in the
         * top frame — so the report goes back through the worker. In the top
         * frame there is no worker round trip to make.
         */
        const said = (report) => {
          if (cardHandle) cardHandle.dropped(report);
          else send('droppedInFrame', { report }).catch(() => undefined);
        };
        imports
          .attach()
          .then(({ dropOnto }) => dropOnto(target, files))
          .then(said)
          .catch(() =>
            said({
              placed: [],
              unplaced: files.map((f) => ({ name: f.name, why: 'the drop could not be completed' })),
            }),
          );
      },
      true,
    );
  }

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

      /** One typed answer the person does not want kept. See `keepTyped`. */
      case 'dontKeep':
        typedNotKept.add(payload.question);
        typedToKeep.delete(payload.question);
        showTypedToKeep();
        return { ok: true };

      /*
       * The upload boxes, from the folder the card would otherwise ask you to
       * paste a path to.
       *
       * The bytes come through the worker because the page's origin has no
       * business reaching the local store, and the placing happens here
       * because only a content script can touch the form. Frames too: the
       * upload control on a good half of these portals is in one, exactly as
       * the text fields are.
       */
      /*
       * The same files, handed to the card rather than put in a box.
       *
       * For dragging. A drag has to have its files in hand the instant
       * `dragstart` fires — `dataTransfer` cannot be filled in after an await
       * — so the card fetches them when the pointer arrives over the chip and
       * holds them until the drop. Nothing is placed and nothing is reported;
       * this is the bytes and their names, and what happens next is the
       * page's business.
       */
      /*
       * What this form is asking for, so the card can point at the right
       * document rather than listing three and leaving you to decide.
       */
      case 'wantedDocuments': {
        const { documentsWanted } = await imports.attach();
        return documentsWanted();
      }

      case 'attachmentFiles': {
        const got = await send('attachments', { application: payload.application ?? null });
        return {
          files: got?.files ?? [],
          missing: (got?.missing ?? []).map((m) => ({ name: m.name, why: m.why })),
          dir: got?.dir ?? null,
        };
      }

      /*
       * A chip has been picked up, or put down. See `inTheAir`: the drag
       * itself carries nothing, so this is how the drop knows what to place.
       */
      case 'dragging': {
        inTheAir = payload.files?.length ? payload.files : null;
        if (inTheAir) watchForDrops();
        /*
         * And every frame on the page, because the drop lands in whichever
         * document the pointer is over. On a board that embeds its form —
         * Greenhouse and Lever both do — that is never this one. Not awaited:
         * the drag is already in flight and the pointer is not going to wait
         * for a round trip through the worker.
         */
        send('draggingInFrames', { files: inTheAir ?? [] }).catch(() => undefined);
        return { watching: Boolean(inTheAir) };
      }

      /*
       * The resume list, asked for again. See `askForResumesAgain` in the
       * card: the list is normally pushed in by `setResumes` once it lands,
       * and that push is dropped if the page moved on while it was in flight
       * — which leaves the picker empty with nothing to retry it.
       */
      case 'listResumes':
        return send('listResumes');

      case 'fresh':
        return send('fresh', { spec: payload.spec });

      case 'attachFiles': {
        const got = await send('attachments', { application: payload.application ?? null });
        const files = got?.files ?? [];
        /*
         * The ones the store listed and could not hand over. They are not
         * placed and they are not unplaceable — they never arrived — and
         * until they were carried through here they were in neither list, so
         * the card reported the two that worked and said nothing at all about
         * the third.
         */
        const missing = (got?.missing ?? []).map((m) => ({ name: m.name, why: m.why }));
        if (files.length === 0) {
          return missing.length > 0
            ? { placed: [], unplaced: missing, dir: got?.dir ?? null }
            : { placed: [], unplaced: [], nothing: true, dir: got?.dir ?? null };
        }
        const { attachFiles } = await imports.attach();
        const here = await attachFiles(files);
        /*
         * And whatever is left, offered to the frames. A form split across
         * the page and an embed is ordinary, and a resume that went nowhere
         * because the box was one level down is the case this is for.
         *
         * A file dropped on a zone that said nothing back counts as left, not
         * as placed: `sure: false` means the event was delivered and nothing
         * visible came of it, and the usual shape there is a marketing "drag
         * your resume here" widget in the page with the real form in an
         * iCIMS frame underneath. Trying the frame as well costs nothing; not
         * trying it left the only real box on the page untouched.
         */
        const left = files.filter((f) => !here.placed.some((p) => p.name === f.name && p.sure !== false));
        if (left.length === 0) return { ...here, unplaced: [...here.unplaced, ...missing], dir: got.dir };

        const inFrames = await send('attachInFrames', { files: left }).catch(() => ({ frames: [] }));
        /*
         * One frame's word each. Every frame is asked at once, so a page with
         * two frames that both pass the gate — a responsive embed rendering a
         * desktop and a mobile copy of one board — reported the same file
         * twice: "Attached Resume.pdf and Resume.pdf".
         */
        const alsoPlaced = [];
        for (const p of (inFrames.frames ?? []).flatMap((f) => f.placed ?? [])) {
          if (!alsoPlaced.some((already) => already.name === p.name)) alsoPlaced.push(p);
        }
        return {
          placed: [...here.placed.filter((p) => !alsoPlaced.some((a) => a.name === p.name)), ...alsoPlaced],
          unplaced: [...here.unplaced.filter((u) => !alsoPlaced.some((p) => p.name === u.name)), ...missing],
          dir: got.dir,
        };
      }

      case 'insertAnswer': {
        const inFrame = IN_FRAME_ID.exec(payload.fieldId ?? '');
        if (inFrame) {
          return send('insertInFrame', {
            frameId: Number(inFrame[1]),
            fieldId: inFrame[2],
            text: payload.text,
            question: payload.question,
          });
        }
        const { insertAnswer } = await imports.autofill();
        return insertAnswer(payload.fieldId, payload.text, payload.question);
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
        return send('coverLetter', { spec: payload.spec, job: analysis.job, draft: payload.draft, feedback: payload.feedback });

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
          ...filedAs(),
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
            limit: q.limit || undefined,
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
          ...filedAs(),
          url: location.href,
          source: new URL(location.href).hostname,
          status: 'applying',
          coverLetter: payload.coverLetter,
          answers: payload.answers,
          // What this application calls its documents, when it has been told.
          // Absent means "leave whatever the tracker already had" — see
          // `buildBundleNow`, which is why a Recompile does not rename the
          // file somebody has been dragging into this form.
          naming: payload.naming,
        });

      case 'bundle':
        return send('bundle', {
          spec: payload.spec,
          resumeId: payload.spec.id,
          ...filedAs(),
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
          naming: payload.naming,
        });

      case 'setBase': {
        const mine = startProposal();
        await send('setSettings', { patch: { baseResumeId: payload.baseResumeId } });
        const next = await send('analyze', { ...(await applicationPayload()), ...tailoring(payload) });
        // See `startProposal`. Picking two bases in quick succession is
        // ordinary, and so is walking to the next posting while one is still
        // being worked out. See `landLate` for where a superseded one goes,
        // and `overtakenHere` for the one that goes nowhere.
        if (!stillWanted(mine)) return overtakenHere(mine) ? null : landLate(next);
        analysis = next;
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
        const mine = startProposal();
        const next = await send('analyze', { ...(await applicationPayload()), ...tailoring(payload) });
        if (!stillWanted(mine)) return overtakenHere(mine) ? null : landLate(next);
        analysis = next;
        cardHandle?.update(analysis);
        return analysis;
      }

      case 'aiStatus':
        return send('aiStatus', {});

      /*
       * The card's "Try again" after this page's own read failed: the whole
       * pass again, onto the card already up. Forced, because it is a button
       * somebody pressed on a card they are looking at. See `drawError`.
       */
      case 'retry':
        return show({ force: true });

      /** Send the user to ResumeM-M, when that is what the card is offering. */
      case 'openTab':
        return send('openTab', { url: payload.url });

      // Turning ResumeM-M's own AI switch on, from the chip that reports it
      // being off. The switch that needs flipping should be under the hand
      // that is reaching for it.
      case 'setAiEnabled':
        return send('setAiEnabled', { enabled: Boolean(payload.enabled) });

      /** The other switch of the pair: this extension's own opt-in. */
      case 'setUseAi':
        return send('setUseAi', { enabled: Boolean(payload.enabled) });

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

      /*
       * The two answers to "this looked like a different job, so I started a
       * new application". Both write the trail, so both come back as a fresh
       * summary for the card to draw from.
       */
      case 'keepTogether': {
        const put = await send('keepTogether', {});
        if (put?.ok) {
          /*
           * The writing first, then the pages. `setTrail` draws the panel and
           * says nothing to the card about what it is now holding; without
           * this the letter was merged into storage and never appeared, and
           * the keeper wrote the card's empty version over it.
           */
          cardHandle?.restoreWork(put.work ?? null);
          cardHandle?.setTrail(put);
        } else if (put?.gone) {
          cardHandle?.setStatus(
            'That application is not being held any more. Its writing is still where it was left — go back to its page and it comes back.',
          );
        }
        return put;
      }

      case 'keepApart':
        return send('keepApart', {});

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
    const { trimForStorage, pageHtml } = await imports.trail();
    return {
      url: location.href,
      title: document.title,
      html: trimForStorage(pageHtml(document), 2_000_000),
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

  /**
   * Whether this tab is in the middle of an application somebody has written
   * into.
   *
   * The one thing that outranks a low score. The score is a guess about the
   * page; this is a fact about the tab, and a guess must not be allowed to
   * bury work already done — see `openHere` in the worker, and the walk that
   * produced it: Indeed, to a posting, to an application form on a host no
   * pattern knows, whose first paint has almost no words in it. The card
   * withdrew without a word, and the letter written two pages back had no
   * route back to the screen.
   *
   * Carrying on here does not claim the page is a posting. It puts the card
   * up so the question can be asked: `remember` still judges whether this
   * page joins the application, branches from it, or starts a new one, and
   * the branch chip is how it offers to undo a wrong guess.
   *
   * Quiet on failure, because a worker that will not answer is not a reason
   * to start offering on every page.
   */
  let heldFor = { url: null, answer: false };
  async function workIsOpenHere() {
    /*
     * Answered once per address, and the memo is correctness rather than
     * thrift. Both gates ask, and between them `analyze` records this page
     * into the trail — which, where the judge branched, replaces the work
     * with a fresh empty one. Asking again after that would be asking about
     * the application this page just started rather than the one it might
     * have interrupted, and the answer would be "nothing here", which is the
     * behaviour being fixed.
     */
    if (heldFor.url === location.href) return heldFor.answer;
    const held = await send('openHere', { page: pageIdentity() }).catch(() => null);
    // Something written, or this page plainly the next one — see `carriesOn`.
    heldFor = { url: location.href, answer: Boolean(held?.open && (held?.made || held?.carriesOn)) };
    return heldFor.answer;
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
    /*
     * Saying yes to a site you once said no to takes it off the list.
     *
     * The only yes available on a muted host is a deliberate one — the chip
     * does not appear there, so this is the toolbar button, or the chip's own
     * Yes on a host muted from another tab. Either way the person is looking
     * at the site and asking for the card on it, which is the opposite of what
     * muting recorded, and leaving the mute in place would mean the card
     * appears once and is gone again tomorrow with nothing saying why.
     */
    /*
     * Asking for the card is the way back from having put it away, exactly as
     * it is the way back from having muted the site. Both were recorded by
     * somebody pressing something; both are undone by them pressing this.
     */
    if (force) dismissed = false;
    if (force && (settings.mutedHosts ?? []).includes(location.hostname)) {
      await setMuted(false).catch(quietly);
      if (!current()) return;
    }
    if (!force) {
      if (!settings.autoPrompt) return;
      if ((settings.mutedHosts ?? []).includes(location.hostname)) return;
      /*
       * And the sites nobody would ever want an offer on, decided from the
       * address. See `shared/sites.js`: on a social network the words on the
       * page are the problem rather than the evidence, because the page is
       * *about* jobs without being one. Checked here, inside the `!force`
       * branch, so the toolbar button still reaches whatever is in front of
       * you — a "who is hiring" thread is a real thing.
       */
      const { neverOffer } = await imports.sites();
      if (!current()) return;
      if (neverOffer(location.href)) return;
      // A frame saying it holds an application is worth more than the score of
      // the page around it, which on those pages is a heading and an iframe.
      // Everything else still applies: a muted host stays muted, and a page
      // the server does not think is a posting still loses its card below.
      if (!viaFrame && localScore() < settings.minScore && !(await workIsOpenHere())) return;
    }

    const [
      { createCard, removeCard },
      { wantsCoverLetter, looksLikeApplicationForm },
      { createAsk, removeAsk },
    ] = await Promise.all([
      imports.card(),
      imports.autofill(),
      imports.ask(),
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
     * Whether this page is worth reading without being asked.
     *
     * Not the same question as `showNow` above, and conflating the two was
     * the mistake worth writing down: that one is "is this certainly a
     * posting", which decides whether the card can go up *before* the
     * verdict, and it is deliberately strict because a card that appears and
     * leaves is worse than one that arrives late. This one is "is this page
     * part of a hiring system at all", which decides whether the pass runs
     * unasked, and it has to be broader — an application form names no role
     * in its title and carries no structured data, and it is the single most
     * important page this tool has.
     *
     * Three things answer yes. A signal that settles it on its own. Being on
     * an applicant tracker or a job board, which does not make this page a
     * posting — the page after you press submit is on one — but does mean
     * somebody arrived here through a hiring system, and the server's
     * classifier is the thing that decides the rest. And a real application
     * form on the page, found the same way the frame branch finds one.
     *
     * Everything else is a guess, and the guesses were the whole problem: a
     * forum thread about offers, a careers article, a salary page, a
     * newsletter about hiring. Every one of those is *about* jobs without
     * being one, and no amount of reading the words harder separates them.
     * They get the chip, and nothing else happens — the page is not read, not
     * sent anywhere, not classified. Yes runs the whole pass. No records the
     * site as one not to offer on, which is the same switch the popup shows
     * and the same one a later yes undoes. See `ask.js`.
     */
    const worthReading = async () =>
      showNow ||
      ON_A_TRACKER.test(location.href) ||
      ON_A_BOARD.test(location.href) ||
      IN_A_JOBS_AREA.test(location.href) ||
      looksLikeApplicationForm() ||
      /*
       * Or this tab is in the middle of an application somebody has written
       * into, which is the one answer none of the four above can give.
       *
       * This is the gate that actually fired on the walk reported — Indeed,
       * to a posting, to an application form at `/n/c/8f2a1b` on a host no
       * pattern knows, whose form is drawn by script and says nothing at
       * first paint. None of the four match, so the page was not read at
       * all; and the branch below then either asked "is this a job page?"
       * about the form the person was standing on, or, where the trail
       * claimed the page, returned in silence. Both leave no card, and the
       * resume built two pages earlier had nothing left to reach it from.
       *
       * Last, so the four cheap answers short-circuit it and the ordinary
       * page never pays for the message. See `workIsOpenHere`.
       */
      (await workIsOpenHere());
    /*
     * And never in the middle of something already begun.
     *
     * An application is several pages — the form, the questions, the
     * voluntary disclosures, the review — and only the first of them is a
     * decision. Asking "is this a job posting?" on each of the rest is asking
     * somebody to re-answer, four times, a question they answered by starting
     * to fill the thing in. Nearly all of those pages are caught by the
     * signals above, because a form is a form and `/apply/eeo` is in the
     * hiring part of the site; this is for the flows that are neither, and it
     * asks the one source that actually knows — the trail, which is what
     * decides that two pages belong to one application, and which answers
     * with nothing when this page is not part of the one in hand.
     *
     * Only reached once the cheap answers have all come back no, so the
     * ordinary path never pays for it.
     */
    if (!(await worthReading())) {
      if (askedFor === location.href) return;
      const held = await send('trailPages', { page: pageIdentity() }).catch(() => ({ pages: [] }));
      if (!current()) return;
      /*
       * Recorded as settled, not merely skipped. The rescan tick runs every
       * second for a minute and this branch is where it lands, so leaving the
       * mark unset meant asking the worker the same question sixty times —
       * and keeping it awake to answer. Nothing will change the answer: a
       * page that grows a form or a posting stops reaching this branch at
       * all, because `worthReading` answers yes before it.
       */
      if ((held.pages ?? []).length > 0) {
        askedFor = location.href;
        return;
      }
      askedFor = location.href;
      createAsk({
        site: location.hostname,
        onYes: () => void show({ force: true }).catch(quietly),
        onNo: () => void setMuted(true).catch(quietly),
      });
      return;
    }

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
      // The question has been answered by whatever put the card up, so the
      // chip asking it is over — including the one this very call may have
      // left behind on a page that has since declared itself.
      removeAsk();
      if (cardHandle) {
        // The page may have thrown it out; see `putBack` in card.js.
        cardHandle.putBack?.();
        return cardHandle;
      }
      cardHandle = createCard({
        analysis: null,
        resumes: [],
        settings,
        questions: [],
        needsCoverLetter: wantsCoverLetter(),
        /*
         * Whether there is a form on this page at all, which the card cannot
         * see for itself — it lives in a shadow root and reads none of the
         * page. Used only to decide whether the card may reduce itself: see
         * `reducedNow`. Read once, here, because it is read in the same
         * breath as `wantsCoverLetter` and the two answer the same question
         * about the same page.
         */
        isForm: looksLikeApplicationForm(),
        onAction,
        onClose: () => {
          cardHandle = null;
          dismissed = true;
        },
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
    if (showNow && !dismissed) putUpCard();

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
      /*
       * And not asked again on the next tick, unless the page has gained.
       *
       * Only a verdict used to settle the page, so a read that failed left it
       * open — and the rescore tick below fires on any DOM change, which a
       * busy page makes constantly. Measured on a board's results page of
       * 22,500 elements whose timestamps and adverts tick, with the store
       * answering 500: the whole page was copied, scrubbed, serialised and
       * posted twelve times in twelve seconds — 1.9 seconds of the page's main
       * thread spent re-reading what had not changed, heading for sixty
       * multi-megabyte posts over the minute the tick runs. With ResumeM-M
       * simply not open, which is the ordinary state of most browsing, every
       * page above the threshold did the same.
       *
       * Held the way a "not a posting" verdict is held: a page that has grown
       * something since is still worth a second look, and the toolbar button
       * still asks at once.
       */
      if (current()) ruledOut = { url: location.href, score: judgedScore };
      return;
    }
    if (!current()) return;
    analysis = found;
    analysed = mine;

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
    // And not back onto a page it was put away on, unless this pass is the
    // button. `force` cleared `dismissed` on the way in.
    if (dismissed) return;
    putUpCard();
    cardHandle?.update(analysis);
    /*
     * What this page called itself when it was read, for the tick that
     * watches boards which swap the job in place. Recorded here rather than
     * at the top of the pass, because the employer's name is what makes the
     * comparison mean anything and the analysis is where it comes from.
     */
    readAs = {
      company: analysis?.job?.company,
      said: withoutCompany(document.title, analysis?.job?.company),
    };
    // An AI pass that outlived the card it was started from. See `landLate`.
    takeLateProposal();

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
    cardHandle?.restoreWork(carried?.work ?? null, carried?.recovered);
    // Say so when it came from a tab that was closed rather than from the
    // page before: finding your letter back without being told is its own
    // kind of unsettling.
    if (carried?.work && carried.recovered) {
      // Two rescues, two sentences. 'job' is this tab going back to a job it
      // had already started — on a board that shows several at one address,
      // that is a click, not an accident, and "before this tab closed" would
      // read as the extension having lost track of a tab that never went
      // anywhere.
      // And whose it was, where the worker could not check it against this
      // page — see `takeWork`. A page it cannot name is exactly the page you
      // cannot tell a wrong rescue from a right one on.
      cardHandle?.setStatus(
        carried.recovered === 'job'
          ? 'Brought back what you had written for this job.'
          : carried.recoveredFor
            ? `Recovered what you had written for ${carried.recoveredFor} before this tab closed.`
            : 'Recovered what you had written before this tab closed.',
      );
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
    /*
     * And what gets chosen on this form, so the next one can offer it back.
     *
     * Started here rather than at document idle because this is the point the
     * page has been read and found to be an application: watching every page
     * somebody visits for what they select is not a thing this should do, and
     * there is nothing to learn from a page that is not a form.
     *
     * Nothing personal leaves the page. `watchChoices` puts every answer
     * through `worthRemembering` before telling anyone, so the refusal
     * happens in the document rather than at the far end of a message.
     */
    imports
      .autofill()
      .then(({ watchChoices, watchTyped, looksLikeApplicationForm, findQuestions }) => {
        if (!current()) return;
        /*
         * The choices are watched only once this page is a form, and that
         * can be later than now. See below.
         */
        const watchTheForm = () => {
          if (stopChoices || !looksLikeApplicationForm()) return;
          stopChoices = watchChoices((said) => {
            if (!said.keep) return;
            send('rememberChoice', { question: said.question, answer: said.answer }).catch(() => undefined);
          });
          /*
           * And what is typed, held until the form is sent or left. An
           * emptied box, or one whose answer is refused, takes its question
           * off the list; one the person said not to keep stays off it.
           */
          typedWatch?.stop();
          typedWatch = watchTyped(
            (said) => {
              if (said.keep && !typedNotKept.has(said.question)) {
                typedToKeep.set(said.question, { answer: said.answer, itemId: said.itemId });
              } else typedToKeep.delete(said.question);
              showTypedToKeep();
            },
            { profile: () => typedProfile, company: companyHere },
          );
        };
        /*
         * And its questions, for a form that moves on in place — watched on
         * any page the card is up on, not only one that already looked like
         * a form when it was read.
         *
         * Workday reads as a route change and draws its first step seconds
         * later, so the page was read as "Loading…", did not look like a
         * form, and no watcher was started; every step after that is swapped
         * in where the last one was with the address unchanged, so nothing
         * read the page again. "Why are you interested in working for
         * CrowdStrike?" was on the page and never on the card. The watcher
         * only reads while a card is up, so this costs nothing anywhere else,
         * and it is what notices the form arriving — which is when the
         * choices start to be watched too.
         *
         * One watcher, for the reason given below for the choices.
         */
        stopQuestions?.();
        stopQuestions = watchQuestions(findQuestions, current, watchTheForm);
        /*
         * One watcher, whatever number of passes found the form.
         *
         * The function that stops watching was thrown away, and a pass runs on
         * every url change of a single-page form, every press of the toolbar
         * button and every return from the back / forward cache — each adding
         * a pair of document listeners for the life of the page. Measured in
         * tests/worker.mjs: a form taken through three `pushState` steps sent
         * one choice to the store four times, and each radio click ran a
         * whole-document scan once per listener.
         */
        stopChoices?.();
        stopChoices = null;
        watchTheForm();
      })
      .catch(() => undefined);

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
    const { watchForSending: watch, watchForReceipt: watchReceipt } = await imports.sending();
    /*
     * And the page saying it has the application, for a send whose press was
     * never seen. Filed from the trail rather than from `analysis`: the
     * receipt is usually a page the card never read. See
     * `applicationSentHere`, which decides whether it belongs to this tab's
     * application at all.
     */
    const sayReceived = (how) =>
      send('applicationSentHere', { note: how, url: location.href, receipt: true })
        .then((reply) => {
          if (reply?.ok !== false) cardHandle?.setStatus?.('Recorded as sent.');
        })
        .catch(() => undefined);
    const took = (how) => {
      // What was typed on it is kept whatever becomes of the record. See `keepTyped`.
      keepTyped();
      /*
       * Only on the page where an application is actually sent.
       *
       * "Apply Now" ends the application on ADP and opens it on almost every
       * description page there is — the same words for the opposite act. Taken
       * anywhere, it filed every posting you so much as opened as one you had
       * sent, which is the worst thing this could do: a job marked as done
       * comes off the list of things to finish.
       *
       * Said out loud, because the watcher only has one send to give and a
       * press this declined must not be the one that spends it.
       */
      if (analysis?.kind !== 'application') return false;

      const named = analysis?.spec?.generatedFor;
      // Nothing to file it under. The card knows a posting by what the
      // analysis made of it, and without that this is just a form.
      if (!named?.company || !named?.role) return false;

      /*
       * Said after it is true, not before.
       *
       * This fired the message, swallowed its rejection, and announced
       * "Recorded as sent." on the next line whatever came back — and
       * `applicationSent` answers `{ ok: false }` rather than throwing when
       * the store cannot be reached, on the reasoning that a person who has
       * just sent an application should not be interrupted by it. So with
       * ResumeM-M closed, submitting a real form measured as:
       *
       *   card says           : "… | Recorded as sent."
       *   tracker after       : applying
       *
       * Nothing recorded, the claim made anyway, and the old `return true`
       * spent the one send this document had — so starting the store and
       * pressing Submit again did nothing either. This file's header calls a
       * wrong "yes" the worst failure available; that was one.
       */

      /*
       * Flushed here, not left to the keeper.
       *
       * `holdASpace` — the thing that opens the Workspace draft — only runs
       * off `saveWork`, which this page's keeper otherwise sends on a plain
       * two-second interval. A short form is read, filled and sent well
       * inside that window, so `applicationSent` could reach the store,
       * mark the tracker row `applied`, and return — before the interval
       * had ticked even once. No draft existed yet for `/api/extension/sent`
       * to find and close, and none was ever going to arrive: the next tick
       * would have opened one, but nobody presses Submit twice to give it
       * the chance.
       *
       * Measured against tests/sending.mjs with the call below removed: four
       * of the twenty-four sending fixtures had their draft opened a whole
       * keeper tick after the application was filed as sent, and under the
       * parallel runner one came back `applied` with no draft at all.
       *
       * Fired, not awaited: this is the same fire-and-forget write
       * `saveWork` already makes off every keeper tick, and waiting for it
       * here would hold up telling the person their application went out
       * for a write this route does not need the answer to.
       */
      saveWorkNow?.();

      return send('applicationSent', {
        company: named.company,
        role: named.role,
        url: location.href,
        note: how,
      })
        .then((reply) => {
          if (reply?.ok === false) {
            cardHandle?.setStatus?.('Not recorded — ResumeM-M could not be reached.');
            return false;
          }
          cardHandle?.setStatus?.('Recorded as sent.');
          return true;
        })
        .catch(() => {
          cardHandle?.setStatus?.('Not recorded — ResumeM-M could not be reached.');
          return false;
        });
    };

    stopSending = watch(document, took);
    stopReceipt = watchReceipt(document, sayReceived);
    /*
     * And begun again at each posting, because the watcher is one send per
     * document and a single-page board is one document for the afternoon.
     *
     * Without this, sending the first application on a board latched it: every
     * posting applied to after that one, in that tab, went out unrecorded and
     * stayed on the list of things still to do. The document never goes away
     * to take the latch with it — a route change is the only navigation there
     * is here.
     */
    restartSending = () => {
      stopSending?.();
      stopSending = watch(document, took);
      stopReceipt?.();
      stopReceipt = watchReceipt(document, sayReceived);
    };
    teardown.push(() => stopSending?.());
    teardown.push(() => stopReceipt?.());
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
      // Handed back, so a caller that must know the save has landed can wait
      // for it. See `jh-flush-work`.
      return send('saveWork', { work, page: pageIdentity() }).catch(() => undefined);
    };
    saveWorkNow = save;
    every(2000, save);

    /*
     * And the store, watched while the card is in front of somebody.
     *
     * The card builds from ResumeM-M and then holds what it built, so a
     * change made there — a variation saved, a bullet reworded, the copy
     * edited — reached it only on coming back to the tab, and a new
     * variation not at all until the card was put up again. The store says in
     * one short string whether anything has moved (`/api/revision`); asked
     * every few seconds while this tab is visible, and never while it is not,
     * and the card is told the moment it does. See `storeChanged` in the card.
     */
    let revision = null;
    /*
     * Where things stand, read now rather than on the first tick: a change
     * made in the four seconds after the card went up was otherwise taken
     * for where things started, and never reached it.
     */
    send('revision')
      .then((r) => {
        revision ??= r?.revision ?? null;
      })
      .catch(() => undefined);
    every(4000, async () => {
      if (document.visibilityState !== 'visible' || !cardHandle?.storeChanged) return;
      const now = (await send('revision').catch(() => null))?.revision;
      if (!now) return;
      const moved = revision !== null && now !== revision;
      revision = now;
      if (!moved) return;
      await cardHandle?.storeChanged?.();
      // And the answer bank, matched again for the questions listed. See
      // `setMatches` in the card.
      const { questions } = await gatherQuestions().catch(() => ({ questions: [] }));
      if (questions.length) cardHandle?.setMatches?.(questions);
    });
    // A navigation is exactly when this matters, and exactly when an interval
    // is least likely to have just run.
    const onHide = () => save();
    window.addEventListener('pagehide', onHide);
    // And what was typed on the form, which is kept when the form is left and
    // not when the tab is merely hidden. See `keepTyped`.
    window.addEventListener('pagehide', keepTyped);
    // Coming back from the builder is the worker's news to break, not this
    // listener's — see the `jh-came-back` message.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onHide();
      /*
       * And back in view: whatever was changed in ResumeM-M meanwhile may
       * not be what the card is holding. See `checkFresh` in the card.
       */
      else cardHandle?.checkFresh?.().catch?.(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibility);

    /*
     * Coming back with the Back button is this listener's, though, and there
     * was nothing listening for it.
     *
     * `persisted` is the whole of the difference: false is an ordinary load,
     * where the script is running from the top anyway and has already done all
     * of this. True means the document was restored whole from the back /
     * forward cache — nothing re-ran, and the tab's trail has moved on to
     * whatever was visited in between. See `startOver`.
     */
    const onShow = (event) => {
      if (event.persisted) void startOver();
    };
    window.addEventListener('pageshow', onShow);

    teardown.push(() => {
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pagehide', keepTyped);
      window.removeEventListener('pageshow', onShow);
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
      .then(({ watchForSending, watchForReceipt }) => {
        // Answering whether it was taken, for the same reason the top
        // document does: the one send a frame has must not be spent on a
        // record that never reached the store.
        watchForSending(document, (how) =>
          send('applicationSentHere', { note: how, url: location.href })
            .then((reply) => reply?.ok !== false)
            .catch(() => false),
        );
        /*
         * And the receipt, which on an embedded board is drawn in here: the
         * frame goes to Greenhouse's confirmation while the careers page
         * around it stays exactly as it was. Sent with the origins above it,
         * because this frame's own address is the board's, not the employer's.
         */
        watchForReceipt(document, (how) =>
          send('applicationSentHere', {
            note: how,
            url: location.href,
            receipt: true,
            above: [...(location.ancestorOrigins ?? [])],
          }).catch(() => undefined),
        );
      })
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

        /*
         * And the upload boxes in this frame. Half the portals that split a
         * form across an embed put the attachment control in the embed.
         */
        case 'jh-frame-attach':
          answer(
            Promise.all([imports.attach(), imports.autofill()]).then(
              ([{ attachFiles }, { looksLikeApplicationForm }]) =>
                /*
                 * Behind the same guard as `jh-frame-fill`, and for a
                 * stronger reason.
                 *
                 * Every frame on the page runs this script and every frame is
                 * asked, so an advert, a chat widget or a survey embed with a
                 * file input in it was a place the resume could land — and a
                 * resume is a name, an address, a phone number and an
                 * employment history in one file. `fillForm` has always
                 * checked that the frame is actually an application before
                 * giving it a single field; this gave a whole document to
                 * anything with a box.
                 */
                looksLikeApplicationForm()
                  ? attachFiles(message.payload?.files ?? [])
                  : { placed: [], unplaced: [], boxes: 0 },
            ),
          );
          return true;

        /*
         * A chip is in the air over the page this frame is part of.
         *
         * The card lives in the top frame and the drop lands in whichever
         * document the pointer is over — which, on half the portals that
         * matter, is an embed. Without this the frame under the pointer never
         * knew a drag was happening and let go of the file into nothing.
         *
         * Behind the same guard as `jh-frame-attach`, and for the same
         * reason: every advert and chat widget on the page runs this script,
         * and a resume is a name, an address and an employment history in one
         * file. A frame that is not an application form is told nothing and
         * installs nothing.
         */
        case 'jh-frame-dragging':
          answer(
            imports.autofill().then(({ looksLikeApplicationForm }) => {
              const files = message.payload?.files ?? [];
              if (files.length === 0) {
                inTheAir = null;
                return { watching: false };
              }
              if (!looksLikeApplicationForm()) return { watching: false };
              inTheAir = files;
              watchForDrops();
              return { watching: true };
            }),
          );
          return true;

        case 'jh-frame-fill':
          answer(
            imports.autofill().then(({ looksLikeApplicationForm }) =>
              // The one that must not be got wrong. Anything else on the page
              // gets nothing about the person using it.
              looksLikeApplicationForm()
                ? fillThisDocument(message.payload?.fields ?? {}, message.payload?.history ?? [], message.payload?.education ?? [])
                : { filled: [], skipped: [] },
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
              ([{ looksLikeApplicationForm }, { trimForStorage, pageHtml }]) =>
                looksLikeApplicationForm()
                  ? {
                      url: location.href,
                      title: document.title,
                      html: trimForStorage(pageHtml(document), 400_000),
                    }
                  : { html: '' },
            ),
          );
          return true;

        case 'jh-frame-insert':
          answer(
            imports
              .autofill()
              .then(({ insertAnswer }) =>
                insertAnswer(message.payload?.fieldId, message.payload?.text, message.payload?.question),
              ),
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
      if (!cardHandle && !dismissed) show({ viaFrame: true }).catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    /*
     * A frame took a drop, and the card is here rather than there.
     *
     * The drop lands in whichever document the pointer is over, which on a
     * board that embeds its form is never this one — but the account of where
     * the file went belongs on the card, and the card is in the top frame.
     * It comes back through the worker, which is the only thing that can
     * address this frame from that one.
     */
    if (message?.type === 'jh-frame-dropped') {
      cardHandle?.dropped(message.payload?.report);
      sendResponse({ ok: true });
      return false;
    }
    /*
     * "Which application is this page, as far as you know?"
     *
     * Asked by the worker when a form inside a frame has just been sent. A
     * frame has no card and no analysis of its own, so it cannot name what it
     * has just submitted; the worker reads the trail instead, and the trail
     * is written by a keeper on a two-second interval. Press Submit inside an
     * embedded form faster than that — which is what happens when the resume
     * was already built and the fields were already filled — and the send
     * found nothing to file it under and was dropped. The top document has
     * known the answer since the card went up.
     */
    if (message?.type === 'jh-what-is-this') {
      /*
       * No `kind === 'application'` guard here, deliberately.
       *
       * That guard belongs on *this* document's own watcher, where it stops
       * "Apply Now" on a description page being read as the application going
       * out. This question is only ever asked after a frame has already
       * decided a form was submitted, and on an embedded board the outer page
       * is precisely the description — it holds a heading and an iframe. The
       * frame gets no second opinion by design; refusing to name what it sent
       * was one anyway, and the answer was always no.
       */
      const named = analysis?.spec?.generatedFor;
      sendResponse({
        ok: true,
        data: named?.company && named?.role ? { company: named.company, role: named.role } : null,
      });
      return false;
    }
    /*
     * The worker asking for this page's work now, because a frame on it has
     * just reported a send and nothing was flushed with it — a frame's script
     * runs no keeper. The card and the keeper are here.
     *
     * Answered once the worker has taken the save, not the moment it is sent:
     * the two travel separately, and an answer that overtook its own save left
     * the worker nothing to wait for.
     *
     * In this listener, the top document's. It was written into the frames'
     * listener behind a check that only the top frame answers — never so in
     * that listener — so nobody answered, and every send from an embedded
     * form was filed without waiting for its draft: "embedded-apply" in
     * tests/sending.mjs, the draft opened 298ms to 1.4s after the send
     * whenever Submit beat the keeper's tick.
     */
    if (message?.type === 'jh-flush-work') {
      Promise.resolve(saveWorkNow?.())
        .then(() => sendResponse({ ok: true, data: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
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
        // Asynchronous now — it fetches the copy as the builder left it — so
        // a failure there is caught the same way a throw here is.
        Promise.resolve(cardHandle?.cameBack?.()).catch(() => undefined);
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
  // Reset by a route change, which is a page as far as this is concerned: see
  // `startOver`.
  let loadedAt = Date.now();
  let pageChanged = false;
  const watcher = new MutationObserver(() => {
    pageChanged = true;
  });
  /*
   * The document, not its root element. Attached to `documentElement`, the
   * observer followed that element and nothing else: a page that builds its
   * finished document off to one side and swaps it in with
   * `document.replaceChild(next, document.documentElement)` left it watching
   * the detached old root, so the shell was scored once and the posting that
   * replaced it never — no card, under a title naming the role and a JSON-LD
   * JobPosting (tests/worker.mjs). And a page with no root element at all by
   * document idle threw here, at the top of the script, into the page's
   * console, stopping everything below this line.
   */
  watcher.observe(document, { childList: true, subtree: true });
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

  /*
   * And the board that swaps the job without changing anything else.
   *
   * The tick below watched the url, which covers every board that routes —
   * and Indeed's results pane does not route. The list is on the left, the
   * posting is on the right, and clicking down the list replaces the posting
   * in place. Nothing navigates, nothing pushes state, the url is the search
   * you arrived on. So the card sat there showing the first job while
   * somebody read the fourth, the trail held the first job's description, and
   * a letter written from that card was written about a job the user had
   * stopped looking at four clicks ago. This is the case every other rule in
   * `trail.js` cannot reach, because all of them are about *where* pages are
   * and here they are all in the same place.
   *
   * What is left to read is what the page calls itself. The employer's name
   * comes out of it first — every one of these titles carries it, and leaving
   * it in means two jobs at one company always have a word in common — and
   * what remains goes to `plainlyAnotherRole`, which is the same conservative
   * test the trail uses: an opinion only when the two share no word at all.
   * "Platform Engineer" and "Data Scientist" is a different job; "Platform
   * Engineer" and "Senior Platform Engineer (Remote)" is not, and a form page
   * retitling itself mid-application is not either.
   *
   * Starting over is all this does. Whether the new job is a branch, or the
   * same application after all, is `judgeApplication`'s to answer, on a page
   * that has actually been read.
   */
  let readAs = null;

  /** Loaded once and held, because the tick cannot await. */
  let plainlyAnotherRole = null;
  imports
    .trail()
    .then((m) => {
      plainlyAnotherRole = m.plainlyAnotherRole;
      employerKey = m.employerKey;
      titleKey = m.titleKey;
    })
    .catch(quietly);

  /**
   * A title with the employer's name taken out of it.
   *
   * Substring rather than a pattern: a company name is arbitrary text and
   * building a regular expression out of it is one `C++ Systems (Ltd.)` away
   * from throwing on a page that did nothing wrong.
   */
  const withoutCompany = (text, company) => {
    const said = String(text ?? '');
    const co = String(company ?? '').trim().toLowerCase();
    if (!co) return said;
    const lower = said.toLowerCase();
    let out = '';
    let from = 0;
    for (;;) {
      const at = lower.indexOf(co, from);
      if (at === -1) return out + said.slice(from);
      out += `${said.slice(from, at)} `;
      from = at + co.length;
    }
  };

  /**
   * Start this page again, as though it had just been opened.
   *
   * Two things arrive here. A route change on a single-page board, which is
   * the only kind of navigation those have. And a restore from the back /
   * forward cache, which looks like nothing at all from in here: the document,
   * the card and the half-written letter all come back exactly as they were
   * frozen, no script re-runs, and `location.href` is what it already was —
   * it changed and changed back while this document sat still.
   *
   * The tab did not sit still. Going to the next posting made the trail that
   * posting's, so a card restored onto the previous one is a card writing into
   * an application the tab has moved on from: every two-second save is refused
   * by `sameApplication` and the refusal is caught and dropped, so the letter
   * stays on screen and nothing holds it. The toolbar names the other posting
   * while the user is looking at this one.
   *
   * Reloading was the only path that ever worked, and it worked because it
   * runs all of this. So a restore runs it too.
   *
   * Not visible to the suite, which is why it lasted: Playwright launches
   * Chromium with `--disable-back-forward-cache`, so every `goBack()` in the
   * tests is a reload. Measured both ways on the same page — as the suite
   * launches it, `pageshow.persisted` is false and JavaScript state is gone;
   * with the flag left off, `persisted` is true and the state is still there.
   */
  const startOver = () => {
    /*
     * Save before anything else. On a single-page board this is the only
     * kind of navigation there is — `pagehide` never fires — and the card
     * was torn down here without a save, so up to two seconds of letter or
     * answer went with it.
     */
    saveWorkNow?.();
    // And what was typed on the form being left, while it is still this page's. See `keepTyped`.
    keepTyped();

    // Saved, and now shut again until the next page's card has been offered
    // what that save just put away. Without this a route change kept the
    // open gate from the page before, which is the race this closes.
    workRestored = false;

    /*
     * And what the *previous* posting's form asked for, which is not a fact
     * about this one.
     *
     * `letterInFrame` is learnt from a frame scan and never went back to
     * false, so on a single-page board — LinkedIn, Workday, Ashby, where
     * this is the only kind of navigation there is — one posting whose
     * embedded form wanted a cover letter made every posting looked at
     * afterwards in that tab demand one too.
     *
     * Measured against the same posting two ways. Loaded fresh it offers
     * the letter as something to add; reached by route change from a
     * posting that wanted one, it asserts a letter is required and drops
     * the offer:
     *
     *   fresh tab      {"role":"Data Scientist","addLetter":true}
     *   after the hop  {"role":"Data Scientist","addLetter":false}
     *
     * Downstream that is an unrequested letter drafted by `maybeAutoDraft`,
     * a Submit blocked for "missing a cover letter", and
     * `coverLetterRequired: true` handed to the editor.
     */
    letterInFrame = false;

    // And the one send this document's watcher had to give, which the
    // posting you have just left may already have spent.
    restartSending?.();

    /*
     * And the second look, for the page this is now.
     *
     * The window it runs in was counted from when the document loaded and
     * the watcher was switched off for good when it closed, so a route change
     * a minute in — reading a posting for longer than that before pressing
     * Apply — got the one look this function takes, a few hundred
     * milliseconds after the url changed, at a form the board had not drawn
     * yet. Nothing looked again. A route change is a new page here in every
     * other respect, and it is one for this too.
     */
    loadedAt = Date.now();
    pageChanged = false;
    watcher.observe(document, { childList: true, subtree: true });

    // And the choices watcher, which was for the form you have just left: the
    // next page is watched only if its own pass finds a form on it.
    stopChoices?.();
    stopChoices = null;
    typedWatch?.stop();
    typedWatch = null;
    typedNotKept.clear();
    stopQuestions?.();
    stopQuestions = null;

    // Before the await, not after: the pass still running belongs to the url
    // that just went away, and it must stop being able to write to the card
    // from this instant rather than from whenever the import resolves.
    supersede();
    return (async () => {
      const [{ removeCard }, { removeAsk }] = await Promise.all([imports.card(), imports.ask()]);
      removeCard();
      // And the chip, which was asking about the page you have just left.
      removeAsk();
      cardHandle = null;
      // A new page is not the page anything was put away on.
      dismissed = false;
      await show().catch(quietly);
    })();
  };

  every(1000, () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      readAs = null;
      return startOver();
    }

    /*
     * A card the page took off, put back — before anything below reads
     * `cardHandle` as "the card is up". See `putBack` in card.js: a page that
     * re-renders its root throws the host out with it, and the handle kept
     * every route back closed for the life of the page.
     */
    if (cardHandle && !dismissed) cardHandle.putBack?.();

    // The board that swaps the job and changes nothing else. See `readAs`.
    if (
      cardHandle &&
      readAs &&
      plainlyAnotherRole &&
      plainlyAnotherRole(withoutCompany(document.title, readAs.company), readAs.said)
    ) {
      readAs = null;
      return startOver();
    }

    if (Date.now() - loadedAt > RESCORE_WINDOW_MS) {
      watcher.disconnect();
      return;
    }
    if (cardHandle || dismissed || !pageChanged) return;
    pageChanged = false;
    if (ruledOut?.url === location.href && localScore() <= ruledOut.score) return;
    /*
     * A page already asked about is not asked about again — but it is still
     * watched, because a board that serves a shell and fetches the posting
     * can settle the question a second after the chip went up, and when it
     * does the card is owed. `decisiveSignal` is two selectors and the title,
     * which is what makes it cheap enough to ask every tick.
     */
    if (askedFor === location.href && !decisiveSignal()) return;

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
    // Same reasoning: a chip whose Yes throws is worse than no chip.
    imports.ask().then(({ removeAsk }) => removeAsk()).catch(() => undefined);
    cardHandle = null;
    stopChoices?.();
    typedWatch?.stop();
    stopQuestions?.();
  });

  // A missing server must not spam every page the user opens.
  show().catch(quietly);
})();
