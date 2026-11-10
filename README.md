# JobAI

Sanjeev's private job-search agent. It runs every hour on GitHub Actions and emails sanjeevsudarsanam@gmail.com.

## What one run does

1. **Scan** the official public job boards of the companies in `jobai/sources.ts`, on Greenhouse, Lever, Ashby and SmartRecruiters. It also reads the Remotive and Arbeitnow remote boards, and Adzuna and Jooble when their free keys are set. About 8,000 openings a run. There's no scraping and no logins: LinkedIn, Naukri and Indeed forbid automation.
2. **Filter** to the target roles: backend Java and Spring, SDE and software engineer, full-stack TypeScript and MERN, SDET and QA automation, AI engineer, and DevOps. It drops senior, lead and manager roles and anything asking for 4+ years. It skips jobs it has already seen, and roles in India and remote roles rank first.
3. **Screen** every new role with **Claude Haiku 5.5**, which is cheap.
4. **Judge** the best matches with **Claude Opus 5.5**. Each one gets:
   - a fit score and verdict;
   - the evidence for the fit, and the gaps;
   - anything the application needs that only Sanjeev knows (CGPA, visa, notice period), marked **⚠ Needs you**;
   - a cover note and ready-to-paste answers.
5. **Tailor** the resume with Opus inside the exact Overleaf template, using only true facts from `src/content/profile.ts`. The output is rejected if the preamble, the section titles or the structure change. **Tectonic** compiles the PDF.
6. **Email** one digest with the tailored PDFs attached and an "Open & apply" link for each job. You review and submit, which takes about a minute per job.
7. At **08:00 IST** it also emails an **upskilling plan** built from the gaps in that week's matches.

## Setup

1. **Base resume:** put your Overleaf `main.tex` at `jobai/resume/base.tex`. For GitHub, store it as the secret `RESUME_TEX_B64` (`base64 -i jobai/resume/base.tex | pbcopy`).
2. **Claude:** get an API key at console.anthropic.com and add it as `ANTHROPIC_API_KEY`. Cost: about $0.10–0.15 per tailored resume on Opus, capped at 15 a day by default (`JOBAI_MAX_TAILOR_PER_DAY`). That's about $50–70 a month at the cap, plus well under $1 a month for Haiku screening.
3. **Gmail:**
   - Turn on 2-step verification, then create an app password at myaccount.google.com/apppasswords.
   - Add the secrets `GMAIL_USER` (your Gmail address) and `GMAIL_APP_PASSWORD` (the 16-character app password).
4. **Your application details:** copy `jobai/applicant.example.json`, fill it in and add it as the secret `APPLICANT_JSON`. Leave `cgpa` empty if you'd rather be asked each time.
5. **Optional, wider worldwide search:** free keys from developer.adzuna.com (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`) and jooble.org/api (`JOOBLE_API_KEY`).
6. **Turn it on:** the hourly agent lives in its own private repo, **jobai-agent** (generated from the portfolio with `node scripts/export-jobai.mjs`). Push that repo to GitHub; its workflow `.github/workflows/jobai.yml` runs hourly. Start the first run by hand from the Actions tab with "Run workflow".

## Local commands

- `npm run jobai -- --dry`: one run, printed instead of emailed. Reads keys from `.env.local`.
- `npm run resume -- jd.txt --company "Stripe" --title "Backend Engineer"`: tailor for one job description. It writes `jobai/out/resumes/manual/<company-role>/Sanjeev_Sudarsanam_Resume.tex`, the `.pdf` and `notes.md`. To read the job description from the clipboard: `pbpaste | npm run resume -- - --company …`.
- To build PDFs locally, install Tectonic: `brew install tectonic`.

## Dashboard

`/jobai` sits behind the vault login. It shows a setup checklist and a **Tailor my resume** tool: paste a job description and get the fit, a cover note and the tailored LaTeX, with **Open in Overleaf** (which renders the PDF) and **Download .tex**.

## Widening the net

To add companies, append their board names to `COMPANIES` in `jobai/sources.ts`. The name is the part of the careers URL after `boards.greenhouse.io/`, `jobs.lever.co/` or `jobs.ashbyhq.com/`, or the company id on SmartRecruiters.
