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
import { chatJson, claudeFailed, claudeUsable } from "../src/lib/llm/free";
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

/* ---------- tailoring by edits (free models) ----------
 * The model never rewrites the file. JobAI cuts the body into editable segments (the summary, each skills line, each
 * bullet), the model returns new text only for the segments worth changing, and the code splices them back. The template
 * can't break, the output is ~10× smaller (fast even on the local model), and every edit is checked before it's used. */

type Segment = { id: number; kind: "summary" | "skills" | "bullet"; start: number; end: number; text: string; label?: string };

/** Index just after the brace that closes the one opening at `open` (or -1). */
function closeBrace(s: string, open: number) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

export function segments(tex: string): Segment[] {
  const body = tex.indexOf("\\begin{document}");
  const out: Segment[] = [];
  const re = /\\resumeItem\{|\\small\{/g;
  re.lastIndex = body;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) {
    const open = m.index + m[0].length - 1;
    const close = closeBrace(tex, open);
    if (close < 0) break;
    const inner = tex.slice(open + 1, close);
    re.lastIndex = close;
    if (m[0].startsWith("\\resumeItem")) out.push({ id: out.length + 1, kind: "bullet", start: open + 1, end: close, text: inner.trim() });
    else {
      const lab = inner.match(/^\s*\\item\s*\\textbf\{([^}]*)\}/);
      if (lab) {
        const s0 = open + 1 + inner.indexOf(lab[0]) + lab[0].length;
        out.push({ id: out.length + 1, kind: "skills", start: s0, end: close, text: tex.slice(s0, close).trim(), label: lab[1] });
      } else if (!/\\(item|textbf\{[^}]*:\})/.test(inner) && inner.trim().length > 80 && !/begin\{|\\section/.test(inner)) out.push({ id: out.length + 1, kind: "summary", start: open + 1, end: close, text: inner.trim() });
    }
  }
  return out;
}

const Edits = z.object({ edits: z.array(z.object({ id: z.number().int(), text: z.string().min(1), why: z.string() })).max(40) });

/** LaTeX → plain text the model can't break: \textbf{x} → **x**, \% → %. null if the segment uses other commands. */
function toPlain(t: string): string | null {
  const p = t.replace(/\\textbf\{([^{}]*)\}/g, "**$1**").replace(/\\([%&$#_])/g, "$1");
  if (/\\/.test(p) || /[{}]/.test(p)) return null;
  return p.replace(/\s+/g, " ").trim();
}
/** plain text → LaTeX: escape specials, **x** → \textbf{x}. null if the model slipped LaTeX or braces in. */
function fromPlain(t: string): string | null {
  if (/[\\{}]/.test(t) || (t.match(/\*\*/g) ?? []).length % 2) return null;
  return t
    .replace(/[%&$#_]/g, (c) => `\\${c}`)
    .replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}")
    .replace(/\s+/g, " ")
    .trim();
}
const nums = (t: string) => t.match(/\d+(?:\.\d+)?/g) ?? [];

/** Everything a model needs to tailor by edits: the prompt and the JSON Schema of the answer (null: nothing editable). */
export function tailorPrompt(baseTex: string, job: Job, assessment: Assessment | null | undefined, extra = "") {
  const segs = segments(baseTex)
    .map((g) => ({ ...g, plain: toPlain(g.text) }))
    .filter((g): g is Segment & { plain: string } => !!g.plain);
  if (!segs.length) return null;
  const listing = segs.map((g) => `[${g.id}] (${g.kind}${g.label ? `: ${g.label.replace(/\\/g, "")}` : ""}) ${g.plain}`).join("\n");
  return {
    system: `You tailor a resume to one job by rewriting the text of a few numbered segments. Segments are plain text: **double asterisks** mark bold; never write LaTeX, backslashes or braces.
RULES
- Return only segments worth rewording (usually 3-8): the summary, and the bullets most relevant to this job, so they lead with what the job asks for in the job's own words. The order of bullets and skills is handled automatically: don't return skills segments.
- Truth: use only facts in the segments or the candidate facts. Never change or add numbers, years of experience, tools, employers, titles or achievements.
- Mirror the job's wording where truthful (same names for the same technologies) for ATS matching.
- Keep each segment about the same length (the resume must stay one page).
- Never add a skill, tool or technology to a segment that doesn't already mention it.
- "why": a short note on what you changed and why.${extra}`,
    user: `CANDIDATE FACTS\n${factSheet()}\n\nJOB: ${job.title} at ${job.company}\n${job.description.slice(0, 6000)}\n${assessment ? `\nFIT NOTES: ${assessment.why}\nGAPS (do not paper over): ${assessment.gaps.join("; ")}` : ""}\n\nSEGMENTS\n${listing}`,
    schema: z.toJSONSchema(Edits) as object,
  };
}

/** Check a model's edits (truth, numbers, skills, length) and splice the good ones into the template. */
export function applyEdits(baseTex: string, raw: unknown, jd = "") {
  const parsed = Edits.safeParse(raw);
  const res = parsed.success ? parsed.data : { edits: [] };
  const segs = segments(baseTex)
    .map((g) => ({ ...g, plain: toPlain(g.text) }))
    .filter((g): g is Segment & { plain: string } => !!g.plain);
  const byId = new Map(segs.map((g) => [g.id, g]));
  const applied: { seg: Segment; text: string; why: string }[] = [];
  const skipped: string[] = [];
  const skip = (g: Segment, why: string) => void skipped.push(`${g.kind === "bullet" ? "Bullet" : g.kind === "summary" ? "Summary" : "Skills"} #${g.id}: ${why}`);
  for (const e of res.edits) {
    const g = byId.get(e.id);
    if (!g || applied.some((a) => a.seg.id === g.id)) continue;
    const plain = e.text.replace(/^\s*\*\*[^*]*:\*\*\s*/, "").trim();
    if (plain.replace(/\W+/g, "") === g.plain.replace(/\W+/g, "")) continue; // nothing really changed
    if (plain.length > g.plain.length * 1.3 + 40 || plain.length < g.plain.length * 0.5) {
      skip(g, "would change the length too much (the resume must stay one page)");
      continue;
    }
    if (g.kind === "skills") {
      // skills lines: reorder (and trim a little), but never move items between lines or invent new ones
      const items = (t: string) => t.split(/[,;]/).map((x) => x.replace(/\*\*/g, "").trim().toLowerCase()).filter(Boolean);
      const before = new Set(items(g.plain));
      const after = items(plain);
      if (after.some((x) => !before.has(x)) || after.length < before.size * 0.7) {
        skip(g, "would add or drop skills (only reordering is allowed)");
        continue;
      }
    }
    const have = new Set(nums(g.plain));
    const added = nums(plain).filter((n) => !have.has(n));
    if (added.length) {
      skip(g, `would add a number that isn't on your resume (${added.join(", ")})`); // invented
      continue;
    }
    const tex = fromPlain(plain);
    if (!tex) {
      skip(g, "contained formatting that could break the template");
      continue;
    }
    applied.push({ seg: g, text: tex, why: e.why });
  }
  const label = (g: Segment) => (g.label ?? "").replace(/\\/g, "").replace(/:$/, "");
  const changes = applied.map((a) => ({ id: a.seg.id, text: `${a.seg.kind === "bullet" ? "Bullet" : a.seg.kind === "summary" ? "Summary" : `Skills (${label(a.seg)})`}: ${a.why}` }));
  // final text of every segment: the model's checked edit, else the original
  const final = new Map(segments(baseTex).map((g) => [g.id, g.text]));
  for (const a of applied) final.set(a.seg.id, a.text);
  const all = segments(baseTex);
  if (jd) {
    // exact, model-free tailoring: the job's skills first in every skills line…
    for (const g of all.filter((x) => x.kind === "skills" && !applied.some((a) => a.seg.id === x.id))) {
      const r = reorderSkills(final.get(g.id)!, jd);
      if (r) {
        final.set(g.id, r.text);
        changes.push({ id: g.id, text: `Skills (${label(g)}): ${r.moved.join(", ")} moved first (the job asks for them)` });
      }
    }
    // …and in every role/project, the bullets that match the job most lead the list
    for (const group of bulletGroups(baseTex, all)) {
      const ranked = group.map((g, i) => ({ g, i, score: relevance(final.get(g.id)!, jd) })).sort((x, y) => y.score - x.score || x.i - y.i);
      if (ranked.every((r, i) => r.i === i)) continue;
      const texts = ranked.map((r) => final.get(r.g.id)!);
      group.forEach((g, i) => final.set(g.id, texts[i]));
      changes.push({ id: group[0].id, text: `${group.name}: reordered bullets so the most relevant to this job come first` });
    }
  }
  const touched = all.filter((g) => final.get(g.id) !== g.text);
  if (!touched.length) return skipped.length ? { tex: null, changes: [], skipped } : null;
  let tex = baseTex;
  for (const g of [...touched].sort((x, y) => y.start - x.start)) {
    const old = tex.slice(g.start, g.end);
    tex = tex.slice(0, g.start) + (old.match(/^\s*/)?.[0] ?? "") + final.get(g.id)!.trim() + (old.match(/\s*$/)?.[0] ?? "") + tex.slice(g.end);
  }
  return { tex: tex as string | null, skipped, changes: changes.sort((x, y) => x.id - y.id).map((c) => c.text) };
}

/* ---- deterministic tailoring helpers (no model, nothing invented) ---- */
const STOP = new Set("and the for with you your our are will have has this that from into able work team using use good strong across about years year experience role job who what when where they them their its can more such other within".split(" "));
const plainOf = (t: string) => t.replace(/\\textbf\{([^{}]*)\}/g, "$1").replace(/\\([%&$#_])/g, "$1").replace(/\\[a-zA-Z]+/g, " ").replace(/[{}]/g, "");
const has = (hay: string, term: string) => {
  const t = term.trim().toLowerCase();
  if (t.length < 2) return false;
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9+#])${esc}($|[^a-z0-9+#])`, "i").test(hay);
};
/** How much a bullet speaks to the job: distinct job words it uses, tech terms weighing more. */
function relevance(text: string, jd: string) {
  const words = new Set(plainOf(text).toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g) ?? []);
  let score = 0;
  for (const w of words) if (!STOP.has(w) && has(jd, w)) score += /[+#.]|^(java|spring|kafka|docker|kubernetes|aws|sql|react|node|python|api|rest|redis|cache|test|ci|cd|linux|microservices?)$/.test(w) ? 2 : 1;
  return score;
}
/** Split a skills line at top-level commas (not inside parentheses or braces). */
function splitTop(t: string) {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of t) {
    if (c === "(" || c === "{") depth++;
    if (c === ")" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function reorderSkills(text: string, jd: string) {
  const items = splitTop(text);
  if (items.length < 2) return null;
  const hit = (x: string) => {
    const p = plainOf(x);
    return has(jd, p) || has(jd, p.replace(/\s*\(.*\)\s*/, "")) || p.split(/[\s/()]+/).some((w) => w.length > 2 && !STOP.has(w.toLowerCase()) && has(jd, w));
  };
  const first = items.filter(hit);
  if (!first.length || first.length === items.length) return null;
  const order = [...first, ...items.filter((x) => !hit(x))];
  if (order.every((x, i) => x === items[i])) return null;
  return { text: order.join(", "), moved: first.map((x) => plainOf(x).replace(/\s*\(.*\)/, "")).slice(0, 4) };
}
/** Bullets grouped by the list they sit in (one role or project each), named by the heading above it. */
function bulletGroups(tex: string, all: Segment[]) {
  const groups: (Segment[] & { name: string })[] = [];
  const re = /\\resumeItemListStart([\s\S]*?)\\resumeItemListEnd/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tex))) {
    const from = m.index;
    const to = m.index + m[0].length;
    const inside = all.filter((g) => g.kind === "bullet" && g.start > from && g.end < to);
    if (inside.length < 2) continue;
    const head = tex.slice(Math.max(0, from - 600), from).match(/\\resumeSubheading\s*\{([^{}]*)\}\s*\{[^{}]*\}\s*\{([^{}]*)\}/g)?.pop();
    const parts = head?.match(/\{([^{}]*)\}/g)?.map((x) => plainOf(x.slice(1, -1)).trim()) ?? [];
    groups.push(Object.assign(inside, { name: parts[0] ? `${parts[0]}${parts[2] ? ` (${parts[2]})` : ""}` : "Experience" }));
  }
  return groups;
}


async function tailorFree(baseTex: string, job: Job, assessment: Assessment | null | undefined, extra: string) {
  const p = tailorPrompt(baseTex, job, assessment, extra);
  if (!p) return null;
  const res = await chatJson({
    sensitive: true,
    task: "long",
    maxTokens: 3500,
    schema: p.schema,
    parse: (x) => {
      const r = Edits.safeParse(x);
      return r.success ? { success: true, data: r.data } : { success: false, error: { message: r.error.message } };
    },
    system: p.system,
    user: p.user,
  });
  const out = applyEdits(baseTex, res, job.description);
  return out?.tex ? { tex: out.tex, changes: out.changes } : null;
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
