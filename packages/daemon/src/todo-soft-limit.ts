import { openTodoValueEquals, todoSoftLimitAdvisory } from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { projectedTaskSettings } from "./task-wip-settings.ts";

/**
 * The one place an added todo is measured against the repository's soft limit. It runs after the
 * write has been committed and projected, reads the center projection (never an edge cache), and
 * returns the receipt advisory strings; the write itself is never refused here.
 */
export function todoSoftLimitWarnings(cell: RepoCellOperationalContext): readonly string[] {
  const openTodos = cell.projection.countEntities("todo", openTodoValueEquals),
    advisory = todoSoftLimitAdvisory(openTodos, projectedTaskSettings(cell.projection).todos.softLimit);
  return advisory === null ? [] : [advisory];
}
