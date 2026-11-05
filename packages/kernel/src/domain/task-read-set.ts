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
 * Relation-derived entries use only declared or imported edges. Generated execution
 * provenance is not reading material; ancestor plans enter separately via the parent chain.
 */
const explicitRelationOrigins: readonly RelationOrigin[] = ["declared", "imported_snapshot"];

export interface ReadSetEntry {
  readonly entityRef: string;
  readonly locator: string | null;
  readonly contentVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly whyIncluded: {
    /** The relation projection or the parent chain that admitted this entry. */
    readonly source: "task-relation" | "ancestor";
    readonly relationId: string;
    readonly type: RelationType | "ancestor";
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

/** Only explicit active relations can contribute reading requirements. */
export function taskReadSetRelationCandidates(edges: readonly TaskReadSetEdge[]): readonly TaskReadSetEdge[] {
  return edges.filter((edge) => edge.state === "active" && explicitRelationOrigins.includes(edge.origin));
}

export interface TaskReadSetCounterpart {
  readonly witness: EntityVersionWitness;
  /** Only the projection knows a task package path; every other kind derives from its ref. */
  readonly packagePath?: string | null;
  readonly documentAvailable?: boolean;
  readonly documentPath?: string;
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
  readonly ancestors?: readonly {
    readonly taskId: string;
    readonly packagePath: string | null;
    readonly contentVersion?: EntityVersion | null;
    readonly documentAvailable?: boolean;
  }[];
}

export interface ReadSetBlockedReason {
  readonly entityRef: string;
  readonly relationId: string;
  readonly code:
    | "required_target_orphaned"
    | "required_target_unknown"
    | "required_locator_unresolved"
    | "required_document_missing";
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
  for (const edge of taskReadSetRelationCandidates(input.edges)) {
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
  for (const ancestor of input.ancestors ?? []) {
    const entityRef = `task/${ancestor.taskId}`,
      locator = ancestor.packagePath === null ? null : `${ancestor.packagePath}/task_plan.md`;
    entries.push({
      entityRef,
      locator,
      contentVersion: ancestor.contentVersion ?? null,
      freshness: "current",
      whyIncluded: { source: "ancestor", relationId: "", type: "ancestor", rationale: "Inherited task plan" },
      edgeVersions: { targetObservedVersion: null, currentTargetVersion: null },
      required: true,
      authority: "normative",
    });
    if (locator === null)
      blockedReasons.push({
        entityRef,
        relationId: "",
        code: "required_locator_unresolved",
        detail: `Required ancestor ${entityRef} has no task plan locator.`,
      });
    else if (ancestor.documentAvailable === false)
      blockedReasons.push({
        entityRef,
        relationId: "",
        code: "required_document_missing",
        detail: `Required ancestor plan is unavailable: ${locator}`,
      });
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
  if (kind === "decision") return "normative";
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
  else if (counterpart?.documentAvailable === false)
    reasons.push({
      ...anchor,
      code: "required_document_missing",
      detail: `Required document is unavailable: ${counterpart.documentPath ?? entry.locator}`,
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
