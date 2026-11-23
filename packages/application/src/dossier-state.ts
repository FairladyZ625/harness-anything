import { isDossierSynthesisEvent } from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import {
  DossierError,
  dossierStatePath,
  type DossierSlotState,
} from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import type { CanonicalEventStore, TaskProjection } from "@harness-anything/kernel";

export type DossierBootstrapProjection = Partial<
  Pick<
    TaskProjection,
    "readCut" | "readTaskIndex" | "listDecisions" | "searchFacts" | "readRelationQuery" | "listEntities"
  >
>;

export type DossierReader = {
  readonly store: Pick<CanonicalEventStore, "readHead" | "readEvent" | "readEventAtRevision" | "readEventWindow">;
  readonly projection: Pick<TaskProjection, "readDocumentMetadata" | "readDocument"> & DossierBootstrapProjection;
};

export function dossierError(code: string, message: string): never {
  throw new DossierError(code, message);
}

export function dossierSourceCut(reader: DossierReader): { readonly revision: number; readonly watermark: number } {
  const head = reader.store.readHead();
  if (!head) return { revision: 0, watermark: 0 };
  const tail = reader.store.readEvent(head.opId);
  if (tail === null) dossierError("projection_pending", "The dossier source head is not readable yet.");
  return {
    revision: head.revision,
    watermark: isDossierSynthesisEvent(tail) ? tail.payload.sourceWatermark : head.revision,
  };
}

export function dossierDocumentEvent(reader: DossierReader, path: string) {
  const read = reader.projection.readDocumentMetadata(path);
  if (read.status !== "ready")
    dossierError("projection_pending", "The dossier projection has not caught up with the source.");
  if (!read.document) return null;
  const event = reader.store.readEventAtRevision?.(read.document.workspaceRevision);
  if (!event) dossierError("projection_pending", "The dossier document's accepted event is unavailable.");
  return event;
}

export function readDossierState(reader: DossierReader, verticalId: string, slotId: string): DossierSlotState | null {
  const event = dossierDocumentEvent(reader, dossierStatePath(verticalId, slotId));
  if (!event) return null;
  if (
    !isDossierSynthesisEvent(event) ||
    event.payload.state.verticalId !== verticalId ||
    event.payload.state.slotId !== slotId
  )
    dossierError("invalid_store", "Dossier slot state does not match its accepted event.");
  return event.payload.state;
}
