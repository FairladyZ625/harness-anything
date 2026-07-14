import type { TaskRow, RelationEdge, DecisionRow, FactRef } from "../model/types";
import type { RelationCoverageRow, FactAnchorRow } from "../../api/renderer-dto.ts";
import { endpointToNodeId } from "./endpoint";
import { type SemanticAxis } from "./constants";
import type { GraphFilterInput } from "./graphLayoutTypes";
import { computeClaimCoverage } from "./claimCoverage";
import { statusColor, factRefOf } from "./graphLayoutShared";
import { sortDecisionQueue } from "../model/triadic";
import { computeFactTriageSignals, type FactTriageItem } from "../model/fact-triage";
import { t as translate } from "../i18n/core.ts";

/**
 * L1 领地分区逻辑(IA v2 Layer 0)。
 *
 * 从 territoryLayout.ts 抽出,因为分区(task/decision)+ 评分 + 家族收拢 占了 ~400 行,
 * 与纯几何布局(layoutTerritory)职责不同,合起来 >600 行触发文件复杂度门。
 *
 * 两条骨架轴:
 *   task     — 按 rootTask(milestone)分区;有子任务的根=里程碑块,独立任务按模块聚合。
 *   decision — 按 supersede/refine/narrows 链(权威轴)union-find 收拢成「家族」,
 *              再按 landing(派生的 task 落到哪个 milestone)二次分区;无落地=示警区。
 */

export type TerritorySkel = "task" | "decision" | "fact" | "unified";

// ── 几何常量(与 territoryLayout.ts 共享)──
const TASK_CHIP_H = 30;
const TASK_CHIP_GAP = 4;
const DECISION_CARD_H = 92;
const DECISION_CARD_GAP = 10;
const ZONE_MIN_BODY_H = 36;
// D2:zone 盒高现在跟着 chip 实际数量走(不再夹),ZONE_MAX_BODY_H 仅作上界 sanity guard,
// 避免极端数据(50 成员 × 92px)造出 5000px 单块。实际布局里 expanded 已 slice(0,50)。
const ZONE_MAX_BODY_H = 2400;
const FOLDED_TASK_CAP = 8;
// D2:decision zone 修复前压根不折叠(visibleMembers 直接 return members)→ ≥5 家族默认就重叠。
// 现在与 task 同源 —— 折叠态只显前 N 个家族(按 score 已排),其余进 fold 提示。
const FOLDED_DECISION_CAP = 3;
export const GEO = {
  TASK_CHIP_H,
  TASK_CHIP_GAP,
  DECISION_CARD_H,
  DECISION_CARD_GAP,
  ZONE_MIN_BODY_H,
  ZONE_MAX_BODY_H,
  FOLDED_TASK_CAP,
  FOLDED_DECISION_CAP,
};

// ── 内部结构 ──
export interface Member {
  id: string;
  entity: "task" | "decision" | "fact";
  row: TaskRow | DecisionRow | FactRef;
  label: string;
  color?: string;
  dimmed: boolean;
  hiddenCount: number;
  state?: string;
  coverage?: { covered: number; total: number; uncovered: number };
  historyCount?: number;
  derivedCount?: number;
  riskTier?: string;
  urgency?: string;
  /** fact 特有:失效/孤儿/被替代 等分诊信号(空数组=健康)。 */
  factSignals?: string[];
}

export interface Zone {
  id: string;
  title: string;
  axis: SemanticAxis;
  virtual: boolean;
  unlanded: boolean;
  skel: "task" | "decision" | "fact";
  statusCounts?: Record<string, number>;
  isAllDone?: boolean;
  stateCounts?: Record<string, number>;
  coverageSummary?: { covered: number; total: number; uncovered: number };
  historyTotal?: number;
  total: number;
  members: Member[];
  // 派生几何(布局阶段填):
  bodyH?: number;
  h?: number;
}

export interface Section {
  id: string;
  title: string;
  subtitle: string;
  zones: Zone[];
}

export interface PartitionInput {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  facts: FactRef[];
  relations: RelationEdge[];
  filters: GraphFilterInput;
  coverageRows?: ReadonlyArray<RelationCoverageRow>;
  /** fact 领地的分诊信号需要 factAnchors 全集(判定孤儿证据)。 */
  factAnchors?: ReadonlyArray<FactAnchorRow>;
}

// ══ task 领地 ══

export function partitionTaskTerritory(input: PartitionInput): Section[] {
  const { tasks, relations, filters } = input;
  const visible = tasks.filter(
    (t) => filters.modules.has(t.module) && filters.types.has("task"),
  );

  const byRoot = new Map<string, TaskRow[]>();
  for (const t of visible) {
    const root = t.rootTaskId ?? t.taskId;
    const list = byRoot.get(root);
    if (list) list.push(t);
    else byRoot.set(root, [t]);
  }

  const derivesByTask = new Map<string, number>();
  for (const e of relations) {
    if (e.kind !== "derives") continue;
    const t = endpointToNodeId(e.to);
    derivesByTask.set(t, (derivesByTask.get(t) ?? 0) + 1);
  }

  const milestoneZones: Zone[] = [];
  const soloByModule = new Map<string, TaskRow[]>();

  for (const [rootId, members] of byRoot) {
    if (members.length > 1) {
      const root = members.find((m) => m.taskId === rootId);
      milestoneZones.push(
        buildTaskZone(`root:${rootId}`, root?.rootTitle ?? root?.title ?? rootId, members, derivesByTask, false),
      );
    } else {
      const t = members[0];
      const mod = t.module || translate("graph.territoryPartition.notDividedIntoModules");
      const list = soloByModule.get(mod);
      if (list) list.push(t);
      else soloByModule.set(mod, [t]);
    }
  }

  const moduleZones: Zone[] = [];
  for (const [mod, list] of soloByModule) {
    moduleZones.push(buildTaskZone(`mod:${mod}`, mod, list, derivesByTask, true));
  }

  milestoneZones.sort((a, b) => taskZoneRank(a) - taskZoneRank(b));
  moduleZones.sort((a, b) => taskZoneRank(a) - taskZoneRank(b));

  const sections: Section[] = [];
  if (milestoneZones.length > 0) {
    sections.push({
      id: "milestones",
      title: translate("graph.territoryPartition.milestoneTaskTree"),
      subtitle: translate("graph.territoryPartition.countBlocksSortingBlockingProceedingPlanningDone", { count: milestoneZones.length }),
      zones: milestoneZones,
    });
  }
  if (moduleZones.length > 0) {
    sections.push({
      id: "solo",
      title: translate("graph.territoryPartition.independentTasksAggregatedByModule"),
      subtitle: translate("graph.territoryPartition.valueItems", { value: moduleZones.reduce((s, z) => s + z.total, 0) }),
      zones: moduleZones,
    });
  }
  return sections;
}

function buildTaskZone(
  id: string,
  title: string,
  members: TaskRow[],
  derivesByTask: Map<string, number>,
  virtual: boolean,
): Zone {
  const statusCounts: Record<string, number> = {};
  for (const t of members) {
    const s = t.coordinationStatus ?? "unknown";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }
  const total = members.length;
  const isAllDone = total > 0 && (statusCounts.done ?? 0) === total;

  const sorted = [...members].sort((a, b) => taskScore(b) - taskScore(a));
  const memberList: Member[] = sorted.map((t) => {
    const nodeId = t.taskId;
    const decCount = derivesByTask.get(nodeId) ?? 0;
    return {
      id: nodeId,
      entity: "task" as const,
      row: t,
      label: t.title,
      color: statusColor(t),
      dimmed: t.coordinationStatus === "done" || t.coordinationStatus === "cancelled",
      hiddenCount: decCount,
    };
  });

  return {
    id,
    title,
    axis: "execution",
    virtual,
    unlanded: false,
    skel: "task",
    statusCounts,
    isAllDone,
    total,
    members: memberList,
  };
}

/** task 重要性:阻塞 > 进行 > 封存 > 规划 > done/cancelled;叠加近期性。 */
function taskScore(t: TaskRow): number {
  const base: Record<string, number> = {
    blocked: 40,
    active: 28,
    in_review: 22,
    planned: 12,
    done: 4,
    cancelled: 2,
    unknown: 8,
  };
  let s = base[t.coordinationStatus ?? "unknown"] ?? 8;
  const da = daysAgo(t.lastKnownAt);
  s += da < 3 ? 24 : da < 7 ? 14 : da < 30 ? 6 : 0;
  return s;
}

/** zone 排序键:blocked → active → done 占比多(沉底)。 */
function taskZoneRank(z: Zone): number {
  const c = z.statusCounts ?? {};
  if ((c.blocked ?? 0) > 0) return 0;
  if ((c.active ?? 0) > 0) return 1;
  const doneRatio = z.total > 0 ? (c.done ?? 0) / z.total : 0;
  if (doneRatio >= 0.8) return 3;
  return 2;
}

// ══ decision 领地 ══

export function partitionDecisionTerritory(input: PartitionInput): Section[] {
  const { decisions, tasks, relations, filters, coverageRows } = input;
  const visible = decisions.filter((_d) => filters.types.has("decision"));

  // union-find:权威轴连起来的 decision = 同一家族
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const d of visible) parent.set(`decision/${d.decisionId}`, `decision/${d.decisionId}`);
  for (const e of relations) {
    if (e.kind !== "supersedes" && e.kind !== "refines" && e.kind !== "narrows") continue;
    const s = endpointToNodeId(e.from);
    const t = endpointToNodeId(e.to);
    if (parent.has(s) && parent.has(t)) union(s, t);
  }

  const fams = new Map<string, string[]>();
  for (const d of visible) {
    const id = `decision/${d.decisionId}`;
    const root = find(id);
    const list = fams.get(root);
    if (list) list.push(id);
    else fams.set(root, [id]);
  }

  const superseded = new Set<string>();
  for (const e of relations) {
    if (e.kind === "supersedes") superseded.add(endpointToNodeId(e.to));
  }

  const decById = new Map<string, DecisionRow>(
    visible.map((d) => [`decision/${d.decisionId}`, d] as [string, DecisionRow]),
  );
  const taskById = new Map<string, TaskRow>(tasks.map((t) => [t.taskId, t] as [string, TaskRow]));

  const derivesFromDecision = new Map<string, string[]>();
  for (const e of relations) {
    if (e.kind !== "derives") continue;
    const s = endpointToNodeId(e.from);
    const t = endpointToNodeId(e.to);
    // endpointToNodeId 把 task/task_X 剥成 task_X;decision/dec_Y 保留前缀。
    if (s.startsWith("decision/") && !t.startsWith("decision/") && !t.startsWith("fact/")) {
      const list = derivesFromDecision.get(s);
      if (list) list.push(t);
      else derivesFromDecision.set(s, [t]);
    }
  }

  interface Fam {
    headId: string;
    members: string[];
    landing: string | null;
    landingRootId: string | null;
  }
  const famList: Fam[] = [];
  for (const [, memberIds] of fams) {
    const cands = memberIds.filter((id) => !superseded.has(id));
    const pool = cands.length > 0 ? cands : memberIds;
    const sorted = [...pool].sort((a, b) => {
      const da = decById.get(a);
      const db = decById.get(b);
      return decisionScore(db) - decisionScore(da);
    });
    const headId = sorted[0];

    const landingCnt = new Map<string, number>();
    let landingTitle: string | null = null;
    let landingRootId: string | null = null;
    for (const mid of memberIds) {
      const taskIds = derivesFromDecision.get(mid) ?? [];
      for (const tid of taskIds) {
        const task = taskById.get(tid);
        if (!task) continue;
        const rootId = task.rootTaskId ?? task.taskId;
        landingCnt.set(rootId, (landingCnt.get(rootId) ?? 0) + 1);
      }
    }
    if (landingCnt.size > 0) {
      let best = -1;
      for (const [rootId, cnt] of landingCnt) {
        if (cnt > best) {
          best = cnt;
          landingRootId = rootId;
          const rep = tasks.find((t) => (t.rootTaskId ?? t.taskId) === rootId);
          landingTitle = rep?.rootTitle ?? rep?.title ?? rootId;
        }
      }
    }
    famList.push({ headId, members: memberIds, landing: landingTitle, landingRootId });
  }

  const byLanding = new Map<string, Fam[]>();
  for (const f of famList) {
    const key = f.landing ?? "__unlanded__";
    const list = byLanding.get(key);
    if (list) list.push(f);
    else byLanding.set(key, [f]);
  }

  const landingEntries = [...byLanding.entries()].sort((a, b) => {
    const au = a[0] === "__unlanded__";
    const bu = b[0] === "__unlanded__";
    if (au !== bu) return au ? 1 : -1;
    const aProp = a[1].some((f) => f.members.some((id) => decById.get(id)?.state === "proposed"));
    const bProp = b[1].some((f) => f.members.some((id) => decById.get(id)?.state === "proposed"));
    if (aProp !== bProp) return aProp ? -1 : 1;
    const aMax = Math.max(...a[1].map((f) => decisionScore(decById.get(f.headId))));
    const bMax = Math.max(...b[1].map((f) => decisionScore(decById.get(f.headId))));
    return bMax - aMax;
  });

  const sections: Section[] = [];
  for (const [landingKey, famsAtLanding] of landingEntries) {
    const unlanded = landingKey === "__unlanded__";
    const landingTitle = unlanded ? translate("graph.territoryPartition.notYetLanded") : (famsAtLanding[0].landing ?? "");
    const title = unlanded
      ? translate("graph.territoryPartition.notYetImplementedDecisionFamilyWithoutDerived")
      : translate("graph.territoryPartition.milestoneLandingTitle", { landingTitle: landingTitle });
    const zones: Zone[] = [
      buildDecisionZone(landingKey, landingTitle, famsAtLanding, decById, derivesFromDecision, coverageRows, unlanded),
    ];
    sections.push({
      id: `landing:${landingKey}`,
      title,
      subtitle: translate("graph.territoryPartition.countDecisionFamilies", { count: famsAtLanding.length }),
      zones,
    });
  }

  return sections;
}

// ══ fact 领地 ══

/**
 * fact 领地:按宿主 task 的模块分区,失效/孤儿/被替代/低置信的 fact 单独收拢进「需关注」示警区。
 *
 * 复用 fact-triage.ts 的分诊信号(INVALIDATED/ORPHAN/SUPERSEDED/LOW_CONFIDENCE)判定
 * 示警区成员;健康 fact 按模块聚合,与 task 领地的 module zone 同构(便于用户横向对照)。
 *
 * 模块过滤策略(与 unified ledger 对齐):
 *   - 有宿主 task → 宿主 module 在 filters.modules 中才可见;
 *   - 无宿主(task 不在投影)→ 保留可见(与 unlanded 区一致,避免无主 fact 被模块误删)。
 */
export function partitionFactTerritory(input: PartitionInput): Section[] {
  const { facts, tasks, relations, filters, coverageRows, factAnchors } = input;
  const taskById = new Map<string, TaskRow>(tasks.map((t) => [t.taskId, t] as [string, TaskRow]));
  // 类型 + 宿主模块双门;无宿主 fact 不过模块门(见上 JSDoc)。
  const visible = facts.filter((f) => {
    if (!filters.types.has("fact")) return false;
    const host = taskById.get(f.taskId);
    return host ? filters.modules.has(host.module) : true;
  });

  // 分诊信号(复用 fact-triage 的权威判定)
  const triaged: FactTriageItem[] = visible.map((f) =>
    computeFactTriageSignals(
      f,
      relations,
      coverageRows ?? [],
      factAnchors ?? [],
    ),
  );

  // 告警 fact(有任意信号,severity > 0)
  const alertItems = triaged.filter((it) => it.severity > 0);
  const healthyItems = triaged.filter((it) => it.severity === 0);

  const sections: Section[] = [];

  // 示警区:first section — 失效/被替代/孤儿的 fact 单列一块(用户首要关注)
  if (alertItems.length > 0) {
    sections.push({
      id: "fact-alerts",
      title: translate("graph.territoryPartition.evidenceRequiresAttention"),
      subtitle: translate("graph.territoryPartition.countFactsNeedAttention", { count: alertItems.length }),
      zones: [buildFactZone("fact-alert", translate("graph.territoryPartition.invalidatedOrphanSuperseded"), alertItems, taskById, true)],
    });
  }

  // 健康事实:按宿主 task 的模块聚合
  const unhostedLabel = translate("graph.territoryPartition.unhostedTask");
  const byModule = new Map<string, FactTriageItem[]>();
  for (const it of healthyItems) {
    const host = taskById.get(it.fact.taskId);
    const mod = host?.module ?? unhostedLabel;
    const list = byModule.get(mod);
    if (list) list.push(it);
    else byModule.set(mod, [it]);
  }

  const moduleZones: Zone[] = [];
  for (const [mod, items] of byModule) {
    // 未挂接 task 的 fact → 标 unlanded(示警:宿主 task 不在投影里)。
    moduleZones.push(buildFactZone(`fact-mod:${mod}`, mod, items, taskById, false, mod === unhostedLabel));
  }
  moduleZones.sort((a, b) => b.total - a.total);

  if (moduleZones.length > 0) {
    sections.push({
      id: "fact-by-module",
      title: translate("graph.territoryPartition.evidenceByModule"),
      subtitle: translate("graph.territoryPartition.valueItems", { value: moduleZones.reduce((s, z) => s + z.total, 0) }),
      zones: moduleZones,
    });
  }
  return sections;
}

function buildFactZone(
  id: string,
  title: string,
  items: FactTriageItem[],
  taskById: Map<string, TaskRow>,
  isAlert: boolean,
  unlanded = false,
): Zone {
  const sorted = [...items].sort((a, b) => factScore(b) - factScore(a));
  const members: Member[] = sorted.map((it) => {
    const nodeId = factRefOf(it.fact);
    return {
      id: nodeId,
      entity: "fact" as const,
      row: it.fact,
      label: it.fact.text?.slice(0, 60) ?? it.fact.anchor,
      dimmed: Boolean(it.fact.invalidated) || it.signals.some((s) => s.kind === "INVALIDATED" || s.kind === "SUPERSEDED"),
      hiddenCount: it.citingDecisionIds.length,
      factSignals: it.signals.map((s) => s.kind),
    };
  });

  // fact 计数:失效/孤儿/被替代/低置信 各算一档,供 zone header 展示
  const stateCounts: Record<string, number> = {};
  for (const it of items) {
    for (const sig of it.signals) {
      stateCounts[sig.kind] = (stateCounts[sig.kind] ?? 0) + 1;
    }
  }
  void taskById;

  return {
    id,
    title,
    axis: "evidence",
    virtual: false,
    unlanded: isAlert || unlanded,
    skel: "fact",
    stateCounts: Object.keys(stateCounts).length > 0 ? stateCounts : undefined,
    total: members.length,
    members,
  };
}

/** fact 重要性:有信号(severity)的优先;同类按近期性。 */
function factScore(it: FactTriageItem): number {
  if (it.severity > 0) return 1000 + it.severity;
  const da = daysAgo(it.fact.at);
  return da < 3 ? 24 : da < 7 ? 14 : da < 30 ? 6 : 0;
}

function buildDecisionZone(
  id: string,
  title: string,
  fams: { headId: string; members: string[] }[],
  decById: Map<string, DecisionRow>,
  derivesFromDecision: Map<string, string[]>,
  coverageRows: ReadonlyArray<RelationCoverageRow> | undefined,
  unlanded: boolean,
): Zone {
  const heads = fams.map((f) => ({ f, head: decById.get(f.headId)! })).filter((x) => x.head);
  const sorted = sortDecisionQueue(heads.map((x) => x.head));
  const sortedFams = sorted
    .map((d) => heads.find((x) => x.head.decisionId === d.decisionId)!)
    .filter(Boolean);

  const members: Member[] = sortedFams.map(({ f, head }) => {
    const cov = computeClaimCoverage(head, coverageRows);
    const covered = cov.filter((c) => c.status === "covered").length;
    const uncovered = cov.filter((c) => c.status === "uncovered").length;
    const famDerived = new Set<string>();
    for (const mid of f.members) {
      for (const tid of derivesFromDecision.get(mid) ?? []) famDerived.add(tid);
    }
    return {
      id: `decision/${head.decisionId}`,
      entity: "decision" as const,
      row: head,
      label: head.title,
      dimmed: head.state === "retired" || head.state === "rejected",
      hiddenCount: 0,
      state: head.state,
      coverage: { covered, total: cov.length, uncovered },
      historyCount: f.members.length - 1,
      derivedCount: famDerived.size,
      riskTier: head.riskTier,
      urgency: head.urgency,
    };
  });

  const stateCounts: Record<string, number> = {};
  let covCovered = 0;
  let covTotal = 0;
  let historyTotal = 0;
  for (const { f, head } of sortedFams) {
    stateCounts[head.state] = (stateCounts[head.state] ?? 0) + 1;
    const cov = computeClaimCoverage(head, coverageRows);
    covCovered += cov.filter((c) => c.status === "covered").length;
    covTotal += cov.length;
    historyTotal += f.members.length - 1;
  }

  return {
    id,
    title,
    axis: "authority",
    virtual: false,
    unlanded,
    skel: "decision",
    stateCounts,
    coverageSummary: { covered: covCovered, total: covTotal, uncovered: covTotal - covCovered },
    historyTotal,
    total: members.length,
    members,
  };
}

/** decision 重要性:proposed > active > deferred > retired/rejected;叠加 uncovered + 近期性。 */
function decisionScore(d: DecisionRow | undefined): number {
  if (!d) return 0;
  const base: Record<string, number> = {
    proposed: 34,
    active: 20,
    deferred: 10,
    retired: 0,
    rejected: 0,
  };
  let s = base[d.state] ?? 5;
  const unc = d.claims.filter((c) => {
    const chosen = d.chosen.find((x) => x.id === c.id);
    return !chosen?.evidence?.length;
  }).length;
  s += Math.min(15, unc * 3);
  const da = daysAgo(d.proposedAt ?? d.lastChangedAt ?? "");
  s += da < 3 ? 26 : da < 7 ? 16 : da < 30 ? 6 : 0;
  return s;
}

function daysAgo(iso: string): number {
  if (!iso) return 999;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 999;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}
