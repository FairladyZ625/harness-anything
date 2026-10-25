import { endpointToNodeId } from "../graph/endpoint.ts";
import type { CadenceFeedEvent } from "./cadence.ts";
import type { DecisionRow, FactRef, RelationEdge } from "./types.ts";

export interface WorkspaceEvidence {
  readonly events: readonly CadenceFeedEvent[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly missingRefs: readonly string[];
}

const taskRef = (taskId: string): string => `task/${taskId}`;

/** 与工作成员任务有边相连的实体引用:工作归属只取已有关系,不另立归属判据。 */
function workRelatedRefs(memberTaskIds: readonly string[], relations: readonly RelationEdge[]): Set<string> {
  const memberRefs = new Set(memberTaskIds.map(taskRef)),
    relatedRefs = new Set<string>();
  for (const edge of relations) {
    const from = normalizedRef(edge.from),
      to = normalizedRef(edge.to);
    if (memberRefs.has(from)) relatedRefs.add(to);
    if (memberRefs.has(to)) relatedRefs.add(from);
  }
  return relatedRefs;
}

/** 工作内的 Decision(工作页「决策与事实」页签的口径)。 */
export function workDecisionsOf(input: {
  readonly memberTaskIds: readonly string[];
  readonly decisions: readonly DecisionRow[];
  readonly relations: readonly RelationEdge[];
}): readonly DecisionRow[] {
  const relatedRefs = workRelatedRefs(input.memberTaskIds, input.relations);
  return input.decisions.filter(({ decisionId }) => relatedRefs.has(`decision/${decisionId}`));
}

export function workspaceEvidenceOf(input: {
  readonly memberTaskIds: readonly string[];
  readonly events: readonly CadenceFeedEvent[];
  readonly decisions: readonly DecisionRow[];
  readonly facts: readonly FactRef[];
  readonly relations: readonly RelationEdge[];
}): WorkspaceEvidence {
  const members = new Set(input.memberTaskIds),
    relatedRefs = workRelatedRefs(input.memberTaskIds, input.relations);
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
    missingRefs,
  };
}

/** 关系端点 → 与成员引用对齐的归一引用(task 端点保留 `task/` 前缀)。 */
export function normalizedRef(ref: string): string {
  const nodeId = endpointToNodeId(ref);
  return ref.startsWith("task/") ? `task/${nodeId}` : nodeId;
}
