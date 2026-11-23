import { parseEntityRef } from "@harness-anything/kernel/internal/domain/entity-ref.ts";
import type { DossierSlot } from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { DecisionProjectionRow, TaskIndexProjectionRow, WriteSource } from "@harness-anything/kernel";
import { dossierError, type DossierReader } from "../dossier-state.ts";

const MAX_DOSSIER_TEXT = 280;
const MAX_DOSSIER_TAGS = 6;
const BOOTSTRAP_SCHEMA = "dossier-bootstrap/v1";

export interface DossierProjectedChange {
  readonly eventId: string;
  readonly schema: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly source: WriteSource;
  readonly taskId?: string;
  readonly decisionId?: string;
  readonly factId?: string;
  readonly actor?: {
    readonly executor?: { readonly id: string };
    readonly principal?: { readonly personId: string };
  };
  readonly payload: Readonly<Record<string, unknown>>;
  readonly entityRefs: readonly string[];
  readonly matchedKinds: readonly string[];
}

function clipText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_DOSSIER_TEXT ? trimmed : `${trimmed.slice(0, MAX_DOSSIER_TEXT - 1)}…`;
}

function rawKindFromRef(ref: string): string {
  const parsed = parseEntityRef(ref);
  if (parsed) return parsed.kind;
  if (ref.startsWith("entity-kind/")) {
    const parts = ref.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : ref;
  }
  const slash = ref.indexOf("/");
  return slash > 0 ? ref.slice(0, slash) : ref;
}

function mapActor(actor: unknown): DossierProjectedChange["actor"] | undefined {
  if (!actor || typeof actor !== "object") return undefined;
  const record = actor as Readonly<Record<string, unknown>>;
  const principal =
    record.principal && typeof record.principal === "object"
      ? (record.principal as Readonly<Record<string, unknown>>)
      : null;
  const executor =
    record.executor && typeof record.executor === "object"
      ? (record.executor as Readonly<Record<string, unknown>>)
      : null;
  const personId = clipText(principal?.personId);
  const executorId = clipText(executor?.id);
  if (!personId && !executorId) return undefined;
  return {
    ...(personId ? { principal: { personId } } : {}),
    ...(executorId ? { executor: { id: executorId } } : {}),
  };
}

function taskChangeFromRow(row: TaskIndexProjectionRow, fallbackRevision: number): DossierProjectedChange {
  const payload: Record<string, unknown> = {
    title: clipText(row.title) ?? row.taskId,
    taskClass: row.taskClass,
    taskStatus: row.status,
    parentTaskId: row.parentTaskId,
  };
  const packagePath = clipText(row.packagePath);
  if (packagePath) payload.packagePath = packagePath;
  const creatorId = clipText(row.createdByPersonId);
  return {
    eventId: `boot-task-${row.taskId}`,
    schema: BOOTSTRAP_SCHEMA,
    type: "seed_task",
    occurredAt: row.updatedAt,
    workspaceRevision: fallbackRevision,
    source: "local",
    taskId: row.taskId,
    ...(creatorId ? { actor: { principal: { personId: creatorId } } } : {}),
    payload,
    entityRefs: [`task/${row.taskId}`],
    matchedKinds: ["task"],
  };
}

function decisionChangeFromRow(row: DecisionProjectionRow): DossierProjectedChange {
  const decisionAction =
    row.state === "in_effect"
      ? "accepted"
      : row.state === "superseded"
        ? "superseded"
        : row.state === "outcome_retired"
          ? "retired"
          : row.state === "rejected"
            ? "rejected"
            : row.state === "deferred"
              ? "deferred"
              : "proposed";
  const chosen = row.chosen
    .map((entry) => {
      const text = clipText(entry.text);
      if (!text) return undefined;
      const id = clipText(entry.id);
      return id ? `${id}: ${text}` : text;
    })
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, MAX_DOSSIER_TAGS);
  const modules = row.appliesTo.modules
    .map((mod) => clipText(mod))
    .filter((mod): mod is string => mod !== undefined)
    .slice(0, MAX_DOSSIER_TAGS);
  const actor = mapActor(row.arbiter ?? row.proposer);
  return {
    eventId: `boot-dec-${row.decisionId}-${row.workspaceRevision}`,
    schema: BOOTSTRAP_SCHEMA,
    type: "seed_decision",
    occurredAt: row.decidedAt ?? row.proposedAt,
    workspaceRevision: row.workspaceRevision,
    source: "local",
    decisionId: row.decisionId,
    ...(actor ? { actor } : {}),
    payload: {
      decisionId: row.decisionId,
      decisionAction,
      title: clipText(row.title) ?? row.decisionId,
      ...(modules.length > 0 ? { modules } : {}),
      ...(chosen.length > 0 ? { chosen } : {}),
    },
    entityRefs: [`decision/${row.decisionId}`],
    matchedKinds: ["decision"],
  };
}

/**
 * Build a strictly bounded O(1) baseline of projection seed items (schema `dossier-bootstrap/v1`,
 * never canonical aggregate events) from the current TaskProjection so cold or severely lagging
 * dossier slots can jump straight to sourceWatermark without scanning full history.
 */
export function buildDossierBootstrapChanges(input: {
  readonly reader: DossierReader;
  readonly slot: DossierSlot;
  readonly sourceWatermark: number;
  readonly entityKinds: ReadonlySet<string>;
  readonly kindMap: Readonly<Record<string, string>>;
}): readonly DossierProjectedChange[] {
  const { reader, slot, sourceWatermark, entityKinds, kindMap } = input;
  const { projection } = reader;
  if (
    !projection.readCut ||
    !projection.readTaskIndex ||
    !projection.listDecisions ||
    !projection.searchFacts ||
    !projection.readRelationQuery ||
    !projection.listEntities
  ) {
    dossierError("invalid_store", "The dossier bootstrap requires an indexed task projection.");
  }

  const cut = projection.readCut();
  const cutReady = cut.status === "ready";
  if (!cutReady || cut.watermark < sourceWatermark) {
    dossierError("projection_pending", "The dossier projection has not caught up with the source.");
  }

  const slotKindSet = new Set(slot.entityKinds);
  const unrestricted = slotKindSet.size === 0;
  const wantsKind = (kind: string) => unrestricted || slotKindSet.has(kind);
  const items: DossierProjectedChange[] = [];

  const sliceCap = storageReadPolicy.defaultValue.pageSizes.sessions;
  const decisionCap = storageReadPolicy.defaultValue.listDefaults.dispatchLifecycleLimit;
  const secondaryCap = storageReadPolicy.defaultValue.listDefaults.taskLimit;

  if (wantsKind("decision")) {
    const active = projection.listDecisions({ state: "in_effect", limit: decisionCap, withBody: false }).decisions;
    const proposed = projection.listDecisions({ state: "proposed", limit: secondaryCap, withBody: false }).decisions;
    const superseded = projection.listDecisions({
      state: "superseded",
      limit: secondaryCap,
      withBody: false,
    }).decisions;
    const retired = projection.listDecisions({
      state: "outcome_retired",
      limit: secondaryCap,
      withBody: false,
    }).decisions;
    for (const row of [...superseded, ...retired, ...proposed, ...active]) {
      items.push(decisionChangeFromRow(row));
    }
  }

  if (wantsKind("task")) {
    const byTaskId = new Map<string, TaskIndexProjectionRow>();
    const recentFloor = Math.max(0, sourceWatermark - sliceCap * decisionCap);
    const openTasks = projection.readTaskIndex({
      openOnly: true,
      activePackagesOnly: true,
      limit: decisionCap,
      withAttribution: true,
    }).rows;
    const recentTasks = projection.readTaskIndex({
      changedAfterRevision: recentFloor,
      activePackagesOnly: true,
      limit: decisionCap,
      withAttribution: true,
    }).rows;
    const blocked = projection.readTaskIndex({
      status: "blocked",
      activePackagesOnly: true,
      limit: sliceCap + 1,
      withAttribution: true,
    }).rows;
    const openWorks = projection.readTaskIndex({
      workRootsOnly: true,
      openOnly: true,
      activePackagesOnly: true,
      presentationStatus: true,
      limit: decisionCap,
      withAttribution: true,
    }).rows;
    const recentWorks = projection.readTaskIndex({
      workRootsOnly: true,
      changedAfterRevision: recentFloor,
      activePackagesOnly: true,
      presentationStatus: true,
      limit: secondaryCap,
      withAttribution: true,
    }).rows;
    for (const row of recentTasks) byTaskId.set(row.taskId, row);
    for (const row of openTasks) byTaskId.set(row.taskId, row);
    for (const row of blocked) byTaskId.set(row.taskId, row);
    for (const row of recentWorks) byTaskId.set(row.taskId, row);
    for (const row of openWorks) byTaskId.set(row.taskId, row);

    if (byTaskId.size === 0) {
      const fallbackTasks = projection.readTaskIndex({
        activePackagesOnly: true,
        limit: secondaryCap,
        withAttribution: true,
      }).rows;
      const fallbackWorks = projection.readTaskIndex({
        workRootsOnly: true,
        activePackagesOnly: true,
        presentationStatus: true,
        limit: secondaryCap,
        withAttribution: true,
      }).rows;
      for (const row of fallbackTasks) byTaskId.set(row.taskId, row);
      for (const row of fallbackWorks) byTaskId.set(row.taskId, row);
    }

    const missingParents = [
      ...new Set(
        [...byTaskId.values()]
          .map((row) => row.parentTaskId)
          .filter((parentId): parentId is string => typeof parentId === "string" && !byTaskId.has(parentId)),
      ),
    ].slice(0, decisionCap);
    if (missingParents.length > 0) {
      const parents = projection.readTaskIndex({
        taskIds: missingParents,
        presentationStatus: true,
        limit: missingParents.length,
        withAttribution: true,
      }).rows;
      for (const row of parents) byTaskId.set(row.taskId, row);
    }

    const orderedTasks = [...byTaskId.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const baseRev = Math.max(1, sourceWatermark - orderedTasks.length);
    orderedTasks.forEach((row, idx) => {
      items.push(taskChangeFromRow(row, Math.min(sourceWatermark, baseRev + idx)));
    });
  }

  if (wantsKind("fact")) {
    const facts = projection.searchFacts({ limit: secondaryCap }).facts;
    for (const fact of facts) {
      if (fact.invalidated || fact.archived) continue;
      const actor = mapActor(fact.actor);
      items.push({
        eventId: `boot-fact-${fact.factId}`,
        schema: BOOTSTRAP_SCHEMA,
        type: "seed_fact",
        occurredAt: fact.occurredAt,
        workspaceRevision: fact.workspaceRevision,
        source: fact.source,
        factId: fact.factId,
        ...(fact.taskId ? { taskId: fact.taskId } : {}),
        ...(actor ? { actor } : {}),
        payload: {
          factId: fact.factId,
          statement: clipText(fact.statement) ?? fact.factId,
        },
        entityRefs: [fact.ref],
        matchedKinds: ["fact"],
      });
    }
  }

  for (const [opaqueKind, logicalKind] of Object.entries(kindMap)) {
    if (!wantsKind(logicalKind)) continue;
    const rows = projection.listEntities(opaqueKind, false, secondaryCap);
    rows.forEach((row, idx) => {
      const val = row.value && typeof row.value === "object" ? row.value : {};
      const descriptor =
        val.descriptor && typeof val.descriptor === "object"
          ? (val.descriptor as Readonly<Record<string, unknown>>)
          : undefined;
      const locator =
        val.locator && typeof val.locator === "object" ? (val.locator as Readonly<Record<string, unknown>>) : undefined;
      const title = clipText(val.title) ?? clipText(descriptor?.title) ?? clipText(locator?.value) ?? row.id;
      const updatedAt = clipText(val.updatedAt) ?? new Date(0).toISOString();
      items.push({
        eventId: `boot-ent-${logicalKind}-${row.id}`,
        schema: BOOTSTRAP_SCHEMA,
        type: "seed_entity",
        occurredAt: updatedAt,
        workspaceRevision: row.workspaceRevision || Math.max(1, sourceWatermark - rows.length + idx),
        source: "local",
        payload: {
          entityKind: logicalKind,
          entityId: row.id,
          title,
        },
        entityRefs: [`${opaqueKind}/${row.id}`],
        matchedKinds: [logicalKind],
      });
    });
  }

  const relations = projection.readRelationQuery({ state: "active", limit: sliceCap }).rows;
  for (const edge of relations) {
    const refs = [`relation/${edge.relationId}`, edge.sourceRef, edge.targetRef];
    const matchedKinds = new Set<string>();
    let matchesSlot = unrestricted;
    for (const ref of refs) {
      const raw = rawKindFromRef(ref);
      if (entityKinds.has(raw)) {
        matchesSlot = true;
        const logical = kindMap[raw] ?? raw;
        if (slotKindSet.has(logical)) matchedKinds.add(logical);
      }
    }
    if (!matchesSlot) continue;
    const sourceKind = kindMap[rawKindFromRef(edge.sourceRef)] ?? rawKindFromRef(edge.sourceRef);
    const targetKind = kindMap[rawKindFromRef(edge.targetRef)] ?? rawKindFromRef(edge.targetRef);
    const rationale = clipText(edge.rationale);
    items.push({
      eventId: `boot-rel-${edge.relationId}`,
      schema: BOOTSTRAP_SCHEMA,
      type: "seed_relation",
      occurredAt: new Date(0).toISOString(),
      workspaceRevision: edge.workspaceRevision ?? sourceWatermark,
      source: "local",
      payload: {
        ...(rationale ? { reason: rationale } : {}),
        relation: {
          relationId: edge.relationId,
          source: edge.sourceRef,
          target: edge.targetRef,
          sourceKind,
          targetKind,
          relationType: edge.relationType,
          state: edge.state,
          ...(rationale ? { rationale } : {}),
        },
      },
      entityRefs: refs,
      matchedKinds: [...matchedKinds],
    });
  }

  return items.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
}
