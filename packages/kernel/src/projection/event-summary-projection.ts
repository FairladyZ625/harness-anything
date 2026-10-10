import { canonicalEventEntityRefs } from "../composition/index.ts";
import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { canonicalEventSummary } from "../domain/canonical-event-summary.ts";
import { canonicalJson, runSql } from "./rebuildable-task-projection-sql.ts";

/** Replay derives summaries and provenance together at the event revision, without copying its payload. */
export function projectEventSummary(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  runSql(
    db,
    "INSERT INTO event_summary(workspace_revision, summary_json, witness_json, row_json) VALUES (?, ?, ?, ?)",
    event.workspaceRevision,
    canonicalJson(canonicalEventSummary(event)),
    canonicalJson({
      workspaceRevision: event.workspaceRevision,
      occurredAt: event.occurredAt,
      actor: event.actor,
      source: event.source,
    }),
    canonicalJson({
      revision: event.workspaceRevision,
      opId: event.opId,
      eventId: event.eventId,
      schema: event.schema,
      type: event.type,
      occurredAt: event.occurredAt,
      actor: { principal: event.actor.principal, executorId: event.actor.executor?.id ?? null },
      entityRefs: canonicalEventEntityRefs(event),
    }),
  );
}
