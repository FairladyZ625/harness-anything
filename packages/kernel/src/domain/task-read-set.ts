import type { EntityVersion, EntityVersionWitness, RelationFreshness } from "./entity-freshness.ts";
import { getEntityKindContract } from "./entity-kind-registry.ts";
import type { RelationOrigin, RelationStrength, RelationType } from "./entity-relation.ts";
import { parseEntityRef } from "./entity-ref.ts";

export const READ_SET_SCHEMA = "read-set/v1" as const;

/**
 * The three authority classes of `context-assembly-design.md` §4: normative rules
 * (standards, decisions in force), descriptive facts, and historical experience.
 */
export type ReadSetAuthority = "normative" | "descriptive" | "historical";

/**
 * Only the edges the task itself declares enter the read set
 * (`context-assembly-design.md` §3.2 step 1, "显式 active relations"). Generated and
 * inferred edges are execution provenance — the execution that runs the task, the
 * runtime session bound to it, the facts it emitted — not reading material.
 */
const explicitRelationOrigins: readonly RelationOrigin[] = ["declared", "imported_snapshot"];

export interface ReadSetEntry {
  readonly entityRef: string;
  readonly locator: string | null;
  readonly contentVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly whyIncluded: {
    /** W3 adds `context-route` here; this wave derives entries from the task's own edges only. */
    readonly source: "task-relation";
    readonly relationId: string;
    readonly type: RelationType;
    readonly rationale: string;
  };
  /** The relation revisions carried through unchanged so two edge nodes can compare answers. */
  readonly edgeVersions: {
    readonly targetObservedVersion: EntityVersion | null;
    readonly currentTargetVersion: EntityVersion | null;
  };
  readonly required: boolean;
  readonly authority: ReadSetAuthority;
}

export interface TaskReadSetEdge {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: RelationType;
  readonly strength: RelationStrength;
  readonly origin: RelationOrigin;
  readonly state: string;
  readonly freshness: RelationFreshness;
  readonly rationale: string;
  readonly targetObservedVersion: EntityVersion | null;
  readonly currentTargetVersion: EntityVersion | null;
}

export interface TaskReadSetCounterpart {
  readonly witness: EntityVersionWitness;
  /** Only the projection knows a task package path; every other kind derives from its ref. */
  readonly packagePath?: string | null;
}

export interface ReadSetProjectionCut {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
}

export interface TaskReadSetInput {
  readonly taskRef: string;
  readonly edges: readonly TaskReadSetEdge[];
  readonly counterparts: ReadonlyMap<string, TaskReadSetCounterpart>;
  readonly projectionCut: ReadSetProjectionCut;
}

export interface ReadSetBlockedReason {
  readonly entityRef: string;
  readonly relationId: string;
  readonly code: "required_target_orphaned" | "required_target_unknown" | "required_locator_unresolved";
  readonly detail: string;
}

export interface TaskReadSet {
  readonly schema: typeof READ_SET_SCHEMA;
  readonly taskRef: string;
  readonly entries: readonly ReadSetEntry[];
  readonly blocked: boolean;
  readonly blockedReasons: readonly ReadSetBlockedReason[];
  readonly projectionCut: ReadSetProjectionCut;
}

/**
 * The single authority for what a task must read at one projection cut. Ordering,
 * `required`, `authority` and `blocked` are decided here and nowhere else; the CLI,
 * GUI and SDK present this result rather than recomputing it
 * (`governed-entity-design.md` §6).
 */
export function deriveTaskReadSet(input: TaskReadSetInput): TaskReadSet {
  const entries: ReadSetEntry[] = [],
    blockedReasons: ReadSetBlockedReason[] = [];
  for (const edge of input.edges) {
    if (edge.state !== "active" || !explicitRelationOrigins.includes(edge.origin)) continue;
    const entityRef = edge.sourceRef === input.taskRef ? edge.targetRef : edge.sourceRef;
    if (entityRef === input.taskRef) continue;
    const counterpart = input.counterparts.get(entityRef),
      entry: ReadSetEntry = {
        entityRef,
        locator: readSetLocator(entityRef, counterpart?.packagePath ?? null),
        contentVersion: counterpart?.witness.currentVersion ?? null,
        freshness: edge.freshness,
        whyIncluded: {
          source: "task-relation",
          relationId: edge.relationId,
          type: edge.relationType,
          rationale: edge.rationale,
        },
        edgeVersions: {
          targetObservedVersion: edge.targetObservedVersion,
          currentTargetVersion: edge.currentTargetVersion,
        },
        required: edge.strength === "strong",
        authority: readSetAuthority(entityRef),
      };
    entries.push(entry);
    if (entry.required) blockedReasons.push(...readSetGaps(entry, counterpart));
  }
  entries.sort(compareReadSetEntries);
  return Object.freeze({
    schema: READ_SET_SCHEMA,
    taskRef: input.taskRef,
    entries,
    blocked: blockedReasons.length > 0,
    blockedReasons,
    projectionCut: input.projectionCut,
  });
}

/** Reading order between the authority classes. */
const readSetAuthorityRank: Record<ReadSetAuthority, number> = { normative: 0, descriptive: 1, historical: 2 };

function readSetAuthority(entityRef: string): ReadSetAuthority {
  const kind = parseEntityRef(entityRef)?.kind;
  if (kind === "decision" || kind === "policy") return "normative";
  if (kind === "fact") return "descriptive";
  return "historical";
}

/**
 * The ledger-relative place a reader opens. Decision and fact paths follow their own
 * write paths (`decision-event-document.ts`, `fact-event.ts`); entity-store kinds reuse
 * the registry template; task packages are only known to the projection. A kind with no
 * document resolves to null instead of guessing a file by name.
 */
function readSetLocator(entityRef: string, packagePath: string | null): string | null {
  const parsed = parseEntityRef(entityRef);
  if (!parsed) return null;
  if (parsed.kind === "task") return packagePath;
  if (parsed.kind === "decision") return `decisions/decision-${parsed.id}/decision.md`;
  if (parsed.kind === "fact") return `facts/${parsed.id}.md`;
  const template = getEntityKindContract(parsed.kind)?.entityStore?.document.pathTemplate;
  return template === undefined ? null : template.replace("{id}", parsed.id);
}

function readSetGaps(
  entry: ReadSetEntry,
  counterpart: TaskReadSetCounterpart | undefined,
): readonly ReadSetBlockedReason[] {
  const reasons: ReadSetBlockedReason[] = [],
    anchor = { entityRef: entry.entityRef, relationId: entry.whyIncluded.relationId },
    witnessFreshness = counterpart?.witness.freshness ?? "unknown";
  if (entry.freshness === "orphaned" || witnessFreshness === "orphaned")
    reasons.push({
      ...anchor,
      code: "required_target_orphaned",
      detail: `Required ${entry.entityRef} is orphaned at this cut.`,
    });
  else if (witnessFreshness === "unknown")
    reasons.push({
      ...anchor,
      code: "required_target_unknown",
      detail: `Required ${entry.entityRef} has no entity witness at this cut.`,
    });
  if (entry.locator === null)
    reasons.push({
      ...anchor,
      code: "required_locator_unresolved",
      detail: `Required ${entry.entityRef} resolves to no locator.`,
    });
  return reasons;
}

/**
 * Stable and independent of any file path: required first, then authority class,
 * relation type, entity ref, and finally the relation id so two edges to the same
 * entity keep one total order.
 */
function compareReadSetEntries(left: ReadSetEntry, right: ReadSetEntry): number {
  if (left.required !== right.required) return left.required ? -1 : 1;
  const authority = readSetAuthorityRank[left.authority] - readSetAuthorityRank[right.authority];
  if (authority !== 0) return authority;
  return (
    compareText(left.whyIncluded.type, right.whyIncluded.type) ||
    compareText(left.entityRef, right.entityRef) ||
    compareText(left.whyIncluded.relationId, right.whyIncluded.relationId)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
