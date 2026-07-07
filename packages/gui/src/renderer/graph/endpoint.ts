import type { RelationEdge } from "../model/types";

export type EntityKind = "task" | "decision" | "fact";

export interface NodePos {
  id: string;
  entity: EntityKind;
  label: string;
  sub?: string;
  color?: string;
  /** 仅 task 有（抽屉复用其详情） */
  task?: import("../model/types").TaskRow;
  raw?: any;
  x: number;
  y: number;
}

/**
 * 解析 endpoint 字符串 → 归一 id + entity。
 * 支持三种形式：
 *   decision/<id>        → { id: "decision/<id>", entity: "decision" }
 *   fact/<task>/<anchor> → { id: "fact/<task>/<anchor>", entity: "fact" }
 *   task/<id>            → { id: "<id>", entity: "task" }
 *   裸 id（兼容旧 mock）：仅当是已知 task id 时认作 task
 */
export function parseEndpoint(
  raw: string,
  taskIds: Set<string>,
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
  if (taskIds.has(raw)) return { id: raw, entity: "task" };
  return null;
}

/** 端点 endpoint（统一，来自 RelationEdge.from/to）→ 归一 id（与 NodePos.id / nodes key 对齐） */
export function endpointToNodeId(raw: string): string {
  if (raw.startsWith("decision/")) {
    const parts = raw.split("/");
    return `${parts[0]}/${parts[1]}`;
  }
  if (raw.startsWith("fact/")) return raw;
  if (raw.startsWith("task/")) return raw.slice(5).split("/")[0];
  return raw;
}

/** 沿边方向做闭包；dir=out 沿 from→to 扩散，dir=in 反向。用于 focus 链路。 */
export function collectClosure(
  edges: RelationEdge[],
  start: string,
  dir: "out" | "in",
): Set<string> {
  const seen = new Set([start]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      const [src, dst] = dir === "out" ? [e.from, e.to] : [e.to, e.from];
      if (seen.has(src) && !seen.has(dst)) {
        seen.add(dst);
        changed = true;
      }
    }
  }
  return seen;
}
