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
import type { CanonicalEventV1, VerticalDefinition } from "@harness-anything/kernel";
import { dossierError, dossierSourceCut, readDossierState, type DossierReader } from "../dossier-state.ts";
import { buildDossierBootstrapChanges } from "./living-dossier-bootstrap.ts";

const DOSSIER_TEXT_MAX_CHARS = 280;
const MAX_DOSSIER_TAGS = 6;

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

export interface DossierContextCursorOptions {
  readonly afterWatermark?: unknown;
  readonly bootstrap?: unknown;
}

/**
 * Bounded context read for a dossier slot.
 * - Normal incremental scan reads one DOSSIER_PAGE_SIZE window starting after `max(expectedWatermark, afterWatermark)`.
 * - When `bootstrap: true` and the remaining delta exceeds one page, seeds from bounded TaskProjection snapshots
 *   plus the tail event window so cold or severely lagging repositories reach `sourceWatermark` in O(1).
 */
export function readDossierContext(
  reader: DossierReader,
  verticalId: string,
  slot: DossierSlot,
  upper?: unknown,
  declaredKinds: VerticalDefinition["entityKinds"] = [],
  cursorOptions?: DossierContextCursorOptions,
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

  const rawAfter = cursorOptions?.afterWatermark;
  if (rawAfter !== undefined && (!isDossierWatermark(rawAfter) || rawAfter > currentWatermark)) {
    dossierError("invalid_command", "Dossier context afterWatermark must be an integer up to the upper watermark.");
  }
  const scanAfter = rawAfter === undefined ? expectedWatermark : Math.max(expectedWatermark, rawAfter);

  const rawBootstrap = cursorOptions?.bootstrap;
  if (rawBootstrap !== undefined && typeof rawBootstrap !== "boolean") {
    dossierError("invalid_command", "Dossier context bootstrap flag must be a boolean.");
  }
  if (rawBootstrap === true && currentWatermark < sourceWatermark) {
    dossierError("invalid_command", "Dossier bootstrap context cannot target a historical maxWatermark.");
  }

  const readPage = reader.store.readEventWindow;
  if (!readPage) dossierError("invalid_store", "The dossier requires an indexed canonical event window.");

  const entityKinds = new Set(slot.entityKinds);
  const kindMap: Record<string, string> = {};
  for (const kind of declaredKinds) {
    if (kind.entityType === "artifact") {
      const opaqueKind = `entity-kind/${kind.kindId}`;
      kindMap[opaqueKind] = kind.id;
      if (entityKinds.has(kind.id)) entityKinds.add(opaqueKind);
    }
  }

  const shouldBootstrap = rawBootstrap === true && currentWatermark - scanAfter > DOSSIER_PAGE_SIZE;
  if (shouldBootstrap) {
    const projected = buildDossierBootstrapChanges({
      reader,
      slot,
      sourceWatermark: currentWatermark,
      entityKinds,
      kindMap,
    });
    const tailAfter = Math.max(scanAfter, currentWatermark - DOSSIER_PAGE_SIZE);
    const tailPage = readPage({
      afterRevision: tailAfter,
      maxRevision: currentWatermark,
      limit: DOSSIER_PAGE_SIZE,
    });
    const tailChanges = tailPage.events.flatMap((event) =>
      dossierChange(event, entityKinds, kindMap, slot.entityKinds),
    );
    return {
      schema: "dossier-context/v1" as const,
      slotId: slot.id,
      expectedWatermark,
      ...(rawAfter !== undefined ? { afterWatermark: scanAfter } : {}),
      currentWatermark,
      nextWatermark: currentWatermark,
      done: true,
      bootstrapped: true as boolean,
      kindMap,
      changes: [...projected, ...tailChanges],
    };
  }

  const page = readPage({ afterRevision: scanAfter, maxRevision: currentWatermark, limit: DOSSIER_PAGE_SIZE });
  return {
    schema: "dossier-context/v1" as const,
    slotId: slot.id,
    expectedWatermark,
    ...(rawAfter !== undefined ? { afterWatermark: scanAfter } : {}),
    currentWatermark,
    nextWatermark: page.lastScannedRevision,
    done: page.done,
    ...(rawBootstrap !== undefined ? { bootstrapped: false as boolean } : {}),
    kindMap,
    changes: page.events.flatMap((event) => dossierChange(event, entityKinds, kindMap, slot.entityKinds)),
  };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function clippedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= DOSSIER_TEXT_MAX_CHARS ? trimmed : `${trimmed.slice(0, DOSSIER_TEXT_MAX_CHARS - 1)}…`;
}

function clippedStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => clippedString(entry))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, MAX_DOSSIER_TAGS);
  return items.length > 0 ? items : undefined;
}

function rawRefKind(ref: string): string {
  const parsed = parseEntityRef(ref);
  if (parsed) return parsed.kind;
  if (ref.startsWith("entity-kind/")) {
    const parts = ref.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
  }
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

function resolveLogicalKind(rawKind: string, kindMap: Readonly<Record<string, string>>): string {
  return kindMap[rawKind] ?? rawKind;
}

function extractRelationMeta(
  relation: Readonly<Record<string, unknown>> | undefined,
  kindMap: Readonly<Record<string, string>>,
  fallbackRelationId?: string,
) {
  if (!relation) return undefined;
  const source = clippedString(relation.source);
  const target = clippedString(relation.target);
  const relationType = clippedString(relation.type);
  if (!source || !target || !relationType) return undefined;
  return {
    ...(clippedString(relation.relation_id) || fallbackRelationId
      ? { relationId: clippedString(relation.relation_id) ?? fallbackRelationId }
      : {}),
    source,
    target,
    sourceKind: resolveLogicalKind(rawRefKind(source), kindMap),
    targetKind: resolveLogicalKind(rawRefKind(target), kindMap),
    relationType,
    state: clippedString(relation.state) ?? "active",
    ...(clippedString(relation.rationale) ? { rationale: clippedString(relation.rationale) } : {}),
  };
}

function decisionActionFor(type: string): string | undefined {
  switch (type) {
    case "decision_proposed":
      return "proposed";
    case "decision_accepted":
      return "accepted";
    case "decision_rejected":
      return "rejected";
    case "decision_deferred":
      return "deferred";
    case "decision_amended":
      return "amended";
    case "decision_superseded":
      return "superseded";
    case "decision_retired":
      return "retired";
    case "decision_repinned":
      return "repinned";
    case "decision_relation_retired":
      return "relation_retired";
    case "decision_relation_replaced":
      return "relation_replaced";
    case "decision_related":
      return "related";
    default:
      return undefined;
  }
}

function extractTaskPackagePath(
  taskId: string | undefined,
  metadata: Readonly<Record<string, unknown>> | undefined,
  rawPayload: Readonly<Record<string, unknown>>,
): string | undefined {
  const docEntries = Array.isArray(rawPayload.documentClaims) ? rawPayload.documentClaims : [];
  for (const entry of docEntries) {
    const docPath = clippedString(recordOf(entry)?.path);
    if (docPath && docPath.startsWith("tasks/")) {
      const segments = docPath.split("/");
      if (segments.length >= 2 && segments[1]!.length > 0) return `${segments[0]}/${segments[1]}`;
    }
  }
  const slug = clippedString(metadata?.slug);
  if (taskId && slug) return `tasks/${taskId}-${slug}`;
  return undefined;
}

function extractDecisionChosen(
  rawPayload: Readonly<Record<string, unknown>>,
  nextSnapshot: Readonly<Record<string, unknown>> | undefined,
): readonly string[] | undefined {
  const rawChosen = Array.isArray(nextSnapshot?.chosen)
    ? nextSnapshot.chosen
    : Array.isArray(rawPayload.chosen)
      ? rawPayload.chosen
      : undefined;
  if (!rawChosen) return undefined;
  const items = rawChosen
    .map((entry) => {
      const record = recordOf(entry);
      const id = clippedString(record?.id);
      const text = clippedString(record?.text);
      if (!text) return undefined;
      return id ? `${id}: ${text}` : text;
    })
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, MAX_DOSSIER_TAGS);
  return items.length > 0 ? items : undefined;
}

function dossierChange(
  event: CanonicalEventV1,
  kinds: ReadonlySet<string>,
  kindMap: Readonly<Record<string, string>>,
  slotKinds: readonly string[],
) {
  const envelope = event as unknown as Readonly<Record<string, unknown>>;
  const rawPayload = recordOf(envelope.payload) ?? {};
  let refs = canonicalEventEntityRefs(event);
  const extraPayload: Record<string, unknown> = {};
  let retireEventSlotMatch = false;

  if (event.schema === "task-event/v1") {
    if (
      event.type !== "task_created" &&
      event.type !== "task_completed" &&
      event.type !== "task_superseded" &&
      event.type !== "task_transitioned"
    )
      return [];
    const task = recordOf(rawPayload.task);
    const metadata = recordOf(task?.metadata);
    const mutation = recordOf(rawPayload.mutation);
    const resolvedTaskId = clippedString(task?.taskId) ?? clippedString(envelope.taskId);
    const taskTitle = clippedString(task?.title);
    const taskClass = clippedString(task?.taskClass);
    const taskStatus =
      clippedString(task?.status) ??
      (event.type === "task_completed" ? "done" : event.type === "task_superseded" ? "cancelled" : undefined);
    const parentTaskId = metadata?.parentTaskId === null ? null : clippedString(metadata?.parentTaskId);
    const packagePath = extractTaskPackagePath(resolvedTaskId, metadata, rawPayload);
    const surfaces = clippedStringList(metadata?.surfaces);
    const reason = clippedString(mutation?.reason);
    if (taskTitle) extraPayload.title = taskTitle;
    if (taskClass) extraPayload.taskClass = taskClass;
    if (taskStatus) extraPayload.taskStatus = taskStatus;
    if (parentTaskId !== undefined) extraPayload.parentTaskId = parentTaskId;
    if (packagePath) extraPayload.packagePath = packagePath;
    if (surfaces) extraPayload.surfaces = surfaces;
    if (reason) extraPayload.reason = reason;
  } else if (event.schema === "decision-event/v1") {
    const decisionAction = decisionActionFor(event.type);
    if (!decisionAction) return [];
    const decisionId = clippedString(envelope.decisionId);
    const nextSnapshot = recordOf(rawPayload.next);
    const appliesTo = recordOf(nextSnapshot?.appliesTo ?? rawPayload.appliesTo);
    const modules = clippedStringList(appliesTo?.modules);
    const chosen = extractDecisionChosen(rawPayload, nextSnapshot);
    const title = clippedString(rawPayload.title) ?? clippedString(nextSnapshot?.title);
    const reason =
      clippedString(rawPayload.rationale) ??
      clippedString(rawPayload.reason) ??
      clippedString(rawPayload.migrationEvidence);
    const retiredRelationId =
      event.type === "decision_relation_retired" || event.type === "decision_relation_replaced"
        ? clippedString(rawPayload.relationId)
        : undefined;
    const relation = extractRelationMeta(
      recordOf(event.type === "decision_relation_replaced" ? rawPayload.replacement : rawPayload.relation),
      kindMap,
    );
    if (decisionId) extraPayload.decisionId = decisionId;
    extraPayload.decisionAction = decisionAction;
    if (title) extraPayload.title = title;
    if (reason) extraPayload.reason = reason;
    if (modules) extraPayload.modules = modules;
    if (chosen) extraPayload.chosen = chosen;
    if (relation) {
      extraPayload.relation = {
        ...relation,
        ...(retiredRelationId ? { previousRelationId: retiredRelationId } : {}),
      };
      refs = [...new Set([...refs, relation.source, relation.target])];
    } else if (retiredRelationId) {
      extraPayload.relation = {
        relationId: retiredRelationId,
        state: "retired",
        ...(reason ? { rationale: reason } : {}),
      };
      retireEventSlotMatch = slotKinds.length > 0;
    }
  } else if (event.schema === "relation-event/v1") {
    const relationRecord = recordOf(rawPayload.relation);
    refs = [
      "relation/" + event.relationId,
      ...(relationRecord && typeof relationRecord.source === "string" && typeof relationRecord.target === "string"
        ? [relationRecord.source, relationRecord.target]
        : []),
    ];
    const relation = extractRelationMeta(relationRecord, kindMap, event.relationId);
    const previousRelationId =
      event.type === "relation_replaced" ? clippedString(rawPayload.previousRelationId) : undefined;
    if (relation) {
      extraPayload.relation = {
        ...relation,
        ...(previousRelationId ? { previousRelationId } : {}),
      };
      if (relation.rationale) extraPayload.reason = relation.rationale;
    } else if (event.type === "relation_retired") {
      extraPayload.relation = {
        relationId: event.relationId,
        state: "retired",
        ...(clippedString(rawPayload.reason) ? { rationale: clippedString(rawPayload.reason) } : {}),
      };
      // relation_retired only carries relationId without source/target kinds; admit it for entity-scoped slots so tracked edges retire cleanly.
      retireEventSlotMatch = slotKinds.length > 0;
    }
  } else if (event.schema === "entity-event/v1") {
    const rawEntityKind = clippedString(rawPayload.entityKind);
    const logicalKind = rawEntityKind ? resolveLogicalKind(rawEntityKind, kindMap) : undefined;
    const entityId = clippedString(rawPayload.entityId);
    const descriptor = recordOf(rawPayload.descriptor);
    const locator = recordOf(rawPayload.locator);
    const claim = recordOf(rawPayload.declarationDocumentClaim);
    const title =
      clippedString(rawPayload.title) ??
      clippedString(descriptor?.title) ??
      clippedString(locator?.value) ??
      clippedString(claim?.path);
    const reason = clippedString(rawPayload.reason);
    if (logicalKind) extraPayload.entityKind = logicalKind;
    if (entityId) extraPayload.entityId = entityId;
    if (title) extraPayload.title = title;
    if (reason) extraPayload.reason = reason;
  } else if (event.schema === "fact-event/v1") {
    const factId = clippedString(envelope.factId);
    const supersedes = recordOf(rawPayload.supersedes);
    const supersedesRef = clippedString(supersedes?.factRef);
    if (factId) extraPayload.factId = factId;
    if (supersedesRef) extraPayload.supersedesRef = supersedesRef;
  } else if (event.schema !== "vertical-declaration-event/v1") {
    return [];
  }

  const slotKindSet = new Set(slotKinds);
  const matchedKinds = new Set<string>();
  let matchesSlot = kinds.size === 0 || retireEventSlotMatch;
  for (const ref of refs) {
    const rawKind = rawRefKind(ref);
    if (kinds.has(rawKind)) {
      matchesSlot = true;
      const logical = resolveLogicalKind(rawKind, kindMap);
      if (slotKindSet.has(logical)) matchedKinds.add(logical);
    }
  }
  if (!matchesSlot) return [];

  const summary = canonicalEventFleetSummary(event);
  return [
    {
      ...summary,
      payload: {
        ...extraPayload,
        ...summary.payload,
        ...(extraPayload.entityKind ? { entityKind: extraPayload.entityKind } : {}),
      },
      entityRefs: refs,
      matchedKinds: [...matchedKinds],
    },
  ];
}

export type DossierStatusResult = ReturnType<typeof readDossierStatus>;
export type DossierContentResult = ReturnType<typeof readDossierContent>;
export type DossierContextResult = ReturnType<typeof readDossierContext>;
