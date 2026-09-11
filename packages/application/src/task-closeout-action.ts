import {
  createTaskCloseoutPacketTemplate,
  currentExecutionCuts,
  isSamePerson,
  isSameExecution,
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
export type CloseoutStep = "preset-upgrade" | "submit" | "complete" | "task-show";
export interface TaskCloseoutActionDependencies {
  readonly action: Readonly<Record<string, unknown>>;
  readonly caller: ActorIdentity;
  readonly authorizationDecision: AuthorizationDecision;
  readonly opId: string;
  readonly readPacket: () => string;
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
    const template = createTaskCloseoutPacketTemplate({
      includeSubmission: false,
      ci: task.completionGateIds.includes(ciGateId) ? "passed" : "not_applicable",
    });
    return discoveryReceipt(opId, snapshot, template);
  }
  const packetArgument =
      typeof action.fromFile === "string"
        ? `--from-file ${requiredText(action.fromFile, "fromFile")}`
        : "--json-input '<json>'",
    invocation = closeoutInvocation(taskId, packetArgument, executionId);
  let judgment: TaskCloseoutPacket;
  try {
    judgment = readJudgment(dependencies.readPacket);
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
  let submitActor: ActorIdentity | null = null,
    submission: SubmissionV1 | undefined;
  if (task.status === "active") {
    if (!snapshot.lease)
      return reject(opId, "lease_required", {
        commands: [`ha task start ${taskId} --execution-id <execution-id>`, invocation],
      });
    if (executionId && snapshot.lease.executionId !== executionId)
      return candidateRejection(opId, taskId, packetArgument, [snapshot.lease.executionId]);
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
        packetArgument,
        cuts.map((candidate) => candidate.executionId),
      );
    const selected = candidates[0]!;
    if (!selected.submission) return reject(opId, "invalid_transition", { commands: [`ha task show ${taskId}`] });
    submission = selected.submission;
  }

  const selector = executionId ? { executionId } : {},
    steps: Array<WriteReceipt & { readonly stage: string }> = [];
  const closeoutAuthorization = dependencies.authorizationDecision;
  if (!task.createdBy || !isSamePerson(task.createdBy, caller))
    return {
      ...reject(opId, "actor_unauthorized", { commands: [invocation] }),
      authorizationDecision: closeoutAuthorization,
    };
  if (task.status === "active" && (!snapshot.lease || !isSameExecution(snapshot.lease.actor, caller)))
    return {
      ...reject(opId, "actor_unauthorized", { commands: [invocation] }),
      authorizationDecision: closeoutAuthorization,
    };
  if (!dependencies.presetSnapshotCurrent()) {
    const stopped = await invoke("preset-upgrade", { kind: "preset-upgrade", taskId }, caller);
    if (stopped) return stopped;
  }
  if (task.status === "active") {
    const stopped = await invoke("submit", { kind: "task-submit", taskId, ...selector }, submitActor ?? caller);
    if (stopped) return stopped;
    const submitted = currentExecutionCuts(await dependencies.read()).find(
      (candidate) => candidate.executionId === snapshot.lease?.executionId,
    );
    submission = submitted?.submission ?? undefined;
  }
  if (!submission) return reject(opId, "invalid_transition", { commands: [`ha task show ${taskId}`] });

  const completion = { kind: "task-complete", taskId, ...selector };
  const stopped = await invoke("complete", completion, caller);
  if (stopped) return stopped;
  const { stage: _stage, ...final } = steps.at(-1)!;
  return {
    ...final,
    authorizationDecision: closeoutAuthorization,
    taskId,
    submittedCommitSha: submission.commitSha,
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
function closeoutInvocation(taskId: string, packetArgument: string, executionId?: string): string {
  return `ha task closeout ${taskId} ${packetArgument}${executionId ? ` --execution-id ${executionId}` : ""}`;
}
function candidateRejection(
  opId: string,
  taskId: string,
  packetArgument: string,
  candidates: readonly string[],
): WriteReceipt {
  const commands = candidates.map((candidate) => closeoutInvocation(taskId, packetArgument, candidate));
  return reject(opId, "ambiguous_execution", {
    commands: commands.length > 0 ? commands : [`ha task submit ${taskId}`, closeoutInvocation(taskId, packetArgument)],
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
function discoveryReceipt(opId: string, snapshot: Snapshot, value: unknown): WriteReceipt {
  return {
    outcome: "no_changes",
    opId: `read:${opId}`,
    revision: snapshot.revision,
    evidence: JSON.stringify(value),
    visibility: "center",
    proof: {
      committedRevision: snapshot.revision,
      appliedCut: snapshot.revision,
      durable: false,
      canonicalVisible: true,
      worktreeVisible: null,
    },
    summary: `${JSON.stringify(value, null, 2)}\n`,
  } as WriteReceipt;
}
