/**
 * "Is this a job posting?" — asking, instead of guessing and being wrong.
 *
 * The card used to appear on its own wherever the page scored well enough and
 * the server agreed it was a posting. On the pages this tool exists for that
 * is exactly right and nothing here changes it: a page carrying structured
 * JobPosting data, or one whose own title names a role, gets the card at once
 * as it always did.
 *
 * Everything else was a guess, and the guesses were the problem. A thread on
 * a forum about internship offers contains "internship", "new grad",
 * "full-time", "requirements" and "benefits" in the first screen, because it
 * is *about* postings; so does a careers article, a salary page, a
 * confirmation page. Reading the words harder does not separate those from a
 * posting, and every attempt to move the threshold traded one complaint for
 * the other — a card on a forum, or no card on a real job.
 *
 * So the guess is put to the person who can answer it in a quarter of a
 * second. This is smaller than the card, it makes no claims, it sends nothing
 * anywhere, and it costs one glance to ignore. It appears in more places than
 * the card ever did, which is the point: a chip on a page that is not a job is
 * nothing, where a card on one is an interruption.
 *
 * Yes runs the whole pass, exactly as pressing the toolbar button does.
 *
 * No is not a dismissal. It says this site is not one to offer on, and it is
 * recorded as such — the same muted-host list the popup's button writes, so
 * there is one place to see it and one place to undo it, and answering yes
 * here again later takes the site back off it. A site you say no to once is
 * usually a site you would say no to every day.
 *
 * And "not now" is neither, because the two-answer version is a trap: on a job
 * board you use daily, the only way to get the chip off today's page would be
 * to tell the extension to stop working there.
 */

const HOST_ID = 'jobhelper-ask-host';

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }

.ask {
  --accent: #1a73e8;
  --accent-hover: #1967d2;
  --ink: #202124;
  --muted: #5f6368;
  --line: #dadce0;
  --state-hover: rgba(60, 64, 67, .08);

  position: fixed;
  top: 14px;
  right: 14px;
  max-width: calc(100vw - 28px);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 8px 8px 14px;
  background: #fff;
  color: var(--ink);
  border: 1px solid var(--line);
  border-radius: 999px;
  box-shadow: 0 1px 2px 0 rgba(60, 64, 67, .30), 0 2px 6px 2px rgba(60, 64, 67, .15);
  font: 13px/1.4 "Google Sans Text", "Google Sans", Roboto, -apple-system,
        BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  z-index: 2147483647;
}

.what { white-space: nowrap; }

button {
  font: inherit;
  border-radius: 999px;
  cursor: pointer;
  padding: 5px 14px;
  border: 1px solid var(--line);
  background: #fff;
  color: var(--accent);
  white-space: nowrap;
}
button:hover { background: var(--state-hover); }
button.yes {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
button.yes:hover { background: var(--accent-hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

button.later {
  border: 0;
  padding: 4px 8px;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
}
`;

export function removeAsk() {
  document.getElementById(HOST_ID)?.remove();
}

/**
 * Put the chip up. Every handler takes it down first, so none of them has to
 * remember to.
 *
 * @param {object} opts
 * @param {string} opts.site The host, named in the "no" button's tooltip so
 *   what is about to be recorded is legible before it is pressed.
 * @param {() => void} opts.onYes
 * @param {() => void} opts.onNo
 * @param {() => void} [opts.onLater]
 */
export function createAsk({ site, onYes, onNo, onLater }) {
  removeAsk();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.append(Object.assign(document.createElement('style'), { textContent: STYLE }));

  const chip = document.createElement('div');
  chip.className = 'ask';
  root.append(chip);

  const answer = (fn) => () => {
    removeAsk();
    fn?.();
  };

  const what = document.createElement('span');
  what.className = 'what';
  what.textContent = 'Job posting?';
  chip.append(what);

  const yes = document.createElement('button');
  yes.className = 'yes';
  yes.textContent = 'Yes';
  yes.title = 'Read this page and offer a resume for it.';
  yes.onclick = answer(onYes);
  chip.append(yes);

  const no = document.createElement('button');
  no.className = 'no';
  no.textContent = 'No';
  // Says what it does before it is pressed, because what it does outlives the
  // page: the popup's "Mute this site" button is the same switch, and is
  // where it can be seen and turned back off.
  no.title = site ? `Not a job site — stop offering on ${site}.` : 'Stop offering on this site.';
  no.onclick = answer(onNo);
  chip.append(no);

  const later = document.createElement('button');
  later.className = 'later';
  later.textContent = '×';
  later.title = 'Not now. Leaves the site alone.';
  later.setAttribute('aria-label', 'Not now');
  later.onclick = answer(onLater);
  chip.append(later);

  document.documentElement.append(host);
  return { remove: removeAsk };
}
