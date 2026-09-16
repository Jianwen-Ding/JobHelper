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
  --accent: #2f5fd0;
  --accent-hover: #2650b4;
  --accent-soft: #eaf0fd;
  --ink: #17181c;
  --ink-soft: #3d4049;
  --muted: #676b77;
  --faint: #969aa6;
  --line: #e3e5ea;
  --line-soft: #eef0f3;
  --panel-sunk: #fafbfc;
  --good: #146c3f;
  --good-bg: #ecf7f0;
  --good-line: #c6e3d2;
  --bad: #a9231c;
  --bad-bg: #fdeeec;
  --bad-line: #f1cbc7;
  --warn: #7d5700;
  --warn-bg: #fff9ec;
  --warn-line: #eddfba;
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
  border-radius: 12px;
  box-shadow: 0 18px 52px rgba(20, 22, 30, .22);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
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
  font-size: 13px; font-weight: 650; letter-spacing: -.01em;
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

/* Two ways to tailor, side by side, with the one in use marked. */
.build-modes { gap: 6px; }
button.mode { flex: 1 1 0; font-size: 12px; padding: 6px 8px; }
button.mode.on {
  border-color: var(--accent); color: var(--accent);
  background: var(--accent-soft); font-weight: 600;
}
button.mode.on:hover { background: var(--accent-soft); }

button {
  font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: #fff; color: var(--ink); cursor: pointer; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(20,22,30,.05);
  transition: background .12s, border-color .12s;
}
button:hover { border-color: #ccced6; background: var(--panel-sunk); }
button:active { transform: translateY(.5px); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 550; }
button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.icon {
  border: 0; padding: 3px 7px; color: var(--faint); font-size: 17px; line-height: 1;
  background: none; box-shadow: none; border-radius: 5px;
}
button.icon:hover { color: var(--ink); background: var(--line-soft); }
button.tiny { padding: 3px 9px; font-size: 12px; box-shadow: none; }
button.link {
  border: 0; background: none; color: var(--accent); padding: 3px 6px; font-size: 12px;
  box-shadow: none; font-weight: 500;
}
button.link:hover { background: var(--accent-soft); }
button:disabled { opacity: .42; cursor: default; }
button:disabled:hover { background: #fff; border-color: var(--line); }

.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.row.gap { margin-top: 10px; }
.grow { flex: 1 1 auto; }
.hint { color: var(--muted); font-size: 12px; line-height: 1.55; }
.faint { color: var(--faint); font-size: 11px; }

.job { margin-bottom: 12px; }
.job .role { font-weight: 650; font-size: 15px; line-height: 1.3; letter-spacing: -.01em; }
.job .co { color: var(--muted); margin-top: 1px; }

/* Each step is a labelled block, so the card reads as a sequence. */
.step { border-top: 1px solid var(--line-soft); padding-top: 11px; margin-top: 12px; }
.step:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.step-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.step-head .n {
  width: 18px; height: 18px; border-radius: 50%; background: var(--accent-soft); color: var(--accent);
  font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: 0 0 auto;
}
.step-head .t { font-weight: 620; font-size: 13px; letter-spacing: -.01em; }
.step-head .done { background: var(--good-bg); color: var(--good); }

.fit {
  padding: 8px 10px; border-radius: 6px; font-size: 12px; margin: 8px 0; font-weight: 500;
  background: var(--good-bg); border: 1px solid var(--good-line); border-left: 3px solid var(--good);
  color: var(--good);
}
.fit.bad { background: var(--bad-bg); border-color: var(--bad-line); border-left-color: var(--bad); color: var(--bad); }
.fit.idle {
  background: var(--panel-sunk); border: 1px solid var(--line); border-left: 3px solid var(--line);
  color: var(--muted); font-weight: 400;
}

/* What the tailoring changed, in words. */
.changes { display: grid; gap: 6px; margin: 8px 0 2px; }
.change { background: var(--panel-sunk); border: 1px solid var(--line-soft); border-radius: 7px; padding: 7px 9px; }
.change .where {
  font-size: 10px; color: var(--faint); text-transform: uppercase; letter-spacing: .07em; font-weight: 650;
}
.change .swap { font-size: 12.5px; margin-top: 2px; }
.change .swap .to { font-weight: 640; }
.change .swap .arrow { color: var(--faint); padding: 0 4px; }
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
  width: 12px; height: 12px; border: 2px solid #cdd8ef; border-top-color: var(--accent);
  border-radius: 50%; display: inline-block; animation: spin .7s linear infinite; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }
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
export function createCard({ analysis, resumes, settings, questions = [], onAction }) {
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
    spec: analysis.spec,
    render: null,
    busy: null,
    error: null,
    bundle: null,
    view: 'propose',
    letter: null,
    /** True once the letter step is open, even if the draft came back empty. */
    letterStarted: false,
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
    /** How the proposal on screen was produced: 'tags' or 'ai'. */
    builtWith: analysis.aiUsed ? 'ai' : 'tags',
  };

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
  async function act(action, payload, apply) {
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
      state.busy = null;
      draw();
    }
  }

  const busyLabel = (action, idle, working) =>
    state.busy === action ? working : idle;

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
      title: 'The extension is set to use the AI, but ResumeM-M has it switched off. Turn it on under Voice & AI.',
    },
    offline: {
      text: 'AI unknown',
      className: 'ai off',
      title: 'ResumeM-M is not reachable, so its AI setting could not be read.',
    },
  };

  function drawAiChip() {
    if (!state.ai) return null;
    const look = AI_CHIP[state.ai.state] ?? AI_CHIP.off;
    return h('span', { className: look.className, title: look.title, textContent: look.text });
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
    ]);
  }

  function stepHead(n, title, done = false) {
    return h('div', { className: 'step-head' }, [
      h('span', { className: `n${done ? ' done' : ''}`, textContent: done ? '✓' : String(n) }),
      h('span', { className: 't', textContent: title }),
    ]);
  }

  /** What the tailoring changed, in words. Never a silent swap, never an id. */
  function drawChanges() {
    const changes = analysis.rationale ?? [];
    if (changes.length === 0) {
      return h('div', { className: 'no-change' }, 'Nothing needed changing — your base resume already suits this posting.');
    }

    const list = h('div', { className: 'changes' });
    for (const c of changes) {
      const why = h('div', { className: 'why' });
      for (const k of c.because ?? []) why.append(h('span', { className: 'kw', textContent: k }));

      list.append(
        h('div', { className: 'change' }, [
          h('div', {
            className: 'where',
            textContent: [c.where, c.what === 'bullet' ? null : c.what].filter(Boolean).join(' · ') || c.key,
          }),
          h('div', { className: 'swap' }, [
            h('span', { textContent: c.fromLabel ?? c.from }),
            h('span', { className: 'arrow', textContent: '→' }),
            h('span', { className: 'to', textContent: c.toLabel ?? c.to }),
          ]),
          c.toText ? h('div', { className: 'text' }, markup(c.toText)) : null,
          (c.because ?? []).length ? why : null,
        ]),
      );
    }
    return list;
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
        textContent: state.busy === 'render' ? 'Compiling…' : 'Not compiled yet.',
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

  function drawProposeView() {
    const baseSelect = h('select', { title: 'Which resume to start from' });
    for (const r of resumes) {
      baseSelect.append(
        h('option', { value: r.id, textContent: `${r.label}`, selected: r.id === analysis.baseResumeId }),
      );
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
            onclick: () =>
              act('rebuild', { useAi: false }, () => {
                state.builtWith = 'tags';
                state.render = null;
              }),
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
            onclick: () =>
              act('rebuild', { useAi: true }, () => {
                state.builtWith = 'ai';
                state.render = null;
              }),
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
        h('div', { className: 'row' }, [
          h('button', {
            className: 'primary',
            textContent: busyLabel('render', state.render ? 'Recompile' : 'Build resume', 'Compiling…'),
            disabled: Boolean(state.busy),
            onclick: () => act('render', { spec: state.spec }, (r) => (state.render = r)),
          }),
          state.render
            ? h('a', { href: state.render.absolutePdfUrl, target: '_blank', textContent: 'Open PDF' })
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

    /* 2. Cover letter */
    body.append(
      h('div', { className: 'step' }, [
        stepHead(2, 'Cover letter', Boolean(state.letter?.trim())),
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
                  onclick: () =>
                    act('coverLetter', { spec: state.spec }, (r) => {
                      if (!r) return;
                      state.priorLetters = r.priorLetters ?? [];
                      state.letterStarted = true;

                      // Three honest outcomes, in descending order of help, and
                      // all of them leave you with an editor rather than a
                      // dead end: a fresh draft, your closest previous letter
                      // to adapt, or a blank page that becomes the reference
                      // for next time.
                      if (r.body?.trim()) {
                        state.letter = r.body;
                        state.letterSource = 'Drafted in your voice from your previous letters.';
                      } else if (state.priorLetters.length > 0) {
                        state.letter = state.priorLetters[0].body;
                        state.letterSource = `The AI is off — this is your closest previous letter (${state.priorLetters[0].title}) to adapt.`;
                      } else {
                        state.letter = '';
                        state.letterSource =
                          'No previous letters yet. Write one here and the next draft starts from it.';
                      }
                    }),
                }),
              ]),
            ]),
      ]),
    );

    /* 3. Questions found on the page */
    body.append(drawQuestionsStep());

    /* 4. Form and filing */
    body.append(
      h('div', { className: 'step' }, [
        stepHead(4, 'Fill in and file', Boolean(state.bundle)),
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
    const step = h('div', { className: 'step' }, [
      stepHead(3, 'Application questions', Object.keys(state.answers).length > 0),
    ]);

    // A posting that wants prose is a job for the editor, not a sidebar.
    const writingNeeded = state.questions.length > 0;
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

    if (!writingNeeded) {
      step.append(h('div', { className: 'hint' }, 'No free-text questions found on this page.'));
      return step;
    }

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
        h('div', { className: 'path', textContent: b.dir }),
        h('div', { className: 'row gap' }, [
          h('button', {
            className: 'tiny',
            textContent: 'Copy folder path',
            onclick: () => navigator.clipboard?.writeText(b.dir),
          }),
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
    card.replaceChildren(drawHead(), state.view === 'done' ? drawDoneView() : drawProposeView());
  }

  draw();

  return {
    remove: removeCard,
    /** Replace the analysis after the user switches base resume. */
    update(next) {
      Object.assign(analysis, next);
      state.spec = next.spec ?? state.spec;
      state.render = null;
      draw();
    },
    setQuestions(qs) {
      state.questions = qs;
      draw();
    },
    setStatus(text) {
      state.error = text;
      draw();
    },
  };
}
