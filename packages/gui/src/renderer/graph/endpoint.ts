import type { DecisionRow, FactRef, RelationEdge, TaskRow } from "../model/types";
import type { AgentNodeRow, ScheduleNodeRow } from "./runtimeEntities";
import type { GovernedEntityRow } from "./governedEntities";

/**
 * 图实体种类。**没有清单**:取值是 daemon 已注册 kind 读面上的 kind 字符串。
 * 内建五类(task/decision/fact/agent/schedule)的 id 归一规则由代码拥有(见 parseEndpoint),
 * 声明出来的 kind 用完整 ref 作节点 id。
 */
export type EntityKind = string;

export interface NodePos {
  id: string;
  entity: EntityKind;
  label: string;
  sub?: string;
  color?: string;
  /** 仅 task 有（抽屉复用其详情） */
  task?: import("../model/types").TaskRow;
  raw?: TaskRow | DecisionRow | FactRef | AgentNodeRow | ScheduleNodeRow | GovernedEntityRow;
  x: number;
  y: number;
}

/**
 * 解析 endpoint 字符串 → 归一 id + entity。
 *
 * 内建五类各有自己的 id 归一(task 去前缀、decision 截两段、fact 保留整串),这套规则
 * 从 ref 本身推不出来,所以留在代码里:
 *   decision/<id>        → { id: "decision/<id>", entity: "decision" }
 *   fact/<anchor>        → { id: "fact/<anchor>", entity: "fact" }
 *   task/<id>            → { id: "<id>", entity: "task" }
 *   agent/<id>           → { id: "agent/<id>", entity: "agent" }
 *   schedule/<id>        → { id: "schedule/<id>", entity: "schedule" }
 *
 * 其余 kind 由调用方传入 `declaredKinds`(已注册 kind 读面派生),ref 整串即节点 id。
 * vertical 的 ref 是多段(`software/coding/x@1/ADR-…`),所以按最长前缀先匹配。
 * 不传 declaredKinds = 只认内建五类,与本函数原来的行为一致。
 */
export function parseEndpoint(
  raw: string,
  declaredKinds: readonly string[] = [],
): { id: string; entity: EntityKind } | null {
  if (raw.startsWith("decision/")) {
    const parts = raw.split("/");
    const cleanId = `${parts[0]}/${parts[1]}`;
    return { id: cleanId, entity: "decision" };
  }
  if (raw.startsWith("fact/")) return { id: raw, entity: "fact" };
  if (raw.startsWith("task/")) {
    const id = raw.slice(5).split("/")[0];
    return { id, entity: "task" };
  }
  if (raw.startsWith("agent/")) {
    const parts = raw.split("/");
    return { id: `agent/${parts[1] ?? ""}`, entity: "agent" };
  }
  if (raw.startsWith("schedule/")) {
    const parts = raw.split("/");
    return { id: `schedule/${parts[1] ?? ""}`, entity: "schedule" };
  }
  const declared = declaredKinds
    .filter((kind) => raw.startsWith(`${kind}/`))
    .sort((left, right) => right.length - left.length)[0];
  return declared === undefined ? null : { id: raw, entity: declared };
}

/** 端点 endpoint（统一，来自 RelationEdge.from/to）→ 归一 id（与 NodePos.id / nodes key 对齐） */
export function endpointToNodeId(raw: string): string {
  if (raw.startsWith("decision/")) {
    const parts = raw.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  if (raw.startsWith("fact/")) return raw;
  if (raw.startsWith("task/")) return raw.slice(5).split("/")[0];
  if (raw.startsWith("agent/")) return `agent/${raw.split("/")[1] ?? ""}`;
  if (raw.startsWith("schedule/")) return `schedule/${raw.split("/")[1] ?? ""}`;
  return raw;
}

/** 沿边方向做闭包；dir=out 沿 from→to 扩散，dir=in 反向。用于 focus 链路。 */
export function collectClosure(edges: RelationEdge[], start: string, dir: "out" | "in"): Set<string> {
  const seen = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const [src, dst] =
        dir === "out"
          ? [endpointToNodeId(e.from), endpointToNodeId(e.to)]
          : [endpointToNodeId(e.to), endpointToNodeId(e.from)];
      if (seen.has(src) && !seen.has(dst)) {
        seen.add(dst);
        changed = true;
      }
    }
  }
  return seen;
}
