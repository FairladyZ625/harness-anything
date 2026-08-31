import type { MigrationImportContext } from "./migration-import-run.ts";
import { migrationOracleKinds, type MigrationOracleKind } from "./migration-import-oracle.ts";
import type { MigrationKindReconciliation } from "./migration-import-types.ts";

export function reconcileProjectionOracle(
  context: MigrationImportContext,
): Readonly<Record<MigrationOracleKind, MigrationKindReconciliation>> {
  return Object.fromEntries(
    migrationOracleKinds.map((kind) => [kind, reconcileKind(context, kind)]),
  ) as unknown as Readonly<Record<MigrationOracleKind, MigrationKindReconciliation>>;
}

function reconcileKind(context: MigrationImportContext, kind: MigrationOracleKind): MigrationKindReconciliation {
  const sourceIds = oracleIds(context, kind),
    includedIds = new Set([...sourceIds].filter((id) => isIncluded(context, kind, id))),
    derivedIds = intersection(sourceIds, context.derivedIds[kind]),
    archivedIds = intersection(sourceIds, context.archivedIds[kind]),
    retiredIds = kind === "relation" ? intersection(sourceIds, context.retiredIds) : new Set<string>(),
    explainedIds = union(derivedIds, archivedIds, retiredIds),
    baselineIds = new Set([...includedIds].filter((id) => !explainedIds.has(id))),
    differenceIds = difference(sourceIds, baselineIds),
    missingIds = [...difference(sourceIds, includedIds)].sort(),
    passed = missingIds.length === 0 && equal(differenceIds, explainedIds);
  return {
    source: sourceIds.size,
    target: includedIds.size,
    difference: differenceIds.size,
    derived: derivedIds.size,
    archived: archivedIds.size,
    retired: retiredIds.size,
    missingIds,
    passed,
  };
}

function oracleIds(context: MigrationImportContext, kind: MigrationOracleKind): ReadonlySet<string> {
  if (kind === "task") return new Set(context.oracle.tasks.keys());
  if (kind === "decision") return new Set(context.oracle.decisions.keys());
  if (kind === "fact") return new Set(context.oracle.facts.keys());
  if (kind === "relation") return new Set(context.oracle.relations.keys());
  return new Set(context.oracle.executions.keys());
}

function isIncluded(context: MigrationImportContext, kind: MigrationOracleKind, id: string): boolean {
  if (context.archivedIds[kind].has(id)) return true;
  if (kind === "task") return context.taskMap.has(id);
  if (kind === "decision") return context.decisionMap.has(id);
  if (kind === "fact")
    return [...context.factMap.entries()].some(
      ([source, target]) => source.endsWith(`/${id}`) || target.endsWith(`/${id}`),
    );
  if (kind === "relation") return context.relationMap.has(id) || context.retiredIds.has(id);
  return context.nativeExecutionIds.has(id);
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => right.has(value)));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function union(...sets: readonly ReadonlySet<string>[]): Set<string> {
  return new Set(sets.flatMap((set) => [...set]));
}

function equal(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
