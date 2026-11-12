/** Compile LaTeX to PDF with Tectonic (a self-contained TeX engine). Returns null when Tectonic isn't installed. */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Which engine to run: the system's Tectonic (the Mac), else the one bundled into the Vercel build by
 * scripts/tectonic-prepare.mjs together with the TeX files the resume needs (copied to /tmp once, then offline).
 */
let engine: { bin: string; env: NodeJS.ProcessEnv } | null | undefined;
function findEngine() {
  if (engine !== undefined) return engine;
  try {
    execFileSync(/*turbopackIgnore: true*/ "tectonic", ["--version"], { stdio: "ignore" });
    return (engine = { bin: "tectonic", env: process.env });
  } catch {}
  const shipped = path.join(process.cwd(), ".tectonic");
  if (existsSync(path.join(shipped, "bin", "tectonic"))) {
    try {
      const tmp = "/tmp/tectonic";
      if (!existsSync(path.join(tmp, "bin", "tectonic"))) cpSync(shipped, tmp, { recursive: true });
      chmodSync(path.join(tmp, "bin", "tectonic"), 0o755);
      return (engine = { bin: path.join(tmp, "bin", "tectonic"), env: { ...process.env, TECTONIC_CACHE_DIR: path.join(tmp, "cache") } });
    } catch {}
  }
  return (engine = null);
}

export function hasTectonic() {
  return !!findEngine();
}

/** Write `tex` to dir/name.tex and compile it next to it. Returns the PDF path or null. */
export function compile(tex: string, outDir: string, name: string): { texPath: string; pdfPath: string | null; log?: string } {
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const texPath = path.join(dir, `${name}.tex`);
  writeFileSync(texPath, tex);
  const eng = findEngine();
  if (!eng) return { texPath, pdfPath: null, log: "tectonic not installed" };
  // Tectonic runs XeTeX; Overleaf templates are often written for pdfLaTeX. A tiny wrapper provides the two pdfTeX-only
  // pieces (\pdfgentounicode, glyphtounicode) so the template compiles unchanged; XeTeX writes Unicode text natively.
  const wrapper = path.join(dir, `${name}.build.tex`);
  writeFileSync(
    wrapper,
    `\\ifdefined\\pdfgentounicode\\else\\newcount\\pdfgentounicode\\fi\n\\ifdefined\\pdfglyphtounicode\\else\\def\\pdfglyphtounicode#1#2{}\\fi\n\\input{${name}.tex}\n`,
  );
  if (!existsSync(path.join(dir, "glyphtounicode.tex"))) writeFileSync(path.join(dir, "glyphtounicode.tex"), "% pdfTeX glyph map: not needed under XeTeX\n");
  try {
    execFileSync(/*turbopackIgnore: true*/ eng.bin, ["-X", "compile", "--keep-logs", "--outdir", dir, wrapper], { cwd: dir, env: eng.env, stdio: "pipe", timeout: 180_000 });
    const built = path.join(dir, `${name}.build.pdf`);
    const pdf = path.join(dir, `${name}.pdf`);
    if (existsSync(built)) renameSync(built, pdf);
    return { texPath, pdfPath: existsSync(pdf) ? pdf : null };
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return { texPath, pdfPath: null, log: err.stderr?.toString().slice(-2000) };
  }
}
