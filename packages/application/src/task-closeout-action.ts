import { createHash } from "node:crypto";
import {
  createTaskCloseoutPacketTemplate,
  closeoutReadiness,
  currentExecutionCuts,
  isSamePerson,
  isSameExecution,
  stableStringify,
  taskCloseoutPacketSchema,
  validateTaskCloseoutPacket,
  type ActorIdentity,
  type AuthorizationDecision,
  type CloseoutCiJudgment,
  type CloseoutSnapshot,
  type LeaseV1,
  type ReceiptDiagnostic,
  type SubmissionV1,
  type TaskCloseoutPacket,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";

/** The `ci` completion gate id every CI judgment is reconciled against; the task contract owns whether it applies. */
const ciGateId = "ci";
type Snapshot = CloseoutSnapshot & {
  readonly revision: number;
  readonly task:
    | (NonNullable<CloseoutSnapshot["task"]> & {
        readonly taskId: string;
        readonly currentNode: string;
        readonly createdBy: ActorIdentity;
      })
    | null;
  readonly lease: LeaseV1 | null;
};
export type CloseoutStep =
  | "preset-upgrade"
  | "submit"
  | "review-execution"
  | "review-consent"
  | "complete"
  | "task-show";
export interface TaskCloseoutActionDependencies {
  readonly rootDir: string;
  readonly action: Readonly<Record<string, unknown>>;
  readonly caller: ActorIdentity;
  readonly authorizationDecision: AuthorizationDecision;
  readonly opId: string;
  readonly readWorkspaceText: (rootDir: string, requested: string, field: string) => string;
  readonly read: () => Promise<Snapshot>;
  readonly presetSnapshotCurrent: () => boolean;
  readonly invoke: (
    stage: CloseoutStep,
    action: Readonly<Record<string, unknown>>,
    actor: ActorIdentity,
  ) => Promise<WriteReceipt>;
}

/** One compound daemon action; every mutation still runs through the canonical leaf lifecycle commands. */
export async function runTaskCloseoutAction(dependencies: TaskCloseoutActionDependencies): Promise<WriteReceipt> {
  const { action, caller, opId } = dependencies,
    taskId = requiredText(action.taskId, "taskId"),
    executionId = typeof action.executionId === "string" ? action.executionId : undefined;
  const snapshot = await dependencies.read(),
    task = snapshot.task;
  if (!task || task.taskId !== taskId) return reject(opId, "task_not_found", { commands: ["ha task list"] });
  if (action.printSchema === true) return discoveryReceipt(opId, snapshot, taskCloseoutPacketSchema);
  if (action.printTemplate === true) {
    const submitted = currentExecutionCuts(snapshot).some(
        (candidate) =>
          candidate.submission !== null && (executionId === undefined || candidate.executionId === executionId),
      ),
      template = createTaskCloseoutPacketTemplate({
        includeSubmission: !submitted,
        ci: task.completionGateIds.includes(ciGateId) ? "passed" : "not_applicable",
      });
    return discoveryReceipt(opId, snapshot, template);
  }
  const fromFile = requiredText(action.fromFile, "fromFile"),
    invocation = closeoutInvocation(taskId, fromFile, executionId);
  let judgment: TaskCloseoutPacket;
  try {
    judgment = readJudgment(() => dependencies.readWorkspaceText(dependencies.rootDir, fromFile, "fromFile"));
  } catch (error) {
    return reject(opId, "invalid_judgment", {
      commands: [invocation],
      diagnostic: {
        kind: "validation",
        entity: "task-closeout-packet",
        field: "packet",
        actual: error instanceof Error ? error.message : String(error),
        expectation: "a valid closeout packet",
      },
    });
  }
  const repairCandidates = currentExecutionCuts(snapshot).filter(
      (candidate) =>
        candidate.state === "submitted" &&
        candidate.actor.executor === null &&
        (executionId === undefined || candidate.executionId === executionId),
    ),
    executorRepair = task.currentNode === "review" && repairCandidates.length === 1 ? repairCandidates[0] : undefined,
    declareExecutor = executorRepair
      ? [
          `ha task declare-executor ${taskId}`,
          `--execution-id ${executorRepair.executionId}`,
          "--reason <auditable-recovery-reason>",
        ].join(" ")
      : null;
  if (task.status === "done") {
    const shown = await dependencies.invoke("task-show", { kind: "task-show", taskId }, caller);
    return { ...shown, taskId, summary: `task ${taskId} is already done`, steps: [] } as WriteReceipt;
  }
  if (task.status === "planned")
    return reject(opId, "not_started", {
      commands: [`ha task start ${taskId} --execution-id <execution-id>`, invocation],
    });
  if (task.status === "blocked")
    return reject(opId, "task_blocked", {
      commands: [`ha task transition ${taskId} active`, ...(declareExecutor ? [declareExecutor] : []), invocation],
    });
  if (task.status === "cancelled")
    return reject(opId, "terminal_task", {
      commands: [`ha task supersede ${taskId} --title <follow-up-title>`],
    });
  if (task.status !== "active" && task.status !== "in_review")
    return reject(opId, "invalid_transition", { commands: [`ha task show ${taskId}`, invocation] });
  const ciIssue = ciJudgmentIssue(task.completionGateIds, judgment.completion.ci);
  if (ciIssue)
    return reject(opId, "invalid_judgment", {
      commands: [invocation],
      diagnostic: {
        kind: "validation",
        entity: "task-closeout-packet",
        field: "completion.ci",
        actual: ciIssue,
        expectation: task.completionGateIds.includes(ciGateId) ? "passed" : "not_applicable",
      },
    });
  if (task.status === "active" && declareExecutor)
    return reject(opId, "executor_missing", { commands: [declareExecutor, invocation] });
  let stage = 0,
    submitActor: ActorIdentity | null = null,
    submission: SubmissionV1;
  if (task.status === "active") {
    if (!judgment.submission)
      return reject(opId, "submission_required", {
        commands: [`ha task closeout ${taskId} --print-template`, invocation],
      });
    submission = judgment.submission;
    if (!snapshot.lease)
      return reject(opId, "lease_required", {
        commands: [`ha task start ${taskId} --execution-id <execution-id>`, invocation],
      });
    if (executionId && snapshot.lease.executionId !== executionId)
      return candidateRejection(opId, taskId, fromFile, [snapshot.lease.executionId]);
    const active = snapshot.executions.find(
      (candidate) =>
        candidate.executionId === snapshot.lease?.executionId &&
        candidate.iteration === task.iteration &&
        candidate.state === "active" &&
        candidate.submission === null,
    );
    if (!active) return reject(opId, "invalid_transition", { commands: [`ha task show ${taskId}`, invocation] });
    submitActor = snapshot.lease.actor;
  } else {
    const cuts = currentExecutionCuts(snapshot),
      candidates = executionId ? cuts.filter((candidate) => candidate.executionId === executionId) : cuts;
    if (candidates.length !== 1)
      return candidateRejection(
        opId,
        taskId,
        fromFile,
        cuts.map((candidate) => candidate.executionId),
      );
    const selected = candidates[0]!;
    if (!selected.submission) return reject(opId, "invalid_transition", { commands: [`ha task show ${taskId}`] });
    submission = selected.submission;
    if (judgment.submission && !sameSubmission(selected.submission, judgment.submission))
      return reject(opId, "submission_mismatch", {
        commands: [invocation],
        diagnostic: {
          kind: "validation",
          entity: `execution/${selected.executionId}`,
          field: "submission",
          actual: JSON.stringify(judgment.submission),
          expectation: JSON.stringify(selected.submission),
        },
      });
    const reviewId = deterministicReviewId(taskId, task.iteration, submission.commitSha, judgment.review);
    const assessed = closeoutReadiness(
      executionId
        ? {
            ...snapshot,
            executions: snapshot.executions.filter(
              (candidate) => candidate.iteration !== task.iteration || candidate.executionId === executionId,
            ),
          }
        : snapshot,
    );
    if (assessed.blocker === "projection_unknown")
      return reject(opId, "projection_unknown", { commands: [`ha task show ${taskId}`, invocation] });
    stage = assessed.blocker === "review" ? 1 : assessed.blocker === "consent" ? 2 : 3;
    if (
      stage > 1 &&
      !snapshot.reviews.some((review) => review.executionId === selected.executionId && review.reviewId === reviewId)
    )
      stage = 1;
    if (
      stage > 2 &&
      !snapshot.consents.some(
        (consent) => consent.executionId === selected.executionId && consent.reviewId === reviewId,
      )
    )
      stage = 2;
  }

  const reviewId = deterministicReviewId(taskId, task.iteration, submission.commitSha, judgment.review),
    consentId = deterministicId("consent-closeout", taskId, String(task.iteration), submission.commitSha, reviewId);

  const selector = executionId ? { executionId } : {},
    humanReviewer: ActorIdentity = { principal: caller.principal, executor: null },
    steps: Array<WriteReceipt & { readonly stage: string }> = [];
  const closeoutAuthorization = dependencies.authorizationDecision;
  if (!task.createdBy || !isSamePerson(task.createdBy, caller))
    return {
      ...reject(opId, "actor_unauthorized", { commands: [invocation] }),
      authorizationDecision: closeoutAuthorization,
    };
  if (stage <= 0 && (!snapshot.lease || !isSameExecution(snapshot.lease.actor, caller)))
    return {
      ...reject(opId, "actor_unauthorized", { commands: [invocation] }),
      authorizationDecision: closeoutAuthorization,
    };
  if (!dependencies.presetSnapshotCurrent()) {
    const stopped = await invoke("preset-upgrade", { kind: "preset-upgrade", taskId }, caller);
    if (stopped) return stopped;
  }
  if (stage <= 0) {
    const stopped = await invoke(
      "submit",
      { kind: "task-submit", taskId, ...selector, submission },
      submitActor ?? caller,
    );
    if (stopped) return stopped;
  }
  if (stage <= 1) {
    const reviewBody = `${JSON.stringify(judgment.review, null, 2)}\n`,
      stopped = await invoke(
        "review-execution",
        { kind: "task-review-execution", taskId, ...selector, reviewId, jsonInput: reviewBody },
        humanReviewer,
      );
    if (stopped) return stopped;
    if (judgment.review.verdict !== "approved")
      return {
        ...reject(opId, judgment.review.verdict === "changes_requested" ? "changes_requested" : "review_not_approved", {
          commands:
            judgment.review.verdict === "changes_requested"
              ? [`ha task start ${taskId} --execution-id <execution-id>`, invocation]
              : [invocation],
        }),
        stoppedAt: "review-execution",
        steps,
      } as WriteReceipt;
  }
  if (stage <= 2) {
    const stopped = await invoke(
      "review-consent",
      { kind: "task-review-consent", taskId, ...selector, reviewId, consentId },
      caller,
    );
    if (stopped) return stopped;
  }
  const ciFlag = judgment.completion.ci === "passed" ? { ci: "passed" as const } : {};
  const pathFlag = { paths: judgment.completion.codeDocPaths };
  const completion = { kind: "task-complete", taskId, ...selector, ...ciFlag, ...pathFlag };
  const stopped = await invoke("complete", completion, caller);
  if (stopped) return stopped;
  const { stage: _stage, ...final } = steps.at(-1)!;
  return {
    ...final,
    authorizationDecision: closeoutAuthorization,
    taskId,
    reviewId,
    consentId,
    submittedCommitSha: submission.commitSha,
    summary: `closed out task ${taskId}`,
    steps,
  } as WriteReceipt;

  async function invoke(
    name: Exclude<CloseoutStep, "task-show">,
    leaf: Readonly<Record<string, unknown>>,
    actor: ActorIdentity,
  ): Promise<WriteReceipt | null> {
    const receipt = await dependencies.invoke(name, leaf, actor);
    steps.push({ stage: name, ...receipt });
    if (receipt.outcome === "applied") return null;
    const commands = name === "complete" ? [`ha task complete ${taskId}`, invocation] : [invocation];
    return {
      ...receipt,
      authorizationDecision: receipt.authorizationDecision ?? closeoutAuthorization,
      code: receipt.code ?? "closeout_stopped",
      guidance: receipt.guidance && receipt.guidance.length > 0 ? receipt.guidance : commandGuidance(commands),
      stoppedAt: name,
      steps,
    } as WriteReceipt;
  }
}

function readJudgment(readText: () => string): TaskCloseoutPacket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText());
  } catch (error) {
    throw new Error(
      `Closeout judgment must be one readable JSON object inside the workspace: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const validation = validateTaskCloseoutPacket(parsed);
  if (!validation.ok)
    throw new Error(`Closeout packet has ${validation.issues.length} error(s):\n- ${validation.issues.join("\n- ")}`);
  return validation.packet;
}
/**
 * The task contract, never the executor, decides which CI judgment is honest for this task.
 * A declared `ci` completion gate demands `passed`; no declared `ci` gate demands `not_applicable`,
 * because there is no CI run on this change for `passed` to refer to. Exactly one value is legal
 * either way, so closeout can neither invent a green CI run nor wave away a gate the contract declared.
 */
function ciJudgmentIssue(completionGateIds: readonly string[], ci: CloseoutCiJudgment): string | null {
  const declared = completionGateIds.includes(ciGateId);
  if (ci === (declared ? "passed" : "not_applicable")) return null;
  const because = declared
    ? `declares the ${ciGateId} completion gate`
    : `declares no ${ciGateId} completion gate, so no CI run judges this change`;
  const expected = declared ? "passed" : "not_applicable";
  return (
    `completion.ci must be ${expected} because this task contract ${because};` +
    " closeout never invents a CI judgment."
  );
}
function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}
function deterministicId(prefix: string, ...parts: readonly unknown[]): string {
  return `${prefix}-${createHash("sha256")
    .update(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\0"))
    .digest("hex")
    .slice(0, 16)}`;
}
function deterministicReviewId(
  taskId: string,
  iteration: number,
  commitSha: string,
  review: TaskCloseoutPacket["review"],
): string {
  return deterministicId("review-closeout", taskId, String(iteration), commitSha, review);
}
function closeoutInvocation(taskId: string, fromFile: string, executionId?: string): string {
  return `ha task closeout ${taskId} --from-file ${fromFile}${executionId ? ` --execution-id ${executionId}` : ""}`;
}
function candidateRejection(
  opId: string,
  taskId: string,
  fromFile: string,
  candidates: readonly string[],
): WriteReceipt {
  const commands = candidates.map((candidate) => closeoutInvocation(taskId, fromFile, candidate));
  return reject(opId, "ambiguous_execution", {
    commands:
      commands.length > 0
        ? commands
        : [`ha task submit ${taskId} --json-input '<submission-json>'`, closeoutInvocation(taskId, fromFile)],
  });
}
function reject(
  opId: string,
  code: string,
  detail: { readonly commands?: readonly string[]; readonly diagnostic?: ReceiptDiagnostic } = {},
): WriteReceipt {
  return {
    outcome: "op_rejected",
    opId,
    code,
    origin: "daemon",
    evidence: `rejection:${code}`,
    ...(detail.commands?.length ? { guidance: commandGuidance(detail.commands) } : {}),
    ...(detail.diagnostic ? { diagnostic: detail.diagnostic } : {}),
  };
}
function commandGuidance(commands: readonly string[]) {
  return commands.map((command) => ({ kind: "run-command" as const, args: { command } }));
}
function sameSubmission(left: SubmissionV1, right: SubmissionV1): boolean {
  return stableStringify(left) === stableStringify(right);
}
function discoveryReceipt(opId: string, snapshot: Snapshot, value: unknown): WriteReceipt {
  return {
    outcome: "applied",
    opId: `read:${opId}`,
    revision: snapshot.revision,
    evidence: JSON.stringify(value),
    visibility: "center",
    proof: {
      committedRevision: snapshot.revision,
      appliedCut: snapshot.revision,
      durable: true,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    summary: `${JSON.stringify(value, null, 2)}\n`,
  } as WriteReceipt;
}
