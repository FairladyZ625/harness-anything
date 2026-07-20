import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
const ignoredDirectoryNames = new Set(["node_modules", "dist", "out", "coverage", ".git"]);
const markerPattern = /^\s*\/\/\s*harness-test-tier:\s*(\S+)\s*$/u;

export const testTierNames = Object.freeze(["fast", "contract", "integration", "nightly"]);
export const defaultTestTierNames = Object.freeze(["fast", "contract", "integration"]);

export function parseTestTierMarker(source, file = "test file") {
  const lines = source.split(/\r?\n/u);
  const markerLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*\/\/\s*harness-test-tier:/u.test(line));

  if (markerLines.length === 0) {
    throw new Error(`test tier marker missing: ${file}`);
  }
  if (markerLines.length > 1) {
    throw new Error(`multiple test tier markers: ${file}`);
  }
  if (markerLines[0].index !== 0) {
    throw new Error(`test tier marker must be the first line: ${file}`);
  }

  const match = markerLines[0].line.match(markerPattern);
  const tier = match?.[1];
  if (tier === undefined || !testTierNames.includes(tier)) {
    throw new Error(`invalid test tier marker: ${file}: ${markerLines[0].line.trim()}; expected ${testTierNames.join(", ")}`);
  }
  return tier;
}

export function deriveTestTierManifest(testFiles, readSource) {
  if (typeof readSource !== "function") throw new Error("deriveTestTierManifest requires a source reader");
  const manifest = Object.fromEntries(testTierNames.map((tier) => [tier, []]));
  for (const file of [...testFiles].sort()) {
    manifest[parseTestTierMarker(readSource(file), file)].push(file);
  }
  return manifest;
}

export function discoverTestFiles(repoRoot, roots = ["packages", "tools"]) {
  const files = [];
  for (const root of roots) {
    walk(path.join(repoRoot, root), repoRoot, files);
  }
  return files.sort();
}

export function discoverTestTierManifest(repoRoot, options = {}) {
  return deriveTestTierManifest(
    discoverTestFiles(repoRoot, options.roots),
    options.readSource ?? ((file) => readFileSync(path.join(repoRoot, file), "utf8"))
  );
}

function walk(directory, repoRoot, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath, repoRoot, files);
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path.relative(repoRoot, entryPath).split(path.sep).join("/"));
    }
  }
}
