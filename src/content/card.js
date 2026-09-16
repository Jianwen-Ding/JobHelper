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

/* Two ways to tailor, side by side, with the one in use marked. */
.build-modes { gap: 6px; }
button.mode { flex: 1 1 0; font-size: 12px; padding: 6px 8px; }
button.mode.on {
  border-color: transparent; color: #174ea6;
  background: var(--accent-soft); font-weight: 500;
}
button.mode.on:hover { background: #d2e3fc; }

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
.ok-note { color: var(--good); font-size: 12px; margin-top: 9px; }

.done-box {
  background: var(--good-bg); border: 1px solid var(--good-line); border-radius: 8px; padding: 11px;
}
.done-box .path {
  font-family: var(--mono); font-size: 11px; background: #fff; border: 1px solid var(--good-line);
  border-radius: 5px; padding: 7px 8px; margin-top: 8px; word-break: break-all; color: var(--ink-soft);
}
.done-box .file { font-size: 12px; color: var(--ink-soft); margin-top: 5px; }

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
    /** How the proposal on screen was produced: 'tags' or 'ai'. */
    builtWith: analysis?.aiUsed ? 'ai' : 'tags',
    /** Which compiled PDF is on screen, and the canvases already drawn. */
    shownPdf: null,
    pdfPages: new Map(),
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
      // Keyed by the question, not by the field it was typed into: the field
      // ids belong to a page that no longer exists.
      answersByQuestion: Object.fromEntries(
        (state.questions ?? [])
          .map((q) => [q.question, state.answers[q.fieldId] ?? q.answer])
          .filter(([, a]) => a?.trim()),
      ),
    };
  }

  function restoreWork(work) {
    if (!work) return;
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
    draw();
  }

  /** An answer typed on an earlier page, against the same question here. */
  function applyCarriedAnswers() {
    const carried = state.carriedOver;
    if (!carried) return;
    for (const q of state.questions ?? []) {
      const had = carried[q.question];
      if (had && !state.answers[q.fieldId]?.trim() && !q.answer?.trim()) {
        state.answers[q.fieldId] = had;
      }
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
    const n = Object.assign(document.createElement(tag), props);
    for (const k of [].concat(kids)) if (k != null && k !== false) n.append(k);
    return n;
  };

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

  async function act(action, payload, apply) {
    running.add(action);
    state.busy = action;
    state.error = null;
    draw();
    try {
      const result = await onAction(action, payload);
      apply?.(result);
      return result;
    } catch (err) {
      state.error = err.message;
      return null;
    } finally {
      running.delete(action);
      // Keep showing progress for whatever is still going.
      state.busy = [...running].pop() ?? null;
      draw();
    }
  }

  const busyLabel = (action, idle, working) => (running.has(action) ? working : idle);

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
      state.view !== 'propose'
        ? h('button', { className: 'icon', title: 'Back', textContent: '‹', onclick: () => { state.view = 'propose'; draw(); } })
        : null,
      h('button', { className: 'icon', title: 'Not now', textContent: '×', onclick: () => removeCard() }),
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
    return h('div', {}, [
      h('div', { className: 'progress', role: 'progressbar', 'aria-label': label }),
      h('div', { className: 'progress-label', textContent: label }),
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
  function drawChanges() {
    const diff = analysis.diff ?? [];
    const rationale = analysis.rationale ?? [];

    if (diff.length === 0 && rationale.length === 0) {
      return h('div', { className: 'no-change' }, 'Nothing needed changing — your base resume already suits this posting.');
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
  function drawResumePage() {
    if (!state.render?.pdfUrl) return null;

    const pages = h('div', { className: 'pdf-pages' });
    const pane = h('div', { className: 'pdf-pane' }, [pages]);

    // Redraw whenever a new compile lands, not on every re-render.
    if (state.shownPdf !== state.render.pdfUrl) {
      const wanted = state.render.pdfUrl;
      state.shownPdf = wanted;
      (async () => {
        try {
          const { base64 } = await onAction('pdfBytes', { url: wanted });
          const { drawPdf } = await import(chrome.runtime.getURL('src/content/pdfview.js'));
          if (state.shownPdf !== wanted) return; // a newer compile won
          await drawPdf(pages, base64, { width: 372 });
          state.pdfPages.set(wanted, pages.cloneNode(true));
          // Each of these is a page-sized bitmap. Keeping one per compile
          // meant a session of small edits quietly holding a dozen of them.
          for (const old of [...state.pdfPages.keys()].slice(0, -2)) state.pdfPages.delete(old);
        } catch (err) {
          pane.append(h('div', { className: 'hint', textContent: `Could not draw the resume: ${err.message}` }));
        }
      })();
    } else {
      // Already drawn once; reuse it so a re-render does not refetch.
      const cached = state.pdfPages.get(state.render.pdfUrl);
      if (cached) pane.replaceChildren(cached.cloneNode(true));
    }

    return pane;
  }

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

  /**
   * Draft the letter. Three honest outcomes, in descending order of help, and
   * all of them leave you with an editor rather than a dead end: a fresh
   * draft, your closest previous letter to adapt, or a blank page that becomes
   * the reference for next time.
   */
  function draftLetter() {
    return act('coverLetter', { spec: state.spec }, (r) => {
      if (!r) return;
      state.priorLetters = r.priorLetters ?? [];
      state.letterStarted = true;

      if (r.body?.trim()) {
        state.letter = r.body;
        state.letterSource = 'Drafted in your voice from your previous letters.';
      } else if (state.priorLetters.length > 0) {
        state.letter = state.priorLetters[0].body;
        state.letterSource = `The AI is off — this is your closest previous letter (${state.priorLetters[0].title}) to adapt.`;
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
    baseSelect.onchange = () => act('setBase', { baseResumeId: baseSelect.value, useAi: state.builtWith === 'ai' });

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
         * Two ways to get from the base to a tailored resume, chosen
         * deliberately rather than by a setting the user cannot see from here.
         * Matching is instant, free, and only ever picks among phrasings you
         * already wrote; the AI reads the posting and decides what to change.
         */
        h('div', { className: 'row build-modes' }, [
          h('button', {
            className: state.builtWith === 'tags' ? 'mode on' : 'mode',
            textContent: busyLabel('rebuild-tags', 'Match it myself', 'Matching…'),
            title: 'Pick among your stored phrasings by keyword. Nothing is sent to an AI.',
            disabled: Boolean(state.busy),
            onclick: () => {
              state.rebuilding = 'tags';
              return act('rebuild', { useAi: false }, () => {
                state.builtWith = 'tags';
                state.render = null;
                state.rebuilding = null;
              });
            },
          }),
          h('button', {
            className: state.builtWith === 'ai' ? 'mode on' : 'mode',
            textContent: busyLabel('rebuild-ai', 'Let the AI tailor it', 'Reading the posting…'),
            title: state.ai?.active
              ? 'The AI reads this posting and decides which phrasings and bullets to use.'
              : state.ai?.state === 'server-off'
                ? 'ResumeM-M has its AI switched off — turn it on under Voice & AI.'
                : 'Switch the AI on from the JobHelper toolbar icon to use this.',
            disabled: Boolean(state.busy) || !state.ai?.active,
            onclick: () => {
              state.rebuilding = 'ai';
              return act('rebuild', { useAi: true }, () => {
                state.builtWith = 'ai';
                state.render = null;
                state.rebuilding = null;
              });
            },
          }),
        ]),
        state.builtWith
          ? h('div', {
              className: 'hint',
              textContent:
                state.builtWith === 'ai'
                  ? analysis.aiUsed
                    ? 'The AI chose these changes.'
                    : 'The AI returned nothing usable, so this is the keyword match.'
                  : 'Chosen by keyword match against your own phrasings.',
            })
          : null,
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
              h('textarea', {
                className: 'tall',
                value: state.letter ?? '',
                placeholder: 'Write the letter here. Saving it makes it the reference for the next one.',
                oninput: (e) => (state.letter = e.target.value),
              }),
              h('div', { className: 'row gap' }, [
                h('button', {
                  className: 'tiny',
                  textContent: busyLabel('saveLetter', state.letterSaved ? 'Saved' : 'Save to store', 'Saving…'),
                  disabled: Boolean(state.busy) || state.letterSaved || !state.letter?.trim(),
                  onclick: () =>
                    act('saveLetter', { body: state.letter }, () => {
                      state.letterSaved = true;
                    }),
                }),
                h('button', {
                  className: 'tiny',
                  textContent: 'Copy',
                  disabled: !state.letter?.trim(),
                  onclick: () => navigator.clipboard?.writeText(state.letter ?? ''),
                }),
                h('span', {
                  className: 'faint',
                  textContent: state.letterSaved ? 'Future drafts will start from this one.' : '',
                }),
              ]),
            ])
          : h('div', {}, [
              h('div', {
                className: 'hint',
                textContent: 'Drafted from the letters you have already written for similar roles.',
              }),
              h('div', { className: 'row gap' }, [
                h('button', {
                  textContent: busyLabel('coverLetter', 'Draft a letter', 'Drafting…'),
                  disabled: Boolean(state.busy),
                  onclick: draftLetter,
                }),
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
          h('button', {
            className: 'primary',
            textContent: busyLabel('bundle', 'Save application folder', 'Saving…'),
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
        state.autofillReport
          ? h('div', {
              className: 'ok-note',
              textContent: describeAutofill(state.autofillReport),
            })
          : null,
      ]),
    );

    if (state.error) body.append(h('div', { className: 'err', textContent: state.error }));
    return body;
  }

  function describeAutofill(r) {
    const parts = [`Filled ${plural(r.filled.length, 'field')}`];
    if (r.skipped.length) parts.push(`left ${plural(r.skipped.length, 'field')} that already had a value`);
    return `${parts.join(', ')}.`;
  }

  function collectedAnswers() {
    return Object.entries(state.answers)
      .filter(([, v]) => v?.trim())
      .map(([question, answer]) => ({ question, answer }));
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
            act('openWorkspace', { spec: state.spec, questions: state.questions }, (r) => {
              if (r) state.workspaceOpened = true;
            }),
        }),
        state.workspaceOpened
          ? h('span', { className: 'faint', textContent: 'Opened in the editor.' })
          : null,
      ]),
    );

    for (const q of state.questions) {
      const value = state.answers[q.question] ?? q.answer ?? '';
      const badge = q.confident
        ? h('span', { className: 'badge', textContent: 'answered before' })
        : q.answer
          ? h('span', { className: 'badge weak', textContent: 'close match' })
          : h('span', { className: 'badge none', textContent: 'new question' });

      const box = h('div', { className: 'q' }, [
        h('div', { className: 'qt' }, [document.createTextNode(q.question), badge]),
        h('textarea', {
          value,
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
          h('button', {
            className: 'tiny',
            textContent: busyLabel(`answer:${q.question}`, q.answer ? 'Rewrite for this role' : 'Draft an answer', 'Writing…'),
            disabled: Boolean(state.busy),
            onclick: () =>
              act(`answer:${q.question}`, { question: q.question, force: true }, (r) => {
                if (r?.output) state.answers[q.question] = r.output;
                else if (r && !r.executed) {
                  state.error = 'The AI is off, so a new answer cannot be drafted. Anything you type here is saved for next time.';
                }
              }),
          }),
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
    return h('div', { className: 'body' }, [
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
          h('button', {
            className: 'tiny',
            textContent: 'Copy folder path',
            onclick: () => navigator.clipboard?.writeText(b.currentDir ?? b.dir),
          }),
          b.currentDir
            ? h('span', {
                className: 'faint',
                textContent: 'Everything you are sending, in one place. The full record is kept separately.',
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
        h('button', {
          className: 'primary',
          textContent: busyLabel('trackStatus', 'Mark as submitted', 'Saving…'),
          disabled: Boolean(state.busy),
          onclick: () =>
            act('trackStatus', { id: b.application.id, status: 'applied', note: 'Submitted from the browser' }, () => {
              removeCard();
            }),
        }),
      ]),
      state.autofillReport ? h('div', { className: 'ok-note', textContent: describeAutofill(state.autofillReport) }) : null,
      h('div', { className: 'hint', style: 'margin-top:8px' }, 'Tracked in ResumeM-M with a copy of exactly what was sent.'),
      state.error ? h('div', { className: 'err', textContent: state.error }) : null,
    ]);
  }

  function draw() {
    // Provisional until the analysis lands: what is on screen is the page's
    // own title, not anything this has worked out yet.
    card.classList.toggle('loading', !analysis);
    card.replaceChildren(
      drawHead(),
      !analysis ? drawReadingView() : state.view === 'done' ? drawDoneView() : drawProposeView(),
    );
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
      state.error ? h('div', { className: 'err', textContent: state.error }) : null,
    ].filter(Boolean));
  }

  draw();

  return {
    remove: removeCard,
    /** The analysis, whether this is the first one or a later rebuild. */
    update(next) {
      analysis = analysis ? Object.assign(analysis, next) : next;
      state.spec = next.spec ?? state.spec;
      state.builtWith = next.aiUsed ? 'ai' : state.builtWith;
      state.render = null;
      draw();

      // The posting asked for a letter, so start writing one — but only once
      // there is a resume to write it against, and only once.
      if (state.letterNeeded && !state.letterAutoStarted && state.spec) {
        state.letterAutoStarted = true;
        draftLetter();
      }
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
    tailorWithAi() {
      state.rebuilding = 'ai';
      return act('rebuild', { useAi: true }, () => {
        state.builtWith = 'ai';
        state.render = null;
        state.rebuilding = null;
      });
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
    setStatus(text) {
      state.error = text;
      draw();
    },
  };
}
