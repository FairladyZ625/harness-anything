import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TaskId } from "../../../kernel/src/domain/index.ts";
import { findEntityRefs } from "../../../kernel/src/domain/index.ts";
import { resolveHarnessLayout, taskPackagePath } from "../../../kernel/src/layout/index.ts";

export function renderSupersedesRelation(newTaskId: TaskId, oldTaskId: TaskId, reason: string): string {
  return [
    "---",
    "schema: task-relations/v1",
    `source: task/${newTaskId}`,
    `target: task/${oldTaskId}`,
    "type: supersedes",
    "strength: strong",
    "direction: directed",
    "provenance: declared",
    "state: active",
    "---",
    "",
    "# Supersedes",
    "",
    `task/${newTaskId} supersedes task/${oldTaskId}.`,
    "",
    "## Reason",
    "",
    reason,
    ""
  ].join("\n");
}

export function hasTaskRelations(rootDir: string, taskId: TaskId): boolean {
  const layout = resolveHarnessLayout(rootDir);
  const ownPackage = taskPackagePath(rootDir, taskId);
  for (const filePath of listTextFiles(layout.authoredRoot)) {
    const body = readFileSync(filePath, "utf8");
    const refs = findEntityRefs(body);
    if (refs.some((ref) => !ref.externalHarness && ref.id === taskId)) return true;
    if (filePath.startsWith(ownPackage) && refs.some((ref) => !ref.externalHarness && ref.id !== taskId)) return true;
  }
  return false;
}

function listTextFiles(inputPath: string): ReadonlyArray<string> {
  if (!existsSync(inputPath)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(inputPath, { withFileTypes: true })) {
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTextFiles(fullPath));
      continue;
    }
    if (/\.(md|markdown|txt|ya?ml|json)$/iu.test(entry.name)) files.push(fullPath);
  }
  return files;
}
