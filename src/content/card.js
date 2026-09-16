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
:host { all: initial; }
.card {
  position: fixed;
  top: 14px;
  right: 14px;
  width: 416px;
  max-height: calc(100vh - 28px);
  display: flex;
  flex-direction: column;
  background: #fff;
  color: #1a1a1c;
  border: 1px solid #dcdce1;
  border-radius: 11px;
  box-shadow: 0 10px 38px rgba(0,0,0,.2);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483647;
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid #eeeef1; flex: 0 0 auto;
}
.head b { font-size: 13px; letter-spacing: .1px; }
.head .spacer { margin-left: auto; }
.body { padding: 11px 12px; overflow: auto; flex: 1 1 auto; }

button {
  font: inherit; padding: 6px 10px; border: 1px solid #dcdce1; border-radius: 6px;
  background: #fff; color: #1a1a1c; cursor: pointer; white-space: nowrap;
}
button:hover { border-color: #bfbfc7; background: #fbfbfc; }
button.primary { background: #2f5fd0; border-color: #2f5fd0; color: #fff; }
button.primary:hover { background: #27509f; }
button.icon { border: 0; padding: 2px 6px; color: #77777f; font-size: 17px; line-height: 1; background: none; }
button.icon:hover { color: #1a1a1c; background: #f1f1f4; }
button.tiny { padding: 3px 8px; font-size: 12px; }
button.link { border: 0; background: none; color: #2f5fd0; padding: 3px 5px; font-size: 12px; }
button.link:hover { background: #eef2fb; }
button:disabled { opacity: .45; cursor: default; }
button:disabled:hover { background: #fff; border-color: #dcdce1; }

.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.row.gap { margin-top: 10px; }
.grow { flex: 1 1 auto; }
.hint { color: #6b6b73; font-size: 12px; }
.faint { color: #9a9aa2; font-size: 11px; }

.job .role { font-weight: 650; font-size: 14px; line-height: 1.35; }
.job .co { color: #6b6b73; }
.job { margin-bottom: 10px; }

/* Each step is a labelled block so the card reads as a sequence. */
.step { border-top: 1px solid #eeeef1; padding-top: 9px; margin-top: 10px; }
.step:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.step-head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
.step-head .n {
  width: 17px; height: 17px; border-radius: 50%; background: #eef2fb; color: #2f5fd0;
  font-size: 11px; font-weight: 700; display: grid; place-items: center; flex: 0 0 auto;
}
.step-head .t { font-weight: 600; font-size: 12.5px; }
.step-head .done { background: #e4f2ea; color: #1a7f4b; }

.fit { padding: 7px 9px; border-radius: 6px; font-size: 12px; margin: 7px 0; }
.fit.ok { background: #eef7f1; border: 1px solid #cfe6d8; color: #1a7f4b; }
.fit.bad { background: #fdeeed; border: 1px solid #f2cdca; color: #b4251d; }
.fit.idle { background: #f6f6f8; border: 1px solid #ededf0; color: #6b6b73; }

/* Changes, in words. */
.changes { display: grid; gap: 5px; margin: 6px 0 2px; }
.change { background: #fafafb; border: 1px solid #efeff2; border-radius: 6px; padding: 6px 8px; }
.change .where { font-size: 11px; color: #9a9aa2; text-transform: uppercase; letter-spacing: .04em; }
.change .swap { font-size: 12.5px; margin-top: 1px; }
.change .swap .to { font-weight: 600; }
.change .swap .arrow { color: #9a9aa2; padding: 0 3px; }
.change .text { color: #4a4a52; font-size: 12px; margin-top: 3px; }
.change .text strong { font-weight: 650; color: #1a1a1c; }
.change .text code, .suggestion code {
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .92em;
  background: #eeeef1; border-radius: 3px; padding: 0 3px;
}
.change .why { margin-top: 4px; }
.kw {
  display: inline-block; background: #eef2fb; color: #2f5fd0; border-radius: 3px;
  padding: 0 5px; font-size: 11px; margin-right: 3px;
}
.no-change { color: #6b6b73; font-size: 12px; background: #fafafb; border: 1px solid #efeff2; border-radius: 6px; padding: 7px 9px; }

textarea {
  width: 100%; min-height: 58px; font: inherit; padding: 7px;
  border: 1px solid #dcdce1; border-radius: 6px; resize: vertical; color: #1a1a1c; background: #fff;
}
textarea.tall { min-height: 150px; }
select { font: inherit; padding: 5px 8px; border: 1px solid #dcdce1; border-radius: 6px; max-width: 100%; background: #fff; color: #1a1a1c; }

.suggestion { border: 1px solid #f0e0bb; background: #fffaef; border-radius: 6px; padding: 8px; margin-bottom: 6px; }
.suggestion .why { color: #8a6100; font-size: 11px; margin-top: 4px; }

.q { border: 1px solid #efeff2; border-radius: 6px; padding: 8px; margin-bottom: 6px; background: #fafafb; }
.q .qt { font-weight: 600; font-size: 12.5px; margin-bottom: 4px; }
.q .badge {
  display: inline-block; border-radius: 3px; padding: 0 5px; font-size: 11px; margin-left: 5px;
  background: #e4f2ea; color: #1a7f4b;
}
.q .badge.weak { background: #fff4e0; color: #8a6100; }
.q .badge.none { background: #f1f1f4; color: #77777f; }

.err { color: #b4251d; font-size: 12px; margin-top: 8px; background: #fdeeed; border: 1px solid #f2cdca; border-radius: 6px; padding: 7px 9px; }
.ok-note { color: #1a7f4b; font-size: 12px; margin-top: 8px; }

.done-box { background: #eef7f1; border: 1px solid #cfe6d8; border-radius: 8px; padding: 10px; }
.done-box .path {
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px;
  background: #fff; border: 1px solid #d8e8de; border-radius: 5px; padding: 6px 7px;
  margin-top: 7px; word-break: break-all; color: #3a3a42;
}
.done-box .file { font-size: 12px; color: #3a3a42; margin-top: 4px; }
.spinner {
  width: 12px; height: 12px; border: 2px solid #cdd8ef; border-top-color: #2f5fd0;
  border-radius: 50%; display: inline-block; animation: spin .7s linear infinite; vertical-align: -2px;
}
@keyframes spin { to { transform: rotate(360deg); } }
a { color: #2f5fd0; }
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
  };

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

  function drawHead() {
    return h('div', { className: 'head' }, [
      h('b', { textContent: 'JobHelper' }),
      state.busy ? h('span', { className: 'spinner' }) : null,
      h('span', { className: 'spacer' }),
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
    baseSelect.onchange = () => act('setBase', { baseResumeId: baseSelect.value });

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
