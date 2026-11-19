import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { scopedPersonId, type CollaboratorScope } from "@harness-anything/kernel/internal/domain/collaborator-scope.ts";
import {
  drainCursorPagesSync,
  todoIsOpen,
  type Todo,
  type TaskProjection,
  type TaskRelationQuery,
  type RelationGraphEdgeRow,
} from "@harness-anything/kernel";

export type TodoScope = "mine" | "all" | { readonly personId: string };

export interface TodoReadQuery extends CollaboratorScope {
  readonly viewerPersonId?: string;
  readonly scope?: TodoScope;
}

export function readTodos(
  projection: Pick<TaskProjection, "listEntities" | "getEntity" | "read" | "readDecision" | "readRelationQuery">,
  query: TodoReadQuery = {},
): readonly (Todo & {
  readonly createdByPersonId: string | null;
  readonly originNodeId: string | null;
  readonly open: boolean;
  readonly revision: number;
  readonly ref: string;
  readonly relations: readonly { readonly ref: string; readonly title: string }[];
})[] {
  const mine = query.scope === "mine",
    personId =
      scopedPersonId(query) ??
      (mine ? query.viewerPersonId : typeof query.scope === "object" ? query.scope.personId : undefined);
  return projection
    .listEntities("todo")
    .filter((row) => {
      if (query.filterNodeId !== undefined && query.filterNodeId !== row.originNodeId) return false;
      if (mine && row.createdByPersonId == null) return true;
      return personId === undefined ? !mine : row.createdByPersonId === personId;
    })
    .map((row) => {
      const todo = row.value as unknown as Todo,
        relations = todoRelations(projection, { source: `todo/${row.id}` }).map((edge) => ({
          ref: edge.targetRef,
          title: todoRelationTitle(projection, edge.targetRef),
        }));
      return {
        ...todo,
        createdByPersonId: row.createdByPersonId ?? null,
        originNodeId: row.originNodeId ?? null,
        open: todoIsOpen(todo),
        revision: row.workspaceRevision,
        ref: `todo/${row.id}`,
        relations,
      };
    });
}

/** Viewer-facing list entry; unowned historical rows remain discoverable in the default view. */
export function readViewerTodos(
  projection: Parameters<typeof readTodos>[0],
  query: TodoReadQuery & { readonly viewerPersonId: string },
): ReturnType<typeof readTodos> {
  return readTodos(projection, { scope: "mine", ...query });
}

function todoRelationTitle(
  projection: Pick<TaskProjection, "getEntity" | "read" | "readDecision">,
  ref: string,
): string {
  const slash = ref.indexOf("/"),
    kind = slash < 0 ? "entity" : ref.slice(0, slash),
    id = slash < 0 ? ref : ref.slice(slash + 1);
  if (kind === "task") return projection.read(id).snapshot.task?.title ?? id;
  if (kind === "decision") return projection.readDecision(id, false).decision?.title ?? id;
  const entity = projection.getEntity(kind, id),
    value = entity?.value;
  return typeof value?.title === "string" ? value.title : id;
}

export function todoRelations(
  projection: Pick<TaskProjection, "readRelationQuery">,
  query: Pick<TaskRelationQuery, "source" | "target" | "relationType">,
): readonly RelationGraphEdgeRow[] {
  return drainCursorPagesSync((facets) => {
    const read = projection.readRelationQuery({
      ...query,
      state: "active",
      limit: storageReadPolicy.defaultValue.pageSizes.standard,
      ...facets,
    });
    return { ...read, page: { nextCursor: read.page?.nextCursor ?? null } };
  }, "entity relations").flatMap((page) => page.rows);
}
