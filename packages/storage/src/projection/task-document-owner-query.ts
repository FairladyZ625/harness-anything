import type { StatementSync } from "node:sqlite";
import { documentPathAncestors } from "./document-path-ancestors.ts";

const SQL = "SELECT task_id FROM task_package WHERE package_path = ?";

/**
 * Resolve the longest registered task package prefix at this cut.
 * Every ancestor is an equality point read on task_package's unique path index, so the cost is
 * the document's depth rather than the number of registered task packages.
 */
export function readTaskDocumentOwner(documentPath: string, prepare: (sql: string) => StatementSync): string | null {
  const statement = prepare(SQL),
    ancestors = [...documentPathAncestors(documentPath)].sort((left, right) => right.length - left.length);
  for (const ancestor of ancestors) {
    const row = statement.get(ancestor) as { readonly task_id: string } | undefined;
    if (row !== undefined) return row.task_id;
  }
  return null;
}
