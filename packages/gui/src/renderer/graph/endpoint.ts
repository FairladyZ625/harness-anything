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
 *   decision/<id>             → { id: "decision/<id>", entity: "decision" }
 *   decision/<id>/<claimId>   → { id: "decision/<id>", entity: "decision", claimId: "<claimId>" }
 *   fact/<task>/<anchor>      → { id: "fact/<task>/<anchor>", entity: "fact" }
 *   task/<id>                 → { id: "<id>", entity: "task" }
 *
 * claim 维度保留(dec_01KXA7811SVVT8P66HNDFZQ7DF):停止 graphLayout.ts 旧版 slice(0,2) 折叠后,
 * 调用方需要既能拿到 decision 归一 id (大多数消费方),也能拿到具体 claim (布局/边锚点)。
 */
export function parseEndpoint(raw: string): { id: string; entity: EntityKind; claimId?: string } | null {
  if (raw.startsWith("decision/")) {
    const parts = raw.split("/");
    if (parts.length < 2) return null;
    const cleanId = `${parts[0]}/${parts[1]}`;
    // 第三段(若存在)即 claim 锚点:CH1 / C1 / RJ1 …
    const claimId = parts.length >= 3 && parts[2] ? parts[2] : undefined;
    return { id: cleanId, entity: "decision", claimId };
  }
  if (raw.startsWith("fact/")) return { id: raw, entity: "fact" };
  if (raw.startsWith("task/")) {
    const id = raw.slice(5).split("/")[0];
    return { id, entity: "task" };
  }
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

/**
 * 提取 decision endpoint 的 claim 锚点(dec_01KXA7811SVVT8P66HNDFZQ7DF CH2)。
 * 用于把 RelationEdge 锚到具体 claim 行,而不是塌成 decision 节点。
 * 非 decision endpoint / 无 claim 段返回 undefined。
 */
export function endpointClaimId(raw: string): string | undefined {
  if (!raw.startsWith("decision/")) return undefined;
  const parts = raw.split("/");
  return parts.length >= 3 && parts[2] ? parts[2] : undefined;
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
      const [src, dst] = dir === "out"
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
