import {
  isEntityDeclarationEvent,
  type StoredEntityEventV1,
} from "@harness-anything/kernel/internal/domain/entity-event.ts";
import type { EntityDeclarationState } from "@harness-anything/kernel/internal/ports/entity-declarations.ts";
/** Keep accepted declaration bytes and retirement independent, as the event reader has always done. */
export function reduceEntityDeclarationState(
  before: EntityDeclarationState | null,
  event: StoredEntityEventV1,
): EntityDeclarationState {
  const declaration =
    event.type === "entity_deleted" ? null : isEntityDeclarationEvent(event) ? event : (before?.declaration ?? null);
  const retirement =
    event.type === "agent_retired"
      ? {
          retiredAt: event.payload.retiredAt,
          reason: event.payload.reason,
          ...(event.payload.successor === undefined ? {} : { successor: event.payload.successor }),
        }
      : (before?.retirement ?? null);
  return { declaration, retirement };
}
