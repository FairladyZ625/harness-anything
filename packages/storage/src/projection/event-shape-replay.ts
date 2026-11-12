import { isEventShapeMigrationEvent } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";

/** A single repository's replay frontier can identify newly observed shape upgrades.
 * PG acceptance already owns newness; its scope maximum is not a repository frontier. */
export function requiresEventShapeReplay(events: readonly PersistedCanonicalEventV1[], replayStart: number): boolean {
  return (
    replayStart > 0 &&
    events.some((event) => isEventShapeMigrationEvent(event) && event.workspaceRevision > replayStart)
  );
}
