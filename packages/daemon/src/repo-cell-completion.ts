import { readTaskCompletion } from "./task-completion-read.ts";
import { readTaskReviewAttribution } from "@harness-anything/application";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  submissionDigest,
  completionGateIds,
  compileCompletionGateWitness,
  EXECUTION_DELIVERY_BASELINE_NOTE,
  judgeCompletionEvidence,
  type CompletionEvidenceJudgment,
  deriveTaskRoot,
  documentWorkspacePath,
  hasCloseoutEvidence,
  isTaskEvent,
  repositorySettings,
  resolveHarnessLayout,
  SETTINGS_ID,
  type EventPublicationKillpoint,
  type RepositorySettingsV1,
  type TaskProjectionQueries,
  type CompletionEvidenceV1,
  type ActorIdentity,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";
import {
  taskIncludedByNodeMaterializationPolicy,
  type NodeTaskMaterializationPolicy,
} from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import {
  activeMaterializationHolds,
  materializationState as canonicalMaterializationState,
  type MaterializationEntityState,
  type MaterializationRelation,
} from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import { projectedTaskSettings, resolveTaskRootThreshold } from "./task-wip-settings.ts";
import { readEffectiveCloseoutGates, readEffectiveReviewReturnBudget } from "./repo-cell-settings-state.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import { renderEvidencePayload } from "./repo-cell-evidence.ts";
import { failed } from "./repo-cell-settlement.ts";
import { projectedTaskNotFound } from "./projection-readiness.ts";
import { candidateSample, resolveUniquePrefix } from "./unique-id-prefix.ts";
import { presetSnapshotReader, taskWorkspaceView } from "./task-worktree.ts";
import { readWorktreeSetupSucceeded } from "./worktree-setup.ts";
import { assignmentFromRelations } from "./entity-assignment-runtime.ts";
import { witnessOperationId } from "./repo-cell-proof.ts";

/**
 * The canonical witness write entry: judge the evidence's binding to the frozen cut, then let
 * `compileCompletionGateWitness` enforce that the evidence's source adapter equals the adapter
 * declared in the submission's frozen completion contract.
 */
export function publishGateWitness(
  cell: RepoCellActionContext,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  binding: RepoCellBinding,
  evidence: CompletionEvidenceV1,
): WriteReceipt {
  const execution = snapshot.executions.find(
    (value) => value.executionId === executionId && value.iteration === snapshot.task?.iteration,
  );
  if (!execution?.submission)
    throw cell.cellCodedError("invalid_transition", "A gate witness requires a submitted execution.");
  const judgment: CompletionEvidenceJudgment = judgeCompletionEvidence(evidence, {
    execution,
    gateId: evidence.gateId,
    admitFail: true,
  });
  if (!judgment.accepted)
    throw cell.cellCodedError(
      "invalid_proof",
      `Witness for gate ${evidence.gateId} cannot bind this cut: ${judgment.reason ?? "evidence was rejected"}.`,
    );
  const intent = {
      kind: "canonical-checker-receipt",
      taskId,
      executionId,
      gateId: evidence.gateId,
      result: evidence.result,
      runId: evidence.provenance.runId,
      claimFence: evidence.provenance.claimFence,
      basis: evidence.basis,
    },
    // A witness identifies its frozen cut and actor, independent of later writes or ingress node.
    opId = witnessOperationId(intent, binding.actor, cell.input.repoId),
    existing = cell.store.readEvent(opId);
  if (existing) {
    if (!isTaskEvent(existing) || existing.type !== "completion_gate_verified")
      throw cell.cellCodedError("op_conflict", `opId ${opId} belongs to another event`);
    if (!cell.projection.readOperation(opId)) cell.projection.apply(existing);
    const publication = cell.publicPublication(cell.store.publication(existing));
    return cell.lifecycleReceipt(
      existing,
      cell.projection.read(taskId).snapshot,
      publication,
      cell.receiptProof(existing, publication),
    );
  }
  const rawPaths = packagePath ? [`${packagePath}/INDEX.md`, `${packagePath}/executions/${executionId}.md`] : [],
    compiled = compileCompletionGateWitness({
      snapshot,
      taskId,
      executionId,
      gateId: evidence.gateId,
      result: evidence.result as "pass" | "fail",
      receiptId: opId,
      checkerId: evidence.checkerId,
      commitSha: execution.submission.commitSha,
      iteration: execution.iteration,
      reviewGate: readEffectiveCloseoutGates(cell.projection, snapshot).review,
      actor: binding.actor,
      source: binding.source,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      occurredAt: cell.now(),
      evidence,
      packagePath,
      currentDocuments: rawPaths.flatMap((target) => {
        const document = cell.projection.readDocument(target).document;
        return document ? [document] : [];
      }),
    });
  const appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  cell.completionKillpoint("after_store_commit", opId);
  const receipt = cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
  );
  cell.completionKillpoint("before_response_write", opId);
  cell.completionKillpoint("after_response_write", opId);
  return receipt;
}

export function completionKillpoint(cell: RepoCellActionContext, point: EventPublicationKillpoint, opId: string): void {
  try {
    cell.input.killpoint?.(point);
  } catch (cause) {
    const error = cell.cellCodedError(
      "publication_indeterminate",
      `publication result is unknown; run ha receipt show ${opId} before retrying`,
    ) as Error & {
      opId: string;
      cause?: unknown;
    };
    error.opId = opId;
    error.cause = cause;
    throw error;
  }
}

export function taskShowFromProjection(
  rootDir: string,
  projection: TaskProjectionQueries,
  taskId: string,
  directChildCount = projection.readTaskChildCounts([taskId])[taskId] ?? 0,
  actor?: ActorIdentity,
  nodeTaskMaterializationPolicy: NodeTaskMaterializationPolicy = "include_done",
): WriteReceipt {
  const layout = resolveHarnessLayout(rootDir),
    read = projection.read(taskId),
    progress = projection.readProgress(taskId),
    rootSetting = resolveTaskRootThreshold(projectedTaskSettings(projection)),
    notFound = projectedTaskNotFound(read, taskId);
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
      return taskShowFromProjection(rootDir, projection, prefixed.id, undefined, actor, nodeTaskMaterializationPolicy);
    if (prefixed.candidates.length > 1)
      return failed(
        `read:${taskId}`,
        Object.assign(
          new Error(
            `Task id ${taskId} is a prefix of ${String(prefixed.candidates.length)} task ids ` +
              `(${candidateSample(prefixed.candidates)}). Use a longer prefix or the full id.`,
          ),
          { code: "task_ambiguous_id" } as const,
        ),
      );
    return failed(`read:${taskId}`, notFound);
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
    completion = readTaskCompletion(projection, taskId, rootDir, actor),
    materializationState =
      task === null
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
                  ? readWorktreeSetupSucceeded(path.join(rootDir, workspace.path))
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
