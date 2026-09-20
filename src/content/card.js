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

/*
 * Folded: the header, and what it is a header for.
 *
 * A 380px card sits over the form you are filling in, and dismissing it to
 * see a field means losing the letter, the answers and the built resume with
 * it. So it folds instead — down to one bar you can still read the role off,
 * and still see the spinner on, while a tailoring pass carries on behind it.
 */
.card.folded { height: auto; }
.card.folded .head { border-bottom: none; }
.folded-title {
  font-size: 12px; color: var(--muted); padding: 0 12px 10px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

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
/* The way out to the builder, quiet and on its own line: it is not a third
   way to build, and it used to look like one. */
.to-builder { padding: 2px 0; font-size: 12px; }

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
/*
 * Where a draft would come from, under the button that would ask for one.
 * Set off with a rule rather than left as another grey line, because it is
 * the answer to the question people actually have about an AI writing their
 * letter, and it has to be findable at a glance.
 */
.voice-from { margin: 2px 0 8px; padding-left: 8px; border-left: 2px solid var(--line, #e3e3e3); }
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
/* You have been here before. Said plainly, in the card's own voice, rather
   than dressed as a warning — reapplying is allowed, and often right. */
.job .before { margin-top: 6px; font-size: 12px; color: var(--muted); }
.job .before b { font-weight: 500; color: var(--ink); }

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
/* The way out of the overflow box, drawn in its own colour rather than the
   accent — a blue link on a red panel reads as belonging to something else. */
.fit.bad button.link { color: #b31412; text-decoration: underline; padding: 0; margin-left: 6px; font-size: 12px; }
.fit.bad button.link:hover { background: transparent; text-decoration-thickness: 2px; }
.fit.idle { background: var(--line-soft); border-color: transparent; color: var(--muted); font-weight: 400; }

/* What the tailoring changed, in words. */
.changes { display: grid; gap: 6px; margin: 8px 0 2px; }
/* Shut, the list is its heading: the count, and the way back to all of it. */
.changes.shut .change { display: none; }
.from-what { margin: 2px 0 4px; }
.fold-changes {
  background: none; border: 0; padding: 0 4px 0 0; margin: 0; cursor: pointer;
  color: var(--faint); font-size: 13px; line-height: 1; min-width: 14px;
}
.fold-changes:hover { color: var(--ink); }
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
/* A box per change, ticked when the change is in.
   Square rather than round on purpose: these are independent decisions, not a
   choice of one from several, and a row of circles would say the opposite. */
.change { display: flex; align-items: flex-start; gap: 9px; }
.change-body { min-width: 0; flex: 1 1 auto; }
.pick { position: relative; flex: 0 0 auto; margin-top: 2px; cursor: pointer; line-height: 0; }
.pick input {
  position: absolute; opacity: 0; width: 16px; height: 16px; margin: 0; cursor: pointer;
  /* Over the square it draws, not under it. The span is painted after the
     input and would otherwise swallow every click aimed at the control. */
  z-index: 1;
}
.pick .box {
  display: block; width: 16px; height: 16px; border-radius: 3px;
  border: 2px solid var(--muted); background: #fff; transition: background .12s, border-color .12s;
}
.pick input:checked + .box { background: var(--accent); border-color: var(--accent); }
/* The tick, drawn rather than typed: a glyph would sit at the mercy of
   whatever font the host page happens to have loaded. */
.pick input:checked + .box::after {
  content: ''; position: absolute; left: 5px; top: 1px;
  width: 4px; height: 9px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(42deg);
}
.pick input:focus-visible + .box { box-shadow: 0 0 0 3px var(--accent-hover-layer); }
.pick input:disabled + .box { opacity: .45; cursor: default; }
/* Switched off: the change is still shown, because seeing what you turned
   down is the point of leaving the row there. The strike moves to the side
   that is no longer in the document. */
.change.off { opacity: .72; }
.change.off .ba ins {
  background: var(--line-soft); color: var(--muted);
  text-decoration: line-through; text-decoration-color: var(--line);
}
.change.off .ba del { text-decoration: none; color: var(--ink); background: var(--good-bg); }
.change.off .ba .plain { text-decoration: line-through; color: var(--muted); }

/* The half that is not in the document, kept short.
   Both sides were drawn at full length, so a row offering a four-line
   rewrite spent eight lines saying so — and half of that was a sentence
   nobody had chosen. Struck through over four lines is also genuinely hard
   to read. Two lines is enough to recognise which wording it is, and the
   whole of it is one click away in the builder. Clamped rather than hidden:
   a row with one side missing cannot be compared, which is the only reason
   to open this list. */
.change .ba .aside {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden; font-size: 11.5px; line-height: 1.4;
}
/* The folder the upload dialog wants, while it is still wanted. */
.staged {
  background: var(--panel-sunk); border: 1px solid var(--line-soft); border-radius: 8px;
  padding: 8px 10px; margin-bottom: 8px; font-size: 12px; color: var(--muted);
}
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
.done-box .path, .staged .path {
  font-family: var(--mono); font-size: 11px; background: #fff; border: 1px solid var(--good-line);
  border-radius: 5px; padding: 7px 8px; margin-top: 8px; word-break: break-all; color: var(--ink-soft);
}
/* Selectable, because pasting it is the point. */
.staged .path { user-select: all; border-color: var(--line); margin-bottom: 8px; }
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
/* The way out, kept to the weight of the line it sits on. It is a real exit
   and it should be findable, but it is not the thing you came here to press:
   a Stop drawn as loudly as the button that started the work would read as a
   warning about work that is going fine. */
.progress-label .stop {
  margin-left: 8px;
  padding: 0 6px;
  border: none;
  border-radius: 4px;
  background: none;
  font: inherit;
  color: var(--muted);
  text-decoration: underline;
  cursor: pointer;
}
.progress-label .stop:hover { background: var(--state-hover); color: var(--ink); }

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

  /*
   * Whether what arrived is a decision or a set of offers.
   *
   * Only a run where the model actually answered is a decision — it read the
   * posting and chose, and undoing its choices one at a time is what the
   * boxes are for. Everything else is the keyword match, which is now a list
   * of suggestions: it arrives computed and switched off, over the resume
   * exactly as it is kept. An AI run that fell back to the match is in the
   * second group, not the first, because nothing decided anything.
   */
  const isDecision = (a) => a?.tailor === 'ai' && a?.aiUsed;

  const state = {
    // Hoisted, so this can call a function declared further down.
    spec: isDecision(analysis)
      ? analysis.spec
      : withAllOff(analysis?.spec ?? null, analysis?.rationale, analysis?.skillChanges),
    /** The pages this application is being written from. See drawTrail. */
    trail: null,
    render: null,
    busy: null,
    error: null,
    bundle: null,
    view: 'propose',
    /**
     * Folded down to its header, so the form underneath can be read.
     *
     * Per card rather than remembered: folding is something you do to see the
     * field this one is sitting on, and the next posting is a different
     * question. It survives every repaint, which is what matters — a
     * tailoring pass landing mid-application must not unfold the card over
     * the box you are typing in.
     */
    folded: false,
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
    /*
     * Where this proposal came from, in the two values that now exist.
     *
     * The default used to be `'match'`, which was a guess that stopped being
     * right the moment arriving stopped changing anything: a card given an
     * analysis with no `tailor` claimed a keyword match had been applied and
     * lit that button, over a resume nothing had touched.
     */
    builtWith: isDecision(analysis) ? 'ai' : 'none',
    /**
     * Both readings of this posting, kept side by side.
     *
     * There are two, they are made differently, and they used to share one
     * slot: whichever arrived last was the proposal, and the other was gone.
     * That is wrong in both directions. Asking the AI threw away a keyword
     * list somebody had already been through and ticked; and the opening
     * read, which lands on its own a few seconds later, could overwrite three
     * minutes of a model's work with a match nobody asked for.
     *
     * Comparing them is the interesting part anyway — the whole question a
     * person has in front of a tailored resume is "what did it do that I
     * would not have done?", and that needs both answers present.
     *
     * Each slot holds the proposal-bearing half of an analysis plus the spec
     * as it currently stands, so the boxes ticked on one survive a trip to
     * the other and back.
     */
    offers: { match: null, ai: null },
    /** Which of them is on screen. Null until the first one arrives. */
    showing: null,
    /** Which compiled PDF is on screen per kind, and the canvases drawn. */
    shownPdf: { resume: null, letter: null },
    pdfPages: new Map(),
    /** The typeset cover letter, once it has been asked for. */
    letterRender: null,
    /** Why the last one could not be drawn, if it could not. */
    pdfError: null,
    /**
     * Something that happened and went well, said in words.
     *
     * Apart from `error`, everything the card tells you is a description of
     * what is on it — the summary, the counts, the buttons. That leaves no
     * way to report an *event*, and the event that most needed reporting was
     * the longest one: a tailoring pass finishing. Putting it in `error`
     * would be the red strip, which is the wrong sentence in the wrong
     * colour.
     */
    note: null,
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
    /*
     * What was carried is a starting point, not a correction.
     *
     * `builtWith` used to be written straight in, and with both readings kept
     * that became visible: work saved on the previous page while the keyword
     * list was showing would land on a card already showing the AI's version
     * — the AI's button lit, its rows underneath, and the summary between
     * them saying the resume was exactly as it is kept. Restoring is only
     * ever the *first* proposal on a card, so it is skipped once one has
     * arrived on its own.
     */
    if (work.spec && !state.showing) {
      state.spec = work.spec;
      if (work.builtWith) state.builtWith = work.builtWith;
      state.showing = work.builtWith === 'ai' ? 'ai' : 'match';
      state.offers[state.showing] = {
        analysis: proposalOf(analysis ?? {}),
        spec: work.spec,
        full: work.spec,
        none: withAllOff(work.spec, analysis?.rationale, analysis?.skillChanges),
      };
    } else if (work.spec && !state.offers[state.showing]) {
      state.spec = work.spec;
    }
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
  /*
   * Counted, not a set.
   *
   * The build buttons no longer wait for each other, so two runs can
   * genuinely be in flight — press "Use Original" while the AI reads and its
   * recompile finishes in a moment. A set holds one entry per name, so the
   * fast one's `delete` cleared it, the bar came down and every button came
   * back while a model was still running. Which is precisely the thing the
   * bar exists to be honest about.
   *
   * `running` is kept as the set of names that have at least one run in
   * flight; `depth` is how many.
   */
  const depth = new Map();
  const running = {
    add: (a) => depth.set(a, (depth.get(a) ?? 0) + 1),
    delete: (a) => {
      const left = (depth.get(a) ?? 1) - 1;
      if (left > 0) depth.set(a, left);
      else depth.delete(a);
    },
    has: (a) => depth.has(a),
    [Symbol.iterator]: () => depth.keys(),
  };
  /** When each in-flight action started, so the card can say how long. */
  const startedAt = new Map();

  /**
   * What each action holds while it runs.
   *
   * Knowing *that* something is in flight was enough to draw a progress bar
   * and never enough to decide what to grey out, but it was used for both:
   * every control on the card tested the same `busy` flag. So a tailoring
   * pass — which is a model reading a job posting, and takes minutes — locked
   * the whole card. You could not type in the cover letter it was not
   * touching, answer a question, open the builder, or even press Done to put
   * the card away, for the length of a run that had nothing to do with any of
   * them.
   *
   * A control waits for the work that would actually collide with it and
   * ignores the rest. Filing waits for both of the things it files. Opening a
   * tab and dismissing the card wait for nothing at all, because there is no
   * state of this card in which you should be unable to leave.
   *
   * Unknown actions are treated as holding the resume, which is the cautious
   * reading: it is the lane almost everything is in, and a new action that
   * forgets to name itself here grants no new freedom by accident.
   */
  const LANE = {
    rebuild: 'resume',
    /*
     * Compiling has its own lane, because it is the one thing on this card
     * that works on the resume you already have.
     *
     * It sat in `resume` with the three rebuild modes, so an AI pass — a model
     * reading a posting, minutes of it — greyed out "Build resume" as well.
     * That is the wrong way round: the proposal on screen is complete and
     * compilable the whole time the scan runs, and wanting the file while the
     * AI thinks about a better one is the ordinary case, not a mistake. The
     * scan is an offer, and nobody should have to wait for an offer.
     *
     * What the shared lane was really protecting is `renderedFrom` below: a
     * compile of one proposal must not be shown as a picture of another.
     * Guarding that directly is both narrower and stricter — it also catches
     * the rebuild landing *during* a compile, which sharing a lane never did,
     * because by then the compile had already started.
     */
    render: 'compile',
    refine: 'resume',
    setBase: 'resume',
    /*
     * Drafting is its own lane, separate from working on what is in the box.
     *
     * It sat in `letter` with Save to store and See it typeset, so asking for
     * a draft greyed out both — under a box you had already written in. That
     * is the AI holding up work it is not touching, which is the same fault
     * the lanes exist to prevent, one level down: a run that takes minutes
     * must not be able to stop you keeping what you already have.
     *
     * Nothing is lost by letting them run together. Saving mid-draft saves
     * the text that was in the box, which is the text you were looking at;
     * the draft still lands afterwards, and the box says so.
     */
    coverLetter: 'drafting',
    renderLetter: 'letter',
    saveLetter: 'letter',
    saveAnswer: 'answers',
    // Both, because it writes both — see `writeEverything`.
    writeApplication: 'drafting',
    autofill: 'page',
    bundle: 'submit',
    trackStatus: 'submit',
    // Its own lane: staging runs after every build and must block nothing.
    stage: 'staging',
    clearTrail: 'trail',
    forgetPage: 'trail',
    setAiEnabled: 'settings',
    openWorkspace: 'elsewhere',
  };
  // An action may hold more than one lane: the one-run write holds the letter
  // and the answers, because it is writing both.
  /**
   * Which lanes an action holds.
   *
   * `answer:<the question>` is one action per question rather than a fixed
   * name, so it could never appear in `LANE` and fell through to the default
   * — which is `resume`. Drafting one answer therefore greyed out the build
   * buttons and the tailoring modes, none of which it touches, and did not
   * grey out the other draft buttons, which it does collide with. Both the
   * wrong way round.
   */
  const lanesOf = (action) =>
    [].concat(action?.startsWith('answer:') ? 'drafting' : LANE[action] ?? 'resume');

  const busyIn = (...lanes) =>
    [...running].some((a) => lanesOf(a).some((held) => lanes.includes(held)));

  /**
   * A later rebuild beats an earlier one, however long the earlier takes.
   *
   * The three mode buttons used to wait for each other, which was right while
   * they all took a moment. An AI pass takes minutes, and being unable to say
   * "never mind, match it by keyword" for the whole of one is the scan holding
   * the card hostage. So they no longer wait — and this is what stops the
   * loser landing on top of the winner: every rebuild takes a number, and a
   * reply whose number is no longer the current one is dropped on arrival.
   */
  let rebuildToken = 0;

  async function act(action, payload, apply) {
    running.add(action);
    if (!startedAt.has(action)) startedAt.set(action, Date.now());
    state.busy = action;
    state.error = null;
    state.errorFix = null;
    draw();
    try {
      const result = await onAction(action, payload);
      apply?.(result);
      return result;
    } catch (err) {
      /*
       * Asked to stop is not gone wrong.
       *
       * Pressing Stop abandons the request, and an abandoned request comes
       * back here as a rejection like any other — so the first version of
       * this put "Stopped." in the red error strip, which tells somebody who
       * has just pressed a button that the thing they asked for failed. The
       * card goes quiet instead and keeps whatever was already on screen: the
       * proposal from before the run is still good, and it is the thing they
       * are going back to.
       */
      if (err.jobhelper?.stopped) return null;
      state.error = err.message;
      // Some failures have a way out. Keep it, so the card can offer it.
      state.errorFix = err.jobhelper ?? null;
      return null;
    } finally {
      running.delete(action);
      // The clock belongs to the run still going, not to the one that ended.
      if (!running.has(action)) startedAt.delete(action);
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
    proposing() && state.rebuilding === mode ? working : idle;

  /**
   * Whether what is on screen is the resume exactly as it is kept.
   *
   * Read off the proposal rather than remembered, because the boxes can be
   * ticked and unticked one at a time: "Use Original" is not a mode you are
   * put into, it is the state of being on the keyword list with none of it
   * taken. An AI decision is never this, whatever it chose — it is a
   * different document by construction.
   */
  const onOriginal = () => state.showing !== 'ai' && appliedCount() === 0;

  /**
   * Build the proposal from the base, superseding whatever was already being
   * built.
   *
   * The modes were written out wherever they were offered, and they waited
   * for each other. Waiting is right between two that take a moment and wrong
   * when one of them is a model reading a posting: being unable to say "never
   * mind, send what I have" for three minutes is the scan holding the card. So a
   * later press wins, and the token is what keeps the loser from landing on
   * top of it — the slow reply still arrives, finds its number stale, and is
   * dropped.
   */
  async function rebuildAs(mode) {
    const mine = ++rebuildToken;
    state.rebuilding = mode;
    try {
      return await act('rebuild', { tailor: mode }, (result) => {
        if (mine !== rebuildToken) return;
        /*
         * What came back, not what was asked for.
         *
         * This recorded `mode`, so pressing "Have AI Tailor" lit the AI
         * button whether or not a model had answered — a run that never
         * started, or came back with prose instead of choices, falls through
         * to the suggestions and changes nothing, and the card said the AI
         * had tailored it. The same reading as everywhere else: only a run
         * the model actually answered is a decision.
         */
        // This one *was* asked for, so it takes the screen. `update` has
        // already filed it; see there for why filing and showing are apart.
        if (result?.spec) showOffer(slotOf(result));
      });
    } finally {
      // Only the current one clears the label; a superseded reply arriving
      // late must not say the winner has finished.
      if (mine === rebuildToken) state.rebuilding = null;
    }
  }

  /**
   * The same work, started from the picker instead of the buttons.
   *
   * The mode is the one the proposal is already in, because the suggestions
   * belong to the pair (base, posting) and changing either means working them
   * out again — and on an AI proposal that is a fresh model pass, which is
   * minutes. That is the whole reason this goes through the same bookkeeping
   * as `rebuildAs` rather than dispatching `act` directly: the label, the
   * Stop and the AI indicator are all read off `state.rebuilding`, and a base
   * switch that set none of them started the longest run on the card wearing
   * the clothes of the shortest.
   */
  async function switchBaseTo(baseResumeId) {
    const mode = state.builtWith === 'ai' ? 'ai' : 'match';
    const mine = ++rebuildToken;
    state.rebuilding = mode;
    try {
      return await act('setBase', { baseResumeId, tailor: mode }, (result) => {
        if (mine !== rebuildToken) return;
        // What came back, not what was asked for — see `rebuildAs`.
        if (result?.spec) showOffer(slotOf(result));
      });
    } finally {
      if (mine === rebuildToken) state.rebuilding = null;
    }
  }

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
    /*
     * This extension's own switch, off.
     *
     * The dead end, and the one somebody who has just set an AI up walks
     * straight into: you turn the AI on in ResumeM-M — which is where the
     * command, the model and the effort all live, so it is where you are
     * sitting — and the card still says "AI off". Both switches have to
     * agree, the second one is behind the toolbar icon, and nothing on the
     * card said so or could be pressed. `server-off` below is the mirror of
     * this and has been clickable all along; this side was a tooltip.
     *
     * Named by which switch it is, because "AI off" with the AI on in the
     * other window reads as the card being wrong rather than as a second
     * switch existing.
     */
    off: {
      text: 'AI off in JobHelper',
      className: 'ai warn',
      title: "This extension's own AI switch is off, so nothing is sent to an AI. Click to turn it on.",
      turnOn: 'setUseAi',
    },
    /** Neither switch on: the same click, and the chip then offers the other. */
    'both-off': {
      text: 'AI off',
      className: 'ai off',
      title:
        'Nothing is sent to an AI. Tailoring is keyword matching against your own stored phrasings. ' +
        "Click to turn this extension's switch on; ResumeM-M has its own, and the chip will offer it next.",
      turnOn: 'setUseAi',
    },
    'server-off': {
      text: 'AI off in ResumeM-M',
      className: 'ai warn',
      title: 'Set to use the AI, but ResumeM-M has it switched off. Click to turn it on.',
      turnOn: 'setAiEnabled',
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
    /*
     * "Off" is two different states and they need different words. Off here
     * with ResumeM-M's AI on is one switch away from working and says so;
     * off in both places is the ordinary quiet default and reads as one.
     */
    const named = state.ai.state === 'off' && !state.ai.serverEnabled ? 'both-off' : state.ai.state;
    // A state this version does not know is not an invitation to press
    // anything, so the fallback is the quiet one.
    const look = AI_CHIP[named] ?? AI_CHIP['both-off'];
    const chip = h('span', {
      className: `${look.className}${look.turnOn ? ' actionable' : ''}`,
      title: look.title,
      textContent: look.text,
    });

    if (look.turnOn) {
      chip.onclick = () => {
        chip.textContent = 'Turning on…';
        act(look.turnOn, { enabled: true }, (ai) => {
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
      /*
       * Fold, rather than close.
       *
       * The card sits over the form, and the field you need is under it often
       * enough that "get out of the way" is an ordinary thing to want. Closing
       * did that and took the letter, the answers and the built resume with
       * it. This keeps all of that and gives back the screen.
       *
       * Before the × for the same reason it reads that way: the reversible
       * one first.
       */
      h('button', {
        className: 'icon',
        title: state.folded ? 'Unfold' : 'Fold out of the way',
        ariaLabel: state.folded ? 'Unfold JobHelper' : 'Fold JobHelper out of the way',
        textContent: state.folded ? '⌄' : '⌃',
        onclick: () => { state.folded = !state.folded; draw(); },
      }),
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
      drawSentBefore(),
      drawTrail(),
    ].filter(Boolean));
  }

  /**
   * "You applied to this one on the twelfth of March."
   *
   * The tracker has known this all along; the moment it is worth anything is
   * the moment before the work starts, and that moment happens here rather
   * than in the builder. Reapplying to a role that came round again is a fine
   * thing to do — so this says what happened and stops, with no warning
   * colour and nothing to dismiss. What it prevents is the other version:
   * twenty minutes on a second letter, and then finding the first one in the
   * tracker afterwards.
   *
   * The store decides whether there is anything to say; the card only decides
   * how to say it. The rule about a posting that names a role but no company
   * lives there, with the applications.
   */
  /**
   * What the AI would be writing from, said where it is offered.
   *
   * A model writing a cover letter is the part of this people are rightly
   * wariest of, and the answer to that wariness is the whole reason the
   * letter bank, the answer bank and the writing notes exist: it works from
   * their letters, their samples and their own account of how they write. The
   * card asked for a letter and never said where one would come from, so the
   * button read as "have a machine write this" — which is the thing it does
   * not do.
   *
   * Counted, because a count is something somebody can go and check, and
   * because zero is the honest answer on a first application and the one most
   * worth showing: a letter written with nothing of yours to learn from is a
   * different offer, and should look like one.
   */
  function drawVoiceFrom(kind) {
    const v = analysis?.voice;
    if (!v) return null;
    const bank = kind === 'letter' ? v.letters : v.answers;
    const written = kind === 'letter' ? 'letter' : 'answer';

    const from = [];
    if (bank > 0) from.push(`${bank} ${written}${bank === 1 ? '' : 's'} you have written`);
    if (v.samples > 0) from.push(`${v.samples} writing sample${v.samples === 1 ? '' : 's'}`);
    if (v.notes) from.push('your notes on how you write');

    const said = from.length === 0
      ? `In your voice — but there is nothing of yours to learn it from yet. Add a ${written} you have written under Voice & AI.`
      : `In your voice, from ${from.length > 1 ? `${from.slice(0, -1).join(', ')} and ${from[from.length - 1]}` : from[0]} — not from nothing.`;
    return h('div', { className: 'hint voice-from', textContent: said });
  }

  function drawSentBefore() {
    const past = analysis?.applied;
    if (!past?.at) return null;

    const when = new Date(past.at);
    if (Number.isNaN(when.getTime())) return null;
    const sameYear = when.getFullYear() === new Date().getFullYear();
    const said = when.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      ...(sameYear ? {} : { year: 'numeric' }),
    });

    // What happened next, where there is a next. "Applied" on its own is the
    // ordinary case and needs no second clause.
    const since = {
      interview: ' — you were interviewing',
      offer: ' — and got it',
      closed: ' — and it closed',
    }[past.status];

    return h('div', { className: 'before' }, [
      document.createTextNode('You applied to this on '),
      h('b', { textContent: said }),
      document.createTextNode(`${since ?? ''}.${past.id ? ' ' : ''}`),
      /*
       * And the question that follows it. "You applied in March" invites
       * exactly one reply — what did I send them? — and the answer is in the
       * tracker, behind opening the editor, finding the tab and scrolling
       * back past everything since. The record is one click instead.
       */
      past.id
        ? h('button', {
            className: 'link',
            textContent: 'See what you sent',
            title: 'Open that application in ResumeM-M',
            onclick: () => onAction('openTab', { url: `/#applications/${encodeURIComponent(past.id)}` }),
          })
        : null,
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
    writeApplication: [2, 'Writing the letter and the answers…'],
  };

  /** What `rebuild` is doing, which depends on which of the three was pressed. */
  const REBUILDING = {
    none: 'Copying it across…',
    match: 'Matching on keywords…',
    ai: 'Reading the posting…',
  };

  /*
   * And the same three from the picker, which starts the same work.
   *
   * "Starting from that resume…" was said whichever mode the switch was in,
   * including the one that runs a model for minutes: a bar that reads like a
   * copy, with a clock on it passing thirteen seconds and climbing, and
   * nothing saying an AI was involved at all.
   */
  const SWITCHING = {
    none: 'Starting from that resume…',
    match: 'Starting from that resume, matching on keywords…',
    ai: 'Reading the posting again, from that resume…',
  };

  /**
   * Runs the worker can be told to let go of, and what it calls each one.
   *
   * Only the long ones. A compile or a save is over before the button could be
   * found, and offering to stop something that is already finished is how you
   * end up with a button that does nothing when pressed.
   */
  const STOPPABLE = {
    rebuild: 'rebuild',
    /*
     * Switching base is the same run under another name.
     *
     * The picker asks for the mode the proposal is already in, so on an
     * AI-built one it starts a fresh model pass — minutes — and the worker
     * registers it under `rebuild` like any other analysis. Everything that
     * exists for a long run was keyed on the *card's* action name, though, so
     * a base switch got the short bar, the wrong sentence and no way out.
     */
    setBase: 'rebuild',
    coverLetter: 'coverLetter',
    writeApplication: 'writeApplication',
  };
  const stopName = (action) =>
    action?.startsWith('answer:') ? 'answerQuestion' : STOPPABLE[action] ?? null;

  /**
   * Let go of the run this bar belongs to.
   *
   * Stopping is not undoing and the card does not pretend otherwise: whatever
   * was on screen before the run stays on screen, because the run never got
   * as far as replacing it. What this costs is the run itself — the model on
   * ResumeM-M's side is a process that keeps going to the end whatever we do
   * here, so a stopped AI pass is money already spent, not money saved. What
   * it buys is the card back.
   *
   * The token goes up as well as the request going down. A stop and a reply
   * can cross: the request that is already answering at the moment the button
   * is pressed will not be aborted in time, and without the bump it would
   * land afterwards and overwrite the proposal the person just chose to keep.
   */
  async function stopWork(action) {
    const what = stopName(action);
    if (!what) return;
    if (what === 'rebuild') {
      rebuildToken += 1;
      state.rebuilding = null;
    }
    // The worker rejects the in-flight request, which `act` recognises and
    // passes over in silence; this call only has to ask.
    await onAction('cancelWork', { what: [what] }).catch(() => undefined);
  }

  /** The two actions that put a proposal together, either of which may be the AI. */
  const proposing = () => running.has('rebuild') || running.has('setBase');

  /** Whether the AI is the thing holding this card up right now. */
  const aiIsReading = () => proposing() && state.rebuilding === 'ai';

  /**
   * Actions whose bar is drawn beside the button that started them rather than
   * at the top of their step. Long AI work, in other words: the question "is
   * the AI what I am waiting for?" should be answerable by looking at the
   * button, not by reading a label under a heading.
   */
  const HOMED = new Set(['writeApplication']);

  /**
   * @param step which numbered step this bar belongs under
   * @param opts `{ ai: true }` for the bar that sits beside the AI button.
   *
   * The AI's bar is drawn where the AI is, not at the top of the step.
   * Everything in step one shared one bar, so a model reading the posting for
   * three minutes looked exactly like a compile — the same bar in the same
   * place, under a heading that says "Resume". Whether the AI is what you are
   * waiting for is the question worth answering without reading anything, so
   * the bar for it lives next to the button that started it and the rest of
   * the step keeps its own.
   */
  function progressFor(step, opts = {}) {
    const action = state.busy;
    const entry = WORKING[action];
    if (!entry || entry[0] !== step) return null;

    // `here` names the action this bar is the home of — or `'ai'` for the
    // tailoring pass, which is one action wearing three hats. A bar with a
    // home of its own is never also drawn at the top of its step.
    const athome = aiIsReading() ? 'ai' : HOMED.has(action) ? action : null;
    if (opts.here ? opts.here !== athome : athome) return null;
    /*
     * One action, more than one job, and the bar has to name the one you
     * asked for.
     *
     * `rebuild` was the same call whichever mode button was pressed, so a
     * single label meant the bar said "Choosing what to change…" to someone
     * who had just asked for nothing to be changed. Read against what was
     * asked for: the only reason to watch this bar is to find out whether
     * that is what is happening. It still matters — the offer to work the
     * suggestions out again comes through here as `match`.
     */
    const label =
      (running.has('rebuild') && REBUILDING[state.rebuilding]) ||
      (running.has('setBase') && SWITCHING[state.rebuilding]) ||
      entry[1];

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

    /*
     * And a way out of it.
     *
     * Every long run on this card was one-way: a model reading a posting is
     * minutes, and the only exits were waiting for it and closing the card,
     * which loses the letter and the answers with it. The stop sits in the
     * bar rather than beside the button that started it because the bar is
     * what you are looking at while you decide — and it only exists while
     * there is something to stop, so it can never be the button that does
     * nothing.
     */
    const what = stopName(action);
    return h('div', {}, [
      h('div', { className: 'progress', role: 'progressbar', 'aria-label': label }),
      h('div', { className: 'progress-label' }, [
        h('span', { textContent: label }),
        clock,
        ...(what
          ? [
              h('button', {
                className: 'stop',
                type: 'button',
                textContent: 'Stop',
                title:
                  what === 'rebuild'
                    ? 'Stop this and keep the resume as it is now.'
                    : 'Stop this and keep what is already written.',
                onclick: () => stopWork(action),
              }),
            ]
          : []),
      ]),
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
  /**
   * One line naming the resume being sent and what, if anything, was done
   * to it.
   *
   * Two modes and a count, now that the keyword match is a list of offers
   * rather than somewhere you can be. "Which version am I actually sending?"
   * is answered by naming the base, saying whether the AI decided anything,
   * and saying how many suggestions are switched on — because a resume with
   * four boxes ticked is not the base resume, whatever mode the card is in.
   */
  /**
   * How many suggestions are switched on, counted off the proposal itself.
   *
   * Asked by the summary line as well as by the list, and the two must not
   * be able to disagree — a sentence saying "three switched on" over a list
   * showing four ticks is worse than no sentence. So both read the same
   * source, which is the spec that gets compiled and filed.
   */
  function suggestions() {
    const changeFor = new Map();
    for (const r of analysis.rationale ?? []) if (r.toText) changeFor.set(plainish(r.toText), r);
    const skillFor = new Map();
    for (const sc of analysis.skillChanges ?? []) if (sc.groupName) skillFor.set(plainish(sc.groupName), sc);

    /*
     * What a row offers, if anything. A diff row with neither a wording
     * behind it nor a narrowed group is something the base resume does rather
     * than something this proposal is offering — it has no box, and it is in
     * the document whatever anyone ticks.
     */
    const toggleFor = (c) => {
      const change = changeFor.get(plainish(c.to ?? ''));
      if (change?.key && change.from) return { kind: 'wording', change };
      const skill = c.to ? undefined : skillFor.get(plainish(c.where ?? ''));
      if (!skill) return null;
      /*
       * Which half of the group's change this row is about. The diff writes
       * the two as separate rows and gives each its own kind, so the row
       * already knows — it just had nowhere to say it while both shared a
       * box. A group the base said nothing about has one row and no half.
       */
      const part = skill.from ? (c.kind === 'added' ? 'added' : c.kind === 'removed' ? 'dropped' : null) : null;
      return { kind: 'skills', skill, part };
    };
    const onFor = (c) => {
      const t = toggleFor(c);
      if (!t) return true;
      return t.kind === 'wording' ? wordingOn(t.change) : skillsOn(t.skill, t.part);
    };
    const rows = analysis.diff ?? [];
    return { rows, toggleFor, onFor, on: rows.filter(onFor).length, total: rows.length };
  }

  /**
   * How many suggestions are switched on.
   *
   * The same walk the list itself does, deliberately: this was counting the
   * rationale and the skill changes while the heading counted the diff rows,
   * and the two sets are not the same — a diff row with nothing behind it is
   * in the document and has no box, so one walk saw it and the other did not.
   * A sentence saying "three switched on" over a list showing four ticks is
   * worse than no sentence.
   */
  const appliedCount = () => suggestions().on;

  function builtSummary() {
    /*
     * One line, and only the part of it nothing else on the card says.
     *
     * This used to open by naming the base and what had been done to it:
     * "Software Engineer Intern — Summer 2027, with the changes the AI chose
     * below. Your Software Engineer Intern — Summer 2027 is untouched — this
     * is a copy, saved under this posting's name." Three claims, and the
     * first two are already on screen a few pixels away — the base is the
     * selected option of the "Start from" picker directly above, and what
     * changed it is the provenance line under the diff ("Chosen by the AI,
     * after reading this posting", or "Found by keyword matching"). The name
     * then appeared twice in one sentence, which is most of why it read as
     * long as it did.
     *
     * What nothing else says is that this is a copy and the resume you keep
     * is not being edited. That is the sentence worth having, and putting it
     * behind a "what is this" button would have hidden the one part that was
     * news while leaving the two duplicates in place.
     *
     * The three failure branches keep their full wording. They are not
     * repeating anything, they are the only notice that a run did not
     * happen, and they say what to do about it.
     */
    const copy = ` This is a copy, saved under this posting's name — the resume you keep is untouched.`;

    if (state.builtWith === 'ai' && analysis.aiUsed) {
      return copy.trim();
    }
    /*
     * The AI was asked for and did not happen.
     *
     * Two ways that goes, and they need different words. It ran and came back
     * with something unusable — a bad minute, try again. Or it never started,
     * which is almost always the configured command not being on the path the
     * builder runs with, and trying again will do exactly the same thing
     * until the setting is fixed. The server says which by sending
     * `aiFailed`.
     *
     * Neither leaves a tailored resume behind any more. Both used to say "so
     * this is your resume with the keyword match applied", which was true
     * while a failed run fell through to the match; it falls through to the
     * suggestions now, switched off like any others, so the sentence would
     * have been describing changes nobody had accepted.
     */
    /*
     * Three ways, and they are not the same thing to be told.
     *
     * This said "could not be started" about all of them, which is true of
     * one and contradicts the evidence in the other two. What a person
     * actually met:
     *
     *   The AI could not be started, so nothing was tailored. It said: AI
     *   command "codex" ran for longer than 180s and was stopped.
     *
     * A command that ran for three minutes was started. The sentence argues
     * with its own quotation, and the two halves suggest opposite fixes — one
     * says check the command exists, the other says give it longer.
     *
     * The server knows which and now says so in `aiFailedKind`; matching on
     * the message would mean parsing somebody else's English.
     */
    if (analysis.aiFailed) {
      const how =
        {
          'not-installed': 'The AI could not be started',
          timeout: 'The AI was stopped for taking too long',
        }[analysis.aiFailedKind] ??
        // Anything else, and anything from a server too old to say: a frame
        // that is true whichever of the three it was.
        'The AI did not finish';
      return `${how}, so nothing was tailored. It said: ${analysis.aiFailed}${copy}`;
    }
    if (state.builtWith === 'ai' || analysis.aiRaw) {
      return `The AI returned nothing usable, so nothing was tailored.${copy}`;
    }

    /*
     * Otherwise this is the resume as it is kept, plus whatever is ticked.
     *
     * Counted rather than described. The match's two levers are not equally
     * likely to fire — narrowing a skills group needs nothing but the group,
     * while swapping a wording needs a line that has a second phrasing and an
     * alternate that clearly beats the current one — so a sentence about what
     * "the keyword match" does was false on most stores. A count is true on
     * all of them.
     */
    const on = appliedCount();
    if (on === 0) return `Exactly as you keep it — nothing is swapped, dropped or added.${copy}`;
    return `${plural(on, 'keyword suggestion')} switched on below.${copy}`;
  }

  /**
   * Whether one proposed change is currently in the resume, read off the
   * proposal rather than off a list of what has been pressed.
   *
   * This used to be a `state.undone` array of keys, which made the button
   * one-way in more places than the obvious one: the array did not travel
   * with `takeWork`, so carrying an application to the next page brought the
   * corrected spec along with every box ticked again, and the row you had
   * turned off came back claiming to be on. `spec.choices` is the thing that
   * is compiled and the thing that is filed. Asking it directly cannot
   * disagree with what is on the page.
   */
  const wordingOn = (change) => (state.spec?.choices ?? {})[change.key] === change.to;

  const sameItems = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

  /**
   * The two halves of what a match does to a skills group.
   *
   * Narrowing a group is really two decisions — some items the posting names
   * go in, some it never mentions come out — and the diff already writes them
   * as two rows ("Frameworks: added Node.js, Express" and "Frameworks:
   * dropped Unity, SDL — keeping Node.js, Express"). They shared one box,
   * because both rows resolve to the same group and the box was the group's:
   * ticking either did both, which is not what either row says it would do.
   *
   * `from: null` is the base asking for nothing, which prints every item in
   * the group. Nothing can be *added* to that, so such a group has only the
   * dropping half, and the ids it drops are not knowable from here — the
   * server sends what was kept, not what the group holds. That case keeps the
   * whole-group toggle it always had.
   */
  const addedBy = (change) =>
    change.from ? (change.to ?? []).filter((id) => !change.from.includes(id)) : [];
  const droppedBy = (change) =>
    change.from ? change.from.filter((id) => !(change.to ?? []).includes(id)) : null;

  /** What the group prints as things stand: the choice made, or the base's. */
  const skillItemsNow = (change) => {
    const items = (state.spec?.sections ?? []).find((s) => s.kind === 'skills')?.items ?? {};
    return items[change.groupId] ?? change.from ?? null;
  };

  const skillsOn = (change, part) => {
    const now = skillItemsNow(change);
    const dropped = droppedBy(change);
    // The group the base said nothing about: one decision, one box.
    if (!change.from || !part) return sameItems(now, change.to);
    if (part === 'added') {
      const added = addedBy(change);
      return added.length > 0 && added.every((id) => (now ?? []).includes(id));
    }
    return (dropped ?? []).length > 0 && !(dropped ?? []).some((id) => (now ?? []).includes(id));
  };

  /**
   * The proposal with every keyword suggestion turned off.
   *
   * The keyword match stopped being a mode and became a list of
   * suggestions. It still runs on arrival — it is local, free and measured
   * at two seconds against the worst page set worth having — but what it
   * produces is a set of offers, not a decision: the resume on screen is the
   * one you keep, and each suggestion is a box you can tick.
   *
   * That is the shape the match was always better suited to. Its two levers
   * are not equally likely to fire: narrowing a skills group needs nothing
   * but the group, while swapping a wording needs a line that has a second
   * phrasing and an alternate that clearly beats the current one. So on most
   * stores "match by keyword" was a skills cut arriving as a fait accompli,
   * under a name that promised a rewrite. Offered one at a time, it is
   * honest at any store size — including the one where it has nothing to
   * say.
   *
   * Computed here rather than asked for, because the server has already sent
   * everything needed: `from` on each change is what the base was using.
   * A second round trip to be told what we can work out is a second wait.
   */
  function withAllOff(spec, rationale = [], skillChanges = []) {
    if (!spec) return spec;
    const choices = { ...(spec.choices ?? {}) };
    for (const r of rationale ?? []) if (r.key && r.from) choices[r.key] = r.from;
    const sections = (spec.sections ?? []).map((section) => {
      if (section.kind !== 'skills') return section;
      const items = { ...(section.items ?? {}) };
      /*
       * The key comes out rather than being written back as the base's own
       * list. Absent means inherited, and what is inherited here *is* the
       * base's list — `from` is read off the flattened base — so the printed
       * document is the same either way. Pinning it is how a resume stops
       * seeing a skill added to its base next month.
       */
      for (const sc of skillChanges ?? []) delete items[sc.groupId];
      return { ...section, items };
    });
    return { ...spec, choices, ...(spec.sections ? { sections } : {}) };
  }

  /**
   * Back to the resume exactly as it is kept, without asking the server.
   *
   * A round trip would fetch a spec we can compute from one already in hand,
   * and would take the suggestion list down with it while it ran. Local, the
   * list stays up and the boxes simply all come off — which is what "use the
   * original" means once the match is a list of offers.
   */
  /**
   * The half of an analysis that belongs to one proposal rather than to the
   * posting. Everything else — the job, the voice counts, which resumes fit
   * — is true of the page and is shared by both.
   */
  const PROPOSAL_KEYS = [
    'spec',
    'diff',
    'rationale',
    'skillChanges',
    'entryByBullet',
    'suggestions',
    'baseResumeId',
    'baseLabel',
    'aiUsed',
    'tailor',
    'aiFailed',
    'aiFailedKind',
    'aiRaw',
  ];

  const proposalOf = (a) => Object.fromEntries(PROPOSAL_KEYS.filter((k) => k in a).map((k) => [k, a[k]]));

  /** The same analysis with its proposal taken out. See `update`. */
  const aboutThePage = (a) => Object.fromEntries(Object.entries(a).filter(([k]) => !PROPOSAL_KEYS.includes(k)));

  /** Which slot an analysis belongs in. See `isDecision`. */
  const slotOf = (a) => (isDecision(a) ? 'ai' : 'match');

  /**
   * File a proposal without putting it on screen.
   *
   * Separating the two is the point: an analysis arriving is not the same
   * event as somebody asking for it. The opening read lands on its own while
   * you may be three minutes into an AI pass, and it belongs in its slot and
   * nowhere near the view.
   */
  function fileOffer(next) {
    if (!next?.spec) return null;
    const which = slotOf(next);
    const none = withAllOff(next.spec, next.rationale, next.skillChanges);
    state.offers[which] = {
      analysis: proposalOf(next),
      // A decision arrives applied; offers arrive over the resume as it is
      // kept, with every box off. Same reading as `state.spec`'s initialiser.
      spec: which === 'ai' ? next.spec : none,
      /* The two ends of the list, so the buttons that jump to them can. */
      full: next.spec,
      none,
    };
    return which;
  }

  /** Park what is on screen, so its ticks are there when you come back. */
  function parkShown() {
    const held = state.showing && state.offers[state.showing];
    if (held && state.spec) held.spec = state.spec;
  }

  /**
   * Put one of the two proposals on screen. Free: no server, no model.
   *
   * Switching used to mean running the thing again, which for the AI is
   * minutes and a bill, so in practice you could not go back and look.
   */
  function showOffer(which) {
    const offer = state.offers[which];
    if (!offer) return false;
    if (state.showing !== which) parkShown();
    state.showing = which;
    state.spec = offer.spec;
    Object.assign(analysis, offer.analysis);
    state.builtWith = which === 'ai' ? 'ai' : 'none';
    state.render = null;
    draw();
    return true;
  }

  async function useOriginal() {
    // "As you keep it" is the match's list with nothing ticked, so it is that
    // proposal you are on — not a third state of its own.
    if (state.offers.match && state.showing !== 'match') showOffer('match');
    state.spec = withAllOff(state.spec, analysis.rationale, analysis.skillChanges);
    state.builtWith = 'none';
    if (state.offers.match) state.offers.match.spec = state.spec;
    state.render = null;
    await compile();
  }

  /**
   * The keyword list, with every suggestion in.
   *
   * The counterpart of "Use Original", and the other end of the same list.
   * Without it the only ways to see what the match would actually do were to
   * tick six boxes by hand or to have arrived before anything else did.
   */
  async function useKeywordMatch() {
    const offer = state.offers.match;
    if (!offer) return rebuildAs('match');
    showOffer('match');
    state.spec = offer.full ?? state.spec;
    offer.spec = state.spec;
    state.render = null;
    await compile();
  }

  /**
   * The AI's reading, run if there is not one yet and simply shown if there
   * is. Looking at it again used to mean paying for it again.
   */
  async function useAiTailoring() {
    if (state.offers.ai) {
      showOffer('ai');
      return compile();
    }
    return rebuildAs('ai');
  }

  /**
   * Take one swapped wording, or put it back.
   *
   * `change.from` is the wording the base resume was using before this
   * proposal touched it, so pinning that is exactly "leave this line alone",
   * and `change.to` is what the match picked. Both are written into
   * `spec.choices`, which is what the PDF is compiled from and what filing
   * sends — so the decision survives both rather than being a tidy-up of the
   * list on screen.
   *
   * Going both ways is the point. Pressing this used to remove the row it was
   * on, which meant deciding against one swap was permanent for as long as
   * the proposal lasted: no way to compare the two readings, and no way back
   * from a misclick short of rebuilding the whole thing.
   */
  async function setWording(change, on) {
    const choices = { ...(state.spec?.choices ?? {}), [change.key]: on ? change.to : change.from };
    state.spec = { ...state.spec, choices };
    // The compiled PDF is now of a resume nobody has: recompile before the
    // preview or the fit badge claim to be about this one.
    state.render = null;
    await compile();
  }

  /**
   * The same, for a skills group that was narrowed.
   *
   * A different write because it is a different kind of change: a wording is
   * one of several the entry holds, recorded in `choices`; a skills group is a
   * set of items, recorded under `sections[skills].items`. Putting one back
   * means putting that list back, and `null` means the base asked for nothing
   * — which is not "no answer" but a real one, the group printing all of its
   * items, and the way to say it is to leave the key out.
   */
  async function setSkills(change, on, part) {
    /*
     * The list this group would print with `part` set the way it was just
     * asked for, and the other half left exactly as it is.
     *
     * Where both halves end up on, the answer is `change.to` verbatim rather
     * than the same set rebuilt — the match chose an order as well as a set,
     * and a rebuilt list is a permutation of it. Where both end up off, the
     * key is left out rather than written back as the base's own list:
     * absent means inherited, and pinning what was inherited is how a resume
     * stops seeing things added to its base later.
     */
    const wanted = () => {
      if (!change.from || !part) return on ? change.to : null;
      const added = addedBy(change);
      const dropped = droppedBy(change) ?? [];
      const addOn = part === 'added' ? on : skillsOn(change, 'added');
      const dropOn = part === 'dropped' ? on : skillsOn(change, 'dropped');
      if (addOn && dropOn) return change.to;
      if (!addOn && !dropOn) return null;
      const kept = change.from.filter((id) => !(dropOn && dropped.includes(id)));
      return addOn ? [...kept, ...added] : kept;
    };

    const want = wanted();
    const sections = (state.spec?.sections ?? []).map((section) => {
      if (section.kind !== 'skills') return section;
      const items = { ...(section.items ?? {}) };
      if (want) items[change.groupId] = want;
      else delete items[change.groupId];
      return { ...section, items };
    });
    state.spec = { ...state.spec, sections };
    state.render = null;
    await compile();
  }

  /**
   * Put the built files where the upload dialog will be, as soon as they are
   * built.
   *
   * Two things are true of "Build resume" that make this worth doing without
   * being asked. The compile it runs is a *preview* — the fast path, which is
   * right for a badge and a picture and is explicitly not what gets attached
   * to an application — so something has to produce the real file eventually.
   * And the moment after building is the moment the portal's file dialog
   * opens, which is a bad time to discover the folder is empty because the
   * application has not been "prepared" yet.
   *
   * So this files the application as `applying`: built, in the flat folder,
   * not yet sent. Submitting moves it on. The compile here is the trusted
   * engine, because the whole point is that what is in that folder is the
   * thing you can attach.
   *
   * Never awaited by the button. It takes as long as a real compile and the
   * preview is already on screen; its own lane means it blocks nothing while
   * it runs, and a failure is reported without taking the build with it.
   */
  /**
   * Compile the proposal on screen, and only keep the result if it is still
   * the proposal on screen when it comes back.
   *
   * Compiling runs in its own lane, so it can be pressed while an AI pass is
   * reading the posting. That makes a race real that the shared lane used to
   * hide: the scan lands, `update` swaps in a different proposal and clears
   * the preview, and then the compile of the *old* one arrives and puts a
   * picture back. The card would then show a page, a page count and a fit
   * badge belonging to a resume nobody had chosen.
   *
   * `state.spec` is replaced wholesale whenever it changes, so its identity is
   * the whole test. A compile that loses the race is dropped rather than
   * retried: the thing that replaced it clears the preview and the next
   * compile is a button press away.
   */
  async function compile() {
    const of = state.spec;
    /*
     * A compile that comes back with nothing is a failure, not a silence.
     *
     * `state.render = r` with `r` undefined leaves the fit box reading "Not
     * compiled yet." and the error strip empty — so pressing Build resume
     * looked like a button that does nothing at all, with nowhere to go
     * next. Every way this can happen is worth reporting: a reply that is
     * not a compile, a spec the card never had, a worker that answered
     * without answering.
     */
    if (!of) {
      state.error = 'There is no resume to build yet. Choose one to start from.';
      draw();
      return null;
    }
    return act('render', { spec: of }, (r) => {
      if (state.spec !== of) return;
      if (!r) {
        state.error = 'ResumeM-M answered, but sent back no compiled resume. Check its log.';
        return;
      }
      state.render = r;
    });
  }

  function stageFiles() {
    if (!state.spec) return;
    act('stage', { spec: state.spec, coverLetter: state.letter, answers: collectedAnswers() }, (staged) => {
      if (staged) state.staged = staged;
    });
  }

  function drawChanges() {
    const diff = analysis.diff ?? [];
    const rationale = analysis.rationale ?? [];

    if (diff.length === 0 && rationale.length === 0) {
      return h(
        'div',
        { className: 'no-change' },
        /*
         * Two reasons there is nothing here, and they need different words.
         * The AI read the posting and found nothing worth changing, which is
         * a verdict. The keyword match having nothing to offer is not a
         * verdict about the posting — it means the store has no alternate
         * wording this posting's vocabulary reaches, which is a fact about
         * the store and is fixed in the builder, not here.
         */
        state.builtWith === 'ai'
          ? 'The AI read this posting and found nothing worth changing — your base resume already suits it.'
          : 'Keyword matching found nothing to suggest: none of this posting’s words reach an alternate phrasing in your save. Add another phrasing in ResumeM-M and there will be more to offer.',
      );
    }

    /*
     * Every row stays, whether or not it is switched on.
     *
     * A change turned off used to be removed from the list, which is a
     * strange thing to do to a decision the user has just made: the evidence
     * for it disappears at the moment they make it, so they cannot see what
     * they chose, cannot compare the two readings, and cannot get back from a
     * misclick without throwing the whole proposal away. The rows are a
     * record of what the match proposed. What the user did about each one is
     * the state of its box.
     */
    const shown = diff;
    const shownRationale = rationale;
    const { toggleFor, onFor, on: live } = suggestions();

    /*
     * Collapsed until asked for.
     *
     * Six rows of before-and-after is the most detailed thing on the card, and
     * it was the first thing under the resume — so the ordinary case, reading
     * what is proposed and accepting it, meant scrolling past every line of
     * reasoning to reach the build button. The count is the part you always
     * want; the rows are the part you want when one of them looks wrong.
     */
    const open = state.changesOpen ?? false;
    const list = h('div', { className: `changes${open ? '' : ' shut'}` }, [
      h('div', { className: 'diff-head' }, [
        h('button', {
          className: `fold-changes${open ? ' open' : ''}`,
          textContent: open ? '⌄' : '›',
          title: open ? 'Hide what was changed' : 'Show what was changed',
          'aria-expanded': String(open),
          onclick: () => {
            state.changesOpen = !open;
            draw();
          },
        }),
        h('span', { className: 'from-label', textContent: analysis.baseLabel ?? 'Base' }),
        h('span', { className: 'arrow', textContent: '→' }),
        h('span', { className: 'to-label', textContent: 'this posting' }),
        /*
         * How many are in, out of how many were offered. It said only the
         * total, which stopped being the interesting number the moment the
         * rows could be switched off: "6 changes" over a list with two boxes
         * unticked is describing what the match suggested, not what is about
         * to be printed.
         */
        h('span', {
          className: 'count',
          textContent:
            shown.length && live !== shown.length
              ? `${live} of ${plural(shown.length, 'change')}`
              : plural(shown.length || shownRationale.length, 'change'),
        }),
        /*
         * The way out, beside the list rather than back up among the build
         * modes. This is where you find out what was changed, so this is where
         * "actually, none of it" belongs.
         */
        /*
         * Offered whenever anything is on, rather than only in a mode.
         *
         * It used to test `builtWith !== 'none'`, from when the match was a
         * mode you were in. It is a list of offers now: you can be on the
         * original resume with three suggestions ticked, and that is exactly
         * when "actually, none of it" is worth one press.
         */
        live === 0
          ? null
          : h('button', {
              className: 'link undo-all',
              textContent: 'Undo all',
              title: 'Take every suggestion off and send the resume exactly as you keep it',
              // `compile` only: this is a local revert and a recompile, and
              // it must stay live while the AI reads.
              disabled: busyIn('compile'),
              onclick: () => useOriginal(),
            }),
      ]),
      /*
       * Where these rows came from, above the rows themselves.
       *
       * The two lists look identical — the same boxes, the same before and
       * after — and they are not the same kind of thing at all. One is a
       * model that read the posting and chose; the other is this posting's
       * words matched against the alternate phrasings already in your save,
       * with no model anywhere near it. Which one you are looking at decides
       * how much weight a row deserves, and the card had left you to infer
       * it from which button happened to be lit.
       *
       * Outside the fold, because it is true of the list whether or not the
       * list is open.
       */
      h('div', {
        className: 'hint from-what',
        textContent:
          state.builtWith === 'ai'
            ? 'Chosen by the AI, after reading this posting.'
            : 'Found by keyword matching: this posting’s words against the alternate phrasings already in your save. No AI was involved.',
      }),
    ]);

    for (const c of shown) {
      /*
       * What this row offers, from the same walk that counted them.
       *
       * It used to work this out again from its own copies of the two maps,
       * which is one more place for the box and the count to disagree about
       * the same row — and they are read side by side.
       */
      const toggle = toggleFor(c);
      const change = toggle?.kind === 'wording' ? toggle.change : undefined;
      const skill = toggle?.kind === 'skills' ? toggle.skill : undefined;
      const part = toggle?.kind === 'skills' ? toggle.part : undefined;
      const because = (change?.because ?? []).length ? change.because : undefined;
      // `text` is a self-contained sentence, which means it repeats the place
      // it happened — and the place is already the label above it.
      const detail = c.where && c.text?.startsWith(`${c.where}: `)
        ? c.text.slice(c.where.length + 2)
        : c.text;
      const why = h('div', { className: 'why' });
      for (const k of because ?? []) why.append(h('span', { className: 'kw', textContent: k }));

      /*
       * A box per change, ticked when the change is in.
       *
       * Both kinds get one — a swapped wording and a narrowed skills group —
       * and both are toggles rather than the one-way "Keep the original" this
       * replaces. The skills rows are the ones that most needed it: four
       * groups narrowed at once off the same handful of keywords is the part
       * of a match most likely to be wrong, and it is also the part you are
       * most likely to want to see both ways before deciding.
       *
       * A row with neither is something the base resume does, not something
       * this proposal chose, and there is nothing here to decide.
       */
      const settable = change?.key && change.from
        ? () => setWording(change, !onFor(c))
        : skill
          ? () => setSkills(skill, !onFor(c), part)
          : null;
      const on = onFor(c);
      /*
       * What the box would do, in the words of the row it is on. A group's
       * two halves are separate decisions now, so "show the group the way
       * your base has it" was wrong on both of them: it describes undoing
       * the whole change from a box that does half of it.
       */
      const undoes = !skill
        ? 'Put this one line back the way your base resume has it'
        : part === 'added'
          ? `Leave ${skill.groupName} without the ones this posting names`
          : part === 'dropped'
            ? `Keep everything ${skill.groupName} already lists`
            : `Show ${skill.groupName} the way your base resume has it`;
      const takes = !skill
        ? 'Use what the match picked for this one'
        : part === 'added'
          ? `Add what this posting names to ${skill.groupName}`
          : part === 'dropped'
            ? `Drop what this posting never mentions from ${skill.groupName}`
            : 'Use what the match picked for this one';
      const box = settable
        ? h('label', { className: 'pick', title: on ? undoes : takes }, [
            h('input', {
              type: 'checkbox',
              checked: on,
              /*
               * `compile` only, deliberately — not `resume`.
               *
               * Flipping one recompiles, so two at once would leave whichever
               * finished second describing the card, and that is worth
               * waiting for. An AI pass is not: it is minutes of a model
               * reading the posting, and greying out the switches on the
               * proposal already in front of you for the whole of it is the
               * scan interfering with work it has nothing to do with. When it
               * lands it brings a proposal of its own, and says so.
               */
              disabled: busyIn('compile'),
              onchange: settable,
            }),
            h('span', { className: 'box' }),
          ])
        : null;

      list.append(
        h('div', { className: `change ${c.kind}${settable && !on ? ' off' : ''}` }, [
          box,
          h('div', { className: 'change-body' }, [
            c.where ? h('div', { className: 'where', textContent: c.where }) : null,
            /*
             * Which side is the aside depends on which way the box is set:
             * switched on, the original is the one nobody is sending;
             * switched off, it is the suggestion.
             */
            h('div', { className: 'ba' }, [
              c.from ? h('del', { className: on ? 'aside' : '', textContent: c.from }) : null,
              c.to ? h('ins', { className: on ? '' : 'aside', textContent: c.to }) : null,
              !c.from && !c.to ? h('span', { className: 'plain', textContent: detail }) : null,
            ]),
            because?.length ? why : null,
          ]),
        ]),
      );
    }

    /*
     * A proposal whose document diff came back empty still has something to
     * say: the match recorded what it swapped even where resolving the two
     * resumes to compare them did not work.
     *
     * These rows used to be a different shape — `where` and `ba` straight
     * under `.change`, with no body and no box. That was survivable while
     * `.change` stacked its children; it stopped being so the moment the box
     * arrived and made `.change` a flex row, which laid the heading out as a
     * squeezed column beside the text. And with no box they could not be
     * switched off, while counting as on, so a card in this state claimed
     * changes that the spec had already reverted.
     *
     * Same shape as the rows above, and the same box: a rationale entry
     * carries the key and both wordings, which is everything a wording
     * toggle needs. The only thing it lacks is the diff row's `kind`, and
     * nothing here reads that.
     */
    if (shown.length === 0) {
      for (const c of shownRationale) {
        const on = c.key && c.from ? wordingOn(c) : true;
        const settable = c.key && c.from ? () => setWording(c, !(c.key && c.from ? wordingOn(c) : true)) : null;
        list.append(
          h('div', { className: `change${settable && !on ? ' off' : ''}` }, [
            settable
              ? h('label', { className: 'pick' }, [
                  h('input', { type: 'checkbox', checked: on, disabled: busyIn('compile'), onchange: settable }),
                  h('span', { className: 'box' }),
                ])
              : null,
            h('div', { className: 'change-body' }, [
              h('div', { className: 'where', textContent: c.where ?? 'On the resume' }),
              h('div', { className: 'ba' }, [
                c.fromText ? h('del', { className: on ? 'aside' : '', textContent: c.fromText }) : null,
                c.toText ? h('ins', { className: on ? '' : 'aside', textContent: c.toText }) : null,
              ]),
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
      letterControls.save.disabled = busyIn('letter') || state.letterSaved || !written;
      letterControls.save.textContent = busyLabel('saveLetter', state.letterSaved ? 'Saved' : 'Save to store', 'Saving…');
    }
    if (letterControls.copy) letterControls.copy.disabled = !written;
    if (letterControls.typeset) letterControls.typeset.disabled = busyIn('letter') || !written;
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
      /*
       * A dead end, until now. It said how much too long the resume was and
       * stopped there — no advice, no way on — and this is the one place the
       * overflow is ever discovered: mid-application, on the posting, with a
       * form open. The builder has said "pick a shorter phrasing or drop a
       * bullet" at its own version of this message for as long as it has
       * existed; the card, which is where somebody actually meets it, said
       * less and offered nothing.
       *
       * So: the same sentence, and the door to the place that can act on it,
       * opened straight onto this resume. `wentToEditor` is set for the same
       * reason the other button sets it — coming back here has to mean the
       * proposal on screen may be out of date.
       */
      return h('div', { className: 'fit bad' }, [
        h('span', {
          textContent:
            `${plural(r.pages, 'page')} — about ${plural(r.overflowLines, 'line')} too long. ` +
            'Pick a shorter phrasing or drop a bullet.',
        }),
        state.spec?.id
          ? h('button', {
              className: 'link',
              textContent: 'Open it in ResumeM-M',
              title: 'Open this resume in the builder, where phrasings and bullets can be changed',
              onclick: () => {
                state.wentToEditor = true;
                onAction('openTab', { url: `/#resumes/${encodeURIComponent(state.spec.id)}` });
              },
            })
          : null,
      ]);
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

    /*
     * Already drawn once: put the drawn node back, so a re-render does not
     * refetch — and does not blank the page either.
     *
     * This cloned. A canvas clones its size, its inline width and height and
     * its class, and *not one pixel of its bitmap*: `cloneNode` copies the
     * element, and the backing store is not part of the element. Measured in
     * the same Chromium this is tested in — read a pixel from the original and
     * you get the colour, read it from the clone and you get transparent
     * black. Over `.pdf-page { background: #fff }` that is a correctly sized,
     * perfectly white page.
     *
     * So the first render looked right and every repaint after it went blank,
     * which is every button press, every AI status arriving, every fold and
     * unfold — twenty-four of them in this file. Sometimes the repaint landed
     * during the render instead, and then it was white immediately. That is
     * the "some of the time" in the report, and why it always came back on
     * "Open full size": nothing there had been through a clone.
     *
     * Moving the node is what was wanted all along. `draw()` throws the old
     * subtree away, so there is nobody left to take it from.
     */
    const cached = state.pdfPages.get(url);
    if (cached) {
      pane.replaceChildren(cached);
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
          // The node that was actually drawn into, not a copy of it.
          state.pdfPages.set(wanted, pages);
          /*
           * Each of these is a page-sized bitmap. Keeping one per compile
           * meant a session of small edits quietly holding a dozen of them.
           *
           * Dropping the entry a pane is currently showing would leave that
           * pane with no cache to read and no fetch to start — `shownPdf`
           * still names the url, so the guard below refuses — and the strip
           * stays empty for good. So the slot in use is never evicted.
           */
          const inUse = new Set(Object.values(state.shownPdf));
          for (const old of [...state.pdfPages.keys()].slice(0, -4)) {
            if (!inUse.has(old)) state.pdfPages.delete(old);
          }
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
  /**
   * The letter space, opened — and nothing written in it.
   *
   * This used to call the model the moment a form with a cover letter field
   * came up, which is a paid run and minutes of it, started by arriving on a
   * page. Landing on the application you are going to write is not the same
   * as asking for it to be written, and the draft that arrived unasked was
   * often the one you then deleted.
   *
   * So the step opens with the box and the buttons in it, and "Draft a letter"
   * is a button like every other AI action on this card. The flag is still set
   * because everything downstream reads it as "this step is open".
   */
  function maybeAutoDraft() {
    if (!carriedSettled) return;
    if (!state.letterNeeded || state.letterAutoStarted || !state.spec) return;
    state.letterAutoStarted = true;
    state.letterStarted = true;
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

    return act('coverLetter', { spec: state.spec }, (r) => applyLetterReply(mine, r));
  }

  /**
   * What to do with a drafted letter, wherever it came from.
   *
   * Lifted out of `draftLetter` so the one-run write can land its letter by
   * exactly the same rules. Every branch here is a guard somebody's paragraph
   * needed, and two paths reimplementing them is two paths that drift.
   *
   * @param mine what was in the box when the run was asked for
   * @param r `{ body, priorLetters }` — `body` is the drafted letter, if any
   */
  function applyLetterReply(mine, r) {
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
         * and `state.letter` is what Submit ships. So with
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
  }

  /**
   * The letter and every answer, written by one run of the model.
   *
   * They used to be a run each: one for the letter, one per question, so a
   * form with three was four runs — each reading the same posting, the same
   * resume and the same corpus from scratch, four times the tokens and four
   * times the wait, and none of them able to see what the others wrote. Which
   * is how an application ends up saying two different things about why you
   * want the job.
   *
   * The per-item buttons stay. They are what redrafting one thing is now.
   */
  function writeEverything() {
    const wantsLetter = Boolean(state.letterNeeded || state.letterAsked);
    /*
     * Positional ids, made here and thrown away after the reply.
     *
     * The server keys the answers it writes by the id it was handed, and this
     * card has no id to hand it — answers live under the question's *text*,
     * deliberately, because that is the only thing that survives the walk from
     * a description page to a form on another host. So an id is minted for the
     * round trip and mapped straight back.
     *
     * Deduplicated by text: two identical questions on one form already share
     * one answer box, and giving them two ids would mean two slots writing to
     * the same place.
     */
    const seen = new Set();
    const slots = [];
    for (const q of state.questions ?? []) {
      if (seen.has(q.question)) continue;
      seen.add(q.question);
      /*
       * An answer borrowed from the bank for somebody else is not this
       * person's draft, and must not be handed over as work in progress —
       * the run would build on another company's text. See the same rule
       * where the box is filled.
       */
      // Not the model's to answer, so not handed to the run either — see the
      // question box, and `YOURS_TO_ANSWER` in autofill.js.
      if (q.yours) continue;
      const borrowed = Boolean(q.namesAnother) && !state.answers[q.question];
      const before = state.answers[q.question] ?? (borrowed ? '' : q.answer ?? '');
      slots.push({ id: `q${slots.length + 1}`, question: q.question, answer: before, before });
    }

    const mine = state.letter ?? '';
    // A new run, so last run's tally of discarded drafts is not this one's.
    state.kept = [];
    state.answerNote = null;
    return act(
      'writeApplication',
      {
        spec: state.spec,
        letter: { required: wantsLetter, body: mine },
        questions: slots.map(({ id, question, answer }) => ({ id, question, answer })),
      },
      async (r) => {
        if (!r) return;
        /*
         * `=== false`, not `!r.oneRun`. The endpoint leaves the field off
         * entirely when there was nothing to write, and treating that as "it
         * could not be done in one run" would send the whole fallback after a
         * request that asked for nothing.
         */
        if (r.oneRun === false) {
          state.error = `${r.why} Writing them one at a time instead.`;
          state.priorLetters = r.priorLetters ?? [];
          if (wantsLetter) await draftLetter();
          for (const slot of slots) {
            const before = state.answers[slot.question] ?? slot.before;
            await act(`answer:${slot.question}`, { question: slot.question, force: true }, (one) => {
              if (one?.executed && one.output) applyAnswer(slot.question, before, one.output);
            });
          }
          return;
        }

        if (wantsLetter) applyLetterReply(mine, { body: r.letter, priorLetters: r.priorLetters });
        else state.priorLetters = r.priorLetters ?? [];
        for (const slot of slots) applyAnswer(slot.question, slot.before, r.answers?.[slot.id]);
        if (r.aiFailed) state.error = r.aiFailed;
      },
    );
  }

  /**
   * Put a drafted answer in its box — unless somebody wrote there meanwhile.
   *
   * The box stays enabled on purpose: the obvious thing to do with a wait of
   * minutes is write the answer yourself. The reply used to replace that
   * outright, with no merge, no confirmation and no copy kept. Shared with the
   * one-run write, which can land several of these at once and has exactly the
   * same duty to each of them.
   *
   * @param before what was in the box when the run was asked for
   */
  function applyAnswer(question, before, text) {
    if (!text?.trim()) return false;
    if ((state.answers[question] ?? '') !== before) {
      state.kept = [...new Set([...(state.kept ?? []), question])];
      const n = state.kept.length;
      state.answerNote =
        n === 1
          ? 'You were writing while that ran, so what you wrote was kept.'
          : `You were writing while that ran, so what you wrote was kept — ${n} answers.`;
      return false;
    }
    state.answers[question] = text;
    return true;
  }

  function drawProposeView() {
    const baseSelect = h('select', { title: 'Which resume to start from' });

    /*
     * How much of this posting each resume already uses, worked out by the
     * store against the untouched documents. Absent on an older server or on
     * a page that was never analysed, and everything below falls back to the
     * order it had before — a list that cannot be ranked is still a list.
     */
    const fitOf = new Map((analysis.resumeFit ?? []).map((f) => [f.id, f]));
    const picked = new Set(analysis.recommended ?? []);

    /*
     * The mark, and what it is allowed to claim.
     *
     * A star on a row in a picker reads as "start here", so it is only drawn
     * where the store says one resume is genuinely ahead of the others — see
     * `recommend` in ResumeM-M, which marks nothing on a flat field, nothing
     * on a bad one, and everything level at the top rather than choosing
     * between equals. Most postings get no star at all, and that is the
     * point: a mark that is always somewhere is one nobody reads.
     *
     * A character rather than an icon, because this is an `<option>` and an
     * option holds text. The count is in the label for the same reason — it
     * is the whole of the explanation, and there is no room for a tooltip in
     * a native picker.
     */
    const option = (r) => {
      const fit = fitOf.get(r.id);
      const star = picked.has(r.id) ? '★ ' : '';
      const says = fit?.hits ? ` — uses ${plural(fit.hits, 'word')} from this posting` : '';
      return h('option', {
        value: r.id,
        textContent: `${star}${r.label}${says}`,
        selected: r.id === analysis.baseResumeId,
      });
    };

    /**
     * Best fit first, and the order they were in where nothing separates them.
     *
     * Sorting inside each group rather than across them: which resumes are
     * yours and which were built for a posting is a fact about the store, and
     * a good match is not a reason to hide that. `sort` is stable, so equal
     * scores keep the order the group already had.
     */
    const hitsOf = (r) => fitOf.get(r.id)?.hits ?? 0;
    const byFit = (list, first = () => false) =>
      [...list].sort((a, b) => hitsOf(b) - hitsOf(a) || Number(first(b)) - Number(first(a)));

    /*
     * Your starting points at the top, whatever else has piled up under them.
     *
     * Pinning a resume as a base grouped this list properly, and nothing is
     * pinned in a store nobody has pinned anything in — which is every store
     * to begin with. So the list was flat and alphabetical, and it grows by
     * one every time an application is filed: a store four applications old
     * already reads "Base resume, Summer intern, Acme — 127.0.0.1, Role —
     * Acme, Platform Engineer — Andromeda, …", and the four things somebody
     * actually starts from are scattered through it. In a year of applying
     * they are unfindable.
     *
     * Every resume carries a tier now — what you build from, what you keep,
     * and what was made for one posting and gets swept once that posting is
     * done with — including the ones a migration gave one to. So there is
     * always something to group by, rather than a grouping that waited for a
     * pin nobody had found.
     *
     * A resume with no tier at all is one from a save this version has not
     * opened yet — an older ResumeM-M on the other end of the round trip, or
     * one that has not been migrated. `base: true` was the tier there was, so
     * it is read as one; anything else is kept, which is what it is. A file
     * written before any of this existed is not something to file under
     * "about to be deleted".
     */
    const tierOf = (r) => r.tier ?? (r.base ? 'base' : 'extended');
    const GROUPS = [
      ['base', 'Bases'],
      ['extended', 'Kept'],
      ['temporary', 'Built for a posting'],
    ];

    /*
     * Within the temporary group, this company first — as a tiebreaker.
     *
     * Applying somewhere you have applied before, what you sent them last
     * time is the most useful thing to start from, so it used to be lifted to
     * the top of the group outright. That put a resume with nothing to do
     * with this posting above one written for exactly it, which is the
     * opposite of what a ranked list is for. As a tiebreaker it still wins
     * every time the numbers cannot separate them, which is the case it was
     * really about: two resumes that suit the posting equally, one of which
     * this employer has already seen.
     */
    const here = (analysis?.job?.company ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const sameEmployer = (r) => Boolean(here) && r.id.startsWith(`job-${here}-`);

    const groups = GROUPS
      .map(([tier, label]) => [label, resumes.filter((r) => tierOf(r) === tier)])
      .filter(([, list]) => list.length > 0);

    // One group is no grouping, and an empty one reads as a section that
    // failed to load.
    if (groups.length > 1) {
      for (const [label, list] of groups) {
        const group = h('optgroup', { label });
        for (const r of byFit(list, sameEmployer)) group.append(option(r));
        baseSelect.append(group);
      }
    } else {
      for (const r of byFit(resumes, sameEmployer)) baseSelect.append(option(r));
    }

    /*
     * A different base, worked out again for this posting.
     *
     * This asked for `state.builtWith`, which is now `'none'` unless the AI
     * decided something — and `'none'` comes back with no rationale and no
     * skill changes at all, so choosing a different resume emptied the
     * suggestion list and left nothing to tick. The suggestions belong to the
     * pair (base, posting): change either and they have to be computed again.
     * An AI proposal is the one thing that cannot be, so that one repeats
     * what was asked for.
     */
    baseSelect.onchange = () => switchBaseTo(baseSelect.value);

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
        /*
         * Three readings of the same posting, and you can be on any of them.
         *
         * These used to describe how the proposal had been built, which made
         * them a record rather than a control: the AI's version and the
         * keyword list shared one slot, so arriving at one meant losing the
         * other, and going back to look meant running it again. Both are kept
         * now (see `state.offers`), so these switch between them and only
         * start work when there is nothing to switch to.
         */
        h('div', { className: 'row build-modes' }, [
          h('button', {
            className: onOriginal() ? 'mode on' : 'mode',
            textContent: 'Use Original',
            title:
              'Send this resume exactly as you keep it. Every keyword suggestion below comes off.',
            // Live while the AI reads — see `supersede`.
            disabled: aiIsReading() ? false : busyIn('compile'),
            onclick: () => useOriginal(),
          }),
          h('button', {
            className: state.showing === 'match' && !onOriginal() ? 'mode on' : 'mode',
            textContent: rebuildLabel('match', 'Keyword match', 'Matching on keywords…'),
            title: state.offers.match
              ? 'Take every keyword suggestion below. No AI: this posting’s words against the phrasings already in your save.'
              : 'Match this posting’s words against the phrasings already in your save.',
            disabled: aiIsReading() ? false : busyIn('compile'),
            onclick: () => useKeywordMatch(),
          }),
          aiButton({
            className: state.showing === 'ai' ? 'mode on' : 'mode',
            title: !state.ai?.active
              ? state.ai?.state === 'server-off'
                ? 'ResumeM-M has its AI switched off — turn it on under Voice & AI.'
                : 'Switch the AI on from the JobHelper toolbar icon to use this.'
              : state.offers.ai
                ? 'Show what the AI decided. It has already read this posting — nothing runs again.'
                : 'The AI reads this posting and decides which phrasings and bullets to use.',
            disabled: busyIn('resume') || (!state.ai?.active && !state.offers.ai),
            /*
             * From the resume as it is kept, not from whatever boxes happen
             * to be ticked. The AI is being asked to decide what to change,
             * and handing it a proposal half-built out of keyword guesses
             * makes its answer a correction to those rather than a reading
             * of the posting — and makes "why did it keep that?" unanswerable.
             */
            onclick: () => useAiTailoring(),
          }, rebuildLabel('ai', state.offers.ai ? 'AI tailoring' : 'Have AI Tailor', 'Reading the posting…')),
          /*
           * Running it again is a separate press from looking at it.
           *
           * Once there is an AI proposal the button beside this one shows it,
           * which is free; a second pass costs minutes and money and should
           * not be one misclick away from somebody who only wanted to compare.
           */
          state.offers.ai && state.ai?.active
            ? h('button', {
                className: 'link run-again',
                textContent: 'Run again',
                title: 'Read the posting again from the resume as you keep it',
                disabled: busyIn('resume'),
                onclick: () => rebuildAs('ai'),
              })
            : null,
          /*
           * And the bar for it, here rather than at the top of the step. The
           * question "is the AI what I am waiting for?" should be answerable
           * by looking at the AI button, not by reading a label.
           */
          progressFor(1, { here: 'ai' }),
        ]),
        /*
         * Neither of the two: going and writing the sentence yourself.
         *
         * Looking at a posting is exactly when you notice the store has no
         * bullet for the thing it is asking about — and the answer to that is
         * two minutes in the builder, not another pass over the phrasings
         * that already exist. Without a way through, it meant finding the
         * editor by hand, finding the resume in it, and losing the card.
         *
         * On its own line and drawn as a link, not in the row above wearing
         * `mode`. There are two ways to build and this is not one of them —
         * sitting between them, at the same weight, it read as a third, and
         * the row was supposed to be the whole answer to "what happens to my
         * resume".
         */
        h('div', { className: 'row' }, [
          h('button', {
            className: 'link to-builder',
            textContent: 'Edit in ResumeM-M',
            title: 'Open this resume in the builder to add a bullet or another phrasing',
            disabled: !state.spec?.id,
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
        (() => {
          if (!state.editedElsewhere) return null;
          /*
           * What the offer is depends on what this proposal is.
           *
           * A wording added in the builder is an *alternate*, and an alternate
           * is only reached by something choosing it. On a proposal the AI
           * decided, the thing that would choose it is the AI, so the offer
           * repeats what was asked for. Otherwise what is on screen is the
           * resume as it is kept with a list of suggestions beside it, and
           * that list was computed before the new wording existed — so what
           * has to happen is the list being worked out again.
           *
           * Either way the offer names what it would actually do. It used to
           * say "Build it again" over an untailored proposal, where building
           * it again produced the same untouched resume and could never reach
           * the wording just written.
           */
          const again = state.builtWith === 'ai';
          return h('div', { className: 'hint warn' }, [
            h('span', { textContent: 'You have been editing the store. ' }),
            h('button', {
              className: 'link',
              textContent: again ? 'Build it again' : 'Work out the suggestions again',
              disabled: busyIn('resume'),
              onclick: () => {
                state.editedElsewhere = false;
                return rebuildAs(again ? 'ai' : 'match');
              },
            }),
            h('span', { textContent: ' to use anything you added.' }),
          ]);
        })(),
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
            // `compile`, not `resume`: the proposal on screen can be built
            // while the AI is off reading the posting about a different one.
            disabled: busyIn('compile'),
            /*
             * Stage only what actually built.
             *
             * These ran one after the other unconditionally, and `act` clears
             * `state.error` as it starts — so a compile that failed had its
             * message wiped by the staging call a moment later, and the
             * button looked like one that does nothing at all. Which is the
             * worst way for this to fail: the resume is not built, nothing
             * says why, and there is nowhere to go next.
             *
             * Staging a resume that did not compile was never useful anyway:
             * the whole point of the flat folder is that what is in it is
             * the thing you can attach.
             */
            onclick: async () => {
              const built = await compile();
              if (built) stageFiles();
            },
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
            disabled: busyIn('resume'),
            onclick: async () => {
              if (!state.feedback.trim()) return;
              const refined = await act('refine', { spec: state.spec, feedback: state.feedback });
              if (refined?.parsed?.choices) {
                state.spec = { ...state.spec, choices: { ...state.spec.choices, ...refined.parsed.choices } };
                await compile();
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
     * Everything the form wants written, in one go.
     *
     * Above both steps because it belongs to both: one run of the model writes
     * the letter and every answer together, which is a quarter of the tokens
     * of doing them one at a time on a form with three questions, a quarter of
     * the wait, and — the part that is not about cost — one piece of writing
     * rather than four that never saw each other.
     *
     * Offered only when there is more than one thing to write. For a single
     * answer it would be the same run under a longer name, and the button
     * beside that answer already says what it does.
     */
    {
      const wants = Boolean(state.letterNeeded || state.letterAsked);
      // Questions that are the applicant's alone are not counted: the button
      // must not offer to write what it will not write.
      const asked = (state.questions ?? []).filter((q) => !q.yours).length;
      if (asked + (wants ? 1 : 0) > 1) {
        body.append(
          h('div', { className: 'row gap write-all' }, [
            aiButton(
              {
                title: 'One run of your AI writes the cover letter and every answer together.',
                disabled: busyIn('drafting') || !state.ai?.active,
                onclick: writeEverything,
              },
              busyLabel(
                'writeApplication',
                wants
                  ? `Write the letter and ${asked} ${asked === 1 ? 'answer' : 'answers'}`
                  : `Write all ${asked} answers`,
                'Writing…',
              ),
            ),
            progressFor(2, { here: 'writeApplication' }),
          ]),
        );
      }
    }

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
        drawVoiceFrom('letter'),
        h('div', {}, [
              /*
               * The space is open whether or not anything has been written in
               * it. It used to be a placeholder with one button, swapped for
               * the editor once a draft arrived — which only made sense while
               * the draft started itself. Now that drafting is a button, the
               * placeholder was standing between the person and a box they
               * could have typed into, and hiding the previous-letter offer
               * behind an AI run they may not want.
               */
              state.letterSource ? h('div', { className: 'hint', textContent: state.letterSource }) : null,
              !state.letter?.trim()
                ? h('div', { className: 'row gap' }, [
                    aiButton(
                      {
                        title:
                          'Write a first draft from this posting and the letters you have written before. Runs your AI command.',
                        disabled: busyIn('drafting'),
                        onclick: draftLetter,
                      },
                      busyLabel('coverLetter', 'Draft a letter', 'Drafting…'),
                    ),
                    h('span', {
                      className: 'faint',
                      textContent: 'or write it yourself — nothing is sent to an AI until you press it.',
                    }),
                  ])
                : null,
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
                  disabled: busyIn('letter') || state.letterSaved || !state.letter?.trim(),
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
                  disabled: busyIn('letter') || !state.letter?.trim(),
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
            /*
             * Opens the space; does not write in it.
             *
             * This called the model as well, so pressing "+ Cover letter" —
             * which says it is adding a step the page did not ask for —
             * started a paid run of minutes that nobody had asked for either.
             * Adding the step and asking for a draft are two decisions, and
             * "Draft a letter" inside the step is where the second one is
             * made, exactly as it is when the page did ask.
             */
            onclick: () => {
              state.letterAsked = true;
              state.letterStarted = true;
              draw();
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
        /*
         * Where the files are, at the moment the file dialog is about to open.
         *
         * This used to be in the panel after filing, which is the one place
         * you do not need it: by then the upload has happened. Building stages
         * the files now, so the folder has something in it from the moment
         * there is a resume — and a path you can paste into the dialog's
         * location bar is the whole of what makes that reachable. An extension
         * cannot set where the dialog opens; this is what it can do instead.
         */
        state.staged?.currentDir
          ? h('div', { className: 'staged' }, [
              h('div', { textContent: 'Ready to attach, in one folder:' }),
              h('div', { className: 'path', textContent: state.staged.currentDir }),
              h('div', { className: 'row gap' }, [
                h('button', {
                  className: 'tiny',
                  textContent: 'Copy folder path',
                  title: 'Paste it into the upload dialog',
                  onclick: () => navigator.clipboard?.writeText(state.staged.currentDir),
                }),
                h('button', {
                  className: 'tiny',
                  textContent: 'Open the folder',
                  title: 'See the files in a tab, and open any of them',
                  onclick: () => onAction('openTab', { url: '/current' }),
                }),
              ]),
            ])
          : null,
        h('div', { className: 'row' }, [
          h('button', {
            className: 'tiny',
            textContent: busyLabel('autofill', 'Autofill this form', 'Filling…'),
            disabled: busyIn('page'),
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
            textContent: busyLabel('bundle', 'Submit', 'Filing…'),
            // `compile` is in the list now that it is its own lane: filing
            // while the preview is being recompiled files a resume the card
            // is in the middle of changing its mind about.
            disabled: busyIn('submit', 'resume', 'letter', 'compile') || !state.render,
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
         * the base resume already suits, Submit sits
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

    if (state.note) body.append(h('div', { className: 'ok-note', textContent: state.note }));
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
      drawVoiceFrom('answer'),
      /*
       * What a run wrote and could not use, said out loud.
       *
       * The box stays enabled while an answer is being written — the obvious
       * thing to do with a wait of minutes is write it yourself — and what you
       * type wins. That was already true and it was already recorded, in a
       * field nothing rendered: `answerNote` was assigned and read nowhere, so
       * a discarded draft was discarded in silence. A run that writes every
       * answer at once can discard several, which makes the silence worse.
       */
      state.answerNote ? h('div', { className: 'hint', textContent: state.answerNote }) : null,
    ]);
    step.append(
      h('div', { className: 'row', style: 'margin-bottom:8px' }, [
        h('button', {
          className: 'tiny',
          textContent: busyLabel('openWorkspace', 'Write these in ResumeM-M', 'Opening…'),
          title: 'Hand the posting, the resume, and the questions to the editor, where there is room to write',
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
          /*
           * Some questions are not the model's to answer.
           *
           * A salary expectation invented by a model is a number the applicant
           * did not choose and may be held to; the self-identification
           * questions are voluntary by law and about the person, so an answer
           * written on their behalf is a lie told in their name about
           * something they were entitled to decline. The question is still
           * shown and the box still typed in — hiding something the form
           * requires is the worse failure — but there is no button offering to
           * write it. See `YOURS_TO_ANSWER`.
           */
          q.yours
            ? h('span', { className: 'faint', textContent: q.yours })
            : aiButton(
            {
              className: 'tiny',
              // Starting a draft, so it waits for a draft — not for the save
              // of the answer beside it, which is a different kind of work.
              disabled: busyIn('drafting'),
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
                    applyAnswer(q.question, typedBefore, r.output);
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
                /*
                 * Who it was written for, which is what makes it safe to
                 * reuse later.
                 *
                 * The store decides whether an answer is safe to send unread
                 * partly by asking whether it names a *different* employer,
                 * and it learns the employers from the labels on the answers
                 * it holds. Sending none meant every answer saved here was
                 * labelled "Saved", so the store's list of employers was the
                 * word "Saved" and the check could never fire. An answer
                 * written for Acme that opens "Acme is why I applied" came
                 * back for Globex scored 1.0, badged "answered before", with
                 * the text already in the box — which is the one failure the
                 * whole answer bank is built to prevent.
                 *
                 * The Workspace has always labelled its own with the company.
                 * This is the same fact, from the page that knows it first.
                 */
                label: analysis?.job?.company || undefined,
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
      /*
       * A file the store could not put in the folder you are about to upload
       * from — something of yours already sitting under that name, a file open
       * and locked, a full disk. The store names each one and finishes the
       * rest, which is right, and until now said it to nobody.
       *
       * It belongs here rather than only in the builder, because this is the
       * moment a file picker is about to open. A list headed "named and ready
       * to attach" with a file quietly absent from the folder is how last
       * week's resume gets sent.
       */
      (b.currentProblems ?? []).length > 0
        ? h('div', { className: 'done-missing' }, [
            h('strong', { textContent: 'Not everything reached the folder you upload from.' }),
            ...b.currentProblems.map((said) => h('div', { textContent: said })),
            h('div', {
              textContent:
                'The archive below still has all of it. Clear whatever is in the way and press Submit again, or attach from the archive instead.',
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
          disabled: busyIn('page'),
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
          disabled: busyIn('submit'),
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

    /*
     * Where you were reading.
     *
     * `.body` is the scroller and it is destroyed and rebuilt on every
     * redraw, so every redraw put you back at the top — and the card redraws
     * for things that have nothing to do with where you are looking: a status
     * read landing, a compile finishing, a tailoring pass arriving minutes
     * later, opening any panel. Working on the questions at the bottom of a
     * long card meant being thrown to the header over and over, and the cost
     * lands hardest on the longest cards, which are the ones where scrolling
     * back is most work.
     *
     * Saved and put back for the same reason the caret is, a few lines down.
     */
    const wasScrolled = card.querySelector('.body')?.scrollTop ?? 0;

    // Provisional until the analysis lands: what is on screen is the page's
    // own title, not anything this has worked out yet.
    card.classList.toggle('loading', !analysis);
    card.classList.toggle('folded', Boolean(state.folded));
    card.replaceChildren(
      drawHead(),
      /*
       * Folded, the card is its header and one line saying what it is the
       * header for. The line matters: a bar reading only "JobHelper" over
       * somebody's application form is a thing to close, not a thing to open.
       * The spinner stays in the header either way, so work carrying on
       * behind the fold is still visible.
       */
      state.folded
        ? h('div', {
            className: 'folded-title',
            textContent: analysis?.job
              ? [analysis.job.title, analysis.job.company].filter(Boolean).join(' · ')
              : 'Reading this page…',
          })
        : !analysis
          ? drawReadingView()
          : state.view === 'done'
            ? drawDoneView()
            : drawProposeView(),
    );

    if (wasScrolled) {
      const body = card.querySelector('.body');
      // `scrollTop` clamps itself to what the element can actually scroll, so
      // a shorter body simply lands at its own bottom rather than throwing.
      if (body) body.scrollTop = wasScrolled;
    }

    if (!focused) return;
    const again = card.querySelector(`[data-field="${CSS.escape(focused)}"]`);
    if (!again) return;
    // `preventScroll`, or focusing the box would undo the line above.
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
    /**
     * @param next the analysis that arrived
     * @param show true when somebody asked for this one, so it takes the
     *   screen. A run that finished after the card moved on is still a run
     *   somebody asked for — see `landLate` in the content script.
     */
    update(next, { show = false } = {}) {
      /*
       * Filed, and only shown if there is nothing to displace.
       *
       * An analysis arriving is not the same event as somebody asking for
       * one. The opening read lands a few seconds after the card goes up and
       * used to write itself over whatever was there — which, when an AI pass
       * had finished in the meantime, meant a keyword match silently
       * replacing three minutes of a model's work.
       */
      const filed = fileOffer(next);
      const takeScreen = Boolean(filed) && (show || !state.showing || state.showing === filed);

      /*
       * And the merge below is split for the same reason.
       *
       * `analysis` is one object serving two purposes: what this posting is —
       * the job, the voice counts, which resumes fit — and what one proposal
       * did to the resume. The first is always the newest answer. The second
       * belongs to whichever proposal is on screen, so merging a whole
       * analysis in while showing the other one put the match's rationale
       * under the AI's heading: the button said the AI had chosen and the
       * rows underneath it said they came from keyword matching.
       */
      analysis = Object.assign(analysis ?? {}, filed && !takeScreen ? aboutThePage(next) : next);
      // A note is about the run that has just ended, not about the next one.
      state.note = null;

      if (takeScreen) showOffer(filed);
      else {
        state.render = null;
        draw();
      }
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
      return this.retailor('ai');
    },

    /**
     * Do again, on this page, what was asked for on the last one.
     *
     * An application is several pages, and the posting is only whole once you
     * have walked them — so a proposal made from the description page was made
     * from less than there is now. Whichever way it was made is the way it is
     * made again: nothing new is started, the same thing is brought up to
     * date. Called only where a mode was already chosen for this application;
     * arriving on a posting having asked for nothing still does nothing.
     */
    async retailor(mode) {
      if (mode !== 'ai' && mode !== 'match') return null;
      state.rebuilding = mode;
      try {
        return await act('rebuild', { tailor: mode }, (result) => {
          /*
           * What came back, not what was asked for — see `rebuildAs`. And
           * nothing at all when nothing came back: this wrote `'none'` on a
           * run that had failed or been superseded, which is a claim about
           * the proposal on screen made by a run that never produced one.
           * With both readings kept it was visible — the AI's version on
           * screen, its button lit, and the summary under it saying the
           * resume was exactly as it is kept.
           */
          if (result?.spec) showOffer(slotOf(result));
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
    /** Something that happened and went well. See `state.note`. */
    say(text) {
      state.note = text;
      draw();
    },

    setStatus(text, fix = null) {
      state.error = text;
      // The first pass failing is the commonest way to meet this, and the
      // commonest reason is that ResumeM-M is not running.
      state.errorFix = fix;
      draw();
    },
  };
}
