#!/usr/bin/env node
// One command that selects the tests affected by a change and runs them on the
// isolated test server. The dispatch itself is tools/dispatch-isolated-test.mjs;
// this script only selects files (--changed / --file / --tier) and summarizes
// the forwarded run. It holds no server configuration of its own.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripAnsi } from "../../../tools/node-test-runner-lib.mjs";
import { discoverTestTierManifest, testTierNames } from "../../../tools/test-tier-manifest.mjs";
import {
  parseToolOptions,
  renderToolHelp,
  toolValue,
  toolValues,
  validateTestFile,
  validateTestPrefix,
} from "../../../tools/tool-command-contract.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dispatchEntry = "tools/dispatch-isolated-test.mjs";

const command = {
  id: "test-on-server",
  entry: "skills/harness-contributing/scripts/test-on-server.mjs",
  summary: "Select tests by change, file, or tier and run them on the isolated test server in one dispatch.",
  unknownOptionPrefix: "unknown test-on-server option: ",
  options: [
    {
      name: "--changed",
      placeholder: "<base>",
      defaultValue: "origin/main",
      missingValue: "--changed requires a base ref",
      description:
        "Run the registered test files changed since the merge base with <base>, plus the test files that import changed sources.",
    },
    {
      name: "--file",
      placeholder: "<test-file>",
      repeatable: true,
      missingValue: "--file requires a repository-relative test file",
      validate: validateTestFile,
      description: "POSIX repository-relative test file; repeat for several files in one dispatch.",
    },
    {
      name: "--tier",
      placeholder: "<tier>",
      values: testTierNames,
      missingValue: `--tier requires ${testTierNames.join(", ")}`,
      invalidValue: (value) => `unknown test tier: ${value}; expected ${testTierNames.join(", ")}`,
      description: "Run one registered test tier.",
    },
    {
      name: "--prefix",
      placeholder: "<path>",
      repeatable: true,
      missingValue: "--prefix requires a value",
      validate: validateTestPrefix,
      description: "POSIX repository-relative path prefix; narrows --tier to one package or directory.",
    },
  ],
  details: [
    "The import scan resolves relative specifiers and @harness-anything workspace imports; it is a",
    "heuristic, so a change touching shared surfaces (authorization, settings, construction entry",
    "points, protocol, events) should run the owning package's whole tier with --tier and --prefix.",
  ],
};

// The option parser requires a value for every non-boolean flag, while the documented
// usage is `--changed [base]`; a bare --changed gets the default base injected here.
function withDefaultChangedBase(argv, defaultBase = "origin/main") {
  const result = [...argv];
  for (let index = 0; index < result.length; index += 1) {
    if (result[index] !== "--changed") continue;
    const next = result[index + 1];
    if (next === undefined || next.startsWith("--")) result.splice(index + 1, 0, defaultBase);
  }
  return result;
}

export function parseSkillArgs(argv) {
  const parsed = parseToolOptions(command, withDefaultChangedBase(argv));
  if (parsed.help) return { help: true };
  const base = toolValue(parsed, "--changed");
  const files = toolValues(parsed, "--file");
  const tier = toolValue(parsed, "--tier");
  const prefixes = toolValues(parsed, "--prefix");
  const selectors = [base, files.length > 0 ? files : undefined, tier].filter((value) => value !== undefined).length;
  if (selectors !== 1)
    throw new Error(
      "choose exactly one selector: --changed <base>, one or more --file <test-file>, or --tier <tier> [--prefix <path>]",
    );
  if (prefixes.length > 0 && tier === undefined) throw new Error("--prefix narrows a --tier run");
  if (base !== undefined) return { mode: "changed", base };
  if (files.length > 0) return { mode: "files", files };
  return { mode: "tier", tier, prefixes };
}

export function changedFilesSince(sourceRoot, base) {
  return execFileSync("git", ["-C", sourceRoot, "diff", "--name-only", "-z", `${base}...HEAD`], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

const relativeImportPattern = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu;
const workspaceImportPattern = /(?:from|import)\s*\(?\s*["'](@harness-anything\/[^"']+)["']/gu;
const extensionPattern = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/u;

// A test file is affected when it is itself changed, or when one of its imports
// reaches a changed source: relative specifiers by path (with or without
// extension, including directory imports), workspace specifiers through the
// owning package directory. Anything else the test reaches through is out of
// scope for this scan.
export function affectedTestFiles(changedPaths, manifest, readSource, workspacePackages) {
  const registered = Object.values(manifest).flat().sort();
  const changed = [...new Set(changedPaths)];
  const selected = new Set(changed.filter((file) => registered.includes(file)));
  const sources = changed.filter((file) => !file.includes(".vitest."));
  const vitest = changed.filter((file) => file.includes(".vitest."));
  if (sources.length > 0) {
    const packages = workspacePackages ?? workspacePackagesByDirectory();
    for (const test of registered) {
      if (selected.has(test)) continue;
      const source = readSource(test);
      if (source === undefined) continue;
      if (relativeImportReachesChanged(source, test, sources)) selected.add(test);
      else if (workspaceImportReachesChanged(source, sources, packages)) selected.add(test);
    }
  }
  return { files: [...selected].sort(), vitestNotices: vitest };
}

function relativeImportReachesChanged(source, testFile, sources) {
  for (const match of source.matchAll(relativeImportPattern)) {
    const resolved = posix.normalize(posix.join(posix.dirname(testFile), match[1]));
    if (specifierReachesChanged(resolved, sources)) return true;
  }
  return false;
}

function workspaceImportReachesChanged(source, sources, packages) {
  for (const match of source.matchAll(workspaceImportPattern)) {
    const directory = packages.get(match[1]);
    if (directory !== undefined && specifierReachesChanged(directory, sources)) return true;
  }
  return false;
}

function specifierReachesChanged(resolved, sources) {
  const resolvedBase = resolved.replace(extensionPattern, "");
  return sources.some(
    (changed) =>
      resolved === changed ||
      resolvedBase === changed.replace(extensionPattern, "") ||
      changed.startsWith(`${resolvedBase}/`),
  );
}

// Workspace package names do not mirror their directories (adapter-local lives
// in packages/adapters/local), so the name→directory map is read from the
// workspace manifests instead of derived from the names.
export function workspacePackagesByDirectory(packagesRoot = join(repoRoot, "packages")) {
  const packages = new Map();
  const register = (directory) => {
    const manifest = readPackageManifest(join(packagesRoot, directory, "package.json"));
    if (manifest?.name !== undefined) packages.set(manifest.name, `packages/${directory}`);
  };
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    register(entry.name);
    for (const nested of readdirSync(join(packagesRoot, entry.name), { withFileTypes: true })) {
      if (nested.isDirectory()) register(posix.join(entry.name, nested.name));
    }
  }
  return packages;
}

function readPackageManifest(manifestPath) {
  if (!existsSync(manifestPath)) return undefined;
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function dispatchArguments({ mode, files, tier, prefixes }) {
  if (mode === "tier") return ["--tier", tier, ...prefixes.flatMap((prefix) => ["--prefix", prefix])];
  return files.flatMap((file) => ["--file", file]);
}

export async function runDispatch(arguments_, options = {}) {
  const root = options.root ?? repoRoot;
  const child = spawn(process.execPath, [join(root, dispatchEntry), ...arguments_], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const forward = (stream, target) => {
    child[stream].on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      target.write(text);
    });
  };
  forward("stdout", options.stdout ?? process.stdout);
  forward("stderr", options.stderr ?? process.stderr);
  // A dispatch holds a server slot until its control pipe closes, so an
  // interrupted run must take the child down with it instead of leaking the slot.
  const cancel = () => child.kill("SIGTERM");
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, cancel);
  const code = await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, cancel);
  return { code, output };
}

const fileOutcomeLine = /^\[node-test-file\] (pass|fail|timeout|incomplete) (\S+)$/gmu;

export function parseFileOutcomes(output) {
  const outcomes = new Map();
  for (const match of stripAnsi(output).matchAll(fileOutcomeLine)) outcomes.set(match[2], match[1]);
  return outcomes;
}

const recapHeading = "✖ failing tests:";
const recapLocation = /^test at (.+):\d+:\d+$/u;
const recapName = /^✖ (.+) \(\d+(?:\.\d+)?ms\)$/u;

export function parseFailingTests(output) {
  const lines = stripAnsi(output).split(/\r?\n/u);
  const heading = lines.findIndex((line) => line.trim() === recapHeading);
  if (heading === -1) return [];
  const failures = [];
  let current = null;
  for (const line of lines.slice(heading + 1)) {
    const location = recapLocation.exec(line);
    if (location !== null) {
      current = { file: location[1], name: null, excerpt: [] };
      failures.push(current);
      continue;
    }
    if (current === null) continue;
    const name = recapName.exec(line);
    if (name !== null && current.name === null) {
      current.name = name[1];
      continue;
    }
    if (/^\s+\S/u.test(line)) {
      const text = line.trim();
      // Stack frames are noise in an excerpt; the message head is what routes a fix.
      if (text !== "" && current.excerpt.length < 2 && !/^at \S/u.test(text)) current.excerpt.push(text);
      continue;
    }
    if (line.trim() !== "") break;
  }
  return failures.filter((failure) => failure.name !== null);
}

export function parseDurationMs(output) {
  const matches = [...stripAnsi(output).matchAll(/duration_ms=(\d+)/gu)];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

export function formatSummary({ selection, outcomes, failures, exitCode, durationMs }) {
  const symbols = { pass: "✔", fail: "✖", timeout: "✖", incomplete: "✖", "not run": "–" };
  const known = selection.length > 0 ? selection : [...outcomes.keys()];
  const rows = known.map((file) => [file, outcomes.get(file) ?? "not run"]);
  for (const file of outcomes.keys())
    if (!rows.some(([knownFile]) => knownFile === file)) rows.push([file, outcomes.get(file)]);
  rows.sort(([left], [right]) => left.localeCompare(right));
  const counts = new Map();
  for (const [, outcome] of rows) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const summaryCounts = [...counts.entries()].map(([outcome, count]) => `${count} ${outcome}`).join(", ");
  const lines = [
    `[test-on-server] ${rows.length} file(s): ${summaryCounts || "0"}; exit=${exitCode}` +
      (durationMs === null ? "" : `; server duration_ms=${durationMs}`),
  ];
  for (const [file, outcome] of rows) lines.push(`  ${symbols[outcome]} ${file}`);
  for (const failure of failures) {
    lines.push(`      ✖ ${failure.name} (${failure.file})`);
    for (const excerpt of failure.excerpt) lines.push(`         ${excerpt}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseSkillArgs(argv);
  } catch (error) {
    console.error(`test-on-server: ${error.message}`);
    return 2;
  }
  if (options.help) {
    console.log(renderToolHelp(command));
    return 0;
  }
  if (options.mode === "changed") {
    let changed;
    try {
      changed = changedFilesSince(repoRoot, options.base);
    } catch (error) {
      console.error(`test-on-server: ${error.message}`);
      return 2;
    }
    const { files, vitestNotices } = affectedTestFiles(changed, discoverTestTierManifest(repoRoot), (file) =>
      readFileSync(join(repoRoot, file), "utf8"),
    );
    for (const notice of vitestNotices)
      console.log(`[test-on-server] ${notice} runs on the vitest lane; dispatch it separately.`);
    if (files.length === 0) {
      console.log(
        `[test-on-server] no registered test file is affected by ${options.base}...HEAD; nothing to dispatch.`,
      );
      return 0;
    }
    console.log(`[test-on-server] ${files.length} affected test file(s) from ${options.base}...HEAD:`);
    for (const file of files) console.log(`[test-on-server]   ${file}`);
    options = { ...options, files };
  }
  const { code, output } = await runDispatch(dispatchArguments(options));
  console.log(
    formatSummary({
      selection: options.mode === "tier" ? [] : options.files,
      outcomes: parseFileOutcomes(output),
      failures: parseFailingTests(output),
      exitCode: code,
      durationMs: parseDurationMs(output),
    }),
  );
  return code;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
