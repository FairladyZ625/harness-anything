import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow } from "../../api/renderer-dto";
import {
  resolveTaskModule,
  resolveFactModule,
  UNPROJECTED_MODULE,
} from "./moduleAssignment";
import {
  buildGenealogyEdges,
} from "./genealogy";

/**
 * 领地总览分区(REQ-GUI-03 territory zone)。
 *
 * 纯前端派生:把 task/decision/fact 按各自定位维度分进 zone。
 *   task      → module(诚实解析:unassigned → 未投影 zone)
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
}

export interface TerritoryPartition {
  zones: TerritoryZone[];
  /** 孤立实体(无 zone 归属)的 landing chip。 */
  landing: TerritoryChip[];
  /** 未投影计数(用于头部摘要)。 */
  unprojectedCount: number;
}

/** task 分区:按 module 归 zone;module 占位 → 未投影 zone。 */
export function partitionTasks(tasks: ReadonlyArray<TaskRow>): TerritoryZone[] {
  const byModule = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    const mod = resolveTaskModule(task.module);
    const arr = byModule.get(mod) ?? [];
    arr.push(task);
    byModule.set(mod, arr);
  }
  return [...byModule.entries()]
    .sort(([a], [b]) => {
      // 未投影排最后,其余字母序。
      if (a === UNPROJECTED_MODULE) return 1;
      if (b === UNPROJECTED_MODULE) return -1;
      return a.localeCompare(b);
    })
    .map(([mod, group]) => ({
      zoneId: `task:${mod}`,
      title: mod === UNPROJECTED_MODULE ? "未投影" : mod,
      entity: "task" as const,
      moduleId: mod,
      chips: group
        .sort((a, b) => a.title.localeCompare(b.title))
        .map((t) => ({
          navRef: `task/${t.taskId}`,
          label: t.title,
          sub: t.coordinationStatus,
          entity: "task" as const,
          moduleId: mod,
        })),
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
  const unprojectedCount = zones.filter((z) => z.moduleId === UNPROJECTED_MODULE).reduce(
    (sum, z) => sum + z.chips.length,
    0,
  );
  return { zones, landing, unprojectedCount };
}

/** 按 skeleton 种类过滤 partition。 */
export function partitionForSkel(
  skel: TerritorySkel,
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
): TerritoryPartition {
  if (skel === "task") {
    const zones = partitionTasks(tasks);
    return { zones, landing: [], unprojectedCount: zones.filter((z) => z.moduleId === UNPROJECTED_MODULE).reduce((s, z) => s + z.chips.length, 0) };
  }
  if (skel === "decision") {
    const { zones, landing } = partitionDecisions(decisions, relations);
    return { zones, landing, unprojectedCount: 0 };
  }
  if (skel === "fact") {
    const zones = partitionFacts(facts, factAnchors, tasks);
    return { zones, landing: [], unprojectedCount: zones.filter((z) => z.moduleId === UNPROJECTED_MODULE).reduce((s, z) => s + z.chips.length, 0) };
  }
  return partitionAll(tasks, decisions, facts, factAnchors, relations);
}
