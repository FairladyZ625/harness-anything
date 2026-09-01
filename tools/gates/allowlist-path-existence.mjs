#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TASK_EVENT_CONSTRUCTION_ALLOWLIST } from "../gate-allowlists/task-event-aggregate-entry.mjs";
import { kernelImportBoundaryKnownDebt } from "../kernel-import-boundary-known-debt.mjs";
import { portPhysicalIoBoundaryKnownDebt } from "../port-physical-io-boundary-known-debt.mjs";
import { exitCodeFor, parseCommonArgs } from "./ontology-gate-lib.mjs";
import { noSwallowedFailureBaseline } from "./no-swallowed-failure-baseline.mjs";
import { processPortOnlyBaseline } from "./process-port-only-baseline.mjs";

const allowlistSchema = "harness-anything/gate-allowlist/v1";
const jsonPolicies = Object.freeze({
  "check-bypass-write-boundary.json": {
    pathSections: {},
    nonPathSections: [
      "rebuildable-projection",
      "coordinatedCore",
      "exemptHumanOrBootstrap",
      "legacyArchive",
      "freshGateRegistry",
    ],
  },
  "check-implementation-contracts.json": {
    pathSections: {
      expectedRuntimeTestFiles: "value",
      expectedWorkspaceTsconfigs: "value",
      guiCliTextFiles: "value",
      localLifecycleCliTextFiles: "value",
      extensionSchemaPaths: "value",
    },
    nonPathSections: [
      "packageLockVersions",
      "forbiddenLockfiles",
      "requiredCompilerOptions",
      "portablePathRequiredSnippets",
      "portablePathTestEvidence",
      "guiImplementationSnippets",
      "applicationServiceSnippets",
      "guiSecurityEvidence",
      "storeRequiredSnippets",
      "localLifecycleRequiredSnippets",
      "taskProjectionRequiredSnippets",
      "multicaRequiredSnippets",
      "multicaForbiddenVerbs",
      "extensionRequiredSnippets",
      "browserWindowRequiredPatterns",
    ],
  },
  "check-import-boundaries.json": {
    pathSections: {
      guiAdapterCompositionRoots: "value",
      cliAdapterCompositionRoots: "value",
      kernelStoreCompositionRoots: "value",
      cliAdapterKnownDebt: "value",
    },
    nonPathSections: [],
  },
  "check-integration-test-shards.json": {
    pathSections: {},
    nonPathSections: ["intentionalTestDeletions"],
  },
  "check-integrity-single-source.json": {
    pathSections: { authorities: "path" },
    nonPathSections: [],
  },
  "check-kernel-dead-exports.json": {
    pathSections: {},
    nonPathSections: ["zeroConsumptionExports"],
  },
  "check-private-boundary.json": {
    pathSections: {},
    nonPathSections: ["privateContentMarkers"],
  },
  "scan-forbidden-symbols.json": {
    pathSections: {},
    nonPathSections: ["forbiddenSymbols"],
  },
});

const explicitExclusions = Object.freeze([
  "check-implementation-contracts.packageLockVersions (package-lock keys, not checkout paths)",
  "check-implementation-contracts.forbiddenLockfiles (absence is the contract)",
  "check-integration-test-shards.intentionalTestDeletions (intentional deletion tombstones)",
  "scan-forbidden-symbols.forbiddenSymbols (symbol and regex entries)",
]);

export function collectAllowlistPathEntries(rootDir = process.cwd()) {
  return [...collectJsonPathEntries(rootDir), ...collectInlinePathEntries()];
}

export function auditAllowlistPathExistence(rootDir, entries) {
  const findings = [];
  for (const entry of entries) {
    const invalidReason = invalidRelativePathReason(entry.relativePath);
    if (invalidReason !== null) {
      findings.push(`${entry.source}: ${JSON.stringify(entry.relativePath)} ${invalidReason}`);
      continue;
    }
    if (!existsSync(path.join(rootDir, ...entry.relativePath.split("/")))) {
      findings.push(`${entry.source}: ${entry.relativePath} does not exist`);
    }
  }
  return { checked: entries.length, findings };
}

function collectJsonPathEntries(rootDir) {
  const allowlistRoot = path.join(rootDir, "tools/gate-allowlists");
  const jsonFiles = readdirSync(allowlistRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const unclassifiedFiles = jsonFiles.filter((name) => !Object.hasOwn(jsonPolicies, name));
  if (unclassifiedFiles.length > 0) {
    throw new Error(`unclassified JSON allowlist(s): ${unclassifiedFiles.join(", ")}`);
  }

  const entries = [];
  for (const [fileName, policy] of Object.entries(jsonPolicies)) {
    const relativeFile = `tools/gate-allowlists/${fileName}`;
    const parsed = JSON.parse(readFileSync(path.join(rootDir, relativeFile), "utf8"));
    if (parsed.schema !== allowlistSchema || typeof parsed.entries !== "object" || parsed.entries === null) {
      throw new Error(`${relativeFile} must use ${allowlistSchema} and define entries`);
    }
    const classifiedSections = new Set([...Object.keys(policy.pathSections), ...policy.nonPathSections]);
    const unclassifiedSections = Object.keys(parsed.entries).filter((section) => !classifiedSections.has(section));
    if (unclassifiedSections.length > 0) {
      throw new Error(`${relativeFile} has unclassified section(s): ${unclassifiedSections.join(", ")}`);
    }
    for (const [section, field] of Object.entries(policy.pathSections)) {
      if (!Object.hasOwn(parsed.entries, section)) {
        throw new Error(`${relativeFile} is missing classified path section entries.${section}`);
      }
      collectEntryTree(entries, parsed.entries[section], `${relativeFile}:entries.${section}`, field);
    }
  }
  return entries;
}

function collectEntryTree(entries, value, source, field) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${source}[${index}].${field} must be a non-empty path`);
      }
      entries.push({ source: `${source}[${index}].${field}`, relativePath: entry[field] });
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`${source} must be an entry list or nested object of entry lists`);
  }
  for (const [key, child] of Object.entries(value)) {
    collectEntryTree(entries, child, `${source}.${key}`, field);
  }
}

function collectInlinePathEntries() {
  const entries = [];
  collectFingerprintPaths(entries, noSwallowedFailureBaseline, "tools/gates/no-swallowed-failure-baseline.mjs");
  collectFingerprintPaths(entries, processPortOnlyBaseline, "tools/gates/process-port-only-baseline.mjs");
  for (const key of Object.keys(TASK_EVENT_CONSTRUCTION_ALLOWLIST)) {
    const separator = key.indexOf("|");
    if (separator <= 0) throw new Error(`task-event aggregate allowlist key has no path prefix: ${key}`);
    entries.push({
      source: `tools/gate-allowlists/task-event-aggregate-entry.mjs:${key}`,
      relativePath: key.slice(0, separator),
    });
  }
  for (const [index, entry] of kernelImportBoundaryKnownDebt.entries()) {
    entries.push(
      {
        source: `tools/kernel-import-boundary-known-debt.mjs:kernelImportBoundaryKnownDebt[${index}].file`,
        relativePath: entry.file,
      },
      {
        source: `tools/kernel-import-boundary-known-debt.mjs:kernelImportBoundaryKnownDebt[${index}].target`,
        relativePath: entry.target,
      },
    );
  }
  for (const [index, entry] of portPhysicalIoBoundaryKnownDebt.entries()) {
    entries.push({
      source: `tools/port-physical-io-boundary-known-debt.mjs:portPhysicalIoBoundaryKnownDebt[${index}].file`,
      relativePath: entry.file,
    });
  }
  return entries;
}

function collectFingerprintPaths(entries, baseline, source) {
  for (const [index, entry] of baseline.entries()) {
    const match = /^(.*):\d+:\d+#[0-9a-f]{64}$/u.exec(entry);
    if (match === null) throw new Error(`${source}[${index}] is not a path fingerprint`);
    entries.push({ source: `${source}[${index}]`, relativePath: match[1] });
  }
}

function invalidRelativePathReason(relativePath) {
  if (relativePath.trim() !== relativePath || relativePath === "") return "must be a non-empty trimmed path";
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return "must be repository-relative";
  }
  if (relativePath.includes("\\") || relativePath.split("/").some((part) => part === "." || part === "..")) {
    return "must use normalized repository-relative path segments";
  }
  return null;
}

function loadFixturePathEntries(fixture) {
  const parsed = JSON.parse(readFileSync(fixture, "utf8"));
  if (parsed.schema !== allowlistSchema || !Array.isArray(parsed.entries?.paths)) {
    throw new Error(`fixture must use ${allowlistSchema} and define entries.paths`);
  }
  const entries = [];
  collectEntryTree(entries, parsed.entries.paths, `${fixture}:entries.paths`, "value");
  return entries;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const entries = fixture === null ? collectAllowlistPathEntries(rootDir) : loadFixturePathEntries(fixture);
    const result = auditAllowlistPathExistence(rootDir, entries);
    console.log(`B13 allowlist-path-existence: ${mode}`);
    console.log(`checked path-accounting entries (${result.checked})`);
    console.log(`explicit non-path exclusions (${explicitExclusions.length}): ${explicitExclusions.join("; ")}`);
    console.log(`findings (${result.findings.length}):`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`B13 allowlist-path-existence: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
