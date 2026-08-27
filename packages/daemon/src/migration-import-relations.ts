import {
  buildColdCoverage,
  deriveRelationId,
  isMigrationImportEvent,
  type ActorIdentity,
  type MigrationImportEventV1,
  type RelationGraphEdgeRow,
} from "../../kernel/src/index.ts";
import type { Draft, ImportCounts, ImportedRelation, Prepared } from "./migration-import-types.ts";

export function reboundRelation(
  context: any,
  row: RelationGraphEdgeRow,
): {
  readonly oldId: string;
  readonly sourcePath: string;
  readonly ownerRef: string;
  readonly record: ImportedRelation;
} | null {
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
    state: (row.state as string) === "retired" ? "edge_retired" : row.state,
  };
  const legacyRelationId = [...(context.cold.legacyRelationIds as ReadonlyMap<string, string>).entries()].find(
    ([, canonicalId]) => canonicalId === row.relationId,
  )?.[0];
  return {
    oldId: legacyRelationId ?? row.relationId,
    sourcePath: row.sourcePath,
    ownerRef,
    record,
  };
}

export function reboundRef(context: any, ref: string): string | null {
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
  context: any,
  value: NonNullable<ReturnType<typeof context.reboundRelation>>,
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

export function dropMap(context: any, kind: Draft["kind"], id: string): void {
  if (kind === "task") context.taskMap.delete(id);
  if (kind === "decision") context.decisionMap.delete(id);
  if (kind === "fact") context.factMap.delete(id);
}

export function actorFor(context: any, entityId: string): ActorIdentity {
  const principal = context.attribution.get(entityId);
  context.attributionUse[principal ? "restored" : "fallback"] += 1;
  return principal ? { principal, executor: context.actor.executor } : context.actor;
}

export function existingSourceEntity(
  context: any,
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
  context: any,
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

export function sourceCounts(context: any): ImportCounts {
  return {
    task:
      context.taskRead.entries.length +
      context.skips.filter(
        ({ entityType, reason }: { readonly entityType: string; readonly reason: string }) =>
          entityType === "task" && reason === "INDEX.md is malformed",
      ).length,
    decision:
      context.cold.decisions.length +
      context.cold.issues.filter(({ entityType }: { readonly entityType: string }) => entityType === "decision").length,
    fact:
      context.cold.facts.length +
      context.cold.issues.filter(({ entityType }: { readonly entityType: string }) => entityType === "fact").length,
    relation:
      context.cold.truth.edges.length +
      context.cold.issues.filter(({ entityType }: { readonly entityType: string }) => entityType === "relation").length,
    coverage: buildColdCoverage(context.cold, context.cold.truth.edges).length,
  };
}

export function preparedCounts(context: any): ImportCounts {
  const kind = (name: keyof typeof context.alreadyImported): number =>
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

export function projectedCounts(context: any): ImportCounts {
  const taskIds = new Set(context.taskMap.values()),
    decisionIds = new Set(context.decisionMap.values()),
    factRefs = new Set(context.factMap.values()),
    relationIds = new Set(context.relationMap.values()),
    decisions = context.input.projection.readDecisionGraph(),
    facts = context.input.projection.readFactGraph();
  return {
    task: context.input.projection
      .list()
      .rows.filter(
        ({ taskId, generation }: { readonly taskId: string; readonly generation: string }) =>
          taskIds.has(taskId) && generation === "v0",
      ).length,
    decision: decisions.decisionAnchors.filter(({ decisionId }: { readonly decisionId: string }) =>
      decisionIds.has(decisionId),
    ).length,
    fact: facts.facts.filter(({ ref }: { readonly ref: string }) => factRefs.has(ref)).length,
    relation: new Set(
      [...decisions.edges, ...facts.edges]
        .filter(({ relationId }) => relationIds.has(relationId))
        .map(({ relationId }) => relationId),
    ).size,
    coverage: decisions.coverageRows.filter(({ decisionRef }: { readonly decisionRef: string }) =>
      decisionIds.has(decisionRef.slice("decision/".length)),
    ).length,
  };
}
