import {
  todoIsOpen,
  type Todo,
  type TaskProjection,
  type TaskRelationQuery,
  type RelationGraphEdgeRow,
} from "@harness-anything/kernel";

export function readTodos(
  projection: Pick<TaskProjection, "listEntities">,
): readonly (Todo & { readonly open: boolean; readonly revision: number; readonly ref: string })[] {
  return projection.listEntities("todo").map((row) => ({
    ...(row.value as unknown as Todo),
    open: todoIsOpen(row.value as unknown as Todo),
    revision: row.workspaceRevision,
    ref: `todo/${row.id}`,
  }));
}

export function todoRelations(
  projection: Pick<TaskProjection, "readRelationQuery">,
  query: Pick<TaskRelationQuery, "source" | "target">,
): readonly RelationGraphEdgeRow[] {
  const rows: RelationGraphEdgeRow[] = [];
  let cursor: string | undefined;
  do {
    const page = projection.readRelationQuery({ ...query, state: "active", limit: 100, ...(cursor ? { cursor } : {}) });
    rows.push(...page.rows);
    cursor = page.page?.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return rows;
}
