import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const scannedRoots = [path.join(root, "packages")];
const sourceFile = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const allowlist = loadGateAllowlist("check-integrity-single-source", {
  requiredSections: ["authorities"]
});
const authorities = new Map(allowlist.authorities.map((entry) => [entry.symbol, entry.path]));
const violations = [];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      files.push(...await walk(full));
    } else if (sourceFile.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function definitionPattern(symbol) {
  return new RegExp(`\\b(?:export\\s+)?(?:function\\s+${symbol}\\s*\\(|(?:const|let|var)\\s+${symbol}\\s*=)`, "u");
}

for (const sourceRoot of scannedRoots) {
  for (const file of await walk(sourceRoot)) {
    const rel = relative(file);
    const text = await readFile(file, "utf8");
    for (const [symbol, authority] of authorities) {
      if (rel === authority) continue;
      if (definitionPattern(symbol).test(text)) {
        violations.push(`${rel}: duplicate ${symbol} implementation; import from ${authority}`);
      }
    }
    if (
      rel !== "packages/kernel/src/integrity/stable-hash.ts"
      && /createHash\(\s*["']sha256["']\s*\)\.update\(\s*stableStringify\(/u.test(text)
    ) {
      violations.push(`${rel}: duplicate stable payload hash implementation; import from packages/kernel/src/integrity/stable-hash.ts`);
    }
  }
}

if (violations.length > 0) {
  console.error("Integrity single-source violations found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Integrity single-source check passed.");
