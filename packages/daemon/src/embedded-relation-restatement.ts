import {
  isMigrationImportEvent,
  runtimeTaskExecutionRelation,
  stableStringify,
  type AgentRuntimeEventV1,
  type EntityRelationRecord,
  type MigrationImportEventV1,
  type PersistedCanonicalEventV1,
} from "../../kernel/src/index.ts";

export interface EmbeddedRelationRestatementDifference {
  readonly relationId: string;
  readonly migrationOpId: string;
  readonly migrationRevision: number;
  readonly derivedOpId: string;
  readonly derivedRevision: number | null;
  readonly derivedSource: "event" | "runtime-session-task-binding-contract";
  readonly changedFields: readonly string[];
  readonly before: EntityRelationRecord;
  readonly after: EntityRelationRecord;
}

export interface EmbeddedRelationRestatementPlan {
  readonly rewrites: ReadonlyMap<string, MigrationImportEventV1>;
  readonly differences: readonly EmbeddedRelationRestatementDifference[];
}

interface DerivedRelationSource {
  readonly event: AgentRuntimeEventV1 | null;
  readonly record: EntityRelationRecord;
}

const relationRecordFields = [
  "relation_id",
  "source",
  "target",
  "type",
  "direction",
  "strength",
  "origin",
  "state",
  "rationale",
] as const;

export function planEmbeddedRelationRestatements(
  events: readonly PersistedCanonicalEventV1[],
): EmbeddedRelationRestatementPlan {
  const derivedById = new Map<string, DerivedRelationSource[]>();
  for (const event of events) {
    if (event.schema !== "agent-runtime-event/v1" || event.type !== "runtime_session_task_bound") continue;
    const record = runtimeTaskExecutionRelation(event.payload.runtimeSessionId, event.payload.taskId),
      sources = derivedById.get(record.relation_id) ?? [];
    sources.push({ event, record });
    derivedById.set(record.relation_id, sources);
  }

  const derivedTruth = new Map<string, DerivedRelationSource>();
  for (const [relationId, sources] of derivedById) {
    const variants = new Map(sources.map((source) => [stableStringify(source.record), source]));
    if (variants.size > 1)
      throw new Error(
        `Embedded relation ${relationId} has conflicting derived identities from ${sources
          .map(({ event }) => event?.opId ?? "runtime-session-task-binding-contract")
          .sort()
          .join(", ")}`,
      );
    const selected = [...sources].sort(
      (left, right) =>
        left.event!.workspaceRevision - right.event!.workspaceRevision ||
        left.event!.opId.localeCompare(right.event!.opId),
    )[0];
    if (selected) derivedTruth.set(relationId, selected);
  }

  const rewrites = new Map<string, MigrationImportEventV1>(),
    differences: EmbeddedRelationRestatementDifference[] = [];
  for (const event of events) {
    if (!isMigrationImportEvent(event) || event.payload.entity.kind !== "relation") continue;
    const before = event.payload.entity.relation,
      eventDerived = derivedTruth.get(before.relation_id),
      contractDerived = runtimeTaskExecutionContract(before);
    if (
      eventDerived &&
      contractDerived &&
      stableStringify(eventDerived.record) !== stableStringify(contractDerived.record)
    )
      throw new Error(`Embedded relation ${before.relation_id} disagrees with its runtime task-binding contract`);
    const derived = eventDerived ?? contractDerived;
    if (!derived || stableStringify(before) === stableStringify(derived.record)) continue;
    assertSameRelationIdentity(before, derived.record);
    const after = derived.record,
      rewrite: MigrationImportEventV1 = {
        ...event,
        payload: {
          ...event.payload,
          entity: {
            ...event.payload.entity,
            relation: after,
            ownerRef: after.source,
          },
        },
      };
    rewrites.set(event.opId, rewrite);
    differences.push({
      relationId: before.relation_id,
      migrationOpId: event.opId,
      migrationRevision: event.workspaceRevision,
      derivedOpId: derived.event?.opId ?? "contract:runtime-session-task-binding",
      derivedRevision: derived.event?.workspaceRevision ?? null,
      derivedSource: derived.event === null ? "runtime-session-task-binding-contract" : "event",
      changedFields: relationRecordFields.filter((field) => before[field] !== after[field]),
      before,
      after,
    });
  }
  differences.sort(
    (left, right) =>
      left.relationId.localeCompare(right.relationId) || left.migrationOpId.localeCompare(right.migrationOpId),
  );
  return { rewrites, differences };
}

function runtimeTaskExecutionContract(record: EntityRelationRecord): DerivedRelationSource | null {
  if (record.type !== "executes" || record.direction !== "directed" || record.state !== "active") return null;
  const runtimeSessionId = /^runtime-session\/([^/]+)$/u.exec(record.source)?.[1],
    taskId = /^task\/([^/]+)$/u.exec(record.target)?.[1];
  return runtimeSessionId && taskId
    ? { event: null, record: runtimeTaskExecutionRelation(runtimeSessionId, taskId) }
    : null;
}

function assertSameRelationIdentity(before: EntityRelationRecord, after: EntityRelationRecord): void {
  if (
    before.relation_id !== after.relation_id ||
    before.source !== after.source ||
    before.target !== after.target ||
    before.type !== after.type ||
    before.direction !== after.direction
  )
    throw new Error(`Embedded relation ${before.relation_id} cannot be restated across relation identity fields`);
}
