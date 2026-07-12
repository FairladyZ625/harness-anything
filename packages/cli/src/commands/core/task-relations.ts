import { readFileSync } from "node:fs";
import { Effect } from "effect";
import type { EngineError, WriteError } from "../../../../kernel/src/index.ts";
import { deriveRelationId, formatRelationFlowRecord, readRelationGraphProjection, readTaskProjection } from "../../../../kernel/src/index.ts";
import type { EntityRelationRecord } from "../../../../kernel/src/index.ts";
import { readFrontmatter, taskDocumentPath } from "../../../../kernel/src/index.ts";
import { detectRelationGraphCycles } from "../../../../kernel/src/index.ts";
import { parseRelationFlowRecords } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { activeTaskLeaseFailure } from "./task-lease-guard.ts";

type TaskRelateAction = Extract<ParsedCommand["action"], { readonly kind: "task-relate" }>;

export function runTaskRelate(
  context: CommandRunnerContext,
  action: TaskRelateAction
): Effect.Effect<CliResult, EngineError | WriteError> {
  const projection = readTaskProjection({ rootDir: context.rootDir, layoutOverrides: context.layoutOverrides });
  const taskIds = new Set(projection.rows.map((row) => row.taskId));
  if (!taskIds.has(action.sourceTaskId)) return Effect.succeed(taskNotFound(action.sourceTaskId, action.sourceTaskId));
  if (!taskIds.has(action.targetTaskId)) return Effect.succeed(taskNotFound(action.sourceTaskId, action.targetTaskId));

  const relation = taskDependsOnRelation(action);
  const cycle = detectDependsOnCycle(context.rootDir, context.layoutOverrides, relation);
  if (cycle) {
    return Effect.succeed({
      ok: false,
      command: "task-relate",
      taskId: action.sourceTaskId,
      error: cliError(CliErrorCode.InvalidTaskRelation, `depends-on cycle detected: ${cycle.join(" -> ")}`)
    } satisfies CliResult);
  }
  if (action.dryRun) return Effect.succeed(taskRelateSuccess(action.sourceTaskId, relation, true));

  return Effect.gen(function* () {
    const leaseFailure = yield* activeTaskLeaseFailure(context, action.sourceTaskId, "task-relate");
    if (leaseFailure) return leaseFailure;
    const indexPath = taskDocumentPath(context.layoutInput, action.sourceTaskId, "INDEX.md");
    const body = readFileSync(indexPath, "utf8");
    const nextBody = appendRelationToTaskIndex(body, relation);
    if (nextBody === body) return taskRelateSuccess(action.sourceTaskId, relation, false);
    yield* context.engine.replaceTaskDocument({ taskId: action.sourceTaskId, path: "INDEX.md", body: nextBody });
    return taskRelateSuccess(action.sourceTaskId, relation, false);
  });
}

function taskNotFound(sourceTaskId: string, missingTaskId: string): CliResult {
  return {
    ok: false,
    command: "task-relate",
    taskId: sourceTaskId,
    error: cliError(CliErrorCode.TaskNotFound, `task not found: ${missingTaskId}`)
  };
}

function taskRelateSuccess(taskId: string, relation: EntityRelationRecord, dryRun: boolean): CliResult {
  return {
    ok: true,
    command: "task-relate",
    taskId,
    path: "INDEX.md",
    report: {
      schema: "task-relation-report/v1",
      dryRun,
      relationId: relation.relation_id,
      source: relation.source,
      type: relation.type,
      target: relation.target,
      orchestration: "not-triggered"
    }
  };
}

function taskDependsOnRelation(action: TaskRelateAction): EntityRelationRecord {
  const base = {
    source: `task/${action.sourceTaskId}`,
    target: `task/${action.targetTaskId}`,
    type: action.relationType,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: action.rationale,
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return { relation_id: deriveRelationId(base), ...base };
}

function detectDependsOnCycle(rootDir: string, layoutOverrides: CommandRunnerContext["layoutOverrides"], next: EntityRelationRecord): ReadonlyArray<string> | null {
  const graph = readRelationGraphProjection({ rootDir, layoutOverrides }).edges
    .filter((edge) => edge.relationType === "depends-on" && edge.state === "active")
    .concat({
      relationId: next.relation_id,
      sourceRef: next.source,
      targetRef: next.target,
      relationType: next.type,
      direction: next.direction,
      strength: next.strength,
      origin: next.origin,
      state: next.state,
      rationale: next.rationale,
      ownerRef: next.source,
      sourcePath: "pending",
      recordIndex: 0
    });
  return detectRelationGraphCycles(graph)[0] ?? null;
}

function appendRelationToTaskIndex(body: string, relation: EntityRelationRecord): string {
  if (body.includes(`relation_id: ${relation.relation_id}`)) return body;
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) return body;
  const line = formatRelationFlowRecord(relation);
  const nextFrontmatter = parseRelationFlowRecords(frontmatter).length > 0 || /^relations:\s*$/mu.test(frontmatter)
    ? frontmatter.replace(/^(relations:\s*\n(?:\s*-\s*\{[^\n]*\}\n?)*)/mu, (block) => `${block.endsWith("\n") ? block : `${block}\n`}${line}\n`)
    : `${frontmatter}\nrelations:\n${line}`;
  return body.replace(`---\n${frontmatter}\n---`, `---\n${nextFrontmatter}\n---`);
}
