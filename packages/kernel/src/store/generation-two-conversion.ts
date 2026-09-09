import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { publishConvertedGeneration, readCertifiedGitFollower } from "./sqlite-task-event-store.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import { ciWorkflowVerificationMigration } from "./event-shape-migration.ts";
import {
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import { drillLedgerBackup, readVerifiedLedgerBackup } from "./ledger-backup.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import {
  openSqliteEventStore,
  sqliteLedgerPath,
  type SqliteEventStore,
  type SqliteEventRow,
} from "./sqlite-event-store.ts";

export interface GenerationConversionMapping {
  readonly sourceRevision: number;
  readonly sourceOpId: string;
  readonly sourceDigest: string;
  readonly destinationRevision: number | null;
  readonly destinationOpId: string | null;
  readonly destinationDigest: string | null;
  readonly disposition: "converted" | "retained-read-only" | "unsupported";
  readonly reasons: readonly string[];
}

export interface GenerationConversionPlan {
  readonly schema: "generation-conversion-plan/v1";
  readonly repoId: string;
  readonly sourceGeneration: 1;
  readonly destinationGeneration: 2;
  readonly sourceDigest: string;
  readonly sourceEvents: number;
  readonly convertedEvents: number;
  readonly retainedEvents: number;
  readonly ready: boolean;
  readonly mappings: readonly GenerationConversionMapping[];
}

/** Offline operator entry. The input is a verified, self-contained backup, never a live repository. */
export function runGenerationTwoConversion(input: {
  readonly backupDir: string;
  readonly mode: "dry-run" | "convert" | "verify";
  readonly destinationRoot?: string;
}) {
  const backupDir = path.resolve(input.backupDir),
    manifest = readVerifiedLedgerBackup(backupDir),
    sourcePath = path.join(backupDir, "payload", ".harness", "store", "generations", "1", "ledger.sqlite");
  if (
    !manifest.files.some(
      (file) => file.path === ".harness/store/generations/1/ledger.sqlite" && file.method === "vacuum-into",
    )
  )
    throw new Error(
      "generation 1 conversion requires a SQLite backup; legacy generation 0 uses the existing legacy converter",
    );
  const source = openSqliteEventStore({ databasePath: sourcePath, generation: 1, readOnly: true });
  try {
    const { plan, events, rows } = planConversion(source);
    if (input.mode === "dry-run") return { plan, active: false as const };
    if (!plan.ready) return { plan, active: false as const };
    if (!input.destinationRoot || !path.isAbsolute(input.destinationRoot))
      throw new Error("conversion and verification require an absolute --destination outside the backup");
    const destinationRoot = path.resolve(input.destinationRoot),
      relative = path.relative(backupDir, destinationRoot);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
      throw new Error("conversion destination must be outside the immutable backup");
    if (input.mode === "convert") {
      drillLedgerBackup({ backupDir, shadowParent: path.dirname(destinationRoot), destinationRoot });
      convert(source, destinationRoot, plan, events, rows);
    }
    const verification = verify(source, destinationRoot, plan, events, rows);
    // Verification never activates a repository. The retained original and report accompany the candidate.
    return { plan, destinationRoot, verification, active: false as const };
  } finally {
    source.close();
  }
}

function planConversion(source: SqliteEventStore) {
  const rows = source.eventRows(),
    events: CanonicalEventV1[] = [],
    mappings: GenerationConversionMapping[] = [],
    installations = new Map<string, string>();
  for (const row of rows) {
    let candidate: CanonicalEventV1 | undefined;
    const reasons: string[] = [];
    let retained = false;
    try {
      if (row.revision !== mappings.length + 1 || row.digest !== `sha256:${sha256Text(row.eventJson)}`)
        throw new Error("source revision or event digest differs");
      const original = JSON.parse(row.eventJson) as CanonicalEventV1,
        event = ciWorkflowVerificationMigration.rewrite(original)?.event ?? original;
      if (event.opId !== row.opId || event.workspaceRevision !== row.revision || event.occurredAt !== row.occurredAt)
        throw new Error("source event identity or occurredAt column differs");
      if (!Number.isFinite(Date.parse(row.recordedAt))) throw new Error("source recordedAt is unavailable");
      if (event.type === "runtime_session_liveness_changed") {
        retained = true;
        reasons.push("historical liveness is retained in generation 1; it cannot establish current liveness");
      } else if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_installation_observed") {
        const key = event.payload.installationId,
          value = stableStringify(event.payload);
        retained = installations.get(key) === value;
        installations.set(key, value);
        if (retained) reasons.push("identical installation observation retained in generation 1");
      }
      if (!retained) {
        if (event.type === "decision_related" || event.type === "task_relation_added")
          throw new Error("retired relation ingress requires an explicit relation identity and reference mapping");
        if (event.type === "runtime_session_provider_bound" || event.type === "runtime_session_task_bound")
          throw new Error("session binding consolidation requires the approved start-event and historical-cut mapping");
        const issues = validateCurrentCanonicalEvent(event);
        if (issues.length) throw new Error(issues.join("; "));
        for (const claim of contentClaims(event)) {
          const bytes = source.readContentObject(claim.sha256);
          if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
            throw new Error(`missing or corrupt accepted content ${claim.sha256}`);
        }
        candidate = { ...event, workspaceRevision: events.length + 1 };
        // A cut/digest reference cannot be shifted by blind recursive string replacement.
        if (candidate.workspaceRevision !== row.revision && event.type !== "runtime_installation_observed")
          throw new Error("event references a historical revision/cut requiring an explicit mapping");
      }
    } catch (error) {
      consumeKnownError(error);
      reasons.push(error instanceof Error ? error.message : String(error));
      candidate = undefined;
      retained = false;
    }
    if (candidate) events.push(candidate);
    mappings.push({
      sourceRevision: row.revision,
      sourceOpId: row.opId,
      sourceDigest: row.digest,
      destinationRevision: candidate?.workspaceRevision ?? null,
      destinationOpId: candidate?.opId ?? null,
      destinationDigest: candidate ? `sha256:${sha256Text(serializePersistedCanonicalEvent(candidate))}` : null,
      disposition: candidate ? "converted" : retained ? "retained-read-only" : "unsupported",
      reasons,
    });
  }
  const sourceDigest = `sha256:${sha256Text(stableStringify({ metadata: source.metadata(), rows, outcomes: source.outcomes(), objects: source.contentObjectDigests() }))}`;
  const plan: GenerationConversionPlan = {
    schema: "generation-conversion-plan/v1",
    repoId: source.metadata().repoId,
    sourceGeneration: 1,
    destinationGeneration: 2,
    sourceDigest,
    sourceEvents: rows.length,
    convertedEvents: events.length,
    retainedEvents: mappings.filter((row) => row.disposition === "retained-read-only").length,
    ready: mappings.every((row) => row.disposition !== "unsupported"),
    mappings,
  };
  assertOutcomeCoverage(source, rows);
  return { plan, events, rows };
}

function assertOutcomeCoverage(source: SqliteEventStore, rows: readonly SqliteEventRow[]) {
  const covered = new Set<number>();
  for (const outcome of source.outcomes()) {
    if (outcome.firstRevision === null && outcome.lastRevision === null) continue;
    if (
      outcome.status !== "accepted_durable" ||
      outcome.firstRevision === null ||
      outcome.lastRevision === null ||
      outcome.firstRevision < 1 ||
      outcome.lastRevision < outcome.firstRevision ||
      outcome.lastRevision > rows.length
    )
      throw new Error(`source outcome ${outcome.opId} has invalid event bounds`);
    for (let revision = outcome.firstRevision; revision <= outcome.lastRevision; revision++) {
      if (covered.has(revision)) throw new Error(`source outcomes overlap at revision ${revision}`);
      covered.add(revision);
    }
  }
  if (covered.size !== rows.length) throw new Error("source commands do not account for every accepted event");
}

function convert(
  source: SqliteEventStore,
  root: string,
  plan: GenerationConversionPlan,
  events: readonly CanonicalEventV1[],
  rows: readonly SqliteEventRow[],
) {
  const destination = openSqliteEventStore({
      repoId: plan.repoId,
      rootInput: root,
      generation: 2,
      conversionSourceGeneration: 1,
    }),
    fence = { repoId: plan.repoId, holder: "offline-generation-2-converter", epoch: 1 },
    byOpId = new Map(plan.mappings.map((mapping) => [mapping.sourceOpId, mapping]));
  try {
    destination.claimWriter(fence);
    for (const outcome of source.outcomes()) {
      const members = mappedMembers(byOpId, outcome.memberOpIds),
        converted = members.map((mapping) => events[mapping.destinationRevision! - 1]!),
        blobs = converted.flatMap((event) =>
          contentClaims(event).map((claim) => ({ ...claim, body: source.readContentObject(claim.sha256)! })),
        );
      destination.appendCommand({
        fence,
        intent: { opId: outcome.opId, intentDigest: outcome.intentDigest, summary: outcome.summary },
        events: converted,
        blobs,
        ...(outcome.rejectionCode === null ? {} : { rejectionCode: outcome.rejectionCode }),
        historicalRecord: {
          recordedAt: outcome.recordedAt,
          eventRecordedAt: members.map((mapping) => rows[mapping.sourceRevision - 1]!.recordedAt),
        },
      });
    }
    publishConvertedGeneration({ rootInput: root, repoId: plan.repoId, store: destination });
    const reportPath = `${sqliteLedgerPath(root, 2)}.conversion.json`;
    if (!files.createExclusiveText(reportPath, `${JSON.stringify(plan, null, 2)}\n`))
      throw new Error("generation conversion report already exists");
  } finally {
    destination.close();
  }
}

function mappedMembers(byOpId: ReadonlyMap<string, GenerationConversionMapping>, memberOpIds: readonly string[]) {
  return memberOpIds.map((opId) => byOpId.get(opId)!).filter((mapping) => mapping.disposition === "converted");
}

function verify(
  source: SqliteEventStore,
  root: string,
  plan: GenerationConversionPlan,
  events: readonly CanonicalEventV1[],
  rows: readonly SqliteEventRow[],
) {
  const destination = openSqliteEventStore({ repoId: plan.repoId, rootInput: root, generation: 2, readOnly: true }),
    retained = openSqliteEventStore({ repoId: plan.repoId, rootInput: root, generation: 1, readOnly: true }),
    byOpId = new Map(plan.mappings.map((mapping) => [mapping.sourceOpId, mapping]));
  try {
    if (stableStringify(planConversion(retained).plan) !== stableStringify(plan))
      throw new Error("retained generation differs from immutable source");
    const report = JSON.parse(files.readText(`${sqliteLedgerPath(root, 2)}.conversion.json`));
    if (stableStringify(report) !== stableStringify(plan))
      throw new Error("conversion report differs from source plan");
    const actual = destination.eventRows(),
      mappings = plan.mappings.filter((mapping) => mapping.disposition === "converted");
    if (actual.length !== events.length || destination.revision() !== events.length)
      throw new Error("converted event count differs");
    for (const [index, event] of events.entries()) {
      const row = actual[index]!,
        original = rows[mappings[index]!.sourceRevision - 1]!;
      if (
        row.eventJson !== serializePersistedCanonicalEvent(event) ||
        row.digest !== mappings[index]!.destinationDigest ||
        row.occurredAt !== original.occurredAt ||
        row.recordedAt !== original.recordedAt
      )
        throw new Error(`converted event or timestamps differ at revision ${index + 1}`);
      for (const claim of contentClaims(event)) {
        const bytes = destination.readContentObject(claim.sha256);
        if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
          throw new Error(`converted content closure differs: ${claim.sha256}`);
      }
    }
    if (destination.outcomes().length !== source.outcomes().length) throw new Error("command outcome count differs");
    for (const original of source.outcomes()) {
      const members = mappedMembers(byOpId, original.memberOpIds),
        result = destination.outcome(original.opId),
        expected = {
          ...original,
          firstRevision: members[0]?.destinationRevision ?? null,
          lastRevision: members.at(-1)?.destinationRevision ?? null,
          memberOpIds: members.map((mapping) => mapping.destinationOpId),
        };
      if (stableStringify(result) !== stableStringify(expected))
        throw new Error(`command outcome differs: ${original.opId}`);
    }
    const git = readCertifiedGitFollower({ rootInput: root, repoId: plan.repoId, store: destination }),
      eventStore = {
        readHead: () => {
          const last = actual.at(-1);
          return last ? { revision: last.revision, eventDigest: last.digest } : null;
        },
        readContentBlob: destination.readContentObject,
        readBatch: (cursor: string | null, maxItems: number) => {
          const offset = Number(cursor ?? 0),
            batch = destination.eventsAfter(offset, maxItems),
            end = offset + batch.length,
            done = end === actual.length;
          return {
            sourceRevision: actual.length,
            events: batch,
            cursor: done ? null : String(end),
            done,
            accessedItems: batch.length,
            prefetchContent: (selected: readonly CanonicalEventV1[]) =>
              new Map(
                selected.flatMap((event) =>
                  contentClaims(event).map(
                    (claim) => [claim.sha256, destination.readContentObject(claim.sha256)] as const,
                  ),
                ),
              ),
          };
        },
      },
      projection = makeTaskProjection({
        rootDir: root,
        eventStore,
        projectionPath: path.join(root, ".harness", "cache", "generation-2-verification.sqlite"),
      });
    let rebuild;
    try {
      const first = projection.rebuild();
      rebuild = projection.rebuild();
      if (first.stateDigest !== rebuild.stateDigest || rebuild.watermark !== events.length)
        throw new Error("generation 2 cold rebuild differs at the converted cut");
    } finally {
      projection.close();
    }
    return {
      matches: true as const,
      gitCommit: git.commitSha,
      projection: rebuild,
      sourceEvents: rows.length,
      convertedEvents: actual.length,
      retainedEvents: plan.retainedEvents,
      commandOutcomes: destination.outcomes().length,
      contentObjects: destination.contentObjectDigests().length,
      recordedAtPreserved: true as const,
    };
  } finally {
    destination.close();
    retained.close();
  }
}
