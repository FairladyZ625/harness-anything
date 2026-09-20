import type { ArtifactGuiRowDto } from "@harness-anything/daemon/protocol";
import { endpointToNodeId } from "../graph/endpoint.ts";
import type { CadenceFeedEvent } from "./cadence.ts";
import type { DecisionRow, FactRef, RelationEdge } from "./types.ts";

export interface WorkspaceEvidence {
  readonly events: readonly CadenceFeedEvent[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly artifacts: readonly ArtifactGuiRowDto[];
  readonly missingRefs: readonly string[];
}

const taskRef = (taskId: string): string => `task/${taskId}`;

export function workspaceEvidenceOf(input: {
  readonly memberTaskIds: readonly string[];
  readonly events: readonly CadenceFeedEvent[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly relations: readonly RelationEdge[];
  readonly artifacts: readonly ArtifactGuiRowDto[];
}): WorkspaceEvidence {
  const members = new Set(input.memberTaskIds),
    memberRefs = new Set(input.memberTaskIds.map(taskRef)),
    relatedRefs = new Set<string>();
  for (const edge of input.relations) {
    const from = normalizedRef(edge.from),
      to = normalizedRef(edge.to);
    if (memberRefs.has(from)) relatedRefs.add(to);
    if (memberRefs.has(to)) relatedRefs.add(from);
  }
  const decisions = input.decisions.filter(({ decisionId }) => relatedRefs.has(`decision/${decisionId}`)),
    facts = input.facts.filter(
      ({ anchor, taskId }) => (taskId !== undefined && members.has(taskId)) || relatedRefs.has(anchor),
    ),
    known = new Set([
      ...input.memberTaskIds.map(taskRef),
      ...decisions.map(({ decisionId }) => `decision/${decisionId}`),
      ...facts.map(({ anchor }) => anchor),
    ]),
    missingRefs = [...relatedRefs].filter(
      (ref) => (ref.startsWith("decision/") || ref.startsWith("fact/")) && !known.has(ref),
    );
  return {
    events: input.events.filter(({ taskId }) => taskId !== null && members.has(taskId)).toReversed(),
    decisions,
    facts,
    artifacts: input.artifacts.filter(({ taskId }) => taskId !== null && members.has(taskId)),
    missingRefs,
  };
}

export interface WorkspaceGraphSlice {
  readonly nodeRefs: readonly string[];
  readonly edges: readonly RelationEdge[];
  readonly externalRefs: readonly string[];
}

export function workspaceGraphSlice(
  memberTaskIds: readonly string[],
  relations: readonly RelationEdge[],
  expandedExternalRefs: ReadonlySet<string> = new Set(),
): WorkspaceGraphSlice {
  const members = new Set(memberTaskIds.map(taskRef)),
    boundary = new Set<string>(),
    visibleEdges: RelationEdge[] = [];
  for (const edge of relations) {
    const from = normalizedRef(edge.from),
      to = normalizedRef(edge.to);
    if (members.has(from) || members.has(to)) {
      visibleEdges.push(edge);
      if (!members.has(from)) boundary.add(from);
      if (!members.has(to)) boundary.add(to);
    }
  }
  for (const edge of relations) {
    const from = normalizedRef(edge.from),
      to = normalizedRef(edge.to);
    if (expandedExternalRefs.has(from) || expandedExternalRefs.has(to)) visibleEdges.push(edge);
  }
  const edges = [
      ...new Map(
        visibleEdges.map((edge) => [edge.relationId ?? `${edge.from}:${edge.kind}:${edge.to}`, edge]),
      ).values(),
    ],
    nodeRefs = [
      ...new Set([...members, ...edges.flatMap((edge) => [normalizedRef(edge.from), normalizedRef(edge.to)])]),
    ];
  return { nodeRefs, edges, externalRefs: [...boundary] };
}

function normalizedRef(ref: string): string {
  const nodeId = endpointToNodeId(ref);
  return ref.startsWith("task/") ? `task/${nodeId}` : nodeId;
}
