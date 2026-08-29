import {
  buildColdCoverage,
  deriveRelationId,
  isMigrationImportEvent,
  type ActorIdentity,
  type CanonicalEventStore,
  type ColdRebuildSource,
  type MigrationImportEventV1,
  type RelationGraphEdgeRow,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import type {
  Draft,
  EntityKind,
  IdRemapping,
  ImportCounts,
  ImportedRelation,
  Prepared,
  Skip,
  SourceGitIdentity,
} from "./migration-import-types.ts";

export interface ReboundRelation {
  readonly oldId: string;
  readonly sourcePath: string;
  readonly ownerRef: string;
  readonly record: ImportedRelation;
}

export interface MigrationRelationsContext {
  readonly reboundRef: (ref: string) => string | null;
  readonly skips: Skip[];
  readonly cold: ColdRebuildSource;
  readonly taskMap: Map<string, string>;
  readonly decisionMap: Map<string, string>;
  readonly factMap: Map<string, string>;
  readonly relationMap: Map<string, string>;
  readonly prepare: (
    sourceKey: string,
    actor: ActorIdentity,
    kind: string,
    migratedFrom: string,
    occurredAt: string,
    workspaceRevision: number,
    entity: MigrationImportEventV1["payload"]["entity"],
    blobs: Prepared["blobs"],
  ) => Prepared;
  readonly sourceKey: string;
  readonly actorFor: (entityId: string) => ActorIdentity;
  readonly input: {
    readonly store: CanonicalEventStore;
    readonly projection: TaskProjection;
    readonly now: () => string;
  };
  readonly attribution: ReadonlyMap<string, ActorIdentity["principal"]>;
  readonly attributionUse: Record<"restored" | "fallback", number>;
  readonly actor: ActorIdentity;
  readonly migrationOperationId: (sourceKey: string, kind: string, migratedFrom: string) => string;
  readonly sourceGit: SourceGitIdentity;
  readonly migrationImportError: (code: string, detail: string) => Error;
  readonly idRemapConflict: (kind: IdRemapping["entityType"], sourceId: string, targetId: string) => Error;
  readonly remappings: IdRemapping[];
  readonly taskRead: { readonly entries: readonly unknown[] };
  readonly prepared: readonly Prepared[];
  readonly alreadyImported: Readonly<Record<EntityKind, number>>;
  readonly migratedEdges: readonly RelationGraphEdgeRow[];
}

export function reboundRelation(context: MigrationRelationsContext, row: RelationGraphEdgeRow): ReboundRelation | null {
  const source = context.reboundRef(row.sourceRef),
    target = context.reboundRef(row.targetRef),
    ownerRef = context.reboundRef(row.ownerRef);
  if (!source || !target || !ownerRef) {
    context.skips.push({
      entityType: "relation",
      migratedFrom: row.relationId,
      sourcePath: row.sourcePath,
      reason: "relation endpoint or owner was skipped",
    });
    return null;
  }
  const record: ImportedRelation = {
    relation_id: deriveRelationId({
      source,
      target,
      type: row.relationType,
      direction: row.direction,
    }),
    source,
    target,
    type: row.relationType,
    direction: row.direction,
    strength: row.strength,
    origin: "imported_snapshot",
    rationale: row.rationale,
    state: String(row.state) === "retired" ? "edge_retired" : row.state,
  };
  const legacyRelationId = [...context.cold.legacyRelationIds.entries()].find(
    ([, canonicalId]) => canonicalId === row.relationId,
  )?.[0];
  return {
    oldId: legacyRelationId ?? row.relationId,
    sourcePath: row.sourcePath,
    ownerRef,
    record,
  };
}

export function reboundRef(context: MigrationRelationsContext, ref: string): string | null {
  const task = /^task\/([^/]+)$/u.exec(ref);
  if (task) return context.taskMap.has(task[1]!) ? `task/${context.taskMap.get(task[1]!)}` : null;
  const decision = /^decision\/([^/]+)(\/.*)?$/u.exec(ref);
  if (decision)
    return context.decisionMap.has(decision[1]!)
      ? `decision/${context.decisionMap.get(decision[1]!)}${decision[2] ?? ""}`
      : null;
  const fact =
    /^fact\/([^/]+)\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(ref) ?? /^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(ref);
  if (!fact) return null;
  const factId = fact.at(-1)!;
  if (context.factMap.has(ref)) return context.factMap.get(ref)!;
  const canonical = `fact/${factId}`;
  return context.cold.knownFactRefs.has(canonical) ? canonical : null;
}

export function prepareRelation(
  context: MigrationRelationsContext,
  value: ReboundRelation,
  workspaceRevision: number,
): Prepared {
  return context.prepare(
    context.sourceKey,
    context.actorFor(value.ownerRef),
    "relation",
    value.oldId,
    context.input.now(),
    workspaceRevision,
    {
      kind: "relation",
      relation: value.record,
      ownerRef: value.ownerRef,
    },
    [],
  );
}

export function dropMap(context: MigrationRelationsContext, kind: Draft["kind"], id: string): void {
  if (kind === "task") context.taskMap.delete(id);
  if (kind === "decision") context.decisionMap.delete(id);
  if (kind === "fact") context.factMap.delete(id);
}

export function actorFor(context: MigrationRelationsContext, entityId: string): ActorIdentity {
  const principal = context.attribution.get(entityId);
  context.attributionUse[principal ? "restored" : "fallback"] += 1;
  return principal ? { principal, executor: context.actor.executor } : context.actor;
}

export function existingSourceEntity(
  context: MigrationRelationsContext,
  kind: MigrationImportEventV1["payload"]["entity"]["kind"],
  migratedFrom: string,
): MigrationImportEventV1["payload"]["entity"] | null {
  const opId = context.migrationOperationId(context.sourceKey, kind, migratedFrom),
    event = context.input.store.readEvent(opId);
  if (event === null) return null;
  if (
    event.schema !== "migration-import-event/v1" ||
    event.payload.migratedFrom !== migratedFrom ||
    event.payload.entity.kind !== kind
  )
    throw context.migrationImportError(
      "migration_source_operation_conflict",
      [
        "Git source ",
        `${context.sourceGit.rootCommit}`,
        " maps ",
        `${kind}`,
        " ",
        `${migratedFrom}`,
        " to operation ",
        `${opId}`,
        ", but the destination already binds that operation to different ",
        "migration bytes. The source-scoped remap cannot proceed; inspect the ",
        "existing migration id-map before retrying.",
      ].join(""),
    );
  return event.payload.entity;
}

export function mappedIdentifier(
  context: MigrationRelationsContext,
  kind: "task" | "decision",
  sourceId: string,
  occupied: ReadonlySet<string>,
  used: ReadonlySet<string>,
): string {
  if (!occupied.has(sourceId) && !used.has(sourceId)) return sourceId;
  const targetId = `${sourceId}__${context.sourceKey.slice(0, 10)}`;
  if (occupied.has(targetId) || used.has(targetId)) throw context.idRemapConflict(kind, sourceId, targetId);
  context.remappings.push({
    entityType: kind,
    sourceId,
    targetId,
    reason: [
      "destination already contains ",
      `${kind}`,
      " id ",
      `${sourceId}`,
      "; importing Git source ",
      `${context.sourceGit.rootCommit}`,
      " triggered the deterministic source-scoped suffix",
    ].join(""),
  });
  return targetId;
}

export function sourceCounts(context: MigrationRelationsContext): ImportCounts {
  return {
    task:
      context.taskRead.entries.length +
      context.skips.filter(({ entityType, reason }) => entityType === "task" && reason === "INDEX.md is malformed")
        .length,
    decision:
      context.cold.decisions.length + context.cold.issues.filter(({ entityType }) => entityType === "decision").length,
    fact: context.cold.facts.length + context.cold.issues.filter(({ entityType }) => entityType === "fact").length,
    relation:
      context.cold.truth.edges.length +
      context.cold.issues.filter(({ entityType }) => entityType === "relation").length,
    coverage: buildColdCoverage(context.cold, context.cold.truth.edges).length,
  };
}

export function preparedCounts(context: MigrationRelationsContext): ImportCounts {
  const kind = (name: "task" | "decision" | "fact" | "relation"): number =>
    context.prepared.filter(
      ({ event }: Prepared) => isMigrationImportEvent(event) && event.payload.entity.kind === name,
    ).length + context.alreadyImported[name];
  return {
    task: kind("task"),
    decision: kind("decision"),
    fact: kind("fact"),
    relation: kind("relation"),
    coverage: buildColdCoverage(context.cold, context.migratedEdges).filter(({ decisionRef }) =>
      context.decisionMap.has(decisionRef.slice("decision/".length)),
    ).length,
  };
}

export function projectedCounts(context: MigrationRelationsContext): ImportCounts {
  const taskIds = new Set(context.taskMap.values()),
    decisionIds = new Set(context.decisionMap.values()),
    factRefs = new Set(context.factMap.values()),
    relationIds = new Set(context.relationMap.values()),
    decisions = context.input.projection.readDecisionGraph(),
    facts = context.input.projection.readFactGraph();
  return {
    task: context.input.projection
      .list()
      .rows.filter(({ taskId, generation }) => taskIds.has(taskId) && generation === "v0").length,
    decision: decisions.decisionAnchors.filter(({ decisionId }) => decisionIds.has(decisionId)).length,
    fact: facts.facts.filter(({ ref }) => factRefs.has(ref)).length,
    relation: new Set(
      [...decisions.edges, ...facts.edges]
        .filter(({ relationId }) => relationIds.has(relationId))
        .map(({ relationId }) => relationId),
    ).size,
    coverage: decisions.coverageRows.filter(({ decisionRef }) => decisionIds.has(decisionRef.slice("decision/".length)))
      .length,
  };
}
