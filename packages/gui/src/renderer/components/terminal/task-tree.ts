import type { SnapshotStatus } from "../../model/types.ts";

/** 树选择器只需要的 task 投影(App 从 TaskRow 裁出来)。 */
export interface TaskTreeNode {
  readonly taskId: string;
  readonly title: string;
  readonly parentTaskId?: string | null;
  readonly status?: SnapshotStatus;
  readonly createdAt?: string | null;
}
export interface TaskTreeFilters {
  readonly query: string;
  /** null = 不按状态过滤。 */
  readonly statuses: ReadonlySet<SnapshotStatus> | null;
  /** null = 不按创建时间过滤;否则只保留 N 天内创建的。 */
  readonly createdWithinDays: number | null;
}
export interface TaskTreeRow {
  readonly node: TaskTreeNode;
  readonly depth: number;
  /** 本行是否命中当前筛选(未筛选时恒 false:那是浏览模式,不高亮)。 */
  readonly hit: boolean;
  readonly childCount: number;
  readonly expanded: boolean;
}
export interface TaskTreeIndex {
  readonly byId: ReadonlyMap<string, TaskTreeNode>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly roots: readonly string[];
}

/** 最多渲染多少行;超过就让用户继续收窄,几千个 task 不进 DOM。 */
export const taskTreeRowLimit = 300;
const rootKey = "";

export function buildTaskTreeIndex(nodes: readonly TaskTreeNode[]): TaskTreeIndex {
  const byId = new Map(nodes.map((node) => [node.taskId, node] as const));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    // 父不在集合里(跨项目 / 已归档)就当根,树永远闭合。
    const parent = node.parentTaskId && byId.has(node.parentTaskId) ? node.parentTaskId : rootKey;
    if (parent === rootKey) roots.push(node.taskId);
    else children.set(parent, [...(children.get(parent) ?? []), node.taskId]);
  }
  return { byId, children, roots };
}

/** 从 taskId 上溯到根的祖先链(不含自身,近→远)。 */
export function taskAncestors(index: TaskTreeIndex, taskId: string): TaskTreeNode[] {
  const chain: TaskTreeNode[] = [];
  const seen = new Set<string>([taskId]);
  let current = index.byId.get(taskId)?.parentTaskId ?? null;
  while (current && index.byId.has(current) && !seen.has(current)) {
    seen.add(current);
    chain.push(index.byId.get(current)!);
    current = index.byId.get(current)!.parentTaskId ?? null;
  }
  return chain;
}

export function isFiltering(filters: TaskTreeFilters): boolean {
  return filters.query.trim() !== "" || filters.statuses !== null || filters.createdWithinDays !== null;
}

function matches(node: TaskTreeNode, filters: TaskTreeFilters, now: number): boolean {
  const needle = filters.query.trim().toLowerCase();
  if (needle && !node.title.toLowerCase().includes(needle) && !node.taskId.toLowerCase().includes(needle)) return false;
  if (filters.statuses && (!node.status || !filters.statuses.has(node.status))) return false;
  if (filters.createdWithinDays !== null) {
    const created = node.createdAt ? Date.parse(node.createdAt) : Number.NaN;
    if (!Number.isFinite(created) || now - created > filters.createdWithinDays * 86_400_000) return false;
  }
  return true;
}

/**
 * 把「焦点子树 × 筛选 × 展开/折叠覆盖」摊平成可渲染的行。
 *
 * - 浏览模式(没有任何筛选):从作用域根开始,只有被显式展开的节点才显示子节点。
 * - 筛选模式:命中节点高亮;命中的祖先链自动展开作为上下文,但只显示通往命中的那些孩子;
 *   节点被显式展开(toggles=true)时显示它的全部孩子(「看到它下级所有的」),
 *   显式折叠(false)则收起。
 */
export function taskTreeRows(
  index: TaskTreeIndex,
  filters: TaskTreeFilters,
  focusId: string | null,
  toggles: ReadonlyMap<string, boolean>,
  now = Date.now(),
): { readonly rows: readonly TaskTreeRow[]; readonly hits: number; readonly truncated: boolean } {
  const scopeRoots = focusId && index.byId.has(focusId) ? [focusId] : index.roots;
  const filtering = isFiltering(filters);
  const hitSet = new Set<string>();
  const contextSet = new Set<string>();
  if (filtering) {
    const visit = (id: string, trail: readonly string[]) => {
      if (matches(index.byId.get(id)!, filters, now)) {
        hitSet.add(id);
        for (const ancestor of trail) contextSet.add(ancestor);
      }
      for (const child of index.children.get(id) ?? []) visit(child, [...trail, id]);
    };
    for (const root of scopeRoots) visit(root, []);
  }
  const rows: TaskTreeRow[] = [];
  let truncated = false;
  const emit = (id: string, depth: number) => {
    if (rows.length >= taskTreeRowLimit) {
      truncated = true;
      return;
    }
    const kids = index.children.get(id) ?? [];
    const override = toggles.get(id);
    const showAll = override === true;
    const showContext = override !== false && filtering && contextSet.has(id);
    const visibleKids = showAll ? kids : showContext ? kids.filter((k) => hitSet.has(k) || contextSet.has(k)) : [];
    rows.push({
      node: index.byId.get(id)!,
      depth,
      hit: hitSet.has(id),
      childCount: kids.length,
      expanded: visibleKids.length > 0,
    });
    for (const kid of visibleKids) emit(kid, depth + 1);
  };
  const topLevel = filtering ? scopeRoots.filter((id) => hitSet.has(id) || contextSet.has(id)) : scopeRoots;
  for (const id of topLevel) emit(id, 0);
  return { rows, hits: hitSet.size, truncated };
}
