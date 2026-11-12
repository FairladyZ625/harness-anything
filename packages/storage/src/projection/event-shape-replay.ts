import { isEventShapeMigrationEvent } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync-types.ts";

/** A newly accepted shape upgrade invalidates reductions made before this replay started. */
export function requiresEventShapeReplay(events: readonly PersistedCanonicalEventV1[], replayStart: number): boolean {
  return (
    replayStart > 0 &&
    events.some((event) => isEventShapeMigrationEvent(event) && event.workspaceRevision > replayStart)
  );
}
