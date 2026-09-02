/**
 * Dispatch artifacts cannot recover the ingress idempotency key, so imported dispatch events use
 * `dispatch-record-migration:<dispatchId>`. This intentionally differs from ingress's repo-scoped
 * hash derivation; the migration marker's `migratedFrom` value preserves the construction source.
 *
 * The cancelled opId suffix also differs from production's hashed `runtime-cancel-*` form. Existing
 * cancelled sessions are terminal before migration planning, so that branch is not reachable for a
 * partially projected session; the suffix remains only for a wholly absent historical sequence.
 */
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runtimeArchiveText,
  runtimeDefinitionSnapshotArtifact,
  validateCurrentAgentRuntimeEvent,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type RuntimeSession,
} from "../domain/agent-runtime.ts";
import type { ActorIdentity } from "../domain/actor-identity.ts";
import { migrationImportWritePlan, type MigrationImportEventV1 } from "../domain/migration-import-event.ts";
import type { WriteReceiptDraft } from "../domain/receipt-domain-registry.ts";
import type { WriteSource } from "../domain/write-chain.contract.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection-factory.ts";
import type { TaskProjection } from "../projection/task-projection-port.ts";
import { canonicalEventWritePlan } from "./task-event-store-contract.ts";
import { canonicalDocumentClaims } from "./task-event-store-claims-layout.ts";
import type { CanonicalEventStore } from "./task-event-store-types.ts";

export interface DispatchRecordLeaseSettlement {
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly leaseVersion: number;
  readonly endedAt: string;
}

export interface DispatchRecordMigrationInput {
  readonly dryRun: boolean;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly rootDir: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly settleLease: (settlement: DispatchRecordLeaseSettlement) => Promise<void>;
}

type DispatchRecordAction = "import-full" | "settle-tail" | "settle-lease-only" | `skip:${string}`;

interface RuntimeDispatchRecordV1 {
  readonly schema: "runtime-dispatch/v1";
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  readonly runtimeSessionId: string;
  readonly providerSessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled";
  readonly exitCode: number | null;
  readonly resultRef: string;
  readonly eventStreamRef: string;
}

interface RecoveredResult {
  readonly body: string;
  readonly sourceRef: string;
  readonly claim: {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: "text/plain; charset=utf-8";
  };
}

type RuntimeEventType = AgentRuntimeEventV1["type"];
type RuntimeEventPayload<T extends RuntimeEventType> = Extract<AgentRuntimeEventV1, { readonly type: T }>["payload"];

type PlannedRuntimeEvent = {
  [T in RuntimeEventType]: {
    readonly type: T;
    readonly opId: string;
    readonly occurredAt: string;
    readonly actor: ActorIdentity;
    readonly payload: RuntimeEventPayload<T>;
    readonly body?: string;
  };
}[RuntimeEventType];

interface PlannedDispatch {
  readonly sourcePath: string;
  readonly sourceBody: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string | null;
  readonly taskId: string | null;
  readonly executionId: string | null;
  readonly startedAt: string | null;
  readonly action: DispatchRecordAction;
  readonly events: readonly PlannedRuntimeEvent[];
  readonly settlement: DispatchRecordLeaseSettlement | null;
  readonly sourceResultRef: string | null;
  readonly recoveredResultRef: string | null;
  readonly resultBlobMissing: boolean;
}

export async function runDispatchRecordMigration(input: DispatchRecordMigrationInput): Promise<WriteReceiptDraft> {
  if (!input.dryRun) await input.store.settlePendingMaterialization?.("dispatch-records migration");
  const headRevision = input.store.readHead()?.revision ?? 0,
    gitRevision = input.store.revisionAt(input.store.currentCommit()) ?? 0,
    planned = planDispatchRecords(input, headRevision),
    report = migrationReport(headRevision, gitRevision, planned),
    reportBody = `${JSON.stringify(report, null, 2)}\n`,
    reportDigest = sha256Text(reportBody),
    sourceDigest = sha256Text(
      stableStringify(planned.map(({ sourcePath, sourceBody }) => ({ sourcePath, sourceBody }))),
    ),
    markerOpId = `op_${sha256Text(`dispatch-records\0${sourceDigest}`)}`,
    actionable = planned.filter(
      (entry) =>
        entry.action === "import-full" || entry.action === "settle-tail" || entry.action === "settle-lease-only",
    );
  if (input.dryRun || actionable.length === 0)
    return migrationPreview(headRevision, markerOpId, report, actionable.length);
  if (gitRevision !== headRevision)
    throw new Error(
      `dispatch-records migration requires the WAL to be settled into Git first ` +
        `(head ${headRevision}, Git ${gitRevision})`,
    );
  let appendedEvents = 0,
    releasedLeases = 0;
  for (const entry of actionable) {
    for (const event of entry.events) {
      if (appendRuntimeEvent(input, event)) appendedEvents += 1;
    }
    if (entry.settlement) {
      await input.settleLease(entry.settlement);
      releasedLeases += 1;
    }
  }
  const marker = migrationMarker(input, markerOpId, reportDigest, reportBody, sourceDigest),
    bundle = {
      event: marker,
      plan: migrationImportWritePlan(marker),
      blobs: [
        {
          sha256: reportDigest,
          size: Buffer.byteLength(reportBody),
          mediaType: "application/json",
          body: reportBody,
        },
      ],
    },
    appended = input.store.append(bundle),
    publication = input.store.publication(marker);
  input.projection.apply(marker, bundle.plan);
  const visible = publication.cut.opId === marker.opId && publication.cut.revision === marker.workspaceRevision;
  return {
    outcome: visible ? "applied" : "pending",
    opId: marker.opId,
    revision: appended.revision,
    evidence: JSON.stringify({ ...report, appliedEvents: appendedEvents, releasedLeases }),
    visibility: "center",
    proof: {
      committedRevision: appended.revision,
      appliedCut: publication.cut.revision,
      durable: true,
      canonicalVisible: visible,
      worktreeVisible: true,
    },
    commitSha: appended.commitSha?.sha ?? null,
    cut: appended.cut,
    ...(!visible
      ? { nextAction: `Query receipt ${marker.opId} after canonical publication catches up.` }
      : {
          nextAction:
            `Recovered ${actionable.length} dispatch record(s) with ${appendedEvents} runtime event(s) ` +
            `and ${releasedLeases} lease release(s). Run ha daemon projection rebuild before continuing replay.`,
        }),
  };
}

function planDispatchRecords(input: DispatchRecordMigrationInput, headRevision: number): readonly PlannedDispatch[] {
  const scratchPath = path.join(tmpdir(), `ha-dispatch-records-${process.pid}-${Date.now()}.sqlite`),
    projection = makeTaskProjection({
      rootDir: input.rootDir,
      eventStore: input.store,
      projectionPath: scratchPath,
    });
  try {
    const rebuilt = projection.rebuild();
    if (rebuilt.watermark !== headRevision)
      throw new Error(
        `dispatch-records migrating replay stalled at revision ${rebuilt.watermark} before ${headRevision}`,
      );
    const documents = [...readDispatchDocuments(input.store, projection)].sort(dispatchDocumentOrder),
      seenRuntimeSessionIds = new Set<string>();
    return documents.map((document) =>
      planDispatchDocument(input.store, projection, input.actor, document, seenRuntimeSessionIds),
    );
  } finally {
    projection.close();
    for (const suffix of ["", "-wal", "-shm"]) localRuntimeStateFileSystem.remove(`${scratchPath}${suffix}`);
  }
}

function readDispatchDocuments(
  store: CanonicalEventStore,
  projection: TaskProjection,
): readonly { readonly sourcePath: string; readonly sourceBody: string }[] {
  const paths = new Set(
    store
      .read()
      .events.flatMap((event) => canonicalDocumentClaims(event).map(({ path: sourcePath }) => sourcePath))
      .filter((sourcePath) => /^tasks\/[^/]+\/artifacts\/dispatches\/[^/]+\.json$/u.test(sourcePath)),
  );
  return [...paths].sort().flatMap((sourcePath) => {
    const document = projection.readDocument(sourcePath).document;
    return document === null ? [] : [{ sourcePath, sourceBody: document.body }];
  });
}

function planDispatchDocument(
  store: CanonicalEventStore,
  projection: TaskProjection,
  actor: ActorIdentity,
  document: { readonly sourcePath: string; readonly sourceBody: string },
  seenRuntimeSessionIds: Set<string>,
): PlannedDispatch {
  let raw: unknown;
  try {
    raw = JSON.parse(document.sourceBody);
  } catch {
    return skipped(document, "invalid-json");
  }
  const record = runtimeDispatchRecord(raw);
  if (record === null) return skipped(document, "schema-mismatch", raw);
  if (seenRuntimeSessionIds.has(record.runtimeSessionId)) return skipped(document, "duplicate-session", record);
  seenRuntimeSessionIds.add(record.runtimeSessionId);
  const identity = {
    dispatchId: record.dispatchId,
    runtimeSessionId: record.runtimeSessionId,
    taskId: record.taskId,
    executionId: record.executionId,
    startedAt: record.startedAt,
  };
  const task = projection.read(record.taskId).snapshot;
  if (!task.task) return skipped(document, "task-not-found", record);
  if (!task.executions.some(({ executionId }) => executionId === record.executionId))
    return skipped(document, "execution-not-found", record);
  const session = projection.readRuntimeSession(record.runtimeSessionId),
    settlement = leaseSettlement(projection, record);
  if (session !== null) {
    if (!matchingTaskBinding(session, record)) return skipped(document, "session-binding-mismatch", record);
    if (session.liveness === "exited" && session.outcome !== null)
      return settlement === null
        ? skipped(document, "already-settled", record)
        : {
            ...document,
            ...identity,
            action: "settle-lease-only",
            events: [],
            settlement,
            sourceResultRef: record.resultRef,
            recoveredResultRef: null,
            resultBlobMissing: store.readContentBlob(resultHash(record)) === null,
          };
    if (session.liveness !== "unknown" || session.outcome !== null)
      return skipped(document, "session-not-settleable", record);
    const result = recoveredResult(store, projection, document.sourcePath, record);
    if (result === null) return skipped(document, "result-content-missing", record, true);
    return {
      ...document,
      ...identity,
      action: "settle-tail",
      events: terminalEvents(record, actor, result),
      settlement,
      sourceResultRef: result.sourceRef,
      recoveredResultRef: result.sourceRef,
      resultBlobMissing: false,
    };
  }
  const definitionMatch = matchingDefinition(projection, record);
  if (definitionMatch.kind !== "found") return skipped(document, `definition-${definitionMatch.kind}`, record);
  const definition = definitionMatch.definition,
    definitionArtifact = runtimeDefinitionSnapshotArtifact(definition.snapshot);
  if (definitionArtifact.ref !== definition.ref) return skipped(document, "runtime-definition-content-invalid", record);
  const result = recoveredResult(store, projection, document.sourcePath, record);
  if (result === null) return skipped(document, "result-content-missing", record, true);
  return {
    ...document,
    ...identity,
    action: "import-full",
    events: fullEvents(record, actor, definition, definitionArtifact.body, result),
    settlement,
    sourceResultRef: result.sourceRef,
    recoveredResultRef: result.sourceRef,
    resultBlobMissing: false,
  };
}

function skipped(
  document: { readonly sourcePath: string; readonly sourceBody: string },
  reason: string,
  raw?: unknown,
  resultBlobMissing = false,
): PlannedDispatch {
  const record = isRecord(raw) ? raw : {};
  return {
    ...document,
    dispatchId: typeof record.dispatchId === "string" ? record.dispatchId : path.basename(document.sourcePath, ".json"),
    runtimeSessionId: typeof record.runtimeSessionId === "string" ? record.runtimeSessionId : null,
    taskId: typeof record.taskId === "string" ? record.taskId : null,
    executionId: typeof record.executionId === "string" ? record.executionId : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    action: `skip:${reason}`,
    events: [],
    settlement: null,
    sourceResultRef: typeof record.resultRef === "string" ? record.resultRef : null,
    recoveredResultRef: null,
    resultBlobMissing,
  };
}

function dispatchDocumentOrder(
  left: { readonly sourcePath: string; readonly sourceBody: string },
  right: { readonly sourcePath: string; readonly sourceBody: string },
): number {
  return (
    dispatchStartedAt(left.sourceBody) - dispatchStartedAt(right.sourceBody) ||
    left.sourcePath.localeCompare(right.sourcePath)
  );
}

function dispatchStartedAt(sourceBody: string): number {
  try {
    const value = JSON.parse(sourceBody) as unknown;
    return isRecord(value) && typeof value.startedAt === "string"
      ? Date.parse(value.startedAt)
      : Number.POSITIVE_INFINITY;
  } catch (error) {
    consumeKnownError(error);
    return Number.POSITIVE_INFINITY;
  }
}

function runtimeDispatchRecord(value: unknown): RuntimeDispatchRecordV1 | null {
  if (!isRecord(value) || value.schema !== "runtime-dispatch/v1") return null;
  const strings = [
      value.dispatchId,
      value.taskId,
      value.executionId,
      value.instanceId,
      value.model,
      value.runtimeSessionId,
      value.providerSessionId,
      value.startedAt,
      value.endedAt,
      value.resultRef,
    ],
    validIds =
      /^dispatch_[0-9a-f]{24}$/u.test(String(value.dispatchId)) &&
      /^runtime_[0-9a-f]{24}$/u.test(String(value.runtimeSessionId)),
    validTimestamps =
      typeof value.startedAt === "string" &&
      typeof value.endedAt === "string" &&
      Number.isFinite(Date.parse(value.startedAt)) &&
      Number.isFinite(Date.parse(value.endedAt)) &&
      Date.parse(value.startedAt) <= Date.parse(value.endedAt),
    validOutcome = ["succeeded", "failed", "unknown", "cancelled"].includes(String(value.outcome));
  if (
    strings.some((entry) => typeof entry !== "string" || entry.length === 0) ||
    !validIds ||
    !validTimestamps ||
    !validOutcome ||
    (value.reasoningEffort !== null && (typeof value.reasoningEffort !== "string" || !value.reasoningEffort)) ||
    (value.fast !== undefined && typeof value.fast !== "boolean") ||
    (value.exitCode !== null && (!Number.isInteger(value.exitCode) || Number(value.exitCode) < 0)) ||
    !/^artifact:runtime-result\/sha256\/[0-9a-f]{64}$/u.test(String(value.resultRef)) ||
    (value.eventStreamRef !== undefined && !/^file:[^\r\n]+$/u.test(String(value.eventStreamRef)))
  )
    return null;
  return {
    ...value,
    fast: value.fast === true,
    eventStreamRef:
      typeof value.eventStreamRef === "string"
        ? value.eventStreamRef
        : `file:.harness/runtime/dispatches/${String(value.dispatchId)}.jsonl`,
  } as unknown as RuntimeDispatchRecordV1;
}

function recoveredResult(
  store: CanonicalEventStore,
  projection: TaskProjection,
  sourcePath: string,
  record: RuntimeDispatchRecordV1,
): RecoveredResult | null {
  const sourceHash = resultHash(record),
    existing = store.readContentBlob(sourceHash),
    existingBody = existing === null ? null : utf8(existing);
  if (existingBody !== null && sha256Text(existingBody) === sourceHash) return result(record.resultRef, existingBody);
  const reportPath = sourcePath.replace("/artifacts/dispatches/", "/artifacts/reports/").replace(/\.json$/u, ".md"),
    reportBody = projection.readDocument(reportPath).document?.body,
    normalized = reportBody === undefined ? null : runtimeArchiveText(reportBody);
  return normalized !== null && sha256Text(normalized) === sourceHash ? result(record.resultRef, normalized) : null;
}

function result(sourceRef: string, body: string): RecoveredResult {
  const sha256 = sha256Text(body);
  return {
    body,
    sourceRef,
    claim: {
      sha256,
      size: Buffer.byteLength(body),
      mediaType: "text/plain; charset=utf-8",
    },
  };
}

function resultHash(record: RuntimeDispatchRecordV1): string {
  return record.resultRef.slice("artifact:runtime-result/sha256/".length);
}

type DefinitionMatch =
  | {
      readonly kind: "found";
      readonly definition: { readonly ref: string; readonly snapshot: AgentDefinitionSnapshot };
    }
  | { readonly kind: "not-found" | "ambiguous" };

function matchingDefinition(projection: TaskProjection, record: RuntimeDispatchRecordV1): DefinitionMatch {
  const matches = projection
    .readRuntimeDispatches()
    .filter(({ occurredAt, payload }) => {
      const snapshot = payload.definitionSnapshot;
      return (
        Date.parse(occurredAt) <= Date.parse(record.startedAt) &&
        snapshot.instanceId === record.instanceId &&
        snapshot.model === record.model &&
        snapshot.reasoningEffort === record.reasoningEffort &&
        (snapshot.fast ?? false) === record.fast &&
        projection.readRuntimeInstallation(snapshot.installationId) !== null
      );
    })
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  if (matches.length === 0) return { kind: "not-found" };
  const latestAt = Date.parse(matches[0]!.occurredAt),
    latest = matches
      .filter(({ occurredAt }) => Date.parse(occurredAt) === latestAt)
      .map(({ payload }) => ({ ref: payload.definitionSnapshotRef, snapshot: payload.definitionSnapshot })),
    unique = [...new Map(latest.map((candidate) => [stableStringify(candidate), candidate] as const)).values()];
  return unique.length === 1 ? { kind: "found", definition: unique[0]! } : { kind: "ambiguous" };
}

function matchingTaskBinding(session: RuntimeSession, record: RuntimeDispatchRecordV1): boolean {
  return session.taskBindings.some(
    ({ taskId, executionId }) => taskId === record.taskId && executionId === record.executionId,
  );
}

function leaseSettlement(
  projection: TaskProjection,
  record: RuntimeDispatchRecordV1,
): DispatchRecordLeaseSettlement | null {
  const lease = projection.currentLease(record.taskId, record.endedAt),
    executor = lease?.actor.executor;
  return lease &&
    lease.phase === "held" &&
    lease.executionId === record.executionId &&
    executor?.kind === "agent" &&
    executor.id === `runtime-session:${record.runtimeSessionId}`
    ? {
        dispatchId: record.dispatchId,
        runtimeSessionId: record.runtimeSessionId,
        taskId: record.taskId,
        executionId: record.executionId,
        leaseVersion: lease.version,
        endedAt: record.endedAt,
      }
    : null;
}

function fullEvents(
  record: RuntimeDispatchRecordV1,
  actor: ActorIdentity,
  definition: { readonly ref: string; readonly snapshot: AgentDefinitionSnapshot },
  definitionBody: string,
  recovered: RecoveredResult,
): readonly PlannedRuntimeEvent[] {
  const base = dispatchOpId(record),
    dispatcher = { principal: actor.principal, executor: null } as const,
    prefix: readonly PlannedRuntimeEvent[] = [
      plannedEvent(
        "runtime_dispatch_requested",
        base,
        record.startedAt,
        dispatcher,
        {
          dispatchId: record.dispatchId,
          runtimeSessionId: record.runtimeSessionId,
          instanceId: definition.snapshot.instanceId,
          installationId: definition.snapshot.installationId,
          kindId: definition.snapshot.kindId,
          idempotencyKey: `dispatch-record-migration:${record.dispatchId}`,
          definitionSnapshotRef: definition.ref,
          definitionSnapshot: definition.snapshot,
        },
        definitionBody,
      ),
      plannedEvent("runtime_session_started", `${base}-started`, record.startedAt, dispatcher, {
        runtimeSessionId: record.runtimeSessionId,
        instanceId: definition.snapshot.instanceId,
        installationId: definition.snapshot.installationId,
        kindId: definition.snapshot.kindId,
        definitionSnapshotRef: definition.ref,
        launchGeneration: 0,
        attachable: true,
      }),
      plannedEvent("runtime_session_liveness_changed", `${base}-live`, record.startedAt, dispatcher, {
        runtimeSessionId: record.runtimeSessionId,
        liveness: "live",
      }),
      plannedEvent("runtime_session_provider_bound", `${base}-provider`, record.startedAt, dispatcher, {
        runtimeSessionId: record.runtimeSessionId,
        providerSessionId: record.providerSessionId,
        transcriptRef: record.eventStreamRef,
      }),
      plannedEvent("runtime_session_task_bound", `${base}-task`, record.startedAt, dispatcher, {
        runtimeSessionId: record.runtimeSessionId,
        taskId: record.taskId,
        executionId: record.executionId,
        providerSessionId: record.providerSessionId,
        transcriptRef: record.eventStreamRef,
      }),
    ];
  return [...prefix, ...terminalEvents(record, actor, recovered)];
}

function terminalEvents(
  record: RuntimeDispatchRecordV1,
  actor: ActorIdentity,
  recovered: RecoveredResult,
): readonly PlannedRuntimeEvent[] {
  const base = dispatchOpId(record),
    terminalActor = {
      principal: actor.principal,
      executor: { kind: "agent" as const, id: `runtime-session:${record.runtimeSessionId}` },
    },
    cancelled =
      record.outcome === "cancelled"
        ? [
            plannedEvent("runtime_session_cancelled", `${base}-cancelled`, record.endedAt, terminalActor, {
              runtimeSessionId: record.runtimeSessionId,
            }),
          ]
        : [];
  return [
    ...cancelled,
    plannedEvent("runtime_session_exited", `${base}-exited`, record.endedAt, terminalActor, {
      runtimeSessionId: record.runtimeSessionId,
    }),
    plannedEvent(
      "runtime_session_outcome_observed",
      `${base}-outcome`,
      record.endedAt,
      terminalActor,
      {
        runtimeSessionId: record.runtimeSessionId,
        outcome: record.outcome,
        exitCode: record.exitCode,
        resultRef: recovered.sourceRef,
        result: recovered.claim,
      },
      recovered.body,
    ),
  ];
}

function plannedEvent<T extends RuntimeEventType>(
  type: T,
  opId: string,
  occurredAt: string,
  actor: ActorIdentity,
  payload: RuntimeEventPayload<T>,
  body?: string,
): Extract<PlannedRuntimeEvent, { readonly type: T }> {
  return { type, opId, occurredAt, actor, payload, ...(body === undefined ? {} : { body }) } as Extract<
    PlannedRuntimeEvent,
    { readonly type: T }
  >;
}

function appendRuntimeEvent(input: DispatchRecordMigrationInput, planned: PlannedRuntimeEvent): boolean {
  const existing = input.store.readEvent(planned.opId);
  if (existing) {
    if (
      existing.schema !== "agent-runtime-event/v1" ||
      existing.type !== planned.type ||
      stableStringify(existing.payload) !== stableStringify(planned.payload)
    )
      throw new Error(`Runtime opId ${planned.opId} belongs to another canonical event.`);
    return false;
  }
  const event = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${sha256Text(planned.opId)}`,
      workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
      opId: planned.opId,
      type: planned.type,
      actor: planned.actor,
      source: input.source,
      occurredAt: planned.occurredAt,
      payload: planned.payload,
    } as AgentRuntimeEventV1,
    errors = validateCurrentAgentRuntimeEvent(event);
  if (errors.length) throw new Error(`Recovered runtime event ${planned.opId} is invalid: ${errors.join("; ")}`);
  const claims =
      event.type === "runtime_dispatch_requested"
        ? [runtimeDefinitionSnapshotArtifact(event.payload.definitionSnapshot).claim]
        : event.type === "runtime_session_outcome_observed"
          ? [event.payload.result]
          : [],
    blobs = claims.map((claim) => ({ ...claim, body: planned.body ?? "" }));
  input.store.append({
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs,
  });
  input.projection.apply(event);
  return true;
}

function dispatchOpId(record: RuntimeDispatchRecordV1): string {
  return `runtime-spawn-${record.dispatchId.slice("dispatch_".length)}${record.runtimeSessionId.slice(8, 16)}`;
}

function migrationMarker(
  input: DispatchRecordMigrationInput,
  opId: string,
  reportDigest: string,
  reportBody: string,
  sourceDigest: string,
): MigrationImportEventV1 {
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${sha256Text(opId)}`,
    workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
    opId,
    type: "entity_migrated",
    actor: input.actor,
    source: "migration-import/v1",
    occurredAt: input.now(),
    payload: {
      migratedFrom: `dispatch-records:${sourceDigest}`,
      generation: "v0",
      entity: {
        kind: "id-map",
        importId: `dispatch-records-${sourceDigest.slice(0, 16)}`,
        documentClaim: {
          path: `migrations/dispatch-records/${sourceDigest.slice(0, 16)}/report.json`,
          sha256: reportDigest,
          size: Buffer.byteLength(reportBody),
          mediaType: "application/json",
          policyId: "typed-migration-import/v1",
        },
      },
    },
  };
}

function migrationPreview(
  headRevision: number,
  markerOpId: string,
  report: ReturnType<typeof migrationReport>,
  actionable: number,
): WriteReceiptDraft {
  return {
    outcome: "pending",
    opId: `preview:${markerOpId}`,
    revision: headRevision,
    evidence: JSON.stringify(report),
    visibility: "center",
    proof: {
      committedRevision: headRevision,
      appliedCut: 0,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    nextAction:
      actionable === 0
        ? "Nothing to migrate: every dispatch record is already settled or was skipped."
        : "Remove --dry-run to publish the dispatch-records migration through the canonical event store.",
  };
}

function migrationReport(headRevision: number, gitRevision: number, planned: readonly PlannedDispatch[]) {
  const counts: Record<string, number> = {};
  for (const entry of planned) counts[entry.action] = (counts[entry.action] ?? 0) + 1;
  return {
    schema: "dispatch-record-migration-report/v1",
    migration: "dispatch-records",
    sourceRevision: headRevision,
    gitRevision,
    walPendingRevisions: headRevision - gitRevision,
    dispatchRecords: planned.length,
    plannedEvents: planned.reduce((total, entry) => total + entry.events.length, 0),
    plannedLeaseReleases: planned.filter(({ settlement }) => settlement !== null).length,
    categories: counts,
    dispatches: planned.map((entry) => ({
      sourcePath: entry.sourcePath,
      dispatchId: entry.dispatchId,
      runtimeSessionId: entry.runtimeSessionId,
      taskId: entry.taskId,
      executionId: entry.executionId,
      action: entry.action,
      sourceResultRef: entry.sourceResultRef,
      recoveredResultRef: entry.recoveredResultRef,
      resultBlobMissing: entry.resultBlobMissing,
      plannedEvents: entry.events.map(({ type }) => type),
      releaseLease: entry.settlement !== null,
    })),
  };
}

function utf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
