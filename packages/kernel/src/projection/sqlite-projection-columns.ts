import type { TaskFieldExtensionProjection } from "./types.ts";

export const baseTaskProjectionColumns = [
  "task_id",
  "title",
  "parent_task_id",
  "work_kind",
  "risk_tier",
  "urgency",
  "canonical_status",
  "coordination_status",
  "raw_status",
  "package_disposition",
  "closeout_readiness",
  "lifecycle_engine",
  "freshness",
  "updated_at",
  "source",
  "source_path",
  "vertical",
  "preset",
  "profile",
  "module_key",
  "module_title",
  "has_lesson_candidates"
] as const;

export function queryableTaskFieldExtensions(
  extensions: ReadonlyArray<TaskFieldExtensionProjection>
): ReadonlyArray<TaskFieldExtensionProjection> {
  const seen = new Set<string>(baseTaskProjectionColumns);
  const projected: TaskFieldExtensionProjection[] = [];
  for (const extension of extensions) {
    if (!extension.projection.queryable) continue;
    if (seen.has(extension.projection.column)) continue;
    seen.add(extension.projection.column);
    projected.push(extension);
  }
  return projected;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
