#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AGGREGATE_EVENT_CONSTRUCTION_BASELINE } from "../gate-allowlists/aggregate-event-construction-baseline.mjs";
import { kernelImportBoundaryKnownDebt } from "../kernel-import-boundary-known-debt.mjs";
import { portPhysicalIoBoundaryKnownDebt } from "../port-physical-io-boundary-known-debt.mjs";
import { EVIDENCE_INDEX } from "./evidence-index.mjs";
import { exitCodeFor, parseCommonArgs } from "./ontology-gate-lib.mjs";
import { noSwallowedFailureBaseline } from "./no-swallowed-failure-baseline.mjs";
import { processPortOnlyBaseline } from "./process-port-only-baseline.mjs";

const allowlistSchema = "harness-anything/gate-allowlist/v1";
// Exported so the classification itself is inspectable: every allowlist JSON is
// either audited as repository paths or explicitly recorded as non-path, and an
// unclassified file or section fails closed. Tests pin the per-file decision
// instead of matching source text.
export const allowlistJsonPolicies = Object.freeze({
  "action-catalog-null.json": {
    pathSections: {},
    nonPathSections: ["catalogNulls"],
  },
  // dec_7E44897ECDCAEF2B92EC66A260 CH1: exact ontology source identities still name live source files.
  "ontology-closure.json": {
    pathSections: { candidates: "path" },
    nonPathSections: [],
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
      "extensionRequiredSnippets",
      "browserWindowRequiredPatterns",
    ],
  },
  "check-fallback-boundaries.json": {
    pathSections: { fullHistoryScans: "file" },
    nonPathSections: ["consumeKnownError", "catchSubstitutions"],
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
    pathSections: { overBudgetFiles: "value" },
    nonPathSections: ["intentionalTestDeletions"],
  },
  "check-schema-field-coverage.json": {
    pathSections: {},
    nonPathSections: ["expectedFields"],
  },
  "check-kernel-dead-exports.json": {
    pathSections: {},
    nonPathSections: ["zeroConsumptionExports"],
  },
  "check-poll-spin-boundary.json": {
    pathSections: {},
    nonPathSections: ["exceptions"],
  },
  "authorization-provider-boundary.json": {
    pathSections: {},
    nonPathSections: ["providerWaivers", "lineFingerprints"],
  },
  "check-self-repo-path-literals.json": {
    pathSections: { allowlistedUsages: "path" },
    nonPathSections: ["forbiddenDirectories"],
  },
  "check-private-boundary.json": {
    pathSections: {},
    nonPathSections: ["privateContentMarkers"],
  },
  // dec_AEB05951C69E47FCE53E53C341 CH4 ratchet: every remaining dispatch observation site names a live file.
  "dispatch-lifecycle-observation.json": {
    pathSections: { observationSites: "path" },
    nonPathSections: [],
  },
  "scan-forbidden-symbols.json": {
    pathSections: {},
    nonPathSections: ["forbiddenSymbols"],
  },
});

const explicitExclusions = Object.freeze([
  "check-implementation-contracts.packageLockVersions (package-lock keys, not checkout paths)",
  "check-implementation-contracts.forbiddenLockfiles (absence is the contract)",
  "check-fallback-boundaries.consumeKnownError/catchSubstitutions (file#function keys the gate exact-syncs)",
  "check-integration-test-shards.intentionalTestDeletions (intentional deletion tombstones)",
  "check-poll-spin-boundary.exceptions (file#function#kind keys the gate exact-syncs)",
  "scan-forbidden-symbols.forbiddenSymbols (symbol and regex entries)",
  "authorization-provider-boundary.providerWaivers.paths (scope globs, not concrete checkout paths)",
  "authorization-provider-boundary.lineFingerprints (source-line hashes, not checkout paths)",
]);

function collectAllowlistAudits(rootDir) {
  const { pathEntries, refEntries } = collectJsonPathEntries(rootDir);
  // Inline baseline modules (fingerprints, known debt) carry no ref fields.
  return { pathEntries: [...pathEntries, ...collectInlinePathEntries()], refEntries };
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

const taskSegmentPattern = /^task_(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{26})$/u;
const decisionSegmentPattern = /^dec_[A-Za-z0-9_]+$/u;
const adrSegmentPattern = /^ADR-\d{4}(?:#D\d+)?$/u;
const documentSegmentPattern = /^harness\/[^#]+(?:#[^#]+)?$/u;
const citationSegmentPatterns = [taskSegmentPattern, decisionSegmentPattern, adrSegmentPattern, documentSegmentPattern];

export function auditAllowlistRefReachability(index, entries) {
  const tasks = new Set(index.tasks);
  const decisions = new Set(index.decisions);
  const documents = new Set(index.documents);
  const findings = [];
  for (const entry of entries) {
    // The private ledger never ships with the repository, so reachability is
    // judged against the exported evidence index, not the filesystem.
    for (const segment of entry.ref
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "")) {
      if (
        (taskSegmentPattern.test(segment) && tasks.has(segment)) ||
        (decisionSegmentPattern.test(segment) && decisions.has(segment)) ||
        (documentSegmentPattern.test(segment) && documents.has(segment)) ||
        (adrSegmentPattern.test(segment) && adrReachable(index.adrs, segment))
      ) {
        continue;
      }
      findings.push(
        `${entry.source}: ${
          citationSegmentPatterns.some((pattern) => pattern.test(segment))
            ? `"${segment}" is not reachable in the evidence index`
            : `"${segment}" is not a task, decision, ADR, or ledger document citation`
        }`,
      );
    }
  }
  return { checked: entries.length, findings };
}

function adrReachable(adrs, segment) {
  const separator = segment.indexOf("#");
  const adr = separator === -1 ? segment : segment.slice(0, separator);
  const anchors = adrs[adr];
  if (anchors === undefined) return false;
  return separator === -1 || anchors.includes(segment.slice(separator + 1));
}

function collectJsonPathEntries(rootDir) {
  const allowlistRoot = path.join(rootDir, "tools/gate-allowlists");
  const jsonFiles = readdirSync(allowlistRoot)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const unclassifiedFiles = jsonFiles.filter((name) => !Object.hasOwn(allowlistJsonPolicies, name));
  if (unclassifiedFiles.length > 0) {
    throw new Error(`unclassified JSON allowlist(s): ${unclassifiedFiles.join(", ")}`);
  }

  const pathEntries = [];
  const refEntries = [];
  for (const [fileName, policy] of Object.entries(allowlistJsonPolicies)) {
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
      collectEntryTree(pathEntries, parsed.entries[section], `${relativeFile}:entries.${section}`, field);
    }
    // A missing or non-string ref is load-gate-allowlist.mjs's named failure
    // at every consuming gate's load boundary; this audit only judges the
    // reachability of refs that are present.
    collectEntryRefs(refEntries, parsed.entries, `${relativeFile}:entries`);
  }
  return { pathEntries, refEntries };
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

function collectEntryRefs(entries, value, source) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      if (typeof entry?.ref === "string" && entry.ref.trim() !== "") {
        entries.push({ source: `${source}[${index}].ref`, ref: entry.ref });
      }
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    collectEntryRefs(entries, child, `${source}.${key}`);
  }
}

function collectInlinePathEntries() {
  const entries = [];
  collectFingerprintPaths(entries, noSwallowedFailureBaseline, "tools/gates/no-swallowed-failure-baseline.mjs");
  collectFingerprintPaths(entries, processPortOnlyBaseline, "tools/gates/process-port-only-baseline.mjs");
  for (const key of Object.keys(AGGREGATE_EVENT_CONSTRUCTION_BASELINE)) {
    const [schema, relativePath, form, eventType] = key.split("|");
    if (!schema || !relativePath || !form || eventType === undefined)
      throw new Error(`aggregate event construction baseline key has no schema|path|form|eventType shape: ${key}`);
    entries.push({
      source: `tools/gate-allowlists/aggregate-event-construction-baseline.mjs:${key}`,
      relativePath,
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

function loadFixtureAudits(fixture) {
  const parsed = JSON.parse(readFileSync(fixture, "utf8"));
  if (parsed.schema !== allowlistSchema || !Array.isArray(parsed.entries?.paths)) {
    throw new Error(`fixture must use ${allowlistSchema} and define entries.paths`);
  }
  const pathEntries = [];
  collectEntryTree(pathEntries, parsed.entries.paths, `${fixture}:entries.paths`, "value");
  const refEntries = [];
  collectEntryRefs(refEntries, parsed.entries, `${fixture}:entries`);
  return { pathEntries, refEntries };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode, fixture } = parseCommonArgs(argv, { allowFixture: true });
    const { pathEntries, refEntries } = fixture === null ? collectAllowlistAudits(rootDir) : loadFixtureAudits(fixture);
    const pathResult = auditAllowlistPathExistence(rootDir, pathEntries);
    const refResult = auditAllowlistRefReachability(EVIDENCE_INDEX, refEntries);
    const findings = [...pathResult.findings, ...refResult.findings];
    console.log(`B13 allowlist-path-existence: ${mode}`);
    console.log(`checked path-accounting entries (${pathResult.checked})`);
    console.log(`checked ref-accounting entries (${refResult.checked})`);
    console.log(`explicit non-path exclusions (${explicitExclusions.length}): ${explicitExclusions.join("; ")}`);
    console.log(`findings (${findings.length}):`);
    for (const finding of findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, findings.length);
  } catch (error) {
    console.error(`B13 allowlist-path-existence: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
