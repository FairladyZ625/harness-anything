import { incomingRelations } from "./relation-direction.ts";
import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "./types";

type ProducesFactRelation = {
  readonly kind?: string;
  readonly relationType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly sourceRef?: string;
  readonly targetRef?: string;
};

export interface ActiveProducesFactRef {
  readonly sourceRef: string;
  readonly targetRef: string;
}

/**
 * task→fact 产出边。输入已过 current 收口(triadic-data 的 adaptRelationRows),
 * 这里只按端点与 kind 筛选,不再自查边的状态词。
 */
export function activeProducesFactRefs(
  relations: ReadonlyArray<ProducesFactRelation>,
  taskRef?: string,
): ActiveProducesFactRef[] {
  return relations.flatMap((relation) => {
    const sourceRef = relation.from ?? relation.sourceRef;
    const targetRef = relation.to ?? relation.targetRef;
    if (
      (relation.kind ?? relation.relationType) !== "produces" ||
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
 * 看板/列表/泳道行上的决策来源徽章。daemon 在 `repo.tasks.list` 的
 * `placement.spawningDecisionIds` 里已按同一批 directed `derives` 边推导好
 * (F-84CF0391):唯一来源取该值,多来源不定 → 无徽章。
 */
export function spawningDecisionBadge(task: Readonly<Pick<TaskRow, "spawningDecisionIds">>): string | undefined {
  const ids = task.spawningDecisionIds;
  return ids !== undefined && ids.length === 1 ? ids[0] : undefined;
}

export function derivedTasks(decision: DecisionRow, relations: RelationEdge[], tasks: readonly TaskRow[]): TaskRow[] {
  const taskIds = relations
    .filter(
      (relation) =>
        relation.from === `decision/${decision.decisionId}` &&
        relation.kind === "derives" &&
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
export function sortDecisionQueue<T extends Pick<DecisionRow, "riskTier" | "urgency" | "proposedAt">>(
  decisions: readonly T[],
): T[] {
  return [...decisions].sort((a, b) => {
    const risk = axisRank(a.riskTier) - axisRank(b.riskTier);
    if (risk !== 0) return risk;
    const urgency = axisRank(a.urgency) - axisRank(b.urgency);
    if (urgency !== 0) return urgency;
    return (b.proposedAt ?? "").localeCompare(a.proposedAt ?? "");
  });
}
