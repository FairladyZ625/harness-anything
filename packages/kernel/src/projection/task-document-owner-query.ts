import type { StatementSync } from "node:sqlite";

const SQL = [
  "SELECT task_id FROM task_package WHERE ? = package_path",
  "OR substr(?, 1, length(package_path) + 1) = package_path || '/'",
  "ORDER BY length(package_path) DESC LIMIT 1",
].join(" ");

/** Resolve the longest registered task package prefix at this cut. */
export function readTaskDocumentOwner(documentPath: string, prepare: (sql: string) => StatementSync): string | null {
  return (prepare(SQL).get(documentPath, documentPath) as { readonly task_id: string } | undefined)?.task_id ?? null;
}
