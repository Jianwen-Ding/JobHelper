/**
 * Fills an application form from the profile already stored in ResumeM-M.
 *
 * Deliberately conservative: it only fills fields it is confident about, never
 * overwrites something already typed, and always reports what it touched. A
 * form filled wrongly costs more than a form filled by hand.
 */

/*
 * The privacy rule lives on its own, away from everything that reads a form,
 * because it is the part that has to be reviewable without reading this file.
 */
import {
  dependsOnEmployer,
  mayRememberTyped,
  neverRemember,
  worthRemembering,
  worthRememberingTyped,
} from '../shared/remembering.js';

/** Map a stored profile key to the label/name patterns that mean it. */
const FIELD_PATTERNS = [
  /*
   * The name somebody goes by, above every other name, because "Preferred
   * first name" says "first name" whole. It used to be left out entirely:
   * matched as `first_name` it was given the legal name — the one answer the
   * box is there to be different from — and "Jay" typed there last time could
   * never come back. The store now sends the name the resume prints as these
   * keys, and only when it differs from the legal one; with none, the box is
   * still the person's and the answer they gave last time fills it. See
   * `typedBox` and `NAME_FOR_THE_FORM`.
   */
  /*
   * Both halves of it in one box, above the first half alone, as `full_name`
   * is below. Zoox's Lever form asks "What is your preferred first name and
   * last name?", and "preferred first name" claimed it for the first name.
   */
  ['preferred_name', /\b(preferred|chosen)[\s_-]*first[\s_-]*(name[\s_-]*)?(and|&|\+)[\s_-]*last[\s_-]*name\b/i],
  ['preferred_first_name', /\b(preferred|nick|chosen)[\s_-]*(first|given)[\s_-]*name\b/i],
  ['preferred_last_name', /\b(preferred|chosen)[\s_-]*(last|family|sur)[\s_-]*name\b/i],
  ['preferred_middle_name', /\b(preferred|chosen)[\s_-]*middle[\s_-]*name\b/i],
  /*
   * And "the name you'd prefer", which is how GitLab's Greenhouse board asks
   * it: "What's the name you'd prefer us to use throughout the interview
   * process?". Measured live, it matched nothing, so the box stayed empty and
   * First and Last Name beside it were given the preferred name.
   */
  ['preferred_name', /\b(preferred|nick|chosen)[\s_-]*(full[\s_-]*)?name\b|\bgo(?:es)?[\s_-]+by\b|\bname[\s_-]+(?:that[\s_-]+)?you(?:['’]d|[\s_-]+would)?[\s_-]+prefer\b/i],
  /*
   * Both halves in one box, above either half, because the first pattern to
   * match claims the field: "First and Last Name" says "Last Name" whole and
   * was given the surname alone, and "First Name and Last Name" the first
   * name alone — half a name, in a box asking for all of it.
   */
  ['full_name', /\bfirst[\s_-]*(name[\s_-]*)?(and|&|\+)[\s_-]*last[\s_-]*name\b/i],
  /*
   * And one half of it, said in brackets after the name it is part of — above
   * `legal name`, which claimed the box whole. "Legal name (First)" and "Legal
   * name (Last)" were each given "Morgan Testwell", and "Legal name (Middle)" the
   * whole name too, a middle name the profile does not hold. Only a bracket
   * holding the one word: "Full legal name (first, middle, last)" asks for
   * all of it. `middle_name` is never in a profile, so that box stays blank.
   */
  ['first_name', /\bname[\s_-]*\([\s_-]*(first|given)([\s_-]*name)?[\s_-]*\)/i],
  ['last_name', /\bname[\s_-]*\([\s_-]*(last|family|surname)([\s_-]*name)?[\s_-]*\)/i],
  ['middle_name', /\bname[\s_-]*\([\s_-]*middle([\s_-]*name)?[\s_-]*\)/i],
  ['first_name', /\b(first[\s_-]?name|given[\s_-]?name|forename|fname)\b/i],
  ['last_name', /\b(last[\s_-]?name|family[\s_-]?name|surname|lname)\b/i],
  /*
   * Not the full name *of* something. Datadog's Greenhouse board asks "Please
   * share the full name of your major/final year specialization(s) as it
   * would appear on your diploma", and it was given "Morgan Testwell" —
   * measured live, a person's name typed in as their degree subject. A name
   * followed by "of your", "of the" or "of this" is a thing's name: the
   * subject, the school, the company's legal name. Left to the patterns below,
   * which read "major" in it and give the subject, and otherwise to nothing.
   */
  ['full_name', /\b(full[\s_-]?name|your[\s_-]?name|candidate[\s_-]?name|legal[\s_-]?name)\b(?![\s_-]+of[\s_-]+(?:your|the|this|that|each|any|a|an)\b)/i],
  ['email', /\b(e-?mail)\b/i],
  /*
   * "Number" on its own is far too broad — requisition number, employee
   * number, number of years of experience — but the enterprise systems rarely
   * say "phone" at all: Taleo asks for a "Primary Number", and its siblings
   * are "Home Number" and "Mobile Number". So it counts only behind a word
   * that makes it a telephone.
   */
  ['phone', /\b(phone|mobile|telephone|cell)\b|\b(primary|contact|day(?:time)?|home|work|alternate)[\s_-]*number\b/i],
  ['linkedin', /\b(linked-?in)\b/i],
  ['github', /\b(git-?hub)\b/i],
  ['website', /\b(website|portfolio|personal[\s_-]?site|homepage)\b/i],
  /*
   * The job somebody holds now. Only with "current", "present" or "most
   * recent" in front: a bare "Company" is a row of a job-history section,
   * which asks about every job in turn and is not this question. Lever's is
   * `name="org"` with "Current company" as its only label, and it read as
   * nothing at all.
   */
  /*
   * And a bracket closed between them: Reddit's Greenhouse board asks "Please
   * provide the name of your current (or most recent) company", and ")"
   * stood between "recent" and "company". See `mostRecentJob` for what a
   * question saying "most recent" is given.
   */
  ['current_company', /\b(current|present|most[\s_-]*recent)\)?[\s_-]*(company|employer|organi[sz]ation|org)\b/i],
  ['current_title', /\b(current|present|most[\s_-]*recent)\)?[\s_-]*(job[\s_-]*)?(title|role|position)\b/i],
  /*
   * When the degree ends. Above school and degree on purpose: the first
   * pattern to match claims the field, and "Graduation date from your
   * university" or "Expected degree completion" would otherwise be taken as
   * the school's name or the degree's.
   *
   * Month and year before the date, because "Expected graduation year" is
   * asking for the year alone. Nothing here fires on a bare "graduate" — "Are
   * you a recent graduate?" is a yes/no question, and a date is not its answer.
   */
  ['graduation_month', /(\bgrad\b|\bgraduat\w*|\bcompletion\b).{0,40}\bmonth\b|\bmonth\b.{0,40}\bgraduat/i],
  // "Class of" and "Graduating class" are asking for the year, as "Class year" is.
  /*
   * And "What year will you complete your degree?", which is Okta's Greenhouse
   * board's: it says neither "graduate" nor "completion", fell through to
   * `degree`, and — measured live — was reported as a degree with no
   * matching option in a list of years. Only with the degree named after the
   * verb: "the year you completed the course" is not a graduation.
   */
  ['graduation_year', /(\bgrad\b|\bgraduat\w*|\bcompletion\b).{0,40}\byear\b|\byear\b.{0,40}\bgraduat|\byear\b.{0,40}\bcomplete\b.{0,20}\b(degree|studies|bachelor\w*|master\w*|program(me)?)\b|\bclass\s*year\b|\bclass\s+of\b|\bgraduating\s+class\b/i],
  /*
   * And the date by the words that name the degree's end without saying
   * "graduation": "Expected degree completion" was the example above and no
   * pattern here knew it, so it fell through to `degree` and was given the
   * degree's name. A completion date of anything else — a project, a course —
   * is left alone.
   */
  [
    'graduation_date',
    /\bgrad(uation)?\s*date\b|\bdate\s*of\s*graduation\b|\b(expected|anticipated)\s*grad(uation)?\b|\bwhen\s+(do|will)\s+you\s+(expect\s+to\s+)?graduate\b|\bdegree\s+(completion|conferral|end)\b|\b(end|completion)\s*date\b.{0,20}\bgrad(uat\w*)?\b/i,
  ],
  /*
   * And when it began, asked on its own outside an Education block: "Start
   * date of your degree", "Education start date". With no pattern for it,
   * the first fell through to `degree` and a date picker was given "Bachelor
   * of Science". Only with the schooling named — a bare "Start date" is when
   * somebody can start the job.
   */
  [
    'education_start_date',
    /\b(start|begin|beginning|commencement)\s*(date|month)?\b.{0,30}\b(degree|education|studies|university|college|program(me)?)\b|\b(degree|education|studies|university|college|program(me)?)\s+(start|begin|beginning)\s*date\b/i,
  ],
  /*
   * The grade and the subject above the school, for the reason graduation is:
   * "College GPA" and "University major" name the institution, and with
   * `school` first they were filled with its name.
   */
  ['gpa', /\bgpa\b/i],
  /*
   * What the degree is in, however it is put: "Field of degree", "Degree
   * field" and "Subject of degree" fell through to `degree` and were given
   * "Bachelor of Science" in a box asking for the subject.
   */
  [
    'major',
    /\b(major|discipline|field[\s_-]?of[\s_-]?study|(course|area)[\s_-]?of[\s_-]?study|(field|subject)[\s_-]+of[\s_-]+(your[\s_-]+)?degree|degree[\s_-]+(field|subject))\b/i,
  ],
  ['school', /\b(school|university|college|institution|institute)\b/i],
  /*
   * And the level it is at, asked without the word: BambooHR's "Highest
   * Education Obtained" lists "College - Bachelor of Science" among its
   * levels, and was left on "–Select–". Not a label asking when, though: a
   * date, a year or a month is never the degree's name.
   */
  ['degree', /^(?![\s\S]*(?<!-)\b(date|year|month)\b)[\s\S]*(\bdegree\b|\bhighest[\s_-]+(level[\s_-]+of[\s_-]+)?education\b|\beducation(al)?[\s_-]+level\b|\blevel[\s_-]+of[\s_-]+education\b)/i],
  /*
   * The two declarations above every address field. "Are you authorized to
   * work in this country?" is the commonest wording of the right-to-work
   * question, and with `address_country` first it claimed the question: the
   * yes/no pair was offered "United States", matched neither button, and the
   * required question was left blank. No address label says "authorized to
   * work" or "sponsor", so nothing moves the other way. "Eligible to work" is
   * the same question and matched nothing.
   */
  /*
   * `\w*` where a stem was truncated. These two read as if they matched
   * anything starting with the stem, and matched nothing at all: a trailing
   * \b after "authoriz" demands a word boundary between "z" and "a", so
   * "work authorization" — the words every form actually uses — never matched,
   * and neither did "sponsorship".
   */
  /*
   * `authoriz\w+ to work` as well, because that is how the question is put
   * when it is not put as two nouns: "Are you authorized to work in the US for
   * any employer?" is the commonest phrasing on the hosted boards and matched
   * none of the three above — the required question came out blank and, having
   * matched no key at all, was not reported either. The conjunction with
   * sponsorship is still refused; see `asksBothAtOnce`.
   *
   * And "for employment" where the same question says "to work": "Are you
   * currently eligible for employment in the US?" matched nothing, so the
   * required question was neither answered nor reported.
   *
   * And spelled with an "s", as the European boards spell it. Datadog's
   * Greenhouse board asks "Are you legally authorised to work full-time in the
   * country where this job is based?", which matched none of these, fell
   * through to `address_country` on the word "country", and was reported —
   * measured live — as a country still to be picked by hand from a Yes/No
   * list. The rest of this file already reads both spellings of the answer.
   */
  [
    'work_authorization',
    /\b(work[\s_-]?authori[sz]\w*|legally[\s_-]?authori[sz]ed|(authori[sz]|eligib)\w*[\s_-]+(to[\s_-]+work|for[\s_-]+employment)|right[\s_-]?to[\s_-]?work)\b/i,
  ],
  ['requires_sponsorship', /\b(sponsor\w*|visa[\s_-]?status)\b/i],
  /*
   * Whether the applicant lives in a country the question names — a yes or a
   * no that the profile's own country answers. Asked on three systems in the
   * sweep and answered on none, because no pattern read it: Discord's
   * Greenhouse board ("Are you currently located in the US?"), JumpCloud's
   * Lever form ("Do you currently live in the United States of America?")
   * and Prometheum's JazzHR form ("Do you currently reside in the United
   * States or Canada?"), each required, each measured live left blank and
   * unreported. Only with a country named, and only "Yes" for the profile's
   * own — see `aboutAnotherCountry` — so "Are you located in the Bay Area?"
   * is not read at all and a question about another country is handed back.
   * Below the right to work and sponsorship, which claim a question that
   * mentions residence too; above the address, which would otherwise read
   * "United States" in it as a country to fill in.
   */
  [
    'lives_in_country',
    /\b(?:do|are)\s+you\s+(?:currently\s+|presently\s+|now\s+)?(?:live|living|reside|residing|located|based)\s+(?:in|within)\s+(?:the\s+)?(?:US|USA|U\.S\.(?:A\.)?|United\s+States|America|Canada|UK|U\.K\.|United\s+Kingdom)(?![\w.])/i,
  ],
  /*
   * Both in one box, above the city, which claimed it: "City, State" and
   * "City/State" were given "Boston" on a profile that also holds "MA". See
   * `withCityAndState` for where the value comes from.
   */
  ['city_state', /\b(city|town)[\s_-]*(,|\/|&|and)[\s_-]*(state|province)\b/i],
  ['address_city', /\b(city|town)\b/i],
  /*
   * Country before state, because the first pattern to match wins and
   * "Country/Region" — which is what SuccessFactors, Workday and most of the
   * enterprise systems call the field — matches `region`. It was being filled
   * with a state, finding no such option, and reporting that the country had
   * no matching option while leaving a required field empty.
   */
  ['address_country', /\b(country)\b/i],
  /*
   * "State" the noun, not the verb: "Please state your reason for applying"
   * is a free-text question, and it was typed over with the applicant's state.
   */
  [
    'address_state',
    /(?<!\bplease[\s_-]+)\b(state|province|region)\b(?![\s_-]+(?:your|why|how|what|whether|if|the|any|briefly|clearly|below)\b)/i,
  ],
  /*
   * "Where are you located?", "Where do you live?" and "Where do you
   * currently reside?" are how custom questions ask for this, and only
   * "Where are you based?" matched. Asked of the applicant as they are now:
   * "Where would you like to be located?" is a preference, and stays blank.
   */
  [
    'location',
    /\b(location|where.*based)\b|\bwhere\s+(?:are|do)\s+you\s+(?:currently\s+)?(?:located|live|living|reside|residing)\b/i,
  ],
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/*
 * Which part of an address a field asks for, by its label where the label
 * says.
 *
 * A field is read by its label together with its name and id, which is what
 * lets a box with no label be read at all. Between the parts of an address
 * that reads the wrong one: Workday names its state box
 * `address--countryRegion`, so the box labelled "State" matched `country` —
 * which sits above state for "Country/Region" — was taken for a country
 * question already answered, and the state was never chosen. Only between
 * these three, because elsewhere the name is exactly what settles a vague
 * label: "Name" over `company_name` is not the applicant's name.
 */
const ADDRESS_PARTS = new Set(['address_country', 'address_state', 'address_city']);
function addressPartByLabel(label, key) {
  if (!ADDRESS_PARTS.has(key)) return key;
  const said = FIELD_PATTERNS.find(([, re]) => re.test(label ?? ''))?.[0];
  return said && ADDRESS_PARTS.has(said) ? said : key;
}

/**
 * Fields that carry one of the patterns above and are not about the applicant.
 *
 * Every one of these was measured: with a profile loaded, "Reference 1 email"
 * was filled with the applicant's own address, "Emergency contact number" and
 * "Reference 1 phone" with their own telephone number, "Reference 1 full name"
 * with their own name, and "Where did you hear about this job? (LinkedIn,
 * Indeed, referral)" with their LinkedIn URL. Each is a wrong answer rather
 * than a missing one — a referee who is really the candidate, an emergency
 * contact who is the person having the emergency — and the card counted them
 * as fields successfully filled.
 *
 * Citizenship is the same mistake about a different thing: `address_country`
 * is where the applicant lives, and "Country of citizenship" was being filled
 * from it. Someone living in the United States on a visa was having their
 * application state that they are a US citizen. Birth is a third question
 * with the same answers again — "Country of Birth", "City of Birth" and
 * "State/Province of Birth" were being filled with where the applicant lives
 * now, which for anyone who has moved country is simply false, and false on
 * the part of the form an employer passes to an immigration lawyer.
 *
 * Salary matches nothing here today. It is listed because the cost of that
 * changing is a lie about money, and the cost of naming it now is a line of
 * regex. The self-identification line is not in that position: a signature
 * box on a voluntary EEO or disability form is labelled "Your Name", which
 * `full_name` matches, so the applicant's legal name was being typed onto the
 * signature line of a form they had not chosen to complete.
 */
const NOT_ABOUT_YOU = [
  /*
   * Somebody else's name, telephone number or address.
   *
   * The people a form asks about were a short list, and the rest of them got
   * the applicant: "Referrer's email", "Recruiter email" and "Professor's
   * email" were filled with the applicant's own address, "LinkedIn URL of your
   * referrer" with their own profile, and "Parent's phone number" — which the
   * internship forms ask of students — with their own number. The employee
   * who referred you is the commonest of these, and "referral" was already
   * here for how you heard about the job; the person is not.
   *
   * But "referred to as" is what you are called, not who sent you. Asana's
   * Greenhouse board explains its Preferred Full Name box as "The name that
   * you would like to be referred to as". Measured live, the box was left
   * empty as somebody else's name.
   */
  /\b(references?|referee|emergency|next[\s_-]?of[\s_-]?kin|guardian|spouse|supervisor|manager'?s?|recommender|referr(?:er|ers|ing|ed(?![\s_-]+to[\s_-]+as\b))|recruiters?|parents?|professors?|advis[oe]rs?)\b/i,
  /*
   * A previous employer's address, which the employment-history sections of
   * Taleo and BrassRing ask for field by field. "Employer City" matched
   * `address_city` and was filled with the applicant's own town.
   *
   * `location` and `email` were missing from the list, and "Employer
   * Location" is what Workday, Greenhouse and iCIMS all call that field —
   * one line per past job, filled in with the applicant's own current city as
   * a stated fact about where somebody else's office was. Exactly the case
   * above, on the word those three happen to use.
   */
  /*
   * Its website too: "Company website" is on the same line of the same
   * section, and `website` gave it the applicant's own site.
   */
  /*
   * Its name as well, except where the question opens by saying it is the
   * current one. "Current Company Name" is how Greenhouse's custom questions
   * and plenty of hand-built forms ask `current_company`, and "company name"
   * inside it made it a past employer's: left blank, where "Current company"
   * two lines up on another form was filled. Measured: "Current Company
   * Name", "Current employer's name", "Most recent employer name" and
   * "Present company name" all came out empty.
   *
   * Only at the very start, not merely with "current" in front. "Not your
   * current company name, the one before it" has "current" directly in front
   * too, and asks for somebody else's; a legend such as "Employment history"
   * comes first in what this is tested against, so a row under one stays a
   * past job's; and a name attribute like `companyName` is another "company
   * name" further on, which still excludes. Every doubt leaves it blank. The
   * rest of the list — the employer's address, location, phone — is
   * somebody else's however current they are.
   *
   * "Current/Most Recent Company Name" opens the same way, twice over, and is
   * how Ashby boards ask it: measured live on Vanta's, where it was excluded
   * as a past employer's and left blank. So a "current" may be followed by
   * "/ most recent" or "(or most recent)" before the name.
   */
  /\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+(address|location|city|town|state|province|country|phone|telephone|email|zip|postal|web[\s_-]?site|url)\b|(?<!^[\W_]*(?:current|present|most[\s_-]*recent)(?:[\s_]*(?:\/|\(?\s*or\b)[\s_]*most[\s_-]*recent\)?)?[\s_-]+)\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+name\b/i,
  /*
   * And the school's, which the education sections of the older systems ask
   * for the same way. `school` sits above every address pattern, so "School
   * city", "School state", "University country" and "What city is your
   * university located in?" were each given the university's *name* — in a
   * box asking where it is.
   */
  /\b(school|university|college|institution)['’]?s?[\s_-]+(address|location|city|town|state|province|country|zip|postal)\b|\b(school|university|college|institution)\b[\s\S]{0,24}\blocated\b/i,
  /*
   * Permission to contact an employer, which is a yes or a no and not the
   * employer's name — "Can we contact your current employer?" took
   * `current_company` — and the employer's own contact, which "Employer
   * contact email" gave the applicant's address.
   */
  /\bcontact\b[\s\S]{0,30}\bemployers?\b|\bemployers?\b[\s\S]{0,20}\bcontact\b/i,
  /*
   * Why somebody left, which is not where they were: "Reason for leaving your
   * most recent employer" would otherwise take the employer's name as its
   * reason. Nothing has been measured filling it — it is here because asking
   * for the most recent employer (see `mostRecentJob`) is what reaches it.
   */
  /\breasons?\b[\s\S]{0,30}\bleav\w*|\bwhy\b[\s\S]{0,20}\bleav\w*/i,
  /*
   * How long, not who. "Years at current company" matched `current_company`
   * and was given the employer's name in a box asking for a number.
   */
  /\b(years?|months?|how[\s_-]long|tenure|duration)\b[\s\S]{0,24}\b(current|present|most[\s_-]recent)\b/i,
  /*
   * And how many, of anything. No profile field is a count, and a count
   * question names what it is counting: "How many years of mobile development
   * experience do you have?" matched `phone` on the word "mobile" and was
   * given the applicant's telephone number, and "How many years of college
   * have you completed?" was given the university's name. Plural "years of"
   * only — "Year of graduation" is a date and is asked for.
   */
  /\bhow[\s_-]+many\b|\byears[\s_-]+of\b/i,
  /*
   * A name the applicant used to have, which is exactly the one the profile
   * does not hold. Background-check sections ask for it field by field:
   * "Previous last name(s)", "Maiden last name" and "Prior surname" were each
   * given the applicant's current surname, and "Former legal name" the whole
   * current name — an answer that says nobody's name ever changed, on the
   * part of the form used to run the check.
   */
  /\b(previous\w*|former\w*|prior|maiden|alias\w*|other|different)\b[\s\S]{0,20}\b(name|surname)s?\b|\b(name|surname)s?\b[\s\S]{0,24}\b(previous\w*|former\w*)\b/i,
  // How to say a name, which is not the name: "Pronunciation of your name".
  /\b(pronunc\w*|phonetic\w*)\b/i,
  /*
   * The password to a link, which is not the link. Design roles ask for a
   * "Portfolio password" beside the portfolio URL, and as a plain text box —
   * `isFillable` only refuses `type=password` — so `website` matched it and
   * the URL was typed in as the password, where the reviewer would try it.
   */
  /\b(password|passcode|pass[\s_-]?phrase)\b/i,
  /*
   * An address at a school, which the profile's one address is not. Harvey's
   * Ashby form for law students asks for a "Personal Email Address" and then
   * a "School Email Address", and measured live, the second was given the
   * personal address too.
   */
  /\b(school|university|college|student|\.edu)['’]?s?[\s_-]*e-?mail\b/i,
  /*
   * A username, which is a part of the link and not the link. "GitHub
   * username", "GitHub handle" and "Username on LinkedIn" matched `github`
   * and `linkedin` and were given the whole profile URL, in a box that will
   * be read as a handle — `https://github.com/...` as somebody's username.
   * Left blank rather than cut out of the URL: a stored link is not always
   * just the profile.
   */
  /\b(git-?hub|git-?lab|linked-?in)\b[\s\S]{0,20}\b(user[\s_-]?names?|handles?|user[\s_-]?ids?)\b|\b(user[\s_-]?names?|handles?)\b[\s\S]{0,20}\b(git-?hub|git-?lab|linked-?in)\b/i,
  /*
   * "Major" the adjective. "Major accomplishment", "Major project" and "Your
   * major achievements" matched `major` and were given the applicant's field
   * of study — "Computer Science" as their greatest achievement. Only in
   * front of the nouns a question puts it before; "Major", "Intended major"
   * and "Major / field of study" are the subject and are still filled.
   * "Nearest major city" and "Closest major metropolitan area" were given it
   * too, as a place.
   */
  /\bmajor[\s_-]+(accomplish\w*|achievements?|projects?|challenges?|contributions?|responsibilit\w*|obstacles?|setbacks?|failures?|mistakes?|decisions?|milestones?|initiatives?|cit(?:y|ies)|metro\w*|airports?)\b/i,
  /*
   * "Degree" the measure. "Degree of proficiency in Spanish" and "To what
   * degree are you familiar with SQL?" matched `degree` and were given
   * "Bachelor of Science" as a level of fluency. "What degree are you
   * pursuing?" asks for the qualification in nearly the same words, so only
   * "degree of" before a word for how much, and "to what degree", are read
   * this way.
   */
  /\bdegree[\s_-]+of[\s_-]+(proficiency|fluency|familiarity|experience|expertise|comfort|confidence|knowledge|skill|understanding|competenc\w*)\b|\bto[\s_-]+(what|which|some|a|any|the)[\s_-]+degree\b/i,
  /*
   * A question about a field, which is not the field. Workday asks "Phone
   * Device Type" beside the number, and "Phone Type", "Type of phone" and
   * "Email type" were given the number and the address; "GPA Scale" was given
   * the grade as its own scale, and "Degree Status" the degree's name.
   */
  /\b(phone|telephone|e-?mail|address)[\s_-]+(device[\s_-]+)?types?\b|\btypes?[\s_-]+of[\s_-]+(phone|telephone|e-?mail|address)\b|\b(gpa|grading)[\s_-]+scale\b|\bdegree[\s_-]+status\b/i,
  /*
   * A second subject, degree or school, which the profile does not hold: it
   * holds one of each. "Second Major", "Double major", "Additional degree",
   * "Major 2" and "School 2" were each given the first again — a second major
   * in the subject already named — and "Previous school" and "Transfer
   * university" the school the applicant is at now, as the one they left.
   * "School 1" is still filled, and so is "School (if other)", which is
   * where the applicant's own school goes when the list does not have it.
   */
  /\b(second|secondary|double|dual|additional|another|2nd|third|3rd)[\s_-]+(majors?|degrees?|concentrations?|schools?|universit\w*|colleges?|institutions?)\b|\b(major|degree|school|university|college|institution)[\s_-]*#?[\s_-]*[2-9]\b|\b(previous\w*|former\w*|prior|past|transfer\w*)[\s_-]+(schools?|universit\w*|colleges?|institutions?|majors?|degrees?)\b/i,
  /*
   * The state that issued a licence, which is not where the applicant lives.
   * Nursing, teaching, pharmacy and driving roles ask for it, and "State of
   * licensure", "License state", "Driver's license issuing state" and
   * "Issuing state" were each given the home state — a statement about a
   * credential the applicant may hold somewhere else, or not at all.
   */
  /\blicen[cs]\w*\b[\s\S]{0,24}\b(state|province|country|jurisdiction)\b|\b(state|province|country|jurisdiction)\b[\s\S]{0,12}\blicen[cs]\w*|\bissu(ing|ed)\b[\s\S]{0,12}\b(state|province|country)\b|\b(state|province|country)\b[\s\S]{0,12}\bof[\s_-]+issu\w*/i,
  /*
   * When to ring, which is not the number to ring. "Best phone interview
   * time", "Best time to reach you by phone" and "Phone screen availability"
   * matched `phone` and were given the telephone number as a time. The
   * interview itself is excluded only where no "number" is asked for, because
   * "Phone number for the phone interview" is the telephone box.
   */
  /\b(best|convenient|preferred|ideal)[\s_-]+times?\b|^(?![\s\S]*\bnumber\b)[\s\S]*\bphone[\s_-]+(interview|screen\w*)\b/i,
  /*
   * A signature, which is the applicant's to give. A name typed into one
   * signs whatever sits above it — that everything on the form is true, an
   * at-will acknowledgement, a release for a background check — and
   * "Type your full name to sign", "E-signature (type your name)", "Full
   * legal name (signature)" and "Full Name" under an "Applicant Signature"
   * legend were each signed with the applicant's name before they had read
   * it. Checkboxes are never ticked for the same reason. "Sign in" and
   * "sign up" are not signing.
   */
  /\b(e-?)?signatures?\b|\be-?sign(ed|ing)?\b|\bsign(ed|ing)?\b(?![\s_-]+(?:in|up|on|out)\b)/i,
  // Where you heard about the job, which is not a profile of yours.
  /\b(did[\s_-]you[\s_-](?:first[\s_-])?hear|hear[\s_-](?:about|of)[\s_-](us|this)|referral)\b/i,
  // Citizenship, birth and residence are different questions with the same
  // answers.
  /\b(citizen\w*|nationality|passport)\b/i,
  /\b(birth|born)\b/i,
  /*
   * A preference about the job, not a fact about the applicant — in either
   * order, because the forms put it both ways: "Preferred Work Location" and
   * "Location Preference" are the same question, and only the first was
   * caught. Both were filled with where the applicant lives, which turns
   * "where I am" into "where I want to be" without being asked.
   */
  /\b(prefer\w*|desired|requested)\b[\s\S]{0,24}\b(location|city|town|country|office|site)\b/i,
  // "Which location are you applying for?" is the same question again.
  /*
   * But not a place named by the job, "the country to which you are
   * applying", which is how the global employers ask the right to work: it
   * matched this rule and was excluded, and an exclusion says nothing, so a
   * required question was left blank with the card silent about it. "The
   * country where this job is located" was always answered.
   */
  /\b(location|city|town|country|office|site)\b(?!\s+(?:(?:to|in|for)\s+which\s+)?you(?:\s+are|'re)\s+applying)[\s\S]{0,24}\b(prefer\w*|desired|requested|applying)\b/i,
  /*
   * Where the job is, which is the employer's to say. "Job location",
   * "Office location", "Work location", "Location of the role" and
   * "Location type" — remote, hybrid or on site — were each given the city
   * the applicant lives in, as though that answered which office they are
   * applying to. "Current location" and a plain "Location" are still theirs.
   */
  /\b(job|office|role|position|work)[\s_-]+locations?\b|\blocations?[\s_-]+(?:of|for)[\s_-]+(?:the|this)[\s_-]+(?:role|job|position|opening)\b|\blocation[\s_-]+type\b/i,
  // Relocation is about somewhere you are not. "Which city would you relocate
  // to?" was answered with the city the applicant already lives in.
  /\brelocat\w*/i,
  /\b(salary|compensation|wage|pay[\s_-]?rate|hourly[\s_-]?rate|bonus)\b/i,
  /\b(gender|race|ethnicit\w*|hispanic|latin[ox]|veteran|disabilit\w*|sexual[\s_-]orientation|pronouns)\b/i,
  /\b(eeoc?|self[\s_-]?identification|equal[\s_-]employment)\b/i,
  /*
   * School before the degree. The profile's education is the newest one, and
   * a "High School" box was being told the applicant went to high school at
   * their university — with "High school GPA" given the university's grade.
   */
  /\b(high|secondary)[\s_-]?school\b/i,
  /*
   * A consent question, which is not a fact about the applicant at all — it
   * is a decision about what the employer may send them.
   *
   * Measured: a group headed "Marketing: may we email you about sponsorship
   * webinars?" was answered "No", from `requires_sponsorship`, because
   * `sponsor\w*` matched the word "sponsorship" in it. That is the visa
   * answer written onto a mailing-list question — and the same shape reaches
   * any of these patterns, because a consent question is free to mention
   * whatever it is consenting about.
   *
   * Two rules rather than one long list of words, and both are deliberately
   * narrow. The nouns are ones no profile field is ever called. The second
   * wants "may we"/"can we" *and* an "about" within a phrase of it, so it
   * catches "may we email you about openings" and not "How can we contact
   * you?", which is the heading over a real email box.
   */
  /\b(marketing|newsletter|mailing[\s_-]?list|promotional?|webinars?|subscribe|unsubscribe|opt[\s_-]?(?:in|out)|communications?[\s_-]?preferences?)\b/i,
  /\b(?:may|can)[\s_-]we\b[\s\S]{0,40}\babout\b/i,
];

/**
 * The box beside a telephone number that wants "+1", not a telephone number.
 *
 * `phone` matched "Phone Country Code" first and wrote the whole number into
 * it; where the word "phone" was absent, `address_country` matched and wrote
 * "United States". Neither is a dialling code, and a telephone number an
 * employer cannot ring is worse than a blank one.
 *
 * Read with the parentheses taken out, and kept out of the list above for
 * that reason alone. A parenthetical is an instruction about how to answer,
 * not a change of subject: "Phone Number (include country code)" is the
 * telephone box — asked for in exactly those words because international
 * applicants are expected to write the `+` — and excluding it left the
 * number, usually a required field, blank with nothing said about it. "Phone
 * Country Code" still reads as the code box, because nothing there is an
 * aside.
 *
 * Only parentheses. "Phone number, including country code" is still read as
 * the code box and still goes unfilled; that shape is rarer, and guessing at
 * where a label stops being its subject is how the first version of this
 * went wrong.
 */
/*
 * And the extension box beside it, which took the whole telephone number the
 * same way. Read with the parentheses out for the same reason: "Phone (ext.
 * optional)" is the telephone box.
 */
const DIALLING_CODE = /\b(country|area|dial(?:l?ing)?)[\s_-]?(?:phone[\s_-]?)?code\b|\bext(?:ension)?\b/i;

/*
 * A label that is only "Country", whatever the field is named underneath.
 *
 * The exclusion above reasons entirely about label wording — every line of
 * its note is about what a label says — and it was being asked of the whole
 * description, which is the label *plus* the name, the id and the
 * placeholder. `[\s_-]?` allows no separator at all, so a `<select
 * name="countryCode">` matched it, and naming a country select for the ISO
 * code it submits is idiomatic. So a required dropdown labelled, plainly,
 * "Country" was dropped as though it had asked for a dialling code — and
 * exclusions report nothing, by design, so it was not in `skipped` either:
 * an empty required field with the card saying nothing about it.
 *
 * The name is still read for every field whose label does not settle it,
 * which is what keeps a `phone_country_code` box with no label out of the
 * applicant's full telephone number.
 */
const PLAIN_COUNTRY = /^\s*country(\s+of\s+(residence|citizenship))?\s*[*:]*\s*$/i;

const asksForADiallingCode = (description, label) =>
  DIALLING_CODE.test(description.replace(/\([^)]*\)/g, ' ')) && !PLAIN_COUNTRY.test(label ?? '');

/**
 * What the form says about a field somewhere other than on the field.
 *
 * Every exclusion above reads `describeField`, which is a field's own label
 * plus its own `name`, `id` and `placeholder`. That is enough whenever the
 * form repeats the disambiguating word onto each box — "Emergency contact
 * number", "Reference 1 email" — and plenty of forms do not. They say it once:
 *
 *   <fieldset>
 *     <legend>Emergency Contact</legend>
 *     <label for="ec_phone">Phone</label><input id="ec_phone" name="q_88214">
 *
 * There the field describes itself as "Phone q 88214", matches the ordinary
 * `phone` pattern, and was filled with the applicant's own number — reported
 * as a field filled, in green, as a fact about the person they would call in
 * an emergency. The same three boxes with the word on each of them were
 * correctly left alone, so the rule held exactly where the markup was kind.
 *
 * The nearest fieldset only, and the nearest labelled group: a legend two
 * levels up is about the section, and a form that wraps everything in one
 * fieldset would otherwise have every field in it excluded by a single word.
 *
 * Used for the exclusions and nowhere else. It never reaches `describeField`,
 * because a legend reading "Contact Information" over an ordinary email box
 * is context for whether the box is yours and not evidence about which field
 * it is — and anything that matched before has to go on matching.
 */
function surroundingWords(input) {
  const said = [];
  // Out of the components the field is drawn in: see `closestAround`.
  const legend = clean(closestAround(input, 'fieldset')?.querySelector('legend')?.textContent);
  if (legend) said.push(legend);

  const group = closestAround(input, '[role="group"], [role="radiogroup"]');
  if (group) {
    const named = clean(group.getAttribute('aria-label')) || clean(fromLabelledBy(group));
    if (named) said.push(named);
  }
  return clean(said.join(' ')).slice(0, 200);
}

/**
 * `around` is joined to the description rather than tested beside it, because
 * the two halves of a phrase can be on either side of the boundary: the
 * employment-history rule wants "Employer" next to "Location", and a form
 * that puts the first in the legend and the second on the label has written
 * the same question as one that puts both on the label.
 */
/*
 * A place or a telephone asked inside a past job, or inside the education
 * section, is that job's or that school's.
 *
 * The employer and school rules above want the owner and the place in one
 * phrase — "Employer city", "School state" — and a form that asks a section
 * at a time says the owner once, on the group: a fieldset whose legend is
 * "Work Experience 1", a group labelled "Employment History" or "Education",
 * and inside it plain "Location", "City", "State", "Country" and "Phone".
 * Measured: every one of those was given the applicant's own home and
 * number, a statement about where somebody else's office or campus is, once
 * per row of the history. "School" under "Education" and "City" under
 * "Contact Information" are still filled.
 *
 * The section is read from the group's name alone, never from the field's
 * own words, so "Email (your education address is fine)" on an ordinary box
 * is still the applicant's.
 */
const HISTORY_GROUP = /\b(work|employment|professional|job|career)[\s_-]+(experience|history)\b|\beducation\w*\b/i;
const A_PLACE_OR_LINE = /\b(location|city|town|state|province|region|country|address|zip|postal|phone|telephone|mobile|e-?mail)\b/i;

/*
 * `section` is a heading the markup bounds — see `boundedSection` — and it is
 * read by the history rule alone. A heading is weaker evidence than a legend
 * or a labelled group, so it is not joined to `around` for the rest of the
 * list; and the history rule leaves a box blank, which is the safe way for a
 * guess about sections to be wrong.
 */
const isNotAboutYou = (description, label, around = '', section = '') => {
  const about = around ? `${around} ${description}` : description;
  return (
    asksForADiallingCode(description, label) ||
    NOT_ABOUT_YOU.some((re) => re.test(about)) ||
    ((HISTORY_GROUP.test(around) || HISTORY_GROUP.test(section)) && A_PLACE_OR_LINE.test(description))
  );
};

/*
 * "Are you legally authorized to work in the United States without
 * sponsorship?" is two declarations in one, and was answered from the first
 * alone: `work_authorization` matches, so an applicant storing "authorized:
 * yes" and "needs sponsorship: yes" — which is most people on a student visa —
 * had their form answered "Yes". That is a false statement about their right
 * to work, made in their name, and counted as a field filled.
 *
 * Answering it means resolving a conjunction between two stored declarations,
 * and either way round the answer can be a lie. This file's rule for exactly
 * this pair is that an extension should not be the one deciding them, so the
 * question is handed back instead — reported, so the card shows it as one
 * still for the user, rather than passed over in silence.
 */
const AUTHORIZATION = FIELD_PATTERNS.find(([key]) => key === 'work_authorization')[1];
const SPONSORSHIP = FIELD_PATTERNS.find(([key]) => key === 'requires_sponsorship')[1];
/*
 * And the same pair with its first half in words `AUTHORIZATION` does not
 * know. "Are you able to work in the U.S. without sponsorship?" and "Can you
 * work in the United States without visa sponsorship?" matched only the
 * sponsorship pattern, so they were answered as "do you need sponsorship?" —
 * which is the opposite question. Measured: a profile needing none had "No"
 * written into both, telling the employer the applicant cannot work there
 * unsponsored; a profile needing it would have had "Yes", a false declaration
 * of the right to work. "Without" in front of the sponsorship is what makes it
 * the question about working, however the working is put.
 */
const WITHOUT_SPONSORSHIP = /\bwithout\b[\s\S]{0,30}\bsponsor\w*/i;
const asksBothAtOnce = (description) =>
  (AUTHORIZATION.test(description) || WITHOUT_SPONSORSHIP.test(description)) && SPONSORSHIP.test(description);

/**
 * Handing it back, wherever it turns up.
 *
 * Asked before `isNotAboutYou`, because the commonest wording of this
 * question is
 *
 *   Are you a U.S. citizen or otherwise authorized to work in the United
 *   States for any employer without sponsorship?
 *
 * and the word "citizen" in it matched the pattern that keeps "Country of
 * citizenship" from being filled with where somebody lives. An exclusion
 * says nothing — deliberately, because an excluded field is not the user's
 * to fill — so this one disappeared: not filled, not reported, not on the
 * card. The same sentence with the word "citizen" taken out was handed back
 * properly, which is what this restores. A question about the applicant's own
 * right to work is theirs however it is phrased.
 */
const TWO_AT_ONCE = 'this one asks two things at once';
const handBack = (description, skipped) => {
  if (!asksBothAtOnce(description)) return false;
  skipped.push({
    key: 'work_authorization',
    reason: TWO_AT_ONCE,
    description: description.slice(0, 60),
  });
  return true;
};

/**
 * A label that is just "Name" wants the whole name.
 *
 * It cannot be written as a pattern over the description, because the
 * description also carries the field's name and id attributes — so it is asked
 * of the label alone, and kept here so that everything asking "which profile
 * field is this" agrees.
 */
const BARE_NAME = /^(full\s+)?name$/i;

/**
 * A label without the punctuation a form puts round it.
 *
 * `Name *` and `Name:` are how a required field and a colon-styled form
 * write the commonest label on the page, and `BARE_NAME` is anchored at both
 * ends — so the applicant's name was left out of every form that marks its
 * required fields, silently, because no key matched and nothing that matches
 * no key is reported. `cleanQuestion` has stripped exactly this from question
 * text all along; the label handed to `BARE_NAME` never went through it.
 */
const withoutMarkers = (label) => clean(label).replace(/^[*:\s]+/, '').replace(/[*:\s]+$/, '');

/**
 * A box that asks for writing, not for a fact from the profile.
 *
 * The patterns read single words, and an essay prompt is free to use any of
 * them: "Tell us about a project you shipped at your current company" matched
 * `current_company`, "What did you study in school and why?" matched `school`,
 * and "Do you have experience with state management libraries?" matched
 * `address_state` — each box was typed over with a profile value, as though
 * the employer's name were an answer to the question. These are the card's
 * questions, not autofill's.
 *
 * Read off the field's own label, never the name or id. A multi-line box is
 * writing unless its label is a short noun phrase ("LinkedIn profile"); a
 * single-line one only when the label opens the way a prompt does, so "Which
 * university did you graduate from?" is still the school.
 */
const ESSAY_PROMPT =
  /^(?:please\s+)?(?:describe|tell\s+us|explain|elaborate|why\b|walk\s+us\s+through|give\s+(?:us\s+)?an?\s+example|share\s+(?:a\s+time|an?\s+example|your\s+(?:experience|thoughts))|what\s+(?:excites|interests|motivates|makes|would\s+you|did\s+you)|how\s+(?:does|do|would|did|will)\s+your?\b)|\bexperience\s+(?:with|using|in)\b/i;

function asksForWriting(input) {
  const label = withoutMarkers(labelFor(input));
  if (!label) return false;
  if (input instanceof HTMLTextAreaElement) return /\?$/.test(label) || label.split(/\s+/).length > 5;
  return ESSAY_PROMPT.test(label);
}

/*
 * A one-line box whose label asks for a yes or a no.
 *
 * The patterns read the profile word a question mentions, not what it asks,
 * and a yes-or-no question is free to mention any of them. Measured: "Do you
 * have a bachelor's degree?" was given "Master of Science", "Did you graduate
 * from a US university?" the university's name, "Do you have a GPA of 3.0 or
 * above?" the grade, "Can we text you at this phone number?" the number, and
 * "Will you be located in New York City by the start date?" the city the
 * applicant lives in — the last of which reads as a no to a question they may
 * have meant to answer yes.
 *
 * Only a label that opens the way such a question does, and never where it
 * goes on to ask for the thing — "Do you have a phone number? If so, please
 * share it" still gets it. Nor for a link: "Do you have a LinkedIn profile?"
 * answered with the profile is a yes that shows its working. A dropdown is
 * left to its options, which say for themselves whether the answer is a
 * value or a yes; the two declarations whose answer *is* a yes or a no keep
 * their own handling.
 */
const YES_NO_OPENING = /^(?:are|is|was|were|do|does|did|have|has|had|will|would|can|could|may|should)\s+(?:you|we|your)\b/i;
const ASKS_FOR_IT_TOO = /\bif\s+(?:so|yes)\b|\bplease\s+(?:provide|share|list|enter|include|give|add|specify)\b|\bwhat\s+is\b|\bwhich\b/i;

function asksYesOrNo(input, key) {
  if (input instanceof HTMLSelectElement || YES_NO_KEYS.has(key) || LINKS.has(key)) return false;
  const label = withoutMarkers(labelFor(input));
  return YES_NO_OPENING.test(label) && !ASKS_FOR_IT_TOO.test(label);
}

/**
 * "First" and "Last" under a legend that says "Name".
 *
 * A form that groups the name in a fieldset labels its halves with one word
 * each, and neither the patterns above nor `BARE_NAME` reads "First" as a
 * name: both boxes were left empty, and unreported. Only under a legend that
 * is the name and nothing else — "First" under "Interview availability" is
 * some other question.
 */
function nameHalf(input) {
  if (!/^(?:(?:your|full|legal)\s+)?name$/i.test(withoutMarkers(surroundingWords(input)))) return null;
  const label = withoutMarkers(labelFor(input));
  if (/^(first|given)$/i.test(label)) return 'first_name';
  if (/^(last|family)$/i.test(label)) return 'last_name';
  return null;
}

/**
 * The whole date, where a box asks for the month and the year at once.
 *
 * "From (Month/Year)" matched `month` first and was given "September" — into
 * a box whose placeholder said MM/YYYY — and reported as filled. A dropdown
 * keeps the key it matched: its options are one or the other.
 */
function wholeDateKey(input, key, description) {
  if (input instanceof HTMLSelectElement) return key;
  if (!/^(graduation|education_start)_(month|year)$/.test(key)) return key;
  if (!(/\bmonth\b/i.test(description) && /\byear\b/i.test(description))) return key;
  return key.replace(/_(month|year)$/, '_date');
}

/**
 * Every document this page is really made of.
 *
 * `querySelectorAll` stops at a shadow boundary, so a careers site built out of
 * web components looked to have no form on it at all — nothing to fill, nothing
 * to ask, and in a frame, nothing to recognise it as an application by. Open
 * roots are readable; closed ones are not, and a site using those has decided
 * nobody may look.
 */
/*
 * Except our own.
 *
 * The card is a shadow root on the page like any other, so the walk below
 * went straight into it — and everything in it is a box with a label. Its
 * feedback field, "Anything to change? e.g. …", came back as an application
 * question and was listed under "Application questions" with an offer to
 * draft an answer to it. The letter box and the answer boxes are the same
 * shape, so a form with three questions could grow three more out of the card
 * that was showing them.
 *
 * By id rather than by a marker on the element, because this has to hold for
 * the host before `createCard` has finished putting anything in it.
 */
const OURS = 'jobhelper-card-host';

/**
 * The events this file dispatches itself, so `watchChoices` does not take
 * Autofill's own filling for a choice somebody made.
 *
 * It did: every option Autofill picked fired the same `change` a person's
 * pick fires, and went into the bank as "Chosen on a form". A choice filled
 * from a row worded one way was saved again under the form's wording, as a
 * second row — measured in tests/reusing.mjs, "Which working arrangement do
 * you prefer?" beside the "…for this position?" it was filled from — and a
 * guess nobody checked was written down as their answer. By the event object
 * rather than by `isTrusted`: a page's own scripts, and many real pickers,
 * dispatch untrusted events for choices a person did make.
 */
const OUR_EVENTS = new WeakSet();
const ours = (event) => {
  OUR_EVENTS.add(event);
  return event;
};

function allRoots(root = document, out = [root]) {
  for (const element of root.querySelectorAll('*')) {
    if (element.id === OURS) continue;
    if (element.shadowRoot) {
      out.push(element.shadowRoot);
      allRoots(element.shadowRoot, out);
    }
  }
  return out;
}

/** The same query, asked of the page and of everything nested inside it. */
function deepQueryAll(selector, root = document) {
  return allRoots(root).flatMap((where) => [...where.querySelectorAll(selector)]);
}

/**
 * The text of the page, including what is inside components.
 *
 * `document.body.textContent` does not reach into a shadow root, so a form
 * built that way reads as a blank page.
 */
function deepText(limit = 40_000) {
  let text = document.body?.textContent ?? '';
  for (const root of allRoots().slice(1)) {
    if (text.length >= limit) break;
    text += ` ${root.textContent ?? ''}`;
  }
  return text.slice(0, limit);
}

/** The document or shadow root a field actually lives in. */
const rootOf = (node) => {
  const root = node.getRootNode?.();
  return root?.querySelector ? root : document;
};

/**
 * The component a node is drawn in, where it is drawn in one — never the
 * card's own host, whose insides are not the page's.
 */
const hostOf = (node) => {
  const root = node.getRootNode?.();
  return root instanceof ShadowRoot && root.host.id !== OURS ? root.host : null;
};

/**
 * The slot the page's own markup is drawn through, where it is put inside a
 * component — never one of the card's own.
 */
const slotOf = (node) => {
  const slot = node.assignedSlot;
  return slot && hostOf(slot) ? slot : null;
};

/**
 * The element around this one as the page draws it: the slot it is drawn
 * through, its parent, or the component it is drawn in.
 *
 * The slot first. A component can draw the fieldset, or the group, and put
 * the page's own fields in it through a `<slot>`: `<x-fieldset
 * legend="Emergency contact">` whose root is `<fieldset><legend>Emergency
 * contact</legend><slot></slot></fieldset>`, and the Phone and Email written
 * in the page between its tags. Those fields are in the page's tree and the
 * fieldset is in the component's, so neither `closest` nor climbing out
 * through hosts reached it: measured, an Emergency contact's Phone and Email
 * slotted that way were given the applicant's own, and a Reference's Email
 * in a group drawn the same way the applicant's address, where the same form
 * written without components left all three alone. Through the slot is where
 * the field is drawn — a field put in a slot outside the component's
 * fieldset is not in it, as it is not on the screen.
 */
const parentAround = (node) => slotOf(node) ?? node.parentElement ?? (node.parentNode instanceof ShadowRoot ? hostOf(node) : null);

/**
 * `closest`, carried on out of each component the node is drawn in.
 *
 * The walks that read what a field sits *in* — the fieldset whose legend says
 * whose details these are, the group that says which date, the block that
 * says which job — ask `closest` or climb `parentElement`, and both stop at
 * the shadow root the field is drawn in. So a box drawn in a component was in
 * no fieldset and no group at all, however the page nested it: measured, an
 * Emergency contact's Phone and Email were given the applicant's own, the
 * Month and Year under "When do you expect to graduate?" were left empty, and
 * a Work Experience block of components was not filled at all, where the same
 * form drawn without components was right in every box.
 *
 * Unlike a label, which `labelFor` only borrows from outside a component when
 * the component holds this field alone, what a field sits in needs no such
 * care: a fieldset around a component is around everything the component
 * draws, and its legend is as much the context of each box in it as of a box
 * written straight into the fieldset.
 *
 * And in through the slot a field is drawn through, as `parentAround` climbs:
 * `closest` stops at a host whose root draws the fieldset round its slot.
 */
function closestAround(node, selector) {
  for (let at = node; at; at = parentAround(at)) {
    if (at.matches?.(selector)) return at;
  }
  return null;
}

/** Whether `node` is drawn inside `box`, climbing as `parentAround` does. */
function drawnInside(box, node) {
  for (let at = node; at; at = parentAround(at)) {
    if (at === box) return true;
  }
  return false;
}

/**
 * Every element drawn inside `scope`, in the order the page draws them: a
 * component's root in place of what is written between its tags, and a slot
 * as what the page put in it. The same tree `parentAround` climbs, walked the
 * other way. Never the card's own.
 */
function* drawnWithin(scope) {
  const put = scope.localName === 'slot' && hostOf(scope) ? scope.assignedElements() : [];
  const from = put.length ? put : (scope.shadowRoot && scope.id !== OURS ? scope.shadowRoot : scope).children;
  for (const child of [...from]) {
    yield child;
    yield* drawnWithin(child);
  }
}

const drawsAny = (scope, selector) => {
  for (const el of drawnWithin(scope)) if (el.matches(selector)) return true;
  return false;
};

/*
 * The walks `labelFor` and `isRequired` make, for the page's own field put
 * into a component through a `<slot>`.
 *
 * A component can draw a field's label, and its asterisk, round the slot the
 * page's box is put in: `<x-field label="Last name"><input
 * name="q_1"></x-field>`, its root `<div class="field"><label>Last
 * name</label><slot></slot></div>`. The label is in the component's tree and
 * the box in the page's, and both walks climbed `parentElement` from the box
 * to the host and on up the page, never into the root: measured, a Last
 * name, an Email and a City slotted that way were left empty and unreported,
 * and a question under a label drawn "Why do you want to work here? *" was
 * not offered at all, where the same forms written without components were
 * filled and the question required.
 *
 * So they climb as the box is drawn: through the slot it is put in, then the
 * component's wrappers, then out from its host. What keeps a box from taking
 * the label of the one beside it is what keeps it from doing so in the page
 * — stop at another field — but "another field" has to count those put in
 * through a slot too, which `querySelectorAll` in the component's tree does
 * not see: two boxes slotted under one label looked, from the label's
 * wrapper, like none. See `fieldsDrawnIn`.
 */

/**
 * The element drawn before this one: the one put in the same slot before it,
 * or, for the first, what is drawn before the slot. Otherwise
 * `previousElementSibling`, which for a box put in a slot is whatever the
 * page wrote before it, drawn somewhere else or not at all: measured, a box
 * under a label drawn "Employee ID", after which the page had written a help
 * text "As on your email address" for the slot the component draws below
 * the box, was given the applicant's email address.
 */
function drawnBefore(node) {
  const slot = slotOf(node);
  if (!slot) return node.previousElementSibling;
  const put = slot.assignedElements();
  const at = put.indexOf(node);
  return at > 0 ? put[at - 1] : slot.previousElementSibling;
}

/**
 * How many fields `scope` holds, up to `enough`: those `fieldsIn` counts,
 * or those drawn in it (`drawnWithin`), which include the page's own put in
 * through a slot, whichever is more.
 */
function fieldsDrawnIn(scope, selector, enough) {
  const n = fieldsIn(scope, selector, enough);
  if (n >= enough) return n;
  let drawn = scope.matches?.(selector) ? 1 : 0;
  for (const el of drawnWithin(scope)) {
    if (el.matches(selector) && ++drawn >= enough) break;
  }
  return Math.max(n, drawn);
}

/**
 * The label a component draws round the slot a field is put in, when it
 * draws this field and no other: `<label><span>City</span>
 * <slot></slot></label>`. As a label written round the box is its own, and
 * as `componentLabel` takes one round a component: a label round a slot two
 * boxes are put in is a row of fields under one heading, no more the second
 * box's than the first's.
 */
function labelDrawnRound(input) {
  let through = false;
  for (let at = input; at; ) {
    const slot = slotOf(at);
    if (slot) through = true;
    at = slot ?? at.parentElement;
    if (through && at?.localName === 'label') return fieldsDrawnIn(at, ANOTHER_FIELD, 2) === 1 ? at : null;
  }
  return null;
}

/**
 * Find the label that belongs to a field.
 *
 * Getting this wrong is worse than not filling at all: an earlier version
 * appended "the first label found in the enclosing container", which on a form
 * inside one big <div> meant every field inherited the first field's label and
 * the email box got filled with a first name. So an explicit association wins
 * outright, and the positional fallback only looks at what immediately precedes
 * the field.
 */
/**
 * What `aria-labelledby` points at, as one piece of text.
 *
 * Its own function because a radio needs it and cannot use `labelFor`: a
 * radio's own `label[for]` is its *answer* — "Yes" — and the question is
 * somewhere else entirely, so the chain that is right for a text box gives
 * exactly the wrong string for a group.
 */
function fromLabelledBy(element) {
  const ids = element.getAttribute?.('aria-labelledby');
  if (!ids) return '';
  const text = ids
    .split(/\s+/)
    /*
     * Never the field itself, which `aria-labelledby` does sometimes name.
     *
     * Defensive rather than fixing anything measured, and worth being plain
     * about: an `<input>` has no `textContent`, so on the field this is
     * really about it changes nothing, and no test here falsifies it. It
     * earns its line on a `<textarea>`, whose `textContent` is whatever the
     * applicant typed — labelling a field with its own contents is not a
     * description of anything.
     */
    .filter((id) => id !== element.id)
    .map((id) => byIdAround(element, id)?.textContent ?? '')
    .join(' ');
  return clean(text);
}

/**
 * The element an id names, looked for in this field's own root first and then
 * in each root enclosing it, nearest first.
 *
 * Its own root first: ids inside a component are not in the document's id
 * map, so Workday-style labelling breaks there otherwise.
 *
 * And then outwards, because a component is very often two: an outer field
 * component draws `<div id="label">Phone number</div>` and an inner box
 * component, and the inner one puts `aria-labelledby="label"` on its
 * `<input>`. The id is in the outer component's root, not the input's, so
 * it resolved to nothing and the box was described by its `name` alone —
 * measured, a Phone number drawn that way came out empty and unreported. The
 * browser does not resolve it either, which is the component's bug, but the
 * words are plainly meant for this box.
 *
 * Nearest first, and never sideways into some other component's root: in a
 * list of such fields each outer component has its own `id="label"`, and the
 * nearest enclosing one is this box's. Searching every root on the page would
 * give every box in the list the first one's label.
 */
function byIdAround(element, id) {
  for (let root = rootOf(element); root; root = root.host ? rootOf(root.host) : null) {
    const found = root.getElementById?.(id) ?? root.querySelector(`#${CSS.escape(id)}`);
    if (found) return found;
  }
  return null;
}

/**
 * A field that could own a label of its own — which a hidden input cannot.
 *
 * Both walks in `labelFor`, and the one in `isRequired`, stop when they reach
 * another field: the label before it belongs to that field, not to this one,
 * and stepping over it is how somebody's first name gets typed into a
 * reference-code box. That rule is right and it must not count hidden inputs,
 * because a hidden input is not a field anybody can see, label or fill.
 *
 * Every real application form carries several — a CSRF token, a Workday state
 * blob, a phone country code, a Greenhouse tracking id — and the framework
 * puts them wherever it likes, which is very often immediately before the box
 * a person types into. Measured, on a form whose fields are named `q_00281`
 * and labelled only by a preceding `<div>`: one `<input type=hidden>` between
 * the label and the box, and the first-name and email fields came out empty.
 * Take the hidden inputs out of the same form and all three fill. Nothing is
 * reported, because from the outside it looks exactly like a form the tool was
 * never confident about.
 */
const ANOTHER_FIELD = 'input:not([type=hidden]), textarea, select';

/**
 * How many fields `scope` holds, up to `enough`, counting the ones drawn
 * inside the components in it.
 *
 * `querySelectorAll` does not reach into a shadow root, so a component that
 * draws its `<input>` in its own root looks like an empty element from
 * outside. Both walks in `labelFor` stop at another field by asking
 * `querySelector`, and a row of such components is a row of fields that
 * query cannot see: the walk stepped straight over the component before this
 * box, and over the question that belonged to it, and gave this box its
 * neighbour's label. The light DOM is asked first, and a component is only
 * opened when that has not already found enough.
 */
function fieldsIn(scope, selector, enough) {
  let n = (scope.matches?.(selector) ? 1 : 0) + scope.querySelectorAll(selector).length;
  if (n >= enough) return n;
  for (const el of [scope, ...scope.querySelectorAll('*')]) {
    if (!el.shadowRoot || el.id === OURS) continue;
    n += fieldsIn(el.shadowRoot, selector, enough - n);
    if (n >= enough) break;
  }
  return n;
}

/*
 * What is never drawn, and so is never anybody's label. A component's root
 * very often begins with its own `<style>`, and its text is CSS: taken for
 * the words before a box, `:host { display: block }` is the question.
 */
const NEVER_SHOWN = 'style, script, template, link, meta, noscript';

/**
 * The words an element shows, as `labelFor`'s walks read them.
 *
 * For a component, that is its shadow root with each slot read as what is
 * slotted into it, not its `textContent`: a label component given
 * `text="Email"` draws the word in its root and holds nothing in the page, and
 * one given the word as a child shows it only through a slot.
 *
 * And the same for a slot, or an element drawn round one, in a component's
 * root, which the walks reach from the page's own box put in through a slot
 * (see `drawnBefore`): `<label><slot name="label"></slot> *</label>`, the
 * words the page's, reads by its `textContent` as "*".
 */
function shownText(el) {
  if (el.id === OURS) return clean(el.textContent);
  if (el.shadowRoot || (hostOf(el) && (el.localName === 'slot' || el.querySelector('slot')))) return drawnText(el);
  return clean(el.textContent);
}

/**
 * The words `el` draws: a component's root in place of what is written
 * between its tags, and a slot as what is slotted into it. See `shownText`,
 * which asks this of a component, and `optionLabelFor`, of a label drawn in
 * one round a slot.
 */
function drawnText(el) {
  const parts = [];
  const walk = (node) => {
    const shown = node.localName === 'slot' ? node.assignedNodes({ flatten: true }) : [];
    const kids = shown.length ? shown : (node.shadowRoot && node.id !== OURS ? node.shadowRoot : node).childNodes;
    for (const child of kids) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue);
      else if (child.nodeType === Node.ELEMENT_NODE && !child.matches(NEVER_SHOWN) && child.getAttribute('aria-hidden') !== 'true') {
        parts.push(' ');
        walk(child);
        parts.push(' ');
      }
    }
  };
  walk(el);
  return clean(parts.join(''));
}

/** The element above, or the shadow root when there is none inside it. */
const containerOf = (node) => node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode : null);

/**
 * The group above `node` as the climbs in `labelFor` and `isRequired` take
 * it: `containerOf`, or, for the page's own element put in a component's
 * slot, what the component draws round the slot. Each root entered that way
 * is added to `putInto`.
 */
function groupDrawnAround(node, putInto) {
  const slot = slotOf(node);
  if (!slot) return containerOf(node);
  putInto.add(slot.getRootNode());
  return containerOf(slot);
}

/*
 * How far the climb in `labelFor` goes above a component, once it has left
 * the one the field is drawn in. See there.
 */
const LEVELS_OUTSIDE = 3;

/**
 * A label's words, the way a screen reader says them.
 *
 * LinkedIn's Easy Apply writes every question twice inside its label — once
 * for the eye, marked `aria-hidden`, and once for a screen reader, clipped out
 * of sight — in two spans with nothing between them. `textContent` ran them
 * together into "SchoolSchool", which no pattern here reads as a school, so
 * a Greenhouse form inside Easy Apply was filled with nothing at all:
 * reported as "Filled 0 fields" over School, Degree and Discipline.
 *
 * So the copy marked `aria-hidden` is left out when the label says anything
 * else, as assistive technology leaves it out, and an element boundary is a
 * word boundary. A label that is nothing but hidden text keeps it, rather than
 * becoming no label at all.
 */
/*
 * And the words a `<slot>` shows, which are not its children.
 *
 * A web component's label is very often a slot: Shoelace's `<sl-input>`
 * draws `<label for="input"><slot name="label">` beside its own `<input
 * id="input">` in its shadow root, and the page writes the words in its own
 * markup, `<sl-input><span slot="label">First name</span></sl-input>`. What
 * the slot shows is its assigned nodes, which live in the page, and what it
 * holds is only the fallback for when nothing is assigned — so the label was
 * read as empty, and every box drawn this way was described by its `name`
 * alone. On a form whose names are `q_1001` that is no description at all:
 * measured, First name, Last name and Email came out empty and unreported.
 * The assigned nodes when there are any, flattened through a slot passed on
 * into another component, and the fallback otherwise, as the browser draws it.
 */
function labelWords(el) {
  if (!el) return '';
  const parts = [];
  const walk = (node) => {
    const shown = node.localName === 'slot' ? node.assignedNodes({ flatten: true }) : [];
    for (const child of shown.length ? shown : node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) parts.push(child.nodeValue);
      else if (child.nodeType === Node.ELEMENT_NODE && child.getAttribute('aria-hidden') !== 'true') {
        parts.push(' ');
        walk(child);
        parts.push(' ');
      }
    }
  };
  walk(el);
  return clean(parts.join('')) || clean(el.textContent);
}

/**
 * The `<label>` the page gave the component a field is drawn in, when it gave
 * the component one rather than the field.
 *
 * The page cannot name an `<input>` inside a component's root — neither
 * `for` nor a wrapping label reaches in — so it names the component: `<label
 * for="email">Email</label>` and `<x-input id="email">`, or `<label>Email
 * <x-input></x-input></label>`. `labelFor` asked for `label[for]` in the
 * input's own root and for `closest('label')`, and both stop at the shadow
 * root, so both were read as nothing. The words beside the component are
 * found by the climb in `labelFor`, but these are not beside it: the text
 * is inside the label with the component, which the climb takes for this
 * field's own wrapper, and a `for` label is very often in another column
 * altogether. Measured, Last name, Email and First name wired these ways
 * came out empty and unreported.
 *
 * Out through each root, nearest first, and only while the root holds this
 * field and no other: a label naming a component that draws a first-name box
 * and a last-name box names neither, and "Name" in both would be the full
 * name twice. Then at each host:
 *
 * - `label[for]` in the host's own root, and only when that root's element
 *   with the id *is* this host. An id is only resolved in its own root, so
 *   the page's `for="city"` does not name a component some other component
 *   draws with `id="city"`; and ids are not always unique, and `for` names
 *   the first element with its id, never the second.
 * - the label wrapping the host, and only when it holds no other field,
 *   counting the ones drawn in components. A label around two components is
 *   a row of fields under one heading, and its words are no more the second
 *   box's than the first's.
 */
function componentLabel(input) {
  let from = input;
  for (let root = rootOf(from); root instanceof ShadowRoot && root.host.id !== OURS; root = rootOf(from)) {
    if (fieldsIn(root, ANOTHER_FIELD, 2) > 1) return null;
    from = root.host;
    const around = rootOf(from);
    if (from.id && around.getElementById?.(from.id) === from) {
      const named = around.querySelector(`label[for="${CSS.escape(from.id)}"]`);
      if (named) return named;
    }
    const wrapping = from.closest('label');
    if (wrapping && fieldsIn(wrapping, ANOTHER_FIELD, 2) === 1) return wrapping;
  }
  return null;
}

function labelFor(input) {
  // A plain dropdown's own label, and never one found further off. See `PLAIN`.
  if (PLAIN.has(input)) return labelWords(plainLabelOf(input));
  /*
   * Each of these answers only when it has something to say.
   *
   * `if (label) return clean(label.textContent)` returned the empty string
   * for a label that exists and is empty — and an empty `<label for=…>` is
   * ordinary markup: a styling hook, an icon slot, a label a framework
   * renders before its text arrives. Returning it ended the search, so
   * `aria-labelledby` and `aria-label` below were never reached on exactly
   * the forms that use them, and the field was described by its `name`
   * attribute alone. On a system whose names are `field_0192` that is no
   * description at all.
   *
   * A wrapping `<label>` has the same shape: one that holds only the input
   * cleans down to nothing.
   */
  if (input.id) {
    const label = rootOf(input).querySelector(`label[for="${CSS.escape(input.id)}"]`);
    const said = labelWords(label);
    if (said) return said;
  }

  const wrapping = labelWords(input.closest('label'));
  if (wrapping) return wrapping;

  // Or one a component draws round the slot it is put in. See `labelDrawnRound`.
  const drawnRound = labelWords(labelDrawnRound(input));
  if (drawnRound) return drawnRound;

  const described = fromLabelledBy(input);
  if (described) return described;

  /*
   * Unless it only names the kind of control. Rippling's custom questions are
   * each a widget whose `aria-label` is "Select" — the question itself is a
   * `<p>` in the block above — so every one of them was described as
   * "Select": measured live on two Rippling boards (ats.rippling.com/capacity
   * and /closinglock), "Do you have the unrestricted right to work for any
   * employer…?" and the rest came out as nothing anybody could match. Such a
   * label is kept for last, below, and used only if nothing says more.
   */
  const aria = clean(input.getAttribute('aria-label'));
  if (aria && !CONTROL_WORD.test(aria)) return aria;

  /*
   * The label the page gave the component this field is drawn in. After
   * everything the field says of itself, which is nearer, and before any
   * guess from position, which it is not. See `componentLabel`.
   */
  const hosts = labelWords(componentLabel(input));
  if (hosts) return hosts;

  /*
   * Positional fallback: the nearest preceding element that reads like a label.
   *
   * Stop at another field, and a bare <input> *is* another field. Testing only
   * for a descendant field stepped straight over one — it has no descendants —
   * so `<label for=fn>First Name</label><input id=fn><input name=ref_code>`
   * gave the unlabelled box the label "First Name", and the user's first name
   * was typed into it. The same walk put their email address in the unlabelled
   * box after the email field. That is precisely the failure the note at the
   * top of this function says was fixed.
   */
  /*
   * "Another field" includes one drawn inside a component (see `fieldsIn`),
   * and what is never drawn is stepped over without being counted: see
   * `NEVER_SHOWN`.
   *
   * And "preceding" is as the page draws it, and so is "another field": a
   * box put in a component's slot is preceded by what the component draws
   * before the slot, and by the boxes put in the slot before it. See
   * `drawnBefore` and `fieldsDrawnIn`.
   */
  const lookBack = (from) => {
    let node = drawnBefore(from);
    for (let i = 0; i < 3 && node; node = drawnBefore(node)) {
      if (node.matches(NEVER_SHOWN)) continue;
      i++;
      if (fieldsDrawnIn(node, ANOTHER_FIELD, 1)) break;
      const text = shownText(node);
      if (text && text.length < 160) return text;
    }
    return '';
  };
  const before = lookBack(input);
  if (before) return before;

  /*
   * Last resort: the nearest ancestor holding this field and nothing else
   * fillable.
   *
   * Climbing is the point. This looked in one container and gave up, which
   * misses the two shapes that matter most in practice: Lever wraps the field
   * in its own div and puts the question in a sibling div above it, and Taleo
   * lays the form out as a table with the label in the cell before. In both,
   * the label is nowhere near the box the field sits in — it is one level up.
   *
   * "Nothing else fillable" is what keeps this safe: the moment an ancestor
   * holds a second field, it is the form rather than this field's own group,
   * and whatever label it holds belongs to something else.
   */
  /*
   * The same climb, for a question that is not marked as a label at all: the
   * first thing in the group, holding words and no field of its own. That is
   * Rippling's shape — `<div><div><p>question</p></div></div>` and then the
   * field's own wrapper — and its textareas, which have no `aria-label` to
   * fall back on, were not even offered as questions to answer.
   */
  /*
   * Seven levels, because a widget is deep: Rippling's `role="combobox"` sits
   * six wrappers below the block holding its question. Every level still has
   * to hold this one field and no other, which is what bounds the climb.
   */
  /*
   * And on out of a component, to where the page put it.
   *
   * Both walks stopped at the shadow root a field is drawn in, since neither
   * `previousElementSibling` nor `parentElement` leaves it. So a box drawn
   * alone in a component was labelled only from inside that component, and
   * the three commonest ways of labelling one from outside were never read:
   * the page's `<label>Last name</label>` beside `<x-input>`, and a field
   * component whose root holds a label component and then a box component.
   * Measured, Last name and Email drawn those ways came out empty and
   * unreported.
   *
   * The shadow root is now one more group, and when it holds this field and
   * nothing else fillable the walks carry on from its host, exactly as they
   * start from the field: the few elements before the host, then the groups
   * around it. The rules that keep them safe are unchanged — stop at another
   * field, counting the ones inside components, and stop at a group holding
   * a second one — so in a row of components each with its own label beside
   * it, each box reads its own, and the one before a component holding a
   * tick box is never stepped over.
   *
   * Only `LEVELS_OUTSIDE` groups beyond the component, where inside the page
   * the climb goes seven. Those seven are for a widget buried in wrappers of
   * its own; a component *is* the widget, and its wrappers are the page's.
   * A component with no label near it is otherwise alone in its section for
   * as far as the climb goes, and the section's heading, several levels up,
   * became its label.
   */
  // One field, whether it is an input or a widget `<div>` (which the old
  // test, "exactly one input", stopped at before it had begun).
  const oneField = `${ANOTHER_FIELD}, [role="combobox"]`;
  // `from` is where the field is, as seen from `group`: the field itself, the
  // element holding it, or the component it is drawn in.
  /*
   * And in through the slot a box is put in, as `groupDrawnAround` climbs,
   * counting what is drawn (`fieldsDrawnIn`). A component the page's box is
   * put into is not the box's own, as one it is drawn in is: it is one more
   * of the page's wrappers, drawn by somebody else. So its wrappers cost none
   * of the seven, and leaving it is not leaving the field's component, from
   * which only `LEVELS_OUTSIDE` more are climbed.
   */
  let from = input;
  const putInto = new Set();
  let group = groupDrawnAround(input, putInto);
  for (let i = 0, outside = 0; i < 7 && group && outside <= LEVELS_OUTSIDE; ) {
    if (fieldsDrawnIn(group, oneField, 2) > 1) break;
    const heading = group.querySelector('label,legend,th,.label,[class*="label"]');
    // A label a component draws round a slot says what is put in it, as in `optionLabelFor`.
    if (heading && !heading.contains(from)) return hostOf(heading) && heading.querySelector('slot') ? drawnText(heading) : clean(heading.textContent);
    let lead = group.firstElementChild;
    while (lead?.matches(NEVER_SHOWN)) lead = lead.nextElementSibling;
    const said = lead && !lead.contains(from) && !fieldsDrawnIn(lead, ANOTHER_FIELD, 1) ? shownText(lead) : '';
    if (said && said.length < 300) return said;
    const leaving = group instanceof ShadowRoot;
    const put = putInto.has(leaving ? group : group.getRootNode());
    from = leaving ? group.host : group;
    if (leaving) {
      const beside = lookBack(from);
      if (beside) return beside;
    }
    group = groupDrawnAround(from, putInto);
    if ((leaving && !put) || outside) outside++;
    if (!put) i++;
  }
  return aria;
}

/** An `aria-label` that names the control rather than the question. */
/*
 * And says it is required. Workday's Application Questions are "Select One"
 * buttons labelled " Select One Required", the question being rich text in
 * the `<legend>` of the `<fieldset>` around them — so every one was described
 * as "Select One Required", matched nothing, and was neither answered nor
 * reported. Measured live with a fake profile on NVIDIA's "Are you legally
 * authorized to work in the United States?" and "Will you now or in the
 * future require sponsorship…?", and on Intel's questionnaire: every required
 * right-to-work question left on "Select One" under a report saying nothing.
 */
const CONTROL_WORD = /^(select|search|choose|pick|select an option|select one|dropdown|combobox|text ?area|input)\.*(\s+required)?$/i;

/**
 * Everything a field's label might be hiding in. The explicit label leads, so
 * that a pattern matching on it wins over an incidental match in an attribute.
 */
function describeField(input) {
  const label = labelFor(input);
  const attrs = [input.name, input.id, input.placeholder].flatMap(alsoAsWords).filter(Boolean);
  return clean([label, ...attrs].filter(Boolean).join(' ')).slice(0, 300);
}

/**
 * An attribute value as the words it is made of.
 *
 * `\b` counts an underscore as a word character, so every pattern here that
 * names a word failed against the snake_case half these systems use:
 * `/\breferences?\b/` does not match `reference_email`, and
 * `/\b(emergency|...)\b/` does not match `emergency_contact_phone`. The
 * hyphenated spelling matched all along, which is what made the exclusion
 * look covered — `reference-email` is kept out and `reference_email` was
 * filled with the applicant's own address.
 *
 * camelCase for the same reason and the same systems: `referenceEmail` is one
 * word to a regular expression and two to everybody else.
 *
 * Splitting can only add word boundaries, so nothing that matched before
 * stops matching. What changes is that a name written the way a programmer
 * writes it now reads the way its label does.
 */
const asWords = (value) => clean(String(value ?? '').replace(/_+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

/**
 * Both spellings, because splitting is not always right either.
 *
 * `urls[LinkedIn]` is Lever's name for the LinkedIn box, and the pattern for
 * it is `/\b(linked-?in)\b/` — a hyphen is allowed and a space is not, so
 * splitting the camel case and keeping only the split turned a field that had
 * always been filled into one that never was. Measured:
 *
 *   FAIL  Lever: fills the fields it should
 *         input[name="urls[LinkedIn]"] wanted "linkedin.com/in/morgantestwell", got ""
 *
 * A description is a bag of words rather than a sentence, so the answer is to
 * carry both: the name as written, which every pattern was designed against,
 * and the name as words, which is what the exclusions need. Nothing that
 * matched before can stop matching, which is the property worth having here.
 */
const alsoAsWords = (value) => {
  const raw = clean(value);
  const split = asWords(value);
  return split && split !== raw ? [raw, split] : [raw];
};

/** The label alone, for cases where attribute noise would mislead. */
function questionFor(input) {
  return labelFor(input);
}

/** A choice dressed as something else: a button, or a text box that is a list. */
function isWidgetChoice(element) {
  if (element instanceof HTMLSelectElement) return false;
  // What select2 draws is its select's, which is the question. See `select2Of`.
  if (isSelect2Part(element)) return false;
  const role = element.getAttribute?.('role');
  return (
    role === 'combobox' ||
    role === 'listbox' ||
    element.getAttribute?.('aria-haspopup') === 'listbox' ||
    ['list', 'both'].includes(element.getAttribute?.('aria-autocomplete')) ||
    isWorkdayPrompt(element) ||
    isFabricSelect(element) ||
    PLAIN.has(element)
  );
}

/*
 * A dropdown written for the site, with nothing to say it is one.
 *
 * No role, no `aria-haspopup`, no select behind it: a `div` saying "Select"
 * beside a chevron, which on a click draws a `div` of clickable `div`s,
 * often at the foot of the page. Nothing here read it as a question at all,
 * so on a fixture drawn that way the School, Degree and Discipline stayed on
 * "Select" and the report said nothing about any of them.
 *
 * Pressing things that say nothing about themselves is how a form gets
 * something it did not ask for, so one is taken for a dropdown only when
 * every sign agrees:
 *
 *   - its words are a prompt to choose and nothing else — "Select",
 *     "Select…", "Choose an option" — and no control, link or ARIA widget
 *     is in it or around it;
 *   - it draws a chevron (an icon, an arrow character, or a `::before` or
 *     `::after` of its own) and looks pressable (a pointer, or a place in the
 *     Tab order);
 *   - a `<label>` stands just before it, or names it, and belongs to nothing
 *     else — it is never labelled by a climb through the page, which is how
 *     a Degree would come to be read as the School above it.
 *
 * It is then driven exactly as the ARIA ones are (`chooseInWidget`), only
 * where the profile or the bank answers its label, and with its list found
 * as what appeared on the page when it was pressed (see `plainOptions`).
 */
const PLAIN = new WeakSet();
const PLAIN_PROMPT = /^(?:please\s+)?(?:select|choose|pick)(?:\s+(?:one|an?\s+option))?\s*(?:\.{1,3}|…)?$/i;
const CHEVRON_CHARACTER = /[▾▼⌄˅∨⏷▿⌵]/;
const promptWords = (text) => clean(String(text ?? '').replace(new RegExp(CHEVRON_CHARACTER.source, 'g'), ''));

/** The plain dropdowns under `root`, each remembered as a widget. */
function plainDropdowns(root = document) {
  const found = [];
  for (const where of allRoots(root)) {
    const walker = document.createTreeWalker(where, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!PLAIN_PROMPT.test(promptWords(node.nodeValue))) continue;
      const control = plainControlOver(node.parentElement);
      if (control && !found.includes(control)) found.push(control);
    }
  }
  return found;
}

/**
 * These controls and the plain dropdowns under `root`, in the order the
 * page has them — or just these, as they came, where there are none.
 */
function withPlainDropdowns(found, root = document) {
  const plain = plainDropdowns(root).filter((el) => !found.includes(el));
  if (!plain.length) return [...found];
  return [...found, ...plain].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1));
}

/** The dropdown whose prompt these words are, or nothing. */
function plainControlOver(words) {
  if (!words || rootOf(words)?.host?.id === OURS) return null;
  const said = promptWords(words.textContent);
  if (!PLAIN_PROMPT.test(said)) return null;
  // The outermost element saying the prompt and nothing more.
  let control = words;
  while (
    control.parentElement &&
    !['body', 'form', 'html'].includes(control.parentElement.localName) &&
    promptWords(control.parentElement.textContent) === said
  ) {
    control = control.parentElement;
  }
  if (PLAIN.has(control)) return control;
  if (!looksLikePlainDropdown(control, words)) return null;
  PLAIN.add(control);
  return control;
}

function looksLikePlainDropdown(control, words) {
  if (control.getClientRects().length === 0 || getComputedStyle(control).visibility === 'hidden') return false;
  if (isWidgetChoice(control) || isDisabled(control)) return false;
  if (control.matches('[role]:not([role="presentation"]):not([role="none"]), [aria-haspopup], [aria-expanded], [contenteditable]')) return false;
  if (control.querySelector('input:not([type=hidden]), select, textarea, button, a[href], [role="combobox"], [role="listbox"], [aria-haspopup]')) return false;
  if (control.closest('a[href], label, select, option, textarea, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], [role="menuitem"], [aria-haspopup]')) return false;
  const button = control.closest('button');
  if (button && (button !== control || wouldSubmit(button))) return false;
  // Not an upload's "Select" beside its file box.
  if (control.parentElement?.querySelector('input[type=file]')) return false;
  const pseudo = (el, which) => !['none', 'normal', '""', "''"].includes(getComputedStyle(el, which).content);
  const chevron =
    Boolean(control.querySelector('svg, img, i, [class*="chevron" i], [class*="arrow" i], [class*="caret" i]')) ||
    CHEVRON_CHARACTER.test(control.textContent) ||
    [control, words].some((el) => pseudo(el, '::after') || pseudo(el, '::before'));
  if (!chevron) return false;
  const pressable =
    getComputedStyle(words).cursor === 'pointer' ||
    control.matches('button, [tabindex]:not([tabindex^="-"])') ||
    Boolean(control.querySelector('[tabindex]:not([tabindex^="-"])'));
  if (!pressable) return false;
  return Boolean(plainLabelOf(control));
}

/**
 * The `<label>` of a plain dropdown: one that names it or something in it,
 * or the one standing straight before it — or before a wrapper holding
 * nothing else — and naming nothing else. Never one found further off.
 */
function plainLabelOf(control) {
  const root = rootOf(control);
  for (const el of [control, ...control.querySelectorAll('[id]')]) {
    const label = el.id && root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label && clean(labelWords(label))) return label;
  }
  let at = control;
  for (let up = 0; up < 3 && at && !['body', 'form', 'html'].includes(at.localName); up++) {
    let before = at.previousElementSibling;
    while (before?.matches('input[type=hidden]')) before = before.previousElementSibling;
    if (before) {
      const mine = before.localName === 'label' && !before.htmlFor && !before.querySelector(ANOTHER_FIELD) && clean(labelWords(before));
      return mine ? before : null;
    }
    const parent = at.parentElement;
    if (!parent || [...parent.children].some((other) => other !== at && (clean(other.textContent) || other.matches(A_CONTROL) || other.querySelector(A_CONTROL)))) {
      return null;
    }
    at = parent;
  }
  return null;
}

/** Where a widget is pressed to open it: itself, or a plain one's words. */
const pressPoint = (widget) => (PLAIN.has(widget) ? wordsOf(widget) : widget);

/*
 * What appeared on the page while a plain dropdown was being pressed: its
 * list, since nothing names it. Watched from before the press until the
 * choice is read back.
 */
const APPEARED = new WeakMap();

function watchAppearing(widget) {
  const seen = new Set();
  const note = (records) => {
    for (const record of records) {
      if (record.type === 'attributes') seen.add(record.target);
      else for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) seen.add(node);
    }
  };
  const observer = new MutationObserver(note);
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] });
  APPEARED.set(widget, { seen, words: pressPoint(widget), flush: () => note(observer.takeRecords()) });
  return () => {
    observer.disconnect();
    APPEARED.delete(widget);
  };
}

/**
 * A plain dropdown's options: the words in the one thing that appeared when
 * it was pressed — and only one, since two is a guess about which is its
 * list. Only a list holding nothing that could be pressed for some other
 * purpose (a field, a button, a link), at least two options, and never an
 * option whose words are said twice.
 */
function plainOptions(widget) {
  const lists = plainAppeared(widget);
  if (lists.length !== 1) return [];
  const [list] = lists;
  if (list.matches('a[href], button, form') || list.querySelector('input:not([type=hidden]), select, textarea, button, a[href], iframe, form')) return [];
  const worded = [list, ...list.querySelectorAll('*')].filter(
    (el) => [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.nodeValue.trim()) && el.getClientRects().length > 0,
  );
  const said = worded.map((el) => clean(el.textContent).toLowerCase());
  const options = worded.filter((_, i) => said.indexOf(said[i]) === said.lastIndexOf(said[i]));
  return options.length >= 2 ? options : [];
}

/** What has appeared on the page since a plain dropdown was pressed, and is showing. */
function plainAppeared(widget) {
  const watch = APPEARED.get(widget);
  if (!watch) return [];
  watch.flush();
  const shown = [...watch.seen].filter(
    (el) =>
      el.isConnected &&
      !el.contains(watch.words) &&
      !el.contains(widget) &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      getComputedStyle(el).opacity !== '0',
  );
  return shown.filter((el) => !shown.some((other) => other !== el && other.contains(el)));
}

/** What a plain dropdown shows as chosen, its own list left out. */
function plainShown(widget) {
  const lists = [...(APPEARED.get(widget)?.seen ?? [])].filter((el) => el !== widget && widget.contains(el));
  const walker = document.createTreeWalker(widget, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!lists.some((list) => list.contains(node))) text += ` ${node.nodeValue}`;
  }
  return promptWords(text);
}

/**
 * Whether a plain dropdown took the choice: it shows the option's words as
 * its own, and its list has gone. It has no value to read and no state to
 * ask, so both are needed — an ignored click leaves the list open.
 */
function plainTookIt(widget, chosen) {
  return widget.isConnected && sameOption(plainShown(widget), chosen) && plainOptions(widget).length === 0;
}

/*
 * BambooHR's dropdown: Fabric's select, a button saying only that it opens a
 * menu (`aria-haspopup="true"`), which names that menu in `data-menu-id` and
 * draws it at the foot of the page as `role="menuitem"` rows. Every list on
 * its application is one, and none was read as a list. The menu's name is
 * required as well, because a button opening a menu is otherwise a toolbar.
 */
const FABRIC_SELECT = 'button[data-menu-id][aria-haspopup="true"]';
const isFabricSelect = (element) => Boolean(element.matches?.(FABRIC_SELECT));

/*
 * Workday's prompt: a search box that is a list, and says so in nothing a
 * screen reader reads.
 *
 * Its School or University, its Field of Study, "How Did You Hear About Us?"
 * and the phone's country code are each an `<input placeholder="Search">`
 * with no role and no `aria-autocomplete`, inside a `multiSelectContainer`,
 * marked only `data-uxi-widget-type="selectinput"`. Nothing here read that as
 * a list, so it was typed into as a text box. Measured live with a fake
 * profile on Intel's and NVIDIA's My Experience: "Northeastern University" and
 * "Computer Science" sat in the search boxes, the report counted both filled,
 * and Save and Continue answered "The field School or University is required
 * and must have a value", and the same for Field of Study — words in a search
 * box are not a choice. Where a person had already picked Computer Science,
 * on NVIDIA, the words were typed in again beside the pill.
 *
 * As a list it is driven the way every list is (see `chooseInWidget`), with
 * the two things this one needs: the search runs on Enter, and the click has
 * to land on the option's words (see `wordsOf`). What it holds is its pills
 * (see `controlOf`), so one already chosen is left alone.
 */
function isWorkdayPrompt(element) {
  return element.getAttribute?.('data-uxi-widget-type') === 'selectinput';
}

/*
 * A `<select>` Chosen (harvesthq's jQuery plugin) has hidden and drawn again.
 *
 * Chosen hides the select with `display: none` and draws a
 * `.chosen-container` straight after it — `.chzn-container` before 1.0 —
 * with a search box of its own inside. It has no ARIA roles, so nothing here
 * read it as a list; and the select, having no box on the page, was not
 * fillable either. Measured on a fixture drawn as Chosen draws itself: the
 * profile's "United States" went into Chosen's search box, the report said
 * the Country was filled, and the select still held nothing and showed
 * "Select a country". The box's placeholder, "Select an Option", was
 * offered to the bank as a question typed on the form. And a person's pick
 * was never kept: Chosen announces it with jQuery's `trigger('change')`,
 * which runs jQuery's handlers and fires no native event.
 *
 * So the select is filled as the select it is, its visibility read off the
 * container; Chosen is told to redraw the way a page tells it, with
 * `chosen:updated` (jQuery's `.on` hears a native event of that name); and
 * the fill counts only once the container shows the choice. A pick inside
 * the container is read back off the select. See `watchChosenPicks`.
 *
 * bootstrap-select keeps its select on the page, shrunk to a pixel, and
 * redraws on its native `change`, so it needs none of this. select2 does
 * too — see `select2Of` for what it does need.
 */
const CHOSEN = '.chosen-container, .chzn-container';

/*
 * A `<select>` select2 (4.x) has shrunk to a pixel and drawn again.
 *
 * select2 keeps the select on the page as `select2-hidden-accessible`,
 * labelled by its own `<label for>`, and draws a `.select2-container` straight
 * after it: a `.select2-selection` that is `role="combobox"`, labelled by the
 * span that shows the choice, and a dropdown it opens in a second
 * `.select2-container` at the foot of the body, with a search box
 * (`aria-autocomplete="list"`) over a `role="listbox"`. It redraws from the
 * select on `change`, so filling the select fills it. But its drawing was
 * read as a question of its own: measured on a fixture drawn as select2
 * draws itself, "Select an option" — the placeholder in the selection — was
 * offered to the bank beside the select's real question; and a person's pick
 * was never kept, because select2 picks on mouseup and announces it with
 * jQuery's `trigger('change')`, which fires no native event, and the option
 * the pick was made in has left the page before any click arrives.
 *
 * So everything select2 draws is its select's, and nothing of it is a widget
 * or a box (see `isSelect2Part`); the select is filled, asked and read as the
 * select it is, and a pick made in the drawing is read back off the select by
 * `watchChosenPicks`, as Chosen's is.
 */
const SELECT2 = '.select2-container';

function select2Of(select) {
  if (!(select instanceof HTMLSelectElement)) return null;
  const next = select.nextElementSibling;
  return next?.matches?.(SELECT2) && next.querySelector('.select2-selection') ? next : null;
}

/**
 * The select a select2 container stands in for: the one before it, or — for
 * the dropdown it opens at the foot of the body — the one whose selection
 * names its list (`select2-<id>-results` beside `select2-<id>-container`).
 */
function selectOfSelect2(node) {
  const container = node?.closest?.(SELECT2);
  if (!container) return null;
  const before = container.previousElementSibling;
  if (before instanceof HTMLSelectElement && select2Of(before) === container) return before;
  const list = container.querySelector('.select2-results__options[id]');
  if (!list) return null;
  const root = container.getRootNode?.();
  const named = /^select2-(.+)-results$/.exec(list.id);
  const owner =
    (named && root?.getElementById?.(`select2-${named[1]}-container`)) ||
    root?.querySelector?.(`.select2-selection[aria-controls~="${CSS.escape(list.id)}"], .select2-selection[aria-owns~="${CSS.escape(list.id)}"]`);
  const drawn = owner?.closest?.(SELECT2);
  const select = drawn?.previousElementSibling;
  return select instanceof HTMLSelectElement && select2Of(select) === drawn ? select : null;
}

/** Anything select2 drew for a select: its selection, its search box, its list. */
function isSelect2Part(node) {
  const container = node?.closest?.(SELECT2);
  return Boolean(container && (selectOfSelect2(container) || container.querySelector(':scope > .select2-dropdown')));
}

function chosenOf(select) {
  if (!(select instanceof HTMLSelectElement)) return null;
  const next = select.nextElementSibling;
  if (next?.matches?.(CHOSEN)) return next;
  if (!select.id) return null;
  const root = select.getRootNode?.();
  for (const suffix of ['_chosen', '_chzn']) {
    const drawn = root?.getElementById?.(`${select.id}${suffix}`);
    if (drawn?.matches?.(CHOSEN)) return drawn;
  }
  return null;
}

/** The select a Chosen container stands in for. */
function selectOfChosen(container) {
  const before = container.previousElementSibling;
  if (before instanceof HTMLSelectElement && chosenOf(before) === container) return before;
  const id = String(container.id ?? '').replace(/_(?:chosen|chzn)$/, '');
  const select = id && id !== container.id ? container.getRootNode?.()?.getElementById?.(id) : null;
  return select instanceof HTMLSelectElement && chosenOf(select) === container ? select : null;
}

/**
 * Tell a widget standing in for this select that its value was changed, and
 * say whether it now shows it. True for a select nothing stands in for.
 */
function redrawStandIn(select) {
  // select2 redraws on the `change` already sent; asked only whether it did.
  const select2 = select2Of(select);
  if (select2) {
    const said = clean(select.selectedOptions?.[0]?.textContent).toLowerCase();
    const shown = select2.querySelector('.select2-selection__rendered') ?? select2;
    return Boolean(said) && clean(shown.textContent).toLowerCase().includes(said);
  }
  const drawn = chosenOf(select);
  if (!drawn) return true;
  for (const type of ['chosen:updated', 'liszt:updated']) select.dispatchEvent(ours(new Event(type, { bubbles: true })));
  const shown = drawn.cloneNode(true);
  for (const drop of shown.querySelectorAll('.chosen-drop, .chzn-drop')) drop.remove();
  const said = clean(select.selectedOptions?.[0]?.textContent).toLowerCase();
  return Boolean(said) && clean(shown.textContent).toLowerCase().includes(said);
}

/**
 * After a select has been written and announced: whether what stands in for
 * it shows the choice. Where it does not, the select is put back as it was —
 * one that submits one thing and shows another is worse than one left for
 * the person — and false comes back.
 */
function standInTookIt(select, before) {
  if (redrawStandIn(select)) return true;
  nativeSet(select, 'value', before);
  select.dispatchEvent(ours(new Event('input', { bubbles: true })));
  select.dispatchEvent(ours(new Event('change', { bubbles: true })));
  redrawStandIn(select);
  return false;
}

/**
 * Would the browser refuse this control, whoever turned it off?
 *
 * `matches` because a disabled `<fieldset>` disables everything inside it
 * without touching a single descendant's own `disabled` attribute, and an
 * `<option>` inside a disabled `<optgroup>` is the same trick one level down.
 * Guarded because `matches` is not on every node this file walks — a widget's
 * `<div>` reaches `looksLikePlaceholder` too.
 */
function isDisabled(node) {
  return typeof node?.matches === 'function' ? node.matches(':disabled') : Boolean(node?.disabled);
}

/*
 * A control a dropdown keeps for itself beside its button, which no person
 * reaches: hidden from a screen reader (`aria-hidden="true"`) and from the
 * Tab key (`tabindex="-1"`).
 *
 * MUI's Select keeps what it submits in one — a text box, `opacity: 0`, named
 * like the question and holding the chosen option's value — and the box just
 * before it is the Select's own button saying "Select". So it was read as a
 * box labelled "Select" and named `school_name_id`, the profile's words were
 * typed into it, and it was counted filled; MUI takes a value typed there
 * only when it is one of its options' values, and a form over Greenhouse's
 * API gives those as ids, so nothing was chosen. Measured on a fixture drawn
 * as MUI draws itself: School, Degree and Discipline stayed on "Select" and
 * were reported filled, and because they were claimed the Select beside each
 * was never driven — the Country, not an education key, was driven and chose.
 * That is the shape of what Epic Games' form was reported to do.
 *
 * Radix's Select keeps a visually hidden `<select>` beside its button, with
 * no label of its own: read the same way, it was a list labelled by whatever
 * the button showed, "Select" or the last choice. It takes a `change` as a
 * choice, but it also fires one of its own after every choice, so a person's
 * pick — and each one made here — was written down a second time under the
 * button's words as the question: "Northeastern University — Northeastern
 * University".
 *
 * So a text box like that is never typed into, and a select like that — no
 * label of its own, an ARIA dropdown beside it — is not filled, asked or
 * watched as a question: the dropdown is, by `fillComboboxes` and
 * `watchWidgetPicks`, and what it holds is read back as the dropdown's
 * (see `hiddenPartner`). A select with a label of its own is left as it was:
 * select2 hides its select the same way, labels it, and redraws from it.
 */
function isWidgetPartner(el) {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return false;
  if (el.getAttribute('aria-hidden') !== 'true' || el.getAttribute('tabindex') !== '-1') return false;
  if (el instanceof HTMLInputElement) return el.type !== 'hidden';
  // select2's select is the question, labelled or not. See `select2Of`.
  if (select2Of(el)) return false;
  const labelled =
    (el.id && rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
    el.closest('label') ||
    el.hasAttribute('aria-labelledby') ||
    el.hasAttribute('aria-label');
  if (labelled) return false;
  return [...(el.parentElement?.children ?? [])].some(
    (other) => other !== el && (isWidgetChoice(other) || other.querySelector?.('[role="combobox"], [aria-haspopup="listbox"]')),
  );
}

function isFillable(input) {
  /*
   * `:disabled`, not `.disabled`.
   *
   * The property reflects the element's own attribute and nothing else, so a
   * control inside `<fieldset disabled>` reads `false` while the browser
   * treats it as disabled in every way that counts. Forms use that fieldset
   * for the section you have not unlocked yet — "US applicants only", a step
   * you have not reached — and the whole section was filled, reported as
   * filled, and then submitted as nothing at all: `FormData` skips a disabled
   * control. "Filled 3 fields", three empty fields.
   */
  if (isDisabled(input) || input.readOnly) return false;
  /*
   * And a `<select>` marked `readonly`, which the browser ignores and the page
   * does not: it is what a Fabric select keeps behind its button, holding only
   * the choice already made, and was reported as a degree with no matching
   * option beside the list that had one. See `isFabricSelect`.
   */
  if (input instanceof HTMLSelectElement && input.hasAttribute('readonly')) return false;
  if (input.type === 'hidden' || input.type === 'file' || input.type === 'password') return false;
  // What a dropdown keeps beside its button. See `isWidgetPartner`.
  if (isWidgetPartner(input)) return false;
  // Radios are answered as a group, below; checkboxes are consent and are
  // nobody's to tick but the applicant's.
  if (input.type === 'radio' || input.type === 'checkbox') return false;
  /*
   * A combobox is a text input that is not a text field. Half these systems
   * have moved to react-select and its kind, where what the form submits lives
   * in a hidden field only the widget's own code sets — so typing into the
   * visible box fills nothing while looking like it filled something, which is
   * worse than leaving it plainly blank. Reported instead, further down.
   */
  if (isWidgetChoice(input)) return false;
  // Chosen's own search box, which is the list's and not a question. See `chosenOf`.
  if (input.closest?.(CHOSEN)) return false;
  // And select2's. See `select2Of`.
  if (isSelect2Part(input)) return false;
  // `offsetParent` is null for anything positioned fixed, visible or not, and
  // forms inside a fixed modal are ordinary. Whether it occupies space on the
  // page is the question actually being asked. For a select Chosen has
  // hidden, that is asked of what Chosen drew in its place.
  if (input.getClientRects().length === 0 && !(chosenOf(input)?.getClientRects().length > 0)) return false;
  if (BOT_TRAP.test(labelFor(input))) return false;
  return true;
}

/*
 * A box put there to catch robots, which a person is asked to leave empty.
 *
 * Workday's Create Account and Sign In carry one on every tenant: a box named
 * `website`, labelled "Enter website. This input is for robots only, do not
 * enter if you're human.", cut down to a pixel with the same `clip` a
 * screen-reader-only label uses — so it counts as on the page, and `website`
 * matched it. Measured live on NVIDIA's and Intel's with a fake profile that
 * has a website: the address went into the trap, and an account created that
 * way is created by a robot as far as the site can tell. Only a label that
 * says so in words: robots, not a human, a honeypot.
 */
const BOT_TRAP = /\bfor\s+(?:ro)?bots\b|\b(?:ro)?bots?\s+only\b|\bif\s+you(?:'|’|\s+a)?re\s+(?:a\s+)?human\b|\bhoney\s*pot\b/i;

/**
 * Has this dropdown actually been answered?
 *
 * `value` is the wrong question for a select: it is never empty in practice,
 * because the first option is usually a placeholder with a value of its own —
 * "none", "-1", "Select an option". Every such field was being skipped as
 * already filled, which on a real form is most of them.
 */
const PLACEHOLDER = /^(|-+|—+|select.*|choose.*|pick.*|please\b.*|--.*--)$/i;

/*
 * "None" and "N/A" are two things at once.
 *
 * In the slot a browser shows before anyone has chosen, they are a prompt. Two
 * lines down a list, they are an answer — and a true one. Treated as a prompt
 * wherever they sat, "Highest degree completed: None" was quietly replaced with
 * "Bachelor of Science", and a sponsorship question answered "N/A" was
 * overwritten too: a false statement about the applicant, submitted to an
 * employer, and reported as a field successfully filled.
 */
const NONE = /^(none|n\/?a)$/i;

function looksLikePlaceholder(option, select) {
  if (option.disabled) return true;
  const value = String(option.value ?? '').trim();
  const text = (option.textContent ?? '').trim();
  if (PLACEHOLDER.test(value) || PLACEHOLDER.test(text)) return true;
  const first = select?.options?.[0] ?? option.parentElement?.querySelector?.('option');
  return (NONE.test(value) || NONE.test(text)) && first === option;
}

/*
 * Whether it is answered is a question about what is showing, not about which
 * index that is. A select with no placeholder shows its first option from the
 * start — "Canada", say — and overwriting that would be taking a visible
 * answer away; a select showing "Select a city…" has not been answered
 * whatever its index says.
 */
function selectIsAnswered(select) {
  const option = select.selectedOptions?.[0];
  if (!option) return false;
  return !looksLikePlaceholder(option, select);
}

/**
 * Set a property the way the browser does, rather than the way a script does.
 *
 * React puts its own `value` (and, on a radio, `checked`) setter on the element
 * and remembers the last value it saw through it; when an event arrives it
 * compares the two and drops the event if they agree. An ordinary assignment
 * goes through that setter, so React updated its memory and then discarded the
 * change event as a no-op — the control showed the new value until the next
 * render, when React wrote its own state back over it and the form submitted
 * the old one. Reaching past it to the prototype's setter leaves React's memory
 * stale, which is how it tells a real keystroke from nothing having happened.
 *
 * Text inputs already did this. Selects and radios did not, and a fixture
 * carrying React's own value tracker shows the difference: the country dropdown
 * and the work-authorization radio both reported "react-ignores".
 */
function nativeSet(element, property, value) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement
        : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, property)?.set;
  if (setter) setter.call(element, value);
  else element[property] = value;
}

/** Set a value in a way React and friends actually notice. */
/*
 * A date drawn as spin buttons is taken when focus leaves it, and only then.
 *
 * Workday's From and To are a month and a year `role="spinbutton"` box inside
 * one wrapper, and the wrapper reads both boxes into the date — what Save and
 * Continue checks — on the blur that takes focus out of it. Written without
 * focus, as every other box is, the boxes showed 06/2025 and Workday answered
 * "The field From is required and must have a value", for the job's From and
 * To and for the degree's years alike. Measured live on NVIDIA's and Intel's
 * My Experience with a fake profile. Blurred after each box it was worse:
 * the month was taken alone, "Invalid Date: 06/", because focus coming back
 * into the date is sent to its first box and the year's blur never happened.
 *
 * So a spin button is focused before it is written, and focus leaves only
 * after the last box of its date, the way a person tabs through it. Measured
 * live after on Intel: Save and Continue took the From and To.
 */
function setValue(input, value) {
  const spin = input.getAttribute?.('role') === 'spinbutton';
  if (spin) input.focus?.();
  nativeSet(input, 'value', value);
  input.dispatchEvent(ours(new Event('input', { bubbles: true })));
  input.dispatchEvent(ours(new Event('change', { bubbles: true })));
  if (spin && lastBoxOfItsDate(input)) input.blur?.();
}

/*
 * The date's group, and its boxes, as the page draws them.
 *
 * `closest` stops at the root a box is drawn in, and `querySelectorAll` does
 * not open a component, so a date whose boxes are components — the page's
 * `role="group"` round a month and a year each drawn in one, or a date
 * component that is itself the group, its boxes loose in its root — had no
 * group, every box was its date's last, and focus was sent out after the
 * month alone: measured against a wrapper that takes the date on the blur
 * that leaves it, as Workday's does, the date was taken as "May/" where the
 * same boxes written into the page were taken as "May/2026". The nearest
 * group out through each component (see `closestAround`), and its boxes in
 * the order they are drawn (see `drawnWithin`).
 */
function lastBoxOfItsDate(input) {
  const group = closestAround(input, '[role="group"]');
  const boxes = group ? [...drawnWithin(group)].filter((el) => el.matches('[role="spinbutton"]')) : [];
  return !boxes.length || boxes[boxes.length - 1] === input;
}

/**
 * A value the field took now and the browser will refuse at the end.
 *
 * The check after a fill was that the value stuck, which catches the field
 * that throws it away — a phone number assigned to `type=number` leaves the
 * box empty, and that is reported rather than claimed. It does not catch the
 * other half: a field that accepts the text and then fails constraint
 * validation when Submit is pressed.
 *
 *   <input type="tel" pattern="\d{10}" required>  <- Workday, Taleo, iCIMS
 *   profile phone: "(555) 555-5555"
 *
 * `input.value` is exactly what was written, so the old check passes and the
 * card says "Filled 5 fields". Press Submit and the browser refuses the form
 * with "Please match the requested format" against a field the tool said it
 * had done — and `refusedByTheBrowser` in sending.js then correctly declines
 * to record a send, so the application quietly goes nowhere.
 *
 * Read off `validity` rather than `checkValidity()`, which dispatches an
 * `invalid` event the page can see and act on; filling a form must not be
 * something the page can notice.
 *
 * Only the flags this fill could have caused. `valueMissing` cannot be one of
 * them — something was just written — and `customError` belongs to the page,
 * which may have set it before anything here ran.
 */
function browserWouldRefuse(input) {
  const v = input.validity;
  if (!input.willValidate || !v) return false;
  return Boolean(
    v.patternMismatch ||
      v.typeMismatch ||
      v.tooShort ||
      v.stepMismatch ||
      v.rangeOverflow ||
      v.rangeUnderflow ||
      v.badInput,
  );
}

/**
 * The same phone number, written the other ways forms ask for it.
 *
 * Only phones, and deliberately: "(555) 555-5555" and "5555555555" are the
 * same ten digits and every form wants its own punctuation, so rewriting is
 * reading the field's mind rather than changing the answer. An email or a URL
 * that fails validation is wrong rather than punctuated wrong, and guessing at
 * one would put a different address on the application.
 */
const LINKS = new Set(['linkedin', 'github', 'website']);

/*
 * A link box that arrives holding the start of an address — "https://",
 * "https://www.linkedin.com/in/" — has not been answered; the form put that
 * there as a hint. Read as answered, it was left alone and sent as a profile
 * of nothing. A scheme, a host, and at most the site's own path prefix.
 */
/** A phone box holding the country's code and nothing else — "+1", "+44". */
const ONLY_A_DIALLING_CODE = /^\s*\+\d{1,4}\s*$/;

/*
 * A box whose value is its input mask and nothing typed into it:
 * "(___) ___-____", "__/____".
 *
 * A mask that is shown only while the box has focus leaves `value` empty the
 * rest of the time, and those boxes were always filled. One that is always
 * shown writes the mask into `value` from the start — IMask with `lazy:
 * false`, Inputmask with `clearMaskOnLostFocus: false`, and the hand-written
 * masks the enterprise systems put on telephone and date boxes — and such a
 * box read as already answered: measured, the phone box was reported
 * "already filled" and left holding underscores. Only the slots and the
 * punctuation between them, and at least one slot, so a value with a single
 * digit or letter in it is somebody's answer and stays.
 */
const ONLY_A_MASK = /^[\s()\-./+]*_[\s_()\-./+]*$/;

function onlyTheStartOfAnAddress(value) {
  return /^\s*(https?:\/\/)?(www\.)?((linkedin\.com(\/in)?|github\.com)\/?)?\s*$/i.test(value) && /\S/.test(value);
}

/*
 * Workday's LinkedIn box takes the whole address or nothing.
 *
 * Its Social Network URLs ask for the profile in one text box named
 * `linkedInAccount`, and Save and Continue checks it. A profile stores the link
 * as a resume prints it, "linkedin.com/in/…", and measured live with a fake
 * profile on NVIDIA's and Salesforce's My Experience that was refused with
 * "Invalid LinkedIn URL" — and so was "https://linkedin.com/in/…"; only
 * "https://www.linkedin.com/in/…" was taken. The same profile, the same place,
 * written the one way that box accepts. Only that box, and only a link that is
 * plainly LinkedIn's; anything else is written as the profile has it.
 */
const isWorkdayLinkedIn = (input) => input.name === 'linkedInAccount' || input.getAttribute('data-automation-id') === 'linkedInAccount';

function wholeLinkedInAddress(value) {
  const bare = String(value).trim().replace(/^https?:\/\//i, '').replace(/^(?:www\.)?linkedin\.com\b/i, 'linkedin.com');
  return /^linkedin\.com\//i.test(bare) ? `https://www.${bare}` : String(value);
}

function otherWaysToWrite(key, value) {
  const said = String(value).trim();

  /*
   * A link, with the scheme a `type=url` field insists on.
   *
   * A profile stores "github.com/Morgan-Testwell", because that is what goes on
   * a resume — nobody prints the https://. A `type=url` input refuses it, and
   * before this the field was filled, reported as filled, and then blocked the
   * submit. Adding the scheme does not change where the link goes.
   */
  if (LINKS.has(key)) {
    return /^[a-z][a-z0-9+.-]*:/i.test(said) ? [] : [`https://${said}`];
  }

  /*
   * A state as its two letters, for the box that has room for no more. See
   * `fitsIn`: "Massachusetts" in a `maxlength=2` State box went in whole.
   */
  if (key === 'address_state') {
    const code = REGION_BY_NAME[said.toLowerCase()];
    return code ? [code] : [];
  }

  if (key !== 'phone') return [];
  const digits = said.replace(/\D+/g, '');
  if (!digits || digits === said) return [];
  const out = [digits];
  // A number stored with a country code keeps it where the form takes one.
  if (said.startsWith('+')) out.unshift(`+${digits}`);
  // And without it, for the forms that want exactly ten.
  if (digits.length === 11 && digits.startsWith('1')) out.push(digits.slice(1));
  return out;
}

/*
 * Whether a value fits in the room a box gives it.
 *
 * `maxlength` stops a person's typing and nothing else: a value written by
 * script goes in whole, however long, and the browser does not count it as
 * too long when Submit is pressed either — `tooLong` is only ever set by an
 * edit a person made. So "(555) 010-0199" went into a phone box with
 * `maxlength=10`, and "Massachusetts" into a State box with `maxlength=2`,
 * each reported as filled, each a value nobody could have typed there. The
 * page's own checks (jQuery Validate's `maxlength` rule, and the server's
 * column behind the box) are the ones that then refuse it, after the card has
 * said it was done. A shorter way of writing the same answer is used where
 * there is one — see `otherWaysToWrite` — and otherwise the box is left.
 */
const fitsIn = (input, value) => !(input.maxLength > 0 && String(value).length > input.maxLength);

/*
 * A telephone number asked in two or three boxes: area code, exchange and
 * line, `(___) ___ - ____`, each with a `maxlength` of its own.
 *
 * The enterprise and government systems still ask it that way, and every box
 * matched `phone` — by its label, or by names like `phone_area`,
 * `phone_prefix` and `phone_line` — so each was given the whole number:
 * "(555) 010-0199" three times over, in boxes with room for 3, 3 and 4
 * characters. An "Area code" box beside a "Phone number" box was the other
 * half of the same shape: the area code is left alone as a dialling code (see
 * `DIALLING_CODE`), and the number box, `maxlength=7`, was given all ten
 * digits, so the area code went in twice and in the wrong box.
 *
 * The boxes are the ones on either side of this one with nothing between
 * them, in its own wrapper or the two around it: each a one-line box with a
 * `maxlength`, and each either saying nothing of its own or saying it is part
 * of a telephone number. A country code or an extension ends the run — the
 * first is the form's, and the second is not in the number. Two or three
 * boxes: every box but the last takes exactly as many digits as it holds, no
 * more than four, and the last takes the rest, which have to fit and be no
 * fewer than the box before took — 3 + 3 + 4 or 3 + 7 for a ten-digit number.
 * So an unlabelled `+[__]` in front of the three boxes, which would leave
 * one digit for the last, makes the run a shape this cannot be sure of.
 * Anything else is left for the person rather than guessed across the boxes.
 */
const ONE_LINE_BOX = new Set(['text', 'tel', 'number', 'search']);

function partOfTheNumber(input) {
  if (!ONE_LINE_BOX.has(input.type) || !(input.maxLength > 0) || !isFillable(input)) return false;
  const said = describeField(input);
  if (!said) return true;
  if (/\b(country|ext(ension)?)\b/i.test(said)) return false;
  return /\barea\b/i.test(said) || FIELD_PATTERNS.find(([, re]) => re.test(said))?.[0] === 'phone';
}

function nationalDigits(value) {
  const said = String(value).trim();
  const coded = /^\+\d{1,4}[\s.\-)]+(.*)$/.exec(said);
  if (coded) return coded[1].replace(/\D/g, '');
  const digits = said.replace(/\D/g, '');
  return /^\+1\d{10}$/.test(said.replace(/[^\d+]/g, '')) ? digits.slice(1) : digits;
}

/*
 * The boxes in `scope` in the order the page draws them, as a run of a
 * telephone number is read from them.
 *
 * A component drawing one box stands for that box, where the page put the
 * component: `(<x-input maxlength="3">) <x-input maxlength="3"> - <x-input
 * maxlength="4">` is three boxes in a row, as the same `<input>`s are. A
 * component drawing more than one is a thing of its own, and stands in the
 * row as itself, which is no part of any number: its boxes are one question
 * it asks, read inside it (see `phoneBoxes`), and never joined to a box
 * beside it that some other component or the page draws. What is slotted
 * into a component is where the slot is.
 */
function boxesDrawnIn(scope) {
  const out = [];
  const walk = (node) => {
    const put = node.localName === 'slot' && hostOf(node) ? node.assignedElements() : [];
    for (const el of put.length ? put : [...node.children]) {
      if (el.matches(ANOTHER_FIELD)) out.push(el);
      else if (!el.shadowRoot || el.id === OURS) walk(el);
      else if (fieldsIn(el.shadowRoot, ANOTHER_FIELD, 2) > 1) out.push(el);
      else walk(el.shadowRoot);
    }
  };
  walk(scope);
  return out;
}

/*
 * And out of the component the box is drawn in.
 *
 * `querySelectorAll` does not reach into a component and `parentElement`
 * stops at its root, so a number asked in boxes drawn in components was no
 * run at all: each box, `maxlength` 3 or 4, was given the whole number, which
 * did not fit, and was reported as refusing it. Measured, the three boxes of
 * `(___) ___-____` each drawn in a component, an Area code and a seven-digit
 * number each drawn in one, and one component drawing all three boxes loose
 * in its root, were all left empty and reported three times over, where the
 * same boxes written into the form took 555, 010 and 0199.
 *
 * The root is one more wrapper, and costs none of the three, which are the
 * page's. From a root holding only this box the run is read on outside, from
 * the component, as `labelFor` climbs; from a root holding more the run is
 * the root's, and nothing outside is part of it (see `boxesDrawnIn`).
 */
function phoneBoxes(input, value) {
  const digits = nationalDigits(value);
  let scope = containerOf(input);
  for (let i = 0; i < 3 && scope && scope !== document.body; ) {
    // Only the boxes a person can see; a component stands in the row whether or not its host has a box of its own.
    const fields = boxesDrawnIn(scope).filter((el) => !el.matches(ANOTHER_FIELD) || el.getClientRects().length > 0);
    const at = fields.indexOf(input);
    let first = at;
    let last = at;
    while (first > 0 && partOfTheNumber(fields[first - 1])) first--;
    while (last < fields.length - 1 && partOfTheNumber(fields[last + 1])) last++;
    const run = fields.slice(first, last + 1);
    if (run.length >= 2) {
      const heads = run.slice(0, -1).map((box) => box.maxLength);
      const taken = heads.reduce((a, b) => a + b, 0);
      const rest = digits.length - taken;
      if (run.length <= 3 && heads.every((n) => n <= 4) && rest >= heads[heads.length - 1] && rest <= run[run.length - 1].maxLength) {
        let from = 0;
        return run.map((box, n) => {
          const part = n < heads.length ? digits.slice(from, from + heads[n]) : digits.slice(from);
          from += part.length;
          return [box, part];
        });
      }
      // The boxes, with nothing to put in them: one number, reported once.
      return run.map((box) => [box, null]);
    }
    if (scope.localName === 'form') break;
    if (scope instanceof ShadowRoot) {
      if (scope.host.id === OURS || fieldsIn(scope, ANOTHER_FIELD, 2) > 1) break;
      scope = containerOf(scope.host);
    } else {
      scope = containerOf(scope);
      i++;
    }
  }
  return null;
}

/**
 * Which section of the form a field sits in, as its heading says.
 *
 * The fieldset's legend where there is one, since that is the section saying
 * so outright. Otherwise the last heading before the field — and only
 * headings inside the same form, because the page's own title is not a
 * section: a posting for "Software Engineer, Education Technology" would
 * otherwise make every date on its job-history step an education date.
 *
 * A legend only for the fieldset it heads. The walk below took the legend of
 * any fieldset that came earlier as the heading of everything after it, so
 * once an "Education" fieldset had closed, "Available start date" beneath it
 * was given the degree's start and "Notice period end date" its graduation —
 * an availability the applicant never stated, and one already past.
 */
const HEADING = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';

/*
 * Where a heading's section ends, when the markup says.
 *
 * A heading with no fieldset has no edge of its own, and "the last heading
 * before the field" held it open to the end of the form. Measured, on a form
 * built as one wrapper per section: an `<h3>Education</h3>` block, then a
 * block holding only "Available start date" — which was given the degree's
 * start, "September 2022" — and a Work Experience block whose plain
 * "Location" and "City" were given the applicant's own home.
 *
 * The edge is the heading's wrapper: its parent, or the nearest ancestor that
 * holds a control, so a heading wrapped on its own in a header `div` is
 * measured by the section around it. Only a wrapper smaller than the form,
 * and not one holding another heading of the same rank or higher — that is a
 * page, not a section. A flat form, where every heading is a sibling of every
 * field, has no edge to read, and there nothing changes: the last heading
 * before the field is still the answer, because the form's own `Employment
 * history` heading is followed by unrelated questions on the same level and
 * there is no telling where it stopped.
 */
const A_CONTROL =
  'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]), select, textarea';
const rankOf = (heading) =>
  /^h[1-6]$/.test(heading.localName) ? Number(heading.localName[1]) : Number(heading.getAttribute('aria-level')) || 2;

/*
 * "Holds a control" counts the ones drawn in components (see `fieldsIn`): a
 * section whose boxes are all components holds none that `querySelector`
 * can see, so its heading's wrapper was never found, the climb ran on to the
 * form, and the heading was nobody's bound.
 *
 * And as the page draws it (see `drawnWithin`): the heading may be drawn in
 * a component — `<x-heading>` whose root is an `<h3>`, or `<x-section>`
 * whose root is `<section><h3>…</h3><slot></slot></section>` round the
 * page's own fields — and its wrapper is then found by climbing out of the
 * component, or is the component's `<section>` holding what is slotted in.
 */
function sectionBoxOf(heading) {
  let box = parentAround(heading);
  while (box && !drawsAny(box, A_CONTROL)) box = parentAround(box);
  if (!box || box.localName === 'form' || box.localName === 'body' || box.localName === 'html') return null;
  const rank = rankOf(heading);
  for (const other of drawnWithin(box)) {
    if (!other.matches(HEADING)) continue;
    if (other === heading || other.localName === 'legend') continue;
    if (rankOf(other) <= rank) return null;
  }
  return box;
}

/**
 * The heading a field sits under, and whether the markup bounds it.
 *
 * Headings whose wrapper has already closed are passed over; see
 * `sectionBoxOf`. `bounded` is whether the one found has a wrapper holding the
 * field, which is the only case where it is evidence about the field rather
 * than about the form.
 */
/*
 * For a field drawn in a component, from the component in the form's own
 * tree. Neither `closest('form')` nor `contains` nor `compareDocumentPosition`
 * sees through a shadow root — to `compareDocumentPosition` a box in a
 * component is in another tree, before nothing and after nothing — so it had no
 * heading over it at all: measured, a City and a Phone drawn in components
 * under a bounded "Work Experience" heading were given the applicant's own
 * home and number, where the same boxes written straight into the form were
 * left for the person as a past job's.
 *
 * And the headings a component draws. `querySelectorAll` from the form sees
 * none drawn in a component's root — `<x-heading text="Work Experience">`
 * whose root is the `<h3>`, or `<x-section heading="Work Experience">` whose
 * root is `<section><h3>…</h3><slot></slot></section>` round the page's own
 * boxes — and a box slotted into a component is before or after nothing
 * there either. Measured, a City under either was given the applicant's
 * home, where under the same `<h3>` written into the form it was left for
 * the person as a past job's; and an "End date year" after an Education
 * heading drawn in a component was left empty, where after the page's own
 * `<h3>Education</h3>` it was the graduation year. So the form is walked as
 * it is drawn (see `drawnWithin`), up to the field, and "inside" is where
 * the field is drawn (see `drawnInside`). In a form without components that
 * is the same walk, in the same order, as before.
 */
function headingOver(input) {
  const scope = closestAround(input, 'form');
  if (!scope) return null;
  let found = null;
  for (const heading of drawnWithin(scope)) {
    if (heading === input) break;
    if (!heading.matches(HEADING)) continue;
    if (heading.localName === 'legend') {
      if (heading.parentElement && drawnInside(heading.parentElement, input)) found = { heading, bounded: false };
      continue;
    }
    const box = sectionBoxOf(heading);
    if (box && !drawnInside(box, input)) continue;
    found = { heading, bounded: Boolean(box) };
  }
  return found;
}

function sectionOf(input) {
  // Out of the components the field is drawn in: see `closestAround`.
  const legend = closestAround(input, 'fieldset')?.querySelector(':scope > legend');
  if (legend) return clean(legend.textContent);
  return clean(headingOver(input)?.heading.textContent ?? '');
}

/**
 * The section heading over a field, only where its wrapper says the field is
 * in it. See `sectionBoxOf`, and `isNotAboutYou`, which is what reads it.
 */
function boundedSection(input) {
  const over = headingOver(input);
  return over?.bounded ? clean(over.heading.textContent).slice(0, 200) : '';
}

const EDUCATION_SECTION = /\b(education|academic\w*|schools?|degrees?)\b/i;

/**
 * "Start date" and "End date", when they are the degree's.
 *
 * The Education block of a Greenhouse form asks for both ends of the degree in
 * words that say nothing about education — "Start date month", "End date year"
 * — and a job-history block asks the same words about every job. Read on their
 * own they are unanswerable; read with the section's heading they are the
 * start of the degree and its graduation. Anywhere that is not plainly an
 * education section they are left alone, exactly as before.
 */
function educationDateKey(input, description) {
  const key = educationDatePart(description);
  if (!key || !EDUCATION_SECTION.test(sectionOf(input))) return graduationPartKey(input);
  return key;
}

/*
 * A graduation date asked as a group of boxes, each labelled only with its
 * part: GOV.UK's date input and the forms built like it, a `<fieldset>` whose
 * `<legend>` asks "When did you graduate?" or "Expected graduation date" over
 * a box or a list labelled "Month" and another labelled "Year".
 *
 * Every pattern here reads a field's own words, and "Month" and "Year" say
 * nothing about which date, so both were left empty and unreported beside a
 * profile holding the graduation. The question is the group's, and it is only
 * read when the box's own label is nothing but a date part, so the legend is
 * never a description of an ordinary box under it (see `surroundingWords`).
 * The group says which date, and only a graduation is filled: a date of birth
 * or an availability asked the same way matches no pattern. The box says
 * which part, so "Month" under "Graduation month and year" is still the
 * month. A "Day" box is left alone, as a guessed day is a guess.
 */
const DATE_PART = { month: /^(month|mm)$/i, year: /^(year|yyyy|yy)$/i };

function graduationPartKey(input) {
  const own = withoutMarkers(labelFor(input)) || clean(input.placeholder);
  const part = Object.keys(DATE_PART).find((p) => DATE_PART[p].test(own));
  if (!part) return null;
  // Out of the components the box is drawn in: see `closestAround`.
  const legend = closestAround(input, 'fieldset')?.querySelector(':scope > legend');
  const group = closestAround(input, '[role="group"]');
  /*
   * `fromLabelledBy` only for a group there is. A box whose words are "Month"
   * or "MM" with no fieldset and no group anywhere around it is ordinary — a
   * card's expiry, a date asked as two loose boxes — and handing it `null`
   * threw, which took the whole of `fillForm` with it: measured, a form with
   * a First name box and a box labelled Month beside it filled nothing and
   * reported nothing.
   */
  const asked = clean(legend?.textContent) || clean(group?.getAttribute('aria-label')) || (group ? fromLabelledBy(group) : '');
  const found = asked ? FIELD_PATTERNS.find(([, re]) => re.test(asked))?.[0] : null;
  return /^graduation_(month|year|date)$/.test(found ?? '') ? `graduation_${part}` : null;
}

/*
 * Which end of a degree, and which part of that date, words like these ask
 * for — whether or not anything says they are about a degree. Only for a
 * caller that already knows: `educationDateKey` asks the section, and
 * `fillEducation` has the Education section in hand.
 */
function educationDatePart(description) {
  if (!/\b(date|month|year)\b/i.test(description)) return null;
  /*
   * Workday says neither: its education block asks for the "First Year
   * Attended" and the "Last Year Attended (Actual or Expected)", and both were
   * left empty. First and last only beside "attended", so "First name" and a
   * "Last updated" note are not dates of a degree.
   */
  const which = /\b(start\w*|from|began|begin\w*)\b|\bfirst\b.{0,20}\battend/i.test(description)
    ? 'start'
    : /\b(end\w*|to|until|finish\w*|complet\w*)\b|\blast\b.{0,20}\battend/i.test(description)
      ? 'end'
      : null;
  if (!which) return null;
  const part = /\bmonth\b/i.test(description) ? 'month' : /\byear\b/i.test(description) ? 'year' : 'date';
  return which === 'start' ? `education_start_${part}` : `graduation_${part}`;
}

/*
 * A school, a degree, a major, a grade or a date asked about one level of
 * study, when the profile's education is at another.
 *
 * The profile holds one education, the newest, and the forms that ask for
 * more than one say which they mean: "Undergraduate School", "Undergraduate
 * GPA", "Bachelor's Major", "Graduate School", "PhD Institution". Measured
 * against a profile holding a Master of Science: every one of those was given
 * the master's — its university as the undergraduate school, its grade as the
 * undergraduate GPA, "Master of Science" as the undergraduate degree — and
 * against a bachelor's, "Graduate GPA" was given the bachelor's grade. A
 * statement about a degree the applicant may not hold, on the part of the form
 * an employer checks against a transcript.
 *
 * So a field that names a level is filled only when the profile's degree is at
 * that level; with no level to compare, it is left blank, and a field that
 * names none is unaffected. Read from the label and its group, with asides in
 * parentheses taken out — "Degree (e.g. Bachelor's)" names an example, not a
 * level — and never from a placeholder, which is where the examples go.
 * "Graduate" only as an adjective in front of what it qualifies, so
 * "Graduation date" and "Expected graduate year" are not a level.
 */
const EDUCATION_KEYS = /^(school|degree|major|gpa|graduation_\w+|education_start_\w+)$/;
const ASKS_A_LEVEL = [
  ['associate', /\bassociate'?s?[\s_-]+degree\b/i],
  ['bachelor', /\bundergrad\w*|\bbachelor'?s?\b/i],
  ['master', /\bmaster'?s?\b|\bmasters\b/i],
  ['doctorate', /\bph\.?\s?d\b|\bdoctora(?:te|l)\b/i],
  ['graduate', /\b(?:post[\s_-]?)?graduate[\s_-]+(?:school|gpa|degree|program\w*|studies|study|institution|university|college|major|education)\b/i],
];

function anotherLevelOfStudy(input, key, fields) {
  if (!EDUCATION_KEYS.test(key)) return false;
  const said = `${surroundingWords(input)} ${labelFor(input)}`.replace(/\([^)]*\)/g, ' ').replace(/[’]/g, "'");
  const asked = ASKS_A_LEVEL.filter(([, re]) => re.test(said)).map(([level]) => level);
  if (asked.length === 0) return false;
  const held = degreeLevel(fields.degree ?? '');
  if (!held) return true;
  return !asked.some((level) => level === held || (level === 'graduate' && (held === 'master' || held === 'doctorate')));
}

/** Two option labels are the same answer if they read the same. */
const sameOption = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Which month an option means, however it is spelled: "December", "Dec",
 * "Dec.", "Sept", "12", "01", "12 - December". Null for anything else.
 *
 * A month dropdown is the one list where the same answer has four common
 * spellings and every form picks a different one, so matching the store's
 * "December" as text found nothing on a form listing "Dec" and the box was
 * left empty. Three letters at least, so "Ma" is not taken for March or May.
 */
/**
 * The months a written date could mean, as "YYYY-MM" — two for "05/01/2027",
 * which is the first of May or the fifth of January depending on who wrote it.
 * Empty for anything that is not plainly a date with a month and a year.
 */
function monthsMeant(text) {
  const said = clean(text);
  const at = (y, m) => (m >= 1 && m <= 12 ? [`${y}-${String(m).padStart(2, '0')}`] : []);
  let hit;
  if ((hit = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(said))) return at(hit[1], Number(hit[2]));
  if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(said))) return [...at(hit[3], Number(hit[1])), ...at(hit[3], Number(hit[2]))];
  if ((hit = /^(\d{1,2})[/.-](\d{4})$/.exec(said))) return at(hit[2], Number(hit[1]));
  if ((hit = /^([A-Za-z]{3,})\.?,?\s+(?:\d{1,2},?\s+)?(\d{4})$/.exec(said))) return at(hit[2], monthOf(hit[1]) ?? 0);
  return [];
}

/**
 * Whether a date box that rewrote what it was given still holds that month.
 *
 * A date picker takes what is typed and writes it back its own way: Notion's
 * Ashby form turns the graduation date into "05/01/2027". The box held the
 * right date and the card said it would not take it, because what it held was
 * not, letter for letter, what was typed. The same month and year, however
 * written, is the date going in; anything else is still a refusal.
 */
function sameMonthWritten(shown, given) {
  const want = monthsMeant(given);
  return want.length === 1 && monthsMeant(shown).includes(want[0]);
}

export function monthOf(text) {
  const said = clean(text).toLowerCase();
  if (!said) return null;
  const number = /^0?(\d{1,2})(?!\d)/.exec(said);
  if (number) {
    const n = Number(number[1]);
    return n >= 1 && n <= 12 ? n : null;
  }
  const word = /^[a-z]+/.exec(said)?.[0] ?? '';
  if (word.length < 3) return null;
  const at = MONTH_NAMES.findIndex((m) => m.startsWith(word));
  return at === -1 ? null : at + 1;
}

/*
 * The same place, spelled the ways lists spell it.
 *
 * A store holds "MA" and "United States"; a State list says "Massachusetts" and
 * a Country list says "United States of America", which is Workday's spelling
 * and plenty of others'. Exact matching found neither, so the two most-asked
 * dropdowns on a US application were left for the person on most forms.
 *
 * A table rather than anything fuzzier, because these are facts with a closed
 * list of answers: the fifty states, DC and Puerto Rico, Canada's provinces and
 * territories, and the handful of countries whose long official names are what
 * the lists use. Nothing outside the table is treated as the same.
 */
const REGIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const REGION_BY_NAME = Object.fromEntries(Object.entries(REGIONS).map(([code, name]) => [name.toLowerCase(), code]));

const COUNTRY_SPELLINGS = [
  ['united states', 'united states of america', 'usa', 'u.s.a.', 'us', 'u.s.'],
  ['united kingdom', 'united kingdom of great britain and northern ireland', 'uk', 'u.k.', 'great britain'],
  ['south korea', 'korea, republic of', 'republic of korea'],
];

/** One spelling for everything the table says is the same place. */
function placeKey(key, text) {
  /*
   * An aside at the end is not part of the name: "(+1)", and the dialling
   * code Greenhouse writes after every country in its phone's country list —
   * "United States +1" — which "United States" never matched, so the required
   * Country beside the phone number was left empty.
   */
  const said = clean(text).toLowerCase().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+\+\d{1,4}$/, '');
  if (key === 'address_state') {
    const code = said.toUpperCase();
    if (REGIONS[code]) return code;
    return REGION_BY_NAME[said] ?? null;
  }
  if (key === 'address_country') {
    const group = COUNTRY_SPELLINGS.findIndex((names) => names.includes(said));
    return group === -1 ? null : `country:${group}`;
  }
  return null;
}

/**
 * The level a degree is at, from however it is written — or nothing.
 *
 * An MBA is left out on purpose: it is a master's, and a list offering both
 * "Master's Degree" and "MBA" means the person should say which.
 */
const DEGREE_LEVELS = [
  ['associate', /\bassociate\b|\bassociate'?s\b/i],
  ['bachelor', /\bbachelor|\bundergraduate\b|\bb\.?\s?(?:s|a|sc|eng|e)\.?(?=\s|,|$)/i],
  ['master', /\bmaster|\bm\.?\s?(?:s|a|sc|eng)\.?(?=\s|,|$)/i],
  ['doctorate', /\bph\.?\s?d\b|\bdoctor of philosophy\b|\bdoctora(?:te|l)\b/i],
];
function degreeLevel(text) {
  const said = clean(text);
  if (/business administration|\bm\.?\s?b\.?\s?a\b/i.test(said)) return null;
  return DEGREE_LEVELS.find(([, re]) => re.test(said))?.[0] ?? null;
}

/**
 * An option that names a level and nothing else: "Bachelor's Degree",
 * "Masters", "Doctorate", "Undergraduate degree". Only these take a degree by
 * its level — "Bachelor of Arts" is a degree of its own, and a Bachelor of
 * Science is not it.
 */
const LEVEL_ONLY =
  /^(?:associate|bachelor|master|doctorate|doctoral|ph\.?\s?d\.?|undergraduate)(?:'?s)?(?:\s+degree)?$/i;

/**
 * Whether an option is this answer under a different spelling — for the
 * fields where a spelling table exists, and only those. Consulted after an
 * exact match has failed, never instead of one.
 */
/**
 * A location dropdown that lists countries, or cities, and not "Boston, MA".
 *
 * The location is kept as the whole place, and a list of places holds only
 * one part of it: Spotify's Lever form asks "What is your location?" with a
 * list of countries, and the whole "Boston, MA" matched none of them, so a
 * required question was left for the person with the answer in the profile.
 * The country first, then the city — each only as the list spells it, or as
 * the country is otherwise spelled, never a guess.
 */
function locationPart(choosable, fields) {
  for (const [part, value] of [['address_country', fields.address_country], ['address_city', fields.address_city]]) {
    if (!clean(value ?? '')) continue;
    const found = choosable.find(
      (o) => sameOption(o.textContent, value) || sameAnswerSpelledOtherwise(part, o.textContent, value),
    );
    if (found) return found;
  }
  return null;
}

function sameAnswerSpelledOtherwise(key, option, value) {
  /*
   * A degree against a list of levels, which is what Greenhouse asks with:
   * "Associate's Degree", "Bachelor's Degree", "Master's Degree". The store
   * words the degree as the diploma does, so nothing matched and the box was
   * left empty on every Greenhouse form.
   */
  if (key === 'degree') {
    // Or filed under where it is earned, as BambooHR lists them: "College -
    // Bachelor of Science", "College - Associates". Read without the heading.
    const said = clean(option).replace(/^(?:college|university)\s*[-–—:]\s+/i, '');
    if (said !== clean(option) && sameOption(said, value)) return true;
    const level = degreeLevel(value);
    return Boolean(level) && LEVEL_ONLY.test(said.replace(/[’]/g, "'")) && degreeLevel(said) === level;
  }
  if (key === 'graduation_month' || key === 'education_start_month') {
    const month = monthOf(value);
    return Boolean(month) && month === monthOf(option);
  }
  /*
   * A graduation date against a list of them, spelled another way. Campus
   * recruiting forms ask by term — "Spring 2027" — and others by number —
   * "05/2027" — and "May 2027" matched neither, so the box was left empty.
   * The terms are the academic ones: a May graduation is Spring, August is
   * Summer, December is Fall. Winter only for January and February, where no
   * other term claims the month.
   */
  if (key === 'graduation_date') {
    const hit = /^([a-z]+)\s+(\d{4})$/i.exec(String(value).trim());
    const month = hit ? monthOf(hit[1]) : null;
    if (!month) return false;
    const year = hit[2];
    const said = clean(option);
    const monthFirst = /^(\d{1,2})\s*[/.\-]\s*(\d{4})$/.exec(said);
    const yearFirst = /^(\d{4})\s*[/.\-]\s*(\d{1,2})$/.exec(said);
    if (monthFirst) return Number(monthFirst[1]) === month && monthFirst[2] === year;
    if (yearFirst) return Number(yearFirst[2]) === month && yearFirst[1] === year;
    const named = /^([a-z]+)\.?,?\s+(\d{4})$/i.exec(said);
    if (!named || named[2] !== year) return false;
    if (monthOf(named[1])) return monthOf(named[1]) === month;
    const term = named[1].toLowerCase();
    const TERM_MONTHS = { spring: [3, 4, 5], summer: [6, 7, 8], fall: [9, 10, 11, 12], autumn: [9, 10, 11, 12], winter: [1, 2] };
    return (TERM_MONTHS[term] ?? []).includes(month);
  }
  const wanted = placeKey(key, value);
  return Boolean(wanted) && wanted === placeKey(key, option);
}

/*
 * A GPA against a list of bands.
 *
 * Grade dropdowns list ranges — "3.50 - 3.74", "3.75 - 4.00" — or thresholds
 * — "3.0+", "3.5 and above", "Less than 3.0" — and the store holds the grade
 * as one number, "3.8", which matched none of them, so the box was left empty.
 *
 * The band that holds the grade, and of those the tightest: the highest lower
 * bound, then the narrowest. A threshold list holds a 3.8 in "2.5+", "3.0+"
 * and "3.5+" alike, and every one of them is true; only the last says what
 * the grade is. A bare number is a band of one, so "3.80" is the option "3.8"
 * — compared as numbers, never rounded. Nothing for a grade above 4: the
 * bands are written on a four-point scale, and a grade out of ten is not on
 * one.
 */
const GRADE = String.raw`(\d(?:\.\d{1,3})?)`;
const GPA_BANDS = [
  // "3.50 - 3.74", "3.5–3.74", "3.5 to 3.74"
  [new RegExp(String.raw`^${GRADE}\s*(?:-|–|—|to)\s*${GRADE}$`, 'i'), (lo, hi) => ({ lo, hi })],
  // "3.5+", "3.5 and above", "3.5 or higher"
  [new RegExp(String.raw`^${GRADE}\s*(?:\+|and above|or above|and higher|or higher|or more)$`, 'i'), (lo) => ({ lo, hi: 4 })],
  // "at least 3.5", "minimum 3.5"
  [new RegExp(String.raw`^(?:at least|minimum(?: of)?)\s*${GRADE}$`, 'i'), (lo) => ({ lo, hi: 4 })],
  // "above 3.5", "over 3.5", "greater than 3.5"
  [new RegExp(String.raw`^(?:above|over|greater than|more than)\s*${GRADE}$`, 'i'), (lo) => ({ lo, hi: 4, loOpen: true })],
  // "below 2.0", "under 2.0", "less than 2.0"
  [new RegExp(String.raw`^(?:below|under|less than)\s*${GRADE}$`, 'i'), (hi) => ({ lo: 0, hi, hiOpen: true })],
  // "3.8"
  [new RegExp(String.raw`^${GRADE}$`), (at) => ({ lo: at, hi: at })],
];

/** The range an option states, or null when it states none. */
function gpaBand(option) {
  /*
   * With its scale written beside each grade — "3.8 out of 4.0", as SpaceX
   * lists every one, or "3.5/4.0 - 4.0/4.0" — read off and set aside. Only a
   * scale of four: a band out of five is not where a four-point grade goes.
   */
  const OUT_OF = /\s*(?:\/|out\s+of)\s*(\d+(?:\.\d+)?)/gi;
  const scales = [...clean(option).matchAll(OUT_OF)].map((m) => Number(m[1]));
  if (scales.some((scale) => scale !== 4)) return null;
  const said = clean(option).replace(OUT_OF, '').replace(/\s+/g, ' ');
  for (const [re, band] of GPA_BANDS) {
    const hit = re.exec(said);
    if (hit) return band(...hit.slice(1).map(Number));
  }
  return null;
}

/*
 * A place, from a search of places, by the city, state and country the
 * profile holds.
 *
 * Greenhouse's "Location (City)" searches places as it is typed into and
 * answers "Boston, Massachusetts, United States", "Boston, New York, United
 * States", "Boston, England, United Kingdom" — none of them the stored
 * "Boston", so it was left for the person. The one whose city is this city,
 * whose state is this state by its code or its name, and whose country, where
 * it names one, is this country — and only when exactly one is. A city with no
 * state to tell it from its namesakes is still the person's to choose.
 */
function placeOption(options, fields, textOf = (o) => o.textContent) {
  const city = clean(fields?.address_city).toLowerCase();
  const state = placeKey('address_state', fields?.address_state ?? '');
  const country = placeKey('address_country', fields?.address_country ?? '');
  if (!city || !state) return null;
  const hits = options.filter((option) => {
    const parts = clean(textOf(option)).split(/\s*,\s*/);
    if (parts.length < 2 || parts[0].toLowerCase() !== city) return false;
    if (placeKey('address_state', parts[1]) !== state) return false;
    return parts.length < 3 || !country || placeKey('address_country', parts[parts.length - 1]) === country;
  });
  return hits.length === 1 ? hits[0] : null;
}
const PLACE_KEYS = new Set(['address_city', 'city_state', 'location']);

/** The option whose band holds this grade most tightly, or null. */
function gpaOption(options, value, textOf = (o) => o.textContent) {
  const said = clean(value);
  if (!/^\d(?:\.\d{1,3})?$/.test(said) || Number(said) > 4) return null;
  const grade = Number(said);
  const holds = (b) => (b.loOpen ? grade > b.lo : grade >= b.lo) && (b.hiOpen ? grade < b.hi : grade <= b.hi);
  let best = null;
  for (const option of options) {
    const band = gpaBand(textOf(option));
    if (!band || !holds(band)) continue;
    if (!best || band.lo > best.band.lo || (band.lo === best.band.lo && band.hi < best.band.hi)) best = { option, band };
  }
  return best?.option ?? null;
}

/**
 * "December 2026" written the way this particular box wants it.
 *
 * A `type=month` input takes "2026-12" and nothing else — assigning the
 * readable form leaves it empty and raises nothing. A box whose placeholder
 * says MM/YYYY will usually be checked against that shape when the form is
 * sent. Anything else gets the readable form, which a person would type.
 * Never a day: `type=date` wants one, and a guessed day is a guess.
 */
export function graduationFor(input, value) {
  const hit = /^([a-z]+)\s+(\d{4})$/i.exec(String(value).trim());
  const month = hit ? monthOf(hit[1]) : null;
  if (!month) return value;
  const year = hit[2];
  const mm = String(month).padStart(2, '0');
  if (input.type === 'month') return `${year}-${mm}`;
  /*
   * The label too, which is where most forms that want a shape say so:
   * "Graduation date (MM/YYYY)" over a bare box was given "December 2026" and
   * reported as filled — the one shape its own label said it would not take.
   */
  const hint = `${input.placeholder ?? ''} ${input.getAttribute?.('aria-label') ?? ''} ${labelFor(input)}`.toLowerCase();
  if (/yyyy\s*-\s*mm/.test(hint)) return `${year}-${mm}`;
  if (/mm\s*\/\s*yyyy/.test(hint)) return `${mm}/${year}`;
  if (/mm\s*\/\s*yy\b/.test(hint)) return `${mm}/${year.slice(2)}`;
  return value;
}

/**
 * A month box that wants the month as a number: a placeholder of "MM", a
 * `type=number`, a numeric keypad, or no room for more than two characters.
 *
 * Reported on an education block asking "Start Date (Month)" and "End Date
 * (Month)" over boxes whose placeholder is MM: both were left empty beside
 * years that had gone in. The profile's month is a word, "September", and a
 * box like that takes "09".
 */
function asksMonthAsNumber(input) {
  if (input.type === 'number' || input.inputMode === 'numeric') return true;
  if (input.maxLength > 0 && input.maxLength <= 2) return true;
  return /^\s*mm\s*$/i.test(input.placeholder ?? '');
}

/** "September" as "09"; anything that is not a month, as it was. */
function monthAsNumber(value) {
  const month = monthOf(value);
  return month ? String(month).padStart(2, '0') : value;
}

/**
 * Reading a yes/no answer out of a profile that holds a sentence.
 *
 * Measured, and it is the worst miss in the file: a form asking "Are you
 * legally authorized to work in the US?" with Yes and No beside it, against a
 * profile whose `work_authorization` reads "Authorized to work in the US",
 * matched no option and was left blank. That is the one question most likely
 * to get an application rejected without a person reading it, and it was
 * being skipped on every form that asks it as a choice rather than a box —
 * which is nearly all of them, because it is a legal declaration.
 *
 * The profile holds a sentence because the field is a free-text box and a
 * sentence is what people type in one.
 *
 * Deliberately narrow, because the cost here is not a blank field but a false
 * declaration about the applicant's right to work, made in their name:
 *
 *   Only where the options really are a yes/no pair. A three-way list, or a
 *   list of visa categories, is not this question and is left alone.
 *
 *   Only for the two keys that *are* yes/no questions. Nothing else in the
 *   profile is a declaration, and a city is never "yes".
 *
 *   A leading Yes or No wins over everything, because that is the answer and
 *   the rest of the sentence is its explanation. "Yes, but not until 2027"
 *   is a yes; read for negation words instead it comes out a no.
 *
 *   Then the negation has to be *about the thing being asked about*. A
 *   sentence is not a bag of words: scanning the whole of one for any
 *   negation word read "Authorized to work in the US without sponsorship" —
 *   the documented example value plus the commonest suffix people write — as
 *   a No, and ticked No on the question about their right to work. That is
 *   the false declaration this comment says it exists to prevent, made in
 *   their name, on the form most likely to be rejected without a person
 *   reading it. It went wrong in both directions at once: "without" negates
 *   the sponsorship, and the sponsorship question then read the same phrase
 *   as needing it.
 *
 *   A phrase that is neither, or that says both, is skipped and reported —
 *   "it needs you" is a fine answer and a wrong declaration is not, and so is
 *   "I am not a citizen but am authorized to work", which is a true sentence
 *   this has no business reducing to one box.
 */
const YES_NO_KEYS = new Set(['work_authorization', 'requires_sponsorship']);

/**
 * The thing each question is actually about.
 *
 * The answer turns on whether *this* is affirmed or denied, and nothing else
 * in the sentence can settle it. Keeping the two lists apart is half the fix:
 * "sponsorship" says nothing about a right to work, and "citizen" says
 * nothing about needing a visa, so neither key can be decided by a word that
 * belongs to the other.
 */
const CONCEPT = {
  work_authorization:
    /\b(unauthori[sz]ed|ineligible|authori[sz]ed|eligible|permitted|allowed|citizen|permanent[\s_-]resident|green[\s_-]card|work[\s_-]permit|right[\s_-]to[\s_-]work)\b/g,
  requires_sponsorship: /\b(sponsorship|sponsored|sponsor|visa|h-?1b)\b/g,
};

/** Words that are their own denial, with no separate negation to find. */
const FUSED_NO = /^(unauthori[sz]ed|ineligible)$/;

/**
 * A denial fixed to the front of the word it denies: "non-citizen".
 *
 * Its own case, because it is not a word in the sentence — it is part of the
 * word that was matched, and it denies that word and nothing else. Read as a
 * loose negation it poisoned everything after it; not read at all, it would
 * make "non-citizen" an affirmation of citizenship.
 */
const FUSED_PREFIX = /(?:^|[^\w-])non-?$/i;

/**
 * A denial close enough in front of a word to be about that word.
 *
 * Bounded by `[^\w-]` rather than `\b`, because `\b` is a transition between
 * a word character and anything else — and a hyphen is anything else. So
 * `\bnon\b` matched the `non` inside `non-citizen`, and the window is four
 * words wide, so one of those poisoned every concept word after it. Measured,
 * running this function as written:
 *
 *   "I am a non-citizen, but authorized to work in the US without
 *    restriction."                                            => no
 *   "I am a non-immigrant and will require sponsorship."       => no
 *
 * The first says the applicant is not authorised to work, and the second says
 * they do not need sponsorship. Both are the opposite of what was written,
 * both are declarations made in somebody's name on a submitted form, and both
 * are the exact failure the note above this function exists to prevent —
 * arriving through the one spelling a visa holder is most likely to use about
 * themselves. `non-citizen`, `non-immigrant`, `non-resident`.
 */
const NEAR_NO = /(?<![\w-])(no|not|never|non|cannot|can't|don'?t|doesn'?t|without|nor|neither)(?![\w-])/i;

/** How much of what comes before a word can be said to be about it. */
const LOOK_BACK_WORDS = 4;

/**
 * Yes, no, or "cannot tell" — for a value against a yes/no pair.
 *
 * `key` decides which words count, so this cannot be asked in the abstract.
 */
function yesNoFrom(value, key) {
  const said = clean(value).toLowerCase();
  if (!said) return undefined;

  /*
   * A leading Yes or No wins over everything, because that is the answer and
   * the rest of the sentence is its explanation. "Yes, but not until 2027"
   * is a yes; read for negation words instead it comes out a no.
   */
  const lead = /^(yes|no)\b/i.exec(said)?.[1]?.toLowerCase();
  if (lead) return lead;

  const concept = CONCEPT[key];
  if (!concept) return undefined;

  const verdicts = new Set();
  for (const hit of said.matchAll(concept)) {
    if (FUSED_NO.test(hit[1])) {
      verdicts.add('no');
      continue;
    }
    /*
     * Only the few words in front of it: a denial further away than that is
     * about some other clause. "…does not require sponsorship" denies the
     * sponsorship; "I do not need it now but will require sponsorship in
     * 2027" does not.
     *
     * Trimmed first, and that is the whole of this line's history. What comes
     * before a matched word always ends in the space that separates them, so
     * `split(/\s+/)` produced a trailing empty token and the window spent one
     * of its four slots on it — three real words, not four. "I do not at
     * present require sponsorship" put `not` one word outside a window that
     * should have held it and came back `yes`, so the form was filled in with
     * "Yes, I require sponsorship" for somebody who had written the opposite,
     * and counted as a field successfully answered. That is the false legal
     * declaration the note above this function exists to prevent, made by the
     * function written to prevent it.
     */
    const upTo = said.slice(0, hit.index);
    // "non-citizen" is a denial of *this* word, wherever the rest of the
    // sentence goes. See `FUSED_PREFIX`.
    if (FUSED_PREFIX.test(upTo)) {
      verdicts.add('no');
      continue;
    }
    const before = upTo.trim().split(/\s+/).slice(-LOOK_BACK_WORDS).join(' ');
    verdicts.add(NEAR_NO.test(before) ? 'no' : 'yes');
  }

  // Nothing about this question in the sentence, or the sentence says both.
  // Either way it is not this tool's to decide. See the note above.
  return verdicts.size === 1 ? [...verdicts][0] : undefined;
}

/**
 * The countries a declaration or a question names.
 *
 * A declaration is a sentence and it says where it is true: "Authorized to
 * work in the US". A global employer asks the same question of the country
 * the job is in, and the sentence says nothing about that one. Measured: "Are
 * you authorized to work in the UK?" and "…in Canada?" were answered "Yes"
 * from "Authorized to work in the US", and "Will you require sponsorship to
 * work in the United Kingdom?" "No" from "I do not require sponsorship in the
 * US" — declarations about countries the applicant never made one about, and
 * for most people false ones.
 *
 * The short forms in capitals only, because "us" is a pronoun: "Are you
 * authorized to work for us?" names nobody. A question naming no country —
 * "this country", "the country where this job is located" — is still read as
 * the profile's own, which is what it always was.
 */
const COUNTRIES = [
  // [code, the short forms (as capitals), the names (in any case)]
  ['us', /\b(?:US|USA|U\.S\.(?:A\.)?)(?!\w)/, /\bunited\s+states\b|\bamerica\b/i],
  ['uk', /\b(?:UK|U\.K\.)(?!\w)/, /\bunited\s+kingdom\b|\b(?:great\s+)?britain\b|\bengland\b|\bscotland\b|\bwales\b/i],
  ['eu', /\b(?:EU|EEA|E\.U\.)(?!\w)/, /\beuropean\s+(?:union|economic\s+area)\b|\beurope\b/i],
  ['ca', null, /\bcanad\w*/i],
  ['au', null, /\baustralia\w*/i],
  ['nz', null, /\bnew\s+zealand\b/i],
  ['ie', null, /\bireland\b/i],
  ['in', null, /\bindia\b/i],
  ['sg', null, /\bsingapore\b/i],
  ['de', null, /\bgermany\b/i],
  ['fr', null, /\bfrance\b/i],
  ['nl', null, /\bnetherlands\b/i],
  ['mx', null, /\bmexico\b/i],
  ['jp', null, /\bjapan\b/i],
  ['il', null, /\bisrael\b/i],
  /*
   * And the rest of the places the global boards hire in. A country missing
   * from this list is a country no question can name, so a question about it
   * reads as one naming none — the profile's own — and is answered for it.
   * Measured live on Affirm's Greenhouse board: "Do you now or in the future
   * require sponsorship for employment visa status in Spain?" was answered
   * "No" from a profile that only ever said it needs none in the US.
   *
   * Names only, never short forms, and only names nothing else is called:
   * Georgia is also a state and Jordan a person, so neither is here, and a
   * question naming them is read as it always was.
   */
  ['es', null, /\bspain\b/i],
  ['pt', null, /\bportugal\b/i],
  ['it', null, /\bital(?:y|ian)\b/i],
  ['pl', null, /\bpoland\b/i],
  ['ch', null, /\bswitzerland\b/i],
  ['se', null, /\bsweden\b/i],
  ['no', null, /\bnorway\b/i],
  ['dk', null, /\bdenmark\b/i],
  ['fi', null, /\bfinland\b/i],
  ['be', null, /\bbelgium\b/i],
  ['at', null, /\baustria\b/i],
  ['cz', null, /\bczech(?:ia|\s+republic)\b/i],
  ['ro', null, /\bromania\b/i],
  ['gr', null, /\bgreece\b/i],
  ['br', null, /\bbrazil\b/i],
  ['ar', null, /\bargentina\b/i],
  ['cl', null, /\bchile\b/i],
  ['co', null, /\bcolombia\b/i],
  ['cn', null, /\bchina\b/i],
  ['hk', null, /\bhong\s+kong\b/i],
  ['tw', null, /\btaiwan\b/i],
  ['kr', null, /\b(?:south\s+)?korea\b/i],
  ['ph', null, /\bphilippines\b/i],
  ['my', null, /\bmalaysia\b/i],
  ['id', null, /\bindonesia\b/i],
  ['vn', null, /\bvietnam\b/i],
  ['th', null, /\bthailand\b/i],
  ['ae', null, /\bunited\s+arab\s+emirates\b|\bu\.?a\.?e\.?\b|\bdubai\b/i],
  ['za', null, /\bsouth\s+africa\b/i],
  ['ng', null, /\bnigeria\b/i],
  ['tr', null, /\bt(?:ü|u)rk(?:ey|iye)\b/i],
];

/*
 * The dialling code of each country above, for a telephone box a form has
 * already started with its own. See the phone note in `fillForm`.
 */
const DIALLING_CODES = {
  us: '+1', ca: '+1', uk: '+44', ie: '+353', in: '+91', sg: '+65', de: '+49', fr: '+33', nl: '+31', mx: '+52',
  jp: '+81', il: '+972', au: '+61', nz: '+64', es: '+34', pt: '+351', it: '+39', pl: '+48', ch: '+41', se: '+46',
  no: '+47', dk: '+45', fi: '+358', be: '+32', at: '+43', cz: '+420', ro: '+40', gr: '+30', br: '+55', ar: '+54',
  cl: '+56', co: '+57', cn: '+86', hk: '+852', tw: '+886', kr: '+82', ph: '+63', my: '+60', id: '+62', vn: '+84',
  th: '+66', ae: '+971', za: '+27', ng: '+234', tr: '+90',
};

/** The dialling code of the one country `text` names, or `undefined`. */
function diallingCodeFor(text) {
  const named = [...countriesIn(text)];
  return named.length === 1 ? DIALLING_CODES[named[0]] : undefined;
}

function countriesIn(text) {
  const said = String(text ?? '');
  const out = new Set();
  for (const [code, short, name] of COUNTRIES) {
    if (short?.test(said) || name.test(said)) out.add(code);
  }
  return out;
}

/*
 * A national number's trunk 0, which is dialled at home and not from abroad.
 *
 * A UK profile's "07700 900123" went in behind the form's "+44" as "+44 07700
 * 900123", a number nobody can ring. Behind a dialling code the 0 goes —
 * except for North America, whose numbers never start with one and are not
 * touched, and Italy (and the two states inside it), whose numbers keep it.
 * "(0)" is the same 0, written the way a UK business card writes it. "00" in
 * front is the international prefix, not a trunk 0, and is left alone.
 */
const KEEPS_ITS_ZERO = new Set(['+1', '+39', '+378', '+379']);

function withoutTrunkZero(code, number) {
  const said = String(number);
  if (!code || KEEPS_ITS_ZERO.has(code.trim()) || /^\s*\(?00/.test(said)) return said;
  const dropped = said.trim().replace(/^\(0\)\s*/, '').replace(/^0(?=\d)/, '').replace(/^\(0(?=\d)/, '(');
  return dropped === said.trim() ? said : dropped;
}

/** A number stored with its code and its trunk 0 both: "+44 07700 900123", "+44 (0)7700 900123". */
function withoutTrunkZeroAfterCode(number) {
  const m = /^\s*(\+\d{1,4})[\s.-]+(.*)$/.exec(String(number));
  if (!m) return number;
  const rest = withoutTrunkZero(m[1], m[2]);
  return rest === m[2] ? number : `${m[1]} ${rest}`;
}

/*
 * The dialling code the form shows beside a telephone box: a country-code
 * select, or the button an intl-tel-input puts in front of its box, "Change
 * country, selected United Kingdom (+44)". Looked for in the box's own
 * wrapper and the two around it, never the whole form.
 */
/*
 * And out of the component the box is drawn in, and into the components
 * beside it that are only a picker.
 *
 * `parentElement` stops at the root a box is drawn in, and
 * `querySelectorAll` does not open a component, so a code beside a box in a
 * component was never seen: measured, with the page's own select on +44
 * beside a telephone box drawn in a component, with the select drawn in a
 * component beside the page's box, and with an intl-tel-input drawn whole in
 * one component, button and box loose in its root, a UK mobile went in as
 * "07700 900123" behind the +44, where written without components it went
 * in as "7700 900123".
 *
 * The root is one more wrapper, costing none of the three. A component
 * beside the box is read when it draws one control and no more — a picker,
 * standing where the page put it — or when it is the one the box is drawn
 * in. One drawing a control and a box of its own is a telephone field of
 * its own, and its code is its own box's, not this one's.
 */
const A_CODE_CONTROL = 'select, button, [role="combobox"], input';

function codeControlsDrawnIn(scope, input) {
  const out = [];
  const walk = (node) => {
    const put = node.localName === 'slot' && hostOf(node) ? node.assignedElements() : [];
    for (const el of put.length ? put : [...node.children]) {
      if (el.matches(A_CODE_CONTROL)) out.push(el);
      if (!el.shadowRoot || el.id === OURS) walk(el);
      else if (drawnInside(el, input) || fieldsIn(el.shadowRoot, A_CODE_CONTROL, 2) <= 1) walk(el.shadowRoot);
    }
  };
  walk(scope);
  return out;
}

function diallingCodeBeside(input) {
  let scope = containerOf(input);
  for (let i = 0; i < 3 && scope && scope.localName !== 'form' && scope !== document.body; ) {
    for (const el of codeControlsDrawnIn(scope, input)) {
      if (el === input) continue;
      const shown =
        el instanceof HTMLSelectElement
          ? `${el.selectedOptions[0]?.textContent ?? ''} ${el.value}`
          : el.localName === 'input'
            ? el.value
            : `${el.getAttribute('aria-label') ?? ''} ${el.textContent}`;
      const code = /(?:^|[\s(])(\+\d{1,4})(?=$|[\s)])/.exec(shown)?.[1];
      if (code) return code;
    }
    if (scope instanceof ShadowRoot) {
      if (scope.host.id === OURS) break;
      scope = containerOf(scope.host);
    } else {
      scope = containerOf(scope);
      i++;
    }
  }
  return undefined;
}

/**
 * Whether a yes/no declaration names one country and the question another.
 *
 * `home` is the profile's own country, and it speaks for a declaration that
 * names none. "Yes" is what people type into a box labelled "Work
 * authorization", and it matched the Yes option by its text before any
 * country was looked at: a profile living in the United States ticked "Yes"
 * to "Are you authorized to work in the UK?" and "…in Canada?", and "No" to
 * needing UK sponsorship. With no country anywhere in the profile there is
 * nothing to compare, and the answer stands as it always did.
 */
function aboutAnotherCountry(key, value, asked, home) {
  // Where somebody lives is only ever the profile's own country. See `lives_in_country`.
  if (key === 'lives_in_country') {
    const here = countriesIn(home);
    const named = countriesIn(asked);
    return here.size > 0 && named.size > 0 && ![...named].some((code) => here.has(code));
  }
  if (!YES_NO_KEYS.has(key)) return false;
  let declared = countriesIn(value);
  if (declared.size === 0) declared = countriesIn(home);
  const wanted = countriesIn(asked);
  if (declared.size === 0 || wanted.size === 0) return false;
  for (const code of wanted) if (declared.has(code)) return false;
  return true;
}

const ANOTHER_COUNTRY = 'your answer is about another country';

/**
 * The option that answers a yes/no question, where the labels are yes and no
 * and the profile's answer is a phrase. `undefined` unless all of that holds,
 * and unless the phrase and the question are about the same country — see
 * `aboutAnotherCountry`.
 */
function yesNoOption(key, value, options, asked = '') {
  if (!YES_NO_KEYS.has(key)) return undefined;
  if (aboutAnotherCountry(key, value, asked)) return undefined;

  /*
   * An option that *is* Yes or No, or one that says so first and explains
   * after. Stripe's Greenhouse board offers "Are you currently eligible to
   * work in the United States?" as "Yes, I am currently eligible to work in
   * the location where this role is based." and "No, I am not currently
   * eligible…", and the sponsorship question the same way — measured on its
   * embed, both lists hold exactly those two and nothing else. Read as whole
   * labels they were neither yes nor no, and both were left for the person.
   * The leading word is the answer, for the reason `yesNoFrom` gives; it has
   * to be followed by punctuation, so "No preference" is not a No.
   */
  const leading = (said) => /^(yes|no)(?:$|\s*[,.;:!—–-])/.exec(said)?.[1];
  const labelled = options.map((o) => ({ o, said: leading(clean(o.label).toLowerCase()) }));
  const yes = labelled.find((x) => x.said === 'yes');
  const no = labelled.find((x) => x.said === 'no');
  // A yes/no *pair* and nothing else. "Yes / No / Prefer not to say" is a
  // different question with a third answer, and guessing between three is
  // exactly what this file does not do.
  if (!yes || !no || labelled.length !== 2) return undefined;

  const answer = yesNoFrom(value, key);
  return answer === 'yes' ? yes.o : answer === 'no' ? no.o : undefined;
}

/*
 * Work authorization asked as statements rather than as yes or no.
 *
 * SpaceX's reads "I am authorized to work in the United States for any
 * employer", "…for my present employer only", "I require sponsorship…",
 * "I am not authorized…", "My status… is unknown", and was left for the
 * person against a profile that says "Authorized to work in the US" and no
 * sponsorship. Each statement is read for what it claims, and one is chosen
 * only where the profile's two answers make it true and it is the only one:
 * needing sponsorship picks the statement that says so; authorized without
 * it picks "for any employer"; a plain "I am authorized" only where nothing
 * narrower is offered. "Present employer only" and "unknown" are never
 * chosen, and nothing is where the profile does not say about sponsorship.
 */
/*
 * Whether a statement about sponsorship denies needing it — in the words
 * around the need, not anywhere in the sentence. Any "no" at all counted, so
 * the answer "No, I need sponsorship now." read as a statement that no
 * sponsorship is needed: measured live on Datadog's Greenhouse board, whose
 * list is "Yes, no restriction." / "Yes, but I will need sponsorship in the
 * future." / "No, I need sponsorship now.", a profile needing none was given
 * the last. A "No," that answers the question is followed by a comma, and a
 * denial of the need sits in the same clause as it.
 */
const DENIES_THE_NEED =
  /\b(?:not|never|without|don'?t|doesn'?t|won'?t)\b[^.,;]{0,24}\b(?:require|need)|\b(?:require|need)s?\s+no\b|\bno\s+(?:visa\s+)?sponsor/;

function statementKind(text) {
  const said = clean(text).toLowerCase();
  if (/\bnot\s+(?:legally\s+)?authori[sz]ed\b/.test(said)) return 'not-authorized';
  if (/\b(?:require|need)s?\b[^.]*\bsponsor/.test(said)) return DENIES_THE_NEED.test(said) ? 'any-employer' : 'needs-sponsorship';
  if (!/\bauthori[sz]ed\b/.test(said)) return null;
  if (/\bonly\b|\bunknown\b|\bpresent employer\b|\bcurrent employer\b/.test(said)) return 'restricted';
  return /\bany employer\b|\bwithout restriction\b/.test(said) ? 'any-employer' : 'authorized';
}

function authorizationStatement(options, fields, textOf = (o) => o.textContent) {
  const authorized = yesNoFrom(fields?.work_authorization ?? '', 'work_authorization');
  const sponsor = yesNoFrom(fields?.requires_sponsorship ?? '', 'requires_sponsorship');
  const of = (kind) => options.filter((o) => statementKind(textOf(o)) === kind);
  const only = (list) => (list.length === 1 ? list[0] : null);
  if (sponsor === 'yes') return only(of('needs-sponsorship'));
  if (authorized !== 'yes') return null;
  if (sponsor === 'no' && of('any-employer').length) return only(of('any-employer'));
  // Nothing narrower on offer: "I am authorized" is true either way.
  return of('any-employer').length || of('restricted').length ? null : only(of('authorized'));
}

/**
 * Fill what we can. Returns a report of what was filled and what was skipped,
 * so the user can see the difference between "done" and "done silently wrong".
 */
/**
 * The value for a box asking for the city and the state together.
 *
 * The store sends the two apart, as `address_city` and `address_state`, and
 * nothing else says them together in the shape the box asks for — `location`
 * is whatever was typed, "Boston, MA, USA" as often as "Boston, MA". Where
 * there is no state to add, the city alone is what the box was given before.
 */
/*
 * A text box asking for what a list beside it did not have.
 *
 * Stripe's Greenhouse board puts one under its School dropdown: "We are
 * always aiming to keep our school list inclusive of all institutions. If you
 * did not see your University listed in the previous question, please let us
 * know your school name here." It says "school" and "university", so it was
 * filled with the profile's school like any school box — and, filled first,
 * it claimed `school`, so the School dropdown itself, the required one, was
 * never driven and was left on "Select...". Measured on the embed: the
 * school went into `question_68843617` and nowhere else.
 *
 * Such a box is only right to fill once the list has been looked in and the
 * answer was not there, which is what it says. So `fillForm` passes it over,
 * and `fillComboboxes` writes in it only for a list whose answer never
 * appeared. See `fillNotListed`.
 */
const NOT_LISTED = new RegExp(
  [
    String.raw`\b(?:did|do|does|could|can)(?:\s*n't|\s+not)\s+(?:see|find)\b[^.?!]{0,60}?\b(?:listed|in\s+the\s+(?:list|dropdown|menu|options))`,
    String.raw`(?:\bnot|n't)\s+(?:been\s+|be\s+)?(?:listed|found\s+in\s+the\s+(?:list|dropdown)|in\s+the\s+(?:list|dropdown|options)|on\s+the\s+list)\b`,
    String.raw`\bif\s+(?:your|my)\s+(?:school|university|college|institution|degree|major|discipline)\s+(?:is|was)(?:\s*n't|\s+not)\b`,
    String.raw`\bunlisted\b`,
  ].join('|'),
  'i',
);

/*
 * The job a question asking for the "most recent" one means, from the resume.
 *
 * The store sends `current_company` and `current_title` only for a job whose
 * dates run to the present, and on purpose: "Current company" answered with
 * the last place somebody worked says they work there now. But plenty of
 * forms ask for the last one in so many words, and mark it required.
 * Measured live with a fake profile whose one job (Example Co, Software
 * Engineering Intern, Jun–Aug 2025) has ended: Vanta's Ashby board left
 * "Current/Most Recent Company Name" and "Current/Most Recent Job Title"
 * empty, Samsara's Greenhouse board "Most Recent Employer", and Reddit's
 * "Please provide the name of your current (or most recent) company" — each
 * required, each a question the resume being attached plainly answers.
 *
 * So a question that says "most recent" is given the newest job on the
 * resume: one still going, else the one that ended last. Two that cannot be
 * told apart — both still going, or ending in the same month — give nothing,
 * as the store's own `currentJob` does. A question saying only "current" is
 * not touched: it still gets the store's answer or nothing.
 */
const MOST_RECENT = /\bmost[\s_-]*recent\b/i;

function mostRecentJob(history) {
  const jobs = (Array.isArray(history) ? history : []).filter((job) => job?.company);
  if (jobs.length <= 1) return jobs[0];
  const ended = (job) => (job.current ? Infinity : job.end?.year ? job.end.year * 12 + (job.end.month ?? 12) : undefined);
  const ranked = jobs.map((job) => ({ job, at: ended(job) })).filter((r) => r.at !== undefined).sort((a, b) => b.at - a.at);
  if (ranked.length === 0 || ranked[0].at === ranked[1]?.at) return undefined;
  return ranked[0].job;
}

/*
 * "Yes" to "Do you live in <country>?", wherever the profile has a country.
 * The question decides whether it is asked of this country: see
 * `aboutAnotherCountry`.
 */
function withResidence(fields) {
  return fields.address_country && !fields.lives_in_country ? { ...fields, lives_in_country: 'Yes' } : fields;
}

function withCityAndState(fields) {
  if (fields.city_state || !fields.address_city) return fields;
  const both = fields.address_state ? `${fields.address_city}, ${fields.address_state}` : fields.address_city;
  return { ...fields, city_state: both };
}

/**
 * Which name a name box gets, when a profile has two.
 *
 * The legal name, when the box asks for it — "Legal name", "Legal first
 * name", or plain boxes under a "Legal Name" heading as Workday draws them.
 * The legal name too in a plain "Name" box on a form that also has a box for
 * a preferred name, because that form is asking for the two separately. And
 * otherwise, a plain name box on its own gets the name the person goes by —
 * the one the resume being sent prints. With one name in the profile, both
 * are that name.
 */
const NAME_FOR_THE_FORM = { full_name: 'preferred_name', first_name: 'preferred_first_name', last_name: 'preferred_last_name' };
// The preferred-name patterns themselves, so a box read as one is also what
// tells the form it has one.
const PREFERRED_NAME_BOXES = FIELD_PATTERNS.filter(([key]) => key.startsWith('preferred_')).map(([, re]) => re);
const PREFERRED_NAME_BOX = { test: (label) => PREFERRED_NAME_BOXES.some((re) => re.test(label)) };
const LEGAL = /\blegal\b|\bas\s+(it\s+)?appears\s+on\s+(your\s+)?(passport|government|official|id\b)/i;
const asksForLegalName = (input) => LEGAL.test(`${clean(labelFor(input))} ${surroundingWords(input)} ${boundedSection(input)}`);

export function fillForm(fields, { overwrite = false, remembered = [], history = [], company = '' } = {}) {
  fields = withResidence(withCityAndState(fields));
  // For a question asking about the most recent job. See `mostRecentJob`.
  const recent = mostRecentJob(history);
  const lately = {
    ...fields,
    current_company: fields.current_company || recent?.company,
    current_title: fields.current_company ? fields.current_title : fields.current_title || recent?.title,
  };
  const filled = [];
  const skipped = [];
  // A new pass: what an earlier one pressed has been drawn, or was refused.
  pressedNow = new WeakSet();

  const inputs = deepQueryAll('input, textarea, select');
  // Whether this form has a box of its own for the name somebody goes by.
  // See `NAME_FOR_THE_FORM`.
  const asksPreferred = inputs.some((i) => isFillable(i) && PREFERRED_NAME_BOX.test(clean(labelFor(i))));
  // The boxes of a telephone number asked in parts, once one of them has
  // filled them all. See `phoneBoxes`.
  const numberBoxes = new WeakSet();
  for (const input of inputs) {
    if (!isFillable(input) || numberBoxes.has(input)) continue;

    const description = describeField(input);
    if (!description) continue;
    // Somebody else's details, or a question this profile does not answer —
    // see `NOT_ABOUT_YOU`. Not reported: there is nothing here for the user to
    // do about it, and naming it would imply the field is theirs to fill.
    // Before the exclusions, which say nothing, and before the match, which
    // this question does not need. See `handBack`.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description, clean(labelFor(input)), surroundingWords(input), boundedSection(input))) continue;
    // A name is not writing, even asked in a paragraph box as a question:
    // Zoox's "What is your preferred first name and last name?" is a textarea.
    if (asksForWriting(input) && !PREFERRED_NAME_BOX.test(clean(labelFor(input)))) continue;

    /*
     * The first pattern that matches, and then whether the profile has it —
     * not the first pattern that matches *and* has a value.
     *
     * The order of `FIELD_PATTERNS` is load-bearing and says so: country sits
     * above state precisely because "Country/Region" matches `region`. But
     * `&& fields[key]` made the search walk past a pattern whose key the
     * profile happened to be missing, so on a profile with a state and no
     * country — an ordinary partial profile — "Country/Region" fell through
     * to `address_state` and a Californian's application said Canada, the
     * value "CA" having found `<option value="CA">Canada</option>`. Reported
     * as filled, in green.
     *
     * What a field is asking for does not depend on what this profile
     * happens to hold. Nothing here fills a field it has no value for; it
     * simply no longer goes looking for a different question to answer.
     */
    // The degree's dates first: see `educationDateKey`. They read as nothing
    // at all to the patterns, so this can only claim what was going unclaimed.
    const dated = educationDateKey(input, description);
    const found = dated ? [dated] : FIELD_PATTERNS.find(([, re]) => re.test(description));
    const named = found && !dated ? [addressPartByLabel(clean(labelFor(input)), found[0])] : found;
    const answers = MOST_RECENT.test(labelFor(input)) ? lately : fields;
    let match = named && answers[named[0]] ? named : undefined;

    if (!match && fields.full_name && BARE_NAME.test(withoutMarkers(labelFor(input)))) {
      match = ['full_name'];
    }
    if (!match) {
      const half = nameHalf(input);
      if (half && fields[half]) match = [half];
    }
    if (!match) continue;

    const key = wholeDateKey(input, match[0], description);
    if (!answers[key]) continue;
    // A box for the answer a list above it did not have. See `NOT_LISTED`.
    if (!(input instanceof HTMLSelectElement) && NOT_LISTED.test(description)) continue;
    if (anotherLevelOfStudy(input, key, fields)) continue;
    if (asksYesOrNo(input, key)) continue;
    let value = answers[key];
    // The legal name or the one the resume prints. See `NAME_FOR_THE_FORM`.
    if (NAME_FOR_THE_FORM[key] && !asksPreferred && !asksForLegalName(input)) value = answers[NAME_FOR_THE_FORM[key]] || value;

    const answered =
      input instanceof HTMLSelectElement
        ? selectIsAnswered(input)
        : Boolean(input.value) &&
          !ONLY_A_MASK.test(input.value) &&
          !(LINKS.has(key) && onlyTheStartOfAnAddress(input.value)) &&
          !(key === 'phone' && ONLY_A_DIALLING_CODE.test(input.value));
    if (answered && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }
    // The dialling code the form put there stays, in front of a number that
    // does not carry one of its own.
    /*
     * Unless it is some other country's. The code a form starts its box with
     * is the employer's guess, and it is usually the employer's own country:
     * Recruitee boards open the box on "+49" for a German company and "+31"
     * for a Dutch one. Measured live on personio.recruitee.com and
     * jobs.channable.com with a fake profile living in the United States:
     * "(555) 010-0199" went in as "+49 5550 100199" and "+31 5550100199" — a
     * German and a Dutch number nobody answers, reported as filled. Where the
     * profile names its country and that country's code is known, the number
     * goes in behind that code instead; with no country to go on, the form's
     * guess is kept, as it always was.
     */
    if (key === 'phone' && ONLY_A_DIALLING_CODE.test(input.value) && !/^\s*\+/.test(String(value))) {
      const code = diallingCodeFor(fields.address_country) ?? input.value.trim();
      value = `${code} ${withoutTrunkZero(code, String(value).trim())}`;
    } else if (key === 'phone' && /^\s*\+/.test(String(value))) {
      value = withoutTrunkZeroAfterCode(value);
    } else if (key === 'phone' && !(input instanceof HTMLSelectElement)) {
      // Behind a code the form adds itself, from a select or a widget beside the box.
      const beside = diallingCodeBeside(input);
      if (beside) value = withoutTrunkZero(beside, value);
    }

    /*
     * Before any option is matched, because "Yes" matches "Yes" by its text
     * whichever country is asked about — and before a box is typed into,
     * which took the same "Yes" to "Are you authorized to work in the United
     * Kingdom?". See `aboutAnotherCountry`.
     */
    if (aboutAnotherCountry(key, value, description, fields.address_country)) {
      skipped.push({ key, reason: ANOTHER_COUNTRY, description: description.slice(0, 60) });
      continue;
    }

    if (input instanceof HTMLSelectElement) {
      /*
       * A telephone number is typed, never picked from a list, so a dropdown
       * the phone pattern claims is some other question with the word in it:
       * Ramp's "On a scale of 1–10, how comfortable are you … (phone)?", a
       * "Phone type" of Mobile, Home and Work. Measured on the live sweep, the
       * scale was reported as a phone number that would not go in — a failure
       * on the card for a field that was never the number's.
       */
      if (key === 'phone') continue;
      /*
       * Only pick an option that plainly matches; never guess on a dropdown.
       * Compared through `clean` because the enterprise systems pad their
       * option text — a country list whose entry was `United&nbsp;States`
       * matched nothing under a plain `trim`, and a required country dropdown
       * was reported as having no option for the user's country while sitting
       * two lines above the one that did.
       */
      /*
       * Only the ones the control would actually let a person choose.
       *
       * A disabled `<option>`, and every option under a disabled
       * `<optgroup>`, is in `input.options` and reads `value` like any other —
       * but `FormData` takes nothing from a select sitting on one. Country
       * lists do this: the places a company is hiring in one group, the rest
       * greyed out underneath. Setting the greyed-out one left the dropdown
       * reading "United States" on screen, the form reporting itself valid,
       * and the country submitted as nothing.
       */
      const choosable = [...input.options].filter((o) => !isDisabled(o));
      const option =
        choosable.find((o) => sameOption(o.textContent, value) || sameOption(o.value, value)) ??
        // A grade against a list of bands. See `gpaOption`.
        (key === 'gpa' ? gpaOption(choosable, value) : null) ??
        // A location asked as a list of countries or of cities. See `locationPart`.
        (key === 'location' ? locationPart(choosable, fields) : null) ??
        /*
         * The same answer spelled the list's way: a month as "Dec" or "12", a
         * state as its name or its code, a country by its long name. Only for
         * those fields — "12" is a perfectly good option in plenty of other
         * lists — and only after the exact match has failed.
         */
        choosable.find(
          (o) => sameAnswerSpelledOtherwise(key, o.textContent, value) || sameAnswerSpelledOtherwise(key, o.value, value),
        ) ??
        /*
         * And, failing that, a yes/no pair against a phrase. See
         * `yesNoOption`, which wants a pair and nothing else — so the prompt
         * has to come off first.
         *
         * `choosable` drops only the *disabled* options, and a dropdown's
         * "Select…" is usually not disabled: every real yes/no `<select>`
         * therefore arrived as three answers and was refused as a question
         * with a third answer. So Greenhouse's work-authorisation dropdown
         * was left blank against a profile saying "Authorized to work in the
         * US", while the identical question asked as radio buttons on the
         * same form was answered — the shape of the control decided whether
         * the question got an answer. `looksLikePlaceholder` was already here
         * and already knew what a prompt looks like.
         */
        yesNoOption(
          key,
          value,
          choosable.filter((o) => !looksLikePlaceholder(o, input)).map((o) => ({ label: o.textContent, el: o })),
          description,
        )?.el ??
        // Or statements about it. See `authorizationStatement`.
        (key === 'work_authorization' && !aboutAnotherCountry(key, value, description)
          ? authorizationStatement(choosable, fields)
          : null);
      if (option) {
        const was = input.value;
        nativeSet(input, 'value', option.value);
        /*
         * Check it went in, exactly as the text path below does.
         *
         * Setting `value` selects the *first* option carrying it, and two
         * options sharing a value is ordinary — a placeholder with `value=""`
         * above a real entry whose value the form fills in later. The write
         * then lands on the placeholder, the dropdown still reads "Select a
         * country…", and the card says it filled it.
         */
        if (input.selectedOptions[0] !== option) {
          skipped.push({ key, reason: 'the field would not take it', description: description.slice(0, 60) });
          continue;
        }
        // Both, because choosing from a list fires both. `change` alone is
        // what a script fires, and some widgets only listen for `input`.
        input.dispatchEvent(ours(new Event('input', { bubbles: true })));
        input.dispatchEvent(ours(new Event('change', { bubbles: true })));
        // And drawn by whatever stands in for it. See `chosenOf`.
        if (!standInTookIt(input, was)) {
          skipped.push({ key, reason: PICK_BY_HAND, description: description.slice(0, 60) });
          continue;
        }
        filled.push({ key, value });
      } else {
        const reason = aboutAnotherCountry(key, value, description) ? ANOTHER_COUNTRY : 'no matching option';
        skipped.push({ key, reason, description: description.slice(0, 60) });
      }
      continue;
    }

    const before = input.value;
    /*
     * A month picker holds a month *and* a year, so whichever graduation key
     * claimed it — a label saying "date", a name saying `graduation_month` —
     * the only thing it can take is the whole date. Given the month alone it
     * stays empty and says it would not take it.
     */
    if (key.startsWith('graduation_') && input.type === 'month' && fields.graduation_date) {
      value = graduationFor(input, fields.graduation_date);
    } else if (key.startsWith('education_start_') && input.type === 'month' && fields.education_start_date) {
      value = graduationFor(input, fields.education_start_date);
    } else if (key === 'graduation_date' || key === 'education_start_date') {
      value = graduationFor(input, value);
    } else if ((key === 'graduation_month' || key === 'education_start_month') && asksMonthAsNumber(input)) {
      value = monthAsNumber(value);
    } else if (key === 'linkedin' && isWorkdayLinkedIn(input)) {
      value = wholeLinkedInAddress(value);
    }
    /*
     * Never more than the box has room for. See `fitsIn`: the same answer
     * written shorter, or a telephone number spread over the boxes it is
     * asked in, or nothing and a line on the card saying so.
     */
    if (!fitsIn(input, value)) {
      const shorter = otherWaysToWrite(key, value).find((spelling) => fitsIn(input, spelling));
      const parts = shorter === undefined && key === 'phone' ? phoneBoxes(input, value) : null;
      if (parts) {
        const unsure = parts.some(([, part]) => part === null);
        const busy = parts.some(([box]) => box !== input && box.value) && !overwrite;
        const was = parts.map(([box]) => box.value);
        if (!busy && !unsure) for (const [box, part] of parts) setValue(box, part);
        for (const [box] of parts) numberBoxes.add(box);
        if (unsure) {
          skipped.push({ key, reason: 'the field would not accept it in that form', description: description.slice(0, 60) });
        } else if (busy) {
          skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
        } else if (parts.every(([box, part]) => box.value === part)) {
          filled.push({ key, value: parts.map(([, part]) => part).join(' ') });
        } else {
          parts.forEach(([box], n) => setValue(box, was[n]));
          skipped.push({ key, reason: 'the field would not take it', description: description.slice(0, 60) });
        }
        continue;
      }
      if (shorter === undefined) {
        skipped.push({ key, reason: 'the field would not accept it in that form', description: description.slice(0, 60) });
        continue;
      }
      value = shorter;
    }
    setValue(input, value);
    /*
     * Check it went in. Assigning a value a typed input will not accept — a
     * phone number to `type=number`, a city to `type=date`, and both are shapes
     * real forms use — leaves the field empty and raises nothing. Reported as
     * filled anyway, the card said "Filled 4 fields" while two of them were
     * blank, and the user submitted a form missing a required phone number
     * having been told it was done.
     */
    /*
     * A phone box that kept every digit and dropped the formatting has taken
     * it: Greenhouse's intl-tel-input turns "(555) 010-0199" into
     * "5550100199", as it does to what a person types, and the number was
     * reported refused while it sat in the box.
     */
    /*
     * And one that put its own dialling code in front: Teamtailor's
     * intl-tel-input rewrites "(555) 010-0199" as "+1 555-010-0199" as it is
     * typed. Measured live on owlco.na.teamtailor.com: the number sat in the
     * box and the card said the field would not take it. Only a "+" and at
     * most three digits more, in front of every digit that was given.
     */
    const digits = (v) => String(v).replace(/\D/g, '');
    /*
     * And one that took the trunk 0 off as it did: "07700 900123" behind a
     * +44 the script could not see is "+44 7700 900123". See `withoutTrunkZero`.
     */
    const withTheirCode = (shown, given) =>
      /^\s*\+/.test(shown) &&
      !/^\s*\+/.test(given) &&
      [digits(given), digits(given).replace(/^0/, '')].some((d) => digits(shown).endsWith(d) && digits(shown).length - d.length <= 3);
    const sameNumber =
      /phone/.test(key) && digits(value).length >= 7 && (digits(input.value) === digits(value) || withTheirCode(input.value, String(value)));
    // And a date picker that wrote the date back its own way. See `sameMonthWritten`.
    const sameDate = /^(graduation|education_start)_date$/.test(key) && sameMonthWritten(input.value, String(value));
    if (input.value !== String(value) && !sameNumber && !sameDate) {
      skipped.push({ key, reason: 'the field would not take it', description: description.slice(0, 60) });
      continue;
    }

    /*
     * And that the browser will still take it when Submit is pressed. See
     * `browserWouldRefuse`: a `pattern` is checked then, not now, so a value
     * the field holds happily can still stop the form going. Where the same
     * answer can be written another way, write it that way; where it cannot,
     * put the field back as it was rather than leave a value that blocks the
     * submit, and say so.
     */
    if (browserWouldRefuse(input)) {
      const took = otherWaysToWrite(key, value).find((spelling) => {
        setValue(input, spelling);
        return input.value === spelling && !browserWouldRefuse(input);
      });
      if (took === undefined) {
        setValue(input, before);
        skipped.push({
          key,
          reason: 'the field would not accept it in that form',
          description: description.slice(0, 60),
        });
        continue;
      }
      filled.push({ key, value: took });
      continue;
    }
    filled.push({ key, value });
  }

  const radios = answerRadioGroups(fields, overwrite);
  const buttons = answerChoiceButtons(fields, overwrite, [...filled, ...radios.filled]);

  /*
   * Last, over what the profile could not answer. The profile has had every
   * chance by here, so anything still unanswered is a question only the
   * person applying knows — which is the only kind the bank holds.
   */
  const memory = answerFromMemory(remembered);
  // And what was typed, into the short boxes the profile had nothing for.
  const typed = answerTypedFromMemory(remembered, fields, company);
  // And the jobs on the resume, into the blocks a work history is asked in.
  const work = fillWorkHistory(history, { overwrite });
  const done = [...filled, ...radios.filled, ...buttons.filled, ...memory.filled, ...typed.filled, ...work.filled];

  /*
   * A control the memory pass answered is not still waiting, whatever an
   * earlier pass said about it. `fillForm` reports a select it matched but
   * could not find an option for as "no matching option", and the bank quite
   * often *does* have an option for it — leaving both rows in said "filled 5
   * fields, 1 still for you to answer" about a form with nothing left on it,
   * which sends somebody back to hunt for a question that is answered.
   */
  const answered = new Set(memory.filled.map((f) => f.description));
  const waiting = [...skipped, ...radios.skipped, ...buttons.skipped].filter(
    (s) => !answered.has(s.description),
  );

  return {
    filled: done,
    skipped: [...waiting, ...memory.skipped, ...typed.skipped, ...work.skipped, ...unfillableChoices(fields, done)],
  };
}

/* ------------------------- A past job, from the resume ------------------------- */

/*
 * Where a field says it is part of a job history.
 *
 * Read off the groups it sits in, the heading bounding it, or its own id —
 * never off the words around a whole form, because "experience" is a word a
 * form uses about everything. Workday's ids say it outright
 * (`workExperience-3--jobTitle`), and its blocks are groups headed "Work
 * Experience 1".
 */
const WORK_HISTORY = /\b(work|employment|professional|job|career)[\s_-]*(experience|history)\b|\bexperience[\s_-]*\d+\b|\b(employer|job|position)[\s_-]*\d+\b/i;

function inWorkHistory(input) {
  const own = [input.id, input.name, input.getAttribute('data-automation-id')].map(asWords).join(' ');
  if (WORK_HISTORY.test(own)) return true;
  // Out of the components the field is drawn in: see `closestAround`.
  for (let at = parentAround(input), n = 0; at && n < 8; at = parentAround(at), n++) {
    if (!at.matches('[role="group"], fieldset, section')) continue;
    const named =
      clean(at.getAttribute('aria-label')) ||
      clean(fromLabelledBy(at)) ||
      clean(at.querySelector(':scope > legend, :scope > h2, :scope > h3, :scope > h4, :scope > h5')?.textContent);
    if (WORK_HISTORY.test(named)) return true;
  }
  return WORK_HISTORY.test(boundedSection(input)) || underPlainHeading(input, EMPLOYMENT_HEADING);
}

/*
 * A section named by a paragraph rather than a heading.
 *
 * Greenhouse's current boards title their Employment block with
 * `<div><p>Employment</p></div>` as the first child of the block, then one
 * wrapper per field, and none of that is a heading, a legend or a group — so
 * the block read as no work history at all. Measured live on Coinbase's and
 * Lyft's boards with a fake profile holding one job: Company name, Title and
 * the start and end, month and year, all required, all left empty.
 *
 * Read the way a person reads it: from the field outwards, the nearest thing
 * before it at each level that holds words and no control. A `<label>` is the
 * field's own and is stepped past; the first other one is the section's
 * heading, and it answers — this section if it says so exactly, and no
 * section at all otherwise. So an Education block under its own "Education"
 * paragraph is never taken for an employment one, whatever sits above it.
 */
const EMPLOYMENT_HEADING = /^(employment|employment\s+history|work\s+experience|work\s+history|professional\s+experience|experience)$/i;

/*
 * And out of the components the field is drawn in, as the page draws them.
 * `parentElement` stops at the shadow root, so a block of components under
 * its "Employment" paragraph read as no work history, and was left empty
 * where the same block written straight into the form was filled. Out
 * through the host (see `parentAround`), stepping past what is never drawn
 * — a component's root begins with its `<style>`, whose CSS was otherwise
 * the words before the box, and not a heading — counting a component's
 * boxes as the controls they are (see `fieldsIn`), and reading a
 * component's words as it shows them (see `shownText`).
 */
function underPlainHeading(input, heading) {
  // From a widget's whole control, whose own "Select..." is not a heading.
  const start = isWidgetChoice(input) ? controlOf(input) : input;
  for (let at = start, n = 0; at && parentAround(at) && n < 6; at = parentAround(at), n++) {
    const parent = parentAround(at);
    if (parent.localName === 'form' || parent.localName === 'body') return false;
    for (let before = at.previousElementSibling; before; before = before.previousElementSibling) {
      if (before.matches(NEVER_SHOWN) || fieldsIn(before, A_CONTROL, 1)) continue;
      const words = shownText(before);
      if (!words) continue;
      const label = before.matches('label') ? before : before.querySelector('label');
      if (label && clean(label.textContent) === words) break;
      return heading.test(withoutMarkers(words));
    }
  }
  return false;
}

/*
 * Which part of a past job a field asks for, by its label alone.
 *
 * Not by the whole description: "From" and "To" are the entire label of the
 * two date fields on Workday, and a two-letter word looked for in a string
 * carrying the field's name and id would be found everywhere.
 */
const JOB_PARTS = [
  ['current', /\b(i\s+)?(currently|still)\s+(work|am\s+employed)\b|\bcurrent(ly)?\s+(job|role|position|employer|employed)\b/i],
  ['description', /\b(description|responsibilit(y|ies)|duties|accomplishments?|achievements?)\b/i],
  ['title', /\b(job|position|role)[\s_-]*title\b|^\s*(title|position|role)\s*$/i],
  ['company', /\b(company|employer|organi[sz]ation)([\s_-]*name)?\b/i],
  ['location', /^\s*((job|work|office)\s+)?(location|city)\s*$/i],
  ['start', /^\s*(from|start(ing)?(\s+date)?|date\s+from|started)\s*$/i],
  ['end', /^\s*(to|end(ing)?(\s+date)?|date\s+to|until|ended)\s*$/i],
];

/** The label of the date a month or year box is one half of. */
/*
 * Seven wrappers up, not four. Workday draws the date as a `<fieldset>` whose
 * `<legend>` says "From", and the month box sits five wrappers below it: its
 * own section, a focus holder, the `role="group"` — which names itself by an
 * `aria-labelledby` pointing at nothing on the page, so it says nothing — and
 * two layout divs. Measured live on NVIDIA's and Intel's My Experience with a
 * fake resume holding one job: Job Title, Company and Role Description were
 * filled and the required From and To left empty, unreported, because the
 * climb stopped a level short of the legend. The first named group on the way
 * up still answers, so a date inside a block named "Work Experience 1" is
 * never read as that block's name.
 */
/*
 * And out of the components the box is drawn in, a component's host being
 * one wrapper more: see `closestAround`.
 */
function dateHalfOf(input) {
  for (let at = parentAround(input), n = 0; at && n < 7; at = parentAround(at), n++) {
    if (at.matches('[role="group"], fieldset')) {
      const named = clean(at.getAttribute('aria-label')) || clean(fromLabelledBy(at)) || clean(at.querySelector(':scope > legend')?.textContent);
      if (named) return withoutMarkers(named);
    }
  }
  return '';
}

function jobPartOf(input) {
  const label = withoutMarkers(labelFor(input));
  const kind = input instanceof HTMLTextAreaElement ? 'textarea' : input.type === 'checkbox' ? 'checkbox' : input.localName === 'input' ? 'text' : null;
  if (!kind) return null;
  for (const [part, re] of JOB_PARTS) {
    if (!re.test(label)) continue;
    if ((part === 'description') !== (kind === 'textarea')) continue;
    if ((part === 'current') !== (kind === 'checkbox')) continue;
    return { part };
  }
  // Both at once, as Greenhouse's Employment block labels them: "Start date month", "End date year".
  const named = label.match(/^\s*(start|end)\s+date\s+(month|year)\s*$/i);
  if (named && kind === 'text') return { part: named[1].toLowerCase(), half: named[2].toLowerCase() };
  // A month box and a year box, together one end of the job: Workday's From and To.
  const half = /^\s*(month|mm)\s*$/i.test(label || input.placeholder) ? 'month' : /^\s*(year|yyyy)\s*$/i.test(label || input.placeholder) ? 'year' : null;
  if (kind !== 'text' || !half) return null;
  const end = dateHalfOf(input);
  if (/^\s*(from|start)/i.test(end)) return { part: 'start', half };
  if (/^\s*(to|end)/i.test(end)) return { part: 'end', half };
  return null;
}

/** "December", for a box that takes a date as a person writes it. */
const monthWord = (month) => MONTH_NAMES[month - 1].replace(/^./, (c) => c.toUpperCase());

/**
 * The jobs on the resume being sent, into the blocks a form asks a work
 * history in.
 *
 * Workday's "My Experience" wants each job as Job Title, Company, Location,
 * "I currently work here", From, To and Role Description, and none of it was
 * filled: the profile knows one current job, and the Role Description — the
 * box that most plainly *is* the resume — was left for the person to type out
 * again, job by job, from the document they were attaching.
 *
 * The blocks are read in the order the page asks them, a part seen a second
 * time starting the next job. A block somebody has begun is filled only for
 * the job it names, and only where it is still empty; an empty block takes
 * the next job on the resume, in the resume's order. Nothing here writes: the
 * words are the resume's own, and a block for a job it does not list is left
 * exactly as it was.
 */
export function fillWorkHistory(history, { overwrite = false } = {}) {
  const filled = [];
  const skipped = [];
  for (const { block, job } of jobBlocks(history, skipped)) fillJob(block, job, overwrite, filled, skipped);
  return { filled, skipped };
}

/*
 * A month asked as a list, which `fillJob` cannot type into: Greenhouse's
 * Employment block asks "Start date month" and "End date month" as
 * react-select widgets beside plain year boxes. Found with the rest of the
 * block, and chosen once the page can be waited on — see `fillComboboxes`.
 */
const isMonthWidget = (input, found) => found.half === 'month' && isWidgetChoice(input) && !isDisabled(input) && input.getClientRects().length > 0;

/** Each work-history block on the page, and the job on the resume it is for. */
function jobBlocks(history, skipped = []) {
  const pairs = [];
  if (!Array.isArray(history) || history.length === 0) return pairs;

  const blocks = [];
  let block = null;
  for (const input of deepQueryAll('input, textarea')) {
    const found = jobPartOf(input);
    if (!found) continue;
    const usable = found.part === 'current' ? !isDisabled(input) && input.getClientRects().length > 0 : isFillable(input) || isMonthWidget(input, found);
    if (!usable || !inWorkHistory(input)) continue;
    const slot = found.half ? `${found.part}.${found.half}` : found.part;
    if (!block || block.has(slot)) blocks.push((block = new Map()));
    block.set(slot, input);
  }

  const flat = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const used = new Set();
  for (const b of blocks) {
    const typedCompany = flat(b.get('company')?.value);
    const typedTitle = flat(b.get('title')?.value);
    let index = -1;
    if (typedCompany || typedTitle) {
      index = history.findIndex(
        (job, i) =>
          !used.has(i) &&
          (typedCompany
            ? flat(job.company) && (flat(job.company).includes(typedCompany) || typedCompany.includes(flat(job.company)))
            : flat(job.title) === typedTitle),
      );
      if (index < 0) {
        skipped.push({ key: 'work_history', reason: 'this job is not on the resume', description: clean(b.get('company')?.value || b.get('title')?.value).slice(0, 60) });
        continue;
      }
    } else {
      index = history.findIndex((_, i) => !used.has(i));
      if (index < 0) break;
    }
    used.add(index);
    pairs.push({ block: b, job: history[index] });
  }
  return pairs;
}

/** The job months `fillJob` left to a widget, chosen the way every widget is. */
async function fillJobMonths(history, patience) {
  const done = [];
  for (const { block, job } of jobBlocks(history)) {
    for (const [part, when] of [['start', job.start], ['end', job.current ? null : job.end]]) {
      const widget = block.get(`${part}.month`);
      if (!when?.month || !widget || !isWidgetChoice(widget) || widgetShowsAnAnswer(widget)) continue;
      const value = monthWord(when.month);
      if ((await chooseInWidget(widget, `job_${part}_month`, value, { patience, fields: {}, asked: '' })) === 'chose') {
        done.push({ key: `job_${part}_month`, value, widget: true });
      }
    }
  }
  return done;
}

function fillJob(block, job, overwrite, filled, skipped) {
  const put = (slot, key, value) => {
    const input = block.get(slot);
    if (!input || value === undefined || value === null || value === '') return;
    // A list is chosen from later, not typed into. See `fillJobMonths`.
    if (isWidgetChoice(input)) return;
    if (input.value && !overwrite) return;
    const written = slot === 'start' || slot === 'end' ? graduationFor(input, value) : String(value);
    setValue(input, written);
    /*
     * The same month without its leading zero is the month. Workday's month
     * box rewrites "06" as "6" the moment it takes it, and measured live on
     * NVIDIA's and Intel's My Experience the From and To showed "06/2025" and
     * "08/2025" while the report said the months had not been taken — telling
     * the person to type what was already there.
     */
    const took = input.value === written || (/\.month$/.test(slot) && /^\d+$/.test(input.value) && Number(input.value) === Number(written));
    if (took) filled.push({ key, value: written.slice(0, 80) });
    else skipped.push({ key, reason: 'the field would not take it', description: clean(labelFor(input)).slice(0, 60) });
  };
  put('title', 'job_title', job.title);
  put('company', 'job_company', job.company);
  put('location', 'job_location', job.location);
  put('description', 'job_description', job.description);

  /*
   * "I currently work here" is the resume's "Present", not a consent box — so
   * it is ticked for the job that says so, and never unticked: a box already
   * ticked is somebody's statement about their own job.
   */
  const current = block.get('current');
  if (current && job.current && !current.checked) {
    current.click();
    if (current.checked) filled.push({ key: 'job_current', value: 'yes' });
  }

  for (const [part, when] of [['start', job.start], ['end', job.current ? null : job.end]]) {
    if (!when?.year) continue;
    put(part, `job_${part}`, when.month ? `${monthWord(when.month)} ${when.year}` : String(when.year));
    if (when.month) put(`${part}.month`, `job_${part}_month`, String(when.month).padStart(2, '0'));
    put(`${part}.year`, `job_${part}_year`, String(when.year));
  }
}

/* ------------------- Choices that are buttons, not inputs ------------------- */

/**
 * The same questions, asked with ARIA instead of with `<input type=radio>`.
 *
 * `answerRadioGroups` finds the native shape and `unfillableChoices` reports
 * the popup shape as one to pick by hand. Between them is a third that is
 * neither: a group whose options are already on the page and are `<div>`s or
 * `<button>`s wearing `role="radio"` or `role="option"`. Every modern
 * component library builds a segmented yes/no that way — it is what an
 * accessible custom control is *supposed* to look like — and nothing here
 * could see one, so a required work-authorisation question went out blank
 * under a card reporting the form done.
 *
 * Only groups whose options are on screen. A `role="listbox"` that is the
 * popup half of a combobox is a different thing: opening it, waiting for it
 * and choosing inside it is fragile in a way that ends with the wrong answer
 * ticked, and `unfillableChoices` already says those have to be picked by
 * hand. This does not widen that promise.
 */

/**
 * Every ARIA group on the page that is a real, answerable choice.
 *
 * Pulled out of `answerChoiceButtons` because the remembered-answer pass has
 * to walk exactly the same set. Two walks that agree by having been written
 * to look alike do not stay agreeing: the popup exclusions below were added
 * once, to one of them, and a second copy would have gone on opening
 * comboboxes for ever. One function, two callers, no drift.
 */
const A_CHOICE_GROUP = '[role="radiogroup"], [role="listbox"], [role="group"]';
const AN_ARIA_OPTION = '[role="radio"], [role="option"]';

/*
 * The options of an ARIA group: those written in it, and those drawn in the
 * components in it.
 *
 * A group whose options are components — `<div role="radiogroup">` holding
 * an `<x-radio>` for Yes and one for No, each drawing a `<button
 * role="radio">` in its root — has nothing `querySelectorAll` calls an
 * option, and was passed over as no choice at all: measured, "Are you
 * legally authorized to work in the United States?" and the sponsorship
 * question asked that way were neither answered nor mentioned, where the
 * same buttons written into the group were answered.
 *
 * An option is this group's only when no group of its own is drawn between
 * them (`choiceGroupOf`). A component drawing a whole yes/no radiogroup of
 * its own, put inside the page's `role="group"`, is found as that group, and
 * its buttons are not also the page's group's. And the same for the page's
 * own: `group.contains` reaches into a nested group, so a section's
 * `role="group"` labelled "Work authorization", written round the
 * sponsorship and authorization questions each with its own label and
 * radiogroup, took all four buttons as its own. Measured, it was offered to
 * the bank as a question, "Work authorization", and reported as having no
 * matching option, though both questions in it were answered.
 */
function ariaOptionsIn(group) {
  return [...drawnWithin(group)].filter((el) => el.matches(AN_ARIA_OPTION) && choiceGroupOf(el) === group);
}

/*
 * The ARIA group an option is one of: the nearest drawn round it, out through
 * each component (`closestAround`). But a `role="group"` in a listbox is not
 * a question of its own. It is how ARIA heads some of a list's options —
 * "Europe" over France and Germany, "North America" over Canada and the
 * United States — and the options are still the listbox's. Taking the
 * nearest alone, a country list written that way would have no options, and
 * "North America" would be asked as a question.
 */
function choiceGroupOf(option) {
  let group = closestAround(parentAround(option), A_CHOICE_GROUP);
  while (group?.getAttribute('role') === 'group') {
    const outer = closestAround(parentAround(group), A_CHOICE_GROUP);
    if (outer?.getAttribute('role') !== 'listbox') break;
    group = outer;
  }
  return group;
}

/*
 * The words an ARIA option says: its `aria-label`, or what it shows. A
 * component that wears `role="radio"` itself and draws its word in its root
 * from an attribute, `<x-radio role="radio" label="Yes">`, has no
 * `textContent`; nor has a `<button role="radio">` drawn in a root round a
 * slot the page puts its word in. Measured, a Yes and a No drawn the first
 * way read as two empty options, and each question was reported as having
 * none that matched.
 */
function ariaOptionWords(el) {
  return clean(el.getAttribute('aria-label')) || (el.querySelector('slot') ? drawnText(el) : shownText(el));
}

function ariaChoiceGroups() {
  const visible = (el) => el.getClientRects().length > 0;
  const found = [];

  for (const group of deepQueryAll(A_CHOICE_GROUP)) {
    if (isDisabled(group) || !visible(group)) continue;
    /*
     * The popup half of a combobox, which is somebody else's to open. A
     * listbox a combobox owns says so — through `aria-controls`,
     * `aria-owns`, or by sitting under a control that has
     * `aria-haspopup="listbox"` — and those go to `unfillableChoices`.
     */
    if (group.closest('[aria-haspopup="listbox"]')) continue;
    const id = group.getAttribute('id');
    if (id && deepQueryAll(`[aria-controls="${CSS.escape(id)}"], [aria-owns="${CSS.escape(id)}"]`).length > 0) continue;

    const options = ariaOptionsIn(group).filter((el) => visible(el) && !isDisabled(el));
    // One option is not a choice, and nothing on this page asked a question
    // with it. Two is the yes/no pair this exists for.
    if (options.length < 2) continue;

    const question = choiceQuestionFor(group);
    const description = clean([question, group.getAttribute('aria-label'), id].filter(Boolean).join(' '));
    if (!description) continue;

    found.push({ group, options, question, description, chosen: isMarkedChosen, toggles: false });
  }
  return [...found, ...pressedButtonGroups()];
}

/*
 * A question answered by pressing one of a few buttons, as Ashby asks every
 * yes/no.
 *
 * Measured on live Ashby application forms (jobs.ashbyhq.com — Replit,
 * OpenAI, Notion, Ramp and Ashby's own board, September 2026): each yes/no
 * question is a `[data-field-path]` entry holding a `<label>` with the
 * question — its `for` names no element — and then
 *
 *   <div class="… ashby-application-form-input-yesno">
 *     <button aria-pressed="false" data-option="yes">Yes</button>
 *     <button aria-pressed="false" data-option="no">No</button>
 *     <input type="checkbox" tabindex="-1" name="<the field path>">
 *   </div>
 *
 * No role anywhere — not on the buttons, not on the container — so
 * `ariaChoiceGroups` above, which reads `role="radio"` and `role="option"`,
 * saw nothing; nor is there a radio or a select for the other passes. Replit's
 * form asks five of these, two of them "Are you legally authorized to work in
 * the United States?" and "Will you now, or in the future, require
 * sponsorship…", and against a profile saying "Authorized to work in the US"
 * and "No" both were left unpressed and neither was mentioned in the report:
 * `skipped: []`, the card saying the form was done. `choiceQuestions` did not
 * list them either, so an answer given to one could never be remembered or
 * offered back.
 *
 * What the page does, measured there with the same probe:
 *
 *   - `aria-pressed` is the answer. A click presses that button and lets go
 *     of the other; clicking the pressed one again lets go of it, leaving
 *     the question unanswered. So a button already pressed is never pressed
 *     again here.
 *   - It is written by React a microtask after the click, not during it.
 *     Read back synchronously it still says "false", so this cannot be seen
 *     to take inside `fillForm` — see `seePresses`, which reads it once the
 *     page has had its turn.
 *   - The checkbox is `display: none` and is `checked` for Yes and unchecked
 *     for No — it cannot say No, so it is not a read-back — and clicking it
 *     presses Yes. It belongs to the buttons and is never touched: `isFillable`
 *     turns away every checkbox and every control with no box, and nothing
 *     below goes near it.
 *   - Neither button has a `type`, so each is a submit button — but there is
 *     no `<form>`, so pressing one sends nothing. One that would send its
 *     form (`wouldSubmit`) is not a choice and is never pressed.
 *
 * So a group is: between two and eight visible buttons, every one carrying
 * `aria-pressed`, that are the only buttons in their container, with nothing
 * else in there a person could type in or tick. That last is what keeps out
 * a row of toggles beside a text box, and the toolbar roles keep out an
 * editor's Bold and Italic, which are `aria-pressed` buttons too.
 */
const TOGGLE_BARS = '[role="toolbar"], [role="menubar"], [role="tablist"], [contenteditable=""], [contenteditable="true"]';
const isPressed = (el) => el.getAttribute('aria-pressed') === 'true';

function pressedButtonGroups() {
  const visible = (el) => el.getClientRects().length > 0;
  const found = [];
  const seen = new Set();
  for (const button of deepQueryAll('button[aria-pressed]')) {
    const group = button.parentElement;
    if (!group || seen.has(group)) continue;
    seen.add(group);
    if (isDisabled(group) || !visible(group) || group.closest(TOGGLE_BARS)) continue;
    const buttons = [...group.querySelectorAll('button, [role="button"]')].filter(visible);
    const options = buttons.filter(
      (el) => el.localName === 'button' && el.parentElement === group && el.hasAttribute('aria-pressed') && !el.hasAttribute('role'),
    );
    if (options.length < 2 || options.length > 8 || options.length !== buttons.length) continue;
    if (options.some((el) => isDisabled(el) || wouldSubmit(el) || clean(el.getAttribute('aria-label') || el.textContent).length > 80)) continue;
    // The hidden checkbox Ashby keeps beside them has no box; anything that has one is another field.
    if ([...group.querySelectorAll(ANOTHER_FIELD)].some(visible)) continue;

    const question = choiceQuestionFor(group);
    const description = clean([question, group.getAttribute('aria-label'), group.getAttribute('id')].filter(Boolean).join(' '));
    if (!description) continue;
    found.push({ group, options, question, description, chosen: isPressed, toggles: true });
  }
  return found;
}

/*
 * Pressed, and not yet seen to have taken — see `pressedButtonGroups`.
 *
 * Each is a row in `skipped` saying to pick it by hand, which is what it is
 * until the page says otherwise, and what `fillForm` reports if nothing ever
 * reads it back. `seePresses` does, at the top of `fillComboboxes`, and moves
 * the ones the page took into `filled`. Keyed by the row itself, so nothing
 * that is not a plain value goes into the report — a frame's report crosses
 * a message boundary.
 */
const UNSEEN = new WeakMap();
// The groups pressed on this pass, which read as unanswered until the page
// renders, and must not be pressed a second time by the memory pass: a
// second press of the same button lets go of it.
let pressedNow = new WeakSet();

/** Whether this button, and no other in its group, is the one pressed. */
const pressedAlone = (wanted, options) => isPressed(wanted) && options.every((el) => el === wanted || !isPressed(el));

/**
 * Press one button of a group and say what can be said now: `true` if the
 * page already shows it pressed, alone; `false` if it cannot be pressed;
 * otherwise the `{ wanted, options }` to read back once the page has run.
 */
function pressChoice(group, options, wanted) {
  if (pressedAlone(wanted, options)) return true;
  if (isPressed(wanted)) return false;
  pressedNow.add(group);
  wanted.click();
  return pressedAlone(wanted, options) || { wanted, options };
}

/** Wait for what was pressed to show pressed, and count only what does. */
async function seePresses(report, patience = 1000) {
  const waiting = report.skipped.filter((s) => UNSEEN.has(s));
  if (waiting.length === 0) return report;
  const took = (s) => {
    const { wanted, options } = UNSEEN.get(s);
    return wanted.isConnected && pressedAlone(wanted, options);
  };
  await waitFor(() => waiting.every(took) || null, patience);
  const seen = waiting.filter(took);
  const answered = new Set(seen.map((s) => s.description));
  return {
    ...report,
    filled: [...report.filled, ...seen.map((s) => UNSEEN.get(s).row)],
    // And whatever else said this control was still waiting. See the same in `fillForm`.
    skipped: report.skipped.filter((s) => !answered.has(s.description)),
  };
}

function answerChoiceButtons(fields, overwrite, already) {
  const filled = [];
  const skipped = [];
  const taken = new Set(already.map((f) => f.key));

  for (const { group, options, question, description, chosen, toggles } of ariaChoiceGroups()) {
    // The same three gates, in the same order, as `fillForm` and
    // `answerRadioGroups`. See `handBack`.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description, clean(question), surroundingWords(group), boundedSection(group))) continue;

    // Only the keys that are a choice between options, as in
    // `answerRadioGroups` — see `CHOOSABLE` there.
    const named = FIELD_PATTERNS.find(([key, re]) => CHOOSABLE.has(key) && re.test(description));
    const match = named && fields[named[0]] && !taken.has(named[0]) ? named : undefined;
    if (!match) continue;

    const [key] = match;
    const value = fields[key];

    if (options.some(chosen) && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    // Before any option is matched, as in `fillForm`.
    if (aboutAnotherCountry(key, value, description, fields.address_country)) {
      skipped.push({ key, reason: ANOTHER_COUNTRY, description: description.slice(0, 60) });
      continue;
    }
    // Pressed buttons as they always were read; ARIA options as they are drawn.
    const labelOf = toggles ? (el) => clean(el.getAttribute('aria-label') || el.textContent) : ariaOptionWords;
    const wanted =
      options.find((el) => sameOption(labelOf(el), value)) ??
      // And a yes/no pair against a phrase, on the same terms as a radio's.
      yesNoOption(key, value, options.map((el) => ({ label: labelOf(el), el })), description)?.el;
    if (!wanted) {
      const reason = aboutAnotherCountry(key, value, description) ? ANOTHER_COUNTRY : 'no matching option';
      skipped.push({ key, reason, description: description.slice(0, 60) });
      continue;
    }

    /*
     * Clicked, and then read back — which for these is the whole difficulty.
     *
     * A native radio answers "did that take" itself: `checked` is the
     * browser's, and setting it is the last resort when a click is cancelled.
     * These have no such thing. `aria-checked` is an attribute the page
     * writes, and writing it here would be writing the appearance of an
     * answer onto a control whose own state is a variable in somebody's
     * component — the form would submit blank under a green tick, which is
     * the worst outcome this file has.
     *
     * So: click, which is what a person does and what every framework is
     * listening for, and then believe the page. If it did not mark the option
     * chosen, it is reported as needing a hand rather than claimed.
     *
     * A group of pressed buttons is the same, except that its page answers
     * a microtask late and a second press undoes the first — see
     * `pressedButtonGroups`. So it is pressed once, and the reading back is
     * `seePresses`'s, from a row that says "by hand" until then.
     */
    if (toggles) {
      const got = pressChoice(group, options, wanted);
      taken.add(key);
      if (got === true) filled.push({ key, value });
      else {
        const row = { key, reason: 'the page did not take it — pick this one by hand', description: description.slice(0, 60) };
        if (got) UNSEEN.set(row, { ...got, row: { key, value } });
        skipped.push(row);
      }
      continue;
    }
    wanted.click();
    if (chosen(wanted)) {
      filled.push({ key, value });
      taken.add(key);
    } else {
      skipped.push({
        key,
        reason: 'the page did not take it — pick this one by hand',
        description: description.slice(0, 60),
      });
      taken.add(key);
    }
  }
  return { filled, skipped };
}

/**
 * What an ARIA group is asking.
 *
 * Its own label first, because a group that wears `role="radiogroup"` is
 * built by somebody who knows to name it — that is most of the reason the
 * role is there. Then the same fallbacks a native group gets: the row header
 * on a questionnaire laid out as a table, and the nearest heading above.
 */
function choiceQuestionFor(group) {
  const said = fromLabelledBy(group) || clean(group.getAttribute('aria-label'));
  if (said) return said;

  // Out of the components the group is drawn in: see `closestAround`.
  const legend = clean(closestAround(group, 'fieldset')?.querySelector('legend')?.textContent);
  if (legend) return legend;

  const header = clean(closestAround(group, 'tr')?.querySelector('th')?.textContent);
  if (header) return header;

  /*
   * And failing all of that, the text immediately above it — bounded, because
   * an unbounded climb reaches the whole form and reads every other question
   * as part of this one.
   */
  /*
   * And on out of a component, as `groupLabelFor` climbs. `parentElement`
   * stops at the root the group is drawn in, so a yes/no group drawn whole in
   * a component beside the page's "Are you legally authorized to work in the
   * United States?" had no question, and was passed over without a word,
   * where the same group written into the page was answered. The root is one
   * more wrapper, costing none of the three, and the climb carries on from
   * its host only when the root holds no other group: a component drawing two
   * questions' buttons, with no words of its own for either, is not both of
   * them asking the one question beside it.
   */
  /*
   * And in through the slot the page's group is put in, as `labelFor`
   * climbs (`groupDrawnAround`). A component can draw the question round the
   * slot, `<x-question label="Are you legally authorized to work in the
   * United States?">` round the page's radiogroup, and `parentElement` went
   * from the group to the host and on up the page, never into the root: see
   * `headingDrawnBefore`. Its wrappers cost none of the three, as in
   * `labelFor`.
   */
  const HEADINGS = 'label, legend, h1, h2, h3, h4, h5, h6, .label';
  const putInto = new Set();
  let at = groupDrawnAround(group, putInto);
  for (let up = 0; at && up < 3; ) {
    const put = putInto.has(at instanceof ShadowRoot ? at : at.getRootNode());
    const drawn = put && headingDrawnBefore(at, (el) => el === group, HEADINGS);
    const heading = put ? (drawn ? shownText(drawn) : '') : clean(at.querySelector(HEADINGS)?.textContent);
    if (heading) return heading;
    if (at instanceof ShadowRoot) {
      const others = deepQueryAll(A_CHOICE_GROUP, at).filter((g) => g !== group && !drawnInside(g, group) && !drawnInside(group, g));
      if (at.host.id === OURS || others.length > 0) break;
      at = groupDrawnAround(at.host, putInto);
    } else {
      at = groupDrawnAround(at, putInto);
      if (!put) up++;
    }
  }
  return '';
}

/*
 * The question a component draws for what the page puts in its slot: the
 * last element matching `selector` drawn in `scope` before the first thing
 * `ours` picks out, with no field, option or choice group drawn between
 * them, and not drawn round it.
 *
 * Drawn, because the page's radios put in a component's slot are in the
 * page's tree and the question in the component's: neither
 * `querySelectorAll` nor `compareDocumentPosition` relates the two. And
 * only before, with nothing to answer between. A component that draws two
 * questions, each over its own slot, is drawing each for the group put in
 * the slot after it, and the second group is not the first's, as the
 * page's second group under its own label is not. And a component that
 * draws "Are you legally authorized to work in the United States? Please
 * explain." over the slot the page puts its text box in is asking that of
 * the box, not of the Yes and No the page puts in the slot drawn after it.
 */
function headingDrawnBefore(scope, ours, selector) {
  const drawn = [...drawnWithin(scope)];
  const first = drawn.findIndex(ours);
  const between = `${ANOTHER_FIELD}, ${AN_ARIA_OPTION}, ${A_CHOICE_GROUP}`;
  for (let i = first - 1; i >= 0; i--) {
    const el = drawn[i];
    if (drawnInside(el, drawn[first])) continue;
    if (el.matches(between)) return null;
    if (el.matches(selector)) return el;
  }
  return null;
}

/* ---------------------------- Radio groups ---------------------------- */

/**
 * The label a whole group of radios shares.
 *
 * Nothing about an individual radio says what is being asked: the question
 * belongs to the group and each button's label is one of the answers. A
 * fieldset says so outright; failing that, the smallest ancestor that holds the
 * whole group and nothing else is the group, and whatever heading it carries is
 * the question.
 */
/*
 * And out of the components the buttons are drawn in.
 *
 * Every walk here asked `closest` or climbed `parentElement`, and both stop
 * at the root a button is drawn in. So a group whose buttons are components
 * had no question: measured, "Are you legally authorized to work in the
 * United States?" as the legend of a fieldset round a Yes and a No each
 * drawn in a component, and "Will you now or in the future require visa
 * sponsorship?" as the page's label beside a component drawing both
 * buttons, were each described by the group's `name` alone, matched nothing,
 * and were left blank without a word on the card, where the same questions
 * written without components were answered.
 *
 * The fieldset and the row out through each component (see
 * `closestAround`). The climb takes the root as one more wrapper, costing
 * none of the five, and carries on from the host; a wrapper holds the group
 * when every button is drawn inside it (see `drawnInside`). And both of its
 * guards count what is drawn in components, or they let a group borrow a
 * question that is not its own: a wrapper holding the page's label and then
 * a component drawing a text box looked, to `querySelectorAll`, like a
 * wrapper with no other field in it, and the buttons beside the box took its
 * question; and a wrapper holding two components each drawing a yes/no group
 * under its own label looked like one question's own, and the second group
 * took the first one's label.
 */
function groupLabelFor(radios) {
  const first = radios[0];
  const legend = clean(closestAround(first, 'fieldset')?.querySelector('legend')?.textContent);
  if (legend) return legend;

  /*
   * Then whatever the buttons themselves point at, which is how the
   * enterprise systems mark a radio question: no fieldset, no heading inside
   * a wrapper, just `aria-labelledby` on each button naming the div that
   * holds the question. Read from `labelFor` so the same chain — several
   * ids, a missing one, one naming the field itself — applies here too.
   *
   * Only the parts every button agrees on, because each one also carries its
   * own answer: taking the first button's whole label would make the question
   * "Are you legally authorized to work in the US? Yes".
   */
  const shared = radios.map((radio) => radio.getAttribute('aria-labelledby')).filter(Boolean);
  if (shared.length === radios.length && new Set(shared).size === 1) {
    const said = fromLabelledBy(first);
    if (said) return said;
  }
  /*
   * Not the first button's own `aria-label`, which this used to take.
   *
   * The paragraph above says why the shared `aria-labelledby` is read and the
   * first button's own label is not: "each one also carries its own answer".
   * An `aria-label` is that own answer — on the markup every framework
   * generates for an accessible radio group, `aria-label="Yes"` and
   * `aria-label="No"` are the two buttons. Taking the first made the
   * question "Yes", so the group's whole description was "Yes auth_q", no
   * pattern matched, and `if (!match) continue` dropped it without even
   * reporting it skipped: a required work-authorization question left blank
   * under a card saying the form was done. It also returned before the `<th>`
   * route and the ancestor climb below, which are the two branches written to
   * find the real question.
   *
   * A row header, which is how the older enterprise systems lay out a
   * questionnaire: the question in a `<th scope="row">`, the buttons in the
   * `<td>` beside it. `labelFor` learned this for text boxes — see the `th`
   * in its ancestor search — and groups had not, so the question came back
   * empty, the group's whole description was a name like `q_998877`, and it
   * matched nothing. Skipped in silence, on the question most likely to
   * matter.
   *
   * Taken from this row rather than added to the climb below, which would
   * reach the table and could take a column heading from some other row as
   * the question for this one.
   */
  const header = clean(closestAround(first, 'tr')?.querySelector('th')?.textContent);
  if (header) return header;

  /*
   * And in through the slot the page's buttons are put in, as `labelFor`
   * climbs (`groupDrawnAround`). A component can draw the question round the
   * slot, `<x-question label="Will you now or in the future require visa
   * sponsorship?">` round the page's Yes and No, and `parentElement` went
   * from the buttons to the host and on up the page, never into the root. Its
   * wrappers cost none of the five, as in `labelFor`; a root holds the group
   * when it draws every button, held or put in through a slot (`drawsThrough`);
   * another field counts those put in through a slot too (`fieldsDrawnIn`);
   * and the question is the one drawn before the buttons
   * (`headingDrawnBefore`).
   */
  // Where the buttons are, as seen from the tree `group` is in: the first
  // button, or the component it is drawn in.
  let from = first;
  const putInto = new Set();
  let group = groupDrawnAround(first, putInto);
  const holds = (radio) => (group instanceof ShadowRoot ? drawsThrough(group, radio) : drawnInside(group, radio));
  for (let i = 0; i < 5 && group; ) {
    const put = putInto.has(group instanceof ShadowRoot ? group : group.getRootNode());
    if (radios.every(holds)) {
      // Another field in here means this is the form, not this question.
      if (fieldsDrawnIn(group, 'input:not([type=radio]):not([type=hidden]), textarea, select', 1) > 0) break;
      // What a component draws round the slot the buttons are put in. See `headingDrawnBefore`.
      const drawn = put && headingDrawnBefore(group, (el) => radios.includes(el), 'label,legend,.label,[class*="label"]');
      if (drawn && shownText(drawn)) return shownText(drawn);
      const headings = put ? [] : [...group.querySelectorAll('label,legend,.label,[class*="label"]')].filter(
        (el) => !fieldsIn(el, 'input, textarea, select', 1),
      );
      /*
       * Somebody else's buttons are in here too.
       *
       * The guard above only counts fields that are *not* radios, so a plain
       * `<div>` holding several yes/no questions one after another — question
       * text, Yes, No, next question text, Yes, No, with no fieldset and no
       * wrapper each, which is how hand-rolled career forms are written — looks
       * exactly like one question's own group. Taking the first heading then
       * gave every group in it the *first* question's words.
       *
       * Measured: sponsorship asked first and work authorisation second, profile
       * saying "may not need sponsorship" and "yes, authorised". Both groups
       * were labelled "require visa sponsorship", both were answered No, and the
       * form submitted "No, I am not legally authorised to work in the United
       * States" over the applicant's own answer. The report never mentioned the
       * question at all — it listed sponsorship twice.
       *
       * So when the container is shared, take the nearest heading *above* these
       * buttons instead: the question text a person reads them under.
       */
      const shared = deepQueryAll('input[type=radio]', group).some((el) => !radios.includes(el));
      const heading = shared
        ? headings.filter((el) => el.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
        : headings[0];
      if (heading) return clean(heading.textContent);
    }
    if (group instanceof ShadowRoot) {
      if (group.host.id === OURS) break;
      from = group.host;
      group = groupDrawnAround(from, putInto);
    } else {
      group = groupDrawnAround(group, putInto);
      if (!put) i++;
    }
  }
  return '';
}

/**
 * Whether `root` draws `node`: holds it, or draws it through a slot it is
 * put in, however deep.
 */
function drawsThrough(root, node) {
  for (let at = node; at; at = parentAround(at)) if (at.getRootNode() === root) return true;
  return false;
}

/**
 * Can a person see this button — the button, or the thing drawn in its place?
 *
 * Nearly every modern form hides the native radio (`display:none`,
 * `appearance:none`, a 1px clip) and styles a `<span>` inside its `<label>`
 * instead. Asking the input alone whether it occupies space therefore
 * answers "no" about a control the user is looking straight at, and the whole
 * group was skipped before anything was reported: `{filled: [], skipped: []}`
 * on a visible work-authorisation question, which reads exactly like a form
 * with nothing to do. Clicking a hidden input works perfectly well, so the
 * only thing the old test bought was silence.
 *
 * The label still has to be somewhere, though. A group inside a closed
 * accordion or an unmounted step is not this question yet, and both the
 * input and its label have no box at all.
 */
function onScreen(radio) {
  if (radio.getClientRects().length > 0) return true;
  const label = radio.closest('label');
  return Boolean(label && label.getClientRects().length > 0);
}

/** What one button of a group means, which is what a human reads beside it. */
/*
 * A label round a slot says what is slotted into it. A button drawn in a
 * component — `<x-radio value="1">Yes</x-radio>`, its root `<label><input
 * type="radio"><slot></slot></label>` — has a label whose `textContent` is
 * nothing, the word being the page's, shown through the slot: measured, a
 * Yes and a No drawn that way under "Are you legally authorized to work in
 * the United States?" read as two empty options, and the question was
 * reported as having none that matched, where the same buttons written into
 * the page were answered Yes.
 */
function optionLabelFor(radio) {
  const words = (label) => (label.querySelector('slot') ? drawnText(label) : clean(label.textContent));
  const wrapping = radio.closest('label');
  if (wrapping) return words(wrapping);
  if (radio.id) {
    const label = rootOf(radio).querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label) return words(label);
  }
  return clean(radio.value);
}

/**
 * Answer the yes/no questions, which on a great many forms are radios rather
 * than a dropdown — Workable, Teamtailor, and most hand-rolled career sites.
 *
 * These were invisible twice over: skipped by the main pass because a radio
 * always has a value and so looked answered, and never reported, so the form
 * came out with its required work-authorization question blank and the card
 * said everything was done.
 *
 * Nothing is inferred. If the stored answer is "Authorized to work in the US"
 * and the buttons say Yes and No, that is reported rather than guessed:
 * sponsorship and work authorization are declarations with consequences, and
 * an extension should not be the one deciding them.
 */
/** The answers a form offers as options rather than asking you to type. */
const CHOOSABLE = new Set([
  'work_authorization',
  'lives_in_country',
  'requires_sponsorship',
  'address_country',
  'address_state',
  'degree',
  'location',
]);

/**
 * The radio groups on the page, scoped the way a browser scopes them.
 *
 * Pulled out for the same reason as `ariaChoiceGroups`: the remembered-answer
 * pass has to see the same groups, and the form-scoping below is exactly the
 * sort of hard-won detail a second copy would be written without.
 */
function radioGroups() {
  /*
   * A radio group is scoped to its form, and so is the grouping here.
   *
   * Keyed on `name` alone, every radio called "country" on the page became one
   * group — and pages carry more than one form. A job-alerts box above the
   * application, both asking "country", merged into a single group that took
   * its question from the marketing form's legend and ticked the marketing
   * form's option. The application's own country question stayed blank, and the
   * card reported it filled. The reverse happened too: an option the user had
   * already ticked in the unrelated form made the real sponsorship question
   * report "already filled" and stay empty. Either way an application is
   * submitted with a required question blank, after being told it was answered.
   */
  /*
   * And to the component it is drawn in, as a browser scopes it — unless the
   * component draws no other button.
   *
   * A browser groups radios by name only within one tree, and every shadow
   * root is a tree of its own. A yes/no component whose root draws its two
   * buttons under a name of its own, `answer`, used for two questions one
   * after the other, is two groups on the screen; keyed on the name alone it
   * was one group of four, matched against "Yes", "Yes", "No", "No", and
   * measured, "Are you legally authorized to work in the United States?" was
   * reported as having no matching option and the sponsorship question after
   * it was never asked, where the same two questions written into the page
   * under two names were both answered.
   *
   * But a component that draws one button — `<x-radio name="q_9901"
   * value="1">Yes</x-radio>`, its root `<label><input type="radio"><slot>` —
   * is one button of a group the page makes of all the components sharing
   * the name, which such components do with script of their own, since the
   * browser will not. So a root that holds this button and
   * no other is not a scope of its own: the grouping carries on out to the
   * tree its host is in. And a form around the host counts as it does around
   * the page's own radios, since a button drawn in a component has none.
   */
  const trees = new WeakMap();
  let nextTree = 0;
  const treeOf = (radio) => {
    let root = rootOf(radio);
    while (root instanceof ShadowRoot && root.host.id !== OURS && deepQueryAll('input[type=radio]', root).length === 1) root = rootOf(root.host);
    if (!trees.has(root)) trees.set(root, `t${nextTree++}`);
    return trees.get(root);
  };
  const formKeys = new WeakMap();
  let nextForm = 0;
  const scopeOf = (radio) => {
    const form = radio.form ?? closestAround(radio, 'form');
    if (!form) return `doc\u0000${treeOf(radio)}`;
    if (!formKeys.has(form)) formKeys.set(form, `f${nextForm++}`);
    return `${formKeys.get(form)}\u0000${treeOf(radio)}`;
  };

  const groups = new Map();
  for (const radio of deepQueryAll('input[type=radio]')) {
    if (isDisabled(radio) || !onScreen(radio)) continue;
    /*
     * Radios with no name are grouped by the fieldset around them, and a
     * button drawn in a component is in the page's fieldset too: `closest`
     * stops at its root, so a Yes and a No each drawn nameless in a
     * component, under a legend asking "Are you legally authorized to work
     * in the United States?", were no group at all and were passed over
     * without a word, where the same buttons written into the fieldset were
     * answered. Out through each component, as `closestAround` goes.
     */
    const key = radio.name ? `${scopeOf(radio)}\u0000${radio.name}` : closestAround(radio, 'fieldset');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(radio);
  }
  return [...groups.values()];
}

function answerRadioGroups(fields, overwrite) {
  const filled = [];
  const skipped = [];

  for (const radios of radioGroups()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;
    // Before the exclusions and before the match, as in `fillForm`. Radios
    // are the commoner shape for this question: Workable and Teamtailor ask
    // "legally authorized to work without sponsorship" as a pair of buttons.
    if (handBack(description, skipped)) continue;
    // The group's own words, on the same terms as `fillForm`.
    if (isNotAboutYou(description, clean(groupLabelFor(radios)), surroundingWords(radios[0]), boundedSection(radios[0]))) continue;

    /*
     * Only the keys that are a choice between options. A name, an email address
     * or a phone number is typed, never picked from two radio buttons, so a
     * pattern matching one of those against a radio group has matched a word in
     * a sentence rather than a field: "Marketing: may we email you about
     * sponsorship webinars?" matched `email` and was reported as a field
     * waiting for the user.
     */
    // The first choosable pattern that matches, then whether the profile has
    // it — see the same change in `fillForm` for why the two are separate.
    const named = FIELD_PATTERNS.find(([key, re]) => CHOOSABLE.has(key) && re.test(description));
    const match = named && fields[named[0]] ? named : undefined;
    if (!match) continue;

    const [key] = match;
    const value = fields[key];

    if (radios.some((radio) => radio.checked) && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    // Before any option is matched, as in `fillForm`.
    if (aboutAnotherCountry(key, value, description, fields.address_country)) {
      skipped.push({ key, reason: ANOTHER_COUNTRY, description: description.slice(0, 60) });
      continue;
    }
    const wanted =
      radios.find(
        (radio) => sameOption(optionLabelFor(radio), value) || sameOption(radio.value, value),
      ) ??
      // And, failing that, a yes/no pair against a phrase. See `yesNoOption`.
      yesNoOption(
        key,
        value,
        radios.map((radio) => ({ label: optionLabelFor(radio), el: radio })),
        description,
      )?.el;
    if (!wanted) {
      const reason = aboutAnotherCountry(key, value, description) ? ANOTHER_COUNTRY : 'no matching option';
      skipped.push({ key, reason, description: description.slice(0, 60) });
      continue;
    }

    /*
     * Clicked, not set.
     *
     * A text input is filled through the prototype's setter and told about it
     * with `input`/`change` (see `nativeSet`), and doing the same to a radio
     * looked right and was not: React listens for **click** on checkboxes and
     * radios, not change — `shouldUseClickEvent` in its own event plugin — so
     * `onChange` never ran, the component's state stayed empty, and its next
     * render put `checked` back to what its state said. Measured against React
     * 18 with a controlled group: the button ticked, one unrelated keystroke
     * re-rendered the form, the tick vanished, and the work-authorisation
     * question submitted blank. The card said "Filled 3 fields".
     *
     * A click is what a person does, so every framework is listening for it.
     * The setter stays as the way back for a form that cancels the click:
     * ticking the box is better than nothing, and it is what used to happen.
     */
    wanted.click();
    if (!wanted.checked) {
      nativeSet(wanted, 'checked', true);
      wanted.dispatchEvent(ours(new Event('input', { bubbles: true })));
      wanted.dispatchEvent(ours(new Event('change', { bubbles: true })));
    }
    filled.push({ key, value: fields[key] });
  }

  return { filled, skipped };
}

/* -------------------- Answers kept from the last form -------------------- */

/**
 * Every choice on this page that nothing in the profile answers.
 *
 * These are the questions the answer bank is for. The profile knows a name,
 * an email address and a country; it does not know whether you have worked
 * here before, how you heard about the job, or whether you are willing to
 * relocate — and those are asked on every application, worded slightly
 * differently each time, and answered by hand every time.
 *
 * The *question* is what travels, not the description. A description is a bag
 * of words built for regular expressions — label plus `name` plus `id` — and
 * matching "Have you previously been employed by Acme?" against
 * "have you previously been employed by acme prev_emp_q3 q3" is matching
 * against noise. The bank is keyed on what a person reads.
 */
function rememberableChoices() {
  const found = [];
  const add = (question, description, el, answered, choose) => {
    const asked = clean(question);
    // Too short to recognise on the next form. The same bar the bank itself
    // applies on the way in — see `worthRemembering`.
    if (asked.length < 8) return;
    found.push({ question: asked, description, el, answered, choose });
  };

  for (const select of deepQueryAll('select')) {
    if (!isFillable(select)) continue;
    const description = describeField(select);
    if (!description) continue;
    add(
      questionFor(select),
      description,
      select,
      () => selectIsAnswered(select),
      (answer) => chooseInSelect(select, answer),
    );
  }

  for (const radios of radioGroups()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;
    add(
      groupLabelFor(radios),
      description,
      radios[0],
      () => radios.some((radio) => radio.checked),
      (answer) => chooseInRadios(radios, answer),
    );
  }

  for (const { group, options, question, description, chosen, toggles } of ariaChoiceGroups()) {
    add(
      question,
      description,
      group,
      // Pressed on this pass and not drawn yet is answered. See `pressedNow`.
      () => options.some(chosen) || (toggles && pressedNow.has(group)),
      (answer) => (toggles ? pressInGroup(group, options, answer) : chooseInAria(options, answer)),
    );
  }

  return found;
}

/** The questions on this page worth asking the bank about. */
export function choiceQuestions() {
  const out = new Set();
  for (const choice of rememberableChoices()) {
    if (choice.answered()) continue;
    // Never ask the bank about these, so that nothing puts one in it and
    // nothing takes one out. See `NEVER_REMEMBER`, and `DEPENDS_ON_EMPLOYER`
    // for the second: a bank row from before that gate is another
    // employer's answer.
    if (neverRemember(choice.question) || dependsOnEmployer(choice.question)) continue;
    out.add(choice.question);
  }
  // And the search-and-pick widgets. See `answerWidgetsFromMemory`.
  for (const { el, question } of rememberableWidgets()) if (!widgetShowsAnAnswer(el)) out.add(question);
  return [...out];
}

/**
 * Put back the answers this person gave the last form that asked.
 *
 * `remembered` is `[{ question, answer }]` where each `question` is one of
 * the strings `choiceQuestions` handed out — the matching was done by the
 * store, which owns the only similarity function either product has, and the
 * question comes back echoed so that the comparison here is string equality.
 * A second fuzzy matcher living in the extension would drift away from the
 * first one silently, and the drift would show up as an application answered
 * wrongly rather than as a failing test.
 *
 * Three rules, and each is a refusal:
 *
 * - Nothing already answered is touched, `overwrite` or not. Overwrite is a
 *   thing the person asked of their *profile*; the bank is a weaker claim
 *   than the profile and a far weaker one than an answer already on screen.
 * - Nothing personal, even if the bank holds it — by the question or by the
 *   answer. `worthRemembering` keeps these out on the way in, and is asked
 *   again here on the way out, because the bank is older than that gate and the
 *   Workspace lets answers be typed in by hand. A date of birth sitting in
 *   the bank must not be typed into a form by a machine. Nor anything whose
 *   answer belongs to one employer — see `DEPENDS_ON_EMPLOYER` — for the
 *   same reason: the bank already holds "Yes, I have worked here" from
 *   before that gate, and it was Acme's.
 * - Only an option that plainly matches. No yes/no coercion, no nearest
 *   option: the question match is already one inference, and stacking a
 *   second one on it is how a form comes to say "No" where its owner meant
 *   "Yes". Where nothing matches, the control is left for the person, which
 *   is exactly where it was.
 */
function answerFromMemory(remembered) {
  const filled = [];
  const skipped = [];
  if (!Array.isArray(remembered) || remembered.length === 0) return { filled, skipped };

  const bank = bankFrom(remembered);
  if (bank.size === 0) return { filled, skipped };

  for (const choice of rememberableChoices()) {
    if (choice.answered()) continue;
    if (neverRemember(choice.question) || dependsOnEmployer(choice.question)) continue;
    const answer = bank.get(choice.question)?.answer;
    /*
     * And the answer, as `answerWidgetsFromMemory` reads it: a question
     * nobody labelled as personal ("Question 88213") can still have a date or
     * an SSN-shaped option as its answer in the bank, and that is not to be
     * chosen for somebody by a machine either.
     */
    if (!answer || !worthRemembering({ question: choice.question, answer }).keep) continue;

    const took = choice.choose(answer);
    const row = { key: 'remembered', value: answer, description: choice.description.slice(0, 60) };
    if (took === true) filled.push({ ...row, question: choice.question, remembered: true });
    else if (took) {
      // Pressed, and read back by `seePresses` once the page has drawn it.
      const waiting = { ...row, reason: 'the page did not take it — pick this one by hand' };
      UNSEEN.set(waiting, { ...took, row: { ...row, question: choice.question, remembered: true } });
      skipped.push(waiting);
    } else skipped.push({ ...row, reason: 'the answer you gave before is not one of the options here' });
  }
  return { filled, skipped };
}

/** The bank as the worker handed it over, by the question it was asked about. */
function bankFrom(remembered) {
  const bank = new Map();
  for (const { question, answer, itemId } of Array.isArray(remembered) ? remembered : []) {
    const asked = clean(question);
    if (asked && String(answer ?? '').trim()) bank.set(asked, { answer: String(answer).trim(), itemId });
  }
  return bank;
}

/* ------------------------ Answers typed on the last form ------------------------ */

/*
 * The short boxes nothing in the profile answers, typed into by hand on every
 * application.
 *
 * Measured with the walk in tests/reusing.mjs — a Greenhouse-shaped form
 * answered once by hand and sent, then a Lever-shaped one asking the same
 * questions in its own words. Of the eight short boxes on the first form
 * ("How did you hear about us?", "Earliest start date", "Expected salary",
 * "Current employer", "Preferred first name", "Portfolio link", and "Are you
 * 18 or older?" and "Willing to relocate?" asked as text), none went into the
 * bank and none came back on the second: the chosen answers were kept, and
 * these — the ones that are actually typed, letter by letter, each time —
 * never were.
 *
 * One line only. A `<textarea>` is the card's: `findQuestions` offers every
 * one that asks something, the bank is matched against it there, and "Save
 * for next time" keeps it — so a second route into the bank for the same box
 * would be two answers to one question, kept two ways. A combobox is a search
 * box, not an answer; a date or a telephone box is the profile's or nobody's.
 */
const ONE_LINE = new Set(['text', 'search', 'url', 'number']);

/*
 * Somebody else's details, by the box's own words or the group around it —
 * the first of `NOT_ABOUT_YOU`, which is the one about people. The rest of
 * that list is what the profile does not answer ("How did you hear about
 * us?", "Are you willing to relocate?"), which is exactly what this is for.
 */
const OTHER_PEOPLE = NOT_ABOUT_YOU[0];

/**
 * The profile key this box asks for, the way `fillForm` would find it — or
 * null when the profile could never answer it.
 */
function profileKeyOf(input, description) {
  const label = clean(labelFor(input));
  if (asksBothAtOnce(description)) return 'work_authorization';
  if (isNotAboutYou(description, label, surroundingWords(input), boundedSection(input))) return null;
  const dated = educationDateKey(input, description);
  const found = dated ? [dated] : FIELD_PATTERNS.find(([, re]) => re.test(description));
  let key = found ? (dated ? found[0] : addressPartByLabel(label, found[0])) : null;
  if (!key && BARE_NAME.test(withoutMarkers(labelFor(input)))) key = 'full_name';
  if (!key) key = nameHalf(input);
  if (!key) return null;
  key = wholeDateKey(input, key, description);
  // Asked as a yes or a no, `fillForm` leaves it, so the profile does not answer it.
  return asksYesOrNo(input, key) ? null : key;
}

/**
 * Whether this is a short box whose answer is the person's to type, and what
 * it asks. `fields` is the profile as the last Autofill had it: a box the
 * profile has a value for is the profile's, and one it could fill but has
 * nothing for — "Portfolio link" on a profile with no website — is the
 * person's. With no profile to go on, every box the profile *could* answer is
 * taken to be the profile's, which only ever keeps less.
 */
function typedBox(input, fields) {
  if (!(input instanceof HTMLInputElement) || !ONE_LINE.has(input.type)) return null;
  if (isDisabled(input) || input.readOnly || isWidgetChoice(input) || isSelect2Part(input)) return null;
  if (rootOf(input)?.host?.id === OURS) return null;
  const description = describeField(input);
  if (!description) return null;
  /*
   * Not `asksForWriting`, which reads a one-line box's label for the way an
   * essay prompt opens so that the profile is not typed into one — and "How
   * did you hear about us?" opens that way. Measured: the commonest of these
   * questions was the one box on the form never kept. Whether an answer is
   * writing is read off the answer instead; see `worthRememberingTyped`.
   */
  const question = clean(questionFor(input));
  if (question.length < 8) return null;
  if (OTHER_PEOPLE.test(`${surroundingWords(input)} ${description}`)) return null;
  // A row of a past job or a school is the resume's. See `fillWorkHistory`.
  if (inWorkHistory(input) || EDUCATION_SECTION.test(sectionOf(input))) return null;
  const key = profileKeyOf(input, description);
  if (key && (!fields || withCityAndState(fields)[key])) return null;
  return { question, description, el: input };
}

function typedBoxes(fields) {
  const found = [];
  for (const input of deepQueryAll('input')) {
    if (!isFillable(input)) continue;
    const box = typedBox(input, fields);
    if (box) found.push(box);
  }
  return found;
}

/**
 * The typed questions on this page worth asking the bank about: empty, and
 * none that `mayRememberTyped` refuses — so nothing personal, nobody else's
 * and nothing about this employer is asked about, as well as never kept.
 */
export function typedQuestions(fields = null, company = '') {
  const out = new Set();
  for (const box of typedBoxes(fields)) {
    if (box.el.value.trim()) continue;
    if (!mayRememberTyped(box.question, company).keep) continue;
    out.add(box.question);
  }
  return [...out];
}

/*
 * Which bank row filled a box, so that changing what was put there changes
 * that row rather than starting another. The bank keys a row on the question
 * as it was first asked; the second form's wording is a different string, and
 * saved under it the corrected answer sat beside the old one — and the old
 * one, found first, was what the third form got.
 */
const FROM_BANK = new WeakMap();

/**
 * Type back the answers this person typed on the last form that asked.
 *
 * The same three refusals as `answerFromMemory`: nothing already answered,
 * nothing `worthRememberingTyped` would not have kept, and only what the box
 * takes as it is — a box that will not hold it is put back as it was.
 */
function answerTypedFromMemory(remembered, fields, company) {
  const filled = [];
  const skipped = [];
  const bank = bankFrom(remembered);
  if (bank.size === 0) return { filled, skipped };

  for (const box of typedBoxes(fields)) {
    if (box.el.value.trim()) continue;
    const kept = bank.get(box.question);
    if (!kept) continue;
    if (!worthRememberingTyped({ question: box.question, answer: kept.answer, company }).keep) continue;

    const row = { key: 'remembered', value: kept.answer, description: box.description.slice(0, 60) };
    setValue(box.el, kept.answer);
    if (box.el.value !== kept.answer || browserWouldRefuse(box.el)) {
      setValue(box.el, '');
      skipped.push({ ...row, reason: 'the box would not take the answer you gave before' });
      continue;
    }
    if (kept.itemId) FROM_BANK.set(box.el, kept.itemId);
    filled.push({ ...row, question: box.question, remembered: true, typed: true });
  }
  return { filled, skipped };
}

/**
 * Watch what the person types into those boxes, so the next form can have it.
 *
 * Written down when the application is sent or the form is left, not as it
 * is typed: `take` is what the caller calls then. What is typed is told as it
 * settles — each `change`, which is a box being left — so the card can say
 * what will be kept and offer not to; and `take` reads every box typed in
 * again, because the last one is often still being typed in when Submit is
 * pressed.
 *
 * Only what a person typed: `isTrusted`, so what Autofill wrote — which fires
 * the same events, deliberately, so the page's framework hears it — is never
 * taken for an answer the person gave. Changing what Autofill wrote is
 * typing, and is kept. `profile` answers the profile as the last Autofill had
 * it; see `typedBox`.
 *
 * Returns `{ stop, take }`.
 */
export function watchTyped(tell, { profile = () => null, company = () => '' } = {}) {
  const typed = new Set();
  const read = (input) => {
    let box;
    try {
      box = typedBox(input, profile());
    } catch {
      return null;
    }
    if (!box) return null;
    const answer = clean(input.value);
    const verdict = worthRememberingTyped({ question: box.question, answer, company: company() });
    const itemId = FROM_BANK.get(input);
    return verdict.keep
      ? { question: box.question, answer, keep: true, ...(itemId ? { itemId } : {}) }
      : { question: box.question, answer, keep: false, why: verdict.why };
  };
  const targetOf = (event) => {
    if (!event.isTrusted) return null;
    const target = event.composedPath?.()?.[0] ?? event.target;
    return target instanceof HTMLInputElement ? target : null;
  };
  const onInput = (event) => {
    const input = targetOf(event);
    if (input) typed.add(input);
  };
  const onChange = (event) => {
    const input = targetOf(event);
    if (!input) return;
    typed.add(input);
    const said = read(input);
    if (said) tell(said);
  };
  document.addEventListener('input', onInput, true);
  document.addEventListener('change', onChange, true);
  return {
    stop() {
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
    },
    /*
     * Every box typed in that is still on the page, read as it stands. One
     * gone with its step was told when it was left, and that stands.
     */
    take() {
      for (const input of typed) {
        if (!input.isConnected) continue;
        const said = read(input);
        if (said) tell(said);
      }
      typed.clear();
    },
  };
}

/* ------------------- Answers picked in a search-and-pick widget ------------------- */

/*
 * A react-select, or anything built like one: a text box that is a combobox,
 * and a menu it opens. Greenhouse asks its custom questions this way on most
 * boards now, and a choice made in one was neither kept nor offered again.
 * `watchChoices` hears a `<select>`'s change and a radio's click, and here
 * there is neither. The option is chosen on mousedown and the menu closes at
 * once, so by the time a click arrives its option has left the page. On the
 * way back, `choiceQuestions` asked the bank only about selects, radios and
 * ARIA groups.
 *
 * Only a widget the profile does not answer. The country, the school, the
 * degree are the profile's, and `fillComboboxes` fills those from it.
 */
const WIDGETS = '[role="combobox"], [aria-haspopup="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"]';

/** What a widget asks, when it is a question for the bank. */
function widgetQuestion(widget) {
  if (!isWidgetChoice(widget) || widget.getAttribute('role') === 'listbox' || isDisabled(widget)) return null;
  if (rootOf(widget)?.host?.id === OURS) return null;
  const description = describeField(widget);
  if (!description) return null;
  const question = clean(questionFor(widget));
  if (question.length < 8) return null;
  if (OTHER_PEOPLE.test(`${surroundingWords(widget)} ${description}`)) return null;
  if (inWorkHistory(widget) || EDUCATION_SECTION.test(sectionOf(widget))) return null;
  if (profileKeyOf(widget, description)) return null;
  if (neverRemember(question) || dependsOnEmployer(question)) return null;
  return { question, description };
}

/** The widgets on this page that ask the bank's kind of question. */
function rememberableWidgets() {
  const found = [];
  for (const widget of withPlainDropdowns(deepQueryAll(WIDGETS))) {
    if (widget.getClientRects().length === 0) continue;
    // A combobox `<div>` around its own text box is one question.
    if (found.some(({ el }) => el.contains(widget) || widget.contains(el))) continue;
    const said = widgetQuestion(widget);
    if (said) found.push({ ...said, el: widget });
  }
  return found;
}

/**
 * The widget a menu belongs to: the one that names it (`aria-controls`,
 * `aria-owns`), or failing that the only combobox beside it, which is where
 * react-select draws its menu. Nothing when that is a guess.
 */
function ownerOfMenu(list) {
  if (list.id) {
    const id = CSS.escape(list.id);
    const named = deepQueryAll(`[aria-controls~="${id}"], [aria-owns~="${id}"]`).find((el) => isWidgetChoice(el));
    if (named) return named;
  }
  for (let at = list.parentElement, up = 0; at && up < 3; at = at.parentElement, up++) {
    const boxes = [...at.querySelectorAll(WIDGETS)].filter((el) => el !== list && !list.contains(el));
    if (boxes.length === 1) return boxes[0];
    if (boxes.length > 1) return null;
  }
  return null;
}

/** Whether the widget is now showing this answer as its choice. */
function widgetHolds(widget, answer) {
  if (PLAIN.has(widget)) return sameOption(plainShown(widget), answer);
  if (!widgetShowsAnAnswer(widget)) return false;
  return clean(controlOf(widget).textContent).toLowerCase().includes(clean(answer).toLowerCase());
}

/**
 * A person's pick in one of these widgets, as `watchChoices` tells a choice:
 * `{ question, answer }`, once the widget is seen to hold it. Only a pick the
 * person made (`isTrusted`), so what Autofill chose is never taken for one.
 */
function watchWidgetPicks(write, watching) {
  /*
   * Read back as soon as the page has drawn the pick, and again a little
   * later for a page that draws it late. And at once on a send or on
   * leaving: a pick followed straight by Submit was lost when it waited
   * 150ms to be read back, because the page had gone by then.
   */
  const pending = new Set();
  const settle = (pick) => {
    if (!pending.has(pick) || !watching()) return;
    if (!widgetHolds(pick.widget, pick.answer)) return;
    pending.delete(pick);
    write({ question: pick.question, answer: pick.answer });
  };
  const settleAll = () => {
    for (const pick of [...pending]) settle(pick);
  };
  const expect = (pick) => {
    pending.add(pick);
    for (const ms of [0, 100, 400]) setTimeout(() => settle(pick), ms);
    // Given up on after that: a pick the widget never showed is not a choice.
    setTimeout(() => pending.delete(pick), 450);
  };
  const question = (widget) => {
    try {
      return widgetQuestion(widget)?.question ?? null;
    } catch {
      return null;
    }
  };
  /*
   * A plain dropdown's pick, which has no option to say it is one: the press
   * that opened it, then the words of the next press outside it — believed
   * only once the dropdown shows those words as its own. See `PLAIN`.
   */
  let opened = null;
  const onPlainPress = (target) => {
    if (!target || rootOf(target)?.host?.id === OURS) return;
    let control = null;
    for (let at = target, up = 0; at && up < 6 && !control; at = at.parentElement, up++) {
      control = PLAIN.has(at) ? at : plainControlOver(at);
    }
    if (control) {
      const asked = question(control);
      opened = asked ? { widget: control, question: asked } : null;
      return;
    }
    const was = opened;
    opened = null;
    if (!was?.widget.isConnected) return;
    const answer = clean(target.textContent);
    if (!answer || answer.length > 120) return;
    expect({ widget: was.widget, answer, question: was.question });
  };
  const onPick = (event) => {
    if (!event.isTrusted) return;
    const target = event.composedPath?.()?.[0] ?? event.target;
    const option = target?.closest?.('[role="option"]');
    const list = option?.closest('[role="listbox"]');
    if (!list) return onPlainPress(target);
    if (rootOf(list)?.host?.id === OURS || isSelect2Part(list)) return;
    const widget = ownerOfMenu(list);
    if (!widget) return;
    const asked = question(widget);
    if (!asked) return;
    // Read now: the menu closes on this press and takes the option with it.
    const answer = clean(option.getAttribute('aria-label') || option.textContent);
    if (!answer) return;
    // And believed once the page has drawn it, the way `tookIt` reads a choice back.
    expect({ widget, answer, question: asked });
  };
  // The plain dropdowns already on the page, so one showing a pick is still known.
  try {
    plainDropdowns();
  } catch {
    // A page that throws from a getter is not a reason to stop watching.
  }
  document.addEventListener('mousedown', onPick, true);
  document.addEventListener('submit', settleAll, true);
  window.addEventListener('pagehide', settleAll);
  return () => {
    document.removeEventListener('mousedown', onPick, true);
    document.removeEventListener('submit', settleAll, true);
    window.removeEventListener('pagehide', settleAll);
  };
}

/**
 * Choose in these widgets what the person chose on the last form that asked:
 * the same refusals as `answerFromMemory`, and only an option that plainly
 * says the answer, driven and read back by `chooseInWidget` as a profile
 * value would be. Whatever did not take is put back as it was.
 */
export async function answerWidgetsFromMemory(remembered, report, { patience = 4000 } = {}) {
  const bank = bankFrom(remembered);
  if (bank.size === 0) return report;
  const filled = [];
  for (const { el, question, description } of rememberableWidgets()) {
    if (widgetShowsAnAnswer(el)) continue;
    const answer = bank.get(question)?.answer;
    if (!answer || !worthRemembering({ question, answer }).keep) continue;
    const how = await chooseInWidget(el, 'remembered', answer, { patience, fields: {}, asked: question });
    if (how === 'chose') {
      filled.push({ key: 'remembered', value: answer, description: description.slice(0, 60), question, remembered: true, widget: true });
    }
  }
  return filled.length ? { ...report, filled: [...report.filled, ...filled] } : report;
}

/** Whether an ARIA option is the one marked as chosen. */
const isMarkedChosen = (el) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

/** Pick an option in a native `<select>` by its text or its value. */
function chooseInSelect(select, answer) {
  const choosable = [...select.options].filter((o) => !isDisabled(o));
  const option = choosable.find((o) => sameOption(o.textContent, answer) || sameOption(o.value, answer));
  if (!option) return false;
  const was = select.value;
  nativeSet(select, 'value', option.value);
  // Two options can share a value, so the write can land on the placeholder.
  // The same read-back `fillForm` does, and for the same reason.
  if (select.selectedOptions[0] !== option) return false;
  select.dispatchEvent(ours(new Event('input', { bubbles: true })));
  select.dispatchEvent(ours(new Event('change', { bubbles: true })));
  return standInTookIt(select, was);
}

/** Tick a radio in a group by its label or its value. */
function chooseInRadios(radios, answer) {
  const wanted = radios.find(
    (radio) => sameOption(optionLabelFor(radio), answer) || sameOption(radio.value, answer),
  );
  if (!wanted) return false;
  // Clicked, not set — React listens for click on radios. See
  // `answerRadioGroups`, which explains what setting it instead cost.
  wanted.click();
  if (!wanted.checked) {
    nativeSet(wanted, 'checked', true);
    wanted.dispatchEvent(ours(new Event('input', { bubbles: true })));
    wanted.dispatchEvent(ours(new Event('change', { bubbles: true })));
  }
  return wanted.checked;
}

/** Click an ARIA option by its label, and believe the page about the result. */
function chooseInAria(options, answer) {
  const wanted = options.find((el) => sameOption(ariaOptionWords(el), answer));
  if (!wanted) return false;
  wanted.click();
  // Never written here: `aria-checked` belongs to the page's own component,
  // and forging it puts a tick over a form that will submit blank. See
  // `answerChoiceButtons`.
  return isMarkedChosen(wanted);
}

/**
 * Press the button of a group that says the answer, and nothing near it —
 * the same plain match as the rest of the memory pass. What comes back is
 * `pressChoice`'s: seen now, not possible, or to be read back later.
 */
function pressInGroup(group, options, answer) {
  const wanted = options.find((el) => sameOption(clean(el.getAttribute('aria-label') || el.textContent), answer));
  return wanted ? pressChoice(group, options, wanted) : false;
}

/**
 * Choices that are not form controls at all.
 *
 * Workday's dropdowns — and the react-select widgets half the other systems
 * have moved to — are a button that opens a listbox. There is nothing to set a
 * value on, and driving them means synthesising clicks against markup that
 * changes between releases, which is exactly the kind of guessing that fills a
 * form wrongly.
 *
 * So they are not filled. But they were also not mentioned, which is worse:
 * the report said everything it could do was done, the form looked handled,
 * and the required country dropdown was still empty at the bottom of page
 * three. Naming them costs nothing and is the difference between "done" and
 * "done silently wrong".
 */
const PICK_BY_HAND = 'this one has to be picked by hand';

/**
 * The widgets on the page that ask something the profile answers, with the
 * element — shared by the report below and by `fillComboboxes`, so the two
 * cannot disagree about which widget is which question.
 */
/*
 * One widget per question, not one per key.
 *
 * Every key used to be claimed by the first widget that asked it, and by any
 * box `fillForm` had already typed it into, so a second question wanting the
 * same answer was never named, never driven and never reported. Measured live
 * on Greenhouse boards with a fake profile: GitLab's required "What is your
 * current country of residence?", Chime's required "Country" and Brex's
 * required "What country are you based in?" were all left on "Select..."
 * because the phone's country picker, above them, had taken
 * `address_country`; Affirm's required phone country was left empty because a
 * text box lower down had; and Anthropic's required "Will you now or will you
 * in the future require employment visa sponsorship…" was left blank because
 * "Do you require visa sponsorship?" had taken `requires_sponsorship`. Each
 * is the same answer to a question asked twice.
 *
 * The education keys are still claimed once. A second School or Degree is
 * another school, and `fillEducation` fills those one block at a time from
 * the resume; given the first answer again they would all say the newest one.
 * And a widget inside another — a combobox `<div>` around its own text box —
 * is the same question once.
 */
function widgetChoices(fields, filled) {
  const already = new Set(filled.map((f) => f.key).filter((key) => EDUCATION_KEYS.test(key)));
  const found = [];
  const seen = [];

  for (const widget of withPlainDropdowns(
    deepQueryAll(
      `[role="combobox"], [aria-haspopup="listbox"], [role="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [data-uxi-widget-type="selectinput"], ${FABRIC_SELECT}`,
    ),
  )) {
    if (!isWidgetChoice(widget)) continue;
    if (widget.getClientRects().length === 0) continue;

    const description = describeField(widget);
    if (!description) continue;
    /*
     * Handed back here too, as `handBack` hands it back everywhere else.
     *
     * Workday asks every yes/no as one of these, and this was the one path
     * that never asked. Measured against a profile that is authorized and
     * needs sponsorship: "Are you legally authorized to work in the United
     * States without sponsorship?" was answered "Yes" from the authorization
     * alone, "Are you able to work in the U.S. without sponsorship?" "Yes"
     * from the sponsorship alone — both declaring a right to work unsponsored
     * that the applicant does not have — and the plain question below them
     * was left blank, because the first had claimed its key. So it claims
     * nothing, is never driven, and is reported for what it is.
     */
    if (asksBothAtOnce(description)) {
      found.push({ key: 'work_authorization', description: description.slice(0, 60), el: widget, both: true });
      continue;
    }
    if (isNotAboutYou(description, clean(labelFor(widget)), surroundingWords(widget), boundedSection(widget))) continue;

    /*
     * The first pattern that matches, and only then whether the profile has
     * it — the rule `fillForm` follows, for the reason it gives there.
     *
     * This still searched for the first pattern that matched *and* had a
     * value *and* was not already claimed, so it walked past country on a
     * profile with no country and named a "Country/Region" widget as the
     * state, `region` being a state word. Measured on a form with a
     * Country/Region widget above a State widget and a profile holding only
     * the state: the report said the state was to be picked by hand at the
     * Country/Region widget, and — the state now being claimed — said nothing
     * about the State widget at all. `fillComboboxes` then typed the state
     * into the country box.
     *
     * What a widget asks does not depend on what the profile holds or what
     * has been claimed already; a widget whose question the profile cannot
     * answer, or that has been answered elsewhere, is simply not named.
     */
    const dated = educationDateKey(widget, description);
    const key = dated || addressPartByLabel(clean(labelFor(widget)), FIELD_PATTERNS.find(([, re]) => re.test(description))?.[0]);
    if (!key || !fields[key] || already.has(key)) continue;
    if (seen.some((other) => other.contains(widget) || widget.contains(other))) continue;
    seen.push(widget);
    /*
     * One already showing an answer is answered, and claims its question.
     *
     * A `<select>` with a real option chosen has always counted as filled;
     * a widget never did. Workday's Country dropdown arrives saying "United
     * States of America", and it was pressed open again, searched for an
     * option spelled "United States", and — none spelled that way within the
     * wait — reported as a country still to pick by hand, over a form that
     * had one. A person's own choice, or the form's default, is not this
     * tool's to reopen.
     */
    /*
     * And a listbox with an option marked chosen. Its options are on the page,
     * so `answerChoiceButtons` answers it as an ARIA group and reads it back
     * by that mark, and `widgetShowsAnAnswer` reads a listbox as never
     * showing one. Measured, a Country listbox the fill had answered United
     * States was reported filled and, in the same report, as one to pick by
     * hand. One left unchosen is still named here.
     */
    /*
     * And one showing this very answer, whatever it is drawn as. A widget
     * with a typing box is never read as showing an answer above, so one
     * already holding it was pressed open and chosen in again. Where the
     * answer was drawn beside an empty box, or the list stayed open after the
     * choice, nothing that press did could be seen, and it was put back and
     * reported as one to pick by hand: measured, a School, a Degree and a
     * Discipline already answered were all reported that way, and the
     * Discipline's box was emptied on the way out.
     */
    if (widgetShowsAnAnswer(widget) || listboxHoldsAChoice(widget) || widgetShowsThisAnswer(widget, key, String(fields[key]))) {
      if (EDUCATION_KEYS.test(key)) already.add(key);
      continue;
    }
    if (anotherLevelOfStudy(widget, key, fields)) continue;
    // Named, so it is reported for what it is and never driven: Workday's
    // list picks "Yes" by its text too. See `aboutAnotherCountry`.
    const elsewhere = aboutAnotherCountry(key, fields[key], description, fields.address_country);
    found.push({ key, description: description.slice(0, 60), asked: description, el: widget, elsewhere });
    if (EDUCATION_KEYS.test(key)) already.add(key);
  }
  return found;
}

/** Whether a listbox has one of its own options, as `choiceGroupOf` counts them, marked chosen. */
function listboxHoldsAChoice(widget) {
  return widget.getAttribute('role') === 'listbox' && ariaOptionsIn(widget).some(isMarkedChosen);
}

/**
 * Whether a widget already shows the profile's answer: its typing box holding
 * it, or its control drawing it (`shownBy`), and any hidden input it submits
 * through holding something. Text typed into a box and never chosen leaves
 * that input empty, and is no answer.
 *
 * The answer as a whole word or words, not a run of letters: "No" is not in
 * "None selected". And a yes or no, which is short enough to be in anything,
 * only as the whole of what is shown.
 */
function widgetShowsThisAnswer(widget, key, value) {
  const hidden = hiddenPartner(widget);
  if (hidden && !hidden.value) return false;
  const answer = clean(value).toLowerCase();
  if (!answer) return false;
  const escaped = answer.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&');
  const whole = new RegExp(String.raw`(?:^|[^\p{L}\p{N}])${escaped}(?:$|[^\p{L}\p{N}])`, 'u');
  return [typingBoxOf(widget)?.value, shownBy(widget)].some((shown) => {
    const said = clean(shown).toLowerCase();
    if (!said) return false;
    if (said === answer || sameAnswerSpelledOtherwise(key, said, value)) return true;
    return !YES_NO_KEYS.has(key) && whole.test(said);
  });
}

function unfillableChoices(fields, filled) {
  return widgetChoices(fields, filled).map(({ key, description, both, elsewhere }) => ({
    key,
    reason: both ? TWO_AT_ONCE : elsewhere ? ANOTHER_COUNTRY : PICK_BY_HAND,
    description,
  }));
}

/* ---------------------------------------------------------------------- *
 * Driving the widgets, where that can be done without guessing             *
 * ---------------------------------------------------------------------- */

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll until `find` answers something, or give up. */
/*
 * How long a widget's options may sit unchanged, without the answer among
 * them, before that is taken as the answer. A list that has arrived and
 * stopped changing is not going to grow the option; waiting out the whole
 * patience on it only made a form with several of them slow.
 */
const SETTLED_MS = 800;

/**
 * This widget's option for the answer, as its list arrives — or nothing,
 * once the list has settled without it, or when nothing has appeared by
 * `quiet`, or at `patience`.
 */
async function waitForOption(widget, key, value, openBefore, { patience, quiet = patience, fields, asked = '' }) {
  const began = Date.now();
  let seen = null;
  let since = began;
  let hushed = began;
  for (;;) {
    const options = optionsOf(widget, openBefore);
    const hit = exactOption(options, key, value, fields, asked);
    if (hit) return hit;
    const now = Date.now();
    /*
     * A list the widget says it is still fetching has not arrived yet, and
     * "nothing has appeared by `quiet`" is not true of it.
     *
     * Greenhouse's Degree is a fixed list of ten, but it is fetched from the
     * board's API the first time the menu opens, and the menu says
     * "Loading..." until it comes. Measured on Stripe's embed: 450 to 900ms
     * for the degrees, about 500 for the schools, about 350 for the
     * disciplines — against a `quiet` of 400. So the degree was given up on
     * while it loaded and the profile's wording typed in instead, and the
     * board's search for "Bachelor of Science" answers nothing at all (its
     * entry is "Bachelor's Degree"): the box sat showing the typed words for
     * the whole of the patience — which is what "filled for a second" was —
     * and was then taken back to "Select...". Whether it worked depended on
     * how quickly the board answered that day.
     */
    if (stillLoading(widget, openBefore)) {
      hushed = now;
      since = now;
    }
    const said = options.map((o) => o.textContent).join('\n');
    if (said !== seen) {
      seen = said;
      since = now;
    } else if (options.length && now - since >= SETTLED_MS) {
      return null;
    }
    if (!options.length && now - hushed >= quiet) return null;
    if (now - began >= patience) return null;
    await pause(50);
  }
}

/**
 * Whether the widget says it is still fetching its options: react-select's
 * spinner in the control, or its "Loading..." notice in the menu, or a list
 * marked busy.
 */
function stillLoading(widget, openBefore) {
  const control = controlOf(widget);
  if (control.querySelector?.('[class*="loading-indicator"], [class*="loadingIndicator"]')) return true;
  const box = typingBoxOf(widget);
  if ([widget, box].some((el) => el?.getAttribute('aria-busy') === 'true')) return true;
  const ids = [widget, box]
    .filter(Boolean)
    .flatMap((el) => `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/))
    .filter(Boolean);
  const lists = ids.map((id) => widget.getRootNode().getElementById?.(id) ?? document.getElementById(id)).filter(Boolean);
  // A list it names, or failing that the one menu its press opened.
  const fresh = lists.length ? lists : visibleListboxes().filter((l) => l !== widget && !openBefore?.has(l));
  return (lists.length || fresh.length === 1) &&
    fresh.some((l) => l.getAttribute('aria-busy') === 'true' || l.querySelector('[class*="notice--loading"], [class*="loadingMessage"], [aria-busy="true"]'));
}

async function waitFor(find, patience) {
  const until = Date.now() + patience;
  for (;;) {
    const got = find();
    if (got) return got;
    if (Date.now() >= until) return null;
    await pause(50);
  }
}

/** The text box a widget types into, if it has one. */
function typingBoxOf(widget) {
  if (widget instanceof HTMLInputElement) return widget;
  return widget.querySelector?.('input:not([type=hidden])') ?? null;
}

/** The listboxes showing on the page right now. */
function visibleListboxes() {
  return deepQueryAll('[role="listbox"]').filter(isShowing);
}

/*
 * Whether an element is drawn where it can be seen. `visibility: hidden`
 * keeps a box, so a closed menu that an exit transition leaves mounted
 * counted as open — and as a second listbox it refused every unlinked widget
 * on the page.
 */
function isShowing(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * The options this widget opened — and only this widget's.
 *
 * The list it names through `aria-controls`, `aria-owns` or
 * `aria-activedescendant`, which is how an accessible widget says which popup
 * is its own. Failing that, the listbox its own press opened, or the one
 * showing inside it, but only if exactly one is: two new listboxes and no
 * pointer to either is a page where choosing is a guess about which one
 * answers this question, and guessing is what this does not do. See
 * `listsOf`.
 */
function optionsOf(widget, openBefore = null) {
  // What its press drew, since nothing names it. See `plainOptions`.
  if (PLAIN.has(widget)) return plainOptions(widget);
  return listsOf(widget, openBefore)
    .flatMap((l) => [...l.querySelectorAll('[role="option"], [role="menuitem"]')])
    .filter((o) => !isDisabled(o) && o.getAttribute('aria-disabled') !== 'true');
}

/**
 * The lists a widget names as its own: through `aria-controls` or
 * `aria-owns`, the one holding the option its `aria-activedescendant` points
 * at, or the menu a Fabric select names its own way (see `isFabricSelect`).
 */
function namedListsOf(widget) {
  const box = typingBoxOf(widget);
  const byId = (id) => widget.getRootNode().getElementById?.(id) ?? document.getElementById(id);
  const ids = [widget, box]
    .filter(Boolean)
    .flatMap((el) => `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/))
    .filter(Boolean);
  if (isFabricSelect(widget)) ids.push(widget.getAttribute('data-menu-id'));
  const lists = ids.map(byId);
  for (const el of [widget, box].filter(Boolean)) {
    const active = el.getAttribute('aria-activedescendant');
    const option = active ? byId(active) : null;
    if (option) lists.push(option.closest('[role="listbox"], [role="menu"], [role="tree"], [role="grid"]') ?? option.parentElement);
  }
  /*
   * Each list once. A react-select's typing box is the widget itself, so the
   * one `aria-controls` was read twice and every option listed twice — which
   * "the first that matches" never noticed, and "the only one that matches"
   * did: Boston, Massachusetts was two Bostons and neither was chosen.
   */
  return [...new Set(lists.filter((l) => l && l !== widget))];
}

/**
 * The lists this widget opened — and only this widget's: the ones it names
 * (`namedListsOf`), or failing that the one listbox its own press opened, or
 * failing that the one showing inside it.
 */
function listsOf(widget, openBefore = null) {
  const box = typingBoxOf(widget);
  const named = namedListsOf(widget);
  if (named.length) return named;
  /*
   * Never a list another control says is its own.
   *
   * Workday's questionnaire is a column of "Select One" buttons, each naming
   * its list in `aria-controls` once the list is drawn, a moment after the
   * press; and a list shut, by a choice or by Escape, takes about 300ms to
   * go. Measured live with a fake profile on Intel's Application Questions:
   * "8) Are you a current Federal, State or Local Government employee…?" was
   * opened (read as a state), had no "MA", and was shut; "10) Are you
   * currently authorized to work in the U.S.?" was pressed 12ms later, before
   * its own list was drawn — so the one list showing was question 8's, "Yes"
   * was pressed in it, and the applicant was declared a government employee
   * while the report said the right to work had been answered. NVIDIA's pair
   * did the same after a choice: "No" meant for "Will you now or in the future
   * require sponsorship…?" was given to "Are you legally authorized to work in
   * the United States?", and both were reported filled.
   */
  const theirs = (list) =>
    (Boolean(list.id) &&
      deepQueryAll(`[aria-controls~="${CSS.escape(list.id)}"], [aria-owns~="${CSS.escape(list.id)}"]`).some(
        (el) => el !== widget && el !== box && !widget.contains(el),
      )) ||
    drawnByAnother(list, widget);
  const showing = visibleListboxes().filter((l) => l !== widget && !theirs(l));
  /*
   * And, where the widget names none, the one its own press opened.
   *
   * "Exactly one listbox showing" was the whole test, and a listbox can be
   * showing without being a menu. Workday draws what a multiselect already
   * holds as one — the country phone code's "United States of America (+1)"
   * is a `role="listbox"` that never closes — so on its My Information page
   * there were always two, and every dropdown on it was refused: the State
   * and the Phone Device Type left on "Select One". What was open before the
   * press is not what the press opened.
   */
  const fresh = openBefore ? showing.filter((l) => !openBefore.has(l)) : [];
  /*
   * And never merely the one listbox on screen. That was the last resort
   * here, and a listbox can be on screen because it is another question's.
   * Measured: a Country listbox the fill had answered, and after it a
   * "Country of residence" listbox that ignores clicks and opens nothing.
   * Pressed, the second drew no list, the Country one was the only listbox
   * showing, and United States was clicked in it for "Country of
   * residence", which was reported filled with nothing chosen in it. A
   * list showing before the press is the widget's only when it is inside
   * the widget.
   */
  /*
   * Nor one whose every option is marked chosen: that is what the widget
   * holds, drawn as chips, not a list to choose from. Measured, a Country
   * multi-select saying "Select countries" over a `role="listbox"` of its
   * chosen chips, holding "United States" and opening nothing on a press:
   * the chip was the option pressed, and pressing a chip takes it out, so
   * the country it held was lost and it was reported as one to pick by hand.
   */
  const inside = showing.filter((l) => widget.contains(l) && !holdsOnlyChosen(l));
  const lists = fresh.length ? fresh : inside;
  return lists.length === 1 ? lists : [];
}

/**
 * Whether a list is drawn beside another question's widget rather than this
 * one's: the nearest thing around it holding a widget holds another and not
 * this one.
 *
 * A list that names no widget is taken as this one's when it is the one
 * that opened as this one was pressed. But a page can open another
 * question's then too. Measured, a sponsorship question drawn as
 * react-select draws one — its menu in its own container, named nowhere —
 * on a page that opens that menu whenever the focus moves: it was answered
 * No, then the authorization question after it was focused and pressed,
 * the sponsorship menu was the one list that opened, and "Yes" was chosen
 * in it. Sponsorship was reported filled with No and showed Yes. A menu
 * drawn at the foot of the body, or in the container round this widget, is
 * still this one's.
 */
const A_WIDGET = `[role="combobox"], [aria-haspopup="listbox"], [role="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [data-uxi-widget-type="selectinput"], ${FABRIC_SELECT}, select`;

function drawnByAnother(list, widget) {
  for (let at = parentAround(list); at; at = parentAround(at)) {
    if (drawnInside(at, widget)) return false;
    const others = [...(at.querySelectorAll?.(A_WIDGET) ?? [])].filter(
      (el) => !list.contains(el) && !el.contains(list) && !isWidgetPartner(el) && isShowing(el),
    );
    if (others.length) return true;
  }
  return false;
}

/** Whether a list has options and every one of them is marked chosen. */
function holdsOnlyChosen(list) {
  const options = [...list.querySelectorAll('[role="option"], [role="menuitem"]')];
  return options.length > 0 && options.every(isMarkedChosen);
}

/** The option that is plainly this answer, or nothing. Never the nearest. */
function exactOption(options, key, value, fields = {}, asked = '') {
  return (
    options.find((o) => sameOption(o.textContent, value)) ??
    (key === 'gpa' ? gpaOption(options, value) : null) ??
    (PLACE_KEYS.has(key) ? placeOption(options, fields) : null) ??
    (key === 'work_authorization' ? authorizationStatement(options, fields) : null) ??
    /*
     * A yes/no pair against the profile's phrase, on the terms a `<select>`
     * and a radio group already had — see `yesNoOption`. Without it the widget
     * path had nothing for these two keys but an option spelled exactly like
     * the profile, and no list says "Authorized to work in the US": Stripe's
     * eligibility and sponsorship questions, both react-select lists of a Yes
     * and a No, were reported as ones to pick by hand. Any prompt drawn as an
     * option comes off first, or the pair reads as three answers.
     */
    (YES_NO_KEYS.has(key)
      ? yesNoOption(
          key,
          value,
          options.filter((o) => !PLACEHOLDER.test(clean(o.textContent))).map((o) => ({ label: o.textContent, el: o })),
          asked,
        )?.el
      : null) ??
    options.find((o) => sameAnswerSpelledOtherwise(key, o.textContent, value)) ??
    null
  );
}

/**
 * A click as a person makes one — some widgets choose on mousedown, some on
 * click. Counted as one click, as a mouse's is: a click with a `detail` of 0
 * is what Enter on a focused button sends, and BambooHR's Fabric select opens
 * on the keys instead and ignores that click. Its lists never opened.
 */
function press(el) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(ours(new Ctor(type, { bubbles: true, cancelable: true, view: window, detail: 1 })));
  }
}

/**
 * Whether the widget really took the answer, read back the way a person would.
 *
 * A widget can render options and then ignore the click — a newer release
 * that chooses on a keypress, a listener the synthetic event did not reach —
 * and a form that looks answered and submits nothing is the failure this
 * whole file is written against. So it has to be seen: the option marked
 * chosen, or the control now showing it with the typing gone, or the value it
 * submits carrying something where it carried nothing.
 */
function tookIt(widget, box, option, value, hiddenBefore, chosen = option.textContent, shownBefore = '') {
  if (PLAIN.has(widget)) return plainTookIt(widget, chosen);
  const hidden = hiddenPartner(widget);
  if (hidden && hidden.value && hidden.value !== hiddenBefore) return true;
  /*
   * A widget that draws what it holds as a value of its own — react-select's
   * `select__single-value` in place of its "Select..." placeholder, a chip
   * for each in a multi-select — has taken a choice when that value is drawn
   * and says it, and not otherwise.
   *
   * Everything below reads the box and the words around it, and in one of
   * these the box holds whatever was typed into it, so every one of those
   * readings can pass on a choice that never happened. Worst is the closed
   * menu: typed "Northeastern University", an option pressed that the widget
   * did not act on, and a menu shut by the same press, and "the menu is
   * closed with exactly that text left in the box" read as an autocomplete
   * that had written its choice in. It was counted as filled; react-select
   * empties its box on blur, so the School went back to "Select..." the moment
   * the fill moved on, with the card saying it was done. So here nothing
   * short of the drawn value counts, and the box has to be empty, as a real
   * choice leaves it.
   */
  const drawn = drawnValue(controlOf(widget));
  if (drawn !== undefined) {
    if (!drawn || (box && box.value)) return false;
    const said = drawn.toLowerCase();
    return (
      [value, chosen].some((it) => clean(it) && said.includes(clean(it).toLowerCase())) ||
      // Greenhouse's country beside the phone draws "+1" for "United States +1".
      (said.length >= 2 && clean(chosen).toLowerCase().includes(said))
    );
  }
  /*
   * The option marked chosen — once its list has shut. In a combobox's popup
   * `aria-selected` is where the highlight is, and it moves with the pointer
   * and the arrow keys: ARIA 1.2's pattern, Downshift and MUI's Autocomplete
   * all mark the option under the pointer that way. Measured, a School and a
   * Country whose options are highlighted as the pointer goes down on them
   * and chosen only on Enter were reported filled on "Select One" and an
   * empty box, both lists left open. A list still showing after the press is
   * one the press did not close, and its mark is the highlight; a choice
   * shows in the control, which is read below.
   */
  if (option.isConnected && option.getAttribute('aria-selected') === 'true' && !isShowing(option)) return true;
  /*
   * An autocomplete that writes the choice into its own box — MUI, Downshift,
   * Ant Design — with no hidden input and the option gone once the menu
   * closes. The box holding the option's text is not evidence on its own,
   * because it was typed there; the widget saying its menu is now closed, with
   * exactly that text left in the box, is. An ignored click leaves the menu
   * open, and a widget that drops the choice clears the box as it closes.
   */
  const expanded = box?.getAttribute('aria-expanded') ?? widget.getAttribute('aria-expanded');
  if (box && expanded === 'false' && sameOption(box.value, option.textContent)) return true;
  /*
   * Not "the box holds the option's text": the box holds it because it was
   * typed there, whether or not the click did anything. And the control's text
   * is read with any open listbox cut out of it, or an ignored click would
   * pass because the option is still showing in the menu underneath — which
   * is what a React widget that re-renders its options on click, choosing
   * nothing, looks like: the clicked node is gone and the menu is still open.
   */
  const text = shownBy(widget);
  /*
   * The value, or the option it was matched to. "VA" chooses "Virginia", and
   * a dropdown showing "Virginia" does not contain the letters "VA" — so a
   * state chosen correctly was read as ignored and reported as still to pick.
   *
   * And only once the control shows something it did not before the press:
   * words that were in it already are not the choice arriving.
   */
  const changed = text !== shownBefore;
  const shows = changed && [value, chosen].some((said) => clean(said) && text.includes(clean(said).toLowerCase()));
  /*
   * Or a part of the option it did not show before. Greenhouse's country
   * beside the phone, chosen as "United States +1", draws "+1" and nothing
   * else, so a choice that had plainly taken was reported as still to pick.
   */
  const part = text.length >= 2 && changed && clean(chosen).toLowerCase().includes(text);
  return (shows || part) && (!box || !box.value);
}

/**
 * What a widget's control shows as its answer, lowercased: its text with its
 * lists and their options cut out of it.
 *
 * Only a listbox was cut out, so a list the widget names that is drawn inside
 * its control without that role — a plain `<ul>` of options, a `role="menu"`
 * — lent its words to a click it ignored: a School combobox whose list sat
 * in its control read "Northeastern University" whether or not anything was
 * chosen, and was reported filled with "Select One" on it. The same for a
 * listbox that is itself the question, whose options all say what could be
 * chosen and none of them what was. An option marked chosen stays, since
 * that is the control holding its answer.
 */
function shownBy(widget) {
  const control = controlOf(widget).cloneNode(true);
  const cut = '[role="listbox"], [role="menu"], [role="option"]:not([aria-selected="true"]), [role="menuitem"]';
  for (const el of control.querySelectorAll(cut)) el.remove();
  for (const list of namedListsOf(widget)) if (list.id) control.querySelector(`#${CSS.escape(list.id)}`)?.remove();
  return clean(control.textContent).toLowerCase();
}

/**
 * What a widget that draws its own value is showing as chosen: the text of
 * its single value or its chips, `''` where it draws none yet — only its
 * placeholder, or nothing — and `undefined` for a widget that is not drawn
 * this way at all, which `tookIt` then reads as it always has.
 */
const DRAWN_VALUE = '[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValueLabel"], [data-automation-id="selectedItem"]';
const DRAWS_ITS_VALUE = `${DRAWN_VALUE}, [class*="value-container"], [class*="ValueContainer"], [class*="__placeholder"], [data-automation-id="multiselectInputContainer"]`;

function drawnValue(control) {
  if (!control?.querySelector?.(DRAWS_ITS_VALUE)) return undefined;
  return clean([...control.querySelectorAll(DRAWN_VALUE)].map((el) => el.textContent).join(' '));
}

/*
 * What a dropdown says while nothing is chosen.
 */
// Any kind of dash: BambooHR's says "–Select–", and iCIMS's "— Make a Selection —".
const NOTHING_CHOSEN = /^(?:select|choose|pick|search)\b|^please\s+(?:select|choose)\b|^[-–—]+|^none\s+selected$|^…$/i;

/**
 * Whether a widget already shows a choice: a pill or a single value drawn
 * inside it — Workday's multiselect, react-select — or a dropdown button
 * whose own text is an answer rather than "Select One".
 */
function widgetShowsAnAnswer(widget) {
  const control = controlOf(widget);
  if (control.querySelector?.('[data-automation-id="selectedItem"], [class*="single-value"], [class*="singleValue"]')) {
    return true;
  }
  if (widget instanceof HTMLInputElement || widget.getAttribute('role') === 'listbox') return false;
  const shown = clean(widget.textContent);
  return Boolean(shown) && !NOTHING_CHOSEN.test(shown) && shown !== clean(labelFor(widget));
}

/**
 * The element a widget draws its current answer in.
 *
 * The widget itself where no wrapper says it is the control — not its parent.
 * A button sitting straight in a form has the form as its parent, and the
 * answer "shown" anywhere in the form's text passed for a choice that took:
 * an ignored click beside a paragraph naming the city was reported as filled.
 */
function controlOf(widget) {
  // A Workday prompt draws its choices as pills beside the search box, in the
  // container around both. See `isWorkdayPrompt`.
  const prompt = widget.closest?.('[data-automation-id="multiSelectContainer"]');
  if (prompt) return prompt;
  /*
   * Its wrapper, not itself, and a near one. `closest` starts at the element
   * it is called on, and react-select's box is `class="select__input"` — so on
   * Greenhouse the "control" was the empty text box, a choice that had plainly
   * taken read as ignored, and each one was taken back out and reported as
   * still to pick. A few levels only, so that a page-wide wrapper whose class
   * happens to say "select" cannot lend its text to a click that did nothing.
   *
   * The one that says it is the control, before the nearest that says
   * "select": on the live board the box sits in a `select__input-container`,
   * which says "select" and holds nothing but the box. That empty wrapper was
   * the control, so every choice made in Greenhouse's react-select — the
   * country, the school, the degree, the location — was read as ignored and
   * reported as still to pick, and an answer already chosen was never seen,
   * so a second fill could choose over it. A wrapper with no text holding
   * only the box is passed over for the same reason where nothing says
   * "control".
   */
  const around = [];
  for (let at = widget.parentElement, up = 0; at && up < 4; up++, at = at.parentElement) around.push(at);
  const selectish = around.filter((at) => at.matches?.('[class*="select"], [class*="combobox"]'));
  const onlyTheBox = (at) => at.children.length <= 1 && !clean(at.textContent);
  return (
    around.find((at) => at.matches?.('[class*="control"]')) ??
    selectish.find((at) => !onlyTheBox(at)) ??
    selectish[0] ??
    widget
  );
}

/**
 * The hidden input carrying what the widget submits, where it sits beside it
 * — beside it, not anywhere below the parent, which for a widget straight in a
 * form was the first hidden input of some other field.
 */
function hiddenPartner(widget) {
  const around = controlOf(widget).parentElement ?? controlOf(widget);
  return (
    around.querySelector?.(':scope > input[type="hidden"]') ??
    // Or the box or select a dropdown keeps out of sight. See `isWidgetPartner`.
    [...(around.querySelectorAll?.(':scope > input, :scope > select') ?? [])].find(isWidgetPartner) ??
    null
  );
}

/** Whether pressing this would send its form. */
function wouldSubmit(el) {
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && Boolean(el.form);
  if (el instanceof HTMLInputElement) return ['submit', 'image'].includes(el.type) && Boolean(el.form);
  return false;
}

/**
 * Put the widget back as it was: nothing typed, nothing open.
 *
 * Escape is pressed where a person's Escape goes, which is wherever the focus
 * is — and a menu that takes the focus as it opens hears it there and not on
 * its button. Headless UI's Listbox focuses its list, MUI's Select an option
 * inside its Modal, and neither button answers Escape. Sent to the button
 * only, a list with no option for the answer stayed open over the form —
 * MUI's with an invisible backdrop over the whole page and the app hidden
 * from screen readers. Where it is still open after that, a button that
 * opened it with a press is pressed once more, which is how a person shuts a
 * dropdown that answers no key at all.
 */
function undoWidget(widget, box, openBefore = null) {
  if (box) setValue(box, '');
  const escape = (el) =>
    el.dispatchEvent(ours(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
  escape(box ?? widget);
  // Believed about itself where it says: a list closing behind a transition
  // is still on the page for a moment, and pressing again would reopen it.
  const open = () => {
    // Anything a plain dropdown's press drew, list-shaped or not, is shut again.
    if (PLAIN.has(widget)) return plainAppeared(widget).length > 0;
    const said = (box ?? widget).getAttribute('aria-expanded');
    return said === null ? optionsOf(widget, openBefore).length > 0 : said === 'true';
  };
  const focused = deepActiveElement();
  if (focused && focused !== (box ?? widget) && focused !== document.body && open()) escape(focused);
  if (!box && open()) press(pressPoint(widget));
  (box ?? widget).blur?.();
}

/** The element that has the focus, inside any shadow root that holds it. */
function deepActiveElement() {
  let at = document.activeElement;
  while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
  return at;
}

/**
 * Choose in the widgets `fillForm` could only report.
 *
 * Workday's dropdowns and the react-select boxes half the other systems use
 * are a control that opens a listbox, with nothing to assign a value to — so
 * the country, the state and the school on those forms were all left for the
 * person to pick, every time. They can be driven, the way a person drives
 * them: type or click to open, choose the option, see that it took.
 *
 * Only on these terms, because a form that looks answered and is not is worse
 * than one that says it is not:
 *
 *   - Exactly the answer, never the nearest. "United States" does not choose
 *     "United States Minor Outlying Islands", and no option means no choice.
 *   - Only this widget's own options. See `optionsOf`.
 *   - Seen to have taken. See `tookIt`. Otherwise everything typed is taken
 *     back out and the widget is reported exactly as it was before.
 *
 * Async, and after `fillForm`, because a widget opens and fills in on its own
 * time — a school list fetched as you type can take a second to arrive.
 */
/*
 * Long enough for a school list that is a search against the board's API to
 * answer; a list that is already there and does not hold the answer is given
 * up on as soon as it settles (see `waitForOption`), so this is not paid by
 * every widget that has no option for its answer.
 */
/*
 * A place typed into a box whose keystrokes search places and draw them
 * beneath it, with a hidden field that only a pick fills.
 *
 * Lever's "Current location" is one: typing "Boston" asks its own search and
 * draws "Boston, MA, USA", "Boston, NY, USA" and more, and choosing one writes
 * `selectedLocation`. Filled as text, the box read "Boston, MA" and the hidden
 * half stayed empty — a location Lever was never told was chosen. So the
 * text is announced as a keystroke would announce it, and the one suggestion
 * whose city, state and country are the profile's is chosen — only that, and
 * only when exactly one is. Otherwise the typed text stays as it was.
 */
const LISTED_PLACE = /selected[\s_-]*location|location[\s_-]*(?:id|selected)/i;

async function pickListedPlaces(fields) {
  for (const hidden of deepQueryAll('input[type="hidden"]')) {
    if (hidden.value || !LISTED_PLACE.test(`${hidden.name} ${hidden.id}`)) continue;
    const box = hidden.parentElement?.querySelector('input[type="text"], input:not([type])');
    const typed = box?.value.trim();
    if (!typed) continue;
    box.focus?.();
    box.dispatchEvent(ours(new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true })));
    setValue(box, typed);
    box.dispatchEvent(ours(new KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true })));
    const drawn = () =>
      [...hidden.parentElement.querySelectorAll('[role="option"], [class*="location"]:not(input), [class*="suggestion"]')].filter(
        (el) => el.childElementCount === 0 && el.getClientRects().length > 0,
      );
    const option = await waitFor(() => placeOption(drawn(), fields), 3000);
    if (option) press(option);
    await pause(60);
  }
}

export async function fillComboboxes(fields, report, { patience = 4000, history = [] } = {}) {
  // What `fillForm` pressed, now that the page has had its turn to draw it.
  report = await seePresses(report);
  // The months of the jobs `fillForm` put in, where the form asks them as lists.
  const months = await fillJobMonths(history, patience);
  if (months.length) report = { ...report, filled: [...report.filled, ...months] };
  // The same fields `fillForm` read, or a widget it named `city_state` has
  // no value here.
  fields = withResidence(withCityAndState(fields));
  await pickListedPlaces(fields);
  const pending = new Set(report.skipped.filter((s) => s.reason === PICK_BY_HAND).map((s) => s.key));
  // The lists that were looked in and did not have the answer. See `NOT_LISTED`.
  const unlisted = new Set(report.skipped.filter((s) => s.reason === 'no matching option').map((s) => s.key));
  if (pending.size === 0) {
    const also = fillNotListed(fields, unlisted);
    return also.length ? { ...report, filled: [...report.filled, ...also] } : report;
  }

  const done = [];
  // Which question each choice answered: a key can now be asked twice.
  const chose = new Set();
  for (const { key, el: widget, both, elsewhere, asked, description } of widgetChoices(fields, report.filled)) {
    if (both || elsewhere || !pending.has(key)) continue;
    const value = String(fields[key]);
    const how = await chooseInWidget(widget, key, value, { patience, fields, asked });
    // Looked for in a list that opened, and not in it. See `NOT_LISTED`.
    if (how === 'unlisted') unlisted.add(key);
    if (how === 'chose') {
      done.push({ key, value, widget: true });
      chose.add(`${key}\u0000${description}`);
    }
  }

  return {
    ...report,
    filled: [...report.filled, ...done, ...fillNotListed(fields, unlisted)],
    skipped: report.skipped.filter((s) => !(s.reason === PICK_BY_HAND && chose.has(`${s.key}\u0000${s.description}`))),
  };
}

/**
 * Choose one answer in one widget, the way `fillComboboxes` always has — on
 * its own so that an Education block added after the fill (see
 * `fillEducation`) is driven by exactly the same rules as the first one, and
 * the two cannot drift.
 *
 * Says what happened: `chose` when the widget is seen to hold the answer,
 * `unlisted` when its list opened and the answer was not in it, and anything
 * else when nothing was chosen. Whatever did not take is put back as it was.
 */
async function chooseInWidget(widget, key, value, options) {
  // A plain dropdown's list is what its press draws, so that is watched for
  // from before the press. See `plainOptions`.
  const stop = PLAIN.has(widget) ? watchAppearing(widget) : null;
  try {
    return await chooseInThisWidget(widget, key, value, options);
  } finally {
    stop?.();
  }
}

async function chooseInThisWidget(widget, key, value, { patience, fields, asked }) {
  const box = typingBoxOf(widget);
  const hiddenBefore = hiddenPartner(widget)?.value ?? '';
  const shownBefore = shownBy(widget);

  /*
   * Never a control that would send the form.
   *
   * A `<button>` with no `type` inside a form *is* a submit button — that is
   * the default, and a Workday-style dropdown written without `type="button"`
   * is one. Pressing it to open its list submitted the application instead:
   * the page navigated away mid-fill, half the form empty, and nothing came
   * back to say so. A widget that has to be pressed to open, and would send
   * the form if pressed, is left for the person, exactly as before.
   */
  if (!box && wouldSubmit(widget)) return 'left';

  /*
   * What was open before the widget is touched at all, focus included: a
   * menu that opens as it takes the focus is one it opened, and is only
   * found as that (see `listsOf`) now that the one listbox on screen is not
   * taken for its own.
   */
  const openBefore = new Set(visibleListboxes());
  widget.focus?.();
  let option = null;
  if (box) {
    /*
     * Opened first, the way a person opens it, and looked at before
     * anything is typed.
     *
     * Greenhouse's react-select offers nothing until its menu is open, and
     * typing into a closed one changes nothing: the school, the degree and
     * the discipline were typed into and left on "Select...". And a fixed
     * list filters by what is typed, so typing the store's wording —
     * "Bachelor of Science" — filters out the answer spelled the form's
     * way, "Bachelor's Degree". So the list is read as it opens, and only
     * where the answer is not in it is it typed, which is how a list that
     * is a search — every school there is — gets asked.
     *
     * The whole patience for that first look, not two seconds of it, for a
     * list that says it is still loading: `quiet` only counts once it has
     * stopped saying so (see `waitForOption`), so a list that is there and
     * lacks the answer costs what it did, and one still on its way is
     * waited for rather than typed over.
     */
    press(box);
    option = await waitForOption(widget, key, value, openBefore, { patience, quiet: 400, fields, asked });
    if (!option) {
      setValue(box, value);
      /*
       * A Workday prompt searches when Enter is let go: its keydown notes the
       * key held and its keyup runs the search. Typed into and left, its list
       * said "No Items." for as long as it was watched.
       */
      if (isWorkdayPrompt(box)) {
        for (const type of ['keydown', 'keyup']) box.dispatchEvent(ours(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })));
      }
      option = await waitForOption(widget, key, value, openBefore, { patience, fields, asked });
    }
  } else {
    press(pressPoint(widget));
    option = await waitForOption(widget, key, value, openBefore, { patience, fields, asked });
  }
  if (!option) {
    const opened = menuIsOpen(widget, box, openBefore);
    undoWidget(widget, box, openBefore);
    return opened ? 'unlisted' : 'missed';
  }
  // Read before the press: a menu that closes takes its options with it.
  const chosen = option.textContent;
  press(wordsOf(option));
  await pause(60);
  if (!tookIt(widget, box, option, value, hiddenBefore, chosen, shownBefore)) {
    undoWidget(widget, box, openBefore);
    return 'ignored';
  }
  return 'chose';
}

/*
 * Where a person's click on an option lands: on its words, the innermost
 * element saying all of them — from which the click rises through the option
 * to every listener above it.
 *
 * Pressed on the option itself, a click never reaches a listener inside it,
 * and Workday's is inside: its `role="option"` row wraps a `promptLeafNode`
 * holding the only click handler, around a radio and the words. Measured live
 * on Intel's School or University: "Northeastern University" found in the
 * list and pressed was not chosen — no pill, the list still open — and the
 * same press on its words chose it. An option that is nothing but its words
 * is pressed as before.
 */
function wordsOf(option) {
  const said = clean(option.textContent);
  let at = option;
  for (;;) {
    const inner = [...at.children].find((child) => clean(child.textContent) === said);
    if (!inner) return at;
    at = inner;
  }
}

/** Whether a widget's own menu is showing. */
function menuIsOpen(widget, box, openBefore) {
  if ((box ?? widget).getAttribute('aria-expanded') === 'true') return true;
  return optionsOf(widget, openBefore).length > 0;
}

/**
 * The boxes that ask for what their list did not have, filled for the lists
 * that did not have it — the list looked in and the answer not there, or a
 * `<select>` with no option for it. Only empty ones, and each only once it is
 * seen to hold the answer. The list itself is left reported as it was: it is
 * still unanswered, and the box beside it is not the list.
 */
function fillNotListed(fields, unlisted) {
  if (unlisted.size === 0) return [];
  const filled = [];
  for (const input of deepQueryAll('input, textarea')) {
    if (!isFillable(input) || input.value) continue;
    const description = describeField(input);
    if (!description || !NOT_LISTED.test(description)) continue;
    const key = FIELD_PATTERNS.find(([, re]) => re.test(description))?.[0];
    if (!key || !unlisted.has(key) || !fields[key]) continue;
    const value = String(fields[key]);
    setValue(input, value);
    if (input.value === value) filled.push({ key, value, notListed: true, description: description.slice(0, 60) });
  }
  return filled;
}

/* ------------------- More than one education, from the resume ------------------- */

/*
 * An Education section that asks one school at a time, with "Add another" for
 * the next.
 *
 * Measured on Greenhouse's new boards — SpaceX (job-boards.greenhouse.io/spacex)
 * and Stripe's embed (job-boards.greenhouse.io/embed/job_app?for=stripe) — the
 * section is one `education--container` holding an `education--form` per
 * school and, after the last, `<button type="button" class="add-another-button">
 * Add another</button>`. A block is School, Degree and Discipline as
 * react-select widgets with ids `school--0`, `degree--0`, `discipline--0`, and
 * on Stripe a "Start date year" box, `start-year--0`, `type=number`; other
 * boards add the start and end month and the end year. Pressing the button
 * appends a second block whose ids end `--1`, and puts the caret in its School.
 * Its heading, "Education", is a `<p>`, which is why nothing that reads
 * headings (`sectionOf`) knows these fields are a degree's.
 *
 * The profile's fields describe one education — the newest, see
 * `newestEducation` in the store — so a bachelor's and a master's had the
 * master's put in the first block and the bachelor's left for the person to
 * add, and to pick out of three searched lists again, from the resume they
 * were attaching.
 *
 * So the resume's own list, `education`, in its order, one per block:
 *
 *   - The first block is left to the fill that has already been through it.
 *     It is the one the profile's fields went into, so it belongs to the
 *     education they describe; only what that fill never tried is added — the
 *     dates of a section whose heading it could not read — and only where it
 *     is empty. Which education that is has to be plain: a profile school the
 *     resume does not list is a first block this cannot account for, and then
 *     nothing is added at all, rather than risk the same school twice.
 *   - A block somebody has already chosen a school in keeps it, and is
 *     finished from that school's education where empty. A school the resume
 *     does not list is left exactly as it was, and said so.
 *   - An empty block takes the next education not yet placed, of a level the
 *     block does not rule out — see `anotherLevelOfStudy`, which is asked of
 *     every part as it is for the first block, with this education's degree.
 *     A block no remaining school fits — "Graduate School" when only a high
 *     school is left — is left empty and said so, and none more is added.
 *   - Only then is "Add another" pressed, once per education still to place,
 *     and never to make more blocks than the resume has educations. The
 *     block it adds is waited for, and filled like the rest; one that does
 *     not appear ends it, and is said so.
 *
 * The button has to be the Education section's own: the nearest thing above
 * it that holds a field holds a School, and nothing that is somebody's name,
 * contact details, right to work or job. An "Add another" under a work
 * history, or one whose nearest fields are the whole form, is not pressed.
 * Nor is one that would send the form, or a link. Every widget is driven by
 * `chooseInWidget`, on exactly the terms of the first block: the exact
 * answer, seen to have taken, or put back.
 */
const ADD_ANOTHER = /^\+?\s*add\s+(?:another|more|new|an?\s+other|education|school|degree)\b[\w\s]*\+?$/i;
const EDUCATION_PART = /^(school|degree|major|gpa|graduation_(month|year|date)|education_start_(month|year|date))$/;
// A school's own place, which an education block may ask and nothing here answers.
const A_SCHOOLS_PLACE = new Set(['address_city', 'address_state', 'address_country', 'city_state', 'location']);
const SECTION_CONTROLS = `${A_CONTROL}, [role="combobox"]:not(input), [aria-haspopup="listbox"]:not(input)`;

/**
 * What one control in an Education section is: a part of an education, a
 * school's place (null, like a box that says nothing), or `foreign` — a field
 * that is not about a school at all, which means this is not the section.
 */
function educationPartOf(control) {
  const description = describeField(control);
  if (!description || NOT_LISTED.test(description)) return null;
  const key = educationDatePart(description) ?? FIELD_PATTERNS.find(([, re]) => re.test(description))?.[0];
  if (key && EDUCATION_PART.test(key)) return wholeDateKey(control, key, description);
  if (key) return A_SCHOOLS_PLACE.has(key) ? null : 'foreign';
  const job = control.localName === 'input' || control.localName === 'textarea' ? jobPartOf(control)?.part : null;
  return ['company', 'title', 'description'].includes(job) ? 'foreign' : null;
}

/**
 * The blocks of an Education section, in the order the page asks them — a
 * part seen a second time starting the next, as `fillWorkHistory` reads a
 * work history. Null when the section holds something that is not education.
 */
function educationBlocks(box) {
  const blocks = [];
  let block = null;
  for (const control of withPlainDropdowns([...box.querySelectorAll(SECTION_CONTROLS)], box)) {
    if (isDisabled(control) || control.getClientRects().length === 0) continue;
    // The dropdown beside it is the part. See `isWidgetPartner`.
    if (isWidgetPartner(control)) continue;
    if (control.type === 'checkbox' || control.type === 'radio') continue;
    const part = educationPartOf(control);
    if (part === 'foreign') return null;
    if (!part) continue;
    if (!block || block.has(part)) blocks.push((block = new Map()));
    block.set(part, control);
  }
  return blocks;
}

/** The page's one Education section with an "Add another", and that button. */
function educationSection() {
  const found = [];
  for (const button of deepQueryAll('button, [role="button"], input[type="button"]')) {
    const said = clean(button.textContent || button.value || button.getAttribute('aria-label'));
    if (said.length > 40 || !ADD_ANOTHER.test(said)) continue;
    if (isDisabled(button) || wouldSubmit(button) || button.closest('a[href]') || button.getClientRects().length === 0) continue;
    let box = button.parentElement;
    while (box && !box.querySelector(SECTION_CONTROLS)) box = box.parentElement;
    if (!box || ['form', 'body', 'html'].includes(box.localName)) continue;
    const blocks = educationBlocks(box);
    if (!blocks?.some((b) => b.has('school'))) continue;
    found.push({ box, button });
  }
  // Two of them is a page where pressing either is a guess.
  return found.length === 1 ? found[0] : null;
}

/** The same school, however much of its name each side writes. */
function sameSchool(a, b) {
  const flat = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const x = flat(a);
  const y = flat(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
}

/** Whether a control already holds an answer, by what it shows. */
function partAnswered(control) {
  if (control instanceof HTMLSelectElement) return selectIsAnswered(control);
  if (isWidgetChoice(control)) return widgetShowsAnAnswer(control);
  return Boolean(control.value);
}

/** The school a block shows as chosen, or nothing. */
function schoolShown(control) {
  if (!control || !partAnswered(control)) return '';
  if (control instanceof HTMLSelectElement) return clean(control.selectedOptions[0]?.textContent);
  if (isWidgetChoice(control)) return drawnValue(controlOf(control)) || clean(control.textContent) || clean(control.value);
  return clean(control.value);
}

/** One education as the fields for its block, keyed as the profile's are. */
function educationFields(school) {
  const f = {};
  for (const key of ['school', 'degree', 'major', 'gpa']) if (clean(school?.[key])) f[key] = clean(school[key]);
  const at = (when, prefix) => {
    const year = Number(when?.year);
    if (!year) return;
    f[`${prefix}_year`] = String(year);
    const month = Number(when.month);
    if (month >= 1 && month <= 12) {
      f[`${prefix}_month`] = monthWord(month);
      f[`${prefix}_date`] = `${monthWord(month)} ${year}`;
    } else {
      f[`${prefix}_date`] = String(year);
    }
  };
  at(school?.start, 'education_start');
  at(school?.end, 'graduation');
  return f;
}

/** Put one part of an education into its control, as the first block's are put. */
async function fillEducationPart(control, key, value, f, patience) {
  const description = describeField(control);
  if (isWidgetChoice(control)) {
    const how = await chooseInWidget(control, key, value, { patience, fields: f, asked: description });
    if (how === 'chose') return { key, value, widget: true };
    return { key, reason: how === 'unlisted' ? 'no matching option' : PICK_BY_HAND, description: description.slice(0, 60) };
  }
  if (control instanceof HTMLSelectElement) {
    const choosable = [...control.options].filter((o) => !isDisabled(o));
    const option =
      choosable.find((o) => sameOption(o.textContent, value) || sameOption(o.value, value)) ??
      (key === 'gpa' ? gpaOption(choosable, value) : null) ??
      choosable.find((o) => sameAnswerSpelledOtherwise(key, o.textContent, value) || sameAnswerSpelledOtherwise(key, o.value, value));
    if (!option) return { key, reason: 'no matching option', description: description.slice(0, 60) };
    const was = control.value;
    nativeSet(control, 'value', option.value);
    if (control.selectedOptions[0] !== option) return { key, reason: 'the field would not take it', description: description.slice(0, 60) };
    control.dispatchEvent(ours(new Event('input', { bubbles: true })));
    control.dispatchEvent(ours(new Event('change', { bubbles: true })));
    if (!standInTookIt(control, was)) return { key, reason: PICK_BY_HAND, description: description.slice(0, 60) };
    return { key, value };
  }
  // A box: the date written the way it wants it, as `fillForm` writes one.
  let written = String(value);
  if (key.startsWith('graduation_') && control.type === 'month' && f.graduation_date) written = graduationFor(control, f.graduation_date);
  else if (key.startsWith('education_start_') && control.type === 'month' && f.education_start_date) written = graduationFor(control, f.education_start_date);
  else if (key === 'graduation_date' || key === 'education_start_date') written = graduationFor(control, written);
  else if ((key === 'graduation_month' || key === 'education_start_month') && asksMonthAsNumber(control)) written = monthAsNumber(written);
  const before = control.value;
  setValue(control, written);
  if (control.value !== written || browserWouldRefuse(control)) {
    setValue(control, before);
    return { key, reason: 'the field would not take it', description: description.slice(0, 60) };
  }
  return { key, value: written };
}

/** Press the section's "Add another" and wait for the block it adds. */
async function addAnother(section, had) {
  press(section.button);
  return waitFor(() => {
    const now = educationSection();
    const blocks = now && educationBlocks(now.box);
    return blocks && blocks.length > had ? { section: now, blocks } : null;
  }, 3000);
}

/*
 * One education, and the first block's dates.
 *
 * With one school on the resume this used to return straight away — "one
 * education is the profile's fields, and those have been through the form
 * already". But they have not all been: the first pass reads a date as the
 * degree's only under a heading that says so (`educationDateKey`), and the
 * heading here is a `<p>`. Measured on Twitch's live board
 * (job-boards.greenhouse.io/twitch), one education — Northeastern
 * University, BS Computer Science, September 2023 to May 2027 — came out
 * with School, Degree and Discipline chosen and Start date month, Start date
 * year, End date month and End date year all empty, and nothing in the
 * report about any of them. The two-education fill had been giving the
 * first block its dates all along; the one-education fill, which is most
 * people's, never did.
 *
 * So one education takes the same first-block route with less: its start
 * and end, month and year, from the resume's own entry, into the first
 * block only, and only into a date that is empty and that the first pass
 * did not already try. Nothing else a one-education fill does changes —
 * no block is added, no school, degree or discipline is touched, and a
 * block showing some other school is left exactly as it was, since those
 * dates would be somebody else's.
 */
const EDUCATION_DATE = /^(education_start|graduation)_(month|year|date)$/;

export async function fillEducation(education, fields, report, { patience = 4000 } = {}) {
  const schools = Array.isArray(education) ? education.filter((e) => clean(e?.school)) : [];
  let section = educationSection();
  if (!section) return report;
  /*
   * Said, where there is an Education section and it is being left.
   *
   * Every way out of here was silent, so a form whose dates stayed empty and
   * whose "Add another" was never pressed looked exactly like one this had
   * never reached — measured on a Greenhouse board filled from a profile and
   * no resume: School, Degree and Discipline in, four dates and the second
   * school out, and a report with nothing about education in it at all.
   */
  const leaving = (reason) => ({
    ...report,
    skipped: [...report.skipped, { key: 'education_start_date', reason, description: 'Education' }],
  });
  if (schools.length === 0) return leaving('the resume sent lists no schools, so the dates and any others were left');
  const onlyOne = schools.length === 1;

  const owner = fields?.school ? schools.findIndex((e) => sameSchool(e.school, fields.school)) : -1;
  if (fields?.school && owner < 0) {
    return leaving(`the resume sent does not list “${clean(fields.school).slice(0, 60)}”, the school the form was given`);
  }
  // What the first pass looked at, in the first block. Not asked twice.
  const tried = new Set([...report.filled, ...report.skipped].map((x) => x.key));

  const filled = [];
  const skipped = [];
  const used = new Set();
  const fits = (block, f) => ![...block].some(([key, control]) => anotherLevelOfStudy(control, key, f));

  const waiting = () => schools.some((_, i) => !used.has(i));
  for (let n = 0; ; n++) {
    // One education has the first block and no other. See `EDUCATION_DATE`.
    if (onlyOne && n > 0) break;
    // A section the page drew again is found again, never counted as empty.
    if (!section.box.isConnected) section = educationSection();
    if (!section) break;
    let blocks = educationBlocks(section.box) ?? [];
    let added = false;
    if (n >= blocks.length) {
      if (!waiting() || blocks.length >= schools.length) break;
      const grown = await addAnother(section, blocks.length);
      if (!grown) {
        skipped.push({ key: 'school', reason: 'the form would not add another', description: 'Education' });
        break;
      }
      ({ section, blocks } = grown);
      added = true;
      if (n >= blocks.length) break;
    }
    const block = blocks[n];

    let index;
    const shown = schoolShown(block.get('school'));
    // Another school's block, whose dates these are not; left, and not remarked on.
    if (onlyOne && shown && !sameSchool(schools[0].school, shown)) break;
    if (shown) {
      index = schools.findIndex((e, i) => !used.has(i) && sameSchool(e.school, shown));
      if (index < 0) {
        skipped.push({ key: 'school', reason: 'this school is not on the resume', description: shown.slice(0, 60) });
        continue;
      }
    } else if (n === 0 && owner >= 0) {
      index = owner;
    } else if (onlyOne) {
      // A block asking about a level this education is not at is not its block.
      if (!fits(block, educationFields(schools[0]))) break;
      index = 0;
    } else {
      index = schools.findIndex((e, i) => !used.has(i) && fits(block, educationFields(e)));
      if (index < 0) {
        /*
         * A block asking about a level — "Graduate School" — that none of the
         * schools still to place is at. Said, because it is a block the person
         * may have to take out again; and if it is one this just added, no
         * more are, since the next would be asked the same way.
         */
        if (waiting()) {
          const asked = describeField(block.get('school') ?? [...block.values()][0]);
          skipped.push({ key: 'school', reason: 'no school left on the resume is at the level this one asks about', description: asked.slice(0, 60) });
        }
        if (added) break;
        continue;
      }
    }
    used.add(index);

    const f = educationFields(schools[index]);
    for (const [key, control] of block) {
      if ((n === 0 && tried.has(key)) || !f[key] || !control.isConnected) continue;
      if (onlyOne && !EDUCATION_DATE.test(key)) continue;
      if (partAnswered(control) || anotherLevelOfStudy(control, key, f)) continue;
      const got = await fillEducationPart(control, key, f[key], f, patience);
      if (got.reason) skipped.push(got);
      else filled.push({ ...got, education: index + 1 });
    }
  }

  return { ...report, filled: [...report.filled, ...filled], skipped: [...report.skipped, ...skipped] };
}

/**
 * Is this document an application form at all?
 *
 * Asked only of frames, and only because the script now runs in all of them so
 * that it can reach the form on the systems that serve it in an iframe. The
 * other frames on a job posting are adverts, newsletter boxes and embedded
 * widgets, and they have fields with exactly the same names — an advert asking
 * for an email address looks, field by field, like the top of an application.
 *
 * Typing someone's address and name into a third party's iframe is a different
 * and worse kind of wrong than leaving a field empty, so the test is for
 * evidence rather than absence of doubt: something only an application asks
 * for, or enough of the form that nothing else would have it.
 */
const APPLICATION_WORDS =
  /\b(submit (your )?application|start your application|cover letter|work authoriz\w*|legally authorized to work|require sponsorship|equal opportunity employer|voluntary self-identification)\b/i;

/**
 * A question only the employer would ask.
 *
 * Recruitee asks for a name, an email, a phone number and "What draws you to
 * this team?" — and labels none of them, using `aria-label` throughout. By
 * every other rule here that is a newsletter box with a comment field: the
 * three fields are the three a mailing list asks for, there is no file
 * upload, and the prose says nothing about applying. So the form was filled
 * correctly and then not recognised as a form at all, which matters because
 * recognition is what gates autofill inside a frame and the finding of
 * questions anywhere.
 *
 * The open question is the evidence that was being ignored. Narrowly: one
 * that asks about *this* role, team or company. "How can we help?" on a
 * contact form and "Comment" under a blog post ask about neither, and both
 * are fixtures here precisely so this cannot quietly start filling them.
 */
const ASKS_ABOUT_THE_JOB =
  /\b(this (role|team|position|job|opportunity|company)|work(ing)? (here|with us|for us)|join(ing)? (us|the team)|our (team|company|mission))\b/i;

/*
 * Fields an advert has no reason to ask for.
 *
 * Name, email, phone and town are the four an application opens with, and also
 * the four a newsletter box asks for — so counting parts of a person cannot
 * tell the two apart. Degree, work authorization, sponsorship, GPA: these are
 * asked by something that intends to employ you.
 */
/*
 * Fields an advert has no reason to ask for.
 *
 * Name, email, phone and town are the four an application opens with, and also
 * the four a newsletter box asks for — so counting parts of a person cannot
 * tell the two apart, which is what the old threshold of four tried to do.
 * LinkedIn, a degree, a GPA, the right to work: these are asked by something
 * that intends to employ you.
 *
 * Deliberately not `website` (name, email and website is a blog comment box)
 * and not the address fields (a job search box asks for city and country).
 */
const TELLTALE = new Set([
  'linkedin', 'github', 'school', 'degree', 'major', 'gpa',
  'work_authorization', 'requires_sponsorship',
]);

/**
 * Watch what the person chooses, so the next form can offer it back.
 *
 * Applying is the same twenty questions over and over, and the answers to most
 * of them do not change. What changes is the wording and the widget, which is
 * why this records the *question* and the *answer as a human reads it* rather
 * than a field name and a value: `q_88213 = 1` is worth nothing on the next
 * site, and "Are you legally authorized to work in the United States? — Yes"
 * is worth something on all of them.
 *
 * Chosen answers only, and that scope is most of the safety here rather than a
 * limitation worked around: a chosen answer is one of a handful the form
 * itself offered, and no form offers a social security number in a dropdown.
 * See `worthRemembering`, which refuses the rest.
 *
 * Returns a function that stops watching, the way `watchForSending` does.
 */
export function watchChoices(tell) {
  const seen = (control) => {
    /*
     * The question is the group's, never the button's own label — each button
     * carries one of the answers. `groupLabelFor` already knows that and says
     * why at length.
     *
     * And it is the *question*, never the description. The first version of
     * this stored `describeField(control)`, which is a bag of words built for
     * regular expressions: the label, plus `name`, `id` and `placeholder`,
     * each also split into words. Greenhouse's work-authorisation dropdown
     * therefore went into the bank as
     *
     *   Are you legally authorized to work in the United States? *
     *   job_application[answers_attributes][1][boolean_value]
     *   job application[answers attributes][1][boolean value] …
     *
     * — which reads as nonsense in the Workspace, writes a form's internal
     * field names into somebody's store, and above all can never be found
     * again: the matcher scores on shared words, and those are shared with
     * nothing. Every select somebody answered was recorded and none of it
     * was ever offered back. The same three functions the reuse side uses
     * (`rememberableChoices`), so that what is written down and what is
     * looked up are the same string.
     */
    if (control instanceof HTMLSelectElement) {
      // Radix's own `change`, after a pick `watchWidgetPicks` reads off the
      // dropdown. See `isWidgetPartner`.
      if (isWidgetPartner(control)) return null;
      const option = control.selectedOptions?.[0];
      if (!option || looksLikePlaceholder(option, control)) return null;
      return { question: clean(questionFor(control)), answer: clean(option.textContent) };
    }
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      if (!control.checked) return null;
      /*
       * The group `radioGroups` makes, so that what is written down is asked
       * of the buttons it is asked of when filling. Matching `name` and
       * `form` here put two yes/no components that draw their buttons under
       * one name of their own into one group of four, and measured, a
       * person's No to "Will you now or in the future require visa
       * sponsorship?" was kept as their No to "Are you legally authorized to
       * work in the United States?", the question before it.
       */
      const group = radioGroups().find((radios) => radios.includes(control)) ?? [control];
      return {
        question: clean(groupLabelFor(group)),
        answer: optionLabelFor(control),
      };
    }
    /*
     * A pressed button — Ashby's Yes and No, see `pressedButtonGroups` — is
     * read the same way, from the same walk the reuse side makes, and
     * *after* the page's own handler: this listener is on `document` in the
     * capture phase, so it runs before the page's, and the page writes
     * `aria-pressed` a microtask after that. Pressing the pressed one lets
     * go of it, and that is not an answer to keep; so the button is asked
     * again once the page has run, and only a pressed one is written down.
     */
    const button = control?.closest?.('button[aria-pressed]');
    if (button) {
      const group = pressedButtonGroups().find((g) => g.options.includes(button));
      if (!group) return null;
      return {
        question: clean(group.question),
        answer: clean(button.getAttribute('aria-label') || button.textContent),
        once: () => isPressed(button),
      };
    }
    /*
     * Out through the components the press lands in, as `ariaOptionsIn`
     * finds their options. What is pressed is the innermost thing drawn,
     * and `closest` stops at the root it is drawn in: a `<button>` inside a
     * component that wears `role="radio"` itself, or a `<button
     * role="radio">` drawn in a component inside the page's radiogroup,
     * found no group, and measured, a person's No to the sponsorship
     * question pressed on either was not kept at all.
     */
    const option = control?.closest ? closestAround(control, AN_ARIA_OPTION) : null;
    // select2's list, whose pick `watchChosenPicks` reads off the select.
    if (option && isSelect2Part(option)) return null;
    if (option) {
      /*
       * The group `ariaChoiceGroups` answers it in (`choiceGroupOf`), not
       * the nearest: a `role="group"` in a listbox heads some of its options.
       * Measured, a person's Germany in a Country listbox headed "Europe"
       * over France and Germany was kept as "Europe — Germany", under a
       * question no form asks, and never offered back to "Country".
       */
      const group = choiceGroupOf(option);
      if (!group) return null;
      // A widget's menu is the widget's question, and `watchWidgetPicks` reads it.
      if (group.getAttribute('role') === 'listbox' && ownerOfMenu(group)) return null;
      return {
        question: choiceQuestionFor(group),
        answer: ariaOptionWords(option),
      };
    }
    return null;
  };

  const look = (event) => {
    // Autofill's own filling, not a choice. See `OUR_EVENTS`.
    if (OUR_EVENTS.has(event)) return;
    const target = event.composedPath?.()?.[0] ?? event.target;
    if (!target || rootOf(target)?.host?.id === OURS) return;
    let said;
    try {
      said = seen(target);
    } catch {
      // A page that throws from a getter is not a reason to break the form.
      return;
    }
    if (!said?.question || !said?.answer) return;
    const { once, ...answer } = said;
    /*
     * The refusal is here rather than at the far end, so nothing personal
     * leaves the page at all — not to the worker, not to the store, not into
     * a log on the way. See `worthRemembering`.
     */
    const write = () => {
      const verdict = worthRemembering(answer);
      tell(verdict.keep ? { ...answer, keep: true } : { ...answer, keep: false, why: verdict.why });
    };
    if (!once) return write();
    setTimeout(() => {
      if (watching && once()) write();
    }, 0);
  };
  let watching = true;

  /*
   * `change` for the native controls, which is what a browser fires when a
   * choice is made, and `click` for the ARIA ones, which fire nothing at all
   * — the page's own handler is what marks them chosen, so this runs after it
   * and reads what it decided.
   */
  document.addEventListener('change', look, true);
  document.addEventListener('click', look, true);
  // And a pick in a react-select, which fires neither usefully. See `watchWidgetPicks`.
  const told = (answer) => {
    const verdict = worthRemembering(answer);
    tell(verdict.keep ? { ...answer, keep: true } : { ...answer, keep: false, why: verdict.why });
  };
  const stopPicks = watchWidgetPicks(told, () => watching);
  // And one in Chosen or select2, which fire no native event at all. See `chosenOf`.
  const stopChosen = watchChosenPicks(told, () => watching);
  return () => {
    watching = false;
    document.removeEventListener('change', look, true);
    document.removeEventListener('click', look, true);
    stopPicks();
    stopChosen();
  };
}

/**
 * A person's pick in a Chosen or select2 list, read off the select it stands
 * in for.
 *
 * Both pick on mouseup, or on a key, and tell only jQuery. So the select's
 * value is noted when a press or a key goes down inside the container and
 * read again once the page has handled the release, the click or the key
 * that follows; a value that moved is the pick. The release, because select2
 * takes its dropdown off the page on it, and the click that follows has
 * nowhere left to land. A native `change` in between — a build that fires
 * one — is heard by `watchChoices` itself, and is not told twice.
 */
function watchChosenPicks(write, watching) {
  const before = new WeakMap();
  const selectAt = (event) => {
    const target = event.composedPath?.()?.[0] ?? event.target;
    const container = target?.closest?.(CHOSEN);
    if (container) return selectOfChosen(container);
    return selectOfSelect2(target);
  };
  const note = (event) => {
    const select = selectAt(event);
    if (select) before.set(select, select.value);
  };
  const heard = (event) => {
    const target = event.composedPath?.()?.[0] ?? event.target;
    if (target instanceof HTMLSelectElement && (chosenOf(target) || select2Of(target))) before.set(target, target.value);
  };
  const check = (event) => {
    if (!event.isTrusted) return;
    const select = selectAt(event);
    if (!select || !before.has(select)) return;
    setTimeout(() => {
      if (!watching() || before.get(select) === select.value) return;
      before.set(select, select.value);
      const option = select.selectedOptions?.[0];
      if (!option || looksLikePlaceholder(option, select)) return;
      write({ question: clean(questionFor(select)), answer: clean(option.textContent) });
    }, 0);
  };
  const events = [['mousedown', note], ['keydown', note], ['change', heard], ['mouseup', check], ['click', check], ['keyup', check]];
  for (const [type, fn] of events) document.addEventListener(type, fn, true);
  return () => {
    for (const [type, fn] of events) document.removeEventListener(type, fn, true);
  };
}

export function looksLikeApplicationForm() {
  const text = deepText();

  const keys = new Set();
  for (const input of deepQueryAll('input, textarea, select')) {
    const description = describeField(input);
    if (!description) continue;
    const match = FIELD_PATTERNS.find(([, re]) => re.test(description));
    if (match) keys.add(match[0]);
    // The same bare "Name" that `fillForm` fills — a real part of a person,
    // and on several systems the only place the name is asked for.
    else if (BARE_NAME.test(withoutMarkers(labelFor(input)))) keys.add('full_name');
  }

  let telltales = 0;
  for (const key of keys) if (TELLTALE.has(key)) telltales++;

  /*
   * Something only an application would have. Each of the old routes here let
   * a third party's iframe through, and each was a route on its own:
   *
   * "apply for this" is a call to action, not a form — a sponsored "Senior SRE
   * at Hyperion. Apply for this role" creative with an email-alerts box prints
   * it, and the user's name and city were typed into the advertiser's input,
   * where the page's own script read them straight off the input event.
   *
   * Counting four parts of a person was worse, because it needed no words at
   * all: name, email, phone and town is a newsletter box. But it cannot simply
   * be raised, because iCIMS asks for exactly four and Taleo for five. What
   * separates them is not how many but which — an employer asks for a legal
   * first and last name as two fields, where a mailing list asks for "Name".
   */
  const evidence =
    APPLICATION_WORDS.test(text) ||
    // A long-form question about this role — see `ASKS_ABOUT_THE_JOB`.
    (deepQueryAll('textarea').length > 0 && ASKS_ABOUT_THE_JOB.test(text)) ||
    // A file upload beside the word résumé is the clearest sign there is.
    (deepQueryAll('input[type=file]').length > 0 && /\b(resum|cv)\b/i.test(text)) ||
    // One field only an employer asks for. The hosted systems serve the form
    // on its own with no prose to match against — Ashby's frame is six
    // labelled inputs and nothing else — so there has to be a route that reads
    // the fields rather than the copy.
    telltales >= 1 ||
    (keys.has('first_name') && keys.has('last_name'));

  // And in every case, enough of a form to be one. Evidence alone let a frame
  // through that merely talked about applying.
  return evidence && keys.size >= 2;
}

/**
 * Whether the form in this frame may be given the profile when Autofill is
 * pressed.
 *
 * An application, by the rules above — or a frame served from the page's own
 * origin. The recognition exists to keep the person's details out of somebody
 * else's iframe, and a frame from the page's own origin is not somebody else:
 * the page could read it, and the same form sitting in the page itself would
 * have been filled without being recognised at all.
 *
 * iCIMS is why. Its sign-in step is served in a frame of the careers site and
 * asks for the email and nothing more — one field, and no words an
 * application uses, so it was never recognised and Autofill said "Filled 0
 * fields" over an empty Email box.
 */
/*
 * And only on a hiring system's own host. The page's own origin alone let
 * every advert a site serves from itself through: measured in
 * tests/navigation.mjs, forty-eight same-origin advert frames beside the one
 * application were each given the person's name and email. A frame of
 * careers-markon.icims.com on that same host is the sign-in; one on a news
 * site is not. The same list the card uses to tell a tracker's page.
 */
const ON_A_TRACKER_HOST =
  /\b(greenhouse|lever|workday|myworkdayjobs|ashby|ashbyhq|workable|smartrecruiters|icims|taleo|jobvite|bamboohr|rippling|breezy|recruitee|teamtailor|jazzhr|successfactors|brassring|myjobs\.adp|workforcenow\.adp)\b/i;

export function mayFillFrame() {
  if (looksLikeApplicationForm()) return true;
  try {
    return (
      /^https?:$/.test(location.protocol) &&
      window.top.location.origin === location.origin &&
      ON_A_TRACKER_HOST.test(location.hostname)
    );
  } catch {
    // Another origin's page, which a frame may not read.
    return false;
  }
}

/** Marks a field so the card can point back at it later. */
const FIELD_KEY = 'data-jobhelper-field';
let fieldCounter = 0;

/**
 * The same marks, kept here as well as on the element.
 *
 * CKEditor 5 draws its editing root's attributes from its own model, so a
 * mark put on the element is taken off the next time it renders — and
 * focusing it is a render. Measured against the real editor: click in the
 * box, press Insert, and it was refused with "that box on the page is gone or
 * asks something else now", the box in plain view and asking the same thing.
 * Held weakly, so a form that throws its boxes away does not keep them.
 */
const markedAs = new Map();

function markedField(fieldId) {
  const onPage = deepQueryAll(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`)[0];
  if (onPage) return onPage;
  const kept = markedAs.get(fieldId)?.deref();
  return kept?.isConnected ? kept : undefined;
}

/**
 * Find the free-text questions on the page — the boxes that want a paragraph,
 * not a phone number. Returned rather than filled: a long-form answer is
 * something to read before it goes out under your name.
 */
export function findQuestions() {
  const found = [];
  const candidates = [
    ...deepQueryAll('textarea'),
    // Some boards use a contenteditable div for long answers.
    ...deepQueryAll('[contenteditable="true"]'),
  ];

  for (const field of candidates) {
    if (field instanceof HTMLTextAreaElement && !isFillable(field)) continue;
    if (field.getClientRects().length === 0) continue;

    /*
     * Nor an editor's own workings, put where nobody can reach them.
     *
     * Quill 1 keeps a second contenteditable beside every editor, 100000px
     * off the left of the page, to catch pastes in. It has no label, so the
     * positional fallback read the editor beside it as its question — which
     * is whatever the person has typed so far. Measured against the real
     * Quill 1.3.7 with the extension loaded: type "I like the team here."
     * into the page's editor and the card listed "I like the team here." as
     * a question of its own, redrawn as the question watcher saw the page
     * change. A box entirely left of or above the page cannot be typed in.
     */
    if (!(field instanceof HTMLTextAreaElement)) {
      const at = field.getBoundingClientRect();
      if (at.right + window.scrollX <= 0 || at.bottom + window.scrollY <= 0) continue;
    }

    /*
     * The cover letter box is not an essay question. It is long-form, it is
     * labelled, and it passes every test below — so it was being offered as a
     * question to draft an answer to, on the same card that already has a
     * cover letter step for it. One box, asked for twice.
     */
    if (/cover\s*letter/i.test(describeField(takenOver(field) ?? field))) continue;

    /*
     * Nor a past job's description. Workday's "My Experience" has a Role
     * Description in every work-history block, and it passed every test below
     * — so the card listed "Role Description" once per job as questions for
     * the AI to write, keyed by their words so that every job shared one
     * answer. It is the resume's own lines for that job, which autofill copies
     * in; see `fillWorkHistory`. The model writes letters and answers, never
     * the resume.
     */
    if (field instanceof HTMLTextAreaElement && jobPartOf(field)?.part === 'description' && inWorkHistory(field)) continue;

    /*
     * The placeholder, where there is no label at all.
     *
     * Lever labels nothing: "Why do you want to work at Lever?" is a
     * placeholder on the textarea and nothing else, so the one question on the
     * form was not offered — the card showed a form with no questions on it,
     * and the box stayed empty. Only as a fallback, and only from the
     * placeholder rather than `describeField`, because a field's name and id
     * are not a question anyone wrote.
     */
    const question = questionOf(field);
    // Anything this short is a label like "Notes" rather than a question worth
    // drafting an answer to — unless it ends in a question mark, which settles
    // it. "Why us?" is seven characters and is exactly the sort of thing this
    // is for.
    if (!question) continue;
    if (question.length < 12 && !question.endsWith('?')) continue;

    let id = field.getAttribute(FIELD_KEY);
    if (!id) {
      id = `jh-${++fieldCounter}`;
      field.setAttribute(FIELD_KEY, id);
    }
    markedAs.set(id, new WeakRef(field));
    found.push({
      fieldId: id,
      question,
      currentValue: field.value ?? field.textContent ?? '',
      /*
       * The box's own limit. A script assigning a value is not held to
       * `maxlength`, so an answer over it went in whole and the form refused
       * it on submit. -1 is what a box without one reports.
       */
      ...(field.maxLength > 0 ? { limit: field.maxLength } : {}),
      ...(yoursToAnswer(question) ? { yours: yoursToAnswer(question) } : {}),
    });
  }
  return found;
}

/*
 * Questions a model must not answer for you, and why.
 *
 * These are still offered — hiding a question the form requires is the worse
 * failure, and the box is still there to type in. What is withheld is the
 * "draft an answer" button, because an answer invented for any of these is
 * either a false statement or a disclosure that is not the tool's to make.
 *
 * A salary figure is the plain case: whatever a model writes is a number the
 * applicant did not choose and may be held to. The self-identification
 * questions are the other kind — voluntary by law and about the person, so an
 * answer written on their behalf is a lie told in their name about something
 * they were entitled to decline.
 */
const YOURS_TO_ANSWER = [
  /*
   * Plurals matter here, and this is where that was measured rather than
   * assumed: "What are your salary expectations for this role?" is the single
   * commonest phrasing on any form, and `expectation` without the `s?` misses
   * every one of them.
   */
  [/\b(salary|compensation|wage|pay|rate|comp)\b.*\b(expectations?|expected|desired|requirements?|ranges?|seeking)\b/i,
    'A figure here is yours to choose.'],
  [/\b(expected|desired|minimum|required)\b.*\b(salary|compensation|pay|rate)\b/i,
    'A figure here is yours to choose.'],
  [/\b(disabilit|accommodat|impairment)\w*/i,
    'This one is yours to answer — nothing is written for you.'],
  [/\b(race|ethnicit|gender|veteran|disabled|sexual orientation|pronoun)\w*/i,
    'This one is yours to answer — nothing is written for you.'],
  /*
   * And the two the rest of this file treats as the most damaging to get
   * wrong, which were not on this list at all.
   *
   * `yesNoFrom` goes to great lengths so that a *tick box* about the right to
   * work is never filled in against what the applicant wrote — the note above
   * it calls a wrong answer there a false legal declaration made in their
   * name. The same question asked as a paragraph ("Please describe your
   * current work authorisation status", "If you will require sponsorship,
   * please explain") is an ordinary custom question on Greenhouse and Lever,
   * and it was offered to the model to invent an answer for.
   */
  [/\b(work[\s_-]authori[sz]ation|authori[sz]ed[\s_-]to[\s_-]work|right[\s_-]to[\s_-]work|sponsorship|sponsor|visa|h-?1b|opt|cpt|immigration|citizenship|work[\s_-]permit)\b/i,
    'This one is yours to answer — nothing is written for you.'],
  [/\b(criminal|conviction|felony|misdemeanou?r|background check)\b/i,
    'This one is yours to answer — nothing is written for you.'],
];

/** The reason a question is yours alone, or undefined where it is not. */
export function yoursToAnswer(question) {
  for (const [re, why] of YOURS_TO_ANSWER) if (re.test(question)) return why;
  return undefined;
}

/**
 * Does this form want a cover letter? Boards signal it with a file upload
 * named for one, or a long-answer box that says so.
 */
export function wantsCoverLetter() {
  for (const field of deepQueryAll('input[type=file], textarea, label, legend')) {
    const text = `${field.getAttribute?.('name') ?? ''} ${field.getAttribute?.('id') ?? ''} ${
      field.textContent ?? ''
    }`.toLowerCase();
    if (/cover\s*letter/.test(text)) return true;
  }
  return false;
}

/**
 * Whether a question is marked required, by any of the usual conventions.
 *
 * The field's own label first. Climbing to `closest('div,fieldset,li,p')` and
 * taking the first label in it usually landed on the wrapper around the whole
 * form, whose first label is "First Name *" — so every question on the form
 * came back required, and the workspace told the user that optional ones had to
 * be answered. Climbing is still useful for the forms that mark the asterisk on
 * a wrapper rather than the label, but only while the container holds this
 * field and nothing else fillable, which is the rule `labelFor` already uses.
 */
export function isRequired(fieldId) {
  const found = deepQueryAll(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`)[0];
  if (!found) return false;
  // Asked by the textarea an editor was put on, so required by its label too.
  // See `takenOver`.
  const field = takenOver(found) ?? found;
  if (field.required || field.getAttribute('aria-required') === 'true') return true;

  const marked = (text) => /\*|\brequired\b/i.test(text ?? '');

  // The label actually associated with this field, or with the component it
  // is drawn in: see `componentLabel`.
  const own =
    (field.id && rootOf(field).querySelector(`label[for="${CSS.escape(field.id)}"]`)) ||
    field.closest('label') ||
    componentLabel(field);
  if (own) return marked(own.textContent);

  /*
   * And on out of a component, as `labelFor` climbs.
   *
   * `parentElement` stops at the shadow root a field is drawn in, so a box in
   * a component had no group at all to find its mark in: `<label>Why do you
   * want to work here? *</label>` beside a component drawing a textarea read
   * as optional, and the card listed a required question as one that could
   * be left. The root is one more group, and when it holds this field alone
   * the climb carries on from its host; a root costs none of the three
   * levels, which are the page's wrappers.
   *
   * Counting the fields drawn in components, as `labelFor` does (see
   * `fieldsIn`): a wrapper holding a required question and then a component
   * with no label of its own looks, to `querySelectorAll`, like a wrapper
   * holding one field, and the second box took the first one's asterisk.
   */
  /*
   * And in through the slot the page's own box is put in, as `labelFor`
   * climbs: an asterisk a component draws on the label round its slot is
   * this box's when the wrapper holds no other, counting those put in the
   * same component through its slots (`fieldsDrawnIn`). The component's
   * wrappers cost none of the three.
   */
  let from = field;
  const putInto = new Set();
  let group = groupDrawnAround(field, putInto);
  for (let i = 0; i < 3 && group; ) {
    if (fieldsDrawnIn(group, ANOTHER_FIELD, 2) > 1) break;
    const label = group.querySelector('label,legend');
    if (label) return marked(label.textContent);
    if (group instanceof ShadowRoot) {
      if (group.host.id === OURS) break;
      from = group.host;
    } else {
      if (!putInto.has(group.getRootNode())) i++;
      from = group;
    }
    group = groupDrawnAround(from, putInto);
  }
  return false;
}

/** What a question box asks, as `findQuestions` reads it. */
function questionOf(field) {
  const asked = takenOver(field) ?? field;
  return cleanQuestion(questionFor(asked) || asked.getAttribute?.('placeholder') || '');
}

/**
 * The textarea a rich-text editor has been put on, where it has one.
 *
 * CKEditor, Summernote and their kind are started on a `<textarea>`: they
 * hide it, keep it as what the form sends, and draw their own box straight
 * after it. The page's label still names the textarea, and the box has a
 * label of the editor's — CKEditor 5 calls every one it draws "Editor editing
 * area: main. Press Alt+0 for help.", and that was the question the card
 * offered, measured against the real editor under a label reading "Why do you
 * want to work here?". A draft was asked for against that sentence, and an
 * answer saved for next time was filed under words every CKEditor form uses.
 *
 * Only a hidden textarea immediately before the box or one of the few
 * elements around it, and never past one that holds another place to write:
 * the label of a different question is exactly what must not be borrowed.
 */
/*
 * And out of the component the editor is drawn in.
 *
 * An editor drawn in a component — its editing box in the component's root,
 * the component straight after the page's hidden textarea — was never
 * matched to the textarea: `previousElementSibling` inside the root is the
 * component's `<style>`, and `parentElement` stops at the root. Measured,
 * each such editor was offered as "Editor editing area: main. Press Alt+0
 * for help.", not required, and the cover letter's editor as a question of
 * its own, where the same editors drawn into the page were "Why do you want
 * to work at Acme?", required, and no question at all.
 *
 * The root is one more wrapper and costs none of the three. And "another
 * place to write" counts those drawn in components: two editors drawn in
 * components side by side after one hidden textarea look, to
 * `querySelectorAll`, like a wrapper holding nothing else to write in, and
 * both took the textarea's question.
 */
const A_PLACE_TO_WRITE = 'textarea, [contenteditable="true"]';

function takenOver(field) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) return null;
  let node = field;
  for (let i = 0; i < 3 && node; ) {
    const before = node.previousElementSibling;
    if (before instanceof HTMLTextAreaElement && before.getClientRects().length === 0) return before;
    const around = containerOf(node);
    const others = around
      ? deepQueryAll(A_PLACE_TO_WRITE, around).filter((f) => f !== field && !drawnInside(f, field) && !drawnInside(field, f))
      : [];
    if (!around || others.length > 0) return null;
    if (around instanceof ShadowRoot) {
      if (around.host.id === OURS) return null;
      node = around.host;
    } else {
      node = around;
      i++;
    }
  }
  return null;
}

/*
 * The same question, however its counter reads. A label that says "(500
 * characters remaining)" says 473 once something is typed into the box, and
 * that is not a different question; a different sentence is.
 */
const askedAs = (question) => cleanQuestion(question).replace(/\d+/g, '#').toLowerCase();

/**
 * Put text into a field the card previously identified.
 *
 * `question` is what the card showed above the answer, and the field has to
 * still be asking it. Questions are found once, when the card goes up, and
 * the box is marked with an id; a form that moves to its next step by
 * re-rendering in place keeps the same element for step two's box, our mark
 * still on it, with the url unchanged and so nothing reading the questions
 * again. Measured in tests/autofill.mjs: Insert under "Why do you want to
 * work at Acme?" wrote that answer into step two's "Describe a time you
 * failed." and returned true. Where it no longer matches, nothing is written.
 */
export async function insertAnswer(fieldId, text, question) {
  const field = markedField(fieldId);
  if (!field) return false;
  if (question != null && askedAs(questionOf(field)) !== askedAs(question)) return false;
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    setValue(field, text);
  } else if (!(await pasteInto(field, text))) {
    return false;
  }
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/**
 * Put text into a rich-text editor the way the editor takes it: as a paste.
 *
 * A contenteditable box on an application form is almost never a bare
 * `<div>`. It is Draft.js, Quill, ProseMirror, CKEditor or TinyMCE, and what
 * the form submits is the editor's own document, not the element's text.
 * Setting `textContent` wrote the words into the element and nowhere else.
 * Measured against the real editors: Draft.js kept an empty EditorState and
 * submitted nothing, CKEditor 5 put its own empty paragraph straight back,
 * and Quill and ProseMirror kept the words but ran the paragraphs into one —
 * while Insert returned true and the card said nothing was wrong.
 *
 * Every one of them handles a paste, because that is how people put an answer
 * written elsewhere into them. So the box's contents are selected, the
 * selection is left a turn to reach the editor — Draft.js, ProseMirror and
 * CKEditor learn it from `selectionchange`, and pasted straight away they put
 * the answer after what was there instead of in place of it — and a paste
 * carrying the text is delivered. An editor that does not take pastes itself
 * (a plain box, Quill 1, TinyMCE) gets the browser's own `insertText`, which
 * those read off the DOM and which splits paragraphs as typing would.
 *
 * Then it is read back, because a paste is an event and an event nobody
 * handled looks like one that worked. True only when the words are in the box.
 */
async function pasteInto(field, text) {
  const doc = field.ownerDocument;
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  field.focus({ preventScroll: true });
  const all = doc.createRange();
  all.selectNodeContents(field);
  const selection = doc.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(all);
  await settle(0);

  const carrier = new DataTransfer();
  carrier.setData('text/plain', text);
  const paste = new ClipboardEvent('paste', { clipboardData: carrier, bubbles: true, cancelable: true });
  field.dispatchEvent(paste);
  if (!paste.defaultPrevented) doc.execCommand('insertText', false, text);

  // Some take a paste on a timer of their own; Quill 1 does.
  const flat = (s) => String(s ?? '').replace(/\s+/g, '');
  for (let i = 0; i < 6; i++) {
    if (flat(field.textContent).includes(flat(text))) return true;
    await settle(40);
  }
  return false;
}

/**
 * Labels arrive with the surrounding furniture attached — character counters,
 * "(optional)", the word "Required". Strip it so the question matches what was
 * stored last time.
 */
function cleanQuestion(raw) {
  return String(raw)
    .replace(/\b\d+\s*(?:of|\/)\s*\d+\s*characters?\b/gi, '')
    .replace(/\(\s*optional\s*\)/gi, '')
    .replace(/\*\s*(required|mandatory)\b/gi, '')
    .replace(/\b(required|optional)\b\s*$/gi, '')
    // A bare asterisk is the universal "required" marker, and it was surviving
    // into the question — so the same question stored from two forms, one
    // marked required and one not, became two questions in the answer bank.
    .replace(/^\s*\*+\s*/, '')
    .replace(/\s*\*+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export { describeField, questionFor, labelFor };
