/** Persistent state between runs (restored and saved by the GitHub Actions cache, or kept on disk locally). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "jobai", "state");
export type HistoryItem = { id: string; at: string; title: string; company: string; url: string; fit: number; verdict?: string; gaps: string[]; tailored?: boolean };
export type State = { seen: Record<string, string>; history: HistoryItem[]; lastUpskill?: string; tailoredToday: { day: string; n: number } };

export function load(): State {
  const f = path.join(DIR, "state.json");
  const empty: State = { seen: {}, history: [], tailoredToday: { day: "", n: 0 } };
  if (!existsSync(f)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(f, "utf8")) as State) };
  } catch {
    return empty;
  }
}

export function save(s: State) {
  mkdirSync(DIR, { recursive: true });
  // forget jobs seen more than 60 days ago, keep 30 days of history
  const cutoff = Date.now() - 60 * 86_400_000;
  for (const [k, v] of Object.entries(s.seen)) if (Date.parse(v) < cutoff) delete s.seen[k];
  s.history = s.history.filter((h) => Date.now() - Date.parse(h.at) < 30 * 86_400_000);
  writeFileSync(path.join(DIR, "state.json"), JSON.stringify(s));
}
