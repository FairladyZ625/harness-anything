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

/** 徽章优先级核心:行内 placement > 唯一 directed derives 来源 > 行内旧字段兜底;多来源不定 → 无徽章。 */
function spawningDecisionFromDerived(task: TaskRow, derivedDecisionIds: ReadonlyArray<string>): string | undefined {
  const fromRow = task.spawningDecisionIds ?? [];
  if (fromRow.length === 1) return fromRow[0];
  if (derivedDecisionIds.length === 1) return derivedDecisionIds[0];
  if (derivedDecisionIds.length > 1) return undefined;
  return task.spawningDecision ? normalizeDecisionId(task.spawningDecision) : undefined;
}

/** taskId → 决策来源徽章 的派生索引;卡片按行取标量,未受影响行标量值不变。 */
export type SpawningDecisionIndex = ReadonlyMap<string, string | undefined>;

/**
 * 单遍徽章索引(W9 修正):一次遍历 relations 收集各 task 的 directed derives
 * 来源,再一次遍历行产出 taskId → 徽章。看板/泳道/列表的 memo 卡片只收自己的
 * 标量,关系刷新时全局 relations 数组不再打穿卡片 memo——只有徽章值变化的行
 * 换新 props。语义与 `spawningDecisionOf` 同源(共用优先级核心)。
 */
export function buildSpawningDecisionIndex(
  tasks: ReadonlyArray<TaskRow>,
  relations: ReadonlyArray<RelationEdge>,
): SpawningDecisionIndex {
  const derivedByTask = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== "derives" || relation.direction !== "directed" || !relation.from.startsWith("decision/")) {
      continue;
    }
    const decisionIds = derivedByTask.get(normalizeTaskId(relation.to));
    const decisionId = normalizeDecisionId(relation.from);
    if (decisionIds === undefined) derivedByTask.set(normalizeTaskId(relation.to), [decisionId]);
    else if (!decisionIds.includes(decisionId)) decisionIds.push(decisionId);
  }
  const index = new Map<string, string | undefined>();
  for (const task of tasks) {
    index.set(task.taskId, spawningDecisionFromDerived(task, derivedByTask.get(task.taskId) ?? []));
  }
  return index;
}

/**
 * 看板/列表行上的决策来源徽章。第一优先级是 daemon 在 `repo.tasks.list`
 * `placement.spawningDecisionIds` 里推导好的同一批 directed `derives` 边
 * (F-84CF0391);`relations` 已过 current 收口,边切面还没到位时也不缺徽章。
 */
export function spawningDecisionOf(task: TaskRow, relations: RelationEdge[] = []): string | undefined {
  return buildSpawningDecisionIndex([task], relations).get(task.taskId);
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
export function sortDecisionQueue(decisions: DecisionRow[]): DecisionRow[] {
  return [...decisions].sort((a, b) => {
    const risk = axisRank(a.riskTier) - axisRank(b.riskTier);
    if (risk !== 0) return risk;
    const urgency = axisRank(a.urgency) - axisRank(b.urgency);
    if (urgency !== 0) return urgency;
    return (b.proposedAt ?? "").localeCompare(a.proposedAt ?? "");
  });
}
