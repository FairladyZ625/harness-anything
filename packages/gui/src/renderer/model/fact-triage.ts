/**
 * Fact triage signal computation (W2B).
 *
 * 全部信号从 relation 图投影 + task 元数据现算,不改 kernel fact schema
 * (task_plan §Context: 改 schema 属 kernel 侧变更,需另起 decision)。
 *
 * 设计原则:机器发现候选,人判。信号不下定论,只排序——危险信号顶到最前。
 */

import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "./types";

/** 三元语里「decision claim ↔ fact」的承重边种类(覆盖度可达性) */
const EVIDENCE_KINDS = new Set(["supports", "evidenced-by", "evidences"]);

/** 失效边种类:指向 fact 的入边标记该 fact 已失效/被取代 */
const INVALIDATION_KINDS = new Set(["invalidated-by", "supersedes-fact"]);

/**
 * 危险信号枚举。severity 越高越危险,排序时顶到最前。
 * 信号口径(task_plan Goal §1):
 *   - INVALIDATED: 矛盾/被 invalidated-by/supersedes-fact
 *   - ORPHAN: 撑不起任何 decision 的孤儿 fact
 *   - WEAKLY_CITED: 低 confidence——只支撑非 active decision 的 claim
 *   - SUPERSEDES_OTHER: supersede 旧事实(出边 supersedes-fact)
 *   - MARGINAL_SOURCE: 来自勉强过门的 task(gate 失败 / 收口不齐)
 */
export type FactTriageSignalKind =
  | "INVALIDATED"
  | "ORPHAN"
  | "WEAKLY_CITED"
  | "SUPERSEDES_OTHER"
  | "MARGINAL_SOURCE";

export interface FactTriageSignal {
  kind: FactTriageSignalKind;
  /** 人可读的信号说明(展示在卡片 badge title + 复制上下文) */
  detail: string;
}

export interface FactTriageItem {
  fact: FactRef;
  signals: FactTriageSignal[];
  /** 最高 severity(用于排序);0 = 无信号(健康 fact) */
  severity: number;
  /** 该 fact 支撑的 decision id 列表(去重) */
  citingDecisionIds: string[];
}

/** 信号 → severity 基线(同 severity 内按 fact.at desc 二次排序) */
export const SIGNAL_SEVERITY: Record<FactTriageSignalKind, number> = {
  INVALIDATED: 100,
  ORPHAN: 80,
  WEAKLY_CITED: 50,
  SUPERSEDES_OTHER: 40,
  MARGINAL_SOURCE: 20,
};

export const SIGNAL_LABEL: Record<FactTriageSignalKind, string> = {
  INVALIDATED: "已失效/矛盾",
  ORPHAN: "孤儿 fact",
  WEAKLY_CITED: "低置信",
  SUPERSEDES_OTHER: "取代旧事实",
  MARGINAL_SOURCE: "来源存疑",
};

/**
 * 归一化 endpoint ref → decision id(decision/<id>[/claim] → <id>)。
 * 与 normalizeDecisionId 等价但本地保留以免循环依赖 model/triadic。
 */
function decisionIdOf(ref: string): string | undefined {
  if (!ref.startsWith("decision/")) return undefined;
  return ref.split("/")[1];
}

/** fact ref 归一化:fact/<task>/<id> 与 <task>/<id> 统一成 <task>/<id> anchor */
function factAnchorOf(ref: string): string {
  return ref.replace(/^fact\//, "");
}

/**
 * 计算单条 fact 的 triage 信号。
 *
 * @param fact 目标 fact
 * @param relations 全量 relation 边(图投影)
 * @param decisions 全量 decision(用于判定 active 状态)
 * @param tasks 全量 task(用于判定来源 task 的 gate/收口质量)
 */
export function computeFactTriageSignals(
  fact: FactRef,
  relations: RelationEdge[],
  decisions: DecisionRow[],
  tasks: TaskRow[],
): FactTriageItem {
  const fullRef = `fact/${fact.anchor}`;
  const signals: FactTriageSignal[] = [];

  // --- 收集该 fact 的入边/出边 ---
  const inbound = relations.filter((r) => r.to === fullRef);
  const outbound = relations.filter((r) => r.from === fullRef);

  // --- 1. INVALIDATED: fact.invalidated 标记或失效入边 ---
  const invalidationEdges = inbound.filter((r) => INVALIDATION_KINDS.has(r.kind));
  if (fact.invalidated || invalidationEdges.length > 0) {
    const sources = invalidationEdges
      .map((r) => r.from)
      .filter((v, i, a) => a.indexOf(v) === i);
    signals.push({
      kind: "INVALIDATED",
      detail:
        sources.length > 0
          ? `被失效边指向: ${sources.join(", ")}`
          : "projection 标记为已失效",
    });
  }

  // --- 2/3. 收集 citing decisions(承重边可达的 decision) ---
  const citingDecisionIds = new Set<string>();
  for (const r of [...inbound, ...outbound]) {
    if (!EVIDENCE_KINDS.has(r.kind)) continue;
    const fromDec = decisionIdOf(r.from);
    const toDec = decisionIdOf(r.to);
    if (fromDec && r.to === fullRef) citingDecisionIds.add(fromDec);
    if (toDec && r.from === fullRef) citingDecisionIds.add(toDec);
  }

  // ORPHAN: 撑不起任何 decision
  if (citingDecisionIds.size === 0) {
    signals.push({
      kind: "ORPHAN",
      detail: "该 fact 未被任何 decision claim 沿承重边引用(潜在噪声)",
    });
  } else {
    // WEAKLY_CITED: 所有 citing decision 都是非 active(rejected/deferred/retired/proposed 待裁决)
    const citingDecisions = decisions.filter((d) => citingDecisionIds.has(d.decisionId));
    const hasActive = citingDecisions.some((d) => d.state === "active");
    if (!hasActive) {
      const states = [...new Set(citingDecisions.map((d) => d.state))].sort();
      signals.push({
        kind: "WEAKLY_CITED",
        detail: `仅被非 active decision 引用 (${states.join("/")})——实际承重为零`,
      });
    }
  }

  // --- 4. SUPERSEDES_OTHER: 出边 supersedes-fact(该 fact 取代了旧 fact) ---
  const supersedesTargets = outbound
    .filter((r) => r.kind === "supersedes-fact")
    .map((r) => factAnchorOf(r.to));
  if (supersedesTargets.length > 0) {
    signals.push({
      kind: "SUPERSEDES_OTHER",
      detail: `取代旧 fact: ${supersedesTargets.join(", ")}(需复核取代 rationale)`,
    });
  }

  // --- 5. MARGINAL_SOURCE: 来源 task gate 失败 / 收口不齐 ---
  const sourceTask = tasks.find((t) => t.taskId === fact.taskId);
  if (sourceTask) {
    const failedGates = sourceTask.gates.filter((g) => !g.ok);
    const poorCloseout = ["missing", "incomplete", "failed"].includes(
      sourceTask.closeoutReadiness,
    );
    if (failedGates.length > 0 || poorCloseout) {
      const parts: string[] = [];
      if (failedGates.length > 0)
        parts.push(`gate 失败 ${failedGates.length}/${sourceTask.gates.length}`);
      if (poorCloseout) parts.push(`收口=${sourceTask.closeoutReadiness}`);
      signals.push({
        kind: "MARGINAL_SOURCE",
        detail: `来源 task ${sourceTask.taskId} ${parts.join(" · ")}`,
      });
    }
  }

  const severity = signals.reduce(
    (max, s) => Math.max(max, SIGNAL_SEVERITY[s.kind]),
    0,
  );

  return {
    fact,
    signals,
    severity,
    citingDecisionIds: [...citingDecisionIds].sort(),
  };
}

/**
 * 排序:severity desc → fact.at desc(更新的异常优先)→ anchor asc(稳定兜底)。
 * 只展示有信号的 fact(severity > 0)——健康 fact 不进 triage 池。
 */
export function rankFactTriage(items: FactTriageItem[]): FactTriageItem[] {
  return [...items]
    .filter((item) => item.severity > 0)
    .sort((a, b) => {
      if (b.severity !== a.severity) return b.severity - a.severity;
      if (b.fact.at !== a.fact.at) return b.fact.at.localeCompare(a.fact.at);
      return a.fact.anchor.localeCompare(b.fact.anchor);
    });
}

/** 便捷入口:从原始数据直接算出排好序的 triage 列表 */
export function buildFactTriage(
  facts: FactRef[],
  relations: RelationEdge[],
  decisions: DecisionRow[],
  tasks: TaskRow[],
): FactTriageItem[] {
  const items = facts.map((fact) =>
    computeFactTriageSignals(fact, relations, decisions, tasks),
  );
  return rankFactTriage(items);
}
