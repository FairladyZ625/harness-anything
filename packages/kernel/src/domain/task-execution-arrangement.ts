import type { ActorAxes, ContractValidationIssue, TaskV2, TaskExecutionArrangement } from "./task.ts";
import { isSameExecution, isSamePerson } from "./actor-domain-services.ts";
import { submissionDigest } from "./execution.ts";
import { sameWriteSource } from "./write-chain.contract.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import type { ReworkTaskCommand, TaskLifecycleSnapshot } from "./task-lifecycle-contract-internal-types.ts";
import { lifecycleContractIssue } from "./task-lifecycle-contract-support.ts";

export function currentExecutionArrangement(snapshot: TaskLifecycleSnapshot): TaskExecutionArrangement | undefined {
  const arrangement = snapshot.task?.executionArrangement;
  if (!arrangement || arrangement.iteration !== snapshot.task?.iteration) return undefined;
  const cut = snapshot.executions.find((value) => value.executionId === arrangement.executionId);
  return cut?.state === "changes_requested" &&
    cut.submission &&
    submissionDigest(cut.submission) === arrangement.submissionDigest
    ? arrangement
    : undefined;
}

export function arrangementIssues(
  snapshot: TaskLifecycleSnapshot,
  command: ReworkTaskCommand,
): ContractValidationIssue[] {
  const task = snapshot.task,
    cut = snapshot.executions.find((value) => value.executionId === command.executionId),
    arrangement = task?.executionArrangement;
  if (command.handoffId !== undefined)
    return arrangement?.id === command.handoffId &&
      arrangement.iteration === task?.iteration &&
      cut?.submission &&
      arrangement.submissionDigest === submissionDigest(cut.submission) &&
      snapshot.lease === null
      ? []
      : [
          lifecycleContractIssue(
            "invalid_transition",
            "The handoff no longer owns this cut/round, or its old execution is still leased",
          ),
        ];
  const reviewing = cut?.state === "submitted" && cut.iteration === task?.iteration && task?.currentNode === "review",
    returned = cut?.state === "changes_requested" && cut.iteration + 1 === task?.iteration && task?.status === "active";
  return cut?.submission &&
    (reviewing || returned) &&
    command.submissionDigest === submissionDigest(cut.submission) &&
    (!arrangement ||
      arrangement.iteration !== (reviewing ? cut.iteration + 1 : task?.iteration) ||
      (isSameExecution(arrangement.actor, command.actor) &&
        sameWriteSource(arrangement.source, command.source) &&
        arrangement.agentId === command.agentId &&
        arrangement.runtimeInstanceId === command.runtimeInstanceId &&
        arrangement.model === command.model))
    ? []
    : [
        lifecycleContractIssue(
          "invalid_transition",
          "Takeover requires the named current cut and submission digest; another session cannot replace its accepted arrangement",
        ),
      ];
}

export function arrangeExecution(snapshot: TaskLifecycleSnapshot, command: ReworkTaskCommand): TaskV2 {
  const cut = snapshot.executions.find((value) => value.executionId === command.executionId)!,
    existing = snapshot.task?.executionArrangement,
    arrangement: TaskExecutionArrangement =
      command.handoffId !== undefined
        ? { ...existing!, ready: true }
        : existing?.executionId === command.executionId && existing.submissionDigest === command.submissionDigest
          ? existing
          : {
              id: command.opId,
              executionId: command.executionId,
              submissionDigest: command.submissionDigest!,
              iteration: cut.iteration + 1,
              actor: command.actor,
              source: command.source,
              reason: command.reason,
              ready: false,
              ...(command.agentId ? { agentId: command.agentId } : {}),
              ...(command.runtimeInstanceId ? { runtimeInstanceId: command.runtimeInstanceId } : {}),
              ...(command.model ? { model: command.model } : {}),
            },
    task: TaskV2 = { ...snapshot.task!, executionArrangement: arrangement };
  return task;
}

/** The writing boundary, shared by task start and runtime launch, rejects superseded intent. */
export function executionArrangementAllows(
  snapshot: TaskLifecycleSnapshot,
  actor: ActorAxes,
  arrangementId?: string,
  source?: WriteSource,
): boolean {
  const arrangement = currentExecutionArrangement(snapshot);
  return (
    (!arrangement && arrangementId === undefined) ||
    (arrangement !== undefined &&
      arrangement.ready &&
      (arrangement.agentId
        ? arrangement.id === arrangementId && isSamePerson(arrangement.actor, actor)
        : isSameExecution(arrangement.actor, actor) &&
          (source === undefined || sameWriteSource(arrangement.source, source))))
  );
}

/** A submitted/approved cut ends the exception; a later return uses the automatic default. */
export function clearExecutionArrangement(task: TaskV2): TaskV2 {
  if (!task.executionArrangement) return task;
  const { executionArrangement: _arrangement, ...rest } = task;
  return rest;
}
