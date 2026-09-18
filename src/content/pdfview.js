/**
 * Draws a compiled PDF into the card, so you can look at the resume without
 * leaving the posting.
 *
 * Two problems make this less obvious than it sounds. A job board served over
 * https cannot fetch `http://127.0.0.1`, so the bytes come through the service
 * worker instead of straight from the page. And an `<iframe>` pointed at a PDF
 * hands the job to Chrome's viewer, which cannot be updated without blanking —
 * the same flashing that drove the editor to pdf.js. So: bytes in, canvas out,
 * one finished page swapped in at a time.
 */

const SCALE_CAP = 2;

let pdfjs = null;

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(chrome.runtime.getURL('vendor/pdf.min.mjs'));
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');

  /*
   * Ask for the worker by its own URL, and never through a blob.
   *
   * pdf.js spawns its worker one of two ways. Where `workerSrc` is the page's
   * own origin it calls `new Worker(workerSrc)`. Where it is not — and from a
   * content script it never is, because `workerSrc` is `chrome-extension://`
   * and the page is whatever site you are on — it fetches the script into a
   * Blob and starts the worker from `blob:`. That is the route every posting
   * page took, and a page whose `worker-src` does not list `blob:` refuses it.
   * GitHub's does not:
   *
   *   Refused to create a worker from 'blob:https://github.com/…' because it
   *   violates the following Content Security Policy directive: "worker-src
   *   github.githubassets.com …". The action has been blocked.
   *
   * Nothing broke — pdf.js catches it and sets up its fake worker, and the
   * resume still draws. Measured under exactly that policy: one page, one
   * canvas, 472ms. What it cost was a violation reported to the site on every
   * posting with a strict policy, which reads as this extension being broken,
   * plus a wasted fetch of a 1MB script before falling back.
   *
   * There is no way to have a real worker here. A content script cannot start
   * one from an extension URL either — Chrome refuses that as cross-origin,
   * measured — so the main thread is where this was always going to run. The
   * only choice is how it gets there. Saying "same origin" sends pdf.js down
   * the direct path, where the failure is a plain TypeError it already catches
   * rather than something the browser reports to the page. On an extension
   * page, where `workerSrc` really is same-origin, the direct path is the one
   * that works, so this is a no-op there.
   *
   * `_isSameOrigin` is pdf.js's own, assigned as a plain static property. If a
   * later version stops using it this assignment does nothing and the blob
   * route comes back — noisy again, but not broken.
   */
  pdfjs.PDFWorker._isSameOrigin = () => true;
  return pdfjs;
}

function bytesFrom(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Render every page of `base64` into `container`, at the width available.
 * Returns the number of pages, or throws with something worth showing.
 */
export async function drawPdf(container, base64, { width } = {}) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytesFrom(base64), isEvalSupported: false }).promise;

  try {
    const target = width || container.clientWidth || 380;
    const canvases = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const unscaled = page.getViewport({ scale: 1 });
      const scale = target / unscaled.width;
      const viewport = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, SCALE_CAP) });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(unscaled.width * scale)}px`;
      canvas.style.height = `${Math.floor(unscaled.height * scale)}px`;
      canvas.className = 'pdf-page';
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      canvases.push(canvas);
    }
    // One swap, fully drawn — never a half-rendered page on screen.
    container.replaceChildren(...canvases);
    return doc.numPages;
  } finally {
    doc.destroy();
  }
}
