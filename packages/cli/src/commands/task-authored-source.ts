import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export function findAuthoredTaskRoot(rootInput: HarnessLayoutInput, taskId: string): string {
  const tasksRoot = resolveHarnessLayout(rootInput).tasksRoot;
  if (!existsSync(tasksRoot)) throw new Error(`Authored task source not found: ${taskId}`);
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(tasksRoot, entry.name, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (frontmatter && readScalar(frontmatter, "task_id", { required: true }) === taskId) {
      return path.join(tasksRoot, entry.name);
    }
  }
  throw new Error(`Authored task source not found: ${taskId}`);
}
