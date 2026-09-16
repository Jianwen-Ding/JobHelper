/**
 * The trail rules, against the addresses real applicant tracking systems use.
 *
 * Every one of these systems gets you from a description to a form in its own
 * way — a path suffix, a query parameter, a fragment, a file with an extension,
 * a hand-off to another host — and the rules in `trail.js` were written against
 * a handful of them. This is the rest: the shapes of about thirty systems, each
 * asked the same two questions.
 *
 * Does the application hold together — do the pages of one application join?
 * And does it stay apart — does the job next to it on the same board, or the
 * listing that links to both, stay out? The second question is the one that
 * matters: a joined-up application that drops a page merely works less well,
 * while two applications joined together produce a cover letter addressed to
 * one company and written from another, and nothing about it looks wrong.
 *
 * The URLs are the real shapes, with identifiers replaced. They are not fetched
 * — this tests the judgement, which is the part that has been wrong.
 *
 *   node --test tests/ats.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sameApplication, wasExpected } from '../src/shared/trail.js';

/**
 * One system.
 *
 *   posting   where the description is
 *   steps     pages of the same application, in the order they are reached
 *   otherJob  a different posting on the same system — must never join
 *   listing   the page that links to both — must never join either
 *   handoff   a step on another host, reached by clicking Apply
 */
const SYSTEMS = [
  {
    name: 'Greenhouse',
    listing: 'https://boards.greenhouse.io/acme',
    posting: 'https://boards.greenhouse.io/acme/jobs/4012345',
    // The form is the same page; the anchor is the whole of the navigation.
    steps: ['https://boards.greenhouse.io/acme/jobs/4012345#app'],
    otherJob: 'https://boards.greenhouse.io/acme/jobs/4067890',
  },
  {
    name: 'Greenhouse (job-boards host)',
    listing: 'https://job-boards.greenhouse.io/acme',
    posting: 'https://job-boards.greenhouse.io/acme/jobs/4012345',
    steps: ['https://job-boards.greenhouse.io/acme/jobs/4012345#application'],
    otherJob: 'https://job-boards.greenhouse.io/acme/jobs/4067890',
  },
  {
    name: 'Greenhouse (embedded)',
    // Embedded boards put the whole identity in the query string.
    posting: 'https://boards.greenhouse.io/embed/job_app?token=4012345',
    steps: ['https://boards.greenhouse.io/embed/job_app?token=4012345&t=1699999999'],
    otherJob: 'https://boards.greenhouse.io/embed/job_app?token=4067890',
  },
  {
    name: 'Lever',
    listing: 'https://jobs.lever.co/acme',
    posting: 'https://jobs.lever.co/acme/8f21c3d4-9a1b-4c5d-8e2f-1a2b3c4d5e6f',
    steps: ['https://jobs.lever.co/acme/8f21c3d4-9a1b-4c5d-8e2f-1a2b3c4d5e6f/apply'],
    otherJob: 'https://jobs.lever.co/acme/7e10b2c3-8d9e-4f0a-9b1c-2d3e4f5a6b7c',
  },
  {
    name: 'Ashby',
    listing: 'https://jobs.ashbyhq.com/acme',
    posting: 'https://jobs.ashbyhq.com/acme/4c2e1f90-3b5a-4d6e-8f70-1a2b3c4d5e6f',
    steps: ['https://jobs.ashbyhq.com/acme/4c2e1f90-3b5a-4d6e-8f70-1a2b3c4d5e6f/application'],
    otherJob: 'https://jobs.ashbyhq.com/acme/9d3f2a81-4c6b-4e7f-9081-2b3c4d5e6f70',
  },
  {
    name: 'Workday',
    listing: 'https://acme.wd1.myworkdayjobs.com/en-US/External',
    posting: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Boston-MA/Platform-Engineer_R-12345',
    // Three steps, and the middle one is where the account is made.
    steps: [
      'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Boston-MA/Platform-Engineer_R-12345/apply',
      'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Boston-MA/Platform-Engineer_R-12345/apply/applyManually',
    ],
    otherJob: 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/Boston-MA/Data-Scientist_R-67890',
  },
  {
    name: 'iCIMS',
    listing: 'https://careers-acme.icims.com/jobs/search',
    posting: 'https://careers-acme.icims.com/jobs/4021/platform-engineer/job',
    steps: ['https://careers-acme.icims.com/jobs/4021/platform-engineer/job?mode=apply'],
    otherJob: 'https://careers-acme.icims.com/jobs/4098/data-scientist/job',
  },
  {
    name: 'Taleo',
    posting: 'https://acme.taleo.net/careersection/ex/jobdetail.ftl?job=12345',
    // A sibling file, not a sibling path: the extension is part of the name.
    steps: ['https://acme.taleo.net/careersection/ex/application.ftl?job=12345'],
    otherJob: 'https://acme.taleo.net/careersection/ex/jobdetail.ftl?job=67890',
  },
  {
    name: 'SmartRecruiters',
    listing: 'https://jobs.smartrecruiters.com/Acme',
    posting: 'https://jobs.smartrecruiters.com/Acme/744000012345678-platform-engineer',
    steps: ['https://jobs.smartrecruiters.com/Acme/744000012345678-platform-engineer/apply'],
    otherJob: 'https://jobs.smartrecruiters.com/Acme/744000087654321-data-scientist',
  },
  {
    name: 'Workable',
    listing: 'https://apply.workable.com/acme',
    posting: 'https://apply.workable.com/acme/j/A1B2C3D4E5',
    steps: ['https://apply.workable.com/acme/j/A1B2C3D4E5/apply'],
    otherJob: 'https://apply.workable.com/acme/j/F6G7H8I9J0',
  },
  {
    name: 'Jobvite',
    listing: 'https://jobs.jobvite.com/acme',
    posting: 'https://jobs.jobvite.com/acme/job/oX5zvfwR',
    steps: ['https://jobs.jobvite.com/acme/job/oX5zvfwR/apply'],
    otherJob: 'https://jobs.jobvite.com/acme/job/pY6awgxS',
  },
  {
    name: 'BambooHR',
    listing: 'https://acme.bamboohr.com/careers',
    // The form is a dialog over the posting; the address never changes.
    posting: 'https://acme.bamboohr.com/careers/42',
    steps: ['https://acme.bamboohr.com/careers/42?source=aWQ9MTIzNDU'],
    otherJob: 'https://acme.bamboohr.com/careers/97',
  },
  {
    name: 'Breezy',
    listing: 'https://acme.breezy.hr',
    posting: 'https://acme.breezy.hr/p/a1b2c3d4e5f6-platform-engineer',
    steps: ['https://acme.breezy.hr/p/a1b2c3d4e5f6-platform-engineer/apply'],
    otherJob: 'https://acme.breezy.hr/p/f6e5d4c3b2a1-data-scientist',
  },
  {
    name: 'Recruitee',
    listing: 'https://acme.recruitee.com',
    posting: 'https://acme.recruitee.com/o/platform-engineer',
    steps: ['https://acme.recruitee.com/o/platform-engineer/c/new'],
    otherJob: 'https://acme.recruitee.com/o/data-scientist',
  },
  {
    name: 'Teamtailor',
    listing: 'https://career.acme.com/jobs',
    posting: 'https://career.acme.com/jobs/1234567-platform-engineer',
    steps: ['https://career.acme.com/jobs/1234567-platform-engineer/applications/new'],
    otherJob: 'https://career.acme.com/jobs/7654321-data-scientist',
  },
  {
    name: 'JazzHR',
    posting: 'https://acme.applytojob.com/apply/AbCdEfGh/platform-engineer',
    steps: ['https://acme.applytojob.com/apply/AbCdEfGh/platform-engineer'],
    otherJob: 'https://acme.applytojob.com/apply/IjKlMnOp/data-scientist',
  },
  {
    name: 'SAP SuccessFactors',
    posting: 'https://career5.successfactors.eu/careers?company=acme&career_job_req_id=12345',
    steps: ['https://career5.successfactors.eu/careers?company=acme&career_job_req_id=12345&mode=apply'],
    otherJob: 'https://career5.successfactors.eu/careers?company=acme&career_job_req_id=67890',
  },
  {
    name: 'UKG Pro Recruiting',
    posting: 'https://recruiting2.ultipro.com/ACM1000ACME/JobBoard/1a2b3c/OpportunityDetail?opportunityId=9f8e7d6c',
    steps: [
      'https://recruiting2.ultipro.com/ACM1000ACME/JobBoard/1a2b3c/OpportunityDetail/Apply?opportunityId=9f8e7d6c',
    ],
    otherJob: 'https://recruiting2.ultipro.com/ACM1000ACME/JobBoard/1a2b3c/OpportunityDetail?opportunityId=1c2d3e4f',
  },
  {
    name: 'Personio',
    listing: 'https://acme.jobs.personio.de',
    posting: 'https://acme.jobs.personio.de/job/123456',
    steps: ['https://acme.jobs.personio.de/job/123456?display=en'],
    otherJob: 'https://acme.jobs.personio.de/job/654321',
  },
  {
    name: 'Rippling',
    listing: 'https://ats.rippling.com/acme/jobs',
    posting: 'https://ats.rippling.com/acme/jobs/1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071',
    steps: ['https://ats.rippling.com/acme/jobs/1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071/apply'],
    otherJob: 'https://ats.rippling.com/acme/jobs/7081920a-3b4c-4d5e-8f60-718293a4b5c6',
  },
  {
    name: 'Paylocity',
    posting: 'https://recruiting.paylocity.com/recruiting/jobs/Details/1234567/Acme/platform-engineer',
    // Apply is a sibling branch, not a suffix, so the click is the evidence.
    handoff: 'https://recruiting.paylocity.com/recruiting/jobs/Apply/1234567/Acme/platform-engineer',
    steps: [],
    otherJob: 'https://recruiting.paylocity.com/recruiting/jobs/Details/7654321/Acme/data-scientist',
  },
  {
    name: 'Dayforce',
    posting: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/12345',
    handoff: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/Apply/12345',
    steps: [],
    otherJob: 'https://acme.dayforcehcm.com/CandidatePortal/en-US/acme/Posting/View/67890',
  },
  {
    name: 'Indeed',
    posting: 'https://www.indeed.com/viewjob?jk=a1b2c3d4e5f60718',
    handoff: 'https://smartapply.indeed.com/beta/indeedapply/form/resume',
    steps: [],
    otherJob: 'https://www.indeed.com/viewjob?jk=1807f6e5d4c3b2a1',
  },
  {
    name: 'LinkedIn',
    listing: 'https://www.linkedin.com/jobs',
    posting: 'https://www.linkedin.com/jobs/view/3812345678',
    // Easy Apply is a dialog; the address does not change.
    steps: ['https://www.linkedin.com/jobs/view/3812345678'],
    otherJob: 'https://www.linkedin.com/jobs/view/3898765432',
  },
  {
    name: 'Glassdoor',
    posting: 'https://www.glassdoor.com/job-listing/platform-engineer-acme-JV_IC1154532_KO0,17.htm?jl=1008123456',
    steps: ['https://www.glassdoor.com/job-listing/platform-engineer-acme-JV_IC1154532_KO0,17.htm?jl=1008123456&src=GD_JOB_AD'],
    otherJob: 'https://www.glassdoor.com/job-listing/platform-engineer-acme-JV_IC1154532_KO0,17.htm?jl=1008987654',
  },
  {
    name: 'ZipRecruiter',
    posting: 'https://www.ziprecruiter.com/c/Acme/Job/Platform-Engineer/-in-Boston,MA?jid=a1b2c3d4',
    steps: ['https://www.ziprecruiter.com/c/Acme/Job/Platform-Engineer/-in-Boston,MA?jid=a1b2c3d4&lvk=xyz'],
    otherJob: 'https://www.ziprecruiter.com/c/Acme/Job/Data-Scientist/-in-Boston,MA?jid=d4c3b2a1',
  },
  {
    name: 'Wellfound',
    listing: 'https://wellfound.com/jobs',
    posting: 'https://wellfound.com/jobs/1234567-platform-engineer',
    steps: ['https://wellfound.com/jobs/1234567-platform-engineer/apply'],
    otherJob: 'https://wellfound.com/jobs/7654321-data-scientist',
  },
  {
    name: 'Handshake',
    listing: 'https://app.joinhandshake.com/jobs',
    posting: 'https://app.joinhandshake.com/jobs/7654321',
    handoff: 'https://app.joinhandshake.com/job-applications/new?job_id=7654321',
    steps: [],
    otherJob: 'https://app.joinhandshake.com/jobs/1234567',
  },
  {
    name: 'Dice',
    posting: 'https://www.dice.com/job-detail/1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071',
    // Apply is a different path entirely, so the click is the only evidence.
    handoff: 'https://www.dice.com/apply?id=1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071',
    steps: [],
    otherJob: 'https://www.dice.com/job-detail/7081920a-3b4c-4d5e-8f60-718293a4b5c6',
  },
  {
    name: 'Built In',
    listing: 'https://builtin.com/jobs',
    posting: 'https://builtin.com/job/platform-engineer/1234567',
    steps: ['https://builtin.com/job/platform-engineer/1234567/apply'],
    otherJob: 'https://builtin.com/job/data-scientist/7654321',
  },
];

/** A trail that has read the description, as the extension would have it. */
const trailFor = (system) => ({
  pages: [{ url: system.posting, company: 'Acme', title: 'Platform Engineer' }],
  at: Date.now(),
});

/** The same, after walking as far as `upTo`. */
const trailAfter = (system, upTo) => ({
  pages: [system.posting, ...system.steps.slice(0, upTo)].map((url) => ({
    url,
    company: 'Acme',
    title: 'Platform Engineer',
  })),
  at: Date.now(),
});

for (const system of SYSTEMS) {
  describe(system.name, () => {
    if (system.steps?.length) {
      it('keeps the application together across its own steps', () => {
        system.steps.forEach((step, i) => {
          assert.equal(
            sameApplication(trailAfter(system, i), { url: step, company: 'Acme' }),
            true,
            `step ${i + 1} (${step}) fell out of the application`,
          );
        });
      });
    }

    it('does not join the job next to it', () => {
      assert.equal(
        sameApplication(trailFor(system), { url: system.otherJob, company: 'Acme' }),
        false,
        `${system.otherJob} was taken for the same job as ${system.posting}`,
      );
    });

    if (system.listing) {
      it('does not join the listing that links to both', () => {
        assert.equal(
          sameApplication(trailFor(system), { url: system.listing, company: 'Acme' }),
          false,
          `${system.listing} was taken for part of the application`,
        );
      });
    }

    if (system.handoff) {
      it('follows the Apply click to wherever it goes', () => {
        const trail = { ...trailFor(system), expecting: { to: system.handoff, at: Date.now() } };
        assert.equal(sameApplication(trail, { url: system.handoff, company: 'Acme' }), true);
      });

      it('and the click does not then vouch for the job next to it', () => {
        const trail = { ...trailFor(system), expecting: { to: system.handoff, at: Date.now() } };
        assert.equal(wasExpected(trail, system.otherJob), false);
      });
    }
  });
}
