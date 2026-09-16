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
  // The worker is web-accessible too; without it pdf.js falls back to running
  // on the main thread, which is fine for one page but slower.
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
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
