import { consumeKnownError, type TaskIndexProjectionRow } from "../../kernel/src/index.ts";

export interface TaskIndexFilters {
  readonly status?: string;
  readonly module?: string;
  readonly workKind?: string;
  readonly riskTier?: string;
  readonly urgency?: string;
  readonly search?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}

export interface TaskTreeNode {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly pinned: boolean;
  readonly children: readonly TaskTreeNode[];
}

export type TaskIndexSelection =
  | {
      readonly mode: "flat";
      readonly rows: readonly TaskIndexProjectionRow[];
      readonly childCounts: ReadonlyMap<string, number>;
      readonly page?: TaskIndexPage;
    }
  | {
      readonly mode: "tree";
      readonly rows: readonly TaskTreeNode[];
      readonly count: number;
      readonly page?: TaskIndexPage;
    };

interface TaskIndexPage {
  readonly limit: number;
  readonly cursor: string | null;
  readonly nextCursor: string | null;
}

interface MutableTreeNode {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly pinned: boolean;
  children: MutableTreeNode[];
}

export function selectTaskIndex(
  source: Iterable<TaskIndexProjectionRow>,
  input: {
    readonly parentTaskId?: string;
    readonly depth?: number | "all";
    readonly filters?: TaskIndexFilters;
    readonly limit?: number;
    readonly cursor?: string;
  },
): TaskIndexSelection {
  const rows: TaskIndexProjectionRow[] = [],
    children = new Map<string, TaskIndexProjectionRow[]>(),
    childCounts = new Map<string, number>();
  for (const row of source) {
    rows.push(row);
    if (row.parentTaskId !== null) {
      const siblings = children.get(row.parentTaskId);
      if (siblings) siblings.push(row);
      else children.set(row.parentTaskId, [row]);
      childCounts.set(row.parentTaskId, (childCounts.get(row.parentTaskId) ?? 0) + 1);
    }
  }
  for (const siblings of children.values()) siblings.sort(compareTaskRows);
  const filters = input.filters ?? {};
  if (input.depth === undefined) {
    const candidates = input.parentTaskId === undefined ? rows : (children.get(input.parentTaskId) ?? []),
      filtered = candidates.filter((row) => matchesFilters(row, filters)).sort(compareTaskRows),
      page = paginate(filtered, input.limit, input.cursor);
    return {
      mode: "flat",
      rows: page.rows,
      childCounts,
      ...(page.page ? { page: page.page } : {}),
    };
  }
  const roots = children.get(input.parentTaskId!) ?? [],
    tree = buildTree(roots, children, input.depth, filters),
    page = paginate(tree, input.limit, input.cursor);
  return {
    mode: "tree",
    rows: page.rows,
    count: countNodes(page.rows),
    ...(page.page ? { page: page.page } : {}),
  };
}

export function renderTaskIndexPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.schema !== "task-list/v2" || !Array.isArray(record.rows)) return null;
  const rows = record.rows as readonly Record<string, unknown>[],
    body =
      record.mode === "tree"
        ? renderTreeRows(rows)
        : rows
            .map(
              (row) =>
                `${row.pinned === true ? "📌 " : ""}${String(row.taskId)}\t${String(row.status)}\t${String(row.title)}\t${String(row.module ?? "")}\t${String(row.updatedAt ?? "")}\t${String(row.packagePath ?? "")}\t${String(row.packageDisposition ?? "")}\t${String(row.taskClass ?? "")}`,
            )
            .join("\n"),
    page = record.page && typeof record.page === "object" ? `  page=${JSON.stringify(record.page)}` : "";
  return [
    `${record.mode === "tree" ? "tree" : "rows"}:`,
    body || "(none)",
    `count=${String(record.count ?? rows.length)}  status=${String(record.status ?? "unknown")}  watermark=${String(record.watermark ?? "unknown")}  sourceRevision=${String(record.sourceRevision ?? "unknown")}${page}`,
  ].join("\n");
}

function matchesFilters(row: TaskIndexProjectionRow, filters: TaskIndexFilters): boolean {
  const search = filters.search?.toLocaleLowerCase();
  return (
    (!filters.status || row.status === filters.status) &&
    (!filters.module || row.moduleKey === filters.module) &&
    (!filters.workKind || row.workKind === filters.workKind) &&
    (!filters.riskTier || row.riskTier === filters.riskTier) &&
    (!filters.urgency || row.urgency === filters.urgency) &&
    (!filters.updatedAfter || row.updatedAt >= filters.updatedAfter) &&
    (!filters.updatedBefore || row.updatedAt <= filters.updatedBefore) &&
    (!search || row.taskId.toLocaleLowerCase().startsWith(search) || row.title.toLocaleLowerCase().includes(search))
  );
}

function buildTree(
  roots: readonly TaskIndexProjectionRow[],
  children: ReadonlyMap<string, readonly TaskIndexProjectionRow[]>,
  depth: number | "all",
  filters: TaskIndexFilters,
): MutableTreeNode[] {
  const limit = depth === "all" ? Number.POSITIVE_INFINITY : depth,
    seen = new Set<string>(),
    matches = new Set<string>(),
    createNode = (row: TaskIndexProjectionRow) => {
      if (matchesFilters(row, filters)) matches.add(row.taskId);
      return treeNode(row);
    },
    tree = roots.map(createNode),
    stack = tree.map((node) => ({ node, level: 1 })).reverse();
  while (stack.length) {
    const { node, level } = stack.pop()!;
    if (seen.has(node.taskId)) continue;
    seen.add(node.taskId);
    if (level >= limit) continue;
    node.children = (children.get(node.taskId) ?? []).filter((row) => !seen.has(row.taskId)).map(createNode);
    for (let index = node.children.length - 1; index >= 0; index -= 1)
      stack.push({ node: node.children[index]!, level: level + 1 });
  }
  const postorder = tree.map((node) => ({ node, visited: false }));
  while (postorder.length) {
    const frame = postorder.pop()!;
    if (!frame.visited) {
      postorder.push({ node: frame.node, visited: true });
      for (const child of frame.node.children) postorder.push({ node: child, visited: false });
    } else
      frame.node.children = frame.node.children.filter(
        (child) => matches.has(child.taskId) || child.children.length > 0,
      );
  }
  return tree.filter((node) => matches.has(node.taskId) || node.children.length > 0);
}

function treeNode(row: TaskIndexProjectionRow): MutableTreeNode {
  return {
    taskId: row.taskId,
    title: row.title,
    status: row.status,
    pinned: row.pinned,
    children: [],
  };
}

function paginate<T extends { readonly taskId: string }>(
  rows: readonly T[],
  limit: number | undefined,
  cursor: string | undefined,
): { readonly rows: readonly T[]; readonly page?: TaskIndexPage } {
  if (limit === undefined && cursor === undefined) return { rows };
  const pageLimit = limit ?? 100,
    after = cursor === undefined ? null : decodeCursor(cursor),
    remaining = after === null ? rows : rows.filter((row) => row.taskId > after),
    visible = remaining.slice(0, pageLimit),
    last = visible.at(-1);
  return {
    rows: visible,
    page: {
      limit: pageLimit,
      cursor: cursor ?? null,
      nextCursor: remaining.length > pageLimit && last ? encodeCursor(last.taskId) : null,
    },
  };
}

function decodeCursor(value: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string" && parsed[0]) return parsed[0];
  } catch (error) {
    // The caller translates this stable error to the command receipt.
    consumeKnownError(error);
  }
  throw new Error("task list cursor is invalid");
}

function encodeCursor(taskId: string): string {
  return Buffer.from(JSON.stringify([taskId]), "utf8").toString("base64url");
}

function compareTaskRows(left: { readonly taskId: string }, right: { readonly taskId: string }): number {
  return left.taskId.localeCompare(right.taskId);
}

function countNodes(rows: readonly TaskTreeNode[]): number {
  let count = 0;
  const stack = [...rows];
  while (stack.length) {
    const node = stack.pop()!;
    count += 1;
    stack.push(...node.children);
  }
  return count;
}

function renderTreeRows(rows: readonly Record<string, unknown>[]): string {
  const lines: string[] = [],
    stack = rows.map((row) => ({ row, depth: 0 })).reverse();
  while (stack.length) {
    const { row, depth } = stack.pop()!;
    lines.push(
      `${"  ".repeat(depth)}${row.pinned === true ? "📌 " : ""}${String(row.taskId)} [${String(row.status)}] ${String(row.title)}`,
    );
    const children = Array.isArray(row.children) ? (row.children as Record<string, unknown>[]) : [];
    for (let index = children.length - 1; index >= 0; index -= 1)
      stack.push({ row: children[index]!, depth: depth + 1 });
  }
  return lines.join("\n");
}
