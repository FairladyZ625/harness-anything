import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localLayoutFileSystem } from "./local-layout-file-system.ts";

export function listExecutionLeaseRefs(
  rootInput: HarnessLayoutInput
): ReadonlyArray<{ readonly taskId: string; readonly executionId: string }> {
  const holderRoot = path.join(resolveHarnessLayout(rootInput).localRoot, "task-holders");
  if (!localLayoutFileSystem.exists(holderRoot)) return [];
  return localLayoutFileSystem.readDirents(holderRoot)
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(".json"))
    .map((entry) => JSON.parse(localLayoutFileSystem.readText(path.join(holderRoot, entry.name))) as Record<string, unknown>)
    .filter((record) => record.schema === "task-holder/v2" && typeof record.taskId === "string" && typeof record.executionId === "string")
    .map((record) => ({ taskId: String(record.taskId), executionId: String(record.executionId) }))
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}
