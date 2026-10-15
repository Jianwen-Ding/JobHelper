/**
 * The page's own file dialog, answered by the extension — only when asked to.
 *
 * Runs in the page's world (`"world": "MAIN"` in the manifest), at
 * document_start, and does nothing at all until content.js arms it.
 *
 * Why it has to exist. LinkedIn's Easy Apply draws the resume step with an
 * "Upload resume" button and no file input anywhere: not in the document, not
 * in the open shadow root on `#interop-outlet` the dialog lives in. Measured
 * on the user's own page with a console probe that walked the document and
 * every open root: `{"inputs": [], "shadowRoots": ["document >
 * div#interop-outlet"], "dialogInShadow": true}`. The button's handler makes
 * an `<input type=file>` when it is pressed, calls `click()` on it to open the
 * dialog, and reads `files` on `change` — so there is no box to put a file in
 * until the dialog is already open, and a box that is never in the page
 * cannot be found from it. Attach files said "this page has no upload box the
 * extension can reach" and a chip let go of on the button said "there is no
 * upload box where you dropped it", on the one step of the one site where
 * somebody is most likely to try both.
 *
 * The content script cannot reach that input: it is made and clicked in the
 * page's world, never attached, and the content script's own world has its
 * own copy of `HTMLInputElement.prototype`, so replacing `click` there changes
 * nothing the page calls. This script's copy is the page's.
 *
 * What it does, while armed and for one use: a `click()` or `showPicker()` on
 * a file input does not open the dialog. It tells content.js what the input
 * says it takes (`accept`, `multiple`), and content.js — which keeps every
 * rule about what goes where — either hands over the file or declines. Handed
 * over, it goes in exactly as `attach.js` puts a file in any other box: a
 * `DataTransfer`'s `FileList` into `input.files`, then `input` and `change`,
 * bubbling. Declined, nothing happens, which is what the page would have seen
 * from a person cancelling the dialog.
 *
 * And `showOpenFilePicker`, for a page that asks for a file that way: the
 * same question, answered with something shaped like a `FileSystemFileHandle`
 * — its prototype, its `name` and `kind`, and a `getFile()` returning the
 * file. A page that only calls `getFile()` gets what a person's pick would
 * have given it; one that asks the handle for anything else gets an error
 * from the browser. Not seen on LinkedIn; covered because it is small.
 *
 * The arm lasts two seconds and one dialog. A click from the person after
 * that — or a second click inside it — goes to the real dialog, untouched.
 *
 * Talking across worlds. The two worlds share the DOM and nothing else; a
 * `CustomEvent`'s `detail` does not carry an object from one to the other,
 * and a `File` cannot be put in an attribute. `window.postMessage` can: it is
 * delivered to listeners in every world on the window, and a `File`
 * structured-clones. So every message here is a `postMessage` to this window,
 * marked `jobhelper-picker` and carrying a nonce content.js made for this one
 * arm. The page's own listeners see them too — including the file, at the
 * moment it is being handed to that page anyway. A page could answer in our
 * place; what it could get by doing so is the file it was about to be given,
 * and a report about itself that it chose to falsify.
 */
(() => {
  const MARK = 'jobhelper-picker';
  if (window[Symbol.for(MARK)]) return;
  window[Symbol.for(MARK)] = true;

  const ARMED_FOR_MS = 2000;
  let armed = null; // { nonce, until }
  const waiting = new Map(); // nonce -> (message) => void

  const say = (what) => window.postMessage({ [MARK]: true, ...what }, '*');

  /** Take the arm, if there is one and it is still good. One use only. */
  const takeArm = () => {
    if (!armed) return null;
    const arm = armed;
    armed = null;
    return Date.now() <= arm.until ? arm : null;
  };

  /** Ask content.js for the file, and wait for its answer. */
  const ask = (arm, accept, multiple) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(arm.nonce);
        resolve(null);
      }, 5000);
      waiting.set(arm.nonce, (message) => {
        clearTimeout(timer);
        waiting.delete(arm.nonce);
        resolve(message.type === 'deliver' && Array.isArray(message.files) ? message.files : null);
      });
      say({ type: 'asked', nonce: arm.nonce, accept, multiple });
    });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message[MARK] !== true || typeof message.nonce !== 'string') return;
    if (message.type === 'arm') {
      armed = { nonce: message.nonce, until: Date.now() + ARMED_FOR_MS };
      say({ type: 'armed', nonce: message.nonce });
    } else if (message.type === 'disarm') {
      if (armed?.nonce === message.nonce) armed = null;
    } else if (message.type === 'deliver' || message.type === 'decline') {
      waiting.get(message.nonce)?.(message);
    }
  });

  /*
   * `click` is `HTMLElement.prototype`'s — an input has no `click` of its
   * own — so it is replaced there, and asks whether `this` is a file input.
   * Replacing it on `HTMLInputElement.prototype` instead would miss a page
   * that calls `HTMLElement.prototype.click.call(input)`.
   */
  const proto = HTMLInputElement.prototype;
  const click = HTMLElement.prototype.click;
  const showPicker = proto.showPicker;

  /** Answer a file input's dialog. True when it was ours to answer. */
  function answer(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || input.disabled) return false;
    const arm = takeArm();
    if (!arm) return false;
    ask(arm, input.getAttribute('accept') ?? '', input.multiple).then((files) => {
      if (!files || files.length === 0) {
        say({ type: 'delivered', nonce: arm.nonce, count: 0 });
        return;
      }
      const carrier = new DataTransfer();
      for (const file of input.multiple ? files : files.slice(0, 1)) carrier.items.add(file);
      try {
        input.files = carrier.files;
      } catch {
        say({ type: 'delivered', nonce: arm.nonce, count: 0 });
        return;
      }
      const count = input.files?.length ?? 0;
      if (count > 0) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      say({ type: 'delivered', nonce: arm.nonce, count, names: [...(input.files ?? [])].map((f) => f.name) });
    });
    return true;
  }

  HTMLElement.prototype.click = function () {
    if (answer(this)) return undefined;
    return click.call(this);
  };
  if (typeof showPicker === 'function') {
    proto.showPicker = function () {
      if (answer(this)) return undefined;
      return showPicker.call(this);
    };
  }

  const openPicker = window.showOpenFilePicker;
  if (typeof openPicker === 'function') {
    window.showOpenFilePicker = function (options = {}) {
      const arm = takeArm();
      if (!arm) return openPicker.call(this, options);
      // `types: [{accept: {"application/pdf": [".pdf"]}}]`, read as an `accept` attribute.
      const accept = (options?.types ?? [])
        .flatMap((t) => Object.entries(t?.accept ?? {}).flatMap(([mime, exts]) => [mime, ...[].concat(exts ?? [])]))
        .join(',');
      return ask(arm, accept, Boolean(options?.multiple)).then((files) => {
        if (!files || files.length === 0) {
          say({ type: 'delivered', nonce: arm.nonce, count: 0 });
          throw new DOMException('The user aborted a request.', 'AbortError');
        }
        const chosen = options?.multiple ? files : files.slice(0, 1);
        const Handle = window.FileSystemFileHandle;
        const handles = chosen.map((file) =>
          Object.defineProperties(Object.create(Handle ? Handle.prototype : Object.prototype), {
            kind: { value: 'file' },
            name: { value: file.name },
            getFile: { value: async () => file },
          }),
        );
        say({ type: 'delivered', nonce: arm.nonce, count: handles.length, names: chosen.map((f) => f.name) });
        return handles;
      });
    };
  }
})();
