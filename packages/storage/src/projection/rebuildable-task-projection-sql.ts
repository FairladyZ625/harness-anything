import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { isAgentRuntimeEvent } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type {
  CanonicalEventV1,
  PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { withReviewerQualifiedDispatchKey } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import type * as ReadSet from "@harness-anything/kernel/internal/domain/task-read-set.ts";
import { isRecord } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue, StatementSync } from "node:sqlite";
import {
  OPAQUE_TEXTUAL_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import type { DocumentState } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { ENTITY_CONTENT_POLICY_ID } from "@harness-anything/kernel/internal/domain/entity-owned-content.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import {
  readContentObject,
  readVerifiedContentObject,
  registerVerifiedContentBlobReader,
  verifiedContentBlobReaderFor,
} from "../store/content-objects.ts";
import {
  canonicalJson,
  hashCanonicalJsonTextFieldChunks,
  hashCanonicalJsonTextFieldChunksAsync,
} from "./iso-timestamp-sql.ts";

export { canonicalJson, hashCanonicalJsonTextFieldChunks, hashCanonicalJsonTextFieldChunksAsync };

export type ProjectionEventSourceErrorCode = "event_source_missing";

/** Strict L3 fail-closed error thrown when an indexed revision is missing from the canonical ledger. */
export class ProjectionEventSourceError extends Error {
  readonly code: ProjectionEventSourceErrorCode;
  readonly missingRevisions: readonly number[];

  constructor(missingRevisions: readonly number[], message?: string) {
    super(message ?? `canonical event payload is unavailable for indexed revision(s): ${missingRevisions.join(", ")}`);
    this.name = "ProjectionEventSourceError";
    this.code = "event_source_missing";
    this.missingRevisions = [...missingRevisions];
  }
}

export type BatchEventsByRevisionsReader = (
  revisions: readonly number[],
) => ReadonlyMap<number, PersistedCanonicalEventV1>;

export interface EventIndexRowValues {
  readonly op_id: string;
  readonly workspace_revision: number;
  readonly task_id: string | null;
  readonly event_schema: string | null;
  readonly event_type: string | null;
  readonly event_id: string | null;
  readonly occurred_at: string | null;
  readonly occurred_at_ms: number | null;
  readonly actor_person_id: string | null;
  readonly actor_executor_id: string | null;
  readonly source_node_id: string | null;
  readonly source_resolved_node_id: string | null;
  readonly source_runtime_session_id: string | null;
  readonly entity_id: string | null;
  readonly execution_id: string | null;
  readonly payload_task_id: string | null;
  readonly migration_created_at: string | null;
  readonly migration_entity_kind: string | null;
  readonly migrated_task_id: string | null;
  readonly migrated_task_pinned: 0 | 1;
  readonly pin_entity_ref: string | null;
  readonly task_transition_status: string | null;
  readonly runtime_session_id: string | null;
  readonly dispatch_id: string | null;
  readonly dispatch_key: string;
  readonly runtime_session_present: 0 | 1 | null;
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly squad_id: string | null;
  readonly attempt_group_id: string | null;
  readonly definition_snapshot_ref: string | null;
  readonly resumed_from_dispatch_id: string | null;
  readonly started_at: string | null;
  readonly dispatch_activity_at: string | null;
  readonly dispatch_activity_ms: number | null;
  readonly review_target_kind: string | null;
  readonly review_target_decision_id: string | null;
  readonly has_control_request: 0 | 1;
  readonly control_request_action: string | null;
  readonly has_control_receipt: 0 | 1;
  readonly control_receipt_request_op_id: string | null;
  readonly control_receipt_status: string | null;
  readonly has_control_receipt_steer_version: 0 | 1;
}

export const EVENT_INDEX_INSERT_COLUMN_NAMES = [
  "op_id",
  "workspace_revision",
  "task_id",
  "event_schema",
  "event_type",
  "event_id",
  "occurred_at",
  "occurred_at_ms",
  "actor_person_id",
  "actor_executor_id",
  "source_node_id",
  "source_resolved_node_id",
  "source_runtime_session_id",
  "entity_id",
  "execution_id",
  "payload_task_id",
  "migration_created_at",
  "migration_entity_kind",
  "migrated_task_id",
  "migrated_task_pinned",
  "pin_entity_ref",
  "task_transition_status",
  "runtime_session_id",
  "dispatch_id",
  "dispatch_key",
  "runtime_session_present",
  "agent_id",
  "agent_name",
  "squad_id",
  "attempt_group_id",
  "definition_snapshot_ref",
  "resumed_from_dispatch_id",
  "started_at",
  "dispatch_activity_at",
  "dispatch_activity_ms",
  "review_target_kind",
  "review_target_decision_id",
  "has_control_request",
  "control_request_action",
  "has_control_receipt",
  "control_receipt_request_op_id",
  "control_receipt_status",
  "has_control_receipt_steer_version",
] as const;

export const EVENT_INDEX_INSERT_SQL =
  `INSERT INTO event_index(${EVENT_INDEX_INSERT_COLUMN_NAMES.join(", ")}) ` +
  `VALUES (${EVENT_INDEX_INSERT_COLUMN_NAMES.map(() => "?").join(", ")})`;

/** Canonical deterministic witness columns for `readStateDigest()` (excludes disposable `runtime_session_present`). */
export const EVENT_INDEX_STATE_DIGEST_COLUMNS = EVENT_INDEX_INSERT_COLUMN_NAMES.filter(
  (column) => column !== "runtime_session_present",
).join(",");

export const EVENT_INDEX_TABLE_SQL = `
    /* @gate-identity state-store/task.projection.event_index */ CREATE TABLE IF NOT EXISTS event_index (
      op_id TEXT PRIMARY KEY,
      workspace_revision INTEGER NOT NULL UNIQUE,
      task_id TEXT,
      event_schema TEXT,
      event_type TEXT,
      event_id TEXT,
      occurred_at TEXT,
      occurred_at_ms INTEGER,
      actor_person_id TEXT,
      actor_executor_id TEXT,
      source_node_id TEXT,
      source_resolved_node_id TEXT,
      source_runtime_session_id TEXT,
      entity_id TEXT,
      execution_id TEXT,
      payload_task_id TEXT,
      migration_created_at TEXT,
      migration_entity_kind TEXT,
      migrated_task_id TEXT,
      migrated_task_pinned INTEGER NOT NULL DEFAULT 0,
      pin_entity_ref TEXT,
      task_transition_status TEXT,
      runtime_session_id TEXT,
      dispatch_id TEXT,
      dispatch_key TEXT,
      runtime_session_present INTEGER,
      agent_id TEXT,
      agent_name TEXT,
      squad_id TEXT,
      attempt_group_id TEXT,
      definition_snapshot_ref TEXT,
      resumed_from_dispatch_id TEXT,
      started_at TEXT,
      dispatch_activity_at TEXT,
      dispatch_activity_ms INTEGER,
      review_target_kind TEXT,
      review_target_decision_id TEXT,
      has_control_request INTEGER NOT NULL DEFAULT 0,
      control_request_action TEXT,
      has_control_receipt INTEGER NOT NULL DEFAULT 0,
      control_receipt_request_op_id TEXT,
      control_receipt_status TEXT,
      has_control_receipt_steer_version INTEGER NOT NULL DEFAULT 0
    )`;

function asEventScalarString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function parseEventTimestampMs(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * Extract all scalar `event_index` columns deterministically from one accepted event JSON string.
 * Shared across incremental apply, cold rebuild, and v40→v41 in-place upgrade so all three produce
 * byte-identical rows and `stateDigest` without redundant per-write SHA-256 hashing.
 */
export function extractEventIndexRow(input: {
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly taskId: string | null;
  readonly eventJson: string;
  readonly parsedEvent?: Readonly<Record<string, unknown>>;
  readonly runtimeSessionPresent: 0 | 1 | null;
}): EventIndexRowValues {
  const raw: unknown = input.parsedEvent ?? JSON.parse(input.eventJson);
  const event = isRecord(raw) ? raw : {},
    schema = asEventScalarString(event.schema),
    type = asEventScalarString(event.type),
    eventId = asEventScalarString(event.eventId),
    occurredAt = asEventScalarString(event.occurredAt),
    occurredAtMs = parseEventTimestampMs(occurredAt),
    actor = isRecord(event.actor) ? event.actor : null,
    principal = actor && isRecord(actor.principal) ? actor.principal : null,
    executor = actor && isRecord(actor.executor) ? actor.executor : null,
    actorPersonId = principal ? asEventScalarString(principal.personId) : null,
    actorExecutorId = executor ? asEventScalarString(executor.id) : null,
    source = event.source,
    sourceRecord = isRecord(source) ? source : null,
    sourceNodeId = sourceRecord ? asEventScalarString(sourceRecord.nodeId) : null,
    sourceResolvedNodeId =
      source === "local"
        ? "center"
        : sourceRecord && (sourceRecord.kind === "node" || sourceRecord.kind === "assignment")
          ? sourceNodeId && sourceNodeId.length > 0
            ? sourceNodeId
            : null
          : null,
    sourceRuntimeSessionId =
      typeof source === "string" && source.startsWith("runtime-session/") ? source.slice(16) : null,
    entity = isRecord(event.entity) ? event.entity : null,
    entityId = entity ? asEventScalarString(entity.id) : null,
    payload = isRecord(event.payload) ? event.payload : null;

  const isDispatch = schema === "agent-runtime-event/v1" && type === "runtime_dispatch_requested";
  const payloadExecution = payload && isRecord(payload.execution) ? payload.execution : null;
  const executionId =
    schema === "task-event/v1"
      ? payloadExecution
        ? asEventScalarString(payloadExecution.executionId)
        : null
      : payload
        ? asEventScalarString(payload.executionId)
        : null;
  const payloadTaskId = payload ? asEventScalarString(payload.taskId) : null;
  const migrationCreatedAt =
    schema === "migration-import-event/v1" && payload ? asEventScalarString(payload.createdAt) : null;
  const migrationEntity = payload && isRecord(payload.entity) ? payload.entity : null;
  const migrationEntityKind = migrationEntity ? asEventScalarString(migrationEntity.kind) : null;
  const migratedTask =
    migrationEntity && migrationEntityKind === "task" && isRecord(migrationEntity.task) ? migrationEntity.task : null;
  const migratedTaskId = migratedTask ? asEventScalarString(migratedTask.taskId) : null;
  const isEntityMigrated = type === "entity_migrated";
  const migratedTaskPinnedFlag = migratedTask?.pinned === true;
  const migratedTaskPinned: 0 | 1 = isEntityMigrated && migratedTaskPinnedFlag ? 1 : 0;
  const pinEntityRef = payload ? asEventScalarString(payload.entityRef) : null;
  const payloadTask = payload && isRecord(payload.task) ? payload.task : null;
  const taskTransitionStatus =
    type === "task_transitioned" && payloadTask ? asEventScalarString(payloadTask.status) : null;

  const runtimeSessionId = payload ? asEventScalarString(payload.runtimeSessionId) : null;
  const dispatchId = payload ? asEventScalarString(payload.dispatchId) : null;
  const rawDispatchKey = isDispatch && payload ? (payload.dispatchKey ?? payload.idempotencyKey) : undefined;
  const dispatchKey =
    !isDispatch || rawDispatchKey === undefined || rawDispatchKey === null ? "" : String(rawDispatchKey);
  const agentId = payload ? asEventScalarString(payload.agentId) : null;
  const agentName = payload ? asEventScalarString(payload.agentName) : null;
  const squadId = payload ? asEventScalarString(payload.squadId) : null;
  const attemptGroupId = payload ? asEventScalarString(payload.attemptGroupId) : null;
  const definitionSnapshotRef = payload ? asEventScalarString(payload.definitionSnapshotRef) : null;
  const resumedFromDispatchId = payload ? asEventScalarString(payload.resumedFromDispatchId) : null;
  const startedAt = payload ? asEventScalarString(payload.startedAt) : null;
  const dispatchActivityAt = startedAt ?? occurredAt;
  const dispatchActivityMs = parseEventTimestampMs(dispatchActivityAt);

  const reviewTarget = payload && isRecord(payload.reviewTarget) ? payload.reviewTarget : null;
  const reviewTargetKind = reviewTarget ? asEventScalarString(reviewTarget.kind) : null;
  const reviewTargetDecisionId = reviewTarget ? asEventScalarString(reviewTarget.decisionId) : null;

  const controlRequest = payload ? payload.controlRequest : undefined;
  const hasControlRequest: 0 | 1 = controlRequest !== undefined && controlRequest !== null ? 1 : 0;
  const controlRequestAction = isRecord(controlRequest) ? asEventScalarString(controlRequest.action) : null;

  const controlReceipt = payload ? payload.controlReceipt : undefined;
  const hasControlReceipt: 0 | 1 = controlReceipt !== undefined && controlReceipt !== null ? 1 : 0;
  const controlReceiptRecord = isRecord(controlReceipt) ? controlReceipt : null;
  const controlReceiptRequestOpId = controlReceiptRecord ? asEventScalarString(controlReceiptRecord.requestOpId) : null;
  const controlReceiptStatus = controlReceiptRecord ? asEventScalarString(controlReceiptRecord.status) : null;
  const hasControlReceiptSteerVersion: 0 | 1 =
    controlReceiptRecord !== null &&
    controlReceiptRecord.steerVersion !== undefined &&
    controlReceiptRecord.steerVersion !== null
      ? 1
      : 0;

  return {
    op_id: input.opId,
    workspace_revision: input.workspaceRevision,
    task_id: input.taskId,
    event_schema: schema,
    event_type: type,
    event_id: eventId,
    occurred_at: occurredAt,
    occurred_at_ms: occurredAtMs,
    actor_person_id: actorPersonId,
    actor_executor_id: actorExecutorId,
    source_node_id: sourceNodeId,
    source_resolved_node_id: sourceResolvedNodeId,
    source_runtime_session_id: sourceRuntimeSessionId,
    entity_id: entityId,
    execution_id: executionId,
    payload_task_id: payloadTaskId,
    migration_created_at: migrationCreatedAt,
    migration_entity_kind: migrationEntityKind,
    migrated_task_id: migratedTaskId,
    migrated_task_pinned: migratedTaskPinned,
    pin_entity_ref: pinEntityRef,
    task_transition_status: taskTransitionStatus,
    runtime_session_id: runtimeSessionId,
    dispatch_id: dispatchId,
    dispatch_key: dispatchKey,
    runtime_session_present: input.runtimeSessionPresent,
    agent_id: agentId,
    agent_name: agentName,
    squad_id: squadId,
    attempt_group_id: attemptGroupId,
    definition_snapshot_ref: definitionSnapshotRef,
    resumed_from_dispatch_id: resumedFromDispatchId,
    started_at: startedAt,
    dispatch_activity_at: dispatchActivityAt,
    dispatch_activity_ms: dispatchActivityMs,
    review_target_kind: reviewTargetKind,
    review_target_decision_id: reviewTargetDecisionId,
    has_control_request: hasControlRequest,
    control_request_action: controlRequestAction,
    has_control_receipt: hasControlReceipt,
    control_receipt_request_op_id: controlReceiptRequestOpId,
    control_receipt_status: controlReceiptStatus,
    has_control_receipt_steer_version: hasControlReceiptSteerVersion,
  };
}

export function eventIndexInsertParams(row: EventIndexRowValues): readonly (string | number | null)[] {
  return [
    row.op_id,
    row.workspace_revision,
    row.task_id,
    row.event_schema,
    row.event_type,
    row.event_id,
    row.occurred_at,
    row.occurred_at_ms,
    row.actor_person_id,
    row.actor_executor_id,
    row.source_node_id,
    row.source_resolved_node_id,
    row.source_runtime_session_id,
    row.entity_id,
    row.execution_id,
    row.payload_task_id,
    row.migration_created_at,
    row.migration_entity_kind,
    row.migrated_task_id,
    row.migrated_task_pinned,
    row.pin_entity_ref,
    row.task_transition_status,
    row.runtime_session_id,
    row.dispatch_id,
    row.dispatch_key,
    row.runtime_session_present,
    row.agent_id,
    row.agent_name,
    row.squad_id,
    row.attempt_group_id,
    row.definition_snapshot_ref,
    row.resumed_from_dispatch_id,
    row.started_at,
    row.dispatch_activity_at,
    row.dispatch_activity_ms,
    row.review_target_kind,
    row.review_target_decision_id,
    row.has_control_request,
    row.control_request_action,
    row.has_control_receipt,
    row.control_receipt_request_op_id,
    row.control_receipt_status,
    row.has_control_receipt_steer_version,
  ];
}

/** Matches PG `eventIndexEvent`: keeps accepted bytes unless the registered reviewer-key transform changes a dispatch. */
export function normalizeHydratedIndexEvent<Event extends PersistedCanonicalEventV1>(event: Event): Event {
  if (!isAgentRuntimeEvent(event) || event.type !== "runtime_dispatch_requested") return event;
  return withReviewerQualifiedDispatchKey(event) === event ? event : (normalizeHistoricalEvent(event) as Event);
}

/**
 * Hydrate full canonical events for the requested indexed revisions in ONE batched read.
 * Strict L3 fail-closed: if any indexed revision is missing from the canonical event source,
 * throws `ProjectionEventSourceError` instead of fabricating or silently omitting rows.
 */
export function hydrateEventsByRevisions(
  revisions: readonly number[],
  readEventsByRevisions: BatchEventsByRevisionsReader | undefined,
): ReadonlyMap<number, CanonicalEventV1> {
  if (revisions.length === 0) return new Map();
  const unique = [...new Set(revisions)];
  if (!readEventsByRevisions) throw new ProjectionEventSourceError(unique);
  const loaded = readEventsByRevisions(unique);
  const missing: number[] = [];
  const hydrated = new Map<number, CanonicalEventV1>();
  for (const revision of unique) {
    const event = loaded.get(revision);
    if (event === undefined) missing.push(revision);
    else hydrated.set(revision, normalizeHydratedIndexEvent(event) as CanonicalEventV1);
  }
  if (missing.length > 0) throw new ProjectionEventSourceError(missing);
  return hydrated;
}

/** Build a fallback `BatchEventsByRevisionsReader` from an `EventStreamPort` plus optional ledger fallback. */
export function eventStreamEventsByRevisionsReader(
  eventStore: EventStreamPort,
  fallbackLedgerReader?: BatchEventsByRevisionsReader,
): BatchEventsByRevisionsReader {
  if (eventStore.readEventsByRevisions) return eventStore.readEventsByRevisions;
  const maybeSingle = (
    eventStore as EventStreamPort & {
      readonly readEventAtRevision?: (revision: number) => PersistedCanonicalEventV1 | null;
    }
  ).readEventAtRevision;
  return (revisions) => {
    if (revisions.length === 0) return new Map();
    if (maybeSingle) {
      const map = new Map<number, PersistedCanonicalEventV1>();
      for (const revision of revisions) {
        const event = maybeSingle(revision);
        if (event !== null) map.set(revision, event);
      }
      return map;
    }
    if (fallbackLedgerReader) {
      const fromLedger = fallbackLedgerReader(revisions);
      if (fromLedger.size === revisions.length) return fromLedger;
    }
    const map = new Map<number, PersistedCanonicalEventV1>();
    for (const revision of revisions) {
      if (revision < 1) continue;
      const batch = eventStore.readBatch(String(revision - 1), 1);
      const match = batch.events.find((event) => event.workspaceRevision === revision);
      if (match !== undefined) map.set(revision, match);
    }
    return map;
  };
}

// SQL execution, projection watermark, canonical serialization, and state digest primitives.
const stateDigestTables = [
  ["event_index", "op_id"],
  ["event_summary", "workspace_revision"],
  ["artifact_entity_state", "entity_kind, entity_id"],
  ["document", "path"],
  ["document_history", "path"],
  ["materialization_hold", "owner_ref, relation_id"],
  ["preset_snapshot", "digest"],
  ["runtime_installation", "installation_id"],
  ["runtime_session", "runtime_session_id"],
  ["task_snapshot", "task_id"],
  ["task_package", "task_id"],
  ["task_generation", "task_id"],
  ["task_relation", "relation_id"],
  ["task_progress", "workspace_revision"],
  ["entity_projection", "entity_kind, task_id, entity_id"],
  ["archived_entity", "entity_kind, entity_id"],
  ["edge", "task_id, edge_id, iteration"],
  ["lease_cas", "task_id"],
  ["lease_interval", "task_id, execution_id, acquired_revision"],
  ["fact", "fact_id"],
  ["relation_edge", "relation_id"],
  ["decision", "decision_id"],
  ["decision_option", "decision_id, kind, option_id"],
  ["decision_claim", "decision_id, claim_id"],
  ["decision_judgment_consent", "consent_id"],
  ["decision_amendment", "amendment_id"],
  ["decision_content_pin", "pin_id"],
  ["decision_review_event", "event_id"],
  ["dispatch_lifecycle_group", "attempt_group_id"],
  ["dispatch_lifecycle_attempt", "runtime_session_id"],
  ["dispatch_lifecycle_task_lease", "task_id"],
  ["inbox_item", "inbox_id, item_id"],
  ["peer_request", "request_id"],
  ["kb_document", "doc_id"],
] as const;

/** Disposable lookup and derived columns added after a table's state fingerprint was defined. */
const stateDigestColumns: Partial<Record<(typeof stateDigestTables)[number][0], string>> = {
  event_index: EVENT_INDEX_STATE_DIGEST_COLUMNS,
  decision:
    "decision_id,legacy_number,decision_sort_key,state,title,question,risk_tier,urgency,vertical,preset,decision_class," +
    "applies_json,proposer_json,arbiter_json,proposed_at,decided_at,provenance_json,workspace_revision",
  // Freshness is derived from the other projected rows at the same cut (dec_E34C4284B48AFAF152D7BF1980).
  relation_edge:
    "relation_id,source_ref,target_ref,relation_type,state,target_observed_version,owner_ref,workspace_revision,updated_at,row_json",
};
const projectionSqlHeartbeat = new AsyncLocalStorage<{ state: BigInt64Array | undefined } | undefined>();

export async function withProjectionSqlHeartbeat<Result>(
  sharedState: SharedArrayBuffer | undefined,
  work: () => Result | Promise<Result>,
): Promise<Result> {
  if (sharedState === undefined) return work();
  const previous = projectionSqlHeartbeat.getStore(),
    scope: { state: BigInt64Array | undefined } = { state: new BigInt64Array(sharedState) };
  try {
    let pending: Result | Promise<Result>;
    projectionSqlHeartbeat.enterWith(scope);
    try {
      pending = work();
    } finally {
      projectionSqlHeartbeat.enterWith(previous);
    }
    return await pending;
  } finally {
    scope.state = undefined;
  }
}

export function markProjectionSqlProgress(): void {
  const heartbeat = projectionSqlHeartbeat.getStore()?.state;
  if (heartbeat !== undefined) Atomics.store(heartbeat, 0, process.hrtime.bigint());
}

export function watermark(db: DatabaseSync): number {
  const row = prepareQuery(db, "SELECT watermark FROM projection_meta WHERE singleton = 1", (sql) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      sql,
    ),
  ).get() as { readonly watermark: number };
  return Number(row.watermark);
}

export function readProjectionCut(
  db: DatabaseSync,
  readHead: EventStreamPort["readHead"],
): {
  readonly status: ReadSet.ReadSetProjectionCut["status"];
  readonly watermark: number;
  readonly sourceRevision: number;
} {
  const current = watermark(db),
    sourceRevision = readHead()?.revision ?? 0;
  return {
    status: current === sourceRevision ? "ready" : "pending",
    watermark: current,
    sourceRevision,
  };
}

export function isAtSourceCut(db: DatabaseSync, sourceRevision: number): boolean {
  const state =
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.prepare("SELECT watermark, scan_cursor, scanned_revision FROM projection_meta WHERE singleton = 1").get() as {
      readonly watermark: number;
      readonly scan_cursor: string | null;
      readonly scanned_revision: number;
    };
  return (
    Number(state.watermark) === sourceRevision &&
    state.scan_cursor === null &&
    Number(state.scanned_revision) === sourceRevision &&
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.prepare("SELECT 1 FROM event_source LIMIT 1").get() === undefined
  );
}

// Hashes every projection row, so only explicit rebuilds and read-side checks call it; writes never do.
export function readStateDigest(db: DatabaseSync, sourceRevision: number): `sha256:${string}` | null {
  markProjectionSqlProgress();
  return queryTransaction(db, () => {
    if (!isAtSourceCut(db, sourceRevision)) return null;
    let digest = sha256Text("task-projection-state/v1");
    for (const [table, order] of stateDigestTables) {
      digest = sha256Text(`${digest}\n${table}`);
      if (table === "document" || table === "document_history") {
        digest = digestDocumentRows(db, digest, table);
        continue;
      }
      // Disposable event lookup fields are not part of the pre-expansion state fingerprint.
      for (const row of prepareQuery(
        db,
        `SELECT ${stateDigestColumns[table] ?? "*"} FROM ${table} ORDER BY ${order}`,
      ).iterate()) {
        markProjectionSqlProgress();
        digest = sha256Text(`${digest}\n${canonicalJson(row as ProjectionSqlRow)}`);
      }
    }
    return `sha256:${digest}` as const;
  });
}

function digestDocumentRows(db: DatabaseSync, digest: string, table: "document" | "document_history"): string {
  const documents = prepareQuery(
    db,
    `SELECT path, workspace_revision, CASE WHEN json_type(value_json, '$.body') IS NULL THEN value_json ELSE json_remove(value_json, '$.body') END AS metadata_json FROM ${table} ORDER BY path`,
  ).iterate() as Iterable<{
    readonly path: string;
    readonly workspace_revision: number;
    readonly metadata_json: string;
  }>;
  for (const { path, workspace_revision, metadata_json } of documents) {
    markProjectionSqlProgress();
    const metadata = JSON.parse(metadata_json) as Record<string, unknown>;
    digest = sha256Text(
      `${digest}\n${canonicalJson({
        path,
        workspace_revision,
        value_json: canonicalJson(metadata),
      })}`,
    );
  }
  return digest;
}
export function transaction<A>(db: DatabaseSync, run: () => A): A {
  markProjectionSqlProgress();
  /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    markProjectionSqlProgress();
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.exec("COMMIT");
    markProjectionSqlProgress();
    return value;
  } catch (error) {
    try {
      /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}

export function queryTransaction<A>(db: DatabaseSync, run: () => A): A {
  if (db.isTransaction) return run();
  /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
  db.exec("BEGIN");
  try {
    const value = run();
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      consumeKnownError(rollbackError);
    }
    throw error;
  }
}
type SqlValue = string | number | bigint | Uint8Array | null;
export function runSql(db: DatabaseSync, sql: string, ...values: readonly SqlValue[]): number | bigint {
  markProjectionSqlProgress();
  return prepareQuery(db, sql, (text) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      text,
    ),
  ).run(...values).changes;
}
const connectionStatements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
/** Release cached prepared statements after an in-place DDL rewrite of a table. */
export function clearConnectionStatements(db: DatabaseSync): void {
  connectionStatements.get(db)?.clear();
  connectionTables.set(
    db,
    new Set(queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => String(name))),
  );
}
/** Release the cache before close finalizes the connection's native statements. */
export function closeProjectionConnection(db: DatabaseSync): void {
  connectionStatements.delete(db);
  db.close();
}
/** Reuse a statement for the connection's lifetime. Call sites that carry their own
 * write-boundary identity pass the `prepare` that performs it. */
export function prepareQuery(
  db: DatabaseSync,
  sql: string,
  prepare = (text: string) =>
    /* @gate-identity state-store/task.source.storage.src.projection.rebuildable-task-projection-sql.sqlite-database */ db.prepare(
      text,
    ),
): StatementSync {
  markProjectionSqlProgress();
  let statements = connectionStatements.get(db);
  if (statements === undefined) connectionStatements.set(db, (statements = new Map()));
  let statement = statements.get(sql);
  if (statement === undefined) statements.set(sql, (statement = prepare(sql)));
  return statement;
}
/** Table names read once per connection: every table is created while a connection initializes. */
const connectionTables = new WeakMap<DatabaseSync, ReadonlySet<string>>();
export function projectionTables(db: DatabaseSync): ReadonlySet<string> {
  let tables = connectionTables.get(db);
  if (tables === undefined)
    connectionTables.set(
      db,
      (tables = new Set(
        queryRows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(({ name }) => String(name)),
      )),
    );
  return tables;
}
export type ProjectionSqlRow = Readonly<Record<string, SQLOutputValue>>;
export function queryRow<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): Row | undefined {
  return prepareQuery(db, sql).get(...values) as Row | undefined;
}
export function queryRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  db: DatabaseSync,
  sql: string,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return queryPreparedRows<Row>(prepareQuery(db, sql), ...values);
}
export function queryPreparedRows<Row extends ProjectionSqlRow = ProjectionSqlRow>(
  statement: StatementSync,
  ...values: readonly SqlValue[]
): readonly Row[] {
  return statement.all(...values) as Row[];
}

export const decisionDocumentPattern = /^decisions\/decision-(dec_[A-Za-z0-9_-]+)\/decision\.md$/u;

export type ProjectionContentBlobErrorCode = "content_blob_missing" | "content_blob_digest_mismatch";

export class ProjectionContentBlobError extends Error {
  readonly code: ProjectionContentBlobErrorCode;
  readonly documentPath: string;
  readonly blobSha256: string;

  constructor(code: ProjectionContentBlobErrorCode, documentPath: string, blobSha256: string, message: string) {
    super(message);
    this.name = "ProjectionContentBlobError";
    this.code = code;
    this.documentPath = documentPath;
    this.blobSha256 = blobSha256;
  }
}

export type ProjectedDocumentMetadata = Omit<DocumentState, "body">;

export function stripDocumentBody(
  document: ProjectedDocumentMetadata & { readonly body?: unknown },
): ProjectedDocumentMetadata {
  return {
    path: document.path,
    blobSha256: document.blobSha256,
    size: document.size,
    mediaType: document.mediaType,
    policyId: document.policyId,
    workspaceRevision: document.workspaceRevision,
  };
}

export function serializeProjectedDocument(document: ProjectedDocumentMetadata & { readonly body?: unknown }): string {
  return canonicalJson(stripDocumentBody(document));
}

export function isNonTextualDocumentPolicy(policyId: string | null | undefined): boolean {
  return policyId === RAW_ARTIFACT_POLICY_ID || policyId === ENTITY_CONTENT_POLICY_ID;
}

/**
 * Hydrate a projected document row into a full DocumentState.
 * Schema v40 rows omit `body` and resolve bytes on demand from immutable CAS with strict L3
 * fail-closed checks (missing blob or size/SHA-256/UTF-8 mismatch always throws explicitly).
 */
export function hydrateDocumentRow(valueJson: string, readBlob?: EventStreamPort["readContentBlob"]): DocumentState {
  const parsed = JSON.parse(valueJson) as ProjectedDocumentMetadata & { readonly body?: unknown };
  if (typeof parsed.body === "string") return parsed as DocumentState;
  const documentPath = String(parsed.path ?? "");
  const blobSha256 = String(parsed.blobSha256 ?? "");
  const expectedSize = Number(parsed.size);
  const verifiedReader = verifiedContentBlobReaderFor(readBlob);
  if (verifiedReader !== undefined) {
    const entry = verifiedReader(blobSha256);
    if (entry === null) {
      throw new ProjectionContentBlobError(
        "content_blob_missing",
        documentPath,
        blobSha256,
        `content blob ${blobSha256} is missing for projected document ${documentPath}`,
      );
    }
    if (entry.size !== expectedSize || entry.sha256 !== blobSha256) {
      throw new ProjectionContentBlobError(
        "content_blob_digest_mismatch",
        documentPath,
        blobSha256,
        `content blob integrity mismatch for projected document ${documentPath}: ` +
          `expected ${blobSha256} (${expectedSize} bytes), observed ${entry.sha256} (${entry.size} bytes)`,
      );
    }
    if (isNonTextualDocumentPolicy(parsed.policyId)) {
      return { ...stripDocumentBody(parsed), body: "" };
    }
    const ignoreBOM = parsed.policyId === OPAQUE_TEXTUAL_POLICY_ID;
    const cachedBody = ignoreBOM ? entry.utf8IgnoreBom : entry.utf8Default;
    if (cachedBody !== undefined) {
      return { ...stripDocumentBody(parsed), body: cachedBody };
    }
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM }).decode(entry.bytes);
    } catch {
      throw new ProjectionContentBlobError(
        "content_blob_digest_mismatch",
        documentPath,
        blobSha256,
        `content blob ${blobSha256} for projected document ${documentPath} is not valid UTF-8`,
      );
    }
    if (ignoreBOM) entry.utf8IgnoreBom = body;
    else entry.utf8Default = body;
    return { ...stripDocumentBody(parsed), body };
  }
  const bytes = readBlob?.(blobSha256) ?? null;
  if (bytes === null) {
    throw new ProjectionContentBlobError(
      "content_blob_missing",
      documentPath,
      blobSha256,
      `content blob ${blobSha256} is missing for projected document ${documentPath}`,
    );
  }
  const actualSha256 = sha256Bytes(bytes);
  if (bytes.byteLength !== expectedSize || actualSha256 !== blobSha256) {
    throw new ProjectionContentBlobError(
      "content_blob_digest_mismatch",
      documentPath,
      blobSha256,
      `content blob integrity mismatch for projected document ${documentPath}: ` +
        `expected ${blobSha256} (${expectedSize} bytes), observed ${actualSha256} (${bytes.byteLength} bytes)`,
    );
  }
  if (isNonTextualDocumentPolicy(parsed.policyId)) {
    return { ...stripDocumentBody(parsed), body: "" };
  }
  let body: string;
  try {
    body = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: parsed.policyId === OPAQUE_TEXTUAL_POLICY_ID,
    }).decode(bytes);
  } catch {
    throw new ProjectionContentBlobError(
      "content_blob_digest_mismatch",
      documentPath,
      blobSha256,
      `content blob ${blobSha256} for projected document ${documentPath} is not valid UTF-8`,
    );
  }
  return { ...stripDocumentBody(parsed), body };
}

/**
 * Resolve a read-only CAS content-blob reader for query-only projection sessions
 * (works for standard workspaces, custom localRoot layouts, and edge replica generations).
 */
export function resolveContentBlobReader(projectionPath: string, rootDir?: string): EventStreamPort["readContentBlob"] {
  const localRoots: string[] = [];
  const addLocalRoot = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (!localRoots.includes(resolved)) localRoots.push(resolved);
  };
  if (projectionPath) addLocalRoot(path.resolve(path.dirname(projectionPath), ".."));
  if (rootDir) addLocalRoot(resolveHarnessLayout(rootDir).localRoot);
  const objectRoots = localRoots.flatMap((localRoot) =>
    ["3", "2", "1"].map((generation) => path.join(localRoot, "store", "generations", generation, "objects", "sha256")),
  );
  const reader: EventStreamPort["readContentBlob"] = (sha256: string): Uint8Array | null => {
    for (const objectRoot of objectRoots) {
      const bytes = readContentObject(objectRoot, sha256);
      if (bytes !== null) return bytes;
    }
    return null;
  };
  registerVerifiedContentBlobReader(reader, (sha256) => readVerifiedContentObject(objectRoots, sha256));
  return reader;
}
