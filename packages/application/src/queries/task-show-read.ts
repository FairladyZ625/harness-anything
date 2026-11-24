import path from "node:path";
import { readTaskReviewAttribution } from "../task-review-attribution.ts";
import {
  completionGateIds,
  deriveTaskRoot,
  documentWorkspacePath,
  EXECUTION_DELIVERY_BASELINE_NOTE,
  hasCloseoutEvidence,
  repositorySettings,
  resolveHarnessLayout,
  SETTINGS_ID,
  submissionDigest,
  type ActorIdentity,
  type RepositorySettingsV1,
  type TaskProjectionQueries,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import {
  activeMaterializationHolds,
  materializationState as canonicalMaterializationState,
  type MaterializationEntityState,
  type MaterializationRelation,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import {
  taskIncludedByNodeMaterializationPolicy,
  type NodeTaskMaterializationPolicy,
} from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import { assignmentFromRelations } from "./task-assignment-read.ts";
import { readTaskCompletion } from "./task-completion-read.ts";
import { renderEvidencePayload } from "./repo-cell-evidence.ts";
import { projectedTaskNotFound } from "./projection-task-read.ts";
import { readEffectiveReviewReturnBudget } from "./task-settings-read.ts";
import type { TaskCoreQueryPorts } from "./task-query-ports.ts";
import { candidateSample, resolveUniquePrefix } from "./unique-prefix.ts";
import { projectedTaskSettings, resolveTaskRootThreshold } from "./task-wip-settings.ts";
import { presetSnapshotReader, taskWorkspaceView } from "./task-workspace-read.ts";

/** Task detail assembled from a projection. Host probes are optional: a cloud node omits them. */
export function taskShowFromProjection(
  rootDir: string,
  projection: TaskProjectionQueries,
  taskId: string,
  directChildCount = projection.readTaskChildCounts([taskId])[taskId] ?? 0,
  actor?: ActorIdentity,
  nodeTaskMaterializationPolicy: NodeTaskMaterializationPolicy = "include_done",
  ports: TaskCoreQueryPorts = {},
  env: NodeJS.ProcessEnv = process.env,
): WriteReceipt {
  const layout = resolveHarnessLayout(rootDir),
    read = projection.read(taskId),
    progress = projection.readProgress(taskId),
    rootSetting = resolveTaskRootThreshold(projectedTaskSettings(projection), env),
    notFound = projectedTaskNotFound(read, taskId);
  const settle = (opId: string, error: unknown): WriteReceipt => {
    if (ports.failRead) return ports.failRead(opId, error) as WriteReceipt;
    throw error;
  };
  // task-show answers with receipts on every path — the fleet lease probe reads outcome/code
  // off the receipt — so settle the shared judgment instead of throwing past the attached
  // fast path, which has no write-queue settlement. A missing exact id still resolves as a
  // unique short-id prefix (git-style); ambiguity lists the candidates.
  if (notFound !== null) {
    const prefixed = resolveUniquePrefix(
      taskId,
      projection.readTaskIndex().rows.map(({ taskId: candidate }) => candidate),
    );
    if (prefixed.matched)
      return taskShowFromProjection(
        rootDir,
        projection,
        prefixed.id,
        undefined,
        actor,
        nodeTaskMaterializationPolicy,
        ports,
        env,
      );
    if (prefixed.candidates.length > 1)
      return settle(
        `read:${taskId}`,
        Object.assign(
          new Error(
            `Task id ${taskId} is a prefix of ${String(prefixed.candidates.length)} task ids ` +
              `(${candidateSample(prefixed.candidates)}). Use a longer prefix or the full id.`,
          ),
          { code: "task_ambiguous_id" } as const,
        ),
      );
    return settle(`read:${taskId}`, notFound);
  }
  const taskRead = projection.read(taskId, true),
    assignmentRevision = Math.max(
      taskRead.snapshot.revision,
      ...projection
        .readRelationQuery({ source: `task/${taskId}`, relationType: "assigned-to" })
        .rows.map((row) => row.workspaceRevision ?? 0),
    ),
    task = taskRead.snapshot.task
      ? { ...taskRead.snapshot.task, assignment: assignmentFromRelations(projection, `task/${taskId}`) }
      : null,
    execution = read.snapshot.executions.find(
      (candidate) => candidate.iteration === task?.iteration && candidate.submission !== null,
    ),
    returnBudget = readEffectiveReviewReturnBudget(projection),
    rootAssessment = task
      ? deriveTaskRoot(
          {
            taskId,
            title: task.title,
            status: task.status,
            taskClass: task.taskClass,
            packageDisposition: task.packageDisposition ?? "active",
            hasOwnExecution:
              read.snapshot.lease !== null ||
              read.snapshot.executions.some(
                (execution) => execution.state === "active" || execution.state === "submitted",
              ),
            hasCloseoutEvidence: hasCloseoutEvidence(read.snapshot.executions),
            directChildCount,
          },
          rootSetting.threshold,
        )
      : null,
    { completion, reviewDispatchFailures } = readTaskCompletion(projection, taskId, rootDir, actor, ports),
    materializationState =
      task === null || (read.packagePath !== null && ports.taskPlanPresent?.(rootDir, read.packagePath) === true)
        ? "materialized"
        : projectedTaskMaterializationState(
            projection,
            { ...task, packagePath: read.packagePath },
            nodeTaskMaterializationPolicy,
          ),
    workspace = taskWorkspaceView(
      rootDir,
      task,
      read.packagePath,
      presetSnapshotReader(projection),
      resolveHarnessLayout(rootDir).authoredRoot,
      ports.linkedWorktree,
    ),
    payload = {
      ...read.snapshot,
      reviewAttribution: readTaskReviewAttribution(projection, taskId, read.sourceRevision),
      // The current-iteration executions the owner needs ids from (review/consent/complete), so
      // getting one never requires probing a write command. Derived here once; the thin CLI renders.
      currentExecutions: read.snapshot.executions
        .filter((value) => value.iteration === task?.iteration)
        .map(({ executionId, state }) => ({ executionId, state })),
      reworkTargets: read.snapshot.executions
        .filter(
          (value) =>
            value.submission &&
            ((value.iteration === task?.iteration && value.state === "submitted") ||
              (task?.status === "active" &&
                value.iteration + 1 === task.iteration &&
                value.state === "changes_requested")),
        )
        .map((value) => ({ executionId: value.executionId, submissionDigest: submissionDigest(value.submission!) })),
      // The raw execution field is start-frozen; ship its semantics beside it so a JSON reader
      // does not mistake the comparison cut for the delivered HEAD (task_199ad30eb5cdd072cd65317919).
      deliveryBaselineNote: EXECUTION_DELIVERY_BASELINE_NOTE,
      assignmentRevision,
      task: task
        ? {
            ...task,
            completionGateIds: completionGateIds(task.completionGateIds, execution?.submission),
          }
        : null,
      packagePath: read.packagePath,
      materializationState,
      ...(read.packagePath === null
        ? {}
        : { workspacePackagePath: documentWorkspacePath(rootDir, read.packagePath, layout) }),
      workspace,
      // Settings `worktree.setup` is what runs in the worktree; what already succeeded there is readable only on
      // the node that holds the checkout, so without one here it is null (unknown), not guessed.
      ...(workspace?.kind === "worktree"
        ? {
            worktreeSetup: {
              declared: projectedWorktreeSetup(projection),
              succeeded:
                workspace.state === "materialized" || workspace.state === "retained"
                  ? (ports.readWorktreeSetupSucceeded?.(path.join(rootDir, workspace.path)) ?? null)
                  : null,
            },
          }
        : {}),
      returnBudget,
      rootAssessment,
      // dec_BEFCF7D0484E901F187C2C8EC6: the kernel's reverify route for this round — how each previous
      // blocking finding is verified; completionNext names who the cut waits on.
      reviewReverify: completion.reviewReverify ?? null,
      completionNext: completion.completionNext,
      completionBlocker: completion.completionBlocker,
      reviewDispatchFailures,
      progress: progress.rows,
    },
    receipt = {
      opId: `read:${taskId}`,
      revision: read.snapshot.revision,
      // The revision optimistic-concurrency task commands (assign/unassign/transition …) must
      // resend as --expected-version. The ledger cut above it is a different number; stating both
      // keeps the mutation input reachable without decoding the evidence snapshot.
      expectedVersion: read.snapshot.revision,
      assignmentRevision,
      evidence: JSON.stringify(payload),
      summary: renderEvidencePayload(payload),
      visibility: "center" as const,
      proof: {
        committedRevision: read.sourceRevision,
        appliedCut: Math.min(read.watermark, progress.watermark),
        durable: true,
        canonicalVisible: read.status === "ready" && progress.status === "ready",
        worktreeVisible: null,
      },
    };
  return read.status === "ready"
    ? { outcome: "applied", ...receipt }
    : {
        outcome: "pending",
        ...receipt,
      };
}

function projectedWorktreeSetup(projection: Pick<TaskProjectionQueries, "getEntity">): readonly string[] {
  const projected = projection.getEntity("settings", SETTINGS_ID)?.value;
  return projected === undefined ? [] : repositorySettings(projected as unknown as RepositorySettingsV1).worktree.setup;
}

export function projectedTaskMaterializationState(
  projection: TaskProjectionQueries,
  task: {
    readonly taskId: string;
    readonly status: string;
    readonly packageDisposition?: string | null;
    readonly packagePath?: string | null;
  },
  policy: NodeTaskMaterializationPolicy,
  documentPath?: string,
): "materialized" | "dematerialized_terminal" | "skipped_by_node_policy" {
  const taskRef = `task/${task.taskId}`,
    entity: MaterializationEntityState = {
      ref: taskRef,
      kind: "task",
      state: task.packageDisposition === "archived" ? "archived" : task.status,
    },
    rows = projection.readTaskRelationsByTargets([taskRef], "depends-on").rows,
    relations: MaterializationRelation[] = rows.map((row) => ({
      source: row.sourceRef,
      target: row.targetRef,
      type: row.relationType as MaterializationRelation["type"],
      state: row.state,
    })),
    sourceTaskIds = [...new Set(rows.flatMap(({ sourceRef }) => /^task\/([^/]+)$/u.exec(sourceRef)?.[1] ?? []))],
    states = new Map<string, MaterializationEntityState>([[taskRef, entity]]);
  for (const source of projection.readTaskStatuses(sourceTaskIds).rows) {
    if (source.status !== null)
      states.set(`task/${source.taskId}`, { ref: `task/${source.taskId}`, kind: "task", state: source.status });
  }
  const holds = activeMaterializationHolds(entity, relations, states);
  if (canonicalMaterializationState(entity, relations, states) === "dematerialized_terminal")
    return "dematerialized_terminal";
  if (taskIncludedByNodeMaterializationPolicy(policy, task)) return "materialized";
  const relativePath =
      documentPath === undefined || task.packagePath === null || task.packagePath === undefined
        ? null
        : documentPath.startsWith(`${task.packagePath}/`)
          ? documentPath.slice(task.packagePath.length + 1)
          : documentPath,
    dependencyAnchor =
      policy !== "none" &&
      holds.length > 0 &&
      (relativePath === null || ["INDEX.md", "task_plan.md", "task-contract.json"].includes(relativePath));
  return dependencyAnchor ? "materialized" : "skipped_by_node_policy";
}
