import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { publishConvertedGeneration, readCertifiedGitFollower } from "./sqlite-task-event-publication.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import { ciRunObservationV3Migration, ciWorkflowVerificationMigration } from "./event-shape-migration.ts";
import {
  serializePersistedCanonicalEvent,
  validateCurrentCanonicalEvent,
} from "../domain/doc-sync-canonical-events.ts";
import type { CanonicalEventV1 } from "../domain/doc-sync-types.ts";
import type { MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem as files } from "../local/local-layout-file-system.ts";
import { drillLedgerBackup, readVerifiedLedgerBackup } from "./ledger-backup.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";
import { GenerationThreeMigration } from "./generation-three-migration.ts";
import {
  generationActivationPath,
  openSqliteEventStore,
  sqliteLedgerPath,
  type GenerationActivationV2,
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
  readonly sourceGeneration: number;
  readonly destinationGeneration: number;
  readonly sourceDigest: string;
  readonly sourceEvents: number;
  readonly convertedEvents: number;
  readonly retainedEvents: number;
  /** Converted one-to-one but carrying no new fact; kept so no later revision or cut is renumbered. */
  readonly preservedHistoricalEvents: number;
  readonly appendedInvalidations: number;
  readonly ready: boolean;
  readonly mappings: readonly GenerationConversionMapping[];
}

/** Offline operator entry. The input is a verified, self-contained backup, never a live repository. */
export function runGenerationConversion(input: {
  readonly backupDir: string;
  readonly mode: "dry-run" | "convert" | "verify" | "activate";
  readonly destinationRoot?: string;
}) {
  const backupDir = path.resolve(input.backupDir),
    manifest = readVerifiedLedgerBackup(backupDir),
    sourceGeneration = manifest.sqlite.generation;
  if (!sourceGeneration || sourceGeneration < 1)
    throw new Error("generation conversion requires a SQLite backup; legacy generation 0 uses the legacy converter");
  const destinationGeneration = sourceGeneration + 1,
    sourcePath = path.join(
      backupDir,
      "payload",
      ".harness",
      "store",
      "generations",
      String(sourceGeneration),
      "ledger.sqlite",
    );
  if (
    !manifest.files.some(
      (file) =>
        file.path === `.harness/store/generations/${sourceGeneration}/ledger.sqlite` && file.method === "vacuum-into",
    )
  )
    throw new Error(`generation ${sourceGeneration} conversion requires its SQLite backup`);
  const source = openSqliteEventStore({ databasePath: sourcePath, generation: sourceGeneration, readOnly: true });
  try {
    const { plan, events, rows, migratedBlobs } = planConversion(source, sourceGeneration, destinationGeneration);
    if (input.mode === "dry-run") return { plan, active: false as const };
    if (!plan.ready) return { plan, active: false as const };
    if (!input.destinationRoot || !path.isAbsolute(input.destinationRoot))
      throw new Error("conversion and verification require an absolute --destination outside the backup");
    const destinationRoot = path.resolve(input.destinationRoot),
      relative = path.relative(backupDir, destinationRoot);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".."))
      throw new Error("conversion destination must be outside the immutable backup");
    if (input.mode === "convert") {
      drillLedgerBackup({
        backupDir,
        shadowParent: path.dirname(destinationRoot),
        destinationRoot,
        verifiedManifest: manifest,
      });
      convert(source, destinationRoot, plan, events, rows, migratedBlobs);
    }
    // Activation follows verification, never precedes it: a destination that fails verification
    // must be left without a certificate, so no process can select it.
    const verification = verify(source, destinationRoot, plan, events, rows);
    if (input.mode !== "activate") return { plan, destinationRoot, verification, active: false as const };
    activateConvertedGeneration({ rootDir: destinationRoot, plan });
    return { plan, destinationRoot, verification, active: true as const };
  } finally {
    source.close();
  }
}

export function activateConvertedGeneration(input: {
  readonly rootDir: string;
  readonly plan: GenerationConversionPlan;
}): void {
  if (!input.plan.ready) throw new Error("cannot activate an unready generation conversion");
  const databasePath = sqliteLedgerPath(input.rootDir, input.plan.destinationGeneration),
    reportPath = `${databasePath}.conversion.json`;
  if (!files.exists(databasePath) || !files.exists(reportPath)) throw new Error("generation conversion is missing");
  // The offline converter stops being the writer here; otherwise its lease fences out the first
  // ordinary writer of the activated generation.
  const released = openSqliteEventStore({
    repoId: input.plan.repoId,
    databasePath,
    generation: input.plan.destinationGeneration,
  });
  try {
    released.releaseWriter(offlineConverterFence(input.plan.repoId));
  } finally {
    released.close();
  }
  retireConvertedSource(input.rootDir, input.plan);
  const activation: GenerationActivationV2 = {
      schema: "generation-activation/v2",
      repoId: input.plan.repoId,
      sourceDigest: input.plan.sourceDigest,
      importedPrefixRevision: input.plan.convertedEvents,
      generation: input.plan.destinationGeneration,
    },
    certificatePath = generationActivationPath(input.rootDir, input.plan.destinationGeneration),
    createCertificate =
      input.plan.destinationGeneration >= 3 ? files.createAtomicExclusiveText : files.createExclusiveText;
  if (!createCertificate(certificatePath, `${JSON.stringify(activation)}\n`)) {
    const existing = JSON.parse(files.readText(certificatePath));
    if (stableStringify(existing) !== stableStringify(activation))
      throw new Error(`generation ${input.plan.destinationGeneration} activation certificate differs`);
  }
}

function retireConvertedSource(rootDir: string, plan: GenerationConversionPlan): void {
  const sourcePath = sqliteLedgerPath(rootDir, plan.sourceGeneration),
    retiredPath = retiredSourceLedgerPath(rootDir, plan);
  if (files.exists(sourcePath)) {
    files.rename(sourcePath, retiredPath);
    for (const suffix of ["-wal", "-shm"])
      if (files.exists(`${sourcePath}${suffix}`)) files.rename(`${sourcePath}${suffix}`, `${retiredPath}${suffix}`);
    files.syncDirectory(path.dirname(sourcePath));
  } else if (!files.exists(retiredPath)) throw new Error("conversion source ledger is neither active nor retired");
  for (const candidate of [
    path.join(rootDir, ".harness", "cache", "task.sqlite"),
    path.join(rootDir, ".harness", "cache", "task.sqlite-wal"),
    path.join(rootDir, ".harness", "cache", "task.sqlite-shm"),
    path.join(rootDir, ".harness", "replica", "repos", plan.repoId),
  ]) {
    if (!files.exists(candidate)) continue;
    const retired = `${candidate}.retired-generation-${plan.destinationGeneration}`;
    if (files.exists(retired)) throw new Error(`retired derived state already exists: ${retired}`);
    files.rename(candidate, retired);
    files.syncDirectory(path.dirname(candidate));
  }
}

function retiredSourceLedgerPath(rootDir: string, plan: GenerationConversionPlan): string {
  return `${sqliteLedgerPath(rootDir, plan.sourceGeneration)}.retired-generation-${plan.destinationGeneration}`;
}

function offlineConverterFence(repoId: string) {
  return { repoId, holder: "offline-generation-converter", epoch: 1 };
}

function planConversion(source: SqliteEventStore, sourceGeneration: number, destinationGeneration: number) {
  const rows = source.eventRows(),
    outcomes = source.outcomes(),
    events: CanonicalEventV1[] = [],
    mappings: GenerationConversionMapping[] = [],
    installations = new Map<string, string>(),
    generationThree = sourceGeneration === 2 ? new GenerationThreeMigration(source) : null,
    migratedBlobs = new Map<string, Uint8Array>();
  for (const row of rows) {
    let candidate: CanonicalEventV1 | undefined;
    const reasons: string[] = [];
    let original: CanonicalEventV1;
    try {
      if (row.revision !== mappings.length + 1 || row.digest !== `sha256:${sha256Text(row.eventJson)}`)
        throw new Error("source revision or event digest differs");
      original = JSON.parse(row.eventJson) as CanonicalEventV1;
      if (
        original.opId !== row.opId ||
        original.workspaceRevision !== row.revision ||
        original.occurredAt !== row.occurredAt
      )
        throw new Error("source event identity or occurredAt column differs");
      if (!Number.isFinite(Date.parse(row.recordedAt))) throw new Error("source recordedAt is unavailable");
    } catch (error) {
      throw new Error(
        `source integrity check failed at revision ${row.revision}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    try {
      // Historical CI observations walk the same v1 → v2 → v3 chain replay applies.
      const verified = ciWorkflowVerificationMigration.rewrite(original)?.event ?? original,
        observed = ciRunObservationV3Migration.rewrite(verified)?.event ?? verified,
        migrated = generationThree?.rewrite(observed),
        event = migrated?.event ?? observed;
      for (const blob of migrated?.blobs ?? []) migratedBlobs.set(blob.sha256, new TextEncoder().encode(blob.body));
      reasons.push(...(migrated?.reasons ?? []));
      if (event.opId !== row.opId || event.workspaceRevision !== row.revision || event.occurredAt !== row.occurredAt)
        throw new Error("source event identity or occurredAt column differs");
      // Root's history ruling: these observations really happened, so generation 2 keeps them as
      // read-only history instead of dropping them and renumbering every later revision and cut.
      if (event.type === "runtime_session_liveness_changed")
        reasons.push("historical liveness observation preserved read-only; it cannot establish current liveness");
      else if (event.type === "runtime_session_provider_bound" || event.type === "runtime_session_task_bound")
        // Root ruled these binding facts are kept where they happened and never backfilled into the
        // earlier started cut, so they convert in place rather than being folded into a start event.
        reasons.push("historical session binding preserved read-only at its own cut; it is not backfilled");
      else if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_installation_observed") {
        const key = event.payload.installationId,
          value = stableStringify(event.payload);
        if (installations.get(key) === value)
          reasons.push("repeated installation observation preserved read-only; it adds no new installation fact");
        installations.set(key, value);
      }
      const issues = validateCurrentCanonicalEvent(event);
      if (issues.length) throw new Error(issues.join("; "));
      for (const claim of contentClaims(event)) {
        const bytes = migratedBlobs.get(claim.sha256) ?? source.readContentObject(claim.sha256);
        if (bytes && (bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256))
          throw new Error(`corrupt accepted content ${claim.sha256}`);
        if (!bytes) throw new Error(`missing accepted content ${claim.sha256}`);
      }
      const candidateEvent = { ...event, workspaceRevision: events.length + 1 } as CanonicalEventV1;
      candidate = candidateEvent;
      // Preserving every source record keeps revisions aligned. Once anything is dropped, every
      // later cut and digest reference shifts, and a blind string rewrite cannot repair that.
      if (candidateEvent.workspaceRevision !== row.revision)
        throw new Error("a dropped earlier record shifted this revision/cut; it requires an explicit mapping");
    } catch (error) {
      consumeKnownError(error);
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.startsWith("corrupt accepted content ")) throw error;
      reasons.push(reason);
      candidate = historicalWitness(original, row, source);
      reasons.push("source-witness-only: original event bytes retained as a read-only content object");
    }
    if (candidate) events.push(candidate);
    mappings.push({
      sourceRevision: row.revision,
      sourceOpId: row.opId,
      sourceDigest: row.digest,
      destinationRevision: candidate?.workspaceRevision ?? null,
      destinationOpId: candidate?.opId ?? null,
      destinationDigest: candidate ? `sha256:${sha256Text(serializePersistedCanonicalEvent(candidate))}` : null,
      disposition: candidate
        ? reasons.some((reason) => reason.startsWith("source-witness-only:"))
          ? "retained-read-only"
          : "converted"
        : "unsupported",
      reasons,
    });
  }
  const invalidations =
    generationThree?.invalidations(
      rows.length + 1,
      new Date(Date.parse(rows.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z") + 1).toISOString(),
    ) ?? [];
  for (const invalidation of invalidations) {
    events.push(invalidation.event);
    for (const blob of invalidation.blobs) migratedBlobs.set(blob.sha256, new TextEncoder().encode(blob.body));
  }
  const sourceSnapshot = {
    metadata: source.metadata(),
    rows,
    outcomes,
    objects: source.contentObjectDigests(),
  };
  const sourceDigest = `sha256:${sha256Text(stableStringify(sourceSnapshot))}`;
  const plan: GenerationConversionPlan = {
    schema: "generation-conversion-plan/v1",
    repoId: source.metadata().repoId,
    sourceGeneration,
    destinationGeneration,
    sourceDigest,
    sourceEvents: rows.length,
    convertedEvents: events.length,
    retainedEvents: mappings.filter((row) => row.disposition === "retained-read-only").length,
    preservedHistoricalEvents: mappings.filter(
      (row) => row.disposition === "converted" && row.reasons.some((reason) => reason.includes("preserved read-only")),
    ).length,
    appendedInvalidations: invalidations.length,
    ready: mappings.every((row) => row.disposition !== "unsupported"),
    mappings,
  };
  assertOutcomeCoverage(outcomes, rows);
  return { plan, events, rows, migratedBlobs };
}

function historicalWitness(
  original: CanonicalEventV1,
  row: SqliteEventRow,
  source: SqliteEventStore,
): MigrationImportEventV1 {
  const raw = new TextEncoder().encode(row.eventJson),
    sha256 = sha256Bytes(raw),
    sourcePath = `history/source-witness/${row.revision}-${row.opId}.json`;
  return {
    schema: "migration-import-event/v1",
    type: "entity_migrated",
    source: "migration-import/v1",
    eventId: `${original.eventId}-source-witness`,
    opId: original.opId,
    workspaceRevision: original.workspaceRevision,
    occurredAt: original.occurredAt,
    actor: original.actor,
    payload: {
      migratedFrom: `canonical-event/${row.revision}/${row.opId}`,
      generation: "v0",
      entity: {
        kind: "repo-document",
        nodeKind: "file",
        documentClaim: {
          path: sourcePath,
          sha256,
          size: raw.byteLength,
          mediaType: "application/json",
          policyId: "typed-migration-import/v1",
        },
        referencedContentClaims: historicalContentClaims(original, source),
        destinationPreimage: { nodeKind: "file", sha256, size: raw.byteLength },
      },
    },
  };
}

function historicalContentClaims(event: CanonicalEventV1, source: SqliteEventStore) {
  type Claim = { sha256: string; size: number; mediaType: string };
  let claims: readonly Claim[] = [];
  try {
    claims = contentClaims(event);
  } catch (error) {
    consumeKnownError(error);
  }
  // Legacy declarations predate ownedContent, but their accepted primary claim is still authoritative.
  const payload = event.payload as unknown as Record<string, unknown>;
  const candidates: unknown[] = [...claims, payload.declarationDocumentClaim, payload.decisionDocumentClaim];
  const result = new Map<string, Claim>();
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") continue;
    const claim = candidate as Claim;
    if (
      typeof claim.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(claim.sha256) ||
      !Number.isSafeInteger(claim.size) ||
      claim.size < 0 ||
      typeof claim.mediaType !== "string"
    )
      continue;
    const bytes = source.readContentObject(claim.sha256);
    if (!bytes) continue;
    if (bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
      throw new Error(`corrupt historical content ${claim.sha256}`);
    result.set(claim.sha256, { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType });
  }
  return [...result.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

function assertOutcomeCoverage(outcomes: ReturnType<SqliteEventStore["outcomes"]>, rows: readonly SqliteEventRow[]) {
  const covered = new Set<number>();
  for (const outcome of outcomes) {
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
  migratedBlobs: ReadonlyMap<string, Uint8Array>,
) {
  const destination = openSqliteEventStore({
      repoId: plan.repoId,
      rootInput: root,
      generation: plan.destinationGeneration,
      conversionSourceGeneration: plan.sourceGeneration,
    }),
    fence = offlineConverterFence(plan.repoId),
    byOpId = new Map(plan.mappings.map((mapping) => [mapping.sourceOpId, mapping]));
  try {
    destination.claimWriter(fence);
    const outcomes = source.outcomes();
    for (const outcome of outcomes) {
      const members = mappedMembers(byOpId, outcome.memberOpIds),
        converted = members.map((mapping) => events[mapping.destinationRevision! - 1]!),
        blobs = new Map(
          converted.flatMap((event, index) =>
            contentClaims(event).map((claim) => {
              const witness =
                members[index]!.disposition === "retained-read-only" &&
                event.schema === "migration-import-event/v1" &&
                event.payload.entity.kind === "repo-document" &&
                claim.sha256 === event.payload.entity.documentClaim.sha256;
              const body = witness
                ? new TextEncoder().encode(rows[members[index]!.sourceRevision - 1]!.eventJson)
                : (migratedBlobs.get(claim.sha256) ?? source.readContentObject(claim.sha256)!);
              return [claim.sha256, { ...claim, body }] as const;
            }),
          ),
        );
      destination.appendCommand({
        fence,
        intent: { opId: outcome.opId, intentDigest: outcome.intentDigest, summary: outcome.summary },
        events: converted,
        blobs: [...blobs.values()],
        ...(outcome.rejectionCode === null ? {} : { rejectionCode: outcome.rejectionCode }),
        historicalRecord: {
          recordedAt: outcome.recordedAt,
          eventRecordedAt: members.map((mapping) => rows[mapping.sourceRevision - 1]!.recordedAt),
        },
      });
    }
    for (const event of events.slice(rows.length)) {
      const blobs = contentClaims(event).map((claim) => ({
        ...claim,
        body: migratedBlobs.get(claim.sha256)!,
      }));
      destination.appendCommand({
        fence,
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(
            stableStringify({
              type: event.type,
              taskId: "taskId" in event ? event.taskId : null,
            }),
          )}`,
          summary: "Invalidate in-flight execution for generation migration",
        },
        events: [event],
        blobs,
        historicalRecord: { recordedAt: event.occurredAt, eventRecordedAt: [event.occurredAt] },
      });
    }
    publishConvertedGeneration({ rootInput: root, repoId: plan.repoId, store: destination });
    const reportPath = `${sqliteLedgerPath(root, plan.destinationGeneration)}.conversion.json`;
    if (!files.createExclusiveText(reportPath, `${JSON.stringify(plan, null, 2)}\n`))
      throw new Error("generation conversion report already exists");
  } finally {
    destination.close();
  }
}

function mappedMembers(byOpId: ReadonlyMap<string, GenerationConversionMapping>, memberOpIds: readonly string[]) {
  return memberOpIds.map((opId) => byOpId.get(opId)!).filter((mapping) => mapping.disposition !== "unsupported");
}

function verify(
  source: SqliteEventStore,
  root: string,
  plan: GenerationConversionPlan,
  events: readonly CanonicalEventV1[],
  rows: readonly SqliteEventRow[],
) {
  const destination = openSqliteEventStore({
      repoId: plan.repoId,
      rootInput: root,
      generation: plan.destinationGeneration,
      readOnly: true,
    }),
    retainedPath = files.exists(sqliteLedgerPath(root, plan.sourceGeneration))
      ? sqliteLedgerPath(root, plan.sourceGeneration)
      : retiredSourceLedgerPath(root, plan),
    retained = openSqliteEventStore({
      repoId: plan.repoId,
      databasePath: retainedPath,
      generation: plan.sourceGeneration,
      readOnly: true,
    }),
    byOpId = new Map(plan.mappings.map((mapping) => [mapping.sourceOpId, mapping]));
  try {
    const sourceOutcomes = source.outcomes(),
      destinationOutcomes = destination.outcomes();
    if (
      stableStringify(planConversion(retained, plan.sourceGeneration, plan.destinationGeneration).plan) !==
      stableStringify(plan)
    )
      throw new Error("retained generation differs from immutable source");
    const report = JSON.parse(files.readText(`${sqliteLedgerPath(root, plan.destinationGeneration)}.conversion.json`));
    if (stableStringify(report) !== stableStringify(plan))
      throw new Error("conversion report differs from source plan");
    const actual = destination.eventRows(),
      mappings = plan.mappings.filter((mapping) => mapping.disposition !== "unsupported");
    if (actual.length !== events.length || destination.revision() !== events.length)
      throw new Error("converted event count differs");
    for (const [index, event] of events.slice(0, rows.length).entries()) {
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
    for (const [offset, event] of events.slice(rows.length).entries()) {
      const row = actual[rows.length + offset]!;
      if (row.eventJson !== serializePersistedCanonicalEvent(event))
        throw new Error(`appended migration event differs at revision ${row.revision}`);
    }
    if (destinationOutcomes.length !== sourceOutcomes.length + plan.appendedInvalidations)
      throw new Error("command outcome count differs");
    for (const original of sourceOutcomes) {
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
        throw new Error(`generation ${plan.destinationGeneration} cold rebuild differs at the converted cut`);
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
      commandOutcomes: destinationOutcomes.length,
      contentObjects: destination.contentObjectDigests().length,
      recordedAtPreserved: true as const,
    };
  } finally {
    destination.close();
    retained.close();
  }
}
