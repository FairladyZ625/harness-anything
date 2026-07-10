import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "./types";

export function normalizeDecisionId(raw: string): string {
  return raw.replace(/^decision\//, "").split("/")[0];
}

export function normalizeTaskId(raw: string): string {
  return raw.replace(/^task\//, "").split("/")[0];
}

export function spawningDecisionOf(task: TaskRow, relations: RelationEdge[]): string | undefined {
  const edge = relations.find(
    (relation) =>
      relation.kind === "derives" &&
      relation.from.startsWith("decision/") &&
      normalizeTaskId(relation.to) === task.taskId,
  );
  if (edge) return normalizeDecisionId(edge.from);
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
    .filter((relation) => relation.from === `decision/${decision.decisionId}` && relation.kind === "derives")
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

/**
 * 覆盖度: claim 沿 relation 可达的活 fact。
 * 原型简化为 evidence anchor walk; 真实版由 RelationGraphProjection 查询。
 */
export function coverageOf(
  decision: DecisionRow,
  facts: FactRef[],
): { covered: number; total: number; gaps: string[] } {
  const evidenceByClaim = new Map<string, string[]>();
  for (const claim of [...decision.chosen, ...decision.rejected]) {
    evidenceByClaim.set(claim.id, claim.evidence);
  }

  let covered = 0;
  const gaps: string[] = [];
  for (const claim of decision.claims) {
    const evidence = evidenceByClaim.get(claim.id) ?? [];
    const reached = evidence.some((ref) => {
      const anchor = ref.replace(/^fact\//, "");
      const fact = facts.find((candidate) => candidate.anchor === anchor);
      return fact && !fact.invalidated;
    });
    if (reached) covered += 1;
    else gaps.push(claim.id);
  }
  return { covered, total: decision.claims.length, gaps };
}

export function factOf(ref: string, facts: FactRef[]): FactRef | undefined {
  const anchor = ref.replace(/^fact\//, "");
  return facts.find((fact) => fact.anchor === anchor);
}

export function rationaleFor(ref: string, relations: RelationEdge[]): string | undefined {
  return relations.find((relation) =>
    (relation.to === ref && (relation.kind === "supports" || relation.kind === "evidenced-by" || relation.kind === "evidences")) ||
    (relation.from === ref && relation.kind === "supports")
  )?.rationale;
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
