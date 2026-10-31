import type { EntityRelationRecord, RelationOrigin, RelationState, RelationType } from "../domain/entity-relation.ts";
import type { EntityVersion, RelationFreshness } from "../domain/entity-freshness.ts";
import type { FactConfidence, FactDomainType, FactEventV1, FactMemoryClass } from "../domain/fact-event.ts";
import type { ActorIdentity, WriteSource } from "../domain/write-chain.contract.ts";
import type { RelationEntity } from "../domain/relation-event.ts";
import type { ReplayTaskStatus } from "../domain/task.ts";

export interface DecisionReadinessProjection {
  readonly schema: "decision-readiness/v1";
  readonly basisCommitSha: string;
  readonly appliesToDrift: {
    readonly state: "clear" | "drift" | "unknown";
    readonly paths: readonly string[];
    readonly lastCommitAt: string | null;
    readonly summary: string;
  };
  readonly conflictMarker: {
    readonly state: "clear" | "conflict" | "unknown";
    readonly paths: readonly string[];
    readonly summary: string;
  };
}

export interface FactProjectionRow {
  readonly schema: "fact-row/v1";
  readonly ref: string;
  readonly taskId?: string;
  readonly factId: string;
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly observedCommit?: string;
  readonly confidence: FactConfidence;
  readonly domainTypes?: readonly FactDomainType[];
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: FactEventV1["payload"]["memoryTags"];
  readonly provenance: FactEventV1["payload"]["provenance"];
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly state: "standing" | "superseded_fact";
  readonly invalidated: boolean;
  readonly archived: boolean;
}

export interface FactRelationEdgeRow {
  readonly relationId: string;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: RelationType;
  readonly direction: "directed";
  readonly strength: "strong";
  readonly origin: RelationOrigin;
  readonly state: RelationState;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface FactSearchFilters {
  readonly query?: string;
  readonly taskId?: string;
  readonly refs?: readonly string[];
  readonly confidence?: FactConfidence;
  readonly domainType?: FactDomainType;
  readonly memoryClass?: FactMemoryClass;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface FactSearchPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export interface FactDomainTypeRow {
  readonly domainType: FactDomainType;
  readonly registeredByFactId: string;
  readonly workspaceRevision: number;
}

export interface RelationGraphEdgeRow {
  readonly relationId: string;
  readonly workspaceRevision: number | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly targetObservedVersion: EntityVersion | null;
  readonly currentTargetVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface RelationCoverageRow {
  readonly decisionRef: string;
  readonly claimRef: string;
  readonly status: "covered" | "uncovered";
  readonly covered: boolean;
  readonly fulfillment: "evidenced" | "delivered" | "standing-policy" | null;
  readonly coveringFactRef?: string;
  readonly refutingFactRefs?: readonly string[];
  readonly relationPath: readonly string[];
  readonly basisRevision?: number;
}

export interface FactAnchorRow {
  readonly factRef: string;
  readonly taskId?: string;
  readonly factId: string;
  readonly sourcePath: string;
}

export interface RelationFactRow {
  readonly schema: "task-fact-row/v1";
  readonly ref: string;
  readonly taskId?: string;
  readonly factId: string;
  readonly statement: string;
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: "low" | "medium" | "high";
  readonly memoryClass: "semantic" | "episodic" | "procedural";
  readonly memoryTags: readonly string[];
  readonly provenance: readonly { readonly runtime: string; readonly sessionId: string; readonly boundAt: string }[];
  readonly liveness: "standing" | "superseded_fact";
  readonly invalidated: boolean;
  readonly archived: boolean;
}

export interface DecisionAnchorTruth {
  readonly decisionRef: string;
  readonly decisionId: string;
  readonly anchorRefs: readonly string[];
  readonly sourcePath: string;
}

export interface EventBackedRelationTruth {
  readonly factAnchors: readonly FactAnchorRow[];
  readonly decisionAnchors: readonly DecisionAnchorTruth[];
  readonly edges: readonly RelationGraphEdgeRow[];
  readonly coverageRows: readonly RelationCoverageRow[];
}

export interface RelationGraphProjection {
  readonly edges: readonly RelationGraphEdgeRow[];
  readonly coverageRows: readonly RelationCoverageRow[];
  readonly factAnchors: readonly FactAnchorRow[];
}

export interface ProjectionPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

export interface TaskProjectionListQuery {
  readonly status?: ReplayTaskStatus;
  readonly changedAfterRevision?: number;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly pinnedFirst?: boolean;
  readonly parentTaskId?: string | null;
  readonly workKind?: string;
  readonly riskTier?: string;
  readonly urgency?: string;
  readonly workRootsOnly?: boolean;
  readonly openOnly?: boolean;
  readonly search?: string;
  readonly slug?: string;
  readonly activePackagesOnly?: boolean;
  readonly taskIds?: readonly string[];
  readonly presentationStatus?: boolean;
}

export interface TaskRelationQuery {
  readonly direction?: EntityRelationRecord["direction"];
  readonly entity?: string;
  readonly source?: string;
  readonly target?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly ownerRef?: string;
  readonly freshness?: RelationFreshness;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface TaskRelationNeighborhoodQuery {
  readonly seed: string;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly relationTypes: readonly RelationType[];
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly state?: EntityRelationRecord["state"];
  readonly allowTruncation?: boolean;
}

export interface TaskRelationProjectionRow {
  readonly relationId: string;
  readonly workspaceRevision: number | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly relationType: EntityRelationRecord["type"];
  readonly direction: EntityRelationRecord["direction"];
  readonly strength: EntityRelationRecord["strength"];
  readonly origin: EntityRelationRecord["origin"];
  readonly state: EntityRelationRecord["state"];
  readonly targetObservedVersion: EntityVersion | null;
  readonly currentTargetVersion: EntityVersion | null;
  readonly freshness: RelationFreshness;
  readonly rationale: string;
  readonly ownerRef: string;
  readonly sourcePath: string;
  readonly recordIndex: number;
}

export interface RelationCycleIssue {
  readonly code: "relation_cycle_detected";
  readonly relationType: RelationType;
  readonly nodeRefs: readonly string[];
  readonly relationIds: readonly string[];
}

export interface RelationCycleAudit {
  readonly scannedEdges: number;
  readonly issues: readonly RelationCycleIssue[];
}

export interface RelationCycleAuditRead extends RelationCycleAudit {
  readonly status: "ready" | "pending";
  readonly watermark: number;
  readonly sourceRevision: number;
}

export interface TaskRelationNeighborhoodWindow {
  readonly rows: readonly TaskRelationProjectionRow[];
  readonly truncated: boolean;
}

export interface VersionedRelationProjectionRow extends RelationGraphEdgeRow {
  readonly schema: "relation-projection/v1";
  readonly entity: RelationEntity;
  readonly workspaceRevision: number;
}
