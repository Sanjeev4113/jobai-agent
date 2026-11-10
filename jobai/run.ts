/**
 * JobAI, the hourly run.  `npm run jobai` (add `-- --dry` to print instead of emailing).
 *   fetch every source → keep new, relevant, fresh roles → Claude Haiku screens them → Claude Opus assesses the best
 *   → Opus tailors the resume for strong matches (same template) → Tectonic compiles PDFs → one email digest.
 *   Once a day (08:00 IST) it also emails an upskilling plan built from the gaps in that week's matches.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assess, hasClaude, screen, tailor, upskill, type Assessment } from "./claude";
import { fresh, keywordScore, locationRank, relevant } from "./filter";
import { compile } from "./latex";
import { esc, hasMail, send } from "./mail";
import { QUERIES } from "./profile";
import { detail, fetchAll, mapLimit, type Job } from "./sources";
import { load, save } from "./state";

const DRY = process.argv.includes("--dry");
const MAX_ASSESS = Number(process.env.JOBAI_MAX_ASSESS ?? 8); // Opus assessments per run
const MAX_TAILOR_DAY = Number(process.env.JOBAI_MAX_TAILOR_PER_DAY ?? 15); // tailored resumes per day
const SCREEN_MIN = Number(process.env.JOBAI_SCREEN_MIN ?? 65);
const SEND_EMPTY = process.env.JOBAI_SEND_EMPTY !== "0";
const OUT = path.join(process.cwd(), "jobai", "out");
const BASE_TEX = path.join(process.cwd(), "jobai", "resume", "base.tex");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const istHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

/** Things the application asks for that only Sanjeev can answer (and aren't in his saved applicant details). */
function applicant(): Record<string, string> {
  try {
    if (process.env.APPLICANT_JSON) return JSON.parse(process.env.APPLICANT_JSON) as Record<string, string>;
    const f = path.join(process.cwd(), "jobai", "applicant.json");
    if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  } catch {}
  return {};
}
function needsYou(a: Assessment | null) {
  if (!a) return [];
  const known = applicant();
  return a.requiredInfo.filter((r) => {
    const k = r.toLowerCase();
    if (/cgpa|gpa|grade|percentage|marks/.test(k)) return !known.cgpa;
    if (/visa|authori[sz]ation|sponsor/.test(k)) return !known.workAuthorization;
    if (/notice/.test(k)) return !known.noticePeriod;
    if (/ctc|salary|compensation/.test(k)) return !known.expectedCtc;
    return true;
  });
}

type Pick = { job: Job; fit: number; why: string; a: Assessment | null; pdf?: string | null; tex?: string; changes?: string[]; tailorError?: string; needs: string[] };

function card(p: Pick) {
  const color = p.fit >= 80 ? "#16a34a" : p.fit >= 65 ? "#ca8a04" : "#6b7280";
  const verdict = p.a?.verdict ? ` · ${p.a.verdict.toUpperCase()}` : "";
  return `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:0 0 14px">
  <div style="display:flex;justify-content:space-between;gap:8px"><strong style="font-size:16px">${esc(p.job.title)}</strong><span style="color:${color};font-weight:700">${p.fit}%${verdict}</span></div>
  <div style="color:#6b7280;font-size:13px;margin:2px 0 8px">${esc(p.job.company)} · ${esc(p.job.location || "—")}${p.job.remote ? " · Remote" : ""} · via ${p.job.source}</div>
  <p style="margin:6px 0">${esc(p.a?.why ?? p.why)}</p>
  ${p.a?.gaps.length ? `<p style="margin:6px 0;color:#92400e"><b>Gaps:</b> ${esc(p.a.gaps.join("; "))}</p>` : ""}
  ${p.needs.length ? `<p style="margin:6px 0;color:#b91c1c"><b>⚠ Needs you:</b> ${esc(p.needs.join("; "))}</p>` : ""}
  ${p.pdf ? `<p style="margin:6px 0;color:#065f46">📎 Tailored resume attached${p.changes?.length ? `: ${esc(p.changes.slice(0, 3).join("; "))}` : ""}</p>` : p.tailorError ? `<p style="margin:6px 0;color:#6b7280">Resume not tailored: ${esc(p.tailorError)}</p>` : ""}
  ${p.a?.coverNote ? `<details><summary style="cursor:pointer">Cover note</summary><p style="white-space:pre-wrap">${esc(p.a.coverNote)}</p></details>` : ""}
  ${p.a?.answers.length ? `<details><summary style="cursor:pointer">Ready answers</summary>${p.a.answers.map((q) => `<p><b>${esc(q.question)}</b><br>${esc(q.answer)}</p>`).join("")}</details>` : ""}
  <a href="${p.job.url}" style="display:inline-block;margin-top:10px;background:#111827;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-weight:700">Open & apply →</a>
</div>`;
}

async function main() {
  const t0 = Date.now();
  const state = load();
  const { jobs, counts } = await fetchAll(QUERIES);
  const seenBefore = new Set(Object.keys(state.seen));
  const now = new Date().toISOString();

  // dedupe by id and by company+title (the same role is often posted in many cities)
  const byKey = new Map<string, Job>();
  for (const j of jobs) {
    if (seenBefore.has(j.id) || !relevant(j) || !fresh(j)) continue;
    const k = `${j.company.toLowerCase()}|${j.title.toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, j);
  }
  const ranked = [...byKey.values()].sort((a, b) => locationRank(b) - locationRank(a) || keywordScore(b).score - keywordScore(a).score);
  // mark everything seen except relevant roles we don't get to this run (they wait for the next hour)
  const later = new Set(ranked.slice(120).map((j) => j.id));
  for (const j of jobs) if (!later.has(j.id)) state.seen[j.id] ??= now;
  const candidates = await mapLimit(ranked.slice(0, 120), 6, detail);
  console.log(`[jobai] fetched ${jobs.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}); ${candidates.length} new relevant (${later.size} queued for next run)`);

  // 1) screen
  const screened = new Map<string, { fit: number; why: string }>();
  if (hasClaude() && candidates.length) {
    for (const [id, v] of await screen(candidates)) screened.set(id, v);
  } else for (const j of candidates) screened.set(j.id, { fit: keywordScore(j).score, why: `Matches: ${keywordScore(j).hits.slice(0, 8).join(", ")}` });

  const shortlist = candidates
    .map((job) => ({ job, ...(screened.get(job.id) ?? { fit: 0, why: "" }) }))
    .filter((x) => x.fit >= SCREEN_MIN)
    .sort((a, b) => b.fit - a.fit);

  // 2) assess + 3) tailor the best
  if (state.tailoredToday.day !== today()) state.tailoredToday = { day: today(), n: 0 };
  const baseTex = existsSync(BASE_TEX) ? readFileSync(BASE_TEX, "utf8") : null;
  const picks: Pick[] = [];
  for (const [i, s] of shortlist.entries()) {
    let a: Assessment | null = null;
    if (hasClaude() && i < MAX_ASSESS) a = await assess(s.job).catch(() => null);
    const fit = a?.fit ?? s.fit;
    const p: Pick = { job: s.job, fit, why: s.why, a, needs: needsYou(a) };
    if (a && a.verdict !== "skip" && baseTex && state.tailoredToday.n < MAX_TAILOR_DAY) {
      const r = await tailor(baseTex, s.job, a).catch((e: Error) => ({ ok: false as const, error: e.message }));
      if (r.ok) {
        const dir = path.join(OUT, "resumes", today(), slug(`${s.job.company}-${s.job.title}`));
        const c = compile(r.tex, dir, "Sanjeev_Sudarsanam_Resume");
        p.pdf = c.pdfPath;
        p.tex = c.texPath;
        p.changes = r.changes;
        if (!c.pdfPath) p.tailorError = `LaTeX saved but not compiled (${c.log?.split("\n").pop() ?? "error"})`;
        state.tailoredToday.n++;
      } else p.tailorError = r.error;
    } else if (a && !baseTex) p.tailorError = "add jobai/resume/base.tex to enable tailoring";
    if (!a || a.verdict !== "skip") picks.push(p);
    state.history.push({ id: s.job.id, at: now, title: s.job.title, company: s.job.company, url: s.job.url, fit, verdict: a?.verdict, gaps: a?.gaps ?? [], tailored: !!p.pdf });
  }

  // 4) email
  const needs = picks.filter((p) => p.needs.length);
  const when = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const subject = picks.length
    ? `JobAI · ${picks.length} new match${picks.length > 1 ? "es" : ""}${needs.length ? ` · ${needs.length} need you` : ""} · ${when}`
    : `JobAI · no new matches · ${when}`;
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:auto;color:#111827">
  <h2 style="margin:0 0 4px">JobAI hourly digest</h2>
  <p style="color:#6b7280;margin:0 0 16px">${when} IST · scanned ${jobs.length} openings, ${candidates.length} new and relevant, ${shortlist.length} shortlisted${hasClaude() ? " by Claude" : " (keyword mode: add ANTHROPIC_API_KEY for Claude)"}.</p>
  ${needs.length ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:12px 14px;margin:0 0 16px"><b style="color:#b91c1c">⚠ ${needs.length} application(s) need information only you can give</b> (marked below). Reply with it, or add it to your applicant details.</div>` : ""}
  ${picks.map(card).join("") || `<p>No new roles cleared the bar this hour. JobAI keeps watching ${Object.keys(counts).length} sources.</p>`}
  <p style="color:#9ca3af;font-size:12px;margin-top:20px">Resumes are tailored with Claude Opus 5.5 using only facts from your profile. Always skim before sending.</p>
</div>`;
  const attachments = picks.filter((p) => p.pdf).map((p) => ({ filename: `${slug(p.job.company)}-${slug(p.job.title)}.pdf`, path: p.pdf! }));
  if (DRY) {
    console.log(`[jobai] DRY RUN, subject: ${subject}`);
    for (const p of picks.slice(0, 15)) console.log(`  ${p.fit}%  ${p.job.title} @ ${p.job.company} (${p.job.location}) ${p.pdf ? "[resume]" : ""}${p.needs.length ? " [NEEDS YOU]" : ""}\n        ${p.job.url}`);
  } else if (picks.length || SEND_EMPTY) await send(subject, html, attachments);

  // 5) daily upskilling plan
  if (!DRY && hasClaude() && istHour() === 8 && state.lastUpskill !== today()) {
    const week = state.history.filter((h) => Date.now() - Date.parse(h.at) < 7 * 86_400_000);
    const counts2 = new Map<string, number>();
    for (const h of week) for (const g of h.gaps) counts2.set(g, (counts2.get(g) ?? 0) + 1);
    const gaps = [...counts2.entries()].map(([skill, count]) => ({ skill, count })).sort((a, b) => b.count - a.count).slice(0, 40);
    const plan = gaps.length ? await upskill(gaps, week.map((h) => `${h.title} @ ${h.company}`)).catch(() => null) : null;
    if (plan) {
      await send(
        `JobAI · your upskilling plan · ${today()}`,
        `<div style="font-family:system-ui,sans-serif;max-width:680px;margin:auto"><h2>Upskill for the roles you're matching</h2><p>${esc(plan.summary)}</p>${plan.skills
          .map((s) => `<h3 style="margin-bottom:4px">${esc(s.skill)} <small style="color:#6b7280">(${esc(s.demand)})</small></h3><p>${esc(s.why)}</p><p><b>Plan:</b> ${esc(s.plan)}</p><p>${s.resources.map(esc).join(" · ")}</p>`)
          .join("")}<h3>This week</h3><ul>${plan.thisWeek.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`,
      );
      state.lastUpskill = today();
    }
  }

  save(state);
  console.log(`[jobai] done in ${Math.round((Date.now() - t0) / 1000)}s · ${picks.length} picks · mail ${hasMail() ? "on" : "off"} · claude ${hasClaude() ? "on" : "off"}`);
}

main().catch((e) => {
  console.error("[jobai] failed:", e);
  process.exit(1);
});
