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
import { dependsOnEmployer, neverRemember, worthRemembering } from '../shared/remembering.js';

/** Map a stored profile key to the label/name patterns that mean it. */
const FIELD_PATTERNS = [
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
   * name (Last)" were each given "Jianwen Ding", and "Legal name (Middle)" the
   * whole name too, a middle name the profile does not hold. Only a bracket
   * holding the one word: "Full legal name (first, middle, last)" asks for
   * all of it. `middle_name` is never in a profile, so that box stays blank.
   */
  ['first_name', /\bname[\s_-]*\([\s_-]*(first|given)([\s_-]*name)?[\s_-]*\)/i],
  ['last_name', /\bname[\s_-]*\([\s_-]*(last|family|surname)([\s_-]*name)?[\s_-]*\)/i],
  ['middle_name', /\bname[\s_-]*\([\s_-]*middle([\s_-]*name)?[\s_-]*\)/i],
  ['first_name', /\b(first[\s_-]?name|given[\s_-]?name|forename|fname)\b/i],
  ['last_name', /\b(last[\s_-]?name|family[\s_-]?name|surname|lname)\b/i],
  ['full_name', /\b(full[\s_-]?name|your[\s_-]?name|candidate[\s_-]?name|legal[\s_-]?name)\b/i],
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
  ['current_company', /\b(current|present|most[\s_-]*recent)[\s_-]*(company|employer|organi[sz]ation|org)\b/i],
  ['current_title', /\b(current|present|most[\s_-]*recent)[\s_-]*(job[\s_-]*)?(title|role|position)\b/i],
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
  ['graduation_year', /(\bgrad\b|\bgraduat\w*|\bcompletion\b).{0,40}\byear\b|\byear\b.{0,40}\bgraduat|\bclass\s*year\b|\bclass\s+of\b|\bgraduating\s+class\b/i],
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
  ['degree', /\b(degree)\b/i],
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
   */
  [
    'work_authorization',
    /\b(work[\s_-]?authoriz\w*|legally[\s_-]?authorized|(authoriz|eligib)\w*[\s_-]+(to[\s_-]+work|for[\s_-]+employment)|right[\s_-]?to[\s_-]?work)\b/i,
  ],
  ['requires_sponsorship', /\b(sponsor\w*|visa[\s_-]?status)\b/i],
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
   */
  /\b(references?|referee|emergency|next[\s_-]?of[\s_-]?kin|guardian|spouse|supervisor|manager'?s?|recommender|referr(?:er|ers|ing|ed)|recruiters?|parents?|professors?|advis[oe]rs?)\b/i,
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
   */
  /\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+(address|location|city|town|state|province|country|phone|telephone|email|zip|postal|web[\s_-]?site|url)\b|(?<!^[\W_]*(?:current|present|most[\s_-]*recent)[\s_-]+)\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+name\b/i,
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
  const legend = clean(input.closest('fieldset')?.querySelector('legend')?.textContent);
  if (legend) said.push(legend);

  const group = input.closest('[role="group"], [role="radiogroup"]');
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
    // Scoped to this field's own root: ids inside a component are not in the
    // document's id map, so Workday-style labelling breaks there otherwise.
    .map((id) => rootOf(element).getElementById?.(id)?.textContent
      ?? rootOf(element).querySelector(`#${CSS.escape(id)}`)?.textContent
      ?? '')
    .join(' ');
  return clean(text);
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
function labelWords(el) {
  if (!el) return '';
  const parts = [];
  const walk = (node) => {
    for (const child of node.childNodes) {
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

function labelFor(input) {
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

  const described = fromLabelledBy(input);
  if (described) return described;

  const aria = clean(input.getAttribute('aria-label'));
  if (aria) return aria;

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
  let node = input.previousElementSibling;
  for (let i = 0; i < 3 && node; i++, node = node.previousElementSibling) {
    if (node.matches?.(ANOTHER_FIELD) || node.querySelector?.(ANOTHER_FIELD)) break;
    const text = clean(node.textContent);
    if (text && text.length < 160) return text;
  }

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
  let group = input.parentElement;
  for (let i = 0; i < 4 && group; i++, group = group.parentElement) {
    if (group.querySelectorAll(ANOTHER_FIELD).length !== 1) break;
    const heading = group.querySelector('label,legend,th,.label,[class*="label"]');
    if (heading && !heading.contains(input)) return clean(heading.textContent);
  }
  return '';
}

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
 *         input[name="urls[LinkedIn]"] wanted "linkedin.com/in/jianwen", got ""
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
  const role = element.getAttribute?.('role');
  return (
    role === 'combobox' ||
    role === 'listbox' ||
    element.getAttribute?.('aria-haspopup') === 'listbox' ||
    ['list', 'both'].includes(element.getAttribute?.('aria-autocomplete'))
  );
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
  if (input.type === 'hidden' || input.type === 'file' || input.type === 'password') return false;
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
  // `offsetParent` is null for anything positioned fixed, visible or not, and
  // forms inside a fixed modal are ordinary. Whether it occupies space on the
  // page is the question actually being asked.
  if (input.getClientRects().length === 0) return false;
  return true;
}

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
function setValue(input, value) {
  nativeSet(input, 'value', value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
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

function onlyTheStartOfAnAddress(value) {
  return /^\s*(https?:\/\/)?(www\.)?((linkedin\.com(\/in)?|github\.com)\/?)?\s*$/i.test(value) && /\S/.test(value);
}

function otherWaysToWrite(key, value) {
  const said = String(value).trim();

  /*
   * A link, with the scheme a `type=url` field insists on.
   *
   * A profile stores "github.com/Jianwen-Ding", because that is what goes on
   * a resume — nobody prints the https://. A `type=url` input refuses it, and
   * before this the field was filled, reported as filled, and then blocked the
   * submit. Adding the scheme does not change where the link goes.
   */
  if (LINKS.has(key)) {
    return /^[a-z][a-z0-9+.-]*:/i.test(said) ? [] : [`https://${said}`];
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

function sectionBoxOf(heading) {
  let box = heading.parentElement;
  while (box && !box.querySelector(A_CONTROL)) box = box.parentElement;
  if (!box || box.localName === 'form' || box.localName === 'body' || box.localName === 'html') return null;
  const rank = rankOf(heading);
  for (const other of box.querySelectorAll(HEADING)) {
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
function headingOver(input) {
  const scope = input.closest?.('form') ?? null;
  if (!scope) return null;
  let found = null;
  for (const heading of scope.querySelectorAll(HEADING)) {
    if (!(heading.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    if (heading.localName === 'legend') {
      if (heading.parentElement?.contains(input)) found = { heading, bounded: false };
      continue;
    }
    const box = sectionBoxOf(heading);
    if (box && !box.contains(input)) continue;
    found = { heading, bounded: Boolean(box) };
  }
  return found;
}

function sectionOf(input) {
  const legend = input.closest?.('fieldset')?.querySelector(':scope > legend');
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
  if (!key || !EDUCATION_SECTION.test(sectionOf(input))) return null;
  return key;
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
function sameAnswerSpelledOtherwise(key, option, value) {
  /*
   * A degree against a list of levels, which is what Greenhouse asks with:
   * "Associate's Degree", "Bachelor's Degree", "Master's Degree". The store
   * words the degree as the diploma does, so nothing matched and the box was
   * left empty on every Greenhouse form.
   */
  if (key === 'degree') {
    const level = degreeLevel(value);
    return Boolean(level) && LEVEL_ONLY.test(clean(option).replace(/[’]/g, "'")) && degreeLevel(option) === level;
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
];

function countriesIn(text) {
  const said = String(text ?? '');
  const out = new Set();
  for (const [code, short, name] of COUNTRIES) {
    if (short?.test(said) || name.test(said)) out.add(code);
  }
  return out;
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
function statementKind(text) {
  const said = clean(text).toLowerCase();
  if (/\bnot\s+(?:legally\s+)?authori[sz]ed\b/.test(said)) return 'not-authorized';
  if (/\b(?:require|need)s?\b[^.]*\bsponsor/.test(said)) return /\b(?:not|no|without|never)\b/.test(said) ? 'any-employer' : 'needs-sponsorship';
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

function withCityAndState(fields) {
  if (fields.city_state || !fields.address_city) return fields;
  const both = fields.address_state ? `${fields.address_city}, ${fields.address_state}` : fields.address_city;
  return { ...fields, city_state: both };
}

export function fillForm(fields, { overwrite = false, remembered = [], history = [] } = {}) {
  fields = withCityAndState(fields);
  const filled = [];
  const skipped = [];
  // A new pass: what an earlier one pressed has been drawn, or was refused.
  pressedNow = new WeakSet();

  const inputs = deepQueryAll('input, textarea, select');
  for (const input of inputs) {
    if (!isFillable(input)) continue;

    const description = describeField(input);
    if (!description) continue;
    // Somebody else's details, or a question this profile does not answer —
    // see `NOT_ABOUT_YOU`. Not reported: there is nothing here for the user to
    // do about it, and naming it would imply the field is theirs to fill.
    // Before the exclusions, which say nothing, and before the match, which
    // this question does not need. See `handBack`.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description, clean(labelFor(input)), surroundingWords(input), boundedSection(input))) continue;
    if (asksForWriting(input)) continue;

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
    let match = named && fields[named[0]] ? named : undefined;

    if (!match && fields.full_name && BARE_NAME.test(withoutMarkers(labelFor(input)))) {
      match = ['full_name'];
    }
    if (!match) {
      const half = nameHalf(input);
      if (half && fields[half]) match = [half];
    }
    if (!match) continue;

    const key = wholeDateKey(input, match[0], description);
    if (!fields[key]) continue;
    // A box for the answer a list above it did not have. See `NOT_LISTED`.
    if (!(input instanceof HTMLSelectElement) && NOT_LISTED.test(description)) continue;
    if (anotherLevelOfStudy(input, key, fields)) continue;
    if (asksYesOrNo(input, key)) continue;
    let value = fields[key];

    const answered =
      input instanceof HTMLSelectElement
        ? selectIsAnswered(input)
        : Boolean(input.value) &&
          !(LINKS.has(key) && onlyTheStartOfAnAddress(input.value)) &&
          !(key === 'phone' && ONLY_A_DIALLING_CODE.test(input.value));
    if (answered && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }
    // The dialling code the form put there stays, in front of a number that
    // does not carry one of its own.
    if (key === 'phone' && ONLY_A_DIALLING_CODE.test(input.value) && !/^\s*\+/.test(String(value))) {
      value = `${input.value.trim()} ${String(value).trim()}`;
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
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
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
    const digits = (v) => String(v).replace(/\D/g, '');
    const sameNumber = /phone/.test(key) && digits(value).length >= 7 && digits(input.value) === digits(value);
    if (input.value !== String(value) && !sameNumber) {
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
  // And the jobs on the resume, into the blocks a work history is asked in.
  const work = fillWorkHistory(history, { overwrite });
  const done = [...filled, ...radios.filled, ...buttons.filled, ...memory.filled, ...work.filled];

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
    skipped: [...waiting, ...memory.skipped, ...work.skipped, ...unfillableChoices(fields, done)],
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
  for (let at = input.parentElement, n = 0; at && n < 8; at = at.parentElement, n++) {
    if (!at.matches('[role="group"], fieldset, section')) continue;
    const named =
      clean(at.getAttribute('aria-label')) ||
      clean(fromLabelledBy(at)) ||
      clean(at.querySelector(':scope > legend, :scope > h2, :scope > h3, :scope > h4, :scope > h5')?.textContent);
    if (WORK_HISTORY.test(named)) return true;
  }
  return WORK_HISTORY.test(boundedSection(input));
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
function dateHalfOf(input) {
  for (let at = input.parentElement, n = 0; at && n < 4; at = at.parentElement, n++) {
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
  if (!Array.isArray(history) || history.length === 0) return { filled, skipped };

  const blocks = [];
  let block = null;
  for (const input of deepQueryAll('input, textarea')) {
    const found = jobPartOf(input);
    if (!found) continue;
    const usable = found.part === 'current' ? !isDisabled(input) && input.getClientRects().length > 0 : isFillable(input);
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
    fillJob(b, history[index], overwrite, filled, skipped);
  }
  return { filled, skipped };
}

function fillJob(block, job, overwrite, filled, skipped) {
  const put = (slot, key, value) => {
    const input = block.get(slot);
    if (!input || value === undefined || value === null || value === '') return;
    if (input.value && !overwrite) return;
    const written = slot === 'start' || slot === 'end' ? graduationFor(input, value) : String(value);
    setValue(input, written);
    if (input.value === written) filled.push({ key, value: written.slice(0, 80) });
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
function ariaChoiceGroups() {
  const visible = (el) => el.getClientRects().length > 0;
  const found = [];

  for (const group of deepQueryAll('[role="radiogroup"], [role="listbox"], [role="group"]')) {
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

    const options = [...group.querySelectorAll('[role="radio"], [role="option"]')].filter(
      (el) => visible(el) && !isDisabled(el),
    );
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
    const labelOf = (el) => clean(el.getAttribute('aria-label') || el.textContent);
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

  const legend = clean(group.closest('fieldset')?.querySelector('legend')?.textContent);
  if (legend) return legend;

  const header = clean(group.closest('tr')?.querySelector('th')?.textContent);
  if (header) return header;

  /*
   * And failing all of that, the text immediately above it — bounded, because
   * an unbounded climb reaches the whole form and reads every other question
   * as part of this one.
   */
  for (let at = group.parentElement, up = 0; at && up < 3; at = at.parentElement, up++) {
    const heading = clean(at.querySelector('label, legend, h1, h2, h3, h4, h5, h6, .label')?.textContent);
    if (heading) return heading;
  }
  return '';
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
function groupLabelFor(radios) {
  const first = radios[0];
  const legend = clean(first.closest('fieldset')?.querySelector('legend')?.textContent);
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
  const header = clean(first.closest('tr')?.querySelector('th')?.textContent);
  if (header) return header;

  let group = first.parentElement;
  for (let i = 0; i < 5 && group; i++, group = group.parentElement) {
    if (!radios.every((radio) => group.contains(radio))) continue;
    // Another field in here means this is the form, not this question.
    if (group.querySelectorAll('input:not([type=radio]):not([type=hidden]), textarea, select').length > 0) break;
    const headings = [...group.querySelectorAll('label,legend,.label,[class*="label"]')].filter(
      (el) => !el.querySelector('input, textarea, select'),
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
    const shared = [...group.querySelectorAll('input[type=radio]')].some((el) => !radios.includes(el));
    const heading = shared
      ? headings.filter((el) => el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      : headings[0];
    if (heading) return clean(heading.textContent);
  }
  return '';
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
function optionLabelFor(radio) {
  const wrapping = radio.closest('label');
  if (wrapping) return clean(wrapping.textContent);
  if (radio.id) {
    const label = rootOf(radio).querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label) return clean(label.textContent);
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
  const formKeys = new WeakMap();
  let nextForm = 0;
  const scopeOf = (radio) => {
    const form = radio.form;
    if (!form) return 'doc';
    if (!formKeys.has(form)) formKeys.set(form, `f${nextForm++}`);
    return formKeys.get(form);
  };

  const groups = new Map();
  for (const radio of deepQueryAll('input[type=radio]')) {
    if (isDisabled(radio) || !onScreen(radio)) continue;
    const key = radio.name ? `${scopeOf(radio)}\u0000${radio.name}` : radio.closest('fieldset');
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
      wanted.dispatchEvent(new Event('input', { bubbles: true }));
      wanted.dispatchEvent(new Event('change', { bubbles: true }));
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
 * - Nothing personal, even if the bank holds it. `worthRemembering` keeps
 *   these out on the way in, but the bank is older than that gate and the
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

  const bank = new Map();
  for (const { question, answer } of remembered) {
    const asked = clean(question);
    if (asked && String(answer ?? '').trim()) bank.set(asked, String(answer).trim());
  }
  if (bank.size === 0) return { filled, skipped };

  for (const choice of rememberableChoices()) {
    if (choice.answered()) continue;
    if (neverRemember(choice.question) || dependsOnEmployer(choice.question)) continue;
    const answer = bank.get(choice.question);
    if (!answer) continue;

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

/** Whether an ARIA option is the one marked as chosen. */
const isMarkedChosen = (el) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

/** Pick an option in a native `<select>` by its text or its value. */
function chooseInSelect(select, answer) {
  const choosable = [...select.options].filter((o) => !isDisabled(o));
  const option = choosable.find((o) => sameOption(o.textContent, answer) || sameOption(o.value, answer));
  if (!option) return false;
  nativeSet(select, 'value', option.value);
  // Two options can share a value, so the write can land on the placeholder.
  // The same read-back `fillForm` does, and for the same reason.
  if (select.selectedOptions[0] !== option) return false;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
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
    wanted.dispatchEvent(new Event('input', { bubbles: true }));
    wanted.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return wanted.checked;
}

/** Click an ARIA option by its label, and believe the page about the result. */
function chooseInAria(options, answer) {
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.textContent);
  const wanted = options.find((el) => sameOption(labelOf(el), answer));
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
function widgetChoices(fields, filled) {
  const already = new Set(filled.map((f) => f.key));
  const found = [];

  for (const widget of deepQueryAll(
    '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"]',
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
    if (widgetShowsAnAnswer(widget)) {
      already.add(key);
      continue;
    }
    if (anotherLevelOfStudy(widget, key, fields)) continue;
    // Named, so it is reported for what it is and never driven: Workday's
    // list picks "Yes" by its text too. See `aboutAnotherCountry`.
    const elsewhere = aboutAnotherCountry(key, fields[key], description, fields.address_country);
    found.push({ key, description: description.slice(0, 60), asked: description, el: widget, elsewhere });
    already.add(key);
  }
  return found;
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

/**
 * The options this widget opened — and only this widget's.
 *
 * The listbox it names through `aria-controls` or `aria-owns`, which is how an
 * accessible widget says which popup is its own. Failing that, the listbox
 * that is visible, but only if exactly one is: two open listboxes and no
 * pointer to either is a page where choosing is a guess about which one
 * answers this question, and guessing is what this does not do.
 */
/** The listboxes showing on the page right now. */
function visibleListboxes() {
  return deepQueryAll('[role="listbox"]').filter(
    /*
     * `visibility: hidden` keeps a box, so a closed menu that an exit
     * transition leaves mounted counted as open — and as a second listbox
     * it refused every unlinked widget on the page.
     */
    (l) => l.getClientRects().length > 0 && getComputedStyle(l).visibility !== 'hidden',
  );
}

function optionsOf(widget, openBefore = null) {
  const box = typingBoxOf(widget);
  const ids = [widget, box]
    .filter(Boolean)
    .flatMap((el) => `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/))
    .filter(Boolean);
  /*
   * Each list once. A react-select's typing box is the widget itself, so the
   * one `aria-controls` was read twice and every option listed twice — which
   * "the first that matches" never noticed, and "the only one that matches"
   * did: Boston, Massachusetts was two Bostons and neither was chosen.
   */
  const named = [...new Set(ids.map((id) => widget.getRootNode().getElementById?.(id) ?? document.getElementById(id)).filter(Boolean))];
  const showing = visibleListboxes().filter((l) => l !== widget);
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
  const lists = named.length ? named : fresh.length ? fresh : showing;
  if (!named.length && lists.length !== 1) return [];
  return lists.flatMap((l) => [...l.querySelectorAll('[role="option"]')]).filter((o) => !isDisabled(o) && o.getAttribute('aria-disabled') !== 'true');
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

/** A click as a person makes one — some widgets choose on mousedown, some on click. */
function press(el) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
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
  if (option.isConnected && option.getAttribute('aria-selected') === 'true') return true;
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
  const control = controlOf(widget).cloneNode(true);
  for (const list of control.querySelectorAll('[role="listbox"]')) list.remove();
  /*
   * The value, or the option it was matched to. "VA" chooses "Virginia", and
   * a dropdown showing "Virginia" does not contain the letters "VA" — so a
   * state chosen correctly was read as ignored and reported as still to pick.
   */
  const text = clean(control.textContent).toLowerCase();
  const shows = [value, chosen].some((said) => clean(said) && text.includes(clean(said).toLowerCase()));
  /*
   * Or a part of the option it did not show before. Greenhouse's country
   * beside the phone, chosen as "United States +1", draws "+1" and nothing
   * else, so a choice that had plainly taken was reported as still to pick.
   */
  const part = text.length >= 2 && text !== shownBefore && clean(chosen).toLowerCase().includes(text);
  return (shows || part) && (!box || !box.value);
}

/**
 * What a widget that draws its own value is showing as chosen: the text of
 * its single value or its chips, `''` where it draws none yet — only its
 * placeholder, or nothing — and `undefined` for a widget that is not drawn
 * this way at all, which `tookIt` then reads as it always has.
 */
const DRAWN_VALUE = '[class*="single-value"], [class*="singleValue"], [class*="multi-value__label"], [class*="multiValueLabel"]';
const DRAWS_ITS_VALUE = `${DRAWN_VALUE}, [class*="value-container"], [class*="ValueContainer"], [class*="__placeholder"]`;

function drawnValue(control) {
  if (!control?.querySelector?.(DRAWS_ITS_VALUE)) return undefined;
  return clean([...control.querySelectorAll(DRAWN_VALUE)].map((el) => el.textContent).join(' '));
}

/*
 * What a dropdown says while nothing is chosen.
 */
const NOTHING_CHOSEN = /^(?:select|choose|pick|search)\b|^please\s+(?:select|choose)\b|^-+|^none\s+selected$|^…$/i;

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
  return around.querySelector?.(':scope > input[type="hidden"]') ?? null;
}

/** Whether pressing this would send its form. */
function wouldSubmit(el) {
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && Boolean(el.form);
  if (el instanceof HTMLInputElement) return ['submit', 'image'].includes(el.type) && Boolean(el.form);
  return false;
}

/** Put the widget back as it was: nothing typed, nothing open. */
function undoWidget(widget, box) {
  if (box) setValue(box, '');
  (box ?? widget).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  (box ?? widget).blur?.();
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
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true }));
    setValue(box, typed);
    box.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', bubbles: true }));
    const drawn = () =>
      [...hidden.parentElement.querySelectorAll('[role="option"], [class*="location"]:not(input), [class*="suggestion"]')].filter(
        (el) => el.childElementCount === 0 && el.getClientRects().length > 0,
      );
    const option = await waitFor(() => placeOption(drawn(), fields), 3000);
    if (option) press(option);
    await pause(60);
  }
}

export async function fillComboboxes(fields, report, { patience = 4000 } = {}) {
  // What `fillForm` pressed, now that the page has had its turn to draw it.
  report = await seePresses(report);
  // The same fields `fillForm` read, or a widget it named `city_state` has
  // no value here.
  fields = withCityAndState(fields);
  await pickListedPlaces(fields);
  const pending = new Set(report.skipped.filter((s) => s.reason === PICK_BY_HAND).map((s) => s.key));
  // The lists that were looked in and did not have the answer. See `NOT_LISTED`.
  const unlisted = new Set(report.skipped.filter((s) => s.reason === 'no matching option').map((s) => s.key));
  if (pending.size === 0) {
    const also = fillNotListed(fields, unlisted);
    return also.length ? { ...report, filled: [...report.filled, ...also] } : report;
  }

  const done = [];
  for (const { key, el: widget, both, elsewhere, asked } of widgetChoices(fields, report.filled)) {
    if (both || elsewhere || !pending.has(key)) continue;
    const value = String(fields[key]);
    const how = await chooseInWidget(widget, key, value, { patience, fields, asked });
    // Looked for in a list that opened, and not in it. See `NOT_LISTED`.
    if (how === 'unlisted') unlisted.add(key);
    if (how === 'chose') done.push({ key, value, widget: true });
  }

  const chose = new Set(done.map((d) => d.key));
  return {
    ...report,
    filled: [...report.filled, ...done, ...fillNotListed(fields, unlisted)],
    skipped: report.skipped.filter((s) => !(s.reason === PICK_BY_HAND && chose.has(s.key))),
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
async function chooseInWidget(widget, key, value, { patience, fields, asked }) {
  const box = typingBoxOf(widget);
  const hiddenBefore = hiddenPartner(widget)?.value ?? '';
  const shownBefore = clean(controlOf(widget).textContent).toLowerCase();

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

  widget.focus?.();
  const openBefore = new Set(visibleListboxes());
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
      option = await waitForOption(widget, key, value, openBefore, { patience, fields, asked });
    }
  } else {
    press(widget);
    option = await waitForOption(widget, key, value, openBefore, { patience, fields, asked });
  }
  if (!option) {
    const opened = menuIsOpen(widget, box, openBefore);
    undoWidget(widget, box);
    return opened ? 'unlisted' : 'missed';
  }
  // Read before the press: a menu that closes takes its options with it.
  const chosen = option.textContent;
  press(option);
  await pause(60);
  if (!tookIt(widget, box, option, value, hiddenBefore, chosen, shownBefore)) {
    undoWidget(widget, box);
    return 'ignored';
  }
  return 'chose';
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
  for (const control of box.querySelectorAll(SECTION_CONTROLS)) {
    if (isDisabled(control) || control.getClientRects().length === 0) continue;
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
    nativeSet(control, 'value', option.value);
    if (control.selectedOptions[0] !== option) return { key, reason: 'the field would not take it', description: description.slice(0, 60) };
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return { key, value };
  }
  // A box: the date written the way it wants it, as `fillForm` writes one.
  let written = String(value);
  if (key.startsWith('graduation_') && control.type === 'month' && f.graduation_date) written = graduationFor(control, f.graduation_date);
  else if (key.startsWith('education_start_') && control.type === 'month' && f.education_start_date) written = graduationFor(control, f.education_start_date);
  else if (key === 'graduation_date' || key === 'education_start_date') written = graduationFor(control, written);
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
      const option = control.selectedOptions?.[0];
      if (!option || looksLikePlaceholder(option, control)) return null;
      return { question: clean(questionFor(control)), answer: clean(option.textContent) };
    }
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      if (!control.checked) return null;
      const group = [...deepQueryAll('input[type=radio]')].filter(
        (r) => r.name === control.name && r.form === control.form,
      );
      return {
        question: clean(groupLabelFor(group.length ? group : [control])),
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
    const option = control?.closest?.('[role="radio"], [role="option"]');
    if (option) {
      const group = option.closest('[role="radiogroup"], [role="listbox"], [role="group"]');
      if (!group) return null;
      return {
        question: choiceQuestionFor(group),
        answer: clean(option.getAttribute('aria-label') || option.textContent),
      };
    }
    return null;
  };

  const look = (event) => {
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
  return () => {
    watching = false;
    document.removeEventListener('change', look, true);
    document.removeEventListener('click', look, true);
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

  // The label actually associated with this field.
  const own =
    (field.id && rootOf(field).querySelector(`label[for="${CSS.escape(field.id)}"]`)) ||
    field.closest('label');
  if (own) return marked(own.textContent);

  let group = field.parentElement;
  for (let i = 0; i < 3 && group; i++, group = group.parentElement) {
    if (group.querySelectorAll(ANOTHER_FIELD).length > 1) break;
    const label = group.querySelector('label,legend');
    if (label) return marked(label.textContent);
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
function takenOver(field) {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) return null;
  let node = field;
  for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
    const before = node.previousElementSibling;
    if (before instanceof HTMLTextAreaElement && before.getClientRects().length === 0) return before;
    const around = node.parentElement;
    const others = [...(around?.querySelectorAll('textarea, [contenteditable="true"]') ?? [])].filter(
      (f) => f !== field && !f.contains(field) && !field.contains(f),
    );
    if (!around || others.length > 0) return null;
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
