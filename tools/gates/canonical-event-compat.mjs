import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { consumeKnownError } from "../../packages/kernel/src/error-consumption.ts";
import { canonicalEventSchemas, parseCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import {
  validateDaemonAgenda,
  validateDaemonDecisionList,
  validateDaemonDocumentRead,
  validateDaemonRelationGraph,
  validateDaemonTaskDispatches,
  validateDaemonTaskDocumentList,
  validateDaemonTaskSnapshotList,
  validateDaemonWorkspaceSummary
} from "../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { repoRoot } from "./git.mjs";

const FIXTURE_ROOT = "packages/kernel/fixtures/canonical-events";
const DAEMON_FIXTURE_ROOT = "packages/daemon/fixtures/readside-responses";

export const daemonResponseValidators = Object.freeze([
  { name: "validateDaemonTaskSnapshotList", validate: validateDaemonTaskSnapshotList },
  { name: "validateDaemonWorkspaceSummary", validate: validateDaemonWorkspaceSummary },
  { name: "validateDaemonAgenda", validate: validateDaemonAgenda },
  { name: "validateDaemonRelationGraph", validate: validateDaemonRelationGraph },
  { name: "validateDaemonDecisionList", validate: validateDaemonDecisionList },
  { name: "validateDaemonDocumentRead", validate: validateDaemonDocumentRead },
  { name: "validateDaemonTaskDocumentList", validate: validateDaemonTaskDocumentList },
  { name: "validateDaemonTaskDispatches", validate: validateDaemonTaskDispatches }
]);

function fixtureDirectory(schema) {
  return schema.replaceAll("/", "-");
}

export function validateFrozenCanonicalEvents(rootDir, schemas, parseCanonicalEvent) {
  const errors = [];
  for (const entry of schemas) {
    const relativeDirectory = path.posix.join(FIXTURE_ROOT, fixtureDirectory(entry.schema));
    const directory = path.join(rootDir, relativeDirectory);
    if (!existsSync(directory)) {
      errors.push(`${relativeDirectory}: ${entry.schema} has no frozen samples`);
      continue;
    }
    const samples = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
    if (samples.length === 0) {
      errors.push(`${relativeDirectory}: ${entry.schema} has no frozen samples`);
      continue;
    }
    for (const name of samples) {
      const relativePath = path.posix.join(relativeDirectory, name);
      let body;
      let value;
      try {
        body = readFileSync(path.join(directory, name), "utf8");
        value = JSON.parse(body);
      } catch (error) {
        consumeKnownError(error);
        errors.push(`${relativePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (value === null || typeof value !== "object" || Array.isArray(value) || value.schema !== entry.schema) {
        errors.push(`${relativePath}: expected ${entry.schema}, found ${String(value?.schema)}`);
        continue;
      }
      const issues = entry.validate(value);
      if (issues.length > 0) errors.push(`${relativePath}: ${entry.schema} rejected frozen sample: ${issues.join("; ")}`);
      else if (parseCanonicalEvent !== undefined) {
        try {
          parseCanonicalEvent(body);
        } catch (error) {
          consumeKnownError(error);
          errors.push(`${relativePath}: frozen bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return errors;
}

export function validateFrozenDaemonResponses(rootDir, validators) {
  const errors = [];
  for (const entry of validators) {
    const relativeDirectory = path.posix.join(DAEMON_FIXTURE_ROOT, entry.name);
    const directory = path.join(rootDir, relativeDirectory);
    if (!existsSync(directory)) {
      errors.push(`${relativeDirectory}: ${entry.name} has no frozen samples`);
      continue;
    }
    const samples = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
    if (samples.length === 0) {
      errors.push(`${relativeDirectory}: ${entry.name} has no frozen samples`);
      continue;
    }
    for (const name of samples) {
      const relativePath = path.posix.join(relativeDirectory, name);
      let value;
      try {
        value = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
      } catch (error) {
        consumeKnownError(error);
        errors.push(`${relativePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const issues = entry.validate(value);
      if (issues.length > 0) errors.push(`${relativePath}: ${entry.name} rejected frozen response: ${issues.join("; ")}`);
    }
  }
  return errors;
}

function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/canonical-event-compat.mjs --check");
  const rootDir = repoRoot();
  const errors = [
    ...validateFrozenCanonicalEvents(rootDir, canonicalEventSchemas, parseCanonicalEvent),
    ...validateFrozenDaemonResponses(rootDir, daemonResponseValidators)
  ];
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`canonical-event-compat: ok (${canonicalEventSchemas.length} canonical schemas, ${daemonResponseValidators.length} daemon response validators)`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
