import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { canonicalEventSummary } from "../domain/canonical-event-summary.ts";
import { canonicalJson, runSql } from "./rebuildable-task-projection-sql.ts";

/** Replay derives summaries and provenance together at the event revision, without copying its payload. */
export function projectEventSummary(db: DatabaseSync, event: PersistedCanonicalEventV1): void {
  runSql(
    db,
    "INSERT INTO event_summary(workspace_revision, summary_json, witness_json) VALUES (?, ?, ?)",
    event.workspaceRevision,
    canonicalJson(canonicalEventSummary(event)),
    canonicalJson({
      workspaceRevision: event.workspaceRevision,
      occurredAt: event.occurredAt,
      actor: event.actor,
      source: event.source,
    }),
  );
}
