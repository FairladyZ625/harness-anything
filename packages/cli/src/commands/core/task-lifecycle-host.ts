import { createHash } from "node:crypto";
import { Effect } from "effect";
import { makeTaskLifecycleService, type TaskLifecycleServiceProof } from "../../../../application/src/index.ts";
import { makeTaskEventStore, makeTaskProjection, type CompleteTaskCommand, type ProofFor, type TaskLifecycleCommand } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult, TaskLifecycleCliAction } from "../../cli/types.ts";
import { runTaskLifecycleFacade, type TaskLifecycleReceipt, type TaskLifecycleServiceInput, type TaskLifecycleServicePort } from "./task-lifecycle.ts";
const leaseTtlMs = 30 * 60 * 1_000;
type Snapshot = Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["read"]>>["snapshot"];
export const runTaskLifecycleFacadeCommand: CommandRunner = (context, command) => Effect.promise(async () => {
  if (!isTaskLifecycleAction(command.action)) throw new Error(`Unexpected lifecycle action ${command.action.kind}.`);
  const receipt = await runTaskLifecycleFacade(command.action, {
    actor: context.actorAxes(), workspaceId: context.rootDir,
    service: makeTaskLifecycleHost(context), verifyReceipt: context.verifyAntiEntropyReceipt
  });
  return cliResult(command.action, receipt);
});
export function makeTaskLifecycleHost(context: CommandRunnerContext, now: () => string = () => new Date().toISOString()): TaskLifecycleServicePort {
  const eventStore = makeTaskEventStore({ rootInput: context.layoutInput });
  const recovery = eventStore.recover();
  if (recovery.status === "indeterminate") throw hostError("publication_indeterminate", "The pending event/head pair could not be proven; inspect it before retrying the lifecycle command.");
  const projection = makeTaskProjection({ rootDir: context.rootDir, eventStore, now });
  const service = makeTaskLifecycleService({ eventStore, projection });
  return {
    show: async ({ taskId }) => {
      const read = await service.read(taskId);
      const opId = `read:${taskId}`;
      return read.status === "ready" ? { outcome: "applied", opId, revision: read.sourceRevision, evidence: JSON.stringify(read.snapshot),
        visibility: "center", proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark } } : {
        outcome: "pending", opId, revision: read.sourceRevision, evidence: JSON.stringify(read.snapshot),
        visibility: "center", proof: { committedRevision: read.sourceRevision, appliedCut: read.watermark },
        nextAction: `Retry \`ha task show ${taskId}\` after the projection catches up.`
      };
    },
    execute: async (input) => {
      const existing = eventStore.readEvent(input.command.opId), command = withServerMeta(input.command, existing, eventStore.readHead()?.revision ?? 0, now()), read = await service.read(command.taskId);
      const result = await service.execute(command, await proofFor(context, command, input, read.snapshot));
      return operationReceipt(command, result);
    }
  };
}
function withServerMeta(command: TaskLifecycleServiceInput["command"], existing: {
  readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string;
} | null, revision: number, now: string): TaskLifecycleCommand {
  return { ...command, eventId: existing?.eventId ?? `event-${createHash("sha256").update(command.opId).digest("hex")}`,
    workspaceRevision: existing?.workspaceRevision ?? revision + 1, occurredAt: existing?.occurredAt ?? now } as TaskLifecycleCommand;
}
async function proofFor(context: CommandRunnerContext, command: TaskLifecycleCommand, input: TaskLifecycleServiceInput,
  snapshot: Snapshot): Promise<TaskLifecycleServiceProof<typeof command>> {
  if (command.type === "CreateReplayTask") return { taskIdUnique: true, actorBinding: command.actor };
  if (command.type === "StartExecution") {
    return { actorBinding: command.actor, reservation: { taskId: command.taskId, executionId: command.executionId, expiresAt: new Date(Date.parse(command.occurredAt) + leaseTtlMs).toISOString(), ttlMs: leaseTtlMs } };
  }
  if (command.type === "SubmitExecution") {
    const lease = snapshot.lease;
    if (lease === null || lease.phase !== "active" || lease.taskId !== command.taskId || lease.executionId !== command.executionId || !sameActor(lease.actor, command.actor)) {
      throw hostError("lease_actor_mismatch", "Submit requires the active lease bound to this authenticated actor and execution.");
    }
    return { actorBinding: command.actor, leaseVersion: lease.version, sessionDisposition: "unavailable" };
  }
  if (command.type === "RecordReview") {
    if (command.kind === "anti_entropy") return antiEntropyProof(command, input);
    const task = snapshot.task, authorize = context.authorizeTaskLifecycleActor;
    if (task === null || authorize === undefined) throw hostError("actor_authority_unavailable", "Configure the task actor authority and retry the acceptance review.");
    const authorization = await authorize({ capability: "acceptance-review@v1", actor: command.actor, task });
    if (!authorization.ok || authorization.actorRole !== "acceptance") throw hostError("actor_unauthorized", authorization.ok ? "The actor authority returned the wrong acceptance role." : authorization.nextAction);
    return { actorBinding: command.actor, capability: "acceptance-review@v1",
      capabilityRef: authorization.capabilityRef, archiveWarningsPresent: false };
  }
  return completeProof(context, command, input, snapshot);
}
function antiEntropyProof(command: Extract<TaskLifecycleCommand, { readonly type: "RecordReview" }>,
  input: TaskLifecycleServiceInput): ProofFor<typeof command> {
  const receipt = input.verifiedReceipt;
  if (receipt === undefined) throw hostError("verified_receipt_required", "Pass anti-entropy review through the CLI receipt-verification boundary, then retry.");
  return { actorBinding: command.actor, capability: "anti-entropy@v1",
    capabilityRef: `anti-entropy-receipt:sha256:${receipt.digest}`, archiveWarningsPresent: false };
}

async function completeProof(context: CommandRunnerContext, command: CompleteTaskCommand, input: TaskLifecycleServiceInput,
  snapshot: Snapshot): Promise<ProofFor<CompleteTaskCommand>> {
  const supplied = validateGateReceiptSet(snapshot.task?.completionGateIds ?? [], input.gateReceipts ?? []);
  const execution = snapshot.executions.find((candidate) => candidate.executionId === command.executionId && candidate.submission !== null);
  if (execution?.submission === null || execution === undefined) throw hostError("invalid_transition", `Run \`ha task show ${command.taskId}\`; complete requires the current submitted Execution.`);
  if (snapshot.task === null) throw hostError("invalid_transition", `Run \`ha task show ${command.taskId}\`; complete requires an existing Task.`);
  const noActiveLease = verifyLeaseAbsence(snapshot.lease, command.taskId);
  const authorize = context.authorizeTaskLifecycleActor;
  if (authorize === undefined) throw hostError("actor_authority_unavailable", "Configure the task actor authority before completing a Task.");
  const authorization = await authorize({ capability: "task-complete@v1", actor: command.actor, task: snapshot.task });
  if (!authorization.ok) throw hostError("actor_unauthorized", authorization.nextAction);
  if (authorization.actorRole !== "owner" && authorization.actorRole !== "commander") throw hostError("actor_unauthorized", "Task completion requires an owner or commander capability.");
  const verify = context.verifyGateReceipt;
  if (supplied.length > 0 && verify === undefined) throw hostError("gate_receipt_verifier_unavailable", "Configure a gate receipt presence verifier, then retry complete.");
  const gateReceipts = await Promise.all(supplied.map(async (receipt) => {
    const verified = await verify!({ ...receipt, executionId: execution.executionId, commitSha: execution.submission!.commitSha, iteration: execution.iteration });
    if (!verified.ok) throw hostError("gate_receipt_unverified", verified.nextAction);
    if (verified.proof.gateId !== receipt.gateId || verified.proof.receiptRef !== receipt.receiptRef || verified.proof.executionId !== execution.executionId
      || verified.proof.commitSha !== execution.submission!.commitSha || verified.proof.iteration !== execution.iteration) {
      throw hostError("gate_receipt_unverified", `Gate ${receipt.gateId} verifier returned a mismatched provenance binding.`);
    }
    return verified.proof;
  }));
  return { capability: "task-complete@v1", capabilityRef: authorization.capabilityRef,
    actorRole: authorization.actorRole, noActiveLease, gateReceipts };
}

export function validateGateReceiptSet(declared: readonly string[], supplied: readonly { readonly gateId: string; readonly receiptRef: string }[]) {
  const counts = new Map<string, number>();
  for (const receipt of supplied) counts.set(receipt.gateId, (counts.get(receipt.gateId) ?? 0) + 1);
  const declaredSet = new Set(declared), missing = declared.filter((id) => !counts.has(id));
  const unknown = [...counts.keys()].filter((id) => !declaredSet.has(id)), duplicate = [...counts].filter(([, count]) => count !== 1).map(([id]) => id);
  const emptyRefs = supplied.filter((receipt) => receipt.receiptRef.trim().length === 0).map((receipt) => receipt.gateId);
  if (missing.length || unknown.length || duplicate.length || emptyRefs.length) throw hostError("gate_receipt_mismatch",
    `Gate receipt set must match declared gates exactly; missing=[${missing}], unknown=[${unknown}], duplicate=[${duplicate}], emptyRef=[${emptyRefs}]. Supply one --gate-receipt <gate-id>:<receipt-ref> for each declared gate.`);
  return supplied;
}

function operationReceipt(command: TaskLifecycleCommand, result: Awaited<ReturnType<ReturnType<typeof makeTaskLifecycleService>["execute"]>>): TaskLifecycleReceipt {
  if (result.outcome === "applied") return { outcome: "applied", opId: command.opId, revision: result.revision,
    evidence: result.event ? `task-event:${result.event.eventId}` : `task-revision:${result.revision}`, visibility: result.visibility, proof: result.proof };
  if (result.outcome === "pending") return { outcome: "pending", opId: command.opId, revision: result.revision,
    evidence: result.evidence ?? `task-revision:${result.revision}`, visibility: result.visibility, proof: result.proof,
    nextAction: result.nextAction ?? `Retry \`ha task show ${command.taskId}\` after projection catch-up.` };
  return { outcome: "indeterminate", opId: command.opId, code: result.code ?? "publication_unknown", origin: "N/A",
    nextAction: result.nextAction ?? `Run \`ha task show ${command.taskId}\` before retrying.` };
}
function sameActor(left: TaskLifecycleCommand["actor"], right: TaskLifecycleCommand["actor"]): boolean {
  return left.principal.personId === right.principal.personId && left.executor?.kind === right.executor?.kind && left.executor?.id === right.executor?.id;
}
function verifyLeaseAbsence(lease: { readonly executionId: string } | null, taskId: string): true {
  if (lease === null) return true;
  throw hostError("active_lease", `Release or submit active Lease ${lease.executionId} before completing ${taskId}.`);
}
function isTaskLifecycleAction(action: { readonly kind: string }): action is TaskLifecycleCliAction {
  return ["task-create", "task-start", "task-submit", "task-review-execution", "task-complete", "task-show"].includes(action.kind);
}
function cliResult(action: TaskLifecycleCliAction, receipt: TaskLifecycleReceipt): CliResult {
  const common = { command: action.kind, taskId: action.taskId,
    ...(action.verb !== "create" && action.verb !== "show" ? { executionId: action.executionId } : {}), ...receipt, report: receipt };
  return receipt.outcome === "applied" || receipt.outcome === "pending" ? { ok: true, ...common } : {
    ok: false, ...common, error: cliError(CliErrorCode.WriteRejected, receipt.nextAction)
  };
}
function hostError(code: string, message: string): Error { const error = new Error(message) as Error & { code: string; origin: string }; error.code = code; error.origin = "task-lifecycle-host"; return error; }
