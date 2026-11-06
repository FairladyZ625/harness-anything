import { relationFreshnessAnchorForType } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import type { RelationType } from "@harness-anything/kernel/internal/domain/relation-type-registry.ts";
import {
  keycloakPersonIdentityWitness,
  relationFreshnessAtCut,
  relationFreshnesses,
  type EntityVersion,
  type EntityVersionWitness,
  type RelationFreshness,
} from "@harness-anything/kernel/internal/domain/entity-freshness.ts";

/**
 * The stored freshness columns of one relation at a write cut (dec_E34C4284B48AFAF152D7BF1980).
 * Witnesses are global — never filtered by a reader — and the judgment is the kernel's own
 * relationFreshnessAtCut with the relation type's declared anchor. SQLite and PostgreSQL writers
 * share this function; readers only return what it stored.
 */
export function relationFreshnessColumns(
  relation: {
    readonly type: RelationType;
    readonly target: string;
    readonly targetObservedVersion: EntityVersion | null;
  },
  projectedTarget: EntityVersionWitness,
  sourceWitness?: EntityVersionWitness,
): { readonly freshness: RelationFreshness; readonly currentTargetVersion: EntityVersion | null } {
  const anchor = relationFreshnessAnchorForType(relation.type),
    target = keycloakPersonIdentityWitness(relation.target, relation.targetObservedVersion) ?? projectedTarget;
  return {
    freshness: relationFreshnessAtCut({
      anchor,
      target,
      targetObservedVersion: relation.targetObservedVersion,
      source: anchor === "source" ? sourceWitness : undefined,
    }),
    currentTargetVersion: target.currentVersion,
  };
}

export function isRelationFreshness(value: unknown): value is RelationFreshness {
  return typeof value === "string" && (relationFreshnesses as readonly string[]).includes(value);
}
