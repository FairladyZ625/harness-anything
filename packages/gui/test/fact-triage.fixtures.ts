import type { FactAnchorRow, RelationCoverageRow, ServedRelationEdgeRow } from "../src/api/renderer-dto.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";

export function baseFact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "fact/F-001",
    taskId: "task_a",
    category: "finding",
    text: "观察 X 成立",
    at: "2026-07-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

export function baseTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "software/coding",
    lastKnownAt: "2026-07-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...overrides,
  };
}

export function baseDecision(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "Decision One",
    state: "active",
    riskTier: "medium",
    urgency: "medium",
    vertical: "software/coding",
    preset: "p",
    proposedBy: { kind: "system", id: "x" },
    proposedAt: "2026-07-01T00:00:00.000Z",
    question: "Q?",
    chosen: [{ id: "CH1", text: "chosen", evidence: [] }],
    rejected: [],
    claims: [{ id: "CH1", text: "chosen", loadBearing: true, fulfillment: "evidenced" }],
    judgmentConsents: [],
    provenance: [],
    lastChangedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

export function edge(
  from: string,
  to: string,
  kind: RelationEdge["kind"],
  extra: Partial<RelationEdge> = {},
): RelationEdge {
  return {
    from,
    to,
    kind,
    direction: "directed",
    state: "active",
    provenance: "local-document",
    ...extra,
  };
}

/**
 * 关系图读面送达的边行(kernel 行 + daemon 转发的 current 判定)。retired/deleted
 * 边由 kernel `relationIsCurrent` 判 current=false,在管道收口处出局。
 */
export function wireEdge(extra: Partial<ServedRelationEdgeRow> = {}): ServedRelationEdgeRow {
  return {
    relationId: "rel_wire",
    sourceRef: "decision/dec_2",
    targetRef: "fact/F-001",
    relationType: "refuted-by",
    direction: "directed",
    strength: "strong",
    origin: "declared",
    state: "active",
    targetObservedVersion: null,
    currentTargetVersion: null,
    freshness: "current",
    rationale: "wire fixture",
    ownerRef: "decision/dec_2",
    sourcePath: "event:dec_2",
    recordIndex: 0,
    current: true,
    ...extra,
  };
}

export function wireFact(ref = "fact/F-001") {
  return {
    schema: "task-fact-row/v1" as const,
    ref,
    factId: ref.split("/").at(-1)!,
    statement: "wire fact",
    source: "fixture",
    observedAt: "2026-07-01T00:00:00.000Z",
    confidence: "high" as const,
    memoryClass: "semantic",
    memoryTags: [],
    provenance: [],
    liveness: "standing" as const,
    invalidated: false,
  };
}

export function anchor(fact = baseFact()): FactAnchorRow {
  return {
    factRef: fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`,
    taskId: fact.taskId,
    factId: fact.anchor.split("/").at(-1) ?? "F-001",
    sourcePath: `event:${fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`}`,
  };
}

export function coverage(fact = baseFact(), decisionId = "dec_1"): RelationCoverageRow {
  return {
    decisionRef: `decision/${decisionId}`,
    claimRef: `decision/${decisionId}/CH1`,
    status: "covered",
    covered: true,
    fulfillment: "evidenced",
    coveringFactRef: fact.anchor.startsWith("fact/") ? fact.anchor : `fact/${fact.anchor}`,
    refutingFactRefs: [],
    relationPath: ["rel_1"],
    basisRevision: 1,
  };
}
