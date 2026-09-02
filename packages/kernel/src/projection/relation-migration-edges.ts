import { parseEntityRef } from "../domain/entity-ref.ts";
import {
  relationStrengthForType,
  validateRelationRecordsForHost,
  type EntityRelationRecord,
} from "../domain/entity-relation.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { legacyRelationManualReason } from "./relation-migration-normalization.ts";

export interface MigrationRelationEntry {
  readonly hostRef: string;
  readonly ownerRef: string;
  readonly record: EntityRelationRecord;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface MigrationRelationIssue {
  readonly entityType: "relation";
  readonly migratedFrom: string;
  readonly sourcePath: string;
  readonly reason: string;
}

export function readMigrationRelationEdges(
  entries: readonly MigrationRelationEntry[],
  taskIds: ReadonlySet<string>,
  decisionRefs: ReadonlySet<string>,
  factRefs: ReadonlySet<string>,
  seedKnownRefs: ReadonlySet<string> = new Set(),
  requireWritableTriples = false,
): { readonly rows: readonly RelationGraphEdgeRow[]; readonly issues: readonly MigrationRelationIssue[] } {
  const seen = new Set<string>(),
    issues: MigrationRelationIssue[] = [],
    rows: RelationGraphEdgeRow[] = [],
    relationRefs = new Set(entries.map(({ record }) => `relation/${record.relation_id}`)),
    known = (ref: string): boolean => {
      if (seedKnownRefs.has(ref)) return true;
      const parsed = parseEntityRef(ref);
      return Boolean(
        parsed &&
          !parsed.externalHarness &&
          (parsed.kind === "task"
            ? taskIds.has(parsed.id)
            : parsed.kind === "decision"
              ? decisionRefs.has(ref)
              : parsed.kind === "fact"
                ? factRefs.has(ref)
                : parsed.kind === "relation" && relationRefs.has(ref)),
      );
    };
  for (const entry of [...entries].sort((a, b) =>
    `${a.sourcePath}\0${a.recordIndex}`.localeCompare(`${b.sourcePath}\0${b.recordIndex}`),
  )) {
    const validation = validateRelationRecordsForHost(entry.hostRef, [entry.record]),
      manualReason = requireWritableTriples ? legacyRelationManualReason(entry.record) : null,
      reason =
        manualReason ??
        (seen.has(entry.record.relation_id)
          ? "duplicate relation_id"
          : (validation[0]?.message ??
            (!known(entry.record.source) || !known(entry.record.target) ? "relation endpoint does not resolve" : "")));
    if (reason) {
      issues.push({
        entityType: "relation",
        migratedFrom: entry.record.relation_id,
        sourcePath: entry.sourcePath,
        reason,
      });
      continue;
    }
    seen.add(entry.record.relation_id);
    rows.push({
      relationId: entry.record.relation_id,
      sourceRef: entry.record.source,
      targetRef: entry.record.target,
      relationType: entry.record.type,
      direction: entry.record.direction,
      strength: relationStrengthForType(entry.record.type),
      origin: entry.record.origin,
      state: entry.record.state,
      targetObservedVersion:
        "targetObservedVersion" in entry.record &&
        (typeof entry.record.targetObservedVersion === "string" ||
          typeof entry.record.targetObservedVersion === "number")
          ? entry.record.targetObservedVersion
          : null,
      currentTargetVersion: null,
      freshness: "suspect",
      rationale: entry.record.rationale,
      ownerRef: entry.ownerRef,
      sourcePath: entry.sourcePath,
      recordIndex: entry.recordIndex,
    });
  }
  return {
    rows: rows.sort((a, b) =>
      `${a.sourceRef}\0${a.targetRef}\0${a.relationId}`.localeCompare(
        `${b.sourceRef}\0${b.targetRef}\0${b.relationId}`,
      ),
    ),
    issues,
  };
}
