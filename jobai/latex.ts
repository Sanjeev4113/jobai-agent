/** Compile LaTeX to PDF with Tectonic (a self-contained TeX engine). Returns null when Tectonic isn't installed. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function hasTectonic() {
  try {
    execFileSync("tectonic", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Write `tex` to dir/name.tex and compile it next to it. Returns the PDF path or null. */
export function compile(tex: string, outDir: string, name: string): { texPath: string; pdfPath: string | null; log?: string } {
  const dir = path.resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const texPath = path.join(dir, `${name}.tex`);
  writeFileSync(texPath, tex);
  if (!hasTectonic()) return { texPath, pdfPath: null, log: "tectonic not installed" };
  // Tectonic runs XeTeX; Overleaf templates are often written for pdfLaTeX. A tiny wrapper provides the two pdfTeX-only
  // pieces (\pdfgentounicode, glyphtounicode) so the template compiles unchanged; XeTeX writes Unicode text natively.
  const wrapper = path.join(dir, `${name}.build.tex`);
  writeFileSync(
    wrapper,
    `\\ifdefined\\pdfgentounicode\\else\\newcount\\pdfgentounicode\\fi\n\\ifdefined\\pdfglyphtounicode\\else\\def\\pdfglyphtounicode#1#2{}\\fi\n\\input{${name}.tex}\n`,
  );
  if (!existsSync(path.join(dir, "glyphtounicode.tex"))) writeFileSync(path.join(dir, "glyphtounicode.tex"), "% pdfTeX glyph map: not needed under XeTeX\n");
  try {
    execFileSync("tectonic", ["-X", "compile", "--keep-logs", "--outdir", dir, wrapper], { cwd: dir, stdio: "pipe", timeout: 180_000 });
    const built = path.join(dir, `${name}.build.pdf`);
    const pdf = path.join(dir, `${name}.pdf`);
    if (existsSync(built)) renameSync(built, pdf);
    return { texPath, pdfPath: existsSync(pdf) ? pdf : null };
  } catch (e) {
    const err = e as { stderr?: Buffer };
    return { texPath, pdfPath: null, log: err.stderr?.toString().slice(-2000) };
  }
}
