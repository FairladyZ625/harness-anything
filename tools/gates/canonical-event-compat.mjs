import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { consumeKnownError } from "../../packages/kernel/src/error-consumption.ts";
import { blockingOf } from "../../packages/kernel/src/domain/task-blocking.ts";
import { closeoutReadiness } from "../../packages/kernel/src/domain/closeout-readiness.ts";
import { canonicalEventSchemas, docSyncWritePlan, isDocEvent, parseCanonicalEvent, serializeCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { isMigrationImportEvent, migrationImportWritePlan } from "../../packages/kernel/src/domain/migration-import-event.ts";
import { isTaskBootstrapEvent, taskBootstrapWritePlan } from "../../packages/kernel/src/domain/task-bootstrap-event.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { makeTaskProjection } from "../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { canonicalEventContentClaims } from "../../packages/kernel/src/store/task-event-store.ts";
import { listProjectedTaskDocuments, readProjectedDocument } from "../../packages/daemon/src/doc-sync-actions.ts";
import { readTaskDispatches } from "../../packages/daemon/src/dispatch-read.ts";
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
import { makeTaskQueryReadModel } from "../../packages/daemon/src/task-query-read.ts";
import { workspaceSummaryFromReads } from "../../packages/daemon/src/workspace-summary-read.ts";
import { repoRoot } from "./git.mjs";

const FIXTURE_ROOT = "packages/kernel/fixtures/canonical-events";
const DAEMON_FIXTURE_ROOT = "packages/daemon/fixtures/readside-responses";
const MAX_READSIDE_EVENTS = 300;
const MAX_READSIDE_MILLISECONDS = 5_000;
const DISPATCH_TASK_ID = "task_62eb49f177c35bd599b0d128a9";
const frozenReadsideEvents = Object.freeze([
  { relativePath: "events/83/migration-36af78f8d2ac53485ca9e14482.json", revision: 108, eventId: "event-83528bd4ab507b4464f6367395476707fd11d8b055bafa53eb569e189f0d1f58", gitBlobSha: "e4106ab9b385fafa88a929f7fb6ffb23b71d15c1", validators: ["validateDaemonDecisionList", "validateDaemonWorkspaceSummary", "validateDaemonRelationGraph"] },
  { relativePath: "events/01/migration-d1f5561fc56708194658688e23.json", revision: 710, eventId: "event-01015fcbe88177fa28c1954658ece77399a587826b46832e159237aa554ebc3d", gitBlobSha: "81f9a9ec2e1f64eb884e94933535dfc214e39633", validators: ["validateDaemonRelationGraph"] },
  { relativePath: "events/00/migration-997d02e0465bb537e7c634506a.json", revision: 2531, eventId: "event-00dd108d8fb541de9a4b33835acf5438a8f8716a0bd27a61d16566e1d882fc61", gitBlobSha: "ff8360db61bc6452420daba4d9f3913ba587a04b", validators: ["validateDaemonRelationGraph"] },
  { relativePath: "events/5d/op_e923d64e5670b35948402b9b2fe99442c8b33362eb49f177c35bd599b0d128a9.json", revision: 23742, eventId: "event-5dbd4d8cd3dadd2834664be4e0a3a046bbe0657c572c38dc4a629444141d38ee", gitBlobSha: "0b5cdf080a31435d58ec407b509f0a4ecbf23fb7", validators: ["validateDaemonTaskSnapshotList", "validateDaemonWorkspaceSummary", "validateDaemonAgenda", "validateDaemonDocumentRead", "validateDaemonTaskDocumentList", "validateDaemonTaskDispatches"] },
  { relativePath: "events/64/op_2e3bdea9f7975741d0bb1cd6cffa2962ccf39b80ab6eb790a901e9b2634c021f.json", revision: 23764, eventId: "event-64bdaa2ba1fac5c9fc3f214a9d14b7ce485664449fd127977beb4ab53b2961ad", gitBlobSha: "0139e5a87941f40249e0e33e616e0fb2b0d037ef", validators: ["validateDaemonTaskDocumentList", "validateDaemonTaskDispatches"] }
]);

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

function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function readContentObject(rootDir, claim) {
  const relativePath = path.posix.join(DAEMON_FIXTURE_ROOT, "objects/sha256", claim.sha256.slice(0, 2), claim.sha256.slice(2));
  const directPath = path.join(rootDir, relativePath), encodedPath = `${directPath}.base64`;
  if (!existsSync(directPath) && !existsSync(encodedPath)) throw new Error(`${relativePath}: frozen content object is missing`);
  const bytes = existsSync(encodedPath) ? Buffer.from(readFileSync(encodedPath, "utf8").trim(), "base64") : readFileSync(directPath);
  if (bytes.byteLength !== claim.size || createHash("sha256").update(bytes).digest("hex") !== claim.sha256) throw new Error(`${relativePath}: frozen content bytes do not match the event claim`);
  return bytes;
}

function readFrozenReadsideHistory(rootDir) {
  if (frozenReadsideEvents.length > MAX_READSIDE_EVENTS) throw new Error(`read-side history has ${frozenReadsideEvents.length} events; budget is ${MAX_READSIDE_EVENTS}`);
  const content = new Map();
  const events = frozenReadsideEvents.map((origin) => {
    const relativePath = path.posix.join(DAEMON_FIXTURE_ROOT, origin.relativePath), bytes = readFileSync(path.join(rootDir, relativePath));
    if (gitBlobSha(bytes) !== origin.gitBlobSha) throw new Error(`${relativePath}: frozen event bytes differ from locked-cut blob ${origin.gitBlobSha}`);
    const event = parseCanonicalEvent(bytes.toString("utf8"));
    if (event.eventId !== origin.eventId || event.workspaceRevision !== origin.revision) throw new Error(`${relativePath}: expected ${origin.eventId} at revision ${origin.revision}`);
    for (const claim of canonicalEventContentClaims(event)) if (!content.has(claim.sha256)) content.set(claim.sha256, readContentObject(rootDir, claim));
    return event;
  }).sort((left, right) => left.workspaceRevision - right.workspaceRevision);
  return { events, content };
}

function fixtureWritePlan(event) {
  if (isMigrationImportEvent(event)) return migrationImportWritePlan(event);
  if (isTaskBootstrapEvent(event)) return taskBootstrapWritePlan(event);
  if (isDocEvent(event)) return docSyncWritePlan(event);
  throw new Error(`read-side fixture ${event.eventId} has no production write-plan adapter`);
}

// This is the gate-only continuity bypass. It advances only disposable projection
// control metadata; event revisions and bytes remain untouched, and apply() still
// runs the production reducer and every response below uses production read assembly.
function positionFixtureProjection(projectionPath, revision) {
  const db = new DatabaseSync(projectionPath);
  try {
    db.prepare("UPDATE projection_meta SET watermark=?, scanned_revision=?, scan_cursor=NULL, head_digest=NULL, state_digest=NULL WHERE singleton=1").run(revision - 1, revision - 1);
  } finally {
    db.close();
  }
}

function sourceEventIds(validatorName) {
  return frozenReadsideEvents.filter(({ validators }) => validators.includes(validatorName)).map(({ eventId }) => eventId);
}

export function projectFrozenDaemonResponses(rootDir) {
  const fixture = readFrozenReadsideHistory(rootDir), temporaryRoot = mkdtempSync(path.join(tmpdir(), "daemon-readside-compat-"));
  mkdirSync(path.join(temporaryRoot, "harness"), { recursive: true });
  let head = null;
  const eventStore = {
    readHead: () => head,
    readBatch: () => { throw new Error("read-side compatibility fixtures must bypass stream scanning"); },
    readContentBlob: (sha256) => fixture.content.get(sha256) ?? null
  };
  const projectionPath = path.join(temporaryRoot, "task.sqlite"), projection = makeTaskProjection({ rootDir: temporaryRoot, eventStore, projectionPath });
  try {
    projection.readStateDigest();
    projection.close();
    for (const event of fixture.events) {
      head = { revision: event.workspaceRevision, eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}` };
      positionFixtureProjection(projectionPath, event.workspaceRevision);
      projection.apply(event, fixtureWritePlan(event));
      projection.close();
    }
    const model = makeTaskQueryReadModel({ rootDir: temporaryRoot, projection, judgments: { closeout: closeoutReadiness, blocking: blockingOf } });
    const taskRead = model.guiTasks({ limit: 100 }), decisionProjection = projection.listDecisions({}), decisionRead = { ok: true, decisions: decisionProjection.decisions, warnings: [] };
    const responses = new Map([
      ["validateDaemonTaskSnapshotList", taskRead],
      ["validateDaemonWorkspaceSummary", workspaceSummaryFromReads(taskRead, decisionRead)],
      ["validateDaemonAgenda", model.agenda({ limit: 100 })],
      ["validateDaemonRelationGraph", model.relationGraph()],
      ["validateDaemonDecisionList", decisionRead],
      [
        "validateDaemonDocumentRead",
        readProjectedDocument(temporaryRoot, projection, { taskId: DISPATCH_TASK_ID, path: "INDEX.md" })
      ],
      [
        "validateDaemonTaskDocumentList",
        listProjectedTaskDocuments(temporaryRoot, projection, { taskId: DISPATCH_TASK_ID })
      ],
      ["validateDaemonTaskDispatches", readTaskDispatches({ rootDir: temporaryRoot, projection, taskId: DISPATCH_TASK_ID })]
    ]);
    return [...responses].map(([name, value]) => ({ name, value, sourceEventIds: sourceEventIds(name) }));
  } finally {
    projection.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function validateProjectedDaemonResponses(samples, validators) {
  const errors = [];
  for (const entry of validators) {
    const sample = samples.find(({ name }) => name === entry.name);
    if (sample === undefined) {
      errors.push(`${entry.name}: no projected historical sample`);
      continue;
    }
    const issues = entry.validate(sample.value);
    if (issues.length > 0) errors.push(`${sample.sourceEventIds.join(", ")} -> ${entry.name} rejected projected history: ${issues.join("; ")}`);
  }
  return errors;
}

export function validateFrozenDaemonReadside(rootDir, validators = daemonResponseValidators) {
  const started = performance.now();
  let errors;
  try {
    errors = validateProjectedDaemonResponses(projectFrozenDaemonResponses(rootDir), validators);
  } catch (error) {
    consumeKnownError(error);
    errors = [`daemon read-side history replay failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  const durationMs = performance.now() - started;
  if (durationMs > MAX_READSIDE_MILLISECONDS) errors.push(`daemon read-side history took ${durationMs.toFixed(1)}ms; budget is ${MAX_READSIDE_MILLISECONDS}ms`);
  return { errors, durationMs, eventCount: frozenReadsideEvents.length };
}

function main() {
  if (!process.argv.includes("--check")) throw new Error("usage: node tools/gates/canonical-event-compat.mjs --check");
  const rootDir = repoRoot(), daemon = validateFrozenDaemonReadside(rootDir);
  const errors = [...validateFrozenCanonicalEvents(rootDir, canonicalEventSchemas, parseCanonicalEvent), ...daemon.errors];
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`canonical-event-compat: ok (${canonicalEventSchemas.length} canonical schemas, ${daemonResponseValidators.length} daemon response validators from ${daemon.eventCount} historical events, ${daemon.durationMs.toFixed(1)}ms)`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
