import { incomingRelations } from "./relation-direction.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "./types";

type ProducesFactRelation = {
  readonly kind?: string;
  readonly relationType?: string;
  readonly state?: string;
  readonly from?: string;
  readonly to?: string;
  readonly sourceRef?: string;
  readonly targetRef?: string;
};

export interface ActiveProducesFactRef {
  readonly sourceRef: string;
  readonly targetRef: string;
}

/** Returns active task-to-fact ownership edges across renderer and bridge row shapes. */
export function activeProducesFactRefs(
  relations: ReadonlyArray<ProducesFactRelation>,
  taskRef?: string,
): ActiveProducesFactRef[] {
  return relations.flatMap((relation) => {
    const sourceRef = relation.from ?? relation.sourceRef;
    const targetRef = relation.to ?? relation.targetRef;
    if (
      (relation.kind ?? relation.relationType) !== "produces" ||
      /* @gate-identity check-gui-status-judgments/gui-status-068 */
      relation.state !== "active" ||
      !sourceRef?.startsWith("task/") ||
      !targetRef?.startsWith("fact/") ||
      (taskRef !== undefined && sourceRef !== taskRef)
    ) {
      return [];
    }
    return [{ sourceRef, targetRef }];
  });
}

export function normalizeDecisionId(raw: string): string {
  return raw.replace(/^decision\//, "").split("/")[0];
}

export function normalizeTaskId(raw: string): string {
  return raw.replace(/^task\//, "").split("/")[0];
}

/**
 * 看板/列表行上的决策来源徽章。第一优先级是 daemon 在 `repo.tasks.list`
 * `placement.spawningDecisionIds` 里推导好的同一批 active directed `derives` 边
 * (F-84CF0391);`relations` 里恰好带着同一切面时结果一致,边切面还没到位时也不缺徽章。
 */
export function spawningDecisionOf(task: TaskRow, relations: RelationEdge[] = []): string | undefined {
  const fromRow = task.spawningDecisionIds ?? [];
  if (fromRow.length === 1) return fromRow[0];
  const decisionIds = [
    ...new Set(
      relations
        .filter(
          (relation) =>
            relation.kind === "derives" &&
            /* @gate-identity check-gui-status-judgments/gui-status-037 */
            relation.state === "active" &&
            relation.direction === "directed" &&
            relation.from.startsWith("decision/") &&
            normalizeTaskId(relation.to) === task.taskId,
        )
        .map((edge) => normalizeDecisionId(edge.from)),
    ),
  ];
  if (decisionIds.length === 1) return decisionIds[0];
  if (decisionIds.length > 1) return undefined;
  return task.spawningDecision ? normalizeDecisionId(task.spawningDecision) : undefined;
}

export function derivedTasks(decision: DecisionRow, relations: RelationEdge[], tasks: readonly TaskRow[]): TaskRow[] {
  const taskIds = relations
    .filter(
      (relation) =>
        relation.from === `decision/${decision.decisionId}` &&
        relation.kind === "derives" &&
        /* @gate-identity check-gui-status-judgments/gui-status-038 */
        relation.state === "active" &&
        relation.direction === "directed",
    )
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
  const incoming = [
    ...incomingRelations(ref, "evidenced-by", relations),
    ...incomingRelations(ref, "evidences", relations),
  ];
  return incoming[0]?.rationale;
}

export const axisRank = (value?: "high" | "medium" | "low") =>
  value === "high" ? 0 : value === "medium" ? 1 : value === "low" ? 2 : 3;

/**
 * 决策队列排序:风险 high→low → 紧急度 high→low → proposedAt 倒序。
 *
 * 风险/紧急度保持主键(队列语义是「先裁哪个」,时间提为主键会把滞留的高风险
 * 决策压到最新低风险之下);同档内最新在前——泽宇 2026-08-21 的「时间倒序」
 * 指的是这一层。总览决策流、决策批准、决策池三处共用本排序。
 */
export function sortDecisionQueue(decisions: DecisionRow[]): DecisionRow[] {
  return [...decisions].sort((a, b) => {
    const risk = axisRank(a.riskTier) - axisRank(b.riskTier);
    if (risk !== 0) return risk;
    const urgency = axisRank(a.urgency) - axisRank(b.urgency);
    if (urgency !== 0) return urgency;
    return (b.proposedAt ?? "").localeCompare(a.proposedAt ?? "");
  });
}
