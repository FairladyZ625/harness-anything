import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { markdownH1 } from "./migration-import-tasks.ts";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  canonicalMigrationProvenance,
  compileFactWrite,
  consumeKnownError,
  makeTaskProjection,
  normalizePersistedCanonicalEvent,
  parseCanonicalEvent,
  readLegacyMigrationSource,
  readMarkdownSource,
  readScalar,
  resolveHarnessLayout,
  serializePersistedCanonicalEvent,
  sha256Text,
  stableStringify,
  taskEntryToRow,
  type CanonicalEventV1,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";
import { readMigrationProjectionOracleAtPath, type MigrationProjectionOracle } from "./migration-import-oracle.ts";
import { isMigrationImportRecord, migrationImportError, timestamp } from "./migration-import-report.ts";
import { restateTaskContract } from "./migration-import-task-restatement.ts";
import type { MigrationFormatObservation } from "./migration-import-types.ts";

export interface MigrationEventInspection {
  readonly events: readonly CanonicalEventV1[];
  readonly eventHeadRevision: number | null;
  readonly observations: readonly MigrationFormatObservation[];
  readonly syntheticBlobs: ReadonlyMap<string, Uint8Array>;
}

const migrationOracleActor = {
  principal: { personId: "migration-oracle" },
  executor: { kind: "agent", id: "migration-import" },
} as const;

/** Rebuilds only a disposable migration oracle. The source repository and its Git refs remain untouched. */
export function rebuildMigrationProjectionOracle(sourceRoot: string): MigrationProjectionOracle {
  const inspection = inspectMigrationSourceEvents(sourceRoot),
    rebuilt = inspection.events.length === 0 ? emptyOracle(inspection) : rebuildEventOracle(sourceRoot, inspection);
  return overlayAuthoredOracle(sourceRoot, rebuilt, inspection);
}

export function inspectMigrationSourceEvents(sourceRoot: string): MigrationEventInspection {
  const layout = resolveHarnessLayout(sourceRoot),
    eventsRoot = path.join(layout.authoredRoot, "events"),
    observations: MigrationFormatObservation[] = [],
    syntheticBlobs = new Map<string, Uint8Array>(),
    events: CanonicalEventV1[] = [];
  for (const file of jsonFiles(eventsRoot).filter((candidate) => path.basename(candidate) !== "head.json")) {
    const sourcePath = portable(path.relative(sourceRoot, file));
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    } catch (error) {
      consumeKnownError(error);
      throw migrationImportError("invalid_migration_source", `${sourcePath}: canonical event is not JSON.`);
    }
    const legacyTask = containsSchema(raw, "task/v1");
    let event: CanonicalEventV1;
    try {
      event = normalizePersistedCanonicalEvent(parseCanonicalEvent(`${stableStringify(raw)}\n`));
    } catch (error) {
      const normalized = normalizeKnownLegacyEvent(raw, syntheticBlobs);
      if (normalized === null) {
        consumeKnownError(error);
        throw migrationImportError(
          "unsupported_legacy_event",
          `${sourcePath}: ${error instanceof Error ? error.message : String(error)}. ` +
            `Preserve the source and report this event schema before retrying.`,
        );
      }
      event = normalized;
      observations.push({
        code: "legacy_event_normalized",
        sourcePath,
        detail: `normalized ${event.schema} to the current read contract for oracle replay`,
        treatment: "mechanically_normalized",
      });
    }
    if (legacyTask)
      observations.push({
        code: "legacy_event_normalized",
        sourcePath,
        detail: "restated embedded Task/v1 as Task/v2 with pinned=false and packageDisposition=active defaults",
        treatment: "mechanically_normalized",
      });
    event = normalizeScheduleFacet(sourceRoot, event, sourcePath, observations, syntheticBlobs);
    events.push(event);
  }
  events.sort((left, right) => left.workspaceRevision - right.workspaceRevision || left.opId.localeCompare(right.opId));
  const eventHeadRevision = readHeadRevision(eventsRoot) ?? events.at(-1)?.workspaceRevision ?? null;
  if (eventHeadRevision !== null && events.some((event) => event.workspaceRevision > eventHeadRevision))
    throw migrationImportError(
      "migration_projection_oracle_cut_mismatch",
      `Canonical event revision exceeds source head ${eventHeadRevision}.`,
    );
  return { events, eventHeadRevision, observations, syntheticBlobs };
}

function rebuildEventOracle(sourceRoot: string, inspection: MigrationEventInspection): MigrationProjectionOracle {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migration-oracle-")),
    databasePath = path.join(scratch, "task.sqlite"),
    sourceRevision = inspection.eventHeadRevision ?? inspection.events.at(-1)?.workspaceRevision ?? 0,
    readSourceBlob = sourceBlobReader(sourceRoot, inspection.syntheticBlobs),
    eventDigest = inspection.events.length
      ? (`sha256:${sha256Text(serializePersistedCanonicalEvent(inspection.events.at(-1)!))}` as const)
      : null;
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    const eventStore = {
      readHead: () => (sourceRevision === 0 || eventDigest === null ? null : { revision: sourceRevision, eventDigest }),
      readBatch: (cursor: string | null, maxItems: number) => {
        const start = cursor === null ? 0 : Number(cursor),
          batch = inspection.events.slice(start, start + maxItems),
          next = start + batch.length,
          done = next >= inspection.events.length;
        return {
          sourceRevision,
          events: batch,
          cursor: done ? null : String(next),
          done,
          accessedItems: batch.length,
          prefetchContent: (requested: readonly CanonicalEventV1[]) => {
            const hashes = new Set(requested.flatMap(contentHashes));
            return new Map([...hashes].map((hash) => [hash, readSourceBlob(hash)]));
          },
        };
      },
      readContentBlob: readSourceBlob,
    };
    projection = makeTaskProjection({ rootDir: scratch, projectionPath: databasePath, eventStore });
    projection.rebuild();
    projection.close();
    projection = undefined;
    return readMigrationProjectionOracleAtPath(sourceRoot, databasePath, "rebuilt-source", [
      ...inspection.observations,
      {
        code: "source_projection_rebuilt",
        sourcePath: ".harness/cache/task.sqlite",
        detail: `rebuilt a disposable oracle from ${inspection.events.length} committed canonical events`,
        treatment: "rebuilt_read_only",
      },
    ]);
  } catch (error) {
    consumeKnownError(error);
    throw migrationImportError(
      "migration_projection_rebuild_failed",
      `Could not rebuild the source oracle without modifying the source: ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
  } finally {
    projection?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

function overlayAuthoredOracle(
  sourceRoot: string,
  base: MigrationProjectionOracle,
  inspection: MigrationEventInspection,
): MigrationProjectionOracle {
  const layout = resolveHarnessLayout(sourceRoot),
    taskRead = readMarkdownSource(sourceRoot),
    cold = readLegacyMigrationSource(sourceRoot),
    tasks = new Map(base.tasks),
    decisions = new Map(base.decisions),
    facts = new Map(base.facts),
    relations = new Map(base.relations),
    executions = new Map(base.executions),
    entityKeys = new Set(base.entityKeys),
    firstTaskEvents = earliestTaskEvents(inspection.events);
  for (const entry of taskRead.entries) {
    const row = taskEntryToRow(sourceRoot, entry),
      occurredAt =
        timestamp(readScalar(entry.frontmatter, "  bindingCreatedAt")) ??
        timestamp(readScalar(entry.frontmatter, "bindingCreatedAt")) ??
        timestamp(readScalar(entry.frontmatter, "createdAt")),
      firstEvent =
        firstTaskEvents.get(row.taskId) ??
        (occurredAt ? { eventId: `authored:${row.taskId}`, occurredAt, workspaceRevision: 0 } : null),
      title = cleanScalar(readScalar(entry.frontmatter, "title")) || markdownH1(entry.body) || row.taskId,
      packagePath = portable(path.relative(layout.authoredRoot, path.dirname(entry.indexPath))),
      contract = restateTaskContract({
        sourceRoot,
        sourcePackageRoot: path.dirname(entry.indexPath),
        targetTaskId: row.taskId,
        targetPackagePath: packagePath,
        fallback: {
          title,
          taskClass: "standard",
          verticalId: row.vertical,
          presetId: row.preset,
          profileId: row.profile,
        },
      }),
      task = {
        schema: "task/v2",
        taskId: row.taskId,
        title,
        taskClass: "standard",
        status: row.canonicalStatus,
        graph: REPLAY_TASK_GRAPH,
        currentNode: row.canonicalStatus === "in_review" ? "review" : "implementation",
        iteration: 0,
        pinned: false,
        packageDisposition: row.packageDisposition,
        createdBy: migrationOracleActor,
        completionGateIds: [],
        presetSnapshotDigest: contract?.presetSnapshotDigest ?? null,
        ...(contract === null ? {} : { contractVersion: 1 as const }),
      };
    if (!tasks.has(row.taskId))
      tasks.set(row.taskId, {
        taskId: row.taskId,
        workspaceRevision: firstEvent?.workspaceRevision ?? 0,
        packagePath,
        snapshot: { task },
        firstEvent,
      });
    entityKeys.add(`task\0${row.taskId}`);
  }
  for (const decision of cold.decisions) {
    if (!decisions.has(decision.decisionId))
      decisions.set(decision.decisionId, {
        decisionId: decision.decisionId,
        workspaceRevision: 0,
        fields: {
          decision_id: decision.decisionId,
          state: decision.state,
          title: decision.title,
          question: decision.question,
          risk_tier: decision.riskTier ?? "medium",
          urgency: decision.urgency ?? "medium",
          vertical: decision.vertical ?? "software/coding",
          preset: decision.preset ?? "standard-task",
          decision_class: decision.decisionClass ?? "ordinary",
          applies_json: JSON.stringify({ modules: decision.moduleKeys, productLines: decision.productLineKeys }),
          proposer_json: JSON.stringify(migrationOracleActor.principal),
          arbiter_json: null,
          proposed_at: decision.proposedAt ?? null,
          decided_at: decision.decidedAt ?? null,
          provenance_json: JSON.stringify(decision.provenance ?? []),
        },
        chosen: decision.chosenRecords,
        rejected: decision.rejectedRecords,
        claims: decision.claimRecords,
      });
    entityKeys.add(`decision\0${decision.decisionId}`);
  }
  for (const fact of cold.facts) {
    if (!facts.has(fact.factId))
      facts.set(fact.factId, {
        factId: fact.factId,
        workspaceRevision: 0,
        fields: {
          ...(fact.taskId ? { taskId: fact.taskId } : {}),
          factId: fact.factId,
          statement: fact.statement,
          evidenceSource: fact.source,
          observedAt: fact.observedAt,
          confidence: fact.confidence,
          memoryClass: fact.memoryClass,
          memoryTags: fact.memoryTags,
          provenance: fact.provenance,
        },
      });
    entityKeys.add(`fact\0${fact.factId}`);
  }
  for (const edge of cold.truth.edges) {
    if (!relations.has(edge.relationId))
      relations.set(edge.relationId, {
        relationId: edge.relationId,
        workspaceRevision: 0,
        row: edge,
        originalFields: { ...edge },
      });
  }
  for (const execution of legacyExecutions(layout.authoredRoot)) {
    if (!executions.has(execution.id))
      executions.set(execution.id, { executionId: execution.id, workspaceRevision: 0, fields: execution.fields });
    entityKeys.add(`execution\0${execution.id}`);
  }
  return {
    ...base,
    basis: "rebuilt-source",
    databasePath: "<rebuilt-from-committed-source>",
    tasks,
    decisions,
    facts,
    relations,
    executions,
    entityKeys,
    coverageCount: Math.max(
      base.coverageCount,
      cold.decisions.flatMap(({ claimRecords }) => claimRecords).filter(({ loadBearing }) => loadBearing).length,
    ),
  };
}

function emptyOracle(inspection: MigrationEventInspection): MigrationProjectionOracle {
  return {
    basis: "rebuilt-source",
    formatObservations: [
      ...inspection.observations,
      {
        code: "source_projection_rebuilt",
        sourcePath: ".harness/cache/task.sqlite",
        detail: "rebuilt a disposable oracle from committed authored packages (the source predates canonical events)",
        treatment: "rebuilt_read_only",
      },
    ],
    databasePath: "<rebuilt-from-committed-source>",
    watermark: 0,
    eventHeadRevision: inspection.eventHeadRevision,
    tasks: new Map(),
    decisions: new Map(),
    facts: new Map(),
    relations: new Map(),
    executions: new Map(),
    agents: new Map(),
    schedules: new Map(),
    runtimeSessions: new Map(),
    entityKeys: new Set(),
    coverageCount: 0,
  };
}

function normalizeKnownLegacyEvent(raw: unknown, syntheticBlobs: Map<string, Uint8Array>): CanonicalEventV1 | null {
  if (!isMigrationImportRecord(raw) || !isMigrationImportRecord(raw.payload)) return null;
  if (raw.schema === "fact-event/v1") {
    const payload = raw.payload;
    if (
      typeof raw.eventId !== "string" ||
      typeof raw.opId !== "string" ||
      !Number.isSafeInteger(raw.workspaceRevision) ||
      typeof raw.factId !== "string" ||
      typeof raw.occurredAt !== "string" ||
      !isMigrationImportRecord(raw.actor) ||
      !Array.isArray(payload.provenance)
    )
      return null;
    const legacySupersedes = isMigrationImportRecord(payload.supersedes) ? payload.supersedes : null,
      legacyFactId =
        typeof legacySupersedes?.factRef === "string"
          ? /(?:^|\/)(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(legacySupersedes.factRef)?.[1]
          : undefined;
    try {
      const compiled = compileFactWrite({
        event: {
          schema: "fact-event/v1",
          eventId: raw.eventId,
          workspaceRevision: raw.workspaceRevision as number,
          opId: raw.opId,
          ...(typeof raw.taskId === "string" ? { taskId: raw.taskId } : {}),
          factId: raw.factId,
          type: "fact_recorded",
          actor: raw.actor as never,
          source: raw.source as never,
          occurredAt: raw.occurredAt,
          payload: {
            statement: String(payload.statement),
            evidenceSource: String(payload.evidenceSource),
            observedAt: String(payload.observedAt),
            confidence: payload.confidence as never,
            memoryClass: payload.memoryClass as never,
            memoryTags: Array.isArray(payload.memoryTags) ? (payload.memoryTags as never) : [],
            provenance: canonicalMigrationProvenance(payload.provenance) as never,
            ...(legacyFactId && legacySupersedes
              ? {
                  supersedes: {
                    factRef: `fact/${legacyFactId}`,
                    rationale: String(legacySupersedes.rationale),
                  },
                }
              : {}),
          },
        },
      });
      syntheticBlobs.set(compiled.blobs[0].sha256, Buffer.from(compiled.blobs[0].body));
      return compiled.event;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  }
  if (raw.schema === "migration-import-event/v1" && isMigrationImportRecord(raw.payload.entity)) {
    const normalized = normalizePersistedCanonicalEvent(
      raw as unknown as PersistedCanonicalEventV1,
    ) as unknown as Record<string, unknown>;
    if (!isMigrationImportRecord(normalized.payload) || !isMigrationImportRecord(normalized.payload.entity))
      return null;
    const entity = normalized.payload.entity,
      currentEntity =
        entity.kind === "task"
          ? { ...entity, provenance: "imported_snapshot" }
          : entity.kind === "fact" && isMigrationImportRecord(entity.fact) && Array.isArray(entity.fact.provenance)
            ? { ...entity, fact: { ...entity.fact, provenance: canonicalMigrationProvenance(entity.fact.provenance) } }
            : entity,
      candidate = { ...normalized, payload: { ...normalized.payload, entity: currentEntity } };
    try {
      return normalizePersistedCanonicalEvent(
        parseCanonicalEvent(serializePersistedCanonicalEvent(candidate as unknown as PersistedCanonicalEventV1)),
      );
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  }
  return null;
}

function normalizeScheduleFacet(
  sourceRoot: string,
  event: CanonicalEventV1,
  sourcePath: string,
  observations: MigrationFormatObservation[],
  syntheticBlobs: Map<string, Uint8Array>,
): CanonicalEventV1 {
  if (event.schema !== "schedule-event/v1" || !("declarationDocumentClaim" in event.payload)) return event;
  const claim = event.payload.declarationDocumentClaim,
    readBlob = sourceBlobReader(sourceRoot, syntheticBlobs),
    bytes = readBlob(claim.sha256);
  if (bytes === null) return event;
  let actual: unknown;
  try {
    actual = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    consumeKnownError(error);
    return event;
  }
  const { status: _status, ...definition } = event.payload.schedule,
    expected = definition;
  if (stableStringify(actual) === stableStringify(expected)) return event;
  if (stableStringify(actual) !== stableStringify(event.payload.schedule)) return event;
  const body = `${JSON.stringify(expected, null, 2)}\n`,
    sha256 = sha256Text(body),
    next = {
      ...event,
      payload: {
        ...event.payload,
        declarationDocumentClaim: { ...claim, sha256, size: Buffer.byteLength(body) },
      },
    } as CanonicalEventV1;
  syntheticBlobs.set(sha256, Buffer.from(body));
  observations.push({
    code: "schedule_definition_facet_mismatch",
    sourcePath,
    detail:
      `accepted historical schedule ${event.entity.id}: ` +
      `declaration blob ${claim.sha256} contains the full schedule instead of only the definition facet`,
    treatment: "accepted_truth_gap",
  });
  return next;
}

function sourceBlobReader(sourceRoot: string, synthetic: ReadonlyMap<string, Uint8Array>) {
  const authoredRoot = resolveHarnessLayout(sourceRoot).authoredRoot;
  return (sha256: string): Uint8Array | null => {
    const held = synthetic.get(sha256);
    if (held !== undefined) return held;
    for (const candidate of [
      path.join(authoredRoot, "objects", "sha256", sha256),
      path.join(authoredRoot, "objects", "sha256", sha256.slice(0, 2), sha256.slice(2)),
    ])
      try {
        return readFileSync(candidate);
      } catch (error) {
        consumeKnownError(error);
      }
    return null;
  };
}

function contentHashes(event: CanonicalEventV1): readonly string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isMigrationImportRecord(value)) return;
    if (typeof value.sha256 === "string" && /^[0-9a-f]{64}$/u.test(value.sha256)) values.push(value.sha256);
    Object.values(value).forEach(visit);
  };
  visit(event);
  return [...new Set(values)];
}

function earliestTaskEvents(events: readonly CanonicalEventV1[]) {
  const rows = new Map<
    string,
    { readonly eventId: string; readonly occurredAt: string; readonly workspaceRevision: number }
  >();
  for (const event of events) {
    const taskId =
      "taskId" in event && typeof event.taskId === "string"
        ? event.taskId
        : event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task"
          ? event.payload.entity.task.taskId
          : null;
    if (taskId !== null && !rows.has(taskId))
      rows.set(taskId, {
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        workspaceRevision: event.workspaceRevision,
      });
  }
  return rows;
}

function legacyExecutions(authoredRoot: string): readonly {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
}[] {
  return files(path.join(authoredRoot, "tasks"))
    .filter((file) => /\/executions\/[^/]+\.md$/u.test(portable(file)))
    .flatMap((file) => {
      const body = readFileSync(file, "utf8");
      try {
        const fields = JSON.parse(body) as unknown;
        if (!isMigrationImportRecord(fields)) return [];
        const id = typeof fields.execution_id === "string" ? fields.execution_id : path.basename(file, ".md");
        return [{ id, fields }];
      } catch (error) {
        consumeKnownError(error);
        return [{ id: path.basename(file, ".md"), fields: { rawBody: body } }];
      }
    });
}

function jsonFiles(root: string): readonly string[] {
  return files(root).filter((file) => file.endsWith(".json"));
}

function files(root: string): readonly string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .flatMap((entry) => {
        const target = path.join(root, entry.name);
        return entry.isDirectory() ? files(target) : entry.isFile() ? [target] : [];
      })
      .sort();
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
}

function readHeadRevision(eventsRoot: string): number | null {
  try {
    const value = JSON.parse(readFileSync(path.join(eventsRoot, "head.json"), "utf8")) as unknown;
    return isMigrationImportRecord(value) && Number.isSafeInteger(value.revision) ? (value.revision as number) : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function containsSchema(value: unknown, schema: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsSchema(entry, schema));
  return isMigrationImportRecord(value)
    ? value.schema === schema || Object.values(value).some((entry) => containsSchema(entry, schema))
    : false;
}

function cleanScalar(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}
