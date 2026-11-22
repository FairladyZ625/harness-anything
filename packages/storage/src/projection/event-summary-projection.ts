import { canonicalEventEntityRefs } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { canonicalEventSummary } from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { bulkRebuildContext } from "./bulk-rebuild-state.ts";
import {
  deriveEventSummarySourceNodeId,
  expandEntityRefSuffixes,
  FLEET_NODE_TASK_SEED_TYPES,
} from "./event-summary-read-index.ts";
import { canonicalJson, runSql } from "./rebuildable-task-projection-sql.ts";

const ACTIVITY_SCHEMAS = new Set(["task-event/v1", "task-bootstrap-event/v1", "task-progress-event/v1"]);

/** Replay derives summaries and provenance together at the event revision, without copying its payload. */
export function projectEventSummary(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  const summary = canonicalEventSummary(event),
    entityRefs = canonicalEventEntityRefs(event),
    summaryJson = canonicalJson(summary),
    witnessJson = canonicalJson({
      workspaceRevision: event.workspaceRevision,
      occurredAt: event.occurredAt,
      actor: event.actor,
      source: event.source,
    }),
    dispatchStartedAt =
      event.schema === "agent-runtime-event/v1" && event.type === "runtime_dispatch_requested"
        ? (event.payload.startedAt ?? event.occurredAt)
        : undefined,
    rowJson = canonicalJson({
      revision: event.workspaceRevision,
      opId: event.opId,
      eventId: event.eventId,
      schema: event.schema,
      type: event.type,
      occurredAt: event.occurredAt,
      actor: { personId: event.actor.principal.personId, executorId: event.actor.executor?.id ?? null },
      entityRefs,
      ...(dispatchStartedAt !== undefined ? { dispatchStartedAt } : {}),
    });
  const bulk = bulkRebuildContext(db);
  if (bulk === undefined) {
    runSql(
      db,
      "INSERT INTO event_summary(workspace_revision, summary_json, witness_json, row_json) VALUES (?, ?, ?, ?)",
      event.workspaceRevision,
      summaryJson,
      witnessJson,
      rowJson,
    );
    return;
  }
  const actorPersonId = event.actor.principal.personId ?? null,
    actorExecutorId = event.actor.executor?.id ?? null,
    sourceNodeId = deriveEventSummarySourceNodeId(
      event.source,
      (sessionId) => bulk.sessionExecutionNode.get(sessionId) || bulk.sessionLaunchNode.get(sessionId) || null,
    ),
    summaryRecord = summary as { readonly taskId?: unknown; readonly payload?: { readonly taskId?: unknown } },
    rawActivityTaskId =
      ACTIVITY_SCHEMAS.has(event.schema) || event.type === "runtime_dispatch_requested"
        ? (summaryRecord.taskId ?? summaryRecord.payload?.taskId ?? null)
        : null,
    activityTaskId = typeof rawActivityTaskId === "string" ? rawActivityTaskId : null,
    derivedDispatchStartedAt =
      event.type === "runtime_dispatch_requested" ? (dispatchStartedAt ?? event.occurredAt) : null;
  runSql(
    db,
    "INSERT INTO event_summary(" +
      "workspace_revision, summary_json, witness_json, row_json, " +
      "event_type, occurred_at, actor_person_id, actor_executor_id, source_node_id, activity_task_id, dispatch_started_at, read_index_version" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)",
    event.workspaceRevision,
    summaryJson,
    witnessJson,
    rowJson,
    event.type,
    event.occurredAt,
    actorPersonId,
    actorExecutorId,
    sourceNodeId,
    activityTaskId,
    derivedDispatchStartedAt,
  );
  if (sourceNodeId !== null && activityTaskId !== null) {
    const key = `${sourceNodeId}\0${activityTaskId}`,
      existing = bulk.fleetNodeTasks.get(key);
    if (existing !== undefined) {
      if (existing.revision < event.workspaceRevision) {
        existing.revision = event.workspaceRevision;
        existing.personId = actorPersonId;
        existing.updatedAt = event.occurredAt;
      }
    } else if (FLEET_NODE_TASK_SEED_TYPES.has(event.type)) {
      bulk.fleetNodeTasks.set(key, {
        nodeId: sourceNodeId,
        taskId: activityTaskId,
        revision: event.workspaceRevision,
        personId: actorPersonId,
        updatedAt: event.occurredAt,
      });
    }
  }
  for (const ref of expandEntityRefSuffixes(entityRefs)) {
    let revisions = bulk.entityRefRevisions.get(ref);
    if (revisions === undefined) bulk.entityRefRevisions.set(ref, (revisions = []));
    revisions.push(event.workspaceRevision);
  }
}
