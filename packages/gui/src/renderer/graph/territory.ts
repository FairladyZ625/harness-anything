import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow, RelationCoverageRow } from "../../api/renderer-dto";
import { incomingRelations } from "../model/relation-direction.ts";
import {
  resolveTaskModule,
  resolveFactModule,
  UNPROJECTED_MODULE,
} from "./moduleAssignment";
import {
  buildGenealogyEdges,
} from "./genealogy";
import { clusterTasksByPrd, type ZoneProgress } from "./territoryProgress";

/**
 * 领地总览分区(REQ-GUI-03 territory zone)。
 *
 * 纯前端派生:把 task/decision/fact 按各自定位维度分进 zone。
 *   task      → PRD(根 task)聚簇 + 进度信号;root 与 module 都缺 → 未投影块(沉底)
 *   decision  → family(谱系连通分量;孤立 decision → 各自独立 zone 或 landing)
 *   fact      → 异常(module 来自宿主 task;宿主不在 → 未投影)
 *
 * zone 是折叠卡片(无关系线),chip 单击进聚光灯。全域(unified)= 三实体合图,
 * 各实体种类独立 skeleton(task/decision/fact)则只画该种类。
 */

export type TerritorySkel = "task" | "decision" | "fact" | "unified";

export interface TerritoryChip {
  navRef: string;
  label: string;
  sub?: string;
  entity: "task" | "decision" | "fact";
  /** 用于 chip 着色与 minimap。 */
  moduleId: string;
}

export interface TerritoryZone {
  zoneId: string;
  title: string;
  entity: "task" | "decision" | "fact";
  moduleId: string;
  chips: TerritoryChip[];
  /** PRD/里程碑块的进度信号(task zone 必有;decision/fact zone 无)。 */
  progress?: ZoneProgress;
}

export interface TerritoryPartition {
  zones: TerritoryZone[];
  /** 孤立实体(无 zone 归属)的 landing chip。 */
  landing: TerritoryChip[];
  /** 未投影计数(用于头部摘要)。 */
  unprojectedCount: number;
}

/**
 * task 分区:按 PRD(根 task)聚簇,每块带状态构成与完成率;
 * 「未投影」块由 clusterTasksByPrd 恒排最后(降权,不占 C 位),但显式保留、不隐藏。
 */
export function partitionTasks(tasks: ReadonlyArray<TaskRow>): TerritoryZone[] {
  return clusterTasksByPrd(tasks).map((cluster) => ({
    zoneId: `task:${cluster.rootId}`,
    title: cluster.title,
    entity: "task" as const,
    moduleId: cluster.progress.unprojected ? UNPROJECTED_MODULE : cluster.rootId,
    chips: cluster.tasks.map((task) => ({
      navRef: `task/${task.taskId}`,
      label: task.title,
      sub: task.coordinationStatus,
      entity: "task" as const,
      moduleId: resolveTaskModule(task.module),
    })),
    progress: cluster.progress,
  }));
}

/**
 * decision 分区:按谱系 family(连通分量)归 zone。
 * 孤立 decision(无谱系边)→ landing,不强制归 zone。
 */
export function partitionDecisions(
  decisions: ReadonlyArray<DecisionRow>,
  relations: ReadonlyArray<RelationEdge>,
): { zones: TerritoryZone[]; landing: TerritoryChip[] } {
  const byId = new Map<string, DecisionRow>();
  for (const d of decisions) byId.set(d.decisionId, d);
  const genealogyEdges = buildGenealogyEdges(relations, byId);

  // 并查集算连通分量(family)。
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      cur = parent.get(cur) ?? cur;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    parent.set(find(a), find(b));
  };
  for (const d of decisions) parent.set(d.decisionId, d.decisionId);
  for (const edge of genealogyEdges) union(edge.from, edge.to);

  const familyMap = new Map<string, DecisionRow[]>();
  const familydByDecision = new Map<string, string>();
  for (const d of decisions) {
    const root = find(d.decisionId);
    const arr = familyMap.get(root) ?? [];
    arr.push(d);
    familyMap.set(root, arr);
    familydByDecision.set(d.decisionId, root);
  }

  const zones: TerritoryZone[] = [];
  const landing: TerritoryChip[] = [];
  let familyIdx = 0;
  for (const [, group] of [...familyMap.entries()].sort((a, b) =>
    (a[1][0]?.title ?? "").localeCompare(b[1][0]?.title ?? ""),
  )) {
    familyIdx += 1;
    const zoneId = `decision:family-${familyIdx}`;
    const chips = group
      .sort((a, b) => (a.title).localeCompare(b.title))
      .map((d) => ({
        navRef: `decision/${d.decisionId}`,
        label: d.title,
        sub: d.state,
        entity: "decision" as const,
        moduleId: zoneId,
      }));
    if (group.length === 1) {
      // 孤立 decision → landing(不进 zone,减少空 zone 噪音)。
      landing.push(chips[0]!);
    } else {
      zones.push({
        zoneId,
        title: `决策族 · ${group[0]!.title.slice(0, 16)}${group.length > 1 ? ` 等 ${group.length}` : ""}`,
        entity: "decision",
        moduleId: zoneId,
        chips,
      });
    }
  }
  return { zones, landing };
}

/** Fact 异常分类(REQ-GUI-03 fact territory + REQ-GUI-07 信号同源)。 */
export type FactAnomaly =
  | "contradictory"
  | "orphan"
  | "low-confidence"
  | "superseded"
  | "normal";

export const ANOMALY_LABEL: Record<FactAnomaly, string> = {
  contradictory: "矛盾 / 已失效",
  orphan: "悬空(无 decision 引用)",
  "low-confidence": "低置信",
  superseded: "被取代",
  normal: "正常",
};

/**
 * 判定单条 fact 的异常类型(与 fact-triage 信号同源,纯前端派生)。
 * 返回第一个命中的异常(按严重度优先);全正常 → "normal"。
 */
export function classifyFactAnomaly(
  factRef: string,
  fact: FactRef | undefined,
  relations: ReadonlyArray<RelationEdge>,
  coveredRefs: ReadonlySet<string>,
): FactAnomaly {
  // contradictory:fact.invalidated 标记,或作为 decision --refuted-by--> fact 的 target(规范方向反查)。
  if (fact?.invalidated) return "contradictory";
  if (incomingRelations(factRef, "refuted-by", relations).length > 0) return "contradictory";
  // superseded:被 supersedes-fact 指向(是 target)。
  if (incomingRelations(factRef, "supersedes-fact", relations).length > 0) return "superseded";
  // low-confidence。
  if (fact?.confidence === "low") return "low-confidence";
  // orphan:无 decision 引用(不在 coveredRefs 且无 evidenced-by 边指向它)。
  const hasEvidence = incomingRelations(factRef, "evidenced-by", relations).length > 0;
  if (!coveredRefs.has(factRef) && !hasEvidence) return "orphan";
  return "normal";
}

/**
 * fact 分区:按宿主 task 的 module 归 zone;异常(orphan/invalidated)单独标。
 * 宿主 task 不在投影 → 未投影 zone。
 */
export function partitionFacts(
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  tasks: ReadonlyArray<TaskRow>,
): TerritoryZone[] {
  // 合并 facts projection + factAnchors(anchors 可能有无 body 的 fact)。
  const seen = new Set<string>();
  const allFacts: { ref: string; taskId: string; label: string; sub?: string }[] = [];
  for (const f of facts) {
    const anchor = f.anchor.split("/").pop() ?? f.anchor;
    const ref = `fact/${f.taskId}/${anchor}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    allFacts.push({ ref, taskId: f.taskId, label: f.text, sub: f.invalidated ? "已失效" : f.category });
  }
  for (const a of factAnchors) {
    if (seen.has(a.factRef)) continue;
    seen.add(a.factRef);
    const taskId = a.factRef.split("/")[1] ?? a.taskId;
    allFacts.push({ ref: a.factRef, taskId, label: a.factId, sub: "anchor" });
  }

  // 失效 fact 集合(用于异常标记)。
  const invalidatedRefs = new Set(
    facts
      .filter((f) => f.invalidated)
      .map((f) => `fact/${f.taskId}/${f.anchor.split("/").pop() ?? f.anchor}`),
  );

  const byModule = new Map<string, typeof allFacts>();
  for (const fact of allFacts) {
    const mod = resolveFactModule(fact.ref, tasks);
    const arr = byModule.get(mod) ?? [];
    arr.push(fact);
    byModule.set(mod, arr);
  }

  return [...byModule.entries()]
    .sort(([a], [b]) => {
      if (a === UNPROJECTED_MODULE) return 1;
      if (b === UNPROJECTED_MODULE) return -1;
      return a.localeCompare(b);
    })
    .map(([mod, group]) => ({
      zoneId: `fact:${mod}`,
      title: mod === UNPROJECTED_MODULE ? "未投影" : mod,
      entity: "fact" as const,
      moduleId: mod,
      chips: group.map((f) => ({
        navRef: f.ref,
        label: f.label,
        sub: invalidatedRefs.has(f.ref) ? "已失效" : f.sub,
        entity: "fact" as const,
        moduleId: mod,
      })),
    }));
}

/**
 * fact 按**异常类型**分区(fact skeleton 专用):contradictory / orphan /
 * low-confidence / superseded / 正常。异常优先,正常按 module 子分。
 */
export function partitionFactsByAnomaly(
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  tasks: ReadonlyArray<TaskRow>,
  relations: ReadonlyArray<RelationEdge>,
  coverageRows: ReadonlyArray<RelationCoverageRow>,
): TerritoryZone[] {
  // 构建 fact 查找表 + coveredRefs。
  const factByRef = new Map<string, FactRef>();
  for (const f of facts) {
    const anchor = f.anchor.split("/").pop() ?? f.anchor;
    factByRef.set(`fact/${f.taskId}/${anchor}`, f);
  }
  const coveredRefs = new Set<string>();
  for (const row of coverageRows) {
    if (row.coveringFactRef) coveredRefs.add(row.coveringFactRef);
  }

  // 合并所有 fact refs。
  const allRefs = new Set<string>([...factByRef.keys()]);
  for (const a of factAnchors) allRefs.add(a.factRef);

  const byAnomaly = new Map<FactAnomaly, { ref: string; fact?: FactRef; taskId: string; label: string }[]>();
  for (const ref of allRefs) {
    const fact = factByRef.get(ref);
    const taskId = ref.split("/")[1] ?? fact?.taskId ?? "";
    const anomaly = classifyFactAnomaly(ref, fact, relations, coveredRefs);
    const arr = byAnomaly.get(anomaly) ?? [];
    arr.push({ ref, fact, taskId, label: fact?.text ?? ref.split("/").pop() ?? ref });
    byAnomaly.set(anomaly, arr);
  }

  const order: FactAnomaly[] = ["contradictory", "orphan", "low-confidence", "superseded", "normal"];
  const zones: TerritoryZone[] = [];
  for (const anomaly of order) {
    const group = byAnomaly.get(anomaly);
    if (!group || group.length === 0) continue;
    // 正常类按 module 子分;异常类整体一个 zone。
    if (anomaly === "normal") {
      const byMod = new Map<string, typeof group>();
      for (const item of group) {
        const mod = resolveFactModule(item.ref, tasks);
        const arr = byMod.get(mod) ?? [];
        arr.push(item);
        byMod.set(mod, arr);
      }
      for (const [mod, items] of [...byMod.entries()].sort(([a], [b]) => {
        if (a === UNPROJECTED_MODULE) return 1;
        if (b === UNPROJECTED_MODULE) return -1;
        return a.localeCompare(b);
      })) {
        zones.push({
          zoneId: `fact:normal:${mod}`,
          title: `正常 · ${mod === UNPROJECTED_MODULE ? "未投影" : mod}`,
          entity: "fact",
          moduleId: mod,
          chips: items.map((f) => ({
            navRef: f.ref,
            label: f.label,
            sub: f.fact?.category,
            entity: "fact" as const,
            moduleId: mod,
          })),
        });
      }
    } else {
      zones.push({
        zoneId: `fact:anomaly:${anomaly}`,
        title: ANOMALY_LABEL[anomaly],
        entity: "fact",
        moduleId: `anomaly:${anomaly}`,
        chips: group.map((f) => ({
          navRef: f.ref,
          label: f.label,
          sub: anomaly,
          entity: "fact" as const,
          moduleId: `anomaly:${anomaly}`,
        })),
      });
    }
  }
  return zones;
}

/**
 * 未投影计数走 **chip 级真相**。task 分区改按 PRD 根聚簇后,module 不再是分组轴,
 * 只数「整块未投影」会把散落在真实 PRD 块里的缺字段 task 漏报成已投影。
 */
function countUnprojectedChips(zones: ReadonlyArray<TerritoryZone>): number {
  let count = 0;
  for (const zone of zones) {
    for (const chip of zone.chips) {
      if (chip.moduleId === UNPROJECTED_MODULE) count += 1;
    }
  }
  return count;
}

/** 全域 partition:task + decision + fact 三实体合图。 */
export function partitionAll(
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
): TerritoryPartition {
  const taskZones = partitionTasks(tasks);
  const { zones: decisionZones, landing } = partitionDecisions(decisions, relations);
  const factZones = partitionFacts(facts, factAnchors, tasks);
  const zones = [...taskZones, ...decisionZones, ...factZones];
  return { zones, landing, unprojectedCount: countUnprojectedChips(zones) };
}

/** 按 skeleton 种类过滤 partition。 */
export function partitionForSkel(
  skel: TerritorySkel,
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
  coverageRows: ReadonlyArray<RelationCoverageRow> = [],
): TerritoryPartition {
  if (skel === "task") {
    const zones = partitionTasks(tasks);
    return { zones, landing: [], unprojectedCount: countUnprojectedChips(zones) };
  }
  if (skel === "decision") {
    const { zones, landing } = partitionDecisions(decisions, relations);
    return { zones, landing, unprojectedCount: 0 };
  }
  if (skel === "fact") {
    const zones = partitionFactsByAnomaly(facts, factAnchors, tasks, relations, coverageRows);
    return { zones, landing: [], unprojectedCount: countUnprojectedChips(zones) };
  }
  return partitionAll(tasks, decisions, facts, factAnchors, relations);
}
