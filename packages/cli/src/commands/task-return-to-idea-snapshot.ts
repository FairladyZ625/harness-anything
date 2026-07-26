import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Schema } from "effect";
import type { TaskReturnToIdeaSnapshotV1 } from "@harness-anything/application";
import {
  executionDeclaration,
  makeTaskHolderService,
  readFrontmatter,
  readScalar,
  resolveHarnessLayout,
  type ExecutionRecord,
  type HarnessLayoutInput
} from "@harness-anything/kernel";

export async function readTaskReturnToIdeaSnapshot(
  rootInput: HarnessLayoutInput,
  taskId: string
): Promise<TaskReturnToIdeaSnapshotV1> {
  const taskRoot = findTaskRoot(rootInput, taskId);
  const executionsRoot = path.join(taskRoot, "executions");
  const activeExecutions = existsSync(executionsRoot)
    ? readdirSync(executionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => decodeExecution(path.join(executionsRoot, entry.name)))
      .filter((execution) => execution.state === "active")
      .map((execution) => ({ executionId: execution.execution_id }))
      .sort((left, right) => left.executionId.localeCompare(right.executionId))
    : [];
  const lease = await makeTaskHolderService({ rootInput }).holder({ taskId });
  const activeLease = lease.effectiveHolder && lease.leaseExpiresAt
    ? {
      holder: lease.effectiveHolder,
      ...(lease.holder?.schema === "task-holder/v2"
        ? { executionId: lease.holder.executionId }
        : {}),
      leaseExpiresAt: lease.leaseExpiresAt
    }
    : null;
  return { taskId, activeExecutions, activeLease };
}

function findTaskRoot(rootInput: HarnessLayoutInput, taskId: string): string {
  const tasksRoot = resolveHarnessLayout(rootInput).tasksRoot;
  if (!existsSync(tasksRoot)) throw new Error(`Task return-to-idea source not found: ${taskId}`);
  for (const entry of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(tasksRoot, entry.name, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
    if (frontmatter && readScalar(frontmatter, "task_id", { required: true }) === taskId) {
      return path.join(tasksRoot, entry.name);
    }
  }
  throw new Error(`Task return-to-idea source not found: ${taskId}`);
}

function decodeExecution(executionPath: string): ExecutionRecord {
  try {
    return Schema.decodeUnknownSync(executionDeclaration.schema)(
      executionDeclaration.documentCodec.decode(readFileSync(executionPath, "utf8"))
    ) as ExecutionRecord;
  } catch (error) {
    throw new Error(
      `Invalid Execution source ${executionPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
