# JobHelper

A Chrome extension that notices you are looking at a job posting, offers a
resume tailored to it from your own stored phrasings, and fills the application
form from things you have already written down.

It is a thin client. Everything that knows about resumes lives in
[ResumeM-M](https://github.com/Jianwen-Ding/ResumeM-M), running on your own
machine.

---

## What it does

1. **Stays quiet.** On every page it computes a cheap local score — JSON-LD
   `JobPosting`, known board domains, phrases like "minimum qualifications". The
   page only leaves your browser once that clears a threshold.
2. **Proposes.** On a real posting a card appears top-right with the role, the
   company, and *what it would change and why*:
   ```
   3 change(s):
     b_edu_coursework → v_systems   (systems, infrastructure, distributed systems)
     b_ec_pipeline    → v_kafka     (kafka, streaming)
     b_ec_testing     → v_ci        (infrastructure)
   ```
   Every swap names the evidence. Nothing changes invisibly.
3. **Compiles.** One click builds the real PDF through the local server and
   reports whether it fits on one page.
4. **Takes redirection.** A text box takes instructions in your own words —
   "lead with the distributed systems work" — and re-tailors.
5. **Files it.** "Save application folder" writes a folder with the PDF already
   named `Your Name Resume Company.pdf`, snapshots exactly what was sent, and
   records the application in the tracker.
6. **Fills the form.** Autofill from your stored profile, and saved answers
   offered on questions it recognises.

---

## Install

The extension is unpacked; there is no build step.

1. Start the store server:
   ```bash
   cd ../ResumeM-M && npm run serve
   ```
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → select this folder.
4. Click the toolbar icon. It should say *Connected — N resume(s) in the store.*

---

## Settings

From the toolbar popup:

| Setting | Default | Notes |
| --- | --- | --- |
| Server | `http://127.0.0.1:4600` | Where ResumeM-M is listening |
| Start resumes from | `newgrad` | Tailored resumes inherit from this, so later edits still reach them |
| Offer automatically | on | Off makes the card appear only when you ask |
| Also ask the AI CLI | **off** | Tag matching is instant, free, and usually right |
| Mute this site | — | Per-host, for a careers page you browse but do not apply on |

---

## Tailoring is conservative on purpose

The default path uses **no AI at all**. It scores each phrasing you already
wrote against keywords in the posting, using the `tags` in your store, and only
swaps when one phrasing beats the current choice by a clear margin. That means
it works offline, costs nothing, and cannot invent anything — the words are all
yours already.

Two rules are enforced regardless of what any model suggests:

- **A posting can never change your graduation date.** Date fields are excluded
  from keyword matching entirely. A job description's vocabulary must not be
  able to alter a fact about you.
- **Variants tagged `short` are never auto-selected.** Those exist for fitting
  a page, not for matching a posting.

Turning on the AI pass adds suggestions for *new* phrasings, capped at three,
each with a stated justification. They are never applied automatically: you add
them to the store one at a time, and they are stored marked as unreviewed.

---

## Autofill

Fills only fields it is confident about, matching on labels, `aria-label`,
`name`, `id`, and nearby text — Greenhouse, Lever, Ashby, and Workable all hide
the label somewhere different. It:

- **never overwrites** anything already typed,
- **never guesses on a dropdown** — an option has to plainly match,
- **reports what it skipped**, so "done" is distinguishable from "done wrong".

Long-form questions are *offered*, not injected: a matching saved answer appears
as a placeholder and is inserted when you focus the box, because an essay answer
should be read before it goes out under your name.

---

## Layout

```
manifest.json               MV3
src/background/             Owns every call to the local server
src/content/content.js      Detection, orchestration
src/content/card.js         The corner card (shadow DOM)
src/content/autofill.js     Form filling and question matching
src/popup/                  Settings and connection status
tests/e2e.mjs               Loads the extension in Chromium, drives the flow
```

The card lives in a shadow root, so no job board's stylesheet can reach it and
nothing it does leaks back onto the page. Content scripts never talk to the
server directly — requests are routed through the service worker, which keeps
loopback traffic out of the page's reach and gives one place to report a server
that is not running.

---

## Tests

```bash
npm install
cd ../ResumeM-M && npm run serve   # in another terminal
npm run test:e2e
```

The test drives a **real** server and cleans up the application and generated
resume it creates. To keep your own store untouched entirely, point the server
at a scratch copy first:

```bash
cp -r data /tmp/rmm-test-store
RMM_DATA=/tmp/rmm-test-store npm run serve
```

Loads the unpacked extension into Chromium, serves a fake Greenhouse-style
posting, and drives the whole path: detect → tailor → compile → autofill →
bundle → track, plus a check that it stays silent on a page about bread.

```
14/14 checks passed
```

---

## Permissions

| Permission | Why |
| --- | --- |
| `<all_urls>` content script | A posting can be on any domain |
| `http://127.0.0.1/*` | Reaching your local ResumeM-M server |
| `storage` | Settings |
| `activeTab`, `tabs`, `scripting` | Acting on the page you are looking at |

Page content is sent to `127.0.0.1` only, and only after the local score says
the page looks like a job posting. Nothing is sent anywhere else.
