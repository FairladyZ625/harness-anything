import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const testFilePattern = /\.(test|spec)\.(?:mjs|js|ts)$/u;
// app-node_modules is the GUI packaging output: gitignored, full of vendored third-party test
// files, and present on any machine that has built the GUI. Walking it makes check:local red
// with "test tier marker missing" for a file nobody in this repository wrote.
const ignoredDirectoryNames = new Set(["node_modules", "app-node_modules", "dist", "out", "coverage", ".git"]);
const markerPattern = /^\s*\/\/\s*harness-test-tier:\s*(\S+)\s*$/u;
const timeoutMarkerPattern = /^\s*\/\/\s*harness-test-file-timeout:\s*(\S+)\s*$/u;

export const testTierNames = Object.freeze(["fast", "contract", "integration"]);

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
    throw new Error(
      `invalid test tier marker: ${file}: ${markerLines[0].line.trim()}; expected ${testTierNames.join(", ")}`,
    );
  }
  return tier;
}

export function parseTestFileTimeoutMarker(source, file = "test file") {
  const lines = source.split(/\r?\n/u);
  const markerLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*\/\/\s*harness-test-file-timeout:/u.test(line));
  if (markerLines.length === 0) return undefined;
  if (markerLines.length > 1) throw new Error(`multiple test file timeout markers: ${file}`);
  const marker = markerLines[0];
  if (marker.index > 1) throw new Error(`test file timeout marker must be in the file header: ${file}`);
  const value = marker.line.match(timeoutMarkerPattern)?.[1];
  if (value === "none") {
    const normalized = file.replaceAll("\\", "/");
    if (!normalized.startsWith("tools/stress/")) {
      throw new Error(`unbounded test file timeout is only allowed under tools/stress/: ${file}`);
    }
    return "none";
  }
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid test file timeout marker: ${file}; expected none or a positive integer`);
  }
  return timeoutMs;
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
    options.readSource ?? ((file) => readFileSync(path.join(repoRoot, file), "utf8")),
  );
}

export function discoverTestFileTimeouts(repoRoot, options = {}) {
  const files = discoverTestFiles(repoRoot, options.roots);
  const readSource = options.readSource ?? ((file) => readFileSync(path.join(repoRoot, file), "utf8"));
  return Object.fromEntries(files.map((file) => [file, parseTestFileTimeoutMarker(readSource(file), file)]));
}

function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const manifest = discoverTestTierManifest(repositoryRoot);
  const count = testTierNames.reduce((total, tier) => total + manifest[tier].length, 0);
  console.log(`Test tier manifest passed (${count} test files).`);
}

function walk(directory, repoRoot, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name.startsWith(".") || ignoredDirectoryNames.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath, repoRoot, files);
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path.relative(repoRoot, entryPath).split(path.sep).join("/"));
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Test tier manifest failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
