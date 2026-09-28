import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../model/types";
import type { FactAnchorRow, RelationCoverageRow } from "../../api/renderer-dto";
import { incomingRelations } from "../model/relation-direction.ts";
import { buildGenealogyEdges, decisionIdOf } from "./genealogy";
import { clusterTasksByWork, NO_WORK, NO_WORK_TITLE, type ZoneProgress } from "./territoryProgress";
import type { EntityKind } from "./endpoint";
import { governedEntityLabel, governedEntitySub, type GovernedEntityRow } from "./governedEntities";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GraphFocusSelection } from "./focusSet";
import { isInGraphFocusSet } from "./focusSet";
import { endpointToNodeId } from "./endpoint";

/**
 * 领地总览分区(REQ-GUI-03 territory zone)。
 *
 * 纯前端派生:把五类实体按各自定位维度分进 zone。
 *   task      → 工作(daemon 工作索引给的所属工作)聚簇 + 进度信号;不属于工作 → 独立任务块(沉底)
 *   decision  → family(谱系连通分量;孤立 decision → 各自独立 zone 或 landing)
 *   fact      → 宿主 task 所属的工作;异常单独成块(无宿主/宿主不在/宿主不属于工作 → 独立任务块)
 *   agent     → 运行时身份层,一个 zone(chip 副标带被派 task 数)
 *   schedule  → 运行时定时层,一个 zone(chip 副标带 state + trigger)
 *
 * zone 是折叠卡片(无关系线),chip 单击进聚光灯。全域(unified)= 五实体合图,
 * 各实体种类独立 skeleton(task/decision/fact)则只画该种类;agent/schedule 只在
 * unified 出现(它们没有独立的 skeleton 段,量级是个位数)。
 */

export type TerritorySkel = "task" | "decision" | "fact" | "unified";

/** 领地里的实体种类:与图节点同一个开放取值域(见 graph/endpoint.ts)。 */
export type TerritoryEntity = EntityKind;

export interface TerritoryChip {
  navRef: string;
  label: string;
  sub?: string;
  entity: TerritoryEntity;
  /** chip 所在分组键(工作根 / 决策族 / 异常类 / 运行时层 / kind)。 */
  groupId: string;
  /** 台账 pin 的只读标记(task chip;pin 写入口在任务列表,图上不做第二条写路)。 */
  pinned?: boolean;
}

export interface TerritoryZone {
  zoneId: string;
  title: string;
  entity: TerritoryEntity;
  groupId: string;
  chips: TerritoryChip[];
  /** 工作块的进度信号(task zone 必有;decision/fact zone 无)。 */
  progress?: ZoneProgress;
  /** 重点模式下被折叠出本块的 chip 数(0 = 无折叠或未开重点模式)。 */
  deferred?: number;
}

export interface TerritoryPartition {
  zones: TerritoryZone[];
  /** 孤立实体(无 zone 归属)的 landing chip。 */
  landing: TerritoryChip[];
  /** 落进「独立任务」块的实体计数(用于头部摘要)。 */
  noWorkCount: number;
  /** 重点模式折叠掉的 chip 总数(zone + landing;未分层时缺省)。 */
  deferredCount?: number;
}

/**
 * task 分区:按所属工作聚簇,每块带状态构成与完成率;
 * 「独立任务」块由 clusterTasksByWork 恒排最后(降权,不占 C 位),但显式保留、不隐藏。
 */
export function partitionTasks(tasks: ReadonlyArray<TaskRow>): TerritoryZone[] {
  return clusterTasksByWork(tasks).map((cluster) => ({
    zoneId: `task:${cluster.rootId}`,
    title: cluster.title,
    entity: "task" as const,
    groupId: cluster.rootId,
    chips: cluster.tasks.map((task) => ({
      navRef: `task/${task.taskId}`,
      label: task.title,
      sub: task.coordinationStatus,
      entity: "task" as const,
      groupId: cluster.rootId,
      ...(task.pinned === true ? { pinned: true } : {}),
    })),
    progress: cluster.progress,
  }));
}

/**
 * decision 分区:按谱系 family(连通分量)归 zone。
 * 只有没有任何当前关系的 decision 才进入 landing。
 */
export function partitionDecisions(
  decisions: ReadonlyArray<DecisionRow>,
  relations: ReadonlyArray<RelationEdge>,
): { zones: TerritoryZone[]; landing: TerritoryChip[] } {
  const byId = new Map<string, DecisionRow>();
  for (const d of decisions) byId.set(d.decisionId, d);
  const genealogyEdges = buildGenealogyEdges(relations, byId);
  const relatedIds = new Set(
    relations.flatMap((edge) =>
      [decisionIdOf(edge.from), decisionIdOf(edge.to)].filter((id): id is string => id !== null),
    ),
  );

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
  for (const d of decisions) {
    const root = find(d.decisionId);
    const arr = familyMap.get(root) ?? [];
    arr.push(d);
    familyMap.set(root, arr);
  }

  const zones: TerritoryZone[] = [];
  const landing: TerritoryChip[] = [];
  const related: TerritoryChip[] = [];
  let familyIdx = 0;
  for (const [, group] of [...familyMap.entries()].sort((a, b) =>
    (a[1][0]?.title ?? "").localeCompare(b[1][0]?.title ?? ""),
  )) {
    familyIdx += 1;
    const zoneId = `decision:family-${familyIdx}`;
    const chips = group
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((d) => ({
        navRef: `decision/${d.decisionId}`,
        label: d.title,
        sub: d.state,
        entity: "decision" as const,
        groupId: zoneId,
      }));
    if (group.length === 1 && !relatedIds.has(group[0]!.decisionId)) {
      // 孤立 decision → landing(不进 zone,减少空 zone 噪音)。
      landing.push(chips[0]!);
    } else if (group.length === 1) {
      related.push({ ...chips[0]!, groupId: "decision:related" });
    } else {
      zones.push({
        zoneId,
        title: `决策族 · ${group[0]!.title.slice(0, 16)}${group.length > 1 ? ` 等 ${group.length}` : ""}`,
        entity: "decision",
        groupId: zoneId,
        chips,
      });
    }
  }
  if (related.length)
    zones.push({
      zoneId: "decision:related",
      title: "关联决策",
      entity: "decision",
      groupId: "decision:related",
      chips: related,
    });
  return { zones, landing };
}

/** Fact 异常分类(REQ-GUI-03 fact territory + REQ-GUI-07 信号同源)。 */
export type FactAnomaly = "contradictory" | "orphan" | "low-confidence" | "superseded" | "normal";

export const ANOMALY_LABEL: Record<FactAnomaly, string> = {
  contradictory: "矛盾 / 已失效",
  orphan: "悬空(无宿主且无引用)",
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
  // contradictory: fact.invalidated 标记,或作为 active decision --refuted-by--> fact
  // 的 target(规范方向反查; retired/deleted 边是审计历史)。
  if (fact?.invalidated) return "contradictory";
  if (incomingRelations(factRef, "refuted-by", relations).length > 0) return "contradictory";
  // superseded:被 state=active 的 supersedes-fact 指向(是 target;判据照抄 kernel
  // fact-liveness,retired/deleted 边是审计历史,不算取代)。
  if (incomingRelations(factRef, "supersedes-fact", relations).length > 0) return "superseded";
  // low-confidence。
  if (fact?.confidence === "low") return "low-confidence";
  // orphan:无宿主 produces 边且无 decision 引用(不在 coveredRefs 且无 evidenced-by 边指向它)。
  const hasHostTask = incomingRelations(factRef, "produces", relations).length > 0;
  const hasEvidence = incomingRelations(factRef, "evidenced-by", relations).length > 0;
  if (!hasHostTask && !coveredRefs.has(factRef) && !hasEvidence) return "orphan";
  return "normal";
}

/** fact 的宿主 task:produces 边(task → fact)的起点;standalone fact 没有宿主。 */
function factHostTaskId(factRef: string, relations: ReadonlyArray<RelationEdge>): string | undefined {
  const canonicalRef = factRef.startsWith("fact/") ? factRef : `fact/${factRef}`;
  return relations
    .find((edge) => edge.kind === "produces" && edge.to === canonicalRef && edge.from.startsWith("task/"))
    ?.from.slice("task/".length);
}

/**
 * 判定 Fact 在领地视图中是否可见:宿主 task 被归档/状态过滤隐藏时随宿主一起隐藏,
 * 不降级成独立任务;没有宿主 task(或宿主不在台账任务全集)的 fact 保持可见。
 */
export function isFactVisibleWithHost(
  factRef: string,
  visibleTaskIds: ReadonlySet<string>,
  allTaskIds: ReadonlySet<string>,
  relations: ReadonlyArray<RelationEdge>,
): boolean {
  const ownerTaskId = factHostTaskId(factRef, relations);
  if (!ownerTaskId || !allTaskIds.has(ownerTaskId)) return true;
  return visibleTaskIds.has(ownerTaskId);
}

/**
 * fact 所属工作 = 宿主 task 所属工作(与 task chip 同一份 daemon 给的 workId,fact 因此与宿主
 * task 落在同一工作键)。无宿主、宿主不在投影或宿主不属于任何工作 → NO_WORK,不猜。
 */
function factWorkIndex(
  tasks: ReadonlyArray<TaskRow>,
  relations: ReadonlyArray<RelationEdge>,
): { workOf: (factRef: string) => string; titleOf: (work: string) => string } {
  const workById = new Map<string, string>();
  const titles = new Map<string, string>();
  for (const task of tasks) {
    if (!task.workId) continue;
    workById.set(task.taskId, task.workId);
    if (task.workTitle) titles.set(task.workId, task.workTitle);
  }
  return {
    workOf: (factRef) => {
      const hostTaskId = factHostTaskId(factRef, relations);
      return (hostTaskId && workById.get(hostTaskId)) || NO_WORK;
    },
    titleOf: (work) => (work === NO_WORK ? NO_WORK_TITLE : (titles.get(work) ?? work)),
  };
}

/** 工作分组排序:按工作标题,独立任务恒排最后。 */
function sortWorkGroups<T>(groups: Map<string, T>, titleOf: (work: string) => string): [string, T][] {
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === NO_WORK) return b === NO_WORK ? 0 : 1;
    if (b === NO_WORK) return -1;
    return titleOf(a).localeCompare(titleOf(b)) || a.localeCompare(b);
  });
}

/**
 * fact 分区:按宿主 task 所属的工作归 zone(见 factWorkIndex);
 * 无宿主 / 宿主不在投影 / 宿主不属于工作 → 独立任务 zone。
 */
export function partitionFacts(
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  tasks: ReadonlyArray<TaskRow>,
  relations: ReadonlyArray<RelationEdge> = [],
): TerritoryZone[] {
  // 合并 facts projection + factAnchors(anchors 可能有无 body 的 fact)。
  const seen = new Set<string>();
  const allFacts: { ref: string; taskId?: string; label: string; sub?: string }[] = [];
  for (const f of facts) {
    const ref = f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    allFacts.push({
      ref,
      taskId: f.taskId,
      label: f.text,
      sub: f.archived ? "已归档" : f.invalidated ? "已失效" : f.category,
    });
  }
  for (const a of factAnchors) {
    if (seen.has(a.factRef)) continue;
    seen.add(a.factRef);
    allFacts.push({ ref: a.factRef, ...(a.taskId ? { taskId: a.taskId } : {}), label: a.factId, sub: "anchor" });
  }

  // 失效 fact 集合(用于异常标记);归档标记优先于失效——归档行不在默认检索面,
  // 开关放行回来时第一眼要能看到它为什么被藏。
  const archivedRefs = new Set(
    facts.filter((f) => f.archived).map((f) => (f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`)),
  );
  const invalidatedRefs = new Set(
    facts.filter((f) => f.invalidated).map((f) => (f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`)),
  );

  const works = factWorkIndex(tasks, relations);
  const byWork = new Map<string, typeof allFacts>();
  for (const fact of allFacts) {
    const work = works.workOf(fact.ref);
    const arr = byWork.get(work) ?? [];
    arr.push(fact);
    byWork.set(work, arr);
  }

  return sortWorkGroups(byWork, works.titleOf).map(([work, group]) => ({
    zoneId: `fact:${work}`,
    title: works.titleOf(work),
    entity: "fact" as const,
    groupId: work,
    chips: group.map((f) => ({
      navRef: f.ref,
      label: f.label,
      sub: archivedRefs.has(f.ref) ? "已归档" : invalidatedRefs.has(f.ref) ? "已失效" : f.sub,
      entity: "fact" as const,
      groupId: work,
    })),
  }));
}

/**
 * fact 按**异常类型**分区(fact skeleton 专用):contradictory / orphan /
 * low-confidence / superseded / 正常。异常优先,正常按宿主 task 所属的工作子分。
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
    const ref = f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`;
    factByRef.set(ref, f);
  }
  const coveredRefs = new Set<string>();
  for (const row of coverageRows) {
    if (row.coveringFactRef) coveredRefs.add(row.coveringFactRef);
  }

  // 合并所有 fact refs。
  const allRefs = new Set<string>([...factByRef.keys()]);
  for (const a of factAnchors) allRefs.add(a.factRef);

  const byAnomaly = new Map<FactAnomaly, { ref: string; fact?: FactRef; taskId?: string; label: string }[]>();
  for (const ref of allRefs) {
    const fact = factByRef.get(ref);
    const taskId = fact?.taskId ?? "";
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
    // 正常类按工作子分;异常类整体一个 zone。
    if (anomaly === "normal") {
      const works = factWorkIndex(tasks, relations);
      const byWork = new Map<string, typeof group>();
      for (const item of group) {
        const work = works.workOf(item.ref);
        const arr = byWork.get(work) ?? [];
        arr.push(item);
        byWork.set(work, arr);
      }
      for (const [work, items] of sortWorkGroups(byWork, works.titleOf)) {
        zones.push({
          zoneId: `fact:normal:${work}`,
          title: `正常 · ${works.titleOf(work)}`,
          entity: "fact",
          groupId: work,
          chips: items.map((f) => ({
            navRef: f.ref,
            label: f.label,
            sub: f.fact?.archived ? "已归档" : f.fact?.category,
            entity: "fact" as const,
            groupId: work,
          })),
        });
      }
    } else {
      zones.push({
        zoneId: `fact:anomaly:${anomaly}`,
        title: ANOMALY_LABEL[anomaly],
        entity: "fact",
        groupId: `anomaly:${anomaly}`,
        chips: group.map((f) => ({
          navRef: f.ref,
          label: f.label,
          sub: anomaly,
          entity: "fact" as const,
          groupId: `anomaly:${anomaly}`,
        })),
      });
    }
  }
  return zones;
}

/**
 * 独立任务计数:只统计真正落进「独立任务」块的实体(CEO 裁决 2026-09-14)。
 * 已按工作聚簇的 task 不计入,fact 跟随宿主落点。
 */
function countNoWorkChips(zones: ReadonlyArray<TerritoryZone>): number {
  let count = 0;
  for (const zone of zones) {
    if (zone.groupId === NO_WORK) {
      count += zone.chips.length;
    }
  }
  return count;
}

/** 全域 partition:内建实体 + 声明实体合图。声明 kind 不改代码就多一块领地。 */
export function partitionAll(
  tasks: ReadonlyArray<TaskRow>,
  decisions: ReadonlyArray<DecisionRow>,
  facts: ReadonlyArray<FactRef>,
  factAnchors: ReadonlyArray<FactAnchorRow>,
  relations: ReadonlyArray<RelationEdge>,
  agents: ReadonlyArray<AgentNodeRow> = [],
  schedules: ReadonlyArray<ScheduleNodeRow> = [],
  governed: ReadonlyArray<GovernedEntityRow> = [],
  kindLabel: (kind: string) => string = (kind) => kind,
): TerritoryPartition {
  const taskZones = partitionTasks(tasks);
  const { zones: decisionZones, landing } = partitionDecisions(decisions, relations);
  const factZones = partitionFacts(facts, factAnchors, tasks, relations);
  const zones = [
    ...taskZones,
    ...decisionZones,
    ...factZones,
    ...partitionAgents(agents),
    ...partitionSchedules(schedules),
    ...partitionGoverned(governed, kindLabel),
  ];
  return { zones, landing, noWorkCount: countNoWorkChips(zones) };
}

/**
 * 声明实体层:每个声明 kind 一块领地,chip 副标是它的 locator 指针。
 * 分块规则来自数据本身(kind),不是一份写死的 zone 表。
 */
export function partitionGoverned(
  rows: ReadonlyArray<GovernedEntityRow>,
  kindLabel: (kind: string) => string = (kind) => kind,
): TerritoryZone[] {
  const byKind = new Map<string, GovernedEntityRow[]>();
  for (const row of rows) {
    const list = byKind.get(row.kind);
    if (list) list.push(row);
    else byKind.set(row.kind, [row]);
  }
  return [...byKind.entries()].map(([kind, kindRows]) => ({
    zoneId: `governed:${kind}`,
    title: kindLabel(kind),
    entity: kind,
    groupId: kind,
    chips: kindRows.map((row) => ({
      navRef: row.ref,
      label: governedEntityLabel(row),
      ...(governedEntitySub(row) ? { sub: governedEntitySub(row) as string } : {}),
      entity: kind,
      groupId: kind,
    })),
  }));
}

/** 运行时身份层:一个 zone(量级个位数;chip 副标带被派 task 数)。 */
export function partitionAgents(agents: ReadonlyArray<AgentNodeRow>): TerritoryZone[] {
  if (agents.length === 0) return [];
  return [
    {
      zoneId: "agent:runtime",
      title: "运行时 · Agent",
      entity: "agent",
      groupId: "runtime",
      chips: [...agents]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({
          navRef: agent.id,
          label: agent.name,
          sub: agent.taskCount > 0 ? `${agent.sub} · ${agent.taskCount} task` : agent.sub,
          entity: "agent" as const,
          groupId: "runtime",
        })),
    },
  ];
}

/** 运行时定时层:一个 zone(chip 副标带 state + trigger,daemon 已算好的事实)。 */
export function partitionSchedules(schedules: ReadonlyArray<ScheduleNodeRow>): TerritoryZone[] {
  if (schedules.length === 0) return [];
  return [
    {
      zoneId: "schedule:runtime",
      title: "运行时 · Schedule",
      entity: "schedule",
      groupId: "runtime",
      chips: [...schedules]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((schedule) => ({
          navRef: schedule.id,
          label: schedule.name,
          sub: schedule.sub,
          entity: "schedule" as const,
          groupId: "runtime",
        })),
    },
  ];
}

/**
 * 密度分层(重点模式)在领地的落点:每块只留重点 chip,其余折叠成本块的计数徽章。
 *
 * · pinned task 恒在重点集(种子判定已含),因此**永不被折叠** —— 这是 pin 与
 *   显示/隐藏的绑定:pin 了就一定看得见。
 * · `revealedZones` 是用户逐块展开的记录;展开后该块回到全量(fold 逻辑照旧)。
 * · 未开重点模式(focus=null)原样返回,不做任何隐藏。
 * · landing(孤立 decision)与 zone 同规则。
 */
export function applyTerritoryDensity(
  partition: TerritoryPartition,
  focus: GraphFocusSelection | null,
  revealedZones: ReadonlySet<string>,
): TerritoryPartition {
  if (!focus) return partition;
  const splitZone = (zone: TerritoryZone, chips: TerritoryChip[]): { chips: TerritoryChip[]; deferred: number } => {
    if (revealedZones.has(zone.zoneId)) return { chips, deferred: 0 };
    const kept = chips.filter((chip) => isInGraphFocusSet(focus, endpointToNodeId(chip.navRef)));
    return { chips: kept, deferred: chips.length - kept.length };
  };
  const zones = partition.zones.map((zone) => {
    const split = splitZone(zone, zone.chips);
    return { ...zone, chips: split.chips, deferred: split.deferred };
  });
  const landingSplit = splitZone(
    { zoneId: "__landing__", title: "", entity: "decision", groupId: "", chips: partition.landing },
    partition.landing,
  );
  return {
    zones,
    landing: landingSplit.chips,
    noWorkCount: countNoWorkChips(zones),
    deferredCount: zones.reduce((total, zone) => total + (zone.deferred ?? 0), 0) + landingSplit.deferred,
  };
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
  agents: ReadonlyArray<AgentNodeRow> = [],
  schedules: ReadonlyArray<ScheduleNodeRow> = [],
  governed: ReadonlyArray<GovernedEntityRow> = [],
  kindLabel: (kind: string) => string = (kind) => kind,
): TerritoryPartition {
  if (skel === "task") {
    const zones = partitionTasks(tasks);
    return { zones, landing: [], noWorkCount: countNoWorkChips(zones) };
  }
  if (skel === "decision") {
    const { zones, landing } = partitionDecisions(decisions, relations);
    return { zones, landing, noWorkCount: 0 };
  }
  if (skel === "fact") {
    const zones = partitionFactsByAnomaly(facts, factAnchors, tasks, relations, coverageRows);
    return { zones, landing: [], noWorkCount: countNoWorkChips(zones) };
  }
  return partitionAll(tasks, decisions, facts, factAnchors, relations, agents, schedules, governed, kindLabel);
}
