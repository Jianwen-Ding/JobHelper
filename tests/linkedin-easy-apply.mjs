/**
 * LinkedIn's Easy Apply, at the resume step, as the page builds it.
 *
 * Shared by tests/attaching.mjs (where `dropOnto` and `attachFiles` are run
 * against it directly) and tests/dropping.mjs (where a real pointer drags a
 * chip-shaped drag into it with the extension loaded).
 *
 * What matters about it, from the markup LinkedIn has served since 2024:
 *
 *  - An `artdeco-modal` `div[role=dialog]`, not a `<dialog>`, with the step in
 *    a `<form>` and Back / Next in a footer outside it.
 *  - The Resume section is a list of the resumes uploaded before, one
 *    `.jobs-document-upload-redesign-card__container` each — the file's name,
 *    when it was last used, a download button and a radio, visually hidden
 *    and drawn as a circle by the label beside it. The selected card is
 *    marked `--selected` and `aria-checked`. Every one of those cards has
 *    "upload" in its class.
 *  - Under the list, `<label for="jobs-document-upload-file-input-upload-resume"
 *    class="artdeco-button">Upload resume</label>` and the real
 *    `<input type=file class="hidden">` (display:none) behind it.
 *  - On `change` LinkedIn uploads the file, then adds a new card at the top of
 *    the list and selects it. `clears` also empties the input afterwards, as
 *    a component that lets the same file be chosen twice does.
 *  - Optionally a Cover letter section on the same step, built the same way.
 *  - Optionally (`shadow`) the whole modal inside an open shadow root on
 *    `#interop-outlet`, which is how LinkedIn has served it since 2025.
 *  - Optionally (`closed`) the same, with the shadow root closed, so that
 *    `host.shadowRoot` is null and only `chrome.dom.openOrClosedShadowRoot`
 *    reaches inside.
 *  - Optionally (`picker`) no file input at all, which is what the user's own
 *    page showed: a console probe of the document and every open shadow root
 *    found `"inputs": []` with the dialog in `#interop-outlet`'s open root.
 *    "Upload resume" is a `<button>` whose click handler makes the input then
 *    and there and calls `click()` on it to open the dialog. `'detached'`
 *    never attaches it; `'transient'` appends it, clicks it and removes it
 *    in the same handler. `window.linkedin.made` counts the inputs made.
 *  - Optionally (`guard`) LinkedIn's own drag handling: the page refuses drops
 *    anywhere but its upload control (`dropEffect = 'none'`), and the upload
 *    control reads `dataTransfer.files` itself and complains when the drag
 *    carries none.
 */

const RESUMES = [
  { name: 'Refactor Resume.docx', when: 'Last used on 10/13/2024', selected: true },
  { name: 'Jianwen-Ding-Resume-2023.pdf', when: 'Last used on 3/2/2024' },
];

const card = (kind, { name, when, selected }, i) => `
  <div class="jobs-document-upload-redesign-card__container${selected ? ' jobs-document-upload-redesign-card__container--selected' : ''}"
       aria-checked="${selected ? 'true' : 'false'}" data-kind="${kind}">
    <div class="display-flex">
      <div class="jobs-document-upload-redesign-card__file-icon">${/\.pdf$/i.test(name) ? 'PDF' : 'DOC'}</div>
      <div class="jobs-document-upload-redesign-card__file-info">
        <h3 class="jobs-document-upload-redesign-card__file-name t-14">${name}</h3>
        <p class="jobs-document-upload-redesign-card__last-used t-12">${when}</p>
      </div>
    </div>
    <div class="jobs-document-upload-redesign-card__toggle-wrapper">
      <button type="button" class="artdeco-button artdeco-button--tertiary artdeco-button--circle" aria-label="Download ${kind} ${name}">&#8681;</button>
      <input type="radio" class="jobs-document-upload-redesign-card__toggle-input visually-hidden"
             id="jobsDocumentCardToggle-${kind}-${i}" name="jobsDocumentCardToggle-${kind}"${selected ? ' checked' : ''}>
      <label for="jobsDocumentCardToggle-${kind}-${i}" class="jobs-document-upload-redesign-card__toggle-label">
        <span class="visually-hidden">${selected ? 'Deselect' : 'Select'} ${kind}</span>
      </label>
    </div>
  </div>`;

const section = (kind, title, help, list, picker) => `
  <div class="jobs-document-upload-redesign-card__section" data-section="${kind}">
    <h3 class="t-16 t-bold">${title}</h3>
    <p class="t-12 t-black--light">${help}</p>
    <div class="jobs-document-upload-redesign-card__list" data-list="${kind}">
      ${list.map((r, i) => card(kind, r, i)).join('')}
    </div>
    <button type="button" class="artdeco-button artdeco-button--tertiary jobs-document-upload__show-more">Show more ${kind.replace('-', ' ')}s</button>
    <div class="js-jobs-document-upload__container jobs-document-upload__container display-flex">
      ${picker
        ? `<button type="button" data-upload="${kind}"
             class="jobs-document-upload__upload-button artdeco-button artdeco-button--secondary artdeco-button--2"
             aria-label="Upload ${kind.replace('-', ' ')} button. Supported file formats: DOC, DOCX, PDF">
             <span class="artdeco-button__text">Upload ${kind.replace('-', ' ')}</span>
           </button>`
        : `<label for="jobs-document-upload-file-input-upload-${kind}" data-upload="${kind}"
             class="jobs-document-upload__upload-button artdeco-button artdeco-button--secondary artdeco-button--2"
             aria-label="Upload ${kind.replace('-', ' ')} button. Supported file formats: DOC, DOCX, PDF">
             <span class="artdeco-button__text" role="button" tabindex="0">Upload ${kind.replace('-', ' ')}</span>
           </label>
           <input id="jobs-document-upload-file-input-upload-${kind}" name="file" type="file"
             accept=".doc,.docx,.pdf" class="hidden" aria-describedby="jobs-document-upload-${kind}-format">`}
      <p id="jobs-document-upload-${kind}-format" class="t-12 t-black--light">DOC, DOCX, PDF (2 MB)</p>
    </div>
  </div>`;

/** The contact-info section of the first step, for the frame variant. See tests/dropping.mjs. */
const CONTACT = `
  <div class="jobs-easy-apply-form-section__grouping">
    <h3 class="t-16 t-bold">Contact info</h3>
    <label for="fn">First name</label><input id="fn" name="firstName" type="text" value="">
    <label for="ln">Last name</label><input id="ln" name="lastName" type="text" value="">
    <label for="ph">Mobile phone number</label><input id="ph" name="phoneNumber" type="text" value="">
  </div>`;

const STYLE = `
  .hidden { display: none !important; }
  .visually-hidden { position: absolute !important; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .display-flex { display: flex; gap: 10px; align-items: center; }
  .artdeco-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: flex-start; justify-content: center; padding-top: 40px; z-index: 1000; }
  .artdeco-modal { background: #fff; width: 744px; max-width: calc(100vw - 32px); border-radius: 8px; font: 14px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif; color: rgba(0,0,0,.9); }
  .artdeco-modal__header { padding: 16px 24px; border-bottom: 1px solid #e8e8e8; }
  .artdeco-modal__header h2 { margin: 0; font-size: 20px; font-weight: 400; }
  .artdeco-modal__content { padding: 16px 24px; max-height: 60vh; overflow: auto; }
  .t-16 { font-size: 16px; } .t-14 { font-size: 14px; margin: 0; } .t-12 { font-size: 12px; margin: 2px 0; } .t-bold { font-weight: 600; }
  .t-black--light { color: rgba(0,0,0,.6); }
  .jobs-document-upload-redesign-card__section { padding: 8px 0 16px; }
  .jobs-document-upload-redesign-card__list { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
  .jobs-document-upload-redesign-card__container { display: flex; justify-content: space-between; align-items: center; border: 1px solid #ccc; border-radius: 8px; padding: 12px; }
  .jobs-document-upload-redesign-card__container--selected { border: 2px solid #01754f; }
  .jobs-document-upload-redesign-card__file-icon { background: #cc1016; color: #fff; font-weight: 700; padding: 18px 8px; border-radius: 4px; font-size: 12px; }
  .jobs-document-upload-redesign-card__toggle-wrapper { display: flex; align-items: center; gap: 12px; }
  .jobs-document-upload-redesign-card__toggle-label { display: inline-block; width: 22px; height: 22px; border-radius: 50%; border: 2px solid #666; cursor: pointer; }
  .jobs-document-upload-redesign-card__container--selected .jobs-document-upload-redesign-card__toggle-label { border-color: #01754f; background: radial-gradient(#01754f 45%, #fff 50%); }
  .artdeco-button { display: inline-flex; align-items: center; border-radius: 16px; padding: 6px 16px; font-weight: 600; cursor: pointer; background: #fff; border: 1px solid #0a66c2; color: #0a66c2; }
  .artdeco-button--tertiary { border: 0; }
  .artdeco-button--primary { background: #0a66c2; color: #fff; }
  .jobs-document-upload__progress { color: #0a66c2; font-size: 12px; }
  .jobs-document-upload__error { color: #cc1016; font-size: 12px; }
  .jobs-easy-apply-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px; border-top: 1px solid #e8e8e8; }
  .jobs-easy-apply-form-section__grouping label { display: block; margin-top: 8px; font-size: 12px; }
`;

/** The modal itself. */
function modal({ cover, contact, picker }) {
  return `
  <div class="artdeco-modal-overlay artdeco-modal-overlay--layer-default">
    <div class="jobs-easy-apply-modal artdeco-modal artdeco-modal--layer-default" role="dialog" tabindex="-1"
         aria-labelledby="jobs-apply-header">
      <button type="button" class="artdeco-modal__dismiss artdeco-button artdeco-button--tertiary" aria-label="Dismiss">&times;</button>
      <div class="artdeco-modal__header"><h2 id="jobs-apply-header">Apply to Camberwell Robotics</h2></div>
      <div class="jobs-easy-apply-content">
        <div class="artdeco-modal__content jobs-easy-apply-modal__content">
          <div class="pv4"><span class="t-12">50%</span><progress max="100" value="50"></progress></div>
          <form>
            ${contact ? CONTACT : ''}
            ${section('resume', 'Resume', 'Be sure to include an updated resume', RESUMES, picker)}
            ${cover ? section('cover-letter', 'Cover letter', 'Upload a cover letter (optional)', [{ name: 'Cover Letter Generic.pdf', when: 'Last used on 5/5/2024' }], picker) : ''}
          </form>
        </div>
        <footer class="jobs-easy-apply-footer" role="presentation">
          <button type="button" class="artdeco-button artdeco-button--secondary" aria-label="Back to previous step">Back</button>
          <button type="button" class="artdeco-button artdeco-button--primary" aria-label="Continue to next step" data-easy-apply-next-button>Next</button>
        </footer>
      </div>
    </div>
  </div>`;
}

/**
 * What LinkedIn does with a file. Runs against `root`, which is the document
 * or the shadow root the modal is in.
 */
function behave(root, { clears, guard, picker }) {
  window.linkedin = { uploads: [], refusedDrops: 0, pageDrops: 0, made: 0 };
  const today = 'Uploaded on 10/15/2026';
  /*
   * No input until the button is pressed: made, given its `accept` and its
   * `change` handler, and clicked — never attached (`detached`), or attached
   * for exactly as long as the click (`transient`).
   */
  if (picker) {
    for (const button of root.querySelectorAll('[data-upload]')) {
      const kind = button.getAttribute('data-upload');
      const holder = button.closest('.jobs-document-upload__container');
      button.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.doc,.docx,.pdf,application/pdf,application/msword';
        input.addEventListener('change', () => took(input, kind, holder));
        window.linkedin.made += 1;
        if (picker === 'transient') {
          holder.append(input);
          input.click();
          input.remove();
        } else {
          input.click();
        }
      });
    }
  }
  for (const input of root.querySelectorAll('input[type=file]')) {
    const kind = input.id.replace('jobs-document-upload-file-input-upload-', '');
    const holder = input.closest('.jobs-document-upload__container');
    input.addEventListener('change', () => took(input, kind, holder));
  }
  function took(input, kind, holder) {
    const file = input.files?.[0];
    if (!file) return;
    const name = file.name;
    if (clears) input.value = '';
    const busy = document.createElement('div');
    busy.className = 'jobs-document-upload__progress';
    busy.setAttribute('role', 'progressbar');
    busy.textContent = 'Uploading…';
    holder.append(busy);
    setTimeout(() => {
      busy.remove();
      const list = root.querySelector(`[data-list="${kind}"]`);
      for (const c of list.children) {
        c.classList.remove('jobs-document-upload-redesign-card__container--selected');
        c.setAttribute('aria-checked', 'false');
      }
      const wrap = document.createElement('div');
      wrap.innerHTML = card(kind, { name, when: today, selected: true }, list.children.length);
      list.prepend(wrap.firstElementChild);
      window.linkedin.uploads.push({ kind, name });
    }, 250);
  }
  for (const holder of root.querySelectorAll('.jobs-document-upload__container')) {
    if (guard) {
      holder.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      });
      holder.addEventListener('drop', (e) => {
        e.preventDefault();
        window.linkedin.pageDrops += 1;
        if (!e.dataTransfer.files.length) {
          const err = document.createElement('p');
          err.className = 'jobs-document-upload__error';
          err.textContent = 'Unable to upload. Please try again.';
          holder.append(err);
        }
      });
    }
  }
  if (guard) {
    /*
     * A stray drop anywhere else on the page is refused, so a file let go of
     * outside the upload control does not navigate the tab to it.
     */
    document.addEventListener('dragover', (e) => {
      if (e.composedPath().some((n) => n.classList?.contains('jobs-document-upload__container'))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      window.linkedin.refusedDrops += 1;
    });
  }
}

/**
 * The whole page: the job behind the modal, and the modal.
 *
 * @param {{shadow?: boolean, cover?: boolean, clears?: boolean, guard?: boolean, contact?: boolean}} o
 */
export function easyApply(o = {}) {
  const inner = modal(o);
  const helpers = `const card = ${card.toString()};`;
  const opts = JSON.stringify({ clears: Boolean(o.clears), guard: Boolean(o.guard), picker: o.picker || null });
  const mount = o.shadow || o.closed
    ? `<div id="interop-outlet" data-testid="interop-shadowdom"></div>
       <script>
         ${helpers}
         (() => {
           const host = document.getElementById('interop-outlet');
           const root = host.attachShadow({ mode: ${JSON.stringify(o.closed ? 'closed' : 'open')} });
           // The page's own handle on its root, which a closed root leaves it the only one of.
           window.__eaRoot = root;
           root.innerHTML = ${JSON.stringify(`<style>${STYLE}</style>${inner}`)};
           (${behave.toString().replace('function behave', 'function')})(root, ${opts});
         })();
       </script>`
    : `${inner}
       <script>${helpers}(${behave.toString().replace('function behave', 'function')})(document, ${opts});</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Platform Engineer | Camberwell Robotics | LinkedIn</title>
<style>${STYLE} body { margin: 0; font: 14px sans-serif; } .job { padding: 24px 40px; }</style></head>
<body>
  <div class="job">
    <h1>Platform Engineer</h1><p>Camberwell Robotics · Boston, MA · Easy Apply</p>
    <p>About the job: build the platform our robots run on. Kubernetes, Go, Python.</p>
  </div>
  ${mount}
  <script>
    /** Find through the shadow root, when there is one. */
    window.$ea = (sel) => {
      const host = document.getElementById('interop-outlet');
      return (window.__eaRoot ?? host?.shadowRoot ?? document).querySelector(sel);
    };
  </script>
</body></html>`;
}

/** Selectors for the places a chip gets let go of, in either variant. */
export const AIM = {
  button: '[data-upload="resume"] .artdeco-button__text',
  card: '[data-list="resume"] .jobs-document-upload-redesign-card__container:nth-child(2) .jobs-document-upload-redesign-card__file-name',
  circle: '[data-list="resume"] .jobs-document-upload-redesign-card__container:nth-child(1) .jobs-document-upload-redesign-card__toggle-label',
  section: '[data-section="resume"]',
  heading: '[data-section="resume"] > h3',
  footer: '.jobs-easy-apply-footer',
  next: '[data-easy-apply-next-button]',
  coverButton: '[data-upload="cover-letter"] .artdeco-button__text',
};
