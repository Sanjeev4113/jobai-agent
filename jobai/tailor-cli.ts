/**
 * Tailor the resume to one job description, locally.
 *   npm run resume -- path/to/jd.txt --company "Stripe" --title "Software Engineer"
 *   pbpaste | npm run resume -- - --company Stripe --title "Backend Engineer"
 * Writes jobai/out/resumes/manual/<company-title>/ : Sanjeev_Sudarsanam_Resume.tex + .pdf, and notes.md (fit, gaps, cover note).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assess, hasClaude, tailor } from "./claude";
import { compile, hasTectonic } from "./latex";
import type { Job } from "./sources";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const src = args[0];
if (!src) {
  console.error('Usage: npm run resume -- <jd.txt | -> [--company "Name"] [--title "Role"]');
  process.exit(1);
}
const jd = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
const BASE = path.join(process.cwd(), "jobai", "resume", "base.tex");
if (!existsSync(BASE)) {
  console.error("Missing jobai/resume/base.tex: paste your Overleaf LaTeX there first.");
  process.exit(1);
}
if (!hasClaude()) {
  console.error("Set ANTHROPIC_API_KEY (in .env.local or your shell) to tailor with Claude.");
  process.exit(1);
}
const company = opt("company") ?? "Company";
const title = opt("title") ?? "Role";
const job: Job = { id: "manual", source: "manual", company, title, location: opt("location") ?? "", remote: false, url: opt("url") ?? "", description: jd };
const slug = `${company}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dir = path.join(process.cwd(), "jobai", "out", "resumes", "manual", slug);

async function main() {
  const a = await assess(job);
  console.log(`Fit ${a?.fit ?? "?"}% · ${a?.verdict ?? ""}\n${a?.why ?? ""}`);
  const r = await tailor(readFileSync(BASE, "utf8"), job, a);
  if (!r.ok) {
    console.error(`Tailoring rejected: ${r.error}`);
    process.exit(1);
  }
  const c = compile(r.tex, dir, "Sanjeev_Sudarsanam_Resume");
  writeFileSync(
    path.join(dir, "notes.md"),
    `# ${title} at ${company}\n\nFit: ${a?.fit}% (${a?.verdict})\n\n${a?.why}\n\n## Gaps\n${(a?.gaps ?? []).map((g) => `- ${g}`).join("\n")}\n\n## Needs your input\n${(a?.requiredInfo ?? []).map((g) => `- ${g}`).join("\n") || "- nothing"}\n\n## What changed in the resume\n${r.changes.map((x) => `- ${x}`).join("\n")}\n\n## Cover note\n${a?.coverNote ?? ""}\n\n## Ready answers\n${(a?.answers ?? []).map((q) => `**${q.question}**\n${q.answer}`).join("\n\n")}\n`,
  );
  console.log(`\nSaved:\n  ${c.texPath}\n  ${c.pdfPath ?? `(PDF not built${hasTectonic() ? `: ${c.log?.slice(-300)}` : ": install Tectonic with `brew install tectonic`"})`}\n  ${path.join(dir, "notes.md")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
