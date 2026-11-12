import type { PoolClient } from "pg";
import { isEventShapeMigrationEvent } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";
import type {
  PgProjectionEventInput,
  PgProjectionRebuildInput,
  PgProjectionScope,
} from "./pg-task-event-materialize.ts";

/** Newly accepted events only: canonical op-id admission returns before this hook on replay. */
export async function pgEventShapeReplayInput(
  client: PoolClient,
  scope: PgProjectionScope,
  events: readonly PersistedCanonicalEventV1[],
  sourceRevision: number,
  readContentBlob: PgProjectionEventInput["readContentBlob"],
): Promise<PgProjectionRebuildInput | null> {
  // Ordinary acceptance never scans history or reads an extra projection cut.
  if (!events.some(isEventShapeMigrationEvent)) return null;
  const keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
    meta = await client.query<{ watermark: string }>(
      "SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
      keys,
    );
  // This is only a warm-state check. The scope maximum cannot order a repository's revisions.
  if (Number(meta.rows[0]?.watermark ?? 0) <= 0) return null;
  // Projection tables belong to the whole scope, so retain every scoped repository and each
  // event's original readers instead of relabeling history with the migration writer's readers.
  const rows = await client.query<{ event_json: string; readers: string[] }>(
      "SELECT event_json,readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 ORDER BY revision,repo_id",
      keys,
    ),
    replay = rows.rows.map((row) => ({
      event: JSON.parse(row.event_json) as PersistedCanonicalEventV1,
      readers: row.readers,
    })),
    readers = new Map(replay.map((row) => [row.event, row.readers]));
  return {
    events: replay.map((row) => row.event),
    // Rebuild owns the entire scope, including repositories ahead of the accepting writer.
    sourceRevision: replay.reduce((head, { event }) => Math.max(head, event.workspaceRevision), sourceRevision),
    readContentBlob,
    readEventReaders: (event) => readers.get(event)!,
  };
}
