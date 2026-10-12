import { imageKind, refused, screenshotCount } from '../shared/bug-reports.js';

const $ = (id) => document.getElementById(id);
const send = async (type, payload) => {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) throw new Error(response?.error ?? 'JobHelper did not respond.');
  return response.data;
};
const screenshots = [];
let busy = false;
const status = (text, error = false) => { $('status').textContent = text; $('status').className = error ? 'error' : ''; };
const metadata = () => { $('metadata').textContent = `JobHelper ${chrome.runtime.getManifest().version} · The current time and code fingerprint are added when you save.`; };
metadata();

function previews() {
  $('previews').replaceChildren();
  screenshots.forEach((image, i) => {
    const box = document.createElement('div'); box.className = 'preview';
    const img = document.createElement('img'); img.src = image.data; img.alt = `Screenshot ${i + 1}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = `Remove screenshot ${i + 1}`;
    remove.disabled = busy;
    remove.onclick = () => { screenshots.splice(i, 1); previews(); };
    box.append(img, remove); $('previews').append(box);
  });
}
let adding = Promise.resolve();
function addImages(files) {
  adding = adding.then(async () => {
    for (const file of files) {
      if (busy) return;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose PNG, JPEG or WebP images.');
      // By what the bytes are, not what the name says: ResumeM-M checks the
      // bytes, and a JPEG named .png was refused there after it was saved.
      const kind = imageKind(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
      if (!kind) throw new Error(`${file.name || 'That file'} is not a PNG, JPEG or WebP image.`);
      if (screenshots.length >= 3 || screenshots.reduce((sum, image) => sum + image.size, 0) + file.size > 4 * 1024 * 1024) {
        throw new Error('Use up to three screenshots totaling at most 4 MB.');
      }
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read that image.'));
        reader.readAsDataURL(file);
      }).then((url) => String(url).replace(/^data:[^;,]*;base64,/, `data:image/${kind};base64,`));
      screenshots.push({ data, size: file.size }); previews();
    }
    status('Screenshot added.');
  }).catch((error) => status(error.message, true));
}
document.addEventListener('paste', (event) => {
  const images = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith('image/')).map((item) => item.getAsFile()).filter(Boolean);
  if (images.length) { event.preventDefault(); addImages(images); }
});
$('images').onchange = () => { addImages([...$('images').files]); $('images').value = ''; };

async function inbox() {
  const reports = await send('listBugReports');
  $('inbox').replaceChildren();
  if (!reports.length) { $('inbox').textContent = 'No reports yet.'; return; }
  for (const report of reports) {
    const row = document.createElement('article'); row.className = 'report';
    const info = document.createElement('p'); info.className = 'hint';
    // A report in the inbox is kept here without its screenshots (they are
    // in the inbox), so the count is the one it was saved with, said as such.
    const count = screenshotCount(report);
    const shots = count && !report.screenshots.length ? `${count} screenshot(s), in the file inbox` : `${count} screenshot(s)`;
    info.textContent = `${new Date(report.createdAt).toLocaleString()} · JobHelper ${report.version} · ${shots} · ${report.id}`;
    const notes = document.createElement('p'); notes.textContent = report.text;
    const place = document.createElement('p'); place.className = 'hint';
    const turnedDown = refused(report);
    place.textContent = report.receipt ? `File inbox: ${report.receipt.directory}`
      : turnedDown ? `Saved in this browser only. ResumeM-M refused it (${report.syncStatus}): ${report.syncError ?? ''} Retrying will not change that.`
      : `Saved in this browser; waiting for the file inbox. ${report.syncError ?? ''}`;
    row.append(info, notes, place);
    if (!report.receipt) {
      const retry = document.createElement('button'); retry.textContent = 'Retry copying to inbox';
      /*
       * Delete waits while a retry is out. Deleting during one was answered
       * "Report deleted", and then the retry finished and wrote the report
       * back. bug-reports.js no longer writes back a deleted report, but the
       * row should not offer both at once either.
       */
      retry.onclick = async () => {
        retry.disabled = true; discard.disabled = true;
        try { await send('syncBugReport', { id: report.id }); await inbox(); }
        catch (error) { status(error.message, true); retry.disabled = false; discard.disabled = false; }
      };
      /*
       * And a way to let go of it. A report the inbox never took could not be
       * cleared, and a few of them fill the browser's storage for reports.
       * Asked first, because this is the only copy there is.
       */
      const discard = document.createElement('button'); discard.textContent = 'Delete from browser';
      discard.title = 'This report was never copied to the file inbox. Deleting it removes the only copy.';
      discard.onclick = async () => {
        if (!confirm('This report was never copied to the file inbox, so this is its only copy. Delete it anyway?')) return;
        discard.disabled = true; retry.disabled = true;
        try { await send('clearBugReport', { id: report.id, discard: true }); await inbox(); status('Report deleted from this browser.'); }
        catch (error) { status(error.message, true); discard.disabled = false; retry.disabled = false; }
      };
      row.append(retry, discard);
    } else {
      const clear = document.createElement('button'); clear.textContent = 'Clear browser copy';
      clear.title = 'Free browser storage. The report and screenshots stay in the file inbox.';
      clear.onclick = async () => {
        clear.disabled = true;
        try { await send('clearBugReport', { id: report.id }); await inbox(); status('Browser copy cleared. The report stays in the file inbox.'); }
        catch (error) { status(error.message, true); clear.disabled = false; }
      };
      row.append(clear);
    }
    const view = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'View saved screenshots'; view.append(summary);
    report.screenshots.forEach((data, i) => { const img = document.createElement('img'); img.src = data; img.alt = `Saved screenshot ${i + 1}`; img.style.maxWidth = '100%'; view.append(img); });
    if (report.screenshots.length) row.append(view);
    $('inbox').append(row);
  }
}
$('reportForm').onsubmit = async (event) => {
  event.preventDefault();
  if (busy) return;
  await adding;
  if (busy) return;
  busy = true; $('save').disabled = true; $('notes').disabled = true; $('images').disabled = true; previews();
  try {
    status('Saving report…');
    const report = await send('saveBugReport', { text: $('notes').value, screenshots: screenshots.map((image) => image.data) });
    $('notes').value = ''; screenshots.length = 0;
    status(report.receipt ? 'Saved in the local file inbox for later review.' : 'Saved in this browser. ResumeM-M could not receive it yet; retry below.');
    await inbox();
  } catch (error) { status(`Could not save: ${error.message} Your notes and screenshots are still here.`, true); }
  finally { busy = false; $('save').disabled = false; $('notes').disabled = false; $('images').disabled = false; previews(); }
};
inbox().catch((error) => status(error.message, true));
