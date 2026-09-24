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
   `JobPosting`, known board domains, phrases like "minimum qualifications" —
   and then asks whether the page is *about one role*: its title names the
   post, or it declares itself with structured data, or it is the form itself.
   Being on an applicant tracking system is not enough on its own; a board's
   own feed, the page after you press submit, and a careers page with nothing
   open are all on one, and none of them is a job to apply to. The page only
   leaves your browser once that clears a threshold, and never on ResumeM-M's
   own pages.
2. **Proposes.** On a real posting a card appears top-right with the role, the
   company, and *what it would change and why* — each swap shown as the
   sentence you wrote before against the sentence it suggests instead, with the
   tags that matched underneath. Nothing changes invisibly, and nothing is
   written for you: it only chooses between wordings already in your store.
3. **Compiles.** One click builds the real PDF through the local server and
   reports whether it fits on one page.
4. **Takes redirection.** A text box takes instructions in your own words —
   "lead with the distributed systems work" — and re-tailors.
5. **Keeps the application together.** An application is rarely one page: you
   read the description on a careers site and follow "Apply" to a form on a
   different host, which is where the cover letter and the essay questions are.
   Pages are kept as you walk them, per tab, so the form is written from the
   description you have already read.
6. **Says it is holding one.** While an application is open, the toolbar icon
   carries the number of pages read and names the company. That is the part
   that survives wandering off — to the company's About page, to what the job
   pays — where the card correctly does not appear. Clicking it says what is
   held and offers the way back.
7. **Files it.** "Prepare to submit" writes a folder with the files named
   for you rather than for the posting — `Your-Name-Resume.pdf` — snapshots
   exactly what was sent, and records the application as sent. "Open the
   folder" shows what is in it, in a tab, so the upload is a click away rather
   than a path to paste. If the form asked for something the folder does not
   have, it says so rather than calling it complete. Nothing was sent after
   all? One button puts it back.
8. **Notices it anyway.** If you never press that button, JobHelper watches
   for the application going out — the form submitted, or the control that
   sends it pressed — and records it. Rules, not a judgement call, tested
   against three dozen real systems and the controls that only look like one:
   a newsletter box, a draft saved, the similar-jobs rail, "complete
   application later".
9. **Fills the form.** Autofill from your stored profile, and saved answers
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
| Start resumes from | `newgrad` | Each tailored resume starts as a copy of this; later edits to it do not reach copies already made |
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
src/shared/trail.js         What counts as one application across pages
tests/                      Playwright harnesses; see Tests below
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
npm test
```

Every harness drives a **real** server and a real Chromium with the unpacked
extension loaded, and each cleans up the applications and resumes it creates.
To keep your own store untouched entirely, point a server at a scratch copy and
tell the tests where it is:

```bash
# in the ResumeM-M checkout
RMM_DATA=/tmp/rmm-test-store PORT=4788 npm run serve
# here
RMM_SERVER=http://127.0.0.1:4788 npm test
```

`RMM_SERVER` reaches the extension too, not only the harness's own requests, so
the card under test talks to the scratch store rather than to whatever is on
the default port.

### Several at a time

`npm test` runs the suites through `tests/run.mjs`, which will run them
concurrently if you give it more than one server. They are serial by default
for exactly one reason — they share a store, and several of them check it was
left as they found it — so parallelism means one store each:

```bash
# in the ResumeM-M checkout, one server per copy
for p in 4788 4789 4790; do
  cp -r /path/to/store /tmp/store-$p
  node dist/src/cli.js serve --port $p --data /tmp/store-$p &
done
# here
RMM_SERVERS=http://127.0.0.1:4788,http://127.0.0.1:4789,http://127.0.0.1:4790 npm test
```

Three servers takes the whole suite from about seven minutes to about three and a half.
The default worker count is one per two cores, capped by the size of the pool,
because headless Chromium is not cheap and this suite's assertions are about
timing — loading the machine past its cores turns them into flakes, and a
flaky suite is not a faster one. `JH_JOBS=1` puts it back to serial, and
`--only e2e,card` runs a subset:

```bash
npm test -- --only e2e,card
```

| Harness | What it walks |
| --- | --- |
| `test:parse` | Whether every source still parses as the module Chrome loads |
| `test:trail` | Which pages belong to one application, in isolation |
| `test:ats` | Classifying the shapes real boards serve |
| `test:autofill` | Filling forms, including comboboxes, shadow roots and frames |
| `test:ats-forms` | Autofill against seventeen systems' real form markup |
| `test:ats-journey` | The whole path — detect, build, fill, file — on each of them |
| `test:card` | Typing in the card while it repaints under you |
| `test:quiet` | False positives: pages that must get no card at all, fast store and slow |
| `test:joins` | Two postings open at once staying two |
| `test:e2e` | Detect → tailor → compile → autofill → file → track |
| `test:nav` | Getting to the form, on every route real systems use |
| `test:carrying` | Wandering off mid-application and coming back |
| `test:adverse` | Tab closed mid-letter, store gone, store slow, worker killed |
| `test:journey` | The same walk on every shape of posting, with timings |

`test:serial` runs the same list one after another without the runner, for
when you want the output in order rather than in blocks.

`node tests/shots.mjs` photographs every state of both products into
`/tmp/shots` — including the empty, busy, error and overflow ones that are easy
to build and never look at. Looking at that output is how several of the bugs these harnesses now guard against were found in the first place.

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
