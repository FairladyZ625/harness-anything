/** ASCII renderer for the causal-graph/v1 read payload served by `ha graph`. */
import { consumeKnownError } from "../daemon/client.ts";

interface GraphNode {
  readonly ref: string;
  readonly kind: string;
  readonly id: string;
  readonly label: string | null;
  readonly state: string | null;
  readonly detail: string | null;
  readonly depth: number;
  readonly viaEdge: {
    readonly relationId: string | null;
    readonly relationType: string;
    readonly traversal: "downstream" | "upstream" | "structural";
    readonly state: string | null;
    readonly freshness: string | null;
  } | null;
  readonly cycle: boolean;
  readonly repeated: boolean;
  readonly truncated: boolean;
  readonly children: readonly GraphNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNode(value: unknown): GraphNode | null {
  if (!isRecord(value) || typeof value.ref !== "string" || !Array.isArray(value.children)) return null;
  return value as unknown as GraphNode;
}

function kindLabel(node: GraphNode): string {
  if (node.kind === "task" && node.detail === "milestone") return "Milestone";
  return node.kind.slice(0, 1).toUpperCase() + node.kind.slice(1);
}

function edgeLabel(node: GraphNode): string {
  const edge = node.viaEdge;
  if (edge === null) return "";
  const flags = [
    edge.state === "retired" ? "retired" : null,
    edge.freshness !== null && edge.freshness !== "current" ? edge.freshness : null,
  ].filter((entry): entry is string => entry !== null);
  const type = edge.relationType === "child" && edge.traversal === "upstream" ? "parent" : edge.relationType,
    arrow = edge.traversal === "downstream" || edge.traversal === "structural" ? "" : "<- ";
  return `${arrow}[${type}${flags.length ? ` ${flags.join(" ")}` : ""}] `;
}

function nodeLine(node: GraphNode): string {
  const marks = [node.state, node.cycle ? "cycle" : null, node.repeated && !node.cycle ? "repeat" : null].filter(
    (entry): entry is string => entry !== null && entry.length > 0,
  );
  return [
    `${kindLabel(node)} ${node.id}`,
    node.label === null ? "" : ` — ${node.label}`,
    marks.length ? ` [${marks.join(" ")}]` : "",
    node.truncated ? " …" : "",
  ].join("");
}

function renderChildren(node: GraphNode, prefix: string, lines: string[]): void {
  node.children.forEach((child, index) => {
    const last = index === node.children.length - 1;
    lines.push(`${prefix}${last ? "└── " : "├── "}${edgeLabel(child)}${nodeLine(child)}`);
    renderChildren(child, `${prefix}${last ? "    " : "│   "}`, lines);
  });
}

export function renderCausalGraph(receipt: Record<string, unknown>): string | null {
  if (typeof receipt.evidence !== "string") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(receipt.evidence);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (!isRecord(payload) || payload.schema !== "causal-graph/v1") return null;
  const root = asNode(payload.root),
    stats = isRecord(payload.stats) ? payload.stats : {};
  if (root === null) return null;
  const lines = [nodeLine(root)];
  renderChildren(root, "", lines);
  lines.push(
    `nodes=${String(stats.nodes ?? "?")} edges=${String(stats.edges ?? "?")}` +
      ` truncated=${String(stats.truncated ?? 0)} watermark=${String(payload.watermark ?? "?")}`,
  );
  return lines.join("\n");
}
