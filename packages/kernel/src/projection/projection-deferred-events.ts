import type { DatabaseSync } from "node:sqlite";
import type { PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { queryRows, watermark } from "./rebuildable-task-projection-sql.ts";

/** Select the next replay window from persisted and freshly scanned events. */
export function readyDeferredEvents(
  db: DatabaseSync,
  batch: readonly PersistedCanonicalEventV1[],
  limit: number,
  allowRevisionGaps: boolean,
): readonly PersistedCanonicalEventV1[] {
  const current = watermark(db),
    candidates = new Map<number, PersistedCanonicalEventV1>();
  for (const row of queryRows(
    db,
    [
      "SELECT workspace_revision, event_json FROM event_source",
      "WHERE workspace_revision > ? AND workspace_revision <= ?",
      "ORDER BY workspace_revision",
    ].join(" "),
    current,
    current + limit,
  ))
    candidates.set(Number(row.workspace_revision), JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1);
  for (const event of batch)
    if (event.workspaceRevision <= current + limit) candidates.set(event.workspaceRevision, event);
  const ready: PersistedCanonicalEventV1[] = [];
  for (let revision = current + 1; revision <= current + limit; revision += 1) {
    const event = candidates.get(revision);
    if (event === undefined) {
      if (!allowRevisionGaps) break;
      continue;
    }
    ready.push(event);
  }
  return ready;
}
