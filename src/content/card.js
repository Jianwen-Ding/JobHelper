/**
 * The corner card. Lives in a shadow root so no job board's stylesheet can
 * reach it and nothing it does leaks back onto the page.
 *
 * The interaction it is built around: propose, show what changed and why in
 * words rather than ids, and let the user redirect it before anything is
 * written. Everything it drafts — resume, cover letter, answers — comes out of
 * the store, so it works with the AI switched off.
 */

const STYLE = `
/*
 * The same visual system as the ResumeM-M editor, restated here because a
 * shadow root inherits nothing. Everything is scoped to :host, so no job
 * board's stylesheet can reach in and nothing here leaks out.
 */
:host { all: initial; }
* { box-sizing: border-box; }

.card {
  /* Google's Workspace palette, matching the editor. */
  --accent: #1a73e8;
  --accent-hover: #1967d2;
  --accent-soft: #e8f0fe;
  --ink: #202124;
  --ink-soft: #3c4043;
  --muted: #5f6368;
  --faint: #80868b;
  --line: #dadce0;
  --line-soft: #f1f3f4;
  --panel-sunk: #f8f9fa;
  --good: #188038;
  --good-bg: #e6f4ea;
  --good-line: #ceead6;
  --bad: #d93025;
  --bad-bg: #fce8e6;
  --bad-line: #f6aea9;
  --warn: #b06000;
  --warn-bg: #fef7e0;
  --warn-line: #feefc3;
  --state-hover: rgba(60, 64, 67, .08);
  --accent-hover-layer: rgba(26, 115, 232, .08);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  position: fixed;
  top: 14px;
  right: 14px;
  width: 420px;
  max-height: calc(100vh - 28px);
  display: flex;
  flex-direction: column;
  background: #fff;
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 4px 4px 0 rgba(60, 64, 67, .30), 0 8px 12px 6px rgba(60, 64, 67, .15);
  font: 13px/1.5 "Google Sans Text", "Google Sans", Roboto, -apple-system,
        BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  z-index: 2147483647;
}

.head {
  display: flex; align-items: center; gap: 8px;
  padding: 0 12px; height: 42px;
  border-bottom: 1px solid var(--line-soft); flex: 0 0 auto;
}
/* Same mark as the editor, so the two plainly belong together. */
.head b {
  font-size: 14px; font-weight: 500; color: var(--muted);
  display: flex; align-items: center; gap: 8px;
}
.head b::before {
  content: ""; width: 16px; height: 16px; border-radius: 5px;
  background: linear-gradient(145deg, var(--accent), #5b86e8);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.55);
}
.head .spacer { margin-left: auto; }
.body { padding: 12px; overflow: auto; flex: 1 1 auto; }

/* Whether an AI is in play, stated in the header rather than left to be
   inferred from whether the wording came out any good. */
.ai {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
  cursor: default; white-space: nowrap;
}
.ai::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ai.on { background: var(--accent-soft); color: var(--accent); }
.ai.off { background: var(--line-soft); color: var(--muted); }
.ai.warn { background: var(--warn-bg); color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn-line); }
.ai.actionable { cursor: pointer; }
.ai.actionable:hover { filter: brightness(.96); }

/*
 * Three ways to tailor, side by side, with the one in use marked — and a
 * fourth, quieter, that leaves for the builder. Four does not fit one line of
 * a 380px card, so the row wraps rather than squeezing every label to an
 * ellipsis; min-width is what stops flex shrinking them past legibility.
 */
.build-modes { gap: 6px; flex-wrap: wrap; }
button.mode { flex: 1 1 auto; min-width: 104px; font-size: 12px; padding: 6px 8px; }
button.mode.on {
  border-color: transparent; color: #174ea6;
  background: var(--accent-soft); font-weight: 500;
}
button.mode.on:hover { background: #d2e3fc; }
/* A third way out, offered quietly beside the two that rebuild the resume. */
button.mode.ghost { flex: 0 0 auto; color: #5f6368; }

/*
 * Pressing one of these costs minutes and, depending on the command, money;
 * the button beside it is instant. The mark goes on the ones that start AI
 * work and on no others.
 */
button.ai-action { display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
.ai-mark { color: #1a73e8; font-size: 0.9em; line-height: 1; }
button.ai-action:disabled .ai-mark { color: inherit; opacity: 0.5; }

button {
  font: inherit; font-weight: 500; padding: 7px 16px;
  border: 1px solid var(--line); border-radius: 999px;
  background: #fff; color: var(--accent); cursor: pointer; white-space: nowrap;
  transition: background .15s, border-color .15s, box-shadow .15s;
}
button:hover { background: var(--accent-hover-layer); }
button.primary {
  background: var(--accent); border-color: transparent; color: #fff;
  box-shadow: 0 1px 2px 0 rgba(60,64,67,.30), 0 1px 3px 1px rgba(60,64,67,.15);
}
button.primary:hover {
  background: var(--accent-hover);
  box-shadow: 0 1px 2px 0 rgba(60,64,67,.30), 0 2px 6px 2px rgba(60,64,67,.15);
}
button.icon {
  border: 0; padding: 4px 8px; color: var(--muted); font-size: 17px; line-height: 1;
  background: none; border-radius: 999px;
}
button.icon:hover { color: var(--ink); background: var(--line-soft); }
button.tiny { padding: 4px 11px; font-size: 12px; border-color: transparent; background: none; color: var(--muted); }
button.tiny:hover { background: var(--state-hover); color: var(--ink); }
button.link {
  border: 0; background: none; color: var(--accent); padding: 3px 6px; font-size: 12px;
  box-shadow: none; font-weight: 500;
}
button.link:hover { background: var(--accent-soft); }
button:disabled { opacity: .38; cursor: default; }
button:disabled:hover { background: #fff; border-color: var(--line); }

.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.row.gap { margin-top: 10px; }
.grow { flex: 1 1 auto; }
.hint { color: var(--muted); font-size: 12px; line-height: 1.55; }
/* A hint you are meant to act on, rather than one that just explains. */
.hint.warn {
  color: var(--warn); background: var(--warn-bg); border: 1px solid var(--warn-line);
  border-radius: 7px; padding: 7px 9px; margin-top: 8px;
}
/*
 * Underlined standing still, not only on hover. Set in the same amber as the
 * sentence around it, a bold word is not an affordance — the one thing here
 * you can press read as emphasis, in a line whose whole purpose is to be
 * pressed.
 */
.hint.warn button.link {
  color: var(--warn); font-weight: 500; padding: 0;
  text-decoration: underline; text-underline-offset: 2px;
}
.hint.warn button.link:hover { background: transparent; text-decoration-thickness: 2px; }
.faint { color: var(--faint); font-size: 11px; }

.job { margin-bottom: 12px; }
.job .role { font-weight: 500; font-size: 16px; line-height: 1.3; }
.job .co { color: var(--muted); margin-top: 1px; }

/* The pages one application is spread across. */
.trail { margin-top: 7px; font-size: 12px; }
.trail summary { cursor: pointer; color: var(--muted); }
.trail summary:hover { color: var(--ink); }
.trail-row { display: flex; align-items: center; gap: 6px; padding: 3px 0 3px 12px; }
.trail-row .what { color: var(--faint); white-space: nowrap; }
.trail-row .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; }
.trail-kept { color: var(--good); padding: 3px 0 3px 12px; }


/* Each step is a labelled block, so the card reads as a sequence. */
.step { border-top: 1px solid var(--line-soft); padding-top: 11px; margin-top: 12px; }
.step:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.step-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.step-head .n {
  width: 18px; height: 18px; border-radius: 50%; background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: 0 0 auto;
}
.step-head .t { font-weight: 500; font-size: 14px; }
.step-head .done { background: var(--good-bg); color: var(--good); }

.fit {
  padding: 9px 12px; border-radius: 8px; font-size: 12px; margin: 8px 0; font-weight: 500;
  background: var(--good-bg); border: 1px solid transparent; color: #0d652d;
}
.fit.bad { background: var(--bad-bg); color: #b31412; }
.fit.idle { background: var(--line-soft); border-color: transparent; color: var(--muted); font-weight: 400; }

/* What the tailoring changed, in words. */
.changes { display: grid; gap: 6px; margin: 8px 0 2px; }
.change { background: var(--panel-sunk); border: 1px solid var(--line-soft); border-radius: 8px; padding: 8px 10px; }
.change .where {
  font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: .07em; font-weight: 650;
}
.change .swap { font-size: 12.5px; margin-top: 2px; }
.change .swap .to { font-weight: 640; }
.change .swap .arrow { color: var(--faint); padding: 0 4px; }

/* The before/after against the base resume: what the page used to say, and
   what it says now. Same shape as the editor's version history, so the two
   read identically. */
.diff-head {
  display: flex; align-items: baseline; gap: 6px; margin-bottom: 2px;
  font-size: 11px; color: var(--muted);
}
.diff-head .from-label, .diff-head .to-label { font-weight: 600; color: var(--ink-soft); }
.diff-head .arrow { color: var(--faint); }
.diff-head .count { margin-left: auto; color: var(--faint); }
/* The way out of the changes, where the changes are. */
.diff-head .undo-all { padding: 0 0 0 8px; font-size: 11px; }
.change .ba { display: grid; gap: 2px; margin-top: 3px; }
.change .ba del, .change .ba ins {
  display: block; font-size: 12px; line-height: 1.45; text-decoration: none;
  padding: 2px 7px; border-radius: 4px;
}
.change .ba del {
  color: var(--muted); background: var(--bad-bg);
  text-decoration: line-through; text-decoration-color: #f1cbc7;
}
.change .ba ins { color: var(--ink); background: var(--good-bg); }
.change .ba .plain { font-size: 12px; color: var(--ink-soft); }
.change.added { border-left: 2px solid #c6e3d2; }
.change.removed { border-left: 2px solid #f1cbc7; }
.change.reworded, .change.changed { border-left: 2px solid var(--accent-soft); }
.change .text { color: var(--ink-soft); font-size: 12px; margin-top: 4px; line-height: 1.5; }
.change .text strong { font-weight: 640; color: var(--ink); }
.change .text code, .suggestion code {
  font-family: var(--mono); font-size: .92em; background: var(--line-soft); border-radius: 3px; padding: 0 3px;
}
.change .why { margin-top: 5px; }
.kw {
  display: inline-block; background: var(--accent-soft); color: var(--accent); border-radius: 999px;
  padding: 0 7px; font-size: 11px; margin: 0 3px 2px 0; font-weight: 500;
}
.no-change {
  color: var(--muted); font-size: 12px; background: var(--panel-sunk);
  border: 1px solid var(--line-soft); border-radius: 7px; padding: 8px 10px;
}

textarea {
  width: 100%; min-height: 60px; font: inherit; padding: 8px;
  border: 1px solid var(--line); border-radius: 6px; resize: vertical; color: var(--ink); background: #fff;
  line-height: 1.55;
}
textarea:focus-visible { outline: 0; border-color: #c8d8f7; box-shadow: 0 0 0 3px var(--accent-soft); }
textarea.tall { min-height: 160px; }
select {
  font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px;
  max-width: 100%; background: #fff; color: var(--ink);
}

.suggestion { border: 1px solid var(--warn-line); background: var(--warn-bg); border-radius: 7px; padding: 9px; margin-bottom: 6px; }
.suggestion .why { color: var(--warn); font-size: 11px; margin-top: 5px; }

.q { border: 1px solid var(--line-soft); border-radius: 7px; padding: 9px; margin-bottom: 7px; background: var(--panel-sunk); }
.q .qt { font-weight: 620; font-size: 12.5px; margin-bottom: 5px; line-height: 1.45; }
.q .badge {
  display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; margin-left: 6px;
  background: var(--good-bg); color: var(--good); font-weight: 500; white-space: nowrap;
}
.q .badge.weak { background: var(--warn-bg); color: var(--warn); }
.q .badge.none { background: var(--line-soft); color: var(--muted); }

.err {
  color: var(--bad); font-size: 12px; margin-top: 10px; background: var(--bad-bg);
  border: 1px solid var(--bad-line); border-left: 3px solid var(--bad); border-radius: 6px; padding: 8px 10px;
  line-height: 1.5;
}
.err-actions { margin-top: 8px; }
.ok-note { color: var(--good); font-size: 12px; margin-top: 9px; }
/*
 * The same sentence when it is not good news. "Filled 6 fields, 3 fields
 * still for you to answer" is a result to act on, and it was drawn in the
 * colour that means finished.
 */
.ok-note.warn { color: var(--warn); }

.done-box {
  background: var(--good-bg); border: 1px solid var(--good-line); border-radius: 8px; padding: 11px;
}
.done-box .path {
  font-family: var(--mono); font-size: 11px; background: #fff; border: 1px solid var(--good-line);
  border-radius: 5px; padding: 7px 8px; margin-top: 8px; word-break: break-all; color: var(--ink-soft);
}
.done-box .file { font-size: 12px; color: var(--ink-soft); margin-top: 5px; }

/*
 * What the form asked for and the folder does not have. Above the green box
 * rather than inside it: the green is the "this went well" colour, and the
 * whole point of this line is that it did not, entirely.
 */
.done-missing {
  background: var(--warn-bg); border: 1px solid var(--warn-line); color: var(--warn);
  border-radius: 8px; padding: 10px 11px; margin-bottom: 9px; font-size: 12px; line-height: 1.55;
}
.done-missing strong { display: block; margin-bottom: 3px; }

.spinner {
  width: 14px; height: 14px; border: 2px solid var(--accent-soft); border-top-color: var(--accent);
  border-radius: 50%; display: inline-block; animation: spin .7s linear infinite; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }

/*
 * Material's indeterminate linear progress, shown at the step doing the work.
 * Generating a letter or re-tailoring takes seconds — long enough that without
 * this, the card looks like it ignored the click.
 */
.progress {
  height: 4px;
  border-radius: 2px;
  background: var(--accent-soft);
  overflow: hidden;
  margin: 8px 0;
  position: relative;
}
.progress::before, .progress::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 0;
  background: var(--accent); border-radius: 2px; width: 100%;
  transform-origin: left center; will-change: transform;
}
/* The two-bar timing Material uses: a long sweep, then a short one chasing it. */
.progress::before { animation: mdc-primary 2s infinite cubic-bezier(.65,.815,.735,.395); }
.progress::after { animation: mdc-secondary 2s infinite cubic-bezier(.165,.84,.44,1); }
@keyframes mdc-primary {
  0% { transform: translateX(0) scaleX(0); }
  40% { transform: translateX(0) scaleX(.4); }
  100% { transform: translateX(100%) scaleX(.5); }
}
@keyframes mdc-secondary {
  0% { transform: translateX(0) scaleX(0); }
  60% { transform: translateX(60%) scaleX(.3); }
  100% { transform: translateX(110%) scaleX(.1); }
}
.progress-label { font-size: 11px; color: var(--muted); margin-top: -3px; margin-bottom: 6px; }
/* The clock, quieter than the label and only there once there is one. */
.progress-label .elapsed { margin-left: 6px; font-variant-numeric: tabular-nums; color: var(--faint); }
.progress-label .elapsed:empty { display: none; }

/* The compiled resume, drawn in the card: a page you can actually look at,
   on the tab you are already on. */
.pdf-pane {
  margin: 8px 0;
  padding: 8px;
  background: var(--line-soft);
  border-radius: 8px;
  max-height: 460px;
  overflow: auto;
}
.pdf-pages { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.pdf-page {
  display: block;
  background: #fff;
  max-width: 100%;
  border-radius: 1px;
  box-shadow: 0 1px 3px 0 rgba(60,64,67,.30), 0 4px 8px 3px rgba(60,64,67,.15);
}

/* What the page did not ask for, kept out of the way until it is wanted. */
.missed { border-top: 1px solid var(--line-soft); margin-top: 12px; padding-top: 8px; gap: 2px; }
a { color: var(--accent); }
`;

const HOST_ID = 'jobhelper-card-host';

export function removeCard() {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * @param {object} opts
 * @param {(action: string, payload?: any) => Promise<any>} opts.onAction
 */
export function createCard({ analysis, resumes = [], settings, questions = [], needsCoverLetter = false, onAction }) {
  removeCard();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.append(Object.assign(document.createElement('style'), { textContent: STYLE }));

  const card = document.createElement('div');
  card.className = 'card';
  root.append(card);
  document.documentElement.append(host);

  const state = {
    spec: analysis?.spec ?? null,
    /** The pages this application is being written from. See drawTrail. */
    trail: null,
    render: null,
    busy: null,
    error: null,
    bundle: null,
    view: 'propose',
    letter: null,
    /** True once the letter step is open, even if the draft came back empty. */
    letterStarted: false,
    /**
     * Whether this posting actually asks for a letter, read off the form. The
     * step only exists when it does — and `letterAsked` is the escape hatch
     * for when the detection misses one.
     */
    letterNeeded: needsCoverLetter,
    letterAsked: false,
    letterAutoStarted: false,
    letterSaved: false,
    letterSource: '',
    /** A previous letter offered as a starting point, until the user takes it. */
    letterOffer: null,
    priorLetters: [],
    questions,
    answers: {},
    feedback: '',
    autofillReport: null,
    workspaceOpened: false,
    /** Whether an AI is in play at all. Filled in below; never assumed. */
    ai: null,
    /** Answers typed on an earlier page of this same application. */
    carriedOver: null,
    /** "Edit in ResumeM-M" was pressed, so coming back here means something. */
    wentToEditor: false,
    /** And you did come back, so what is on screen may be out of date. */
    editedElsewhere: false,
    /** How the proposal on screen was produced: 'none', 'match' or 'ai'. */
    builtWith: analysis?.tailor ?? (analysis?.aiUsed ? 'ai' : 'match'),
    /** Which compiled PDF is on screen per kind, and the canvases drawn. */
    shownPdf: { resume: null, letter: null },
    pdfPages: new Map(),
    /** The typeset cover letter, once it has been asked for. */
    letterRender: null,
    /** Why the last one could not be drawn, if it could not. */
    pdfError: null,
    /** Whether the person said afterwards that they did not send it. */
    unsent: false,
    /** The text that was saved to the store, so an edit after it can be saved too. */
    letterSavedAs: null,
  };

  /**
   * What is worth keeping when the page changes under you.
   *
   * Clicking "Apply" is a navigation, and a navigation tears the card down and
   * builds a new one — so the resume you just built, the letter you just
   * drafted and the answers you just typed were gone at exactly the point the
   * form appeared to put them in. These are the pieces of that work that mean
   * anything on the next page.
   *
   * Not everything: `view` and `bundle` stay behind deliberately, because
   * landing on an application form already showing the "saved" panel would
   * hide the form it is standing in front of.
   */
  function takeWork() {
    return {
      spec: state.spec,
      builtWith: state.builtWith,
      render: state.render,
      letter: state.letter,
      letterSource: state.letterSource,
      letterStarted: state.letterStarted,
      letterSaved: state.letterSaved,
      letterAutoStarted: state.letterAutoStarted,
      priorLetters: state.priorLetters,
      /*
       * Keyed by the question, which is also how `state.answers` is keyed
       * everywhere else in this file — reading it by field id looked right and
       * silently carried nothing, because the field ids belong to a page that
       * no longer exists and were never the key here in the first place.
       */
      answersByQuestion: Object.fromEntries(
        (state.questions ?? [])
          .map((q) => [q.question, state.answers[q.question] ?? q.answer])
          .filter(([, a]) => a?.trim()),
      ),
    };
  }

  /**
   * Called once per card, with whatever was carried to this page or with
   * nothing. Until it has been, the card does not know whether it is starting
   * an application or continuing one — which is the difference between
   * drafting a letter and already having one.
   */
  function restoreWork(work) {
    carriedSettled = true;
    if (!work) {
      maybeAutoDraft();
      return;
    }
    if (work.spec) state.spec = work.spec;
    if (work.builtWith) state.builtWith = work.builtWith;
    if (work.render) state.render = work.render;
    if (work.letter != null) state.letter = work.letter;
    if (work.letterSource) state.letterSource = work.letterSource;
    state.letterStarted = state.letterStarted || Boolean(work.letterStarted);
    state.letterSaved = state.letterSaved || Boolean(work.letterSaved);
    state.letterAutoStarted = state.letterAutoStarted || Boolean(work.letterAutoStarted);
    if (work.priorLetters?.length) state.priorLetters = work.priorLetters;
    state.carriedOver = work.answersByQuestion ?? {};
    applyCarriedAnswers();
    maybeAutoDraft();
    draw();
  }

  /**
   * An answer typed on an earlier page, against the same question here.
   *
   * The guard used to refuse when the answer bank had matched the question too
   * — `!q.answer?.trim()` — which is precisely backwards. A question the bank
   * knows is one you have answered before, so it is exactly the question you
   * rewrote for this company on page one; and page two would show the bank's
   * older text instead, while the trail panel said "Carried over: your
   * answers". Worse, nothing was written into `state.answers`, so the bundle
   * left the question out altogether.
   *
   * What you typed for this application beats what the bank remembers from
   * another one. It is only not applied over something typed here, on this
   * page, which is newer still.
   */
  function applyCarriedAnswers() {
    const carried = state.carriedOver;
    if (!carried) return;
    for (const q of state.questions ?? []) {
      const had = carried[q.question];
      if (had && !state.answers[q.question]?.trim()) state.answers[q.question] = had;
    }
  }

  // Ask once, on open: the card must be able to say whether an AI is involved
  // before the user acts, not after. Deliberately outside act(), which marks
  // the card busy — a status read should not grey out the buttons.

  onAction('aiStatus', {})
    .then((status) => {
      state.ai = status;
      draw();
    })
    .catch(() => {
      /* the chip stays hidden rather than claiming a state we do not know */
    });

  const h = (tag, props = {}, kids = []) => {
    // `dataset` is a read-only DOMStringMap, so assigning it does nothing at
    // all — silently, which is the worst way for it to not work.
    const { dataset, ...rest } = props;
    const n = Object.assign(document.createElement(tag), rest);
    for (const [k, v] of Object.entries(dataset ?? {})) n.dataset[k] = v;
    for (const k of [].concat(kids)) if (k != null && k !== false) n.append(k);
    return n;
  };

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /**
   * Mark a button as one that runs the AI.
   *
   * Pressing one costs minutes and, depending on the command, money; the
   * button beside it is instant. Nothing distinguished them, so the only way
   * to find out which you had pressed was to wait and see. The mark goes on
   * the ones that start AI work and on no others — saying "not AI" on every
   * other button would be a great deal of noise to make a point about four.
   */
  const aiButton = (props, label) =>
    h('button', { ...props, className: `${props.className ?? ''} ai-action`.trim() }, [
      h('span', { className: 'ai-mark', textContent: '✦' }),
      h('span', { textContent: label }),
    ]);

  /**
   * Render the store's inline markup as real nodes. The stored text carries
   * `**bold**` and `` `code` `` for the LaTeX renderer; showing that source to
   * the user is showing them the plumbing.
   */
  function markup(text) {
    const frag = document.createDocumentFragment();
    const re = /\*\*(.+?)\*\*|`(.+?)`|(?:^|(?<=[\s(]))\*([^*]+)\*(?=[\s).,;:]|$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      if (m[1] !== undefined) frag.append(h('strong', { textContent: m[1] }));
      else if (m[2] !== undefined) frag.append(h('code', { textContent: m[2] }));
      else frag.append(h('em', { textContent: m[3] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  /**
   * Run an action with the card showing a busy state. `apply` runs before the
   * final redraw: assigning the result in the caller after `await` would always
   * repaint stale state.
   */
  /*
   * More than one thing can be in flight. The card starts work on its own —
   * the letter drafts itself when the posting asks for one, and the AI pass
   * runs after the first proposal — so two actions overlap without the user
   * having clicked twice. A single `busy` flag meant the first to finish
   * cleared it: the progress bar vanished and every button came back while
   * the other was still thinking.
   */
  const running = new Set();
  /** When each in-flight action started, so the card can say how long. */
  const startedAt = new Map();

  async function act(action, payload, apply) {
    running.add(action);
    startedAt.set(action, Date.now());
    state.busy = action;
    state.error = null;
    state.errorFix = null;
    draw();
    try {
      const result = await onAction(action, payload);
      apply?.(result);
      return result;
    } catch (err) {
      state.error = err.message;
      // Some failures have a way out. Keep it, so the card can offer it.
      state.errorFix = err.jobhelper ?? null;
      return null;
    } finally {
      running.delete(action);
      startedAt.delete(action);
      // Keep showing progress for whatever is still going.
      state.busy = [...running].pop() ?? null;
      draw();
    }
  }

  const busyLabel = (action, idle, working) => (running.has(action) ? working : idle);

  /*
   * Both build buttons dispatch the same action, `rebuild`, and differ only by
   * which mode they asked for. They used to ask busyLabel about "rebuild-tags"
   * and "rebuild-ai" — actions nothing dispatches — so neither ever said it
   * was working.
   */
  const rebuildLabel = (mode, idle, working) =>
    running.has('rebuild') && state.rebuilding === mode ? working : idle;

  /* ---------------------------------------------------------------- */

  /**
   * Whether an AI is in play, said plainly and in one place.
   *
   * Two switches decide it, and the failure people hit is the middle one:
   * turning the extension's switch on while ResumeM-M has its AI off, then
   * wondering why nothing is being written. Name that case explicitly.
   */
  const AI_CHIP = {
    on: { text: 'AI on', className: 'ai on', title: 'This posting can be tailored by your configured AI CLI.' },
    off: {
      text: 'AI off',
      className: 'ai off',
      title: 'Nothing is sent to an AI. Tailoring is keyword matching against your own stored phrasings.',
    },
    'server-off': {
      text: 'AI off in ResumeM-M',
      className: 'ai warn',
      title: 'Set to use the AI, but ResumeM-M has it switched off. Click to turn it on.',
      turnOn: true,
    },
    unconfigured: {
      text: 'No AI set up',
      className: 'ai off',
      title: 'ResumeM-M has no AI command configured. Tailoring is keyword matching against your own phrasings.',
    },
    offline: {
      text: 'AI unknown',
      className: 'ai off',
      title: 'ResumeM-M is not reachable, so its AI setting could not be read.',
    },
  };

  /**
   * The chip says what is true; where one click would make it true, the chip
   * is that click. "Switched off over there" is the state people got stuck in,
   * and reading about it in a tooltip is not a way out of it.
   */
  function drawAiChip() {
    if (!state.ai) return null;
    const look = AI_CHIP[state.ai.state] ?? AI_CHIP.off;
    const chip = h('span', {
      className: `${look.className}${look.turnOn ? ' actionable' : ''}`,
      title: look.title,
      textContent: look.text,
    });

    if (look.turnOn) {
      chip.onclick = () => {
        chip.textContent = 'Turning on…';
        act('setAiEnabled', { enabled: true }, (ai) => {
          state.ai = ai ?? state.ai;
        });
      };
    }
    return chip;
  }

  function drawHead() {
    return h('div', { className: 'head' }, [
      h('b', { textContent: 'JobHelper' }),
      state.busy ? h('span', { className: 'spinner' }) : null,
      h('span', { className: 'spacer' }),
      drawAiChip(),
      /*
       * Named as well as drawn. A button whose only content is "‹" has "‹"
       * for an accessible name, so a screen reader announces a punctuation
       * mark and the title attribute never gets a look in.
       */
      state.view !== 'propose'
        ? h('button', {
            className: 'icon',
            title: 'Back',
            ariaLabel: 'Back',
            textContent: '‹',
            onclick: () => { state.view = 'propose'; draw(); },
          })
        : null,
      h('button', {
        className: 'icon',
        title: 'Not now',
        ariaLabel: 'Close JobHelper on this page',
        textContent: '×',
        onclick: () => removeCard(),
      }),
    ]);
  }

  function drawJob() {
    const job = analysis.job;
    return h('div', { className: 'job' }, [
      h('div', { className: 'role', textContent: job.title ?? 'This posting' }),
      h('div', { className: 'co', textContent: [job.company, job.location].filter(Boolean).join(' · ') }),
      drawTrail(),
    ]);
  }

  /**
   * The pages this application is being written from.
   *
   * Shown only once there is more than one, because on a single page it would
   * be saying "this page" — but the moment there are two, what the letter is
   * written from stops being obvious, and a tool that quietly merged the wrong
   * two pages would be worse than one that never merged at all. So it says
   * which, and both corrections are one click: drop a page, or start over.
   */
  function drawTrail() {
    const pages = state.trail?.pages ?? [];
    if (pages.length < 2) return null;

    const KIND = { posting: 'the description', application: 'the form', listing: 'a list of roles', discussion: 'a thread' };
    const row = (p) =>
      h('div', { className: 'trail-row' }, [
        h('span', { className: 'what', textContent: KIND[p.kind] ?? 'a page' }),
        h('span', { className: 'where', textContent: p.title || p.url || '' , title: p.url ?? '' }),
        h('button', {
          className: 'link',
          textContent: 'Not this one',
          title: 'Leave this page out of what is written',
          onclick: () => act('forgetPage', { url: p.url }, (trail) => (state.trail = trail)),
        }),
      ]);

    // Say plainly that the work came too. The resume being still on screen is
    // evidence, but only if you happened to notice it was ever gone.
    const brought = [
      state.spec ? 'the resume' : null,
      state.letter?.trim() ? 'the letter' : null,
      Object.keys(state.carriedOver ?? {}).length ? 'your answers' : null,
    ].filter(Boolean);

    return h('details', { className: 'trail' }, [
      h('summary', { textContent: `Writing from ${pages.length} pages of this application` }),
      brought.length
        ? h('div', { className: 'trail-kept', textContent: `Carried over: ${brought.join(', ')}.` })
        : null,
      ...pages.map(row),
      h('button', {
        className: 'link',
        textContent: 'Start a new application here',
        title: 'Forget the earlier pages and use only this one',
        onclick: () => act('clearTrail', {}, (trail) => (state.trail = trail)),
      }),
    ]);
  }

  function stepHead(n, title, done = false) {
    return h('div', { className: 'step-head' }, [
      h('span', { className: `n${done ? ' done' : ''}`, textContent: done ? '✓' : String(n) }),
      h('span', { className: 't', textContent: title }),
    ]);
  }

  /**
   * Which step each action belongs to, and what to say while it runs.
   * Compiling, drafting and answering all take seconds — long enough that a
   * card which just sits there looks like it dropped the click.
   */
  const WORKING = {
    render: [1, 'Compiling the resume…'],
    rebuild: [1, 'Choosing what to change…'],
    setBase: [1, 'Starting from that resume…'],
    refine: [1, 'Applying your feedback…'],
    coverLetter: [2, 'Drafting the letter…'],
    saveLetter: [2, 'Saving the letter…'],
    answerQuestion: [3, 'Writing an answer…'],
    matchAnswers: [3, 'Looking through your answers…'],
    bundle: [4, 'Building the files…'],
    autofill: [4, 'Filling the form…'],
    openWorkspace: [3, 'Opening ResumeM-M…'],
  };

  /** A progress bar for `step`, when that is what the card is busy doing. */
  function progressFor(step) {
    const entry = WORKING[state.busy];
    if (!entry || entry[0] !== step) return null;
    const label = running.has('rebuild') && state.rebuilding === 'ai' ? 'Reading the posting…' : entry[1];

    /*
     * And how long it has been going.
     *
     * An indeterminate bar animates whether or not anything is happening, so
     * after the first half-minute of an AI pass it stops being reassurance
     * and starts being the thing you are trying to decide about. A count of
     * seconds moves for a real reason, and it answers the actual question:
     * has this hung, or is it just slow?
     *
     * Ticked in place rather than through `draw()`, which rebuilds the whole
     * subtree and would take the caret out of whatever box is being typed
     * into once a second — see the repaint case in tests/card.mjs. And held
     * back for a moment, because a keyword match finishes in a third of a
     * second and a clock that flashes 0:00 is noise.
     */
    const since = startedAt.get(state.busy) ?? Date.now();
    const clock = h('span', { className: 'elapsed' });
    const tick = () => {
      const s = Math.round((Date.now() - since) / 1000);
      clock.textContent = s < 2 ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    const timer = setInterval(() => {
      // The card redraws often; a bar that has been replaced stops counting.
      if (!clock.isConnected) clearInterval(timer);
      else tick();
    }, 1000);

    return h('div', {}, [
      h('div', { className: 'progress', role: 'progressbar', 'aria-label': label }),
      h('div', { className: 'progress-label' }, [h('span', { textContent: label }), clock]),
    ]);
  }

  /** What the tailoring changed, in words. Never a silent swap, never an id. */
  /**
   * What the tailoring did to the document, as a before/after against the base
   * resume: the sentence that was there, struck through, and the one chosen in
   * its place. The server computes it by resolving both resumes and comparing
   * the results, so this is the page as it will print — not a list of variant
   * ids, which is not something anyone can check at a glance.
   *
   * The keywords that drove each pick are kept, collapsed underneath, because
   * "why did it choose that?" is the next question after "what changed?".
   */
  /** One line naming the resume being sent and what, if anything, was done to it. */
  function builtSummary() {
    const base = analysis.baseLabel ?? 'your base resume';
    const copy = ` Your ${base} is untouched — this is a copy, saved under this posting's name.`;
    if (state.builtWith === 'none') return `${base}, exactly as it is. Nothing was swapped, dropped or added.${copy}`;
    if (state.builtWith === 'ai' && analysis.aiUsed) {
      return `${base}, with the changes the AI chose below.${copy}`;
    }
    if (state.builtWith === 'ai') {
      return `The AI returned nothing usable, so this is ${base} with the keyword match applied.${copy}`;
    }
    return `${base}, with wordings swapped by keyword match against phrasings you already wrote.${copy}`;
  }

  function drawChanges() {
    const diff = analysis.diff ?? [];
    const rationale = analysis.rationale ?? [];

    if (diff.length === 0 && rationale.length === 0) {
      return h(
        'div',
        { className: 'no-change' },
        state.builtWith === 'none'
          ? 'Unchanged, as you asked — this is your resume exactly as you keep it.'
          : 'Nothing needed changing — your base resume already suits this posting.',
      );
    }

    // Keywords, matched to the diff row they explain by the text they swapped in.
    const reasonFor = new Map();
    for (const r of rationale) {
      if (r.toText && (r.because ?? []).length) reasonFor.set(plainish(r.toText), r.because);
    }

    const list = h('div', { className: 'changes' }, [
      h('div', { className: 'diff-head' }, [
        h('span', { className: 'from-label', textContent: analysis.baseLabel ?? 'Base' }),
        h('span', { className: 'arrow', textContent: '→' }),
        h('span', { className: 'to-label', textContent: 'this posting' }),
        h('span', { className: 'count', textContent: plural(diff.length || rationale.length, 'change') }),
        /*
         * The way out, beside the list rather than back up among the build
         * modes. This is where you find out what was changed, so this is where
         * "actually, none of it" belongs.
         */
        state.builtWith === 'none'
          ? null
          : h('button', {
              className: 'link undo-all',
              textContent: 'Undo all',
              title: 'Throw these changes away and send the resume exactly as you keep it',
              disabled: Boolean(state.busy),
              onclick: async () => {
                state.rebuilding = 'none';
                try {
                  await act('rebuild', { tailor: 'none' }, () => {
                    state.builtWith = 'none';
                    state.render = null;
                  });
                } finally {
                  state.rebuilding = null;
                }
              },
            }),
      ]),
    ]);

    for (const c of diff) {
      const because = reasonFor.get(plainish(c.to ?? ''));
      // `text` is a self-contained sentence, which means it repeats the place
      // it happened — and the place is already the label above it.
      const detail = c.where && c.text?.startsWith(`${c.where}: `)
        ? c.text.slice(c.where.length + 2)
        : c.text;
      const why = h('div', { className: 'why' });
      for (const k of because ?? []) why.append(h('span', { className: 'kw', textContent: k }));

      list.append(
        h('div', { className: `change ${c.kind}` }, [
          c.where ? h('div', { className: 'where', textContent: c.where }) : null,
          h('div', { className: 'ba' }, [
            c.from ? h('del', { textContent: c.from }) : null,
            c.to ? h('ins', { textContent: c.to }) : null,
            !c.from && !c.to ? h('span', { className: 'plain', textContent: detail }) : null,
          ]),
          because?.length ? why : null,
        ]),
      );
    }

    // A proposal the server could not resolve still has something to say.
    if (diff.length === 0) {
      for (const c of rationale) {
        list.append(
          h('div', { className: 'change' }, [
            h('div', { className: 'where', textContent: c.where ?? 'On the resume' }),
            h('div', { className: 'ba' }, [
              c.fromText ? h('del', { textContent: c.fromText }) : null,
              c.toText ? h('ins', { textContent: c.toText }) : null,
            ]),
          ]),
        );
      }
    }
    return list;
  }

  /** Store markup off, whitespace normalised — for matching two copies of a sentence. */
  function plainish(text) {
    return String(text ?? '')
      .replace(/[*`]/g, '')
      .replace(/\s*--\s*/g, ' – ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** New phrasings the AI proposed. Opt-in, one at a time, never automatic. */
  function drawSuggestions() {
    const suggestions = analysis.suggestions ?? [];
    if (suggestions.length === 0) return null;

    const box = h('div', { style: 'margin-top:8px' }, [
      h('div', { className: 'hint', textContent: 'Suggested new wording — not in your store yet:' }),
    ]);
    for (const s of suggestions) {
      box.append(
        h('div', { className: 'suggestion' }, [
          h('div', {}, markup(s.text)),
          s.why ? h('div', { className: 'why', textContent: s.why }) : null,
          h('div', { className: 'row gap' }, [
            h('button', {
              className: 'tiny',
              textContent: 'Add to store',
              onclick: () =>
                act(
                  'addVariant',
                  {
                    entryId: s.entryId ?? analysis.entryByBullet?.[s.bulletId],
                    bulletId: s.bulletId,
                    variant: { label: s.label ?? 'Suggested', text: s.text },
                  },
                  (saved) => {
                    if (saved) analysis.suggestions = suggestions.filter((x) => x !== s);
                  },
                ),
            }),
            h('button', {
              className: 'tiny',
              textContent: 'Ignore',
              onclick: () => {
                analysis.suggestions = suggestions.filter((x) => x !== s);
                draw();
              },
            }),
          ]),
        ]),
      );
    }
    return box;
  }

  /**
   * The controls under the letter box, and how they keep up with it.
   *
   * They are drawn from `state.letter`, and the card is not redrawn while
   * anybody is typing — a redraw replaces the textarea and the caret goes to
   * the start of it. So the three of them are held here and brought up to
   * date in place on each keystroke. Rebuilt on every draw, so these always
   * point at the buttons currently on screen rather than at detached ones.
   */
  const letterControls = { save: null, copy: null, typeset: null, note: null };

  function syncLetterControls() {
    const written = Boolean(state.letter?.trim());
    if (letterControls.save) {
      letterControls.save.disabled = Boolean(state.busy) || state.letterSaved || !written;
      letterControls.save.textContent = busyLabel('saveLetter', state.letterSaved ? 'Saved' : 'Save to store', 'Saving…');
    }
    if (letterControls.copy) letterControls.copy.disabled = !written;
    if (letterControls.typeset) letterControls.typeset.disabled = Boolean(state.busy) || !written;
    if (letterControls.note) {
      letterControls.note.textContent = state.letterSaved ? 'Future drafts will start from this one.' : '';
    }
  }

  function drawFit() {
    if (!state.render) {
      return h('div', {
        className: 'fit idle',
        textContent: running.has('render') ? 'Compiling…' : 'Not compiled yet.',
      });
    }
    const r = state.render;
    if (!r.fits) {
      return h('div', {
        className: 'fit bad',
        textContent: `${plural(r.pages, 'page')} — about ${plural(r.overflowLines, 'line')} too long.`,
      });
    }
    const adj = r.adjustments?.length ? ` Auto-fit: ${r.adjustments.join('; ')}.` : '';
    return h('div', { className: 'fit ok', textContent: `Fits on one page.${adj}` });
  }

  /* ---- Main view ---- */

  /**
   * The compiled resume, drawn in the card.
   *
   * Looking at what you are about to send should not mean opening another tab
   * and losing the posting. The bytes come through the service worker (the
   * page's own origin cannot reach loopback over https) and are drawn to a
   * canvas rather than handed to an iframe, which would blank on every
   * recompile.
   */
  /**
   * @param {string} kind    'resume' or 'letter' — which slot guards the fetch
   * @param {string|undefined} url
   * @param {string} what    how to name it if it cannot be drawn
   */
  function drawPdfPane(kind, url, what) {
    if (!url) return null;

    const pages = h('div', { className: 'pdf-pages' });
    const pane = h('div', { className: 'pdf-pane' }, [pages]);

    // Already drawn once: reuse the bitmap so a re-render does not refetch.
    const cached = state.pdfPages.get(url);
    if (cached) {
      pane.replaceChildren(cached.cloneNode(true));
      return pane;
    }
    if (state.pdfError?.url === url) {
      pane.append(h('div', { className: 'hint', textContent: `Could not draw the ${what}: ${state.pdfError.message}` }));
      return pane;
    }

    /*
     * Fetch and draw, once per compile.
     *
     * `shownPdf` is the guard against a re-render refetching, and it used to
     * be the only one — which left the pane permanently empty on the most
     * ordinary step there is. Drawing is asynchronous and writes into the
     * node captured here; a re-render during the fetch replaces that node,
     * so the bitmap landed somewhere detached, and the guard then said this
     * url was already shown and nothing ever drew it again. Walking from the
     * posting to its application form re-renders several times while the
     * card restores, so the resume simply vanished on arrival — a sixteen
     * pixel grey strip where the page had been, with nothing to say why.
     *
     * The bitmap cache above is the real test of "already drawn", so what is
     * left to do here is put it on screen: if the node we drew into is no
     * longer connected, ask for one more render.
     */
    /*
     * One slot per kind, not one slot.
     *
     * This was a single `shownPdf`, which was right while the resume was the
     * only thing drawn here. The letter is drawn the same way now, and with
     * one slot each fetch cancelled the other: the letter's arrival made the
     * resume's "a newer compile won" test true, and the pane it had been
     * drawing into stayed a grey strip.
     */
    if (state.shownPdf[kind] !== url) {
      const wanted = url;
      state.shownPdf[kind] = wanted;
      (async () => {
        try {
          const { base64 } = await onAction('pdfBytes', { url: wanted });
          const { drawPdf } = await import(chrome.runtime.getURL('src/content/pdfview.js'));
          if (state.shownPdf[kind] !== wanted) return; // a newer compile won
          await drawPdf(pages, base64, { width: 372 });
          state.pdfPages.set(wanted, pages.cloneNode(true));
          // Each of these is a page-sized bitmap. Keeping one per compile
          // meant a session of small edits quietly holding a dozen of them.
          for (const old of [...state.pdfPages.keys()].slice(0, -4)) state.pdfPages.delete(old);
          if (!pages.isConnected) draw();
        } catch (err) {
          // Kept in state rather than appended: appending to a node a
          // re-render has already replaced says it to nobody.
          state.pdfError = { url: wanted, message: err.message };
          if (!pane.isConnected) draw();
          else pane.append(h('div', { className: 'hint', textContent: `Could not draw the ${what}: ${err.message}` }));
        }
      })();
    }

    return pane;
  }

  const drawResumePage = () => drawPdfPane('resume', state.render?.pdfUrl, 'resume');

  /**
   * A question the page did not expose — a portal that renders its form in a
   * canvas, or one that only asks after you upload. Typing it here puts it
   * through the same answer-bank matching as a detected one.
   */
  async function addQuestionByHand() {
    const question = window.prompt('What does it ask?');
    if (!question?.trim()) return;

    state.questions = [...state.questions, { question: question.trim(), answer: '', confident: false }];
    draw();

    const matched = await onAction('matchAnswers', { questions: [question.trim()] }).catch(() => null);
    const hit = matched?.matches?.[0];
    if (hit?.answer) {
      state.questions = state.questions.map((q) =>
        q.question === question.trim() ? { ...q, answer: hit.answer, confident: hit.confident } : q,
      );
      draw();
    }
  }

  /** Whether this card has been told what, if anything, was carried to it. */
  let carriedSettled = false;

  /**
   * Start the letter the form is asking for — but not before the card knows
   * whether it already has one.
   *
   * There are two conditions that have nothing to do with each other. A
   * resume to write the letter against, which `update` supplies; and the
   * answer to "was a letter carried here", which arrives a moment later from
   * `restoreWork`. Starting on the first alone meant every return to a form
   * fired a draft whose reply was then thrown away as "offered rather than
   * used" — free when the AI is off, and minutes of somebody's AI budget
   * spent on a letter they had already written when it is on.
   *
   * Whichever of the two arrives second runs this, so it happens once, as
   * late as it can and no later.
   */
  function maybeAutoDraft() {
    if (!carriedSettled) return;
    if (!state.letterNeeded || state.letterAutoStarted || !state.spec) return;
    // A letter is already here. It came from the page before, or from the tab
    // that closed; either way there is nothing to draft.
    if (state.letter?.trim()) return;
    state.letterAutoStarted = true;
    draftLetter();
  }

  /**
   * Draft the letter. Three honest outcomes, in descending order of help, and
   * all of them leave you with an editor rather than a dead end: a fresh
   * draft, your closest previous letter to adapt, or a blank page that becomes
   * the reference for next time.
   */
  function draftLetter() {
    /*
     * What is in the box when the draft was asked for.
     *
     * A draft can start itself — the form page wants a letter, so one is
     * requested the moment the card goes up — and `restoreWork` puts the
     * letter you wrote on the *previous* page into the box a few lines later.
     * The reply then landed on top of it unconditionally. With the AI off,
     * which is the default, that reply is an empty body, so the box went
     * blank and the card explained that the AI is off: it read as an ordinary
     * empty state rather than as the deletion it was.
     *
     * Nothing the AI produces is worth a paragraph somebody wrote.
     */
    const mine = state.letter ?? '';

    return act('coverLetter', { spec: state.spec }, (r) => {
      if (!r) return;
      state.priorLetters = r.priorLetters ?? [];
      state.letterStarted = true;

      /*
       * What is in the box *now*, which is the only thing that can be
       * overwritten — and not the same question as what was in it when this
       * was asked for.
       *
       * Guarding on `mine` alone was a fix for the wrong moment. This draft
       * starts itself from `update`, and `update` runs a few lines before
       * `restoreWork`: on landing back on a form you had already written on,
       * the request goes out with the box empty, the carried letter arrives
       * while it is in flight, and the reply — an empty body, because the AI
       * is off by default — then fell through every guard and blanked it.
       *
       * Not a near-miss: the emptied card was saved back over the stored
       * letter two seconds later, so the writing was gone from disk as well
       * as from the screen, and returning to the page again did not bring it
       * back. Wandering off to read something mid-application and coming
       * back was enough to lose a cover letter.
       */
      const now = state.letter ?? '';

      if (now.trim() && now !== mine) {
        /*
         * It arrived while the draft was out — typed by hand, or carried in
         * from the page before. Either way it is somebody's writing and this
         * reply is not.
         */
        state.letterSource = mine.trim()
          ? 'You were writing while this ran, so what you wrote was kept.'
          : 'What you had written was put back while this was running, so the draft was not used.';
        return;
      }
      if (now.trim()) {
        state.letterOffer = r.body?.trim() ? { title: 'the draft', body: r.body } : state.priorLetters[0] ?? null;
        state.letterSource = state.letterOffer
          ? 'You had already started one, so this is offered rather than used.'
          : 'You had already started one, so nothing was replaced.';
        return;
      }

      if (r.body?.trim()) {
        state.letter = r.body;
        state.letterSource = 'Drafted in your voice from your previous letters.';
      } else if (state.priorLetters.length > 0) {
        /*
         * Offered, not adopted.
         *
         * This used to put the previous letter straight into `state.letter`,
         * and `state.letter` is what "Prepare to submit" ships. So with
         * the AI off — and nobody having clicked anything, because this draft
         * starts itself — a letter that opens "Dear Streamly," was typeset,
         * named "Cover Letter Helios.pdf", and dropped in the folder the card
         * tells you to upload from, with Helios in the address block and
         * Streamly in the salutation. Saving it to the store then filed it
         * under Helios, so the next Helios letter started from it too.
         *
         * A previous letter is a good starting point and a bad submission. It
         * now waits behind a button.
         */
        state.letterOffer = state.priorLetters[0];
        state.letter = '';
        state.letterSource = `The AI is off. Your closest previous letter is ${state.priorLetters[0].title} — it is addressed to someone else, so it is not used until you say so.`;
      } else {
        state.letter = '';
        state.letterSource = 'No previous letters yet. Write one here and the next draft starts from it.';
      }
    });
  }

  function drawProposeView() {
    const baseSelect = h('select', { title: 'Which resume to start from' });
    // Pinned bases are grouped apart. A store fills up with resumes tailored
    // for one posting each; the ones you actually build from should not have
    // to be picked out of that list by name.
    const pinned = resumes.filter((r) => r.base);
    const option = (r) =>
      h('option', { value: r.id, textContent: `${r.label}`, selected: r.id === analysis.baseResumeId });

    if (pinned.length > 0 && pinned.length < resumes.length) {
      const bases = h('optgroup', { label: 'Bases' });
      for (const r of pinned) bases.append(option(r));
      const rest = h('optgroup', { label: 'Everything else' });
      for (const r of resumes.filter((r) => !r.base)) rest.append(option(r));
      baseSelect.append(bases, rest);
    } else {
      for (const r of resumes) baseSelect.append(option(r));
    }
    baseSelect.onchange = () => act('setBase', { baseResumeId: baseSelect.value, tailor: state.builtWith ?? 'match' });

    const feedback = h('textarea', {
      value: state.feedback,
      placeholder: 'Anything to change? e.g. “lead with the distributed systems work”.',
      oninput: (e) => (state.feedback = e.target.value),
    });

    const body = h('div', { className: 'body' }, [drawJob()]);

    /* 1. Resume */
    body.append(
      h('div', { className: 'step' }, [
        stepHead(1, 'Resume', Boolean(state.render?.fits)),
        progressFor(1),
        h('div', { className: 'row' }, [
          h('span', { className: 'hint', textContent: 'Start from' }),
          baseSelect,
        ]),

        /*
         * Three ways to get from the base to what you send, chosen
         * deliberately rather than by a setting the user cannot see from here.
         * Unchanged does nothing at all; matching is instant, free, and only
         * ever picks among phrasings you already wrote; the AI reads the
         * posting and decides what to change.
         *
         * The first of those was missing, and its absence was the whole
         * problem: both buttons altered the resume, so the proposal always
         * arrived with a list of changes on it and no way to say "none of
         * these, send what I already have". Tailoring is the feature; it was
         * never supposed to be compulsory.
         */
        h('div', { className: 'row build-modes' }, [
          h('button', {
            className: state.builtWith === 'none' ? 'mode on' : 'mode',
            textContent: rebuildLabel('none', 'Use it unchanged', 'Copying…'),
            title: 'Send this resume exactly as it is. Nothing is swapped, dropped or added.',
            disabled: Boolean(state.busy),
            onclick: async () => {
              state.rebuilding = 'none';
              try {
                await act('rebuild', { tailor: 'none' }, () => {
                  state.builtWith = 'none';
                  state.render = null;
                });
              } finally {
                state.rebuilding = null;
              }
            },
          }),
          h('button', {
            className: state.builtWith === 'match' ? 'mode on' : 'mode',
            textContent: rebuildLabel('match', 'Match by keyword', 'Matching…'),
            title:
              'Swap in phrasings you already wrote, picked by the keywords in this posting. Nothing is sent to an AI, and nothing new is written.',
            disabled: Boolean(state.busy),
            onclick: async () => {
              state.rebuilding = 'match';
              try {
                await act('rebuild', { tailor: 'match' }, () => {
                  state.builtWith = 'match';
                  state.render = null;
                });
              } finally {
                // Cleared however it ended: a failure used to leave the label
                // for the next run describing the wrong thing.
                state.rebuilding = null;
              }
            },
          }),
          aiButton({
            className: state.builtWith === 'ai' ? 'mode on' : 'mode',
            title: state.ai?.active
              ? 'The AI reads this posting and decides which phrasings and bullets to use.'
              : state.ai?.state === 'server-off'
                ? 'ResumeM-M has its AI switched off — turn it on under Voice & AI.'
                : 'Switch the AI on from the JobHelper toolbar icon to use this.',
            disabled: Boolean(state.busy) || !state.ai?.active,
            onclick: async () => {
              state.rebuilding = 'ai';
              try {
                await act('rebuild', { tailor: 'ai' }, () => {
                  state.builtWith = 'ai';
                  state.render = null;
                });
              } finally {
                state.rebuilding = null;
              }
            },
          }, rebuildLabel('ai', 'Let the AI tailor it', 'Reading the posting…')),
          /*
           * Neither matching nor AI: going and writing the sentence yourself.
           *
           * Looking at a posting is exactly when you notice the store has no
           * bullet for the thing it is asking about — and the answer to that is
           * two minutes in the builder, not another pass over the phrasings
           * that already exist. Without a way through, it meant finding the
           * editor by hand, finding the resume in it, and losing the card.
           */
          h('button', {
            className: 'mode ghost',
            textContent: 'Edit in ResumeM-M',
            title: 'Open this resume in the builder to add a bullet or another phrasing',
            disabled: Boolean(state.busy) || !state.spec?.id,
            onclick: () => {
              // Remembered so that coming back here means something. See
              // `cameBack`.
              state.wentToEditor = true;
              onAction('openTab', { url: `/#resumes/${encodeURIComponent(state.spec.id)}` });
            },
          }),
        ]),
        /*
         * You went to the builder because this posting wanted a bullet the
         * store did not have. Coming back to a card still showing the match
         * made from the store as it was is the half of that journey nobody
         * built: the new wording exists, and the proposal in front of you
         * cannot contain it.
         *
         * Offered, not done. A rebuild throws away every alternate you
         * switched by hand on this card, and it is not worth guessing that
         * the trip to the editor mattered more than those did.
         */
        state.editedElsewhere
          ? h('div', { className: 'hint warn' }, [
              h('span', { textContent: 'You have been editing the store. ' }),
              h('button', {
                className: 'link',
                textContent: 'Build it again',
                disabled: Boolean(state.busy),
                onclick: () => {
                  state.editedElsewhere = false;
                  const mode = state.builtWith ?? 'match';
                  state.rebuilding = mode;
                  return act('rebuild', { tailor: mode }, () => {
                    state.builtWith = mode;
                    state.render = null;
                    state.rebuilding = null;
                  });
                },
              }),
              h('span', { textContent: ' to use anything you added.' }),
            ])
          : null,
        /*
         * Which resume this is, and what was done to it.
         *
         * "Chosen by keyword match against your own phrasings" said what the
         * mechanism was and never what the result was — so the honest question
         * "which version am I actually sending?" had no answer on the card.
         * The copy is always named after the posting, and the base it came
         * from is never touched; both of those are worth saying out loud,
         * because a tool that silently edits the resume you keep is a tool
         * nobody should press a button on.
         */
        state.builtWith ? h('div', { className: 'hint', textContent: builtSummary() }) : null,
        drawChanges(),
        drawSuggestions(),
        drawFit(),
        drawResumePage(),
        h('div', { className: 'row' }, [
          h('button', {
            className: 'primary',
            textContent: busyLabel('render', state.render ? 'Recompile' : 'Build resume', 'Compiling…'),
            disabled: Boolean(state.busy),
            onclick: () => act('render', { spec: state.spec }, (r) => (state.render = r)),
          }),
          state.render
            ? h('a', { href: state.render.absolutePdfUrl, target: '_blank', textContent: 'Open full size' })
            : null,
        ]),
        h('div', { className: 'row gap' }, [feedback]),
        h('div', { className: 'row' }, [
          h('button', {
            className: 'tiny',
            textContent: busyLabel('refine', 'Apply feedback', 'Thinking…'),
            disabled: Boolean(state.busy),
            onclick: async () => {
              if (!state.feedback.trim()) return;
              const refined = await act('refine', { spec: state.spec, feedback: state.feedback });
              if (refined?.parsed?.choices) {
                state.spec = { ...state.spec, choices: { ...state.spec.choices, ...refined.parsed.choices } };
                await act('render', { spec: state.spec }, (r) => (state.render = r));
              } else if (refined && !refined.executed) {
                state.error =
                  'The AI is switched off, so written feedback cannot be applied automatically. Turn it on in ResumeM-M’s config.yaml, or change the wording in the editor.';
                draw();
              }
            },
          }),
        ]),
      ]),
    );

    /*
     * 2. Cover letter — only when the posting asks for one.
     *
     * Every posting used to get this step and a button to press, which made
     * the card ask a question the form had already answered. Now the form
     * decides: if it has a cover letter field, the step appears and the draft
     * starts on its own; if it does not, the step is not there at all, and the
     * line at the bottom of the card is how you overrule that.
     */
    if (state.letterNeeded || state.letterAsked) body.append(
      h('div', { className: 'step' }, [
        stepHead(2, 'Cover letter', Boolean(state.letter?.trim())),
        progressFor(2),
        state.letterStarted
          ? h('div', {}, [
              state.letterSource ? h('div', { className: 'hint', textContent: state.letterSource }) : null,
              state.letterOffer && !state.letter?.trim()
                ? h('button', {
                    className: 'tiny',
                    textContent: `Start from "${state.letterOffer.title}"`,
                    onclick: () => {
                      state.letter = state.letterOffer.body;
                      state.letterSource = `Copied from ${state.letterOffer.title}. It is addressed to another company — read it before sending.`;
                      state.letterOffer = null;
                      draw();
                    },
                  })
                : null,
              h('textarea', {
                className: 'tall',
                dataset: { field: 'letter' },
                value: state.letter ?? '',
                placeholder: 'Write the letter here. Saving it makes it the reference for the next one.',
                /*
                 * Typing has to reach the buttons under the box.
                 *
                 * This only assigned `state.letter`, and every control that
                 * depends on it — Save to store, Copy, See it typeset — has
                 * its `disabled` worked out when the card is drawn. Nothing
                 * draws the card while you type, deliberately: a redraw
                 * destroys the box you are typing into and takes the caret
                 * with it. So writing a letter by hand left all three greyed
                 * out until something unrelated happened to redraw, which
                 * reads as three broken buttons under a box that works. They
                 * are updated in place instead.
                 */
                oninput: (e) => {
                  state.letter = e.target.value;
                  // Editing after saving is a new letter to save.
                  if (state.letterSaved && state.letter !== state.letterSavedAs) state.letterSaved = false;
                  syncLetterControls();
                },
              }),
              h('div', { className: 'row gap' }, [
                (letterControls.save = h('button', {
                  className: 'tiny',
                  textContent: busyLabel('saveLetter', state.letterSaved ? 'Saved' : 'Save to store', 'Saving…'),
                  disabled: Boolean(state.busy) || state.letterSaved || !state.letter?.trim(),
                  onclick: () =>
                    act('saveLetter', { body: state.letter }, () => {
                      state.letterSaved = true;
                      state.letterSavedAs = state.letter;
                    }),
                })),
                (letterControls.copy = h('button', {
                  className: 'tiny',
                  textContent: 'Copy',
                  disabled: !state.letter?.trim(),
                  onclick: () => navigator.clipboard?.writeText(state.letter ?? ''),
                })),
                /*
                 * The letter as it will actually arrive.
                 *
                 * It is typeset through the same LaTeX as the resume and sent
                 * as a PDF — but in here it was a box of plain text, so the
                 * document nobody saw until after it was sent was the one
                 * with the name, the address block and the spacing in it. The
                 * resume has been drawn in the card since the beginning for
                 * exactly this reason; the letter is half of what goes.
                 */
                (letterControls.typeset = h('button', {
                  className: 'tiny',
                  textContent: busyLabel('renderLetter', state.letterRender ? 'Typeset again' : 'See it typeset', 'Typesetting…'),
                  disabled: Boolean(state.busy) || !state.letter?.trim(),
                  title: 'Compile it the way it will be sent',
                  onclick: () =>
                    /*
                     * The base, not the proposal: a tailored spec only exists
                     * in this card until the folder is prepared, so asking the
                     * store to set a letter to match it would be asking about
                     * a resume it has never seen. What the letter borrows is
                     * the margins and the name at the top, and those come from
                     * the base either way.
                     */
                    act('renderLetter', { body: state.letter, resumeId: state.spec?.extends ?? state.spec?.id }, (r) => {
                      state.letterRender = r;
                    }),
                })),
                (letterControls.note = h('span', {
                  className: 'faint',
                  textContent: state.letterSaved ? 'Future drafts will start from this one.' : '',
                })),
              ]),
              drawPdfPane('letter', state.letterRender?.pdfUrl, 'letter'),
              state.letterRender
                ? h('div', { className: 'row gap' }, [
                    h('a', {
                      href: state.letterRender.absolutePdfUrl ?? state.letterRender.pdfUrl,
                      target: '_blank',
                      textContent: 'Open full size',
                    }),
                    // Not the file that gets attached — that one is compiled
                    // again, by the trusted engine, when the folder is built.
                    h('span', { className: 'faint', textContent: 'A preview; the attached copy is compiled when you prepare it.' }),
                  ])
                : null,
            ])
          : h('div', {}, [
              h('div', {
                className: 'hint',
                textContent: 'Drafted from the letters you have already written for similar roles.',
              }),
              h('div', { className: 'row gap' }, [
                aiButton(
                  {
                    title: 'Write a first draft from this posting and the letters you have written before. Runs your AI command.',
                    disabled: Boolean(state.busy),
                    onclick: draftLetter,
                  },
                  busyLabel('coverLetter', 'Draft a letter', 'Drafting…'),
                ),
              ]),
            ]),
      ]),
    );

    /* 3. Questions found on the page */
    const questionsStep = drawQuestionsStep();
    if (questionsStep) body.append(questionsStep);

    /*
     * What the page did not ask for. Detection is good, not perfect, and the
     * cost of being wrong should be one click rather than a lost application.
     */
    const missed = [
      !state.letterNeeded && !state.letterAsked
        ? h('button', {
            className: 'link',
            textContent: '+ Cover letter',
            title: 'This posting does not appear to ask for one — add it anyway',
            onclick: () => {
              state.letterAsked = true;
              draw();
              draftLetter();
            },
          })
        : null,
      h('button', {
        className: 'link',
        textContent: '+ Question',
        title: 'Add a question the page did not expose',
        onclick: addQuestionByHand,
      }),
    ].filter(Boolean);
    body.append(h('div', { className: 'row missed' }, missed));

    /* 4. Form and filing */
    body.append(
      h('div', { className: 'step' }, [
        stepHead(4, 'Fill in and file', Boolean(state.bundle)),
        progressFor(4),
        h('div', { className: 'row' }, [
          h('button', {
            className: 'tiny',
            textContent: busyLabel('autofill', 'Autofill this form', 'Filling…'),
            disabled: Boolean(state.busy),
            onclick: () => act('autofill', {}, (r) => (state.autofillReport = r)),
          }),
          /*
           * Named for what pressing it means, not for what it writes.
           *
           * It was "Save application folder", which is the implementation
           * seen from inside: a folder is written, two in fact. From outside
           * it is unclear what the folder holds — the record, the files to
           * attach, the tracker row — and "save" suggests filing something
           * that already exists rather than compiling it.
           *
           * This is the step that ends an application, so it is named for
           * that and it files the application as sent (see `bundle` in
           * content.js). The explanation of what lands on disk used to live
           * in a `title`, which is to say nowhere; it is a line under the
           * button now.
           */
          h('button', {
            className: 'primary',
            textContent: busyLabel('bundle', 'Prepare to submit', 'Preparing…'),
            disabled: Boolean(state.busy) || !state.render,
            title: state.render ? 'Compile, name the files properly, and snapshot what was sent' : 'Build the resume first',
            onclick: () =>
              act(
                'bundle',
                { spec: state.spec, coverLetter: state.letter, answers: collectedAnswers() },
                (bundle) => {
                  if (bundle) {
                    state.bundle = bundle;
                    state.view = 'done';
                  }
                },
              ),
          }),
        ]),
        /*
         * Why the button beside this is grey.
         *
         * The reason was a `title` on the button itself, and a tooltip on a
         * disabled button is the one place a tooltip cannot be relied on —
         * browsers differ on whether they show it at all, and it needs
         * hovering a control that looks like it does nothing. On a posting
         * the base resume already suits, "Prepare to submit" sits
         * there greyed with no visible reason, which reads as broken rather
         * than as one step out of order.
         */
        !state.render && !state.busy
          ? h('div', { className: 'hint', textContent: 'Build the resume first — then the files can be named and filed.' })
          : // What the button does, where it can be read without hovering it.
            !state.bundle && !state.busy
            ? h('div', {
                className: 'hint',
                textContent:
                  'Typesets the resume and letter as PDFs, names them for this company, puts them in one folder to ' +
                  'attach, and marks this one as sent.',
              })
            : null,
        state.autofillReport
          ? h('div', {
              // Green only when nothing is left. See `.ok-note.warn`.
              className: `ok-note${autofillLeftWork(state.autofillReport) ? ' warn' : ''}`,
              textContent: describeAutofill(state.autofillReport),
            })
          : null,
      ]),
    );

    if (state.error) body.append(drawError());
    return body;
  }

  /**
   * What went wrong, and the one thing that would put it right.
   *
   * The two failures worth acting on both end the same way — nothing works and
   * the card says so in a sentence the user cannot do anything with. ResumeM-M
   * not being open, and being open with no save in it, are each one click from
   * fixed, and the click belongs here rather than in a paragraph describing
   * where to find it.
   */
  function drawError() {
    const box = h('div', { className: 'err' }, [h('div', { textContent: state.error })]);
    const fix = state.errorFix;
    if (!fix) return box;

    box.append(
      h('div', { className: 'row gap err-actions' }, [
        h('button', {
          className: 'tiny',
          textContent: fix.fix === 'open-save' ? 'Open a save in ResumeM-M' : 'Open ResumeM-M',
          onclick: () => onAction('openTab', { url: fix.serverUrl }),
        }),
        h('button', {
          className: 'tiny',
          textContent: busyLabel('retry', 'Try again', 'Trying…'),
          onclick: () => act('rebuild', { tailor: state.builtWith ?? 'match' }),
        }),
      ]),
    );
    return box;
  }

  /** True when the report names fields the form still needs from you. */
  function autofillLeftWork(r) {
    return r.skipped.some((skip) => skip.reason !== 'already filled');
  }

  function describeAutofill(r) {
    const parts = [`Filled ${plural(r.filled.length, 'field')}`];

    /*
     * Skipped is not one thing. A field left alone because it already had an
     * answer is finished; one skipped because nothing in its list matched, or
     * because it is a widget nothing can drive, is a required field still
     * empty. Calling both "already had a value" told someone their country
     * dropdown was done when it read "Select One" — and autofill.js calls that
     * exact distinction the difference between done and done silently wrong,
     * which is why it records the reasons at all.
     */
    const done = r.skipped.filter((s) => s.reason === 'already filled').length;
    const yours = r.skipped.length - done;
    if (done) parts.push(`left ${plural(done, 'field')} that already had a value`);
    if (yours) parts.push(`${plural(yours, 'field')} still for you to answer`);
    return `${parts.join(', ')}.`;
  }

  /**
   * Every answer the card is showing, which is not the same as every answer
   * the user typed.
   *
   * Text matched out of the answer bank lives on the question (`q.answer`) and
   * is only read at render time, with `state.answers[q] ?? q.answer`. Walking
   * `state.answers` alone therefore shipped nothing for a question that was
   * answered from the bank and left as it stood — which is the whole point of
   * having a bank. Those questions were simply absent from the uploadable
   * Answers file and from the permanent record of what was sent, while every
   * box on screen was full.
   */
  function collectedAnswers() {
    const out = new Map();
    for (const q of state.questions ?? []) {
      const answer = state.answers[q.question] ?? q.answer ?? '';
      if (answer.trim()) out.set(q.question, answer);
    }
    // Questions typed in by hand are in `state.answers` and on no page.
    for (const [question, answer] of Object.entries(state.answers)) {
      if (answer?.trim()) out.set(question, answer);
    }
    return [...out].map(([question, answer]) => ({ question, answer }));
  }

  /**
   * Questions found on the page, matched against the answer bank. The whole
   * point is that the fifteenth "why this role?" starts from the fourteenth
   * answer rather than an empty box.
   */
  function drawQuestionsStep() {
    // Questions are taken off the page automatically. When there are none,
    // there is no step: an empty section that exists to say "nothing here" is
    // still something to read past.
    const writingNeeded = state.questions.length > 0;
    if (!writingNeeded) return null;

    const step = h('div', { className: 'step' }, [
      stepHead(3, 'Application questions', Object.keys(state.answers).length > 0),
      progressFor(3),
    ]);
    step.append(
      h('div', { className: 'row', style: 'margin-bottom:8px' }, [
        h('button', {
          className: 'tiny',
          textContent: busyLabel('openWorkspace', 'Write these in ResumeM-M', 'Opening…'),
          title: 'Hand the posting, the resume, and the questions to the editor, where there is room to write',
          disabled: Boolean(state.busy),
          onclick: () =>
            act(
              'openWorkspace',
              {
                spec: state.spec,
                // What is on screen, not what the page asked: an answer typed
                // here and left behind is an answer written twice.
                questions: (state.questions ?? []).map((q) => ({
                  ...q,
                  answer: state.answers[q.question] ?? q.answer ?? '',
                })),
                coverLetter: state.letter ?? '',
              },
              (r) => {
                if (r) state.workspaceOpened = true;
              },
            ),
        }),
        state.workspaceOpened
          ? h('span', { className: 'faint', textContent: 'Opened in the editor.' })
          : null,
      ]),
    );

    for (const q of state.questions) {
      /*
       * An answer that names somebody else is offered, never filled in.
       *
       * "Why do you want to work here?" is answered by naming the company, so
       * the answer written for Acme says Acme — and the bank handed it
       * straight into the box for the next application, badged "answered
       * before", which is the reassurance that stops you reading it. The
       * cover letter learned this the same way and was fixed the same way:
       * put it in front of the person, and let them take it.
       */
      const borrowed = Boolean(q.namesAnother) && !state.answers[q.question];
      const value = state.answers[q.question] ?? (borrowed ? '' : (q.answer ?? ''));
      const badge = q.namesAnother
        ? h('span', { className: 'badge weak', textContent: `written for ${q.namesAnother}` })
        : q.confident
          ? h('span', { className: 'badge', textContent: 'answered before' })
          : q.answer
            ? h('span', { className: 'badge weak', textContent: 'close match' })
            : h('span', { className: 'badge none', textContent: 'new question' });

      const box = h('div', { className: 'q' }, [
        h('div', { className: 'qt' }, [document.createTextNode(q.question), badge]),
        borrowed
          ? h('div', { className: 'row gap' }, [
              h('button', {
                className: 'tiny',
                textContent: `Start from what you told ${q.namesAnother}`,
                onclick: () => {
                  state.answers[q.question] = q.answer ?? '';
                  draw();
                },
              }),
              h('span', {
                className: 'faint',
                textContent: `It names ${q.namesAnother}, so it is not put in for you.`,
              }),
            ])
          : null,
        h('textarea', {
          value,
          // Named for the question it answers, so a repaint puts the caret
          // back in the same box even if another question arrived above it.
          dataset: { field: `answer:${q.question}` },
          placeholder: q.answer ? '' : 'No stored answer yet — write one and it is saved for next time.',
          oninput: (e) => (state.answers[q.question] = e.target.value),
        }),
        h('div', { className: 'row gap' }, [
          h('button', {
            className: 'tiny',
            textContent: 'Insert into form',
            disabled: !q.fieldId,
            onclick: () => onAction('insertAnswer', { fieldId: q.fieldId, text: state.answers[q.question] ?? value }),
          }),
          aiButton(
            {
              className: 'tiny',
              disabled: Boolean(state.busy),
              onclick: () => {
                // What is in the box now, so the reply can tell its own work
                // from anything written during the minutes it takes.
                const typedBefore = state.answers[q.question] ?? value;
                return act(`answer:${q.question}`, { question: q.question, force: true }, (r) => {
                  /*
                   * `executed` first, not `output` first.
                   *
                   * When the AI is off the server used to hand back the prompt
                   * it would have sent, in `output` — always truthy, so the
                   * second branch was dead and the answer box filled with nine
                   * kilobytes starting "You are helping with a resume and
                   * job-search assistant", carrying every cover letter the user
                   * had saved and their whole writing corpus. One more click
                   * put that in the employer's form. The server no longer sends
                   * it here, and this no longer reaches for it either.
                   */
                  if (r?.executed && r.output) {
                    /*
                     * And not over what was typed while it ran. The box stays
                     * enabled on purpose — the obvious thing to do with a wait
                     * of minutes is write the answer yourself — and the reply
                     * used to replace it outright, with no merge, no
                     * confirmation and no copy kept.
                     */
                    if ((state.answers[q.question] ?? '') !== typedBefore) {
                      state.answerNote = 'You were writing while that ran, so what you wrote was kept.';
                    } else {
                      state.answers[q.question] = r.output;
                    }
                  } else if (r && !r.executed) {
                    state.error =
                      'The AI is off, so a new answer cannot be drafted. Anything you type here is saved for next time.';
                  }
                });
              },
            },
            busyLabel(`answer:${q.question}`, q.answer ? 'Rewrite for this role' : 'Draft an answer', 'Writing…'),
          ),
          h('button', {
            className: 'link',
            textContent: 'Save for next time',
            onclick: () =>
              act('saveAnswer', {
                question: q.question,
                answer: state.answers[q.question] ?? value,
                itemId: q.itemId,
              }),
          }),
        ]),
      ]);
      step.append(box);
    }
    return step;
  }

  /* ---- Done view ---- */

  function drawDoneView() {
    const b = state.bundle;

    /*
     * What the form asked for and this folder does not contain.
     *
     * The panel says "Saved. These files are named and ready to attach" and
     * "Everything you are sending, in one place", and it said both while
     * quietly leaving out the cover letter. That is the ordinary path, not a
     * corner: the AI is off by default, so the letter drafts to nothing, the
     * previous letter is deliberately offered rather than used, and an empty
     * letter writes no file. You reach a screen that looks like completion,
     * attach what it lists, and send an application missing the document the
     * form asked for.
     *
     * A list of files cannot say what is absent, so it is said here.
     */
    const missing = [];
    if (state.letterNeeded && !state.letter?.trim()) missing.push('a cover letter');
    const unanswered = (state.questions ?? []).filter(
      (q) => q.required !== false && !(state.answers[q.question] ?? q.answer ?? '').trim(),
    ).length;
    if (unanswered > 0) missing.push(`${unanswered} ${unanswered === 1 ? 'answer' : 'answers'}`);

    /*
     * And what the store could not give it.
     *
     * The resume is built from a proposal made minutes or pages earlier, and
     * the store can change in between — that is the whole point of the round
     * trip to the editor. An entry deleted in the meantime, or a wording
     * renamed, leaves the resume compiling perfectly well without it. The
     * store has always said so and nothing here read it, so a resume missing
     * the job you were looking at was filed under "Saved. These files are
     * named and ready to attach".
     *
     * Only what the store is missing: the same list carries typography notes
     * about this machine's TeX install, which are true, worth saying once,
     * and not worth putting in front of somebody about to attach a file.
     */
    const lost = b.missing;

    return h('div', { className: 'body' }, [
      lost
        ? h('div', { className: 'done-missing' }, [
            h('strong', { textContent: `Not quite the resume you were looking at: ${lost}` }),
            h('div', {
              textContent:
                'It was built from a proposal made before that changed. Build it again to see what it says now — ' +
                'the files below were written from what the store holds today.',
            }),
          ])
        : null,
      missing.length > 0
        ? h('div', { className: 'done-missing' }, [
            h('strong', { textContent: `Not in this folder: ${missing.join(' and ')}.` }),
            h('div', {
              textContent:
                'The form asks for it. Write it above and save again, or attach it yourself — nothing here will add it for you.',
            }),
          ])
        : null,
      h('div', { className: 'done-box' }, [
        h('div', { textContent: 'Saved. These files are named and ready to attach:' }),
        ...b.files.map((f) => h('div', { className: 'file', textContent: f })),

        /*
         * The flat folder, not the archive. Both hold these files, but this is
         * the moment a file picker is about to open, and the flat folder is
         * the one that has everything still in flight in it — no folder per
         * application to navigate with the dialog already up.
         */
        h('div', { className: 'path', textContent: b.currentDir ?? b.dir }),
        h('div', { className: 'row gap' }, [
          /*
           * Open it, not just quote it.
           *
           * A path is what the upload dialog wants and nothing else can use:
           * from a job board, in a browser, it is a string. ResumeM-M serves
           * the same folder as a page — every file in it, each one opening in
           * a tab — so "where are my files" is a click from the card that
           * made them. `file://` would be the obvious link and is the wrong
           * one: an extension cannot send a tab to it without being granted
           * access to every file on the machine.
           */
          h('button', {
            className: 'tiny',
            textContent: 'Open the folder',
            title: 'See the files in a tab, and open any of them',
            onclick: () => onAction('openTab', { url: '/current' }),
          }),
          h('button', {
            className: 'tiny',
            textContent: 'Copy folder path',
            title: 'Paste it into the upload dialog',
            onclick: () => navigator.clipboard?.writeText(b.currentDir ?? b.dir),
          }),
          // Not claimed when it is not true — see `missing` above.
          b.currentDir
            ? h('span', {
                className: 'faint',
                textContent:
                  missing.length > 0
                    ? 'These are in one place. The full record is kept separately.'
                    : 'Everything you are sending, in one place. The full record is kept separately.',
              })
            : null,
        ]),
      ]),
      h('div', { className: 'row gap' }, [
        h('button', {
          className: 'tiny',
          textContent: busyLabel('autofill', 'Autofill this form', 'Filling…'),
          disabled: Boolean(state.busy),
          onclick: () => act('autofill', {}, (r) => (state.autofillReport = r)),
        }),
        /*
         * The escape hatch, not the step.
         *
         * This was "Mark as submitted", a second press that moved the tracker
         * on — and the press nobody makes, because by the time the files are
         * uploaded the tab has gone to a confirmation page and the card with
         * it. Preparing is what files it now, so what is left here is the one
         * case that goes the other way: the folder was built and the
         * application was abandoned. That is rare, so it is not the primary
         * button, but it has to be reachable or the tracker cannot be
         * corrected from the page it was wrong about.
         */
        h('button', {
          className: 'tiny',
          textContent: busyLabel('trackStatus', 'Not sent after all', 'Saving…'),
          disabled: Boolean(state.busy),
          title: 'Put this back on the list of applications still to finish',
          onclick: () =>
            act(
              'trackStatus',
              { id: b.application.id, status: 'applying', note: 'Prepared, then not sent' },
              () => {
                state.unsent = true;
              },
            ),
        }),
        h('button', {
          className: 'primary',
          textContent: 'Done',
          disabled: Boolean(state.busy),
          onclick: () => removeCard(),
        }),
      ]),
      state.unsent
        ? h('div', {
            className: 'ok-note warn',
            textContent: 'Put back — it is being worked on again, and the files stay where they are.',
          })
        : null,
      state.autofillReport
        ? h('div', {
            className: `ok-note${autofillLeftWork(state.autofillReport) ? ' warn' : ''}`,
            textContent: describeAutofill(state.autofillReport),
          })
        : null,
      h(
        'div',
        { className: 'hint', style: 'margin-top:8px' },
        state.unsent
          ? 'Kept in ResumeM-M with a copy of what was built, back among the ones being worked on.'
          : 'Marked as sent in ResumeM-M, with a copy of exactly what went out. The Workspace keeps it open ' +
            'for a fortnight in case anything comes back.',
      ),
      state.error ? drawError() : null,
    ]);
  }

  /**
   * Repaint, keeping the caret where it was.
   *
   * `draw` rebuilds the whole subtree, and it runs on every action starting
   * and finishing, on the AI status arriving, on the resume list arriving, on
   * the trail, on the questions. The keystrokes already typed survive, because
   * each one fires `oninput` — but the box being typed into is destroyed, so
   * focus goes to `null` and the *next* keystroke goes nowhere until the user
   * notices and clicks back. The realistic trigger is the AI pass that starts
   * itself and lands minutes later, mid-sentence.
   *
   * Boxes are identified by what they are for rather than by position, so the
   * caret comes back to the same answer even if a question has appeared above
   * it in the meantime.
   */
  function draw() {
    const active = root.activeElement;
    const focused = active && active !== card ? active.dataset?.field : null;
    const caret = focused ? { start: active.selectionStart, end: active.selectionEnd } : null;

    // Provisional until the analysis lands: what is on screen is the page's
    // own title, not anything this has worked out yet.
    card.classList.toggle('loading', !analysis);
    card.replaceChildren(
      drawHead(),
      !analysis ? drawReadingView() : state.view === 'done' ? drawDoneView() : drawProposeView(),
    );

    if (!focused) return;
    const again = card.querySelector(`[data-field="${CSS.escape(focused)}"]`);
    if (!again) return;
    again.focus({ preventScroll: true });
    try {
      again.setSelectionRange(caret.start, caret.end);
    } catch {
      // Not a text box any more, or the text is shorter than the old caret.
      // Focus is the part that matters; the position is a courtesy.
    }
  }

  /**
   * What the card looks like before the server has answered. It appears the
   * moment the page is judged a posting, rather than after everything is
   * ready — a card that shows up late looks like one that is broken.
   */
  function drawReadingView() {
    return h('div', { className: 'body' }, [
      h('div', { className: 'job' }, [
        h('div', { className: 'role provisional', textContent: document.title.slice(0, 70) || 'This posting' }),
        h('div', { className: 'co', textContent: location.hostname }),
      ]),
      h('div', { className: 'progress' }),
      h('div', { className: 'progress-label', textContent: 'Reading the posting…' }),
      state.error ? drawError() : null,
    ].filter(Boolean));
  }

  draw();

  return {
    remove: removeCard,
    /** The analysis, whether this is the first one or a later rebuild. */
    update(next) {
      analysis = analysis ? Object.assign(analysis, next) : next;
      state.spec = next.spec ?? state.spec;
      state.builtWith = next.tailor ?? (next.aiUsed ? 'ai' : state.builtWith);
      state.render = null;
      draw();
      maybeAutoDraft();
    },

    /**
     * This tab is in front again.
     *
     * Only interesting if the card is the reason it stopped being: the whole
     * point of "Edit in ResumeM-M" is to go and add the phrasing this posting
     * wants, and the proposal on screen was made before it existed.
     */
    cameBack() {
      if (!state.wentToEditor || state.editedElsewhere) return;
      state.wentToEditor = false;
      state.editedElsewhere = true;
      draw();
    },

    /** The pages this application spans, as the trail grows. */
    setTrail(trail) {
      state.trail = trail;
      draw();
    },

    /** The resume list, which arrives on its own. */
    setResumes(list) {
      resumes = list ?? [];
      draw();
    },

    /**
     * Run the AI pass, the same way the button does — progress bar and all.
     * Used when the user has asked for AI tailoring by default: it happens
     * after the deterministic proposal is already on screen, so there is
     * something to read and something to see happening.
     */
    async tailorWithAi() {
      state.rebuilding = 'ai';
      try {
        return await act('rebuild', { tailor: 'ai' }, () => {
          state.builtWith = 'ai';
          state.render = null;
        });
      } finally {
        state.rebuilding = null;
      }
    },
    /**
     * The form asks for a cover letter after all.
     *
     * Read from the top document when the card goes up, which is the whole of
     * the form on most systems and none of it on the ones that serve it in an
     * iframe. Those can only be read once the frames have answered, by which
     * point the card is already on screen.
     */
    setNeedsCoverLetter(needed) {
      if (!needed || state.letterNeeded) return;
      state.letterNeeded = true;
      draw();
    },
    setQuestions(qs) {
      state.questions = qs;
      // Questions arrive after the card is built, so anything carried over
      // from the last page can only be matched to them now.
      applyCarriedAnswers();
      draw();
    },

    /** Hand back the work worth keeping when this page is replaced. */
    takeWork,

    /** Put back the work from the page this one continues. */
    restoreWork,
    setStatus(text, fix = null) {
      state.error = text;
      // The first pass failing is the commonest way to meet this, and the
      // commonest reason is that ResumeM-M is not running.
      state.errorFix = fix;
      draw();
    },
  };
}
