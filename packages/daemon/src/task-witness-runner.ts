import {
  assertCurrentWriter,
  consumeKnownError,
  currentGateRun,
  gateAppliesToSubmission,
  getExecutableEntityAction,
  type CompletionEvidenceV1,
  type ExecutionV1,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellApiContext } from "./repo-cell-api.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { chainRepoCellWrite } from "./repo-cell.ts";
import { centerWitnessAction } from "./task-witness-action.ts";
import { witnessAdapters } from "./repo-cell-witness-adapters.ts";

/** Source execution owns no queue: claims and publication enter the RepoCell's existing writer. */
export async function runCompletionSources(
  context: RepoCellApiContext,
  taskId: string,
  authority: Pick<RepoCellBinding, "withWriterEpochFence" | "writerEpochFence">,
  requestedRunId?: string,
): Promise<readonly string[]> {
  const initial = context.projection.read(taskId).snapshot,
    execution = initial.executions.find(
      (value) =>
        value.schema === "execution/v1" && value.iteration === initial.task?.iteration && value.submission !== null,
    );
  if (
    !execution ||
    execution.schema !== "execution/v1" ||
    !execution.submission ||
    !initial.task ||
    !["submitted", "in_review"].includes(initial.task.status)
  )
    return [];
  const warnings: string[] = [];
  for (const requirement of execution.submission.completionContract.gates) {
    if (
      !gateAppliesToSubmission(requirement, execution.submission) ||
      !["command", "github-actions"].includes(requirement.witness.kind)
    )
      continue;
    const sourceActor: RepoCellBinding = {
      actor: {
        principal: initial.task.createdBy.principal,
        executor: { kind: "agent", id: `completion-source:${requirement.witness.adapterId}` },
      },
      source: "local",
    };
    const current = currentGateRun(execution, requirement.gateId);
    // A command is executed only by the request that accepted its claim. Existing running
    // commands are owned by that invocation; terminal runs require an explicit owner rerun.
    if (
      current &&
      (current.state !== "running" || (requirement.witness.kind === "command" && current.runId !== requestedRunId))
    )
      continue;
    let claimedExecution: ExecutionV1 = execution;
    if (!current) {
      const claim = await accept(
        { kind: "task-witness-claim", taskId, executionId: execution.executionId, gateId: requirement.gateId },
        sourceActor,
      );
      if (claim.receipt.outcome !== "applied" || !claim.execution) {
        if (claim.receipt.outcome !== "no_changes")
          warnings.push(claim.receipt.evidence ?? `Gate ${requirement.gateId} claim was rejected.`);
        continue;
      }
      claimedExecution = claim.execution;
    }
    const run = currentGateRun(claimedExecution, requirement.gateId)!;
    let evidence: CompletionEvidenceV1 | null = null,
      unavailable: string | undefined;
    try {
      const adapter = witnessAdapters[requirement.witness.kind]!;
      evidence = adapter.collect
        ? ((await adapter.collect(
            context.extracted,
            requirement,
            claimedExecution,
            context.presetProcess,
          )) as CompletionEvidenceV1)
        : adapter.evaluate(context.extracted, requirement, claimedExecution, undefined);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "witness_unavailable") throw error;
      consumeKnownError(error);
      unavailable = error.message;
    }
    if (!evidence && unavailable === undefined) continue;
    const settled = await accept(
      {
        kind: "task-witness-settle",
        taskId,
        executionId: claimedExecution.executionId,
        gateId: requirement.gateId,
        runId: run.runId,
        claimFence: run.claimFence,
        ...(evidence ? { evidence } : { diagnostic: unavailable }),
      },
      { actor: run.actor, source: "local" },
    );
    if (settled.receipt.outcome !== "applied")
      warnings.push(settled.receipt.evidence ?? `Gate ${requirement.gateId} settlement was rejected.`);
    else if (unavailable || evidence?.result === "fail") warnings.push(unavailable ?? evidence!.diagnostic);
  }
  return warnings;

  async function accept(
    action: RepoTaskAction,
    binding: RepoCellBinding,
  ): Promise<{ readonly receipt: WriteReceiptDraft; readonly execution?: ExecutionV1 }> {
    context.queueDepth += 1;
    const pending = chainRepoCellWrite(context.tail, async () => {
      context.queueDepth -= 1;
      if (context.state !== "attached")
        throw context.cellCodedError("repo_unavailable", "The source host lost its attached RepoCell.");
      assertCurrentWriter(context.activeWriter, context.writerToken, context.input.repoId);
      context.activeWriterEpochFence = authority.withWriterEpochFence ?? null;
      context.activeWriterEpochFenceDescriptor = authority.writerEpochFence ?? null;
      try {
        const receipt = await context.executeAction({ ...action, [centerWitnessAction]: true }, binding),
          cut = context.projection
            .read(taskId)
            .snapshot.executions.find((value) => value.executionId === action.executionId);
        context.replica.kick();
        return { receipt, ...(cut?.schema === "execution/v1" ? { execution: cut } : {}) };
      } finally {
        context.activeWriterEpochFence = null;
        context.activeWriterEpochFenceDescriptor = null;
      }
    });
    context.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending.catch((error) => {
      if (context.fatalCellError(error)) context.latchWith(error);
      return {
        receipt: context.failed(
          context.operationId(action, binding, context.input.repoId, 0),
          error,
          getExecutableEntityAction(action.kind) ?? undefined,
          action,
        ),
      };
    });
  }
}
