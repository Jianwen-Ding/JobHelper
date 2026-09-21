/**
 * Sites this tool has no business offering on, decided from the address.
 *
 * Everything else in the detector reads the page, and on the sites below that
 * is the problem rather than the solution. A thread on r/csMajors about
 * internship offers contains "internship", "new grad", "full-time",
 * "requirements" and "benefits" in the first screen; a LinkedIn-style feed of
 * people announcing jobs contains all of that and "we're looking for" as well.
 * They read exactly like a posting because they are *about* postings, and no
 * amount of reading the words more carefully separates the two — the
 * difference is not in the text, it is in where you are.
 *
 * So the address gets a say. Being on one of these hosts is not a penalty
 * applied to a score, it is an answer: nothing is offered here, and nothing is
 * sent anywhere to be classified either.
 *
 * Three things this is careful about.
 *
 * It is not the muted-host list. That one is the user's, it is per-host, and
 * they add and remove from it by answering the chip or pressing the button in
 * the popup. This one ships with the extension and is about the handful of
 * sites nobody would ever want an offer on.
 *
 * It leaves off the one network that is also a job board. LinkedIn is a
 * network by any definition and also one of the largest job boards in the
 * world, and the page you are on there is as likely to be a posting as
 * anything on Greenhouse; it stays off this list entirely.
 *
 * Facebook and X are on it, and that is a judgement rather than an oversight:
 * both carry real postings, and both carry a thousand times as many posts
 * *about* jobs, so an offer made without being asked is nearly always wrong
 * there. The same reasoning as Reddit, which is the one the user reported.
 * The rest are here because the postings on them are incidental and the false
 * positives are constant.
 *
 * And it is never the last word. Pressing the extension's own button forces a
 * look at whatever is in front of you, on any site, because the user asking
 * outranks a list written months ago — a "who is hiring" thread is a real
 * thing and this is not going to pretend otherwise. It only decides what
 * happens *without* being asked.
 */

/**
 * Matched against the host and every parent of it, so `old.reddit.com` and
 * `m.facebook.com` are covered by the bare name without a wildcard each.
 */
export const NEVER_OFFER = [
  // Social networks and feeds.
  'reddit.com',
  'facebook.com',
  'instagram.com',
  'threads.net',
  'threads.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'snapchat.com',
  'pinterest.com',
  'tumblr.com',
  'bsky.app',
  'vk.com',
  'weibo.com',
  'quora.com',
  'nextdoor.com',

  // Chat and voice, where a posting is something somebody pasted.
  'discord.com',
  'slack.com',
  'telegram.org',
  'whatsapp.com',
  'messenger.com',
  'teams.microsoft.com',

  // Video and images.
  'youtube.com',
  'twitch.tv',
  'vimeo.com',
  'imgur.com',
  'giphy.com',

  // Reference and shopping, which score on vocabulary and never on substance.
  'wikipedia.org',
  'amazon.com',
  'ebay.com',
  'etsy.com',
];

/** The host of a url, or '' for anything that is not one. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Whether `host` is `name` or a subdomain of it.
 *
 * Written out rather than done with `endsWith`, which says yes to
 * `notreddit.com` for `reddit.com` — a check that is wrong in the direction
 * of silence is the one kind this must not be.
 */
export function under(host, name) {
  return host === name || host.endsWith(`.${name}`);
}

/** Whether nothing should be offered on this address unless asked. */
export function neverOffer(url) {
  const host = hostOf(url);
  if (!host) return false;
  return NEVER_OFFER.some((name) => under(host, name));
}
