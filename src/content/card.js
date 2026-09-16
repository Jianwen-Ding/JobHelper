/**
 * The corner card. Lives in a shadow root so no job board's stylesheet can
 * reach it and nothing it does leaks back onto the page.
 *
 * The interaction it is built around: propose, show what changed and why, and
 * let the user redirect it in their own words before anything is written.
 */

const STYLE = `
:host { all: initial; }
.card {
  position: fixed;
  top: 16px;
  right: 16px;
  width: 380px;
  max-height: calc(100vh - 32px);
  overflow: auto;
  background: #fff;
  color: #1a1a1c;
  border: 1px solid #dededf;
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483647;
}
.head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #eee; }
.head b { font-size: 13px; }
.head .spacer { margin-left: auto; }
.body { padding: 12px; }
.job { margin-bottom: 10px; }
.job .role { font-weight: 650; }
.job .co { color: #6b6b73; }
button {
  font: inherit; padding: 6px 10px; border: 1px solid #dededf; border-radius: 6px;
  background: #fff; color: #1a1a1c; cursor: pointer;
}
button:hover { border-color: #bdbdc2; }
button.primary { background: #2f5fd0; border-color: #2f5fd0; color: #fff; }
button.primary:hover { background: #27509f; }
button.icon { border: 0; padding: 2px 6px; color: #6b6b73; font-size: 16px; line-height: 1; }
button:disabled { opacity: .5; cursor: default; }
.row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.hint { color: #6b6b73; font-size: 12px; }
.fit { padding: 7px 9px; border-radius: 6px; font-size: 12px; margin: 8px 0; }
.fit.ok { background: #eef6f0; border: 1px solid #cfe4d6; color: #1a7f4b; }
.fit.bad { background: #fdeeed; border: 1px solid #f2cdca; color: #b4251d; }
.fit.idle { background: #f6f6f7; border: 1px solid #ededee; color: #6b6b73; }
.changes { margin: 8px 0; }
.changes li { margin-bottom: 4px; font-size: 12px; }
.changes code { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #6b6b73; }
.err { color: #b4251d; font-size: 12px; margin-top: 8px; }
textarea { width: 100%; min-height: 60px; font: inherit; padding: 6px; border: 1px solid #dededf; border-radius: 6px; }
select { font: inherit; padding: 5px 8px; border: 1px solid #dededf; border-radius: 6px; max-width: 100%; }
.suggestion { border: 1px solid #ffe4ad; background: #fffaf0; border-radius: 6px; padding: 8px; margin-bottom: 6px; }
.suggestion .why { color: #8a6100; font-size: 11px; margin-top: 4px; }
a { color: #2f5fd0; }
.done { background: #eef6f0; border: 1px solid #cfe4d6; border-radius: 6px; padding: 10px; }
.done code { display: block; font-family: ui-monospace, Menlo, monospace; font-size: 11px; margin-top: 6px; word-break: break-all; }
`;

const HOST_ID = 'jobhelper-card-host';

export function removeCard() {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * @param {object} opts
 * @param {(action: string, payload?: any) => Promise<any>} opts.onAction
 */
export function createCard({ analysis, resumes, settings, onAction }) {
  removeCard();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);

  const card = document.createElement('div');
  card.className = 'card';
  root.append(card);
  document.documentElement.append(host);

  const state = {
    spec: analysis.spec,
    render: null,
    busy: false,
    error: null,
    bundle: null,
    view: 'propose',
  };

  const h = (tag, props = {}, kids = []) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of [].concat(kids)) if (k != null) n.append(k);
    return n;
  };

  /**
   * Run an action with the card showing a busy state.
   *
   * `apply` runs before the final redraw: the redraw has to see the result, so
   * assigning it in the caller after `await` would always repaint stale state.
   */
  async function act(action, payload, apply) {
    state.busy = true;
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
      state.busy = false;
      draw();
    }
  }

  /* ---------------------------------------------------------------- */

  function drawHead() {
    return h('div', { className: 'head' }, [
      h('b', { textContent: 'JobHelper' }),
      h('span', { className: 'spacer' }),
      h('button', {
        className: 'icon',
        title: 'Not now',
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
    ]);
  }

  /** What the tailoring changed, and on what evidence. Never a silent swap. */
  function drawChanges() {
    const changes = analysis.rationale ?? [];
    if (changes.length === 0) {
      return h('div', { className: 'hint' }, 'Nothing needed changing — your base resume already fits this posting.');
    }
    const list = h('ul', { className: 'changes' });
    for (const c of changes) {
      list.append(
        h('li', {}, [
          h('code', { textContent: c.key }),
          ` → ${c.to} `,
          h('span', { className: 'hint', textContent: c.because.length ? `(${c.because.join(', ')})` : '' }),
        ]),
      );
    }
    return h('div', {}, [h('div', { className: 'hint', textContent: `${changes.length} change(s):` }), list]);
  }

  function drawFit() {
    if (!state.render) {
      return h('div', { className: 'fit idle', textContent: state.busy ? 'Compiling…' : 'Not compiled yet.' });
    }
    const r = state.render;
    if (!r.fits) {
      return h('div', {
        className: 'fit bad',
        textContent: `${r.pages} pages — about ${r.overflowLines} line(s) too long.`,
      });
    }
    const adj = r.adjustments?.length ? ` Auto-fit: ${r.adjustments.join('; ')}.` : '';
    return h('div', { className: 'fit ok', textContent: `Fits on one page.${adj}` });
  }

  /** New phrasings the AI proposed. Opt-in, one at a time, never automatic. */
  function drawSuggestions() {
    const suggestions = analysis.suggestions ?? [];
    if (suggestions.length === 0) return null;

    const box = h('div', {}, [
      h('div', { className: 'hint', textContent: 'Suggested new phrasings — these are not in your store yet:' }),
    ]);
    for (const s of suggestions) {
      const node = h('div', { className: 'suggestion' }, [
        h('div', { textContent: s.text }),
        h('div', { className: 'why', textContent: s.why ?? '' }),
        h('div', { className: 'row' }, [
          h('button', {
            textContent: 'Add to store',
            onclick: () =>
              act(
                'addVariant',
                {
                  entryId: s.entryId ?? findEntryForBullet(s.bulletId),
                  bulletId: s.bulletId,
                  variant: { label: s.label ?? 'Suggested', text: s.text },
                },
                (saved) => {
                  // Drop it from the proposal so the redraw does not offer it
                  // again now that it lives in the store.
                  if (saved) analysis.suggestions = suggestions.filter((x) => x !== s);
                },
              ),
          }),
          h('button', {
            textContent: 'Ignore',
            onclick: () => {
              analysis.suggestions = suggestions.filter((x) => x !== s);
              draw();
            },
          }),
        ]),
      ]);
      box.append(node);
    }
    return box;
  }

  function findEntryForBullet(bulletId) {
    // The server sends the owning entry with each suggestion when it can; this
    // is the fallback for replies that omit it.
    return analysis.entryByBullet?.[bulletId] ?? null;
  }

  function drawProposeView() {
    const baseSelect = h('select', { title: 'Which resume to start from' });
    for (const r of resumes) {
      baseSelect.append(
        h('option', { value: r.id, textContent: `${r.label} (${r.id})`, selected: r.id === analysis.baseResumeId }),
      );
    }
    baseSelect.onchange = async () => {
      await onAction('setBase', { baseResumeId: baseSelect.value });
    };

    const feedback = h('textarea', {
      placeholder:
        'Anything to change? e.g. "lead with the distributed systems work" or "drop the mentoring bullet".',
    });

    return h('div', { className: 'body' }, [
      drawJob(),
      h('div', { className: 'row' }, [h('span', { className: 'hint', textContent: 'Start from' }), baseSelect]),
      drawChanges(),
      drawFit(),
      drawSuggestions(),
      h('div', { className: 'row' }, [
        h('button', {
          className: 'primary',
          textContent: state.render ? 'Recompile' : 'Build resume',
          disabled: state.busy,
          onclick: () => act('render', { spec: state.spec }, (r) => (state.render = r)),
        }),
        state.render
          ? h('a', {
              href: state.render.absolutePdfUrl,
              target: '_blank',
              textContent: 'Open PDF',
            })
          : null,
      ]),
      h('div', { className: 'hint', textContent: 'Feedback' }),
      feedback,
      h('div', { className: 'row' }, [
        h('button', {
          textContent: 'Apply feedback',
          disabled: state.busy,
          onclick: async () => {
            if (!feedback.value.trim()) return;
            const refined = await act('refine', { spec: state.spec, feedback: feedback.value });
            if (refined?.parsed?.choices) {
              state.spec = { ...state.spec, choices: { ...state.spec.choices, ...refined.parsed.choices } };
              await act('render', { spec: state.spec }, (r) => (state.render = r));
            } else if (refined && !refined.executed) {
              state.error =
                "AI is turned off, so feedback cannot be applied automatically. Turn it on in ResumeM-M's config.yaml, or adjust the choices in the editor.";
              draw();
            }
          },
        }),
        h('button', {
          textContent: 'Autofill this form',
          disabled: state.busy,
          onclick: () => act('autofill'),
        }),
      ]),
      h('div', { className: 'row' }, [
        h('button', {
          className: 'primary',
          textContent: 'Save application folder',
          disabled: state.busy || !state.render,
          title: 'Compile, name the files properly, and snapshot what was sent',
          onclick: () =>
            act('bundle', { spec: state.spec }, (bundle) => {
              if (bundle) {
                state.bundle = bundle;
                state.view = 'done';
              }
            }),
        }),
      ]),
      state.error ? h('div', { className: 'err', textContent: state.error }) : null,
    ]);
  }

  function drawDoneView() {
    const b = state.bundle;
    return h('div', { className: 'body' }, [
      h('div', { className: 'done' }, [
        h('div', { textContent: 'Saved. Files are ready to attach:' }),
        h('code', { textContent: b.dir }),
        ...b.files.map((f) => h('div', { className: 'hint', textContent: `· ${f}` })),
      ]),
      h('div', { className: 'row' }, [
        h('button', {
          textContent: 'Autofill this form',
          onclick: () => act('autofill'),
        }),
        h('button', {
          className: 'primary',
          textContent: 'Mark as submitted',
          onclick: async () => {
            await act('trackStatus', { id: b.application.id, status: 'applied', note: 'Submitted from the browser' });
            state.view = 'closed';
            removeCard();
          },
        }),
      ]),
      h('div', {
        className: 'hint',
        textContent: 'Tracked in ResumeM-M with a copy of exactly what was sent.',
      }),
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
    setStatus(text) {
      state.error = text;
      draw();
    },
  };
}
