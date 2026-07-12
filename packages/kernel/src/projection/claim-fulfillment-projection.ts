import type { OutputEvidence } from "../domain/execution.ts";
import { executionDeclaration } from "../entity/execution-declaration.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { validateOutputEvidence } from "../local/output-evidence-validator.ts";
import { parseObjectList, parseStringArray, readBlockScalar } from "../markdown/flow-frontmatter.ts";
import type { DecisionClaimFulfillment } from "../schemas/decision-package.ts";
import { discoverDeclaredEntityRows } from "./entity-declaration-projection.ts";
import type { RelationCoverageRow, RelationGraphEdgeRow } from "./relation-graph-projection.ts";

interface DecisionCoverageSource {
  readonly decisionRef: string;
  readonly frontmatter: string;
}

interface CoverageRefIndex {
  readonly doneTaskIds: ReadonlySet<string>;
  readonly factRefs: ReadonlySet<string>;
}

interface ClaimDeclaration {
  readonly id: string;
  readonly fulfillment: DecisionClaimFulfillment;
}

export function buildClaimFulfillmentRows(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly decisions: ReadonlyArray<DecisionCoverageSource>;
  readonly edges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly refIndex: CoverageRefIndex;
}): ReadonlyArray<RelationCoverageRow> {
  const activeEdges = input.edges.filter((edge) => edge.state === "active");
  const evidenceGraph = evidenceGraphFrom(activeEdges);
  const invalidatedFactRefs = invalidatedFactsFrom(activeEdges);
  const refutingFactRefsByClaim = refutationsFrom(activeEdges);
  const deliveredTaskIds = deliveredTasks(input.rootInput, input.refIndex.doneTaskIds);
  const rows: RelationCoverageRow[] = [];

  for (const decision of input.decisions) {
    for (const claim of loadBearingClaims(decision.frontmatter)) {
      const claimRef = `${decision.decisionRef}/${claim.id}`;
      const refutingFactRefs = [...(refutingFactRefsByClaim.get(claimRef) ?? [])].sort();
      const coverage = refutingFactRefs.length === 0
        ? fulfilledBy(claim.fulfillment, {
            claimRef,
            decisionRef: decision.decisionRef,
            frontmatter: decision.frontmatter,
            activeEdges,
            evidenceGraph,
            invalidatedFactRefs,
            factRefs: input.refIndex.factRefs,
            deliveredTaskIds
          })
        : null;
      rows.push({
        decisionRef: decision.decisionRef,
        claimRef,
        status: coverage ? "covered" : "uncovered",
        ...(coverage?.factRef ? { coveringFactRef: coverage.factRef } : {}),
        ...(refutingFactRefs.length > 0 ? { refutingFactRefs } : {}),
        relationPath: coverage?.path ?? []
      });
    }
  }
  return rows.sort((left, right) => left.claimRef.localeCompare(right.claimRef));
}

function fulfilledBy(
  fulfillment: DecisionClaimFulfillment,
  input: {
    readonly claimRef: string;
    readonly decisionRef: string;
    readonly frontmatter: string;
    readonly activeEdges: ReadonlyArray<RelationGraphEdgeRow>;
    readonly evidenceGraph: ReadonlyMap<string, ReadonlyArray<RelationGraphEdgeRow>>;
    readonly invalidatedFactRefs: ReadonlySet<string>;
    readonly factRefs: ReadonlySet<string>;
    readonly deliveredTaskIds: ReadonlySet<string>;
  }
): { readonly factRef?: string; readonly path: ReadonlyArray<string> } | null {
  if (fulfillment === "evidenced") {
    return firstReachableLiveFact(input.claimRef, input.evidenceGraph, input.factRefs, input.invalidatedFactRefs);
  }
  if (fulfillment === "delivered") {
    const edge = input.activeEdges.find((candidate) => (
      candidate.relationType === "derives" &&
      isSameDecisionOrAnchor(candidate.sourceRef, input.decisionRef) &&
      candidate.targetRef.startsWith("task/") &&
      input.deliveredTaskIds.has(candidate.targetRef.slice("task/".length))
    ));
    return edge ? { path: [edge.relationId] } : null;
  }
  const edge = input.activeEdges.find((candidate) => (
    (candidate.relationType === "refines" || candidate.relationType === "relates") &&
    ((isSameDecisionOrAnchor(candidate.sourceRef, input.decisionRef) && candidate.targetRef.startsWith("decision/")) ||
      (isSameDecisionOrAnchor(candidate.targetRef, input.decisionRef) && candidate.sourceRef.startsWith("decision/")))
  ));
  return hasAppliesTo(input.frontmatter) ? { path: [] } : edge ? { path: [edge.relationId] } : null;
}

function loadBearingClaims(frontmatter: string): ReadonlyArray<ClaimDeclaration> {
  return parseObjectList(frontmatter, "claims")
    .filter((claim) => claim.load_bearing !== false)
    .flatMap((claim) => typeof claim.id === "string" ? [{
      id: claim.id,
      fulfillment: isFulfillment(claim.fulfillment) ? claim.fulfillment : "evidenced"
    }] : []);
}

function hasAppliesTo(frontmatter: string): boolean {
  return parseStringArray(readBlockScalar(frontmatter, "applies_to", "modules"), { tolerateInvalidArrays: true }).length > 0 ||
    parseStringArray(readBlockScalar(frontmatter, "applies_to", "productLines"), { tolerateInvalidArrays: true }).length > 0;
}

function deliveredTasks(rootInput: HarnessLayoutInput, doneTaskIds: ReadonlySet<string>): ReadonlySet<string> {
  const delivered = new Set<string>();
  for (const row of discoverDeclaredEntityRows(rootInput, executionDeclaration)) {
    const taskRef = typeof row.task_ref === "string" ? row.task_ref : "";
    const taskId = taskRef.startsWith("task/") ? taskRef.slice("task/".length) : "";
    const executionId = typeof row.execution_id === "string" ? row.execution_id : "";
    if (!taskId || !executionId || !doneTaskIds.has(taskId) || typeof row.outputs_json !== "string") continue;
    const outputs = JSON.parse(row.outputs_json) as ReadonlyArray<OutputEvidence>;
    try {
      validateOutputEvidence({ rootInput, taskId, executionId, evidence: outputs });
    } catch {
      continue;
    }
    if (hasPassingReceipt(outputs)) delivered.add(taskId);
  }
  return delivered;
}

function hasPassingReceipt(outputs: ReadonlyArray<OutputEvidence>): boolean {
  const byId = new Map(outputs.map((evidence) => [evidence.evidence_id, evidence]));
  return outputs.some((evidence) => {
    if (evidence.locator.substrate === "checker_receipt" || !evidence.sha256 || !evidence.checker_receipt_ref) return false;
    const receipt = byId.get(evidence.checker_receipt_ref);
    return receipt?.locator.substrate === "checker_receipt" && receipt.locator.receipt.result === "pass";
  });
}

function evidenceGraphFrom(edges: ReadonlyArray<RelationGraphEdgeRow>): ReadonlyMap<string, ReadonlyArray<RelationGraphEdgeRow>> {
  const graph = new Map<string, RelationGraphEdgeRow[]>();
  for (const edge of edges) {
    if (edge.relationType !== "evidenced-by") continue;
    graph.set(edge.sourceRef, [...(graph.get(edge.sourceRef) ?? []), edge]);
  }
  return graph;
}

function invalidatedFactsFrom(edges: ReadonlyArray<RelationGraphEdgeRow>): ReadonlySet<string> {
  return new Set(edges
    .filter((edge) => edge.sourceRef.startsWith("fact/") && edge.targetRef.startsWith("fact/") && (edge.relationType === "invalidated-by" || edge.relationType === "supersedes-fact"))
    .map((edge) => edge.targetRef));
}

function refutationsFrom(edges: ReadonlyArray<RelationGraphEdgeRow>): ReadonlyMap<string, ReadonlySet<string>> {
  const refutations = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.relationType !== "refutes" || !edge.sourceRef.startsWith("fact/") || !edge.targetRef.startsWith("decision/")) continue;
    const existing = refutations.get(edge.targetRef) ?? new Set<string>();
    existing.add(edge.sourceRef);
    refutations.set(edge.targetRef, existing);
  }
  return refutations;
}

function firstReachableLiveFact(
  startRef: string,
  graph: ReadonlyMap<string, ReadonlyArray<RelationGraphEdgeRow>>,
  factRefs: ReadonlySet<string>,
  invalidatedFactRefs: ReadonlySet<string>
): { readonly factRef: string; readonly path: ReadonlyArray<string> } | null {
  const visited = new Set<string>();
  const queue: Array<{ readonly ref: string; readonly path: ReadonlyArray<string> }> = [{ ref: startRef, path: [] }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.ref)) continue;
    visited.add(current.ref);
    if (current.ref.startsWith("fact/") && factRefs.has(current.ref.slice("fact/".length)) && !invalidatedFactRefs.has(current.ref)) {
      return { factRef: current.ref, path: current.path };
    }
    for (const edge of graph.get(current.ref) ?? []) queue.push({ ref: edge.targetRef, path: current.path.concat(edge.relationId) });
  }
  return null;
}

function isSameDecisionOrAnchor(ref: string, decisionRef: string): boolean {
  return ref === decisionRef || ref.startsWith(`${decisionRef}/`);
}

function isFulfillment(value: unknown): value is DecisionClaimFulfillment {
  return value === "evidenced" || value === "delivered" || value === "standing-policy";
}
