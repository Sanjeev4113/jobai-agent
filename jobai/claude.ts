/**
 * JobAI's Claude calls.
 *  - screen():  Claude Haiku 5.5, cheap first pass over every new job (fit 0–100 + one line).
 *  - assess():  Claude Opus 5.5, the deep judgement for shortlisted jobs: fit, reasons, gaps, required info,
 *               a cover note and ready-to-paste answers.
 *  - tailor():  Claude Opus 5.5 rewrites the resume LaTeX for one job, keeping the template byte-for-byte outside
 *               the content, and never adding facts that aren't in the fact sheet.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CANDIDATE, TARGET_ROLES, factSheet } from "./profile";
import { chatJson, claudeFailed, claudeUsable, streamChat } from "../src/lib/llm/free";
import type { Job } from "./sources";

/** A model is always available: Claude when it has credit, otherwise the free chain (Groq → Gemini → OpenRouter → Pollinations). */
export const hasClaude = () => true;
export const modelName = () => (claudeUsable() ? "Claude Opus 5.5" : "free models");

/**
 * Structured output: Claude's validated JSON when usable, otherwise a free model asked for the same JSON Schema
 * and validated with the same Zod schema.
 */
async function structured<T>(o: { schema: z.ZodType<T>; system: string; user: string; maxTokens: number; model?: string; effort?: "low" | "medium" | "high"; task?: "chat" | "long" }): Promise<T | null> {
  if (claudeUsable()) {
    try {
      const res = await client().messages.parse({
        model: o.model ?? BEST,
        max_tokens: o.maxTokens,
        output_config: { effort: o.effort ?? "medium", format: zodOutputFormat(o.schema) },
        system: o.system,
        messages: [{ role: "user", content: o.user }],
      });
      return (res.parsed_output as T | null) ?? null;
    } catch (e) {
      claudeFailed(e);
    }
  }
  return chatJson<T>({
    system: o.system,
    user: o.user,
    schema: z.toJSONSchema(o.schema),
    parse: (x) => {
      const r = o.schema.safeParse(x);
      return r.success ? { success: true, data: r.data } : { success: false, error: { message: r.error.message } };
    },
    maxTokens: Math.min(o.maxTokens, 12000),
    task: o.task,
  });
}
let _client: Anthropic | null = null;
const client = () => (_client ??= new Anthropic());

const BEST = "claude-opus-5-5";
const FAST = "claude-haiku-5-5";

/* ---------- screen ---------- */

const Screen = z.object({ results: z.array(z.object({ id: z.string(), fit: z.number().int().min(0).max(100), why: z.string() })) });

export async function screen(jobs: Job[]) {
  const out = new Map<string, { fit: number; why: string }>();
  for (let i = 0; i < jobs.length; i += 25) {
    const batch = jobs.slice(i, i + 25);
    const list = batch.map((j) => `ID ${j.id}\nTITLE ${j.title} @ ${j.company} (${j.location}${j.remote ? ", remote" : ""})\n${j.description.slice(0, 1500)}`).join("\n\n---\n\n");
    const res = await structured({
      schema: Screen,
      model: FAST,
      maxTokens: 6000,
      effort: "low",
      system: `You screen job postings for one candidate. Score each job's fit 0-100 for THIS candidate (skills, seniority, role type), and give one short reason. Be strict: 80+ only when the core stack and level match.
Target roles: ${TARGET_ROLES.join("; ")}.
Seniority: ${CANDIDATE.seniority}
Location: ${CANDIDATE.openTo}`,
      user: `CANDIDATE\n${factSheet()}\n\nJOBS\n${list}`,
    }).catch(() => null);
    for (const r of res?.results ?? []) out.set(r.id, { fit: r.fit, why: r.why });
  }
  return out;
}

/* ---------- assess ---------- */

const Assess = z.object({
  fit: z.number().int().min(0).max(100),
  verdict: z.enum(["apply", "stretch", "skip"]),
  why: z.string(),
  gaps: z.array(z.string()),
  requiredInfo: z.array(z.string()),
  coverNote: z.string(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type Assessment = z.infer<typeof Assess>;

export async function assess(job: Job): Promise<Assessment | null> {
  return structured({
    schema: Assess,
    maxTokens: 8000,
    effort: "medium",
    system: `You are a meticulous career coach preparing a job application for one candidate. Use ONLY the candidate facts given; never invent experience, numbers, tools or credentials.
Return:
- fit (0-100) and verdict: apply (strong match), stretch (worth applying, some gaps), skip.
- why: 2-3 sentences mapping the job's key requirements to concrete evidence.
- gaps: requirements the candidate doesn't clearly meet.
- requiredInfo: things the application will demand that are NOT in the facts and must come from the candidate (for example CGPA/GPA if the posting requires it, visa or work authorisation, security clearance, a minimum years figure he may not meet, relocation). Empty if none.
- coverNote: under 150 words, specific to this company and role, first person, no clichés.
- answers: ready-to-paste answers to the screening questions this posting is likely to ask (why this company, relevant experience, a project you're proud of), each under 90 words.`,
    user: `CANDIDATE\n${factSheet()}\n\nJOB: ${job.title} at ${job.company} (${job.location}${job.remote ? ", remote" : ""})\nURL: ${job.url}\n\n${job.description.slice(0, 12000)}`,
  });
}

/* ---------- tailor ---------- */

const Tailored = z.object({ tex: z.string(), changes: z.array(z.string()) });

/** Everything that defines the template, with the content stripped: preamble + the order of sections and environments. */
export function skeleton(tex: string) {
  const i = tex.indexOf("\\begin{document}");
  const preamble = i >= 0 ? tex.slice(0, i).replace(/\s+/g, " ").trim() : "";
  const body = i >= 0 ? tex.slice(i) : tex;
  const structure = [...body.matchAll(/\\(section\*?|begin\{[^}]+\}|end\{[^}]+\})/g)].map((m) => m[1]);
  // section titles must stay the same (content inside them may change)
  const sections = [...body.matchAll(/\\section\*?\{([^}]*)\}/g)].map((m) => m[1].trim());
  return { preamble, structure, sections };
}

export function sameTemplate(a: string, b: string) {
  const x = skeleton(a);
  const y = skeleton(b);
  if (x.preamble !== y.preamble) return "the preamble (template, packages, macros) changed";
  if (x.sections.join("|") !== y.sections.join("|")) return "section titles or their order changed";
  const outer = (s: string[]) => s.filter((t) => !/itemize|enumerate/.test(t)).join("|");
  if (outer(x.structure) !== outer(y.structure)) return "the document structure changed";
  return null;
}

export async function tailor(baseTex: string, job: Job, assessment?: Assessment | null) {
  const ask = async (extra = "") => {
    if (!claudeUsable()) return tailorFree(baseTex, job, assessment, extra);
    return structured({
      schema: Tailored,
      maxTokens: 32000,
      effort: "high",
      task: "long",
      system: `You tailor a LaTeX resume to one job description.
HARD RULES
1. Keep the template exactly: do not change anything before \\begin{document}, any macro or command definition, section titles, section order, or the layout commands. Only edit the human-readable text inside existing entries.
2. Truth: use only facts present in the base resume or the candidate fact sheet. You may reword, reorder bullets and skills, and emphasise what matches the job. Never invent tools, metrics, employers, titles, dates or achievements. If the job wants something the candidate lacks, leave it out.
3. Mirror the job's language where it is truthful (same terms for the same technologies), so ATS keyword matching works.
4. Keep it to the same length (one page if the base is one page): if you add, trim elsewhere.
5. Output valid LaTeX that compiles with the same template. Escape special characters (& % $ # _ { } ~ ^ \\).
Return the full .tex and a short list of what you changed.${extra}`,
      user: `CANDIDATE FACTS\n${factSheet()}\n\nJOB: ${job.title} at ${job.company}\n${job.description.slice(0, 12000)}\n${assessment ? `\nFIT NOTES: ${assessment.why}\nGAPS (do not paper over): ${assessment.gaps.join("; ")}` : ""}\n\nBASE RESUME (.tex)\n${baseTex}`,
    });
  };
  let out = await ask();
  let problem = out ? sameTemplate(baseTex, out.tex) : "no output";
  if (problem) {
    out = await ask(`\nYour previous attempt was rejected because ${problem}. Start again from the base resume and change only text content.`);
    problem = out ? sameTemplate(baseTex, out.tex) : "no output";
  }
  if (!out || problem) return { ok: false as const, error: problem ?? "no output" };
  return { ok: true as const, tex: out.tex, changes: out.changes };
}

/** Free models: the LaTeX comes back raw between markers (JSON-escaping a whole .tex file trips small models up). */
async function tailorFree(baseTex: string, job: Job, assessment: Assessment | null | undefined, extra: string) {
  const { text } = await streamChat({
    task: "long",
    sensitive: true, // the resume holds his phone number
    maxTokens: 9000,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `You tailor a LaTeX resume to one job description.
RULES: keep everything before \\begin{document} byte-for-byte; keep every section title, section order, command and macro; only edit the human-readable text inside existing entries. Use only facts in the base resume or the candidate facts; never invent tools, metrics, employers or dates. Mirror the job's wording where truthful. Keep the same length (one page). Escape LaTeX special characters.${extra}
OUTPUT FORMAT, exactly:
<<<TEX
(the complete .tex file)
TEX>>>
<<<CHANGES
- one change per line
CHANGES>>>`,
      },
      {
        role: "user",
        content: `CANDIDATE FACTS\n${factSheet()}\n\nJOB: ${job.title} at ${job.company}\n${job.description.slice(0, 8000)}\n${assessment ? `\nFIT NOTES: ${assessment.why}\nGAPS (do not paper over): ${assessment.gaps.join("; ")}` : ""}\n\nBASE RESUME (.tex)\n${baseTex}`,
      },
    ],
  });
  const tex = text.match(/<<<TEX\s*\n([\s\S]*?)\n?TEX>>>/)?.[1] ?? text.match(/(\\documentclass[\s\S]*\\end\{document\})/)?.[1];
  if (!tex) return null;
  const changes = (text.match(/<<<CHANGES\s*\n([\s\S]*?)CHANGES>>>/)?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);
  return { tex: tex.trim() + "\n", changes };
}

/* ---------- upskill ---------- */

const Plan = z.object({
  summary: z.string(),
  skills: z.array(z.object({ skill: z.string(), demand: z.string(), why: z.string(), plan: z.string(), resources: z.array(z.string()) })),
  thisWeek: z.array(z.string()),
});
export type UpskillPlan = z.infer<typeof Plan>;

export async function upskill(gaps: { skill: string; count: number }[], recentTitles: string[]) {
  return structured({
    schema: Plan,
    maxTokens: 8000,
    effort: "medium",
    system: `You are a career mentor for a software engineer targeting these roles: ${TARGET_ROLES.join("; ")}. Given the skills recent matching jobs asked for that he lacks (with counts), produce a focused upskilling plan: the 3-5 highest-leverage skills, why they matter for his targets, a concrete 2-4 week plan each, and free or reputable resources (official docs, well-known courses). Then 3-5 tasks for this week. Be specific and realistic for someone working full time.`,
    user: `CANDIDATE\n${factSheet()}\n\nGAPS FROM THE LAST 7 DAYS OF MATCHING JOBS\n${gaps.map((g) => `${g.skill} (${g.count})`).join("\n")}\n\nRECENT MATCHING TITLES\n${recentTitles.slice(0, 40).join("\n")}`,
  });
}
