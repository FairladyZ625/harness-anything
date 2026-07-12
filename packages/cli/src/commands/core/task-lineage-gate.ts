import { readFileSync } from "node:fs";
import { readFrontmatter, readRelationGraphProjection, readScalar, taskDocumentPath } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult } from "../../cli/types.ts";

interface TaskLineageMetadata {
  readonly parent?: string;
  readonly preset?: string;
  readonly taskClass?: string;
}

export function milestoneDecisionLineageFailure(
  context: Parameters<CommandRunner>[0],
  taskId: string
): CliResult | null {
  const current = readTaskLineageMetadata(context, taskId);
  if (!current || !requiresDecisionLineage(current)) return null;
  const allowedTargets = new Set([taskId]);
  const visited = new Set([taskId]);
  let parent = current.parent;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    const metadata = readTaskLineageMetadata(context, parent);
    if (!metadata) break;
    if (isMilestone(metadata)) allowedTargets.add(parent);
    parent = metadata.parent;
  }
  const hasLineage = readRelationGraphProjection({
    rootDir: context.rootDir,
    layoutOverrides: context.layoutOverrides
  }).edges.some((edge) =>
    edge.state === "active" &&
    edge.relationType === "derives" &&
    /^decision\/[^/]+\/[^/]+$/u.test(edge.sourceRef) &&
    edge.targetRef.startsWith("task/") &&
    allowedTargets.has(edge.targetRef.slice("task/".length))
  );
  if (hasLineage) return null;
  return {
    ok: false,
    command: "task-complete",
    taskId,
    issues: [{
      code: "decision_lineage_required",
      message: `Milestone or long-running task ${taskId} requires an active decision --derives--> task lineage edge.`
    }],
    error: cliError(
      CliErrorCode.CloseoutNotReady,
      `Milestone or long-running task ${taskId} requires at least one active decision --derives--> task/${taskId} lineage edge before completion.`
    )
  };
}

function readTaskLineageMetadata(
  context: Parameters<CommandRunner>[0],
  taskId: string
): TaskLineageMetadata | null {
  try {
    const frontmatter = readFrontmatter(readFileSync(taskDocumentPath(context.layoutInput, taskId, "INDEX.md"), "utf8"));
    if (!frontmatter) return null;
    const parent = readScalar(frontmatter, "parent");
    const preset = readScalar(frontmatter, "preset");
    const taskClass = readScalar(frontmatter, "taskClass");
    return {
      ...(parent ? { parent } : {}),
      ...(preset ? { preset } : {}),
      ...(taskClass ? { taskClass } : {})
    };
  } catch {
    return null;
  }
}

function requiresDecisionLineage(metadata: TaskLineageMetadata): boolean {
  return isMilestone(metadata) || metadata.preset === "long-running-task" || metadata.taskClass === "epic";
}

function isMilestone(metadata: TaskLineageMetadata): boolean {
  return metadata.preset === "create-milestone" || metadata.taskClass === "milestone";
}
