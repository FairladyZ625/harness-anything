import { normalizedRef } from "./workspace-evidence.ts";
import type { DecisionRow, DecisionState, FactRef, RelationEdge } from "./types.ts";

/**
 * 工作页「决策与事实」的收束派生(业主 2026-09-30:253 条事实平铺没人能看):
 * 事实按所属任务分组、每条只露结论句、40 位 SHA 缩到 7 位;决策按状态分段。
 * 纪律:纯派生、不做 IO、不新增读面——分组只用 FactRef.taskId 与已传入的标题查表,
 * 标题取不到就返回 null,由视图如实退回任务 id。
 */

/** 无任务归属(只由关系边连进工作)的事实组的 key。 */
export const LOOSE_FACT_GROUP = "_related";

/**
 * statement 的结论句:到第一个句号 / 分号 / 换行为止;首句切完为空就如实退回整句,
 * 不拿空串冒充「有结论」。
 */
export function factConclusion(statement: string): string {
  // 「At commit <sha>,」是取证锚,不是结论:剥掉后首字母大写。
  const body = statement.trim().replace(/^at commit [0-9a-f]{7,40}[,:，]\s*/iu, "");
  const lead = body.charAt(0).toUpperCase() + body.slice(1);
  const cut = lead.split(/[。；;\n]|\.(?:\s|$)/u, 1)[0] ?? lead;
  return cut.trim() === "" ? lead : cut.trim();
}

/** 40 位十六进制提交号缩到 7 位;短哈希与普通词原样保留。 */
export function shortenShas(text: string): string {
  return text.replaceAll(/\b[0-9a-f]{40}\b/gu, (sha) => sha.slice(0, 7));
}

export interface WorkFactGroup {
  /** 组 key:所属任务 id,或 `_related`(无任务归属)。 */
  readonly key: string;
  /** 标题查表命中给标题,没有就是 null——视图退回任务 id,不补造。 */
  readonly title: string | null;
  /** 组内事实,新 → 旧。 */
  readonly facts: readonly FactRef[];
  /** 组内最近一条事实的时间。 */
  readonly latestAt: string;
}

/** 事实按所属任务分组,组按最近时间新 → 旧;无任务归属的进 `_related` 组。 */
export function workFactGroups(input: {
  readonly facts: readonly FactRef[];
  readonly titles: ReadonlyMap<string, string>;
}): readonly WorkFactGroup[] {
  const buckets = new Map<string, FactRef[]>();
  for (const fact of input.facts) {
    const key = fact.taskId ?? LOOSE_FACT_GROUP;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [fact]);
    else bucket.push(fact);
  }
  return [...buckets.entries()]
    .map(([key, facts]) => {
      const sorted = [...facts].sort((left, right) => right.at.localeCompare(left.at));
      return {
        key,
        title: key === LOOSE_FACT_GROUP ? null : (input.titles.get(`task/${key}`) ?? null),
        facts: sorted,
        latestAt: sorted[0]!.at,
      };
    })
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt));
}

/** 决策三段:待裁决在前、生效中、已退场(已取代 / 已否决 / 已暂缓,折叠)。 */
export type DecisionSegment = "pending" | "inEffect" | "retired";

export function decisionSegmentOf(state: DecisionState): DecisionSegment {
  if (state === "in_effect") return "inEffect";
  return state === "proposed" ? "pending" : "retired";
}

export interface FactDecisionLink {
  readonly decisionId: string;
  readonly title: string;
}

/**
 * fact anchor → 引用它的 Decision(边从 `decision/<id>` 或其 claim 指向 fact)。
 * 标题从工作内 Decision 行取;行不在本次投影里就不入表,不在前端补造标题。
 */
export function factDecisionLinks(input: {
  readonly relations: readonly RelationEdge[];
  readonly decisions: readonly DecisionRow[];
}): ReadonlyMap<string, readonly FactDecisionLink[]> {
  const titleById = new Map(input.decisions.map(({ decisionId, title }) => [decisionId, title])),
    links = new Map<string, FactDecisionLink[]>();
  for (const edge of input.relations) {
    const from = normalizedRef(edge.from),
      to = normalizedRef(edge.to);
    if (!from.startsWith("decision/") || !to.startsWith("fact/")) continue;
    const decisionId = from.split("/")[1]!,
      title = titleById.get(decisionId);
    if (title === undefined) continue;
    const bucket = links.get(to);
    const link = { decisionId, title };
    if (bucket === undefined) links.set(to, [link]);
    else if (!bucket.some(({ decisionId: id }) => id === decisionId)) bucket.push(link);
  }
  return links;
}
