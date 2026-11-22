import { canonicalEventFleetSummary } from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { parseEntityRef } from "@harness-anything/kernel/internal/domain/entity-ref.ts";
import {
  DOSSIER_PAGE_SIZE,
  dossierDocumentPath,
  dossierMediaType,
  isDossierWatermark,
  type DossierSlot,
  type DossierSlotState,
} from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import { canonicalEventEntityRefs } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { isTerminalStatus } from "@harness-anything/kernel/internal/domain/lifecycle-status.ts";
import type { CanonicalEventV1, VerticalDefinition } from "@harness-anything/kernel";
import { dossierError, dossierSourceCut, readDossierState, type DossierReader } from "../dossier-state.ts";

function triggerDue(slot: DossierSlot, state: DossierSlotState | null, delta: number, now: string) {
  return slot.triggers.filter(
    (trigger) =>
      delta > 0 &&
      (trigger.kind === "event-watermark"
        ? delta >= trigger.minimumDelta
        : state === null || Date.parse(now) - Date.parse(state.synthesizedAt) >= trigger.everyMs),
  );
}

export function readDossierStatus(reader: DossierReader, definition: VerticalDefinition, now: string) {
  const { watermark: currentWatermark } = dossierSourceCut(reader);
  return {
    schema: "dossier-status/v1" as const,
    verticalId: definition.id,
    currentWatermark,
    slots: (definition.livingDossier?.slots ?? []).map((slot) => {
      const state = readDossierState(reader, definition.id, slot.id);
      const lastSynthesizedWatermark = state?.lastSynthesizedWatermark ?? 0;
      const stalenessDelta = currentWatermark - lastSynthesizedWatermark;
      return {
        ...slot,
        documentPath: dossierDocumentPath(definition.id, slot),
        lastSynthesizedWatermark,
        synthesizedAt: state?.synthesizedAt ?? null,
        stalenessDelta,
        dueTriggers: triggerDue(slot, state, stalenessDelta, now),
      };
    }),
  };
}

export function readDossierContent(reader: DossierReader, verticalId: string, slot: DossierSlot) {
  const state = readDossierState(reader, verticalId, slot.id);
  const content = state ? reader.projection.readDocument(state.path) : null;
  if (content !== null && (content.status !== "ready" || content.document === null))
    dossierError("projection_pending", "The dossier slot content is unavailable.");
  return {
    schema: "dossier-content/v1" as const,
    slot,
    state,
    mediaType: content?.document?.mediaType ?? dossierMediaType(slot.kind),
    body: content?.document?.body ?? null,
  };
}

/** One page per call. The scanned revision, including irrelevant events, is the next write fence. */
export function readDossierContext(
  reader: DossierReader,
  verticalId: string,
  slot: DossierSlot,
  upper?: unknown,
  declaredKinds: VerticalDefinition["entityKinds"] = [],
) {
  const expectedWatermark = readDossierState(reader, verticalId, slot.id)?.lastSynthesizedWatermark ?? 0;
  const sourceWatermark = dossierSourceCut(reader).watermark;
  const currentWatermark = upper === undefined ? sourceWatermark : upper;
  if (
    !isDossierWatermark(currentWatermark) ||
    currentWatermark < expectedWatermark ||
    currentWatermark > sourceWatermark
  )
    dossierError(
      "invalid_command",
      "Dossier context upper watermark must be between the current slot and source watermarks.",
    );
  const readPage = reader.store.readEventWindow;
  if (!readPage) dossierError("invalid_store", "The dossier requires an indexed canonical event window.");
  const page = readPage({ afterRevision: expectedWatermark, maxRevision: currentWatermark, limit: DOSSIER_PAGE_SIZE });
  const entityKinds = new Set(slot.entityKinds);
  for (const kind of declaredKinds)
    if (kind.entityType === "artifact" && entityKinds.has(kind.id)) entityKinds.add(`entity-kind/${kind.kindId}`);
  return {
    schema: "dossier-context/v1" as const,
    slotId: slot.id,
    expectedWatermark,
    currentWatermark,
    nextWatermark: page.lastScannedRevision,
    done: page.done,
    changes: page.events.flatMap((event) => dossierChange(event, entityKinds)),
  };
}

function dossierChange(event: CanonicalEventV1, kinds: ReadonlySet<string>) {
  let refs = canonicalEventEntityRefs(event);
  if (event.schema === "task-event/v1") {
    if (
      event.type !== "task_completed" &&
      event.type !== "task_superseded" &&
      !(event.type === "task_transitioned" && "task" in event.payload && isTerminalStatus(event.payload.task.status))
    )
      return [];
  } else if (event.schema === "decision-event/v1") {
    if (
      ![
        "decision_accepted",
        "decision_superseded",
        "decision_retired",
        "decision_amended",
        "decision_repinned",
        "decision_relation_replaced",
      ].includes(event.type)
    )
      return [];
  } else if (event.schema === "relation-event/v1") {
    refs = [
      "relation/" + event.relationId,
      ...("relation" in event.payload ? [event.payload.relation.source, event.payload.relation.target] : []),
    ];
  } else if (!["fact-event/v1", "entity-event/v1", "vertical-declaration-event/v1"].includes(event.schema)) return [];
  if (kinds.size > 0 && !refs.some((ref) => kinds.has(parseEntityRef(ref)?.kind ?? ref.slice(0, ref.lastIndexOf("/")))))
    return [];
  return [{ ...canonicalEventFleetSummary(event), entityRefs: refs }];
}

export type DossierStatusResult = ReturnType<typeof readDossierStatus>;
export type DossierContentResult = ReturnType<typeof readDossierContent>;
export type DossierContextResult = ReturnType<typeof readDossierContext>;
