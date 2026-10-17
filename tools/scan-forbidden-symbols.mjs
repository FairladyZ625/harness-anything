import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGateAllowlist, patternEntries } from "./gate-allowlists/load-gate-allowlist.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";

const root = process.cwd();
const sourceFile = /\.(?:ts|mts|js|mjs)$/;
const allowlist = loadGateAllowlist("scan-forbidden-symbols", {
  requiredSections: ["forbiddenSymbols"],
});
const forbidden = patternEntries(allowlist.forbiddenSymbols);
const violations = [];

const files = listWorktreeFiles(root, ["packages"]).filter((file) => sourceFile.test(file));
if (files.length === 0) throw new Error("scan-forbidden-symbols: required scan root packages has no source files");
for (const filePath of files) {
  const text = await readFile(path.join(root, filePath), "utf8");
  for (const { label, pattern, includePathPattern } of forbidden) {
    if (includePathPattern && !includePathPattern.test(filePath)) continue;
    if (pattern.test(text)) {
      violations.push(`${filePath}: forbidden symbol ${label}`);
    }
  }
}

if (violations.length > 0) {
  console.error("Forbidden symbols found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Forbidden symbol scan passed.");
