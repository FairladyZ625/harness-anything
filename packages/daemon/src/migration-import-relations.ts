import {
  deriveRelationId,
  parseEntityRef,
  type ActorIdentity,
  type CanonicalEventStore,
  type ColdRebuildSource,
  type MigrationImportEventV1,
  type RelationGraphEdgeRow,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import type {
  Draft,
  IdRemapping,
  ImportedRelation,
  MigrationDisposition,
  Prepared,
  Skip,
  SourceGitIdentity,
} from "./migration-import-types.ts";
import type { MigrationProjectionOracle } from "./migration-import-oracle.ts";

export interface ReboundRelation {
  readonly oldId: string;
  readonly sourcePath: string;
  readonly ownerRef: string;
  readonly record: ImportedRelation;
  readonly retirementReason?: "truth_gap";
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
  readonly oracle: MigrationProjectionOracle;
  readonly archivedIds: Readonly<Record<"task" | "decision" | "fact" | "relation" | "execution", Set<string>>>;
  readonly dispositions: MigrationDisposition[];
  readonly retiredIds: Set<string>;
}

export function reboundRelation(context: MigrationRelationsContext, row: RelationGraphEdgeRow): ReboundRelation | null {
  const source = context.reboundRef(row.sourceRef),
    target = context.reboundRef(row.targetRef),
    ownerRef = context.reboundRef(row.ownerRef),
    truthGap = !source || !target || !ownerRef,
    resolvedSource = truthGap ? row.sourceRef : source,
    resolvedTarget = truthGap ? row.targetRef : target,
    resolvedOwner = truthGap ? row.ownerRef || row.sourceRef : ownerRef;
  if (!resolvedSource || !resolvedTarget || !resolvedOwner) return null;
  const record: ImportedRelation = {
    relation_id: truthGap
      ? row.relationId
      : deriveRelationId({
          source: resolvedSource,
          target: resolvedTarget,
          type: row.relationType,
          direction: row.direction,
        }),
    source: resolvedSource,
    target: resolvedTarget,
    type: row.relationType,
    direction: row.direction,
    strength: row.strength,
    origin: truthGap ? row.origin : "imported_snapshot",
    rationale: row.rationale,
    state: truthGap || String(row.state) === "retired" ? "edge_retired" : row.state,
  };
  const legacyRelationId = [...context.cold.legacyRelationIds.entries()].find(
    ([, canonicalId]) => canonicalId === row.relationId,
  )?.[0];
  if (truthGap && !context.retiredIds.has(row.relationId)) {
    context.retiredIds.add(row.relationId);
    context.dispositions.push({
      entityType: "relation",
      entityId: row.relationId,
      sourcePath: row.sourcePath,
      disposition: "retired",
      reason: "truth_gap",
    });
  }
  return {
    oldId: legacyRelationId ?? row.relationId,
    sourcePath: row.sourcePath,
    ownerRef: resolvedOwner,
    record,
    ...(truthGap ? { retirementReason: "truth_gap" as const } : {}),
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
  if (!fact) {
    const parsed = parseEntityRef(ref);
    if (
      parsed !== null &&
      !parsed.externalHarness &&
      !isArchivedEndpoint(context, parsed.kind, parsed.id) &&
      context.oracle.entityKeys.has(`${parsed.kind}\0${parsed.id}`)
    )
      return ref;
    return null;
  }
  const factId = fact.at(-1)!;
  if (context.factMap.has(ref)) return context.factMap.get(ref)!;
  const canonical = `fact/${factId}`;
  return context.cold.knownFactRefs.has(canonical) && !context.archivedIds.fact.has(factId) ? canonical : null;
}

function isArchivedEndpoint(context: MigrationRelationsContext, kind: string, id: string): boolean {
  return (
    (kind === "task" && context.archivedIds.task.has(id)) ||
    (kind === "decision" && context.archivedIds.decision.has(id)) ||
    (kind === "fact" && context.archivedIds.fact.has(id)) ||
    (kind === "execution" && context.archivedIds.execution.has(id))
  );
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
      ...(value.retirementReason ? { retirementReason: value.retirementReason } : {}),
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
