import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { listWorktreeFiles } from "./gates/git.mjs";

const root = process.cwd();
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const allowlist = loadGateAllowlist("check-integrity-single-source", {
  requiredSections: ["authorities"],
});
const authorities = new Map(allowlist.authorities.map((entry) => [entry.symbol, entry.path]));
const violations = [];

function definitionPattern(symbol) {
  return new RegExp(`\\b(?:export\\s+)?(?:function\\s+${symbol}\\s*\\(|(?:const|let|var)\\s+${symbol}\\s*=)`, "u");
}

const scannedFiles = listWorktreeFiles(root, ["packages"]).filter((file) => sourceFile.test(file));
if (scannedFiles.length === 0)
  throw new Error("check-integrity-single-source: required scan root packages has no source files");
for (const rel of scannedFiles) {
  const text = await readFile(path.join(root, rel), "utf8");
  for (const [symbol, authority] of authorities) {
    if (rel === authority) continue;
    if (definitionPattern(symbol).test(text)) {
      violations.push(`${rel}: duplicate ${symbol} implementation; import from ${authority}`);
    }
  }
  if (
    rel !== "packages/kernel/src/integrity/stable-hash.ts" &&
    /createHash\(\s*["']sha256["']\s*\)\.update\(\s*stableStringify\(/u.test(text)
  ) {
    violations.push(
      `${rel}: duplicate stable payload hash implementation; import from packages/kernel/src/integrity/stable-hash.ts`,
    );
  }
}

if (violations.length > 0) {
  console.error("Integrity single-source violations found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Integrity single-source check passed.");
