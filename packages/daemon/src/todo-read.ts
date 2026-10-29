import {
  todoIsOpen,
  type Todo,
  type TaskProjection,
  type TaskRelationQuery,
  type RelationGraphEdgeRow,
} from "@harness-anything/kernel";

export function readTodos(
  projection: Pick<TaskProjection, "listEntities" | "getEntity" | "read" | "readDecision" | "readRelationQuery">,
): readonly (Todo & {
  readonly open: boolean;
  readonly revision: number;
  readonly ref: string;
  readonly relations: readonly { readonly ref: string; readonly title: string }[];
})[] {
  return projection.listEntities("todo").map((row) => {
    const todo = row.value as unknown as Todo,
      relations = todoRelations(projection, { source: `todo/${row.id}` }).map((edge) => ({
        ref: edge.targetRef,
        title: todoRelationTitle(projection, edge.targetRef),
      }));
    return {
      ...todo,
      open: todoIsOpen(todo),
      revision: row.workspaceRevision,
      ref: `todo/${row.id}`,
      relations,
    };
  });
}

function todoRelationTitle(
  projection: Pick<TaskProjection, "getEntity" | "read" | "readDecision">,
  ref: string,
): string {
  const slash = ref.indexOf("/"),
    kind = slash < 0 ? "entity" : ref.slice(0, slash),
    id = slash < 0 ? ref : ref.slice(slash + 1);
  if (kind === "task") return projection.read(id).snapshot.task?.title ?? id;
  if (kind === "decision") return projection.readDecision(id).decision?.title ?? id;
  const entity = projection.getEntity(kind, id),
    value = entity?.value;
  return typeof value?.title === "string" ? value.title : id;
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
