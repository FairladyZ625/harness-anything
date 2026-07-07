import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { loadGateAllowlist, patternEntries } from "./gate-allowlists/load-gate-allowlist.mjs";

const root = process.cwd();
const scannedRoots = [path.join(root, "packages")];
const sourceFile = /\.(?:ts|mts|js|mjs)$/;
const allowlist = loadGateAllowlist("scan-forbidden-symbols", {
  requiredSections: ["forbiddenSymbols"]
});
const forbidden = patternEntries(allowlist.forbiddenSymbols);
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

for (const sourceRoot of scannedRoots) {
  for (const file of await walk(sourceRoot)) {
    const text = await readFile(file, "utf8");
    const filePath = relative(file);
    for (const { label, pattern, includePathPattern } of forbidden) {
      if (includePathPattern && !includePathPattern.test(filePath)) continue;
      if (pattern.test(text)) {
        violations.push(`${filePath}: forbidden symbol ${label}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Forbidden symbols found:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Forbidden symbol scan passed.");
