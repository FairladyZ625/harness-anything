import type {
  DecisionRow,
  DecisionState,
  RelationEdge,
  TaskRow,
} from "../model/types";
import { derivedTasks, normalizeDecisionId, supersedeChain } from "../model/triadic";
import { t } from "../i18n/index.tsx";

export type PoolTab = DecisionState;
export type GroupBy = "none" | "milestone" | "vertical";
export type TimeRange = "all" | "14d" | "30d";

export const POOL_TABS: readonly PoolTab[] = [
  "proposed",
  "rejected",
  "deferred",
  "active",
  "retired",
] as const;

export function withinRange(decision: DecisionRow, range: TimeRange): boolean {
  if (range === "all") return true;
  if (!decision.proposedAt) return false;
  const days = range === "14d" ? 14 : 30;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(decision.proposedAt).getTime() >= since;
}

/** 文本搜索的命中域:title / decisionId / question / chosen/rejected claims。小写化。 */
export function decisionSearchHaystack(d: DecisionRow): string {
  const chosenText = d.chosen.map((c) => c.text).join(" ");
  const rejectedText = d.rejected.map((c) => `${c.text} ${c.whyNot ?? ""}`).join(" ");
  const claimsText = d.claims.map((c) => c.text).join(" ");
  return `${d.title} ${d.decisionId} ${d.question} ${chosenText} ${rejectedText} ${claimsText}`.toLowerCase();
}

export function formatActorAxes(
  actor: DecisionRow["attribution"]["originator"],
): string {
  if (!actor) return t("views.decisionPoolView.unknown");
  return `person:${actor.principal.personId} / ${actor.executor ? `agent:${actor.executor.id}` : "executor:none"}`;
}

/**
 * Milestone (root task) for a decision: walk derives → task → rootTaskId.
 * Fallback bucket key when no derives edge exists.
 */
export const UNLINKED_MILESTONE = "__unlinked__";

export function milestoneOf(
  decision: DecisionRow,
  relations: RelationEdge[],
  tasks: TaskRow[],
): { key: string; title: string } {
  const derived = derivedTasks(decision, relations, tasks);
  if (derived.length === 0) {
    return {
      key: UNLINKED_MILESTONE,
      title: t("views.decisionPoolView.unlinkedMilestone"),
    };
  }
  // Prefer the first derived task's root; if multiple roots, join keys stably.
  const roots = new Map<string, string>();
  for (const task of derived) {
    const rootId = task.rootTaskId ?? task.taskId;
    if (!roots.has(rootId)) {
      const root = tasks.find((candidate) => candidate.taskId === rootId);
      roots.set(rootId, root?.rootTitle ?? root?.title ?? rootId);
    }
  }
  const entries = [...roots.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 1) {
    const [key, title] = entries[0]!;
    return { key, title };
  }
  return {
    key: entries.map(([key]) => key).join("+"),
    title: entries.map(([, title]) => title).join(" · "),
  };
}

export interface RelationSummaryLine {
  kind: "derives" | "refines" | "narrows" | "supersedes" | "supersededBy";
  label: string;
  targets: string[];
}

/** Compact lineage for the pool card (P2-5): derives + refines/narrows + supersede. */
export function relationSummary(
  decision: DecisionRow,
  relations: RelationEdge[],
  tasks: TaskRow[],
): RelationSummaryLine[] {
  const lines: RelationSummaryLine[] = [];
  const derived = derivedTasks(decision, relations, tasks);
  if (derived.length > 0) {
    lines.push({
      kind: "derives",
      label: t("views.decisionPoolView.derivesTo"),
      targets: derived.map((task) => task.taskId),
    });
  }

  const decisionRef = `decision/${decision.decisionId}`;
  const refines = relations
    .filter((relation) => relation.from === decisionRef && relation.kind === "refines")
    .map((relation) => normalizeDecisionId(relation.to));
  if (refines.length > 0) {
    lines.push({
      kind: "refines",
      label: t("views.decisionPoolView.refinesTo"),
      targets: refines,
    });
  }
  const narrows = relations
    .filter((relation) => relation.from === decisionRef && relation.kind === "narrows")
    .map((relation) => normalizeDecisionId(relation.to));
  if (narrows.length > 0) {
    lines.push({
      kind: "narrows",
      label: t("views.decisionPoolView.narrowsTo"),
      targets: narrows,
    });
  }

  const chain = supersedeChain(decision, relations);
  if (chain.supersedes.length > 0) {
    lines.push({
      kind: "supersedes",
      label: t("views.decisionPoolView.supersedesLabel"),
      targets: chain.supersedes,
    });
  }
  if (chain.supersededBy.length > 0) {
    lines.push({
      kind: "supersededBy",
      label: t("views.decisionPoolView.supersededByLabel"),
      targets: chain.supersededBy,
    });
  }
  return lines;
}

export interface CardCounts {
  claims: number;
  derives: number;
  chosen: number;
  rejected: number;
}

export function cardCounts(
  decision: DecisionRow,
  relations: RelationEdge[],
  tasks: TaskRow[],
): CardCounts {
  return {
    claims: decision.claims.length,
    derives: derivedTasks(decision, relations, tasks).length,
    chosen: decision.chosen.length,
    rejected: decision.rejected.length,
  };
}

export interface MilestoneGroup {
  key: string;
  title: string;
  rows: DecisionRow[];
}

export function groupRows(
  rows: DecisionRow[],
  groupBy: GroupBy,
  relations: RelationEdge[],
  tasks: TaskRow[],
): MilestoneGroup[] {
  if (groupBy === "none") {
    return [{ key: "all", title: "", rows }];
  }
  if (groupBy === "vertical") {
    const buckets = new Map<string, DecisionRow[]>();
    for (const row of rows) {
      const key = row.vertical ?? t("views.decisionPoolView.unknown");
      const list = buckets.get(key) ?? [];
      list.push(row);
      buckets.set(key, list);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, groupRows]) => ({ key, title: key, rows: groupRows }));
  }
  // milestone
  const buckets = new Map<string, { title: string; rows: DecisionRow[] }>();
  for (const row of rows) {
    const milestone = milestoneOf(row, relations, tasks);
    const existing = buckets.get(milestone.key);
    if (existing) {
      existing.rows.push(row);
    } else {
      buckets.set(milestone.key, { title: milestone.title, rows: [row] });
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => {
      // unlinked last
      if (a === UNLINKED_MILESTONE) return 1;
      if (b === UNLINKED_MILESTONE) return -1;
      return a.localeCompare(b);
    })
    .map(([key, value]) => ({ key, title: value.title, rows: value.rows }));
}

export function tabForState(state: DecisionState): PoolTab {
  return state;
}

export function countByTab(decisions: DecisionRow[]): Record<PoolTab, number> {
  const counts: Record<PoolTab, number> = {
    proposed: 0,
    rejected: 0,
    deferred: 0,
    active: 0,
    retired: 0,
  };
  for (const decision of decisions) {
    counts[decision.state] = (counts[decision.state] ?? 0) + 1;
  }
  return counts;
}
