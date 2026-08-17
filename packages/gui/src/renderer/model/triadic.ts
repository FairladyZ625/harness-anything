import { incomingRelations } from "./relation-direction.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "./types";

export function normalizeDecisionId(raw: string): string {
  return raw.replace(/^decision\//, "").split("/")[0];
}

export function normalizeTaskId(raw: string): string {
  return raw.replace(/^task\//, "").split("/")[0];
}

export function spawningDecisionOf(task: TaskRow, relations: RelationEdge[]): string | undefined {
  const decisionIds = [...new Set(relations.filter(
    (relation) =>
      relation.kind === "derives" &&
      relation.state === "active" &&
      relation.direction === "directed" &&
      relation.from.startsWith("decision/") &&
      normalizeTaskId(relation.to) === task.taskId,
  ).map((edge) => normalizeDecisionId(edge.from)))];
  if (decisionIds.length === 1) return decisionIds[0];
  if (decisionIds.length > 1) return undefined;
  return task.spawningDecision
    ? normalizeDecisionId(task.spawningDecision)
    : undefined;
}

export function derivedTasks(
  decision: DecisionRow,
  relations: RelationEdge[],
  tasks: TaskRow[],
): TaskRow[] {
  const taskIds = relations
    .filter((relation) => relation.from === `decision/${decision.decisionId}` && relation.kind === "derives" && relation.state === "active" && relation.direction === "directed")
    .map((relation) => normalizeTaskId(relation.to));
  return tasks.filter((task) => taskIds.includes(task.taskId));
}

export function supersedeChain(
  decision: DecisionRow,
  relations: RelationEdge[],
): { supersedes: string[]; supersededBy: string[] } {
  const supersedes = relations
    .filter((relation) => relation.from === `decision/${decision.decisionId}` && relation.kind === "supersedes")
    .map((relation) => normalizeDecisionId(relation.to));
  const supersededBy = relations
    .filter((relation) => relation.to === `decision/${decision.decisionId}` && relation.kind === "supersedes")
    .map((relation) => normalizeDecisionId(relation.from));
  return { supersedes, supersededBy };
}

export function factOf(ref: string, facts: FactRef[]): FactRef | undefined {
  const anchor = ref.replace(/^fact\//, "");
  return facts.find((fact) => fact.anchor === anchor);
}

export function rationaleFor(ref: string, relations: RelationEdge[]): string | undefined {
  // Canonical direction only: the rationale shown on a fact's card comes from the
  // decisions citing it (evidenced-by) or the tasks evidencing it — both read
  // `source <verb> fact`, so the reverse question goes through the shared query.
  const incoming = [...incomingRelations(ref, "evidenced-by", relations), ...incomingRelations(ref, "evidences", relations)];
  return incoming[0]?.rationale;
}

export const axisRank = (value?: "high" | "medium" | "low") =>
  value === "high" ? 0 : value === "medium" ? 1 : value === "low" ? 2 : 3;

export function sortDecisionQueue(decisions: DecisionRow[]): DecisionRow[] {
  return [...decisions].sort((a, b) => {
    const risk = axisRank(a.riskTier) - axisRank(b.riskTier);
    if (risk !== 0) return risk;
    const urgency = axisRank(a.urgency) - axisRank(b.urgency);
    if (urgency !== 0) return urgency;
    return (a.proposedAt ?? "").localeCompare(b.proposedAt ?? "");
  });
}
